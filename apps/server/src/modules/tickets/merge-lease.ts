/**
 * 랜딩 lease 의 **순수 판정 로직** (ticket e630b530).
 *
 * DB·시계·네트워크를 만지지 않는다 — 그래서 단위 테스트가 진실표를 전수로
 * 훑을 수 있다. 부수효과가 있는 오케스트레이션은 `merge-lease.service.ts`
 * (획득/해제)와 `../agents/merge-lease-sweep.service.ts`(리퍼·부여)에 있다.
 *
 * 이 파일에 담긴 판정은 셋이다:
 *   1. `decideLeaseLiveness` — 홀더가 살아 있는가(리퍼가 회수해도 되는가).
 *   2. `decideWaiterOutcome` — 대기자를 승격시킬 것인가 / 기다릴 것인가 /
 *      상한을 넘겨 fail-open 으로 통과시킬 것인가.
 *   3. `decideReverifyOutcome` — lease 를 쥔 채 CI 재검증을 몇 번까지 하는가.
 */

import type { ResolvedMergeLease } from '../../common/merge-lease-config';

// ── 1. 홀더 liveness ────────────────────────────────────────────────────────

/**
 * TTL 을 **작업 예산**이 아니라 **liveness 타임아웃**으로 다룬다.
 *
 * 고정 예산(예: "45분 지나면 회수")은 정면으로 위험하다. 정상 작업이 최대
 * 3 × 11–12분 ≈ 33분인데 CI 매트릭스가 느려지면 리퍼가 *진행 중인* 홀더의
 * lease 를 뺏고, 홀더는 그 사실을 모른 채 push 로 진입한다 — 두 홀더가 동시에
 * 랜딩하는, 없애려던 바로 그 경쟁이 되살아난다.
 *
 * 홀더의 턴은 `await_ci_run` 에서 끝나므로 에이전트는 하트비트를 칠 수 없다.
 * 그래서 진행 증거를 **서버가** 관측한다:
 *   - `hasActiveCiWait` — 티켓이 미해소 CI run 에 파킹돼 있다. 서버 자신이 그
 *     run 을 폴링 중이라는 뜻이라 가장 강한 증거다. CI 가 아무리 길어도 이
 *     동안은 살아 있다.
 *   - `lastProgressAtMs` — 그 외 관측된 마지막 진행(획득, 재검증 기록 등).
 *
 * `maxHoldMs` 는 위 판정 자체가 고장 나도 lease 가 영원히 걸려 있지 않게 하는
 * **백스톱**이라 CI 증거보다 우선한다. 회수의 최악 결과는 fail-open(= 오늘
 * 동작으로 회귀)이지 데이터 손상이 아니므로 이 우선순위가 안전하다.
 */
export type LeaseLivenessVerdict = 'alive' | 'reap_not_merging' | 'reap_blocked' | 'reap_max_hold' | 'reap_idle';

export interface LeaseLivenessInput {
  /** 홀더 티켓이 아직 merging kind 컬럼에 있는가. */
  inMergingColumn: boolean;
  /** 미해소 CI 대기가 걸려 있는가(가장 강한 진행 증거). */
  hasActiveCiWait: boolean;
  /**
   * 랜딩과 무관한 다른 사유로 차단됐는가 — `pending_user_action`(사람 대기)
   * 또는 `pending_on_tickets`(다른 티켓 대기).
   *
   * `pend_ticket` 은 컬럼을 옮기지 않으므로 이동 트랜잭션의 해제 훅이 걸리지
   * 않는다. 그런데 사람의 답을 무기한 기다리는 티켓이 저장소 전체의 랜딩
   * 구간을 쥐고 있는 것은 명백히 틀렸다. 그래서 해제 훅을 pend 표면마다
   * 새로 다는 대신, **liveness 규칙 한 곳**에서 처리한다 — 새 pending 종류가
   * 생겨도 여기만 보면 된다.
   *
   * `pending_merge_lease` 자체는 여기 포함하지 **않는다**: 승격 직후 전달
   * 전 크래시 창에서는 홀더가 잠시 파킹된 채로 남는데, 그것까지 차단으로
   * 보면 방금 부여한 lease 를 즉시 회수해 버린다.
   */
  blockedOnOther: boolean;
  /** 획득 시각(ms). null 이면 백스톱 판정을 건너뛴다. */
  acquiredAtMs: number | null;
  /** 마지막으로 관측된 진행 시각(ms). */
  lastProgressAtMs: number;
  nowMs: number;
  idleTimeoutMs: number;
  maxHoldMs: number;
}

export function decideLeaseLiveness(input: LeaseLivenessInput): LeaseLivenessVerdict {
  // Merging 을 떠난 홀더는 즉시 회수 대상이다. 정상 경로에서는 컬럼 이동
  // 트랜잭션이 이미 해제했을 것이므로(설계 보정 D), 여기 걸린다는 것은 그
  // 해제를 놓친 행이 남았다는 뜻 — 리퍼가 백스톱으로 정리한다.
  if (!input.inMergingColumn) return 'reap_not_merging';

  // 사람/다른 티켓을 기다리는 동안 랜딩 구간을 쥐고 있을 이유가 없다.
  if (input.blockedOnOther) return 'reap_blocked';

  if (input.acquiredAtMs != null && input.nowMs - input.acquiredAtMs >= input.maxHoldMs) {
    return 'reap_max_hold';
  }

  if (input.hasActiveCiWait) return 'alive';

  if (input.nowMs - input.lastProgressAtMs < input.idleTimeoutMs) return 'alive';

  return 'reap_idle';
}

// ── 2. 대기자 처리 ──────────────────────────────────────────────────────────

/**
 * 대기자 하나에 대한 판정.
 *
 * `fail_open_timeout` 을 **가장 먼저** 검사하는 것이 핵심이다. FIFO 머리가
 * 아니어도, 스코프가 비지 않았어도, 상한을 넘긴 대기자는 무조건 빠져나간다 —
 * 이것이 기아 방지의 최종 방어선이고, 이 기능의 안전성을 담보하는 fail-open
 * 원칙 그 자체다. 순서를 뒤집어 `grant` 를 먼저 보면, 스코프가 계속 붐비는
 * 동안 상한이 영원히 평가되지 않아 정확히 기아가 된다.
 */
export type WaiterVerdict = 'grant' | 'keep_waiting' | 'fail_open_timeout';

export interface WaiterOutcomeInput {
  /** 큐 진입 시각(ms). */
  queuedAtMs: number;
  nowMs: number;
  maxWaitMs: number;
  /** 이 대기자가 스코프 FIFO 의 머리인가(queued_at 오름차순 최소). */
  isFifoHead: boolean;
  /** 스코프에 살아 있는 홀더가 없는가. */
  scopeFree: boolean;
}

export function decideWaiterOutcome(input: WaiterOutcomeInput): WaiterVerdict {
  if (input.nowMs - input.queuedAtMs >= input.maxWaitMs) return 'fail_open_timeout';
  if (input.scopeFree && input.isFifoHead) return 'grant';
  return 'keep_waiting';
}

// ── 3. 재검증 예산 ──────────────────────────────────────────────────────────

/**
 * lease 를 쥐고 있어도 랜딩이 실패할 수 있다 — 사람이 base 에 직접 push 했거나,
 * 같은 저장소를 보는 **다른 AWB 인스턴스**가 있는 경우다. lease 는 이 AWB 의
 * 티켓들끼리만 조정하므로 그런 외부 전진까지 막지는 못한다.
 *
 * 그래서 lease 보호 하에서도 재검증 횟수에 상한을 둔다. 소진하면 조용히 계속
 * 도는 대신 **명시적 실패**로 끝낸다 — 완료 기준의 "유한하게 랜딩하거나 명시적
 * 으로 실패한다" 를 문자 그대로 만족시키는 지점이다.
 */
export type ReverifyVerdict = 'continue' | 'exhausted';

export function decideReverifyOutcome(reverifyCount: number, maxAttempts: number): ReverifyVerdict {
  return reverifyCount >= maxAttempts ? 'exhausted' : 'continue';
}

// ── 대기 컨텍스트 직렬화 ────────────────────────────────────────────────────

/** `Ticket.merge_lease_context` 의 JSON 모양. */
export interface MergeLeaseContext {
  lease_id: string;
  repo_resource_id: string;
  base_branch: string;
  /** 큐 진입 ISO 시각 — 대기 시간 관측의 기준점. */
  queued_at: string;
  requested_by: string;
  /** 이 대기자 앞에서 lease 를 쥔 티켓(관측성). 알 수 없으면 빈 문자열. */
  ahead_ticket_id: string;
}

/**
 * `Ticket.merge_lease_context` 를 파싱한다. 비었거나 깨졌으면 null — 스윕이
 * 깨진 행을 "컨텍스트 없음" 과 같게 다룰 수 있어야 한다(parseCiWaitContext 와
 * 같은 계약).
 */
export function parseMergeLeaseContext(raw: string | null | undefined): MergeLeaseContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.lease_id || !parsed.repo_resource_id) return null;
    return {
      lease_id: String(parsed.lease_id),
      repo_resource_id: String(parsed.repo_resource_id),
      base_branch: String(parsed.base_branch || ''),
      queued_at: String(parsed.queued_at || ''),
      requested_by: String(parsed.requested_by || ''),
      ahead_ticket_id: String(parsed.ahead_ticket_id || ''),
    };
  } catch {
    return null;
  }
}

/** 결정된 설정값으로부터 사람이 읽을 수 있는 한 줄 요약(로그·코멘트용). */
export function describeMergeLeaseConfig(cfg: ResolvedMergeLease): string {
  const m = (ms: number) => `${Math.round(ms / 60_000)}분`;
  return `enabled=${cfg.enabled} idle=${m(cfg.idleTimeoutMs)} maxHold=${m(cfg.maxHoldMs)} maxWait=${m(cfg.maxWaitMs)}`;
}
