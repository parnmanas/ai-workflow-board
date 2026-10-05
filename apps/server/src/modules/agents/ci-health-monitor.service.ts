/**
 * CiHealthMonitorService — main CI red-streak watchdog (ticket cc1c494e).
 *
 * Background: a project that lands with `use_pr=false` (direct push/merge)
 * never sees a broken default-branch CI run block anything or surface in a PR
 * check — it can (and did) stay red for weeks with nobody noticing. This
 * service periodically polls each project's GitHub repo for its CI
 * workflow(s), and once a red streak trips a threshold, posts an operator
 * chat alert AND (default on) auto-creates a `todo` ticket on that project so
 * the failure enters the normal dispatch loop (the project's
 * `default_assignee` picks it up) instead of depending on a human happening
 * to look.
 *
 * Sweep skeleton: setInterval+unref, a dedup row per monitored target
 * (`CiRedAlert`), and a `delivered_at`-gated re-alert cooldown so a failed
 * delivery retries every sweep instead of going silent for a full cooldown
 * window. The row is keyed by the monitored CI target rather than a ticket,
 * because a CI-red episode has no ticket to key off until (and unless) this
 * service creates one.
 *
 * Monitor target resolution (never guesses a repo): each Project's `repo_url`
 * + `default_branch`, authenticated with the project's `credential_id`. A
 * project with no repo url, no default branch, or a url that isn't github.com
 * is silently skipped — never widened to "guess" a repo or branch from
 * somewhere else.
 *
 * Trigger condition (`evaluateRedStreak`, kept pure/standalone for unit
 * testing without booting Nest): per (repo, branch, workflow), walk the most
 * recent completed runs newest-first. `cancelled`/`skipped` conclusions carry
 * no signal and are dropped before evaluation (neither extend nor break a
 * streak). Trips when the consecutive-red streak reaches `CI_MONITOR_MIN_RUNS`
 * OR the oldest run in the current streak is older than `CI_MONITOR_MIN_AGE_MS`
 * — the "OR" catches a repo with infrequent pushes where only 1-2 red runs
 * exist but a long time has passed. Recovers the instant the newest completed
 * run is green, regardless of how long the preceding streak was.
 * `event === 'schedule'`인 run, 그리고 event가 빈 문자열(누락)인 run도 동일하게 신호에서
 * 제외된다(fail-closed) — cron 트리거 run은 대부분의 잡이 skip돼도 run-level conclusion은
 * success로 찍히고, wire 경로에서 event 필드가 유실되면 그 판별 자체가 불가능해지기
 * 때문이다(ticket 654465c8, 리뷰 지적).
 *
 * 복구는 **단조적**이다 (ticket 0ef405f9): "최신 완료 run이 success" 는 필요조건일 뿐이고,
 * 그 success run이 이 행이 red 근거로 기록해 둔 실패 run(`last_run_id`/`last_run_at`)보다
 * 엄격히 최신일 때만 복구로 인정한다. 복구는 durable 상태(행 삭제 + 추적 티켓 연결 해제)를
 * 파괴하는 전이인데 판단 근거는 목록 API의 단발 응답 하나뿐이라, 그 응답이 한 번만
 * 어긋나도(다른 workflow의 run 혼입 · 최신 run 누락 · 같은 초 생성 run의 순서 뒤집힘) 곧장
 * 가짜 복구가 된다 — 실제로 성공 run이 0건인 main에 복구 알림이 두 차례 발송됐다. 하한선을
 * 통과하지 못한 green은 알림도 상태 변경도 없이 'CI' warn 로그 + `stale_green_rejected`
 * 카운터로만 관측된다. 같은 run의 재실행 flip(run id 동일)은 진짜 복구이므로 통과시킨다.
 *
 * Ticket idempotency: the auto-created ticket (tags `ci-red`, `auto-generated`)
 * carries `operational_dedupe_key = "ci_red:{account_id}:{repo}:{branch}:{workflow_id}"`
 * under Ticket's pre-existing `uq_tickets_operational_dedupe_open` unique
 * index — INSERT-first, unique-violation-caught, winner-reused (never a
 * pre-SELECT check), mirroring `OutreachIngestService._createTicket` /
 * `_resolveDedupeCollision`. The key — not the tags — is what finds the
 * incident's ticket. `CiRedAlert.created_ticket_id` additionally ensures at
 * most one creation ATTEMPT per red episode even before any DB race is in
 * play — 단 그 가드는 "연결이 있는가" 가 아니라 `_hasLiveIncidentTicket()`,
 * 즉 **"연결된 티켓이 아직 canonical 로 살아 있는가"** (archive 되지 않았고 status 가
 * done 이 아님) 로 판정한다. 연결 유무만 보면 canonical 이 복구 없이 done 으로 옮겨진 뒤의
 * 새 실패가 Done 티켓에 매달린 채 영원히 재평가되지 않는다 (아래 done 문단 참고).
 *
 * **Incident 수렴 — 티켓은 프로젝트당 1건이 아니라 장애당 1건이다** (ticket 3886473a):
 * 위 키에 들어가는 것은 project id 가 **아니라** workspace id 다. 같은 저장소를 가리키는
 * 프로젝트가 한 workspace 에 둘 있으면, 키에 감시 단위를 넣었을 때 같은 실패 run 에 대해
 * 실행 티켓이 2건 열리고 같은 담당자가 같은 한 줄 수정을 두 번 dispatch 받는다(보드 시절
 * 실측: 같은 run 을 두고 쌍둥이 티켓이 열려, 사람이 선행조건을 걸었다 풀었다 하며 손으로
 * 조정해야 했다). 그래서 (workspace, repo, branch, workflow) 가 하나의 **incident** 이고,
 * 먼저 trip 한 프로젝트가 canonical 티켓을 만들며 나머지는 그것을 **채택**한다 —
 * `CiRedAlert.created_ticket_id` 가 같은 티켓을 가리키고(관계), 프로젝트별 채팅 알림이 그
 * 티켓을 링크하며(알림), 채택 사실은 canonical 티켓에 코멘트로 남는다. 프로젝트별 감시·복구
 * 판정·재알림 쿨다운은 그대로 프로젝트별 `CiRedAlert` 행에 남는다.
 *
 * 스코프에 workspace 가 들어가는 이유(빼면 안 되는 이유): 티켓·프로젝트가 전부
 * workspace 스코프다. 다른 workspace 의 티켓을 가리키면 그 workspace 에서는 열 수도
 * dispatch 할 수도 없는 죽은 참조가 되고, 알림 본문의 티켓 링크도 어긋난다.
 * 서로 다른 저장소·브랜치·workflow 는 키가 다르므로 절대 합쳐지지 않는다.
 *
 * canonical 티켓이 **done 이 되면 그 incident 는 끝난 것**이므로 재사용하지 않는다 —
 * 키를 반납시키고 새 티켓을 연다. 그러지 않으면 새 실패가 아무도 보지 않는 Done 티켓에
 * 붙어 조용히 묻힌다. 이 판정은 **CI 가 복구되지 않은 상태에서도** 성립해야 한다:
 * 복구는 감시 행을 지우지만, 운영자가 red 인 채로 티켓을 Done 으로 옮기는 전이는 행이
 * 살아 있는 상태에서 벌어지기 때문이다. 그래서 재평가 가드가 연결 유무가 아니라 연결
 * 대상의 생존을 본다. 부수 효과로, red 가 계속되는 동안 티켓을 Done 으로 닫으면 다음
 * sweep 이 새 티켓을 연다 — 그게 이 감시자의 목적(아무도 모르는 red 를 없애는 것)이고,
 * 닫아 두고 싶다면 CI 를 고치거나 `CI_MONITOR_CREATE_TICKET=false` 가 탈출구다.
 * 반대 방향(복구 시 티켓 자동 완료)은 하지 않는다 — `_handleRecovery` 참고.
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { ChatRoom } from '../../entities/ChatRoom';
import { CiRedAlert } from '../../entities/CiRedAlert';
import { Comment } from '../../entities/Comment';
import { Project } from '../../entities/Project';
import { Ticket } from '../../entities/Ticket';
import { Account } from '../../entities/Account';
import { isDoneStatus, type TicketStatus } from '../../common/ticket-status';
import { LogService } from '../../services/log.service';
import { compareRunIds, GitHubConnectorService, GitHubRateLimitError, GitHubWorkflow, GitHubWorkflowRun, parseGitHubUrl, sortWorkflowRunsNewestFirst } from '../../services/github-connector.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { TicketService, type TicketActor } from '../tickets/ticket.service';

const DEFAULTS = {
  ENABLED: true,
  SWEEP_MS: 30 * 60_000,          // 30 min
  MIN_RUNS: 3,                    // consecutive red completed runs
  MIN_AGE_MS: 6 * 60 * 60_000,    // 6 h since the oldest run in the streak
  REALERT_MS: 24 * 60 * 60_000,   // 24 h cooldown between re-alerts
  CREATE_TICKET: true,
} as const;

// The incident ticket lands ready to work: `todo` queues it for the project's
// default_assignee (an unassigned project leaves it visible but undispatched).
const CI_RED_TICKET_STATUS: TicketStatus = 'todo';
const CI_RED_TICKET_TAGS = ['ci-red', 'auto-generated'];
const CI_MONITOR_ACTOR: TicketActor = { id: '', name: 'CiHealthMonitor', type: 'system' };

export interface CiHealthMonitorConfig {
  enabled: boolean;
  sweepMs: number;
  minRuns: number;
  minAgeMs: number;
  realertMs: number;
  createTicket: boolean;
}

function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CiHealthMonitorConfig {
  const parseIntEnv = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  // 'false' / '0' / 'no' / 'off' all disable; anything else (including unset) → default.
  const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
    if (raw == null) return fallback;
    const v = raw.trim().toLowerCase();
    if (v === '') return fallback;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return true;
  };
  return {
    enabled: parseBool(env.CI_MONITOR_ENABLED, DEFAULTS.ENABLED),
    sweepMs: parseIntEnv(env.CI_MONITOR_SWEEP_MS, DEFAULTS.SWEEP_MS),
    minRuns: parseIntEnv(env.CI_MONITOR_MIN_RUNS, DEFAULTS.MIN_RUNS),
    minAgeMs: parseIntEnv(env.CI_MONITOR_MIN_AGE_MS, DEFAULTS.MIN_AGE_MS),
    realertMs: parseIntEnv(env.CI_MONITOR_REALERT_MS, DEFAULTS.REALERT_MS),
    createTicket: parseBool(env.CI_MONITOR_CREATE_TICKET, DEFAULTS.CREATE_TICKET),
  };
}

// Exposed for unit tests so a spec can construct configs without touching
// the host environment.
export const __test__ = { readConfigFromEnv, DEFAULTS };

// conclusions that carry no health signal — dropped before evaluation so they
// neither extend nor break a streak (ticket body: "cancelled|skipped는 신호
// 아님으로 제외").
const RED_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out', 'startup_failure']);
const SIGNAL_CONCLUSIONS: ReadonlySet<string> = new Set(['success', ...RED_CONCLUSIONS]);

export interface RedStreakResult {
  /** Trip condition met on THIS evaluation (streak or age threshold crossed). */
  isRed: boolean;
  /** Newest completed run succeeded — the recovery signal. */
  isGreen: boolean;
  /** Consecutive red runs counting back from the newest signal run. */
  streak: number;
  /** Oldest run within the current streak (undefined streak → null). */
  firstFailedRun: GitHubWorkflowRun | null;
  /** Newest signal run overall (null when there is no completed-run signal yet). */
  lastRun: GitHubWorkflowRun | null;
  /** 최신 signal run 이 success 였지만 기존 red 근거보다 최신이 아니라 복구로 인정하지
   *  않은 run. null 이 아니면 이번 응답이 앞뒤가 맞지 않았다는 뜻이며, 호출자는 기존
   *  상태를 그대로 두고 관측 가능하게 로그를 남겨야 한다 (ticket 0ef405f9). */
  staleGreenRun: GitHubWorkflowRun | null;
}

/**
 * 복구 판정의 하한선 — 직전 평가가 red 의 근거로 기록해 둔 실패 run.
 * `CiRedAlert` 행의 `last_run_id` / `last_run_at` 을 그대로 넘긴다.
 */
export interface RedStreakEvidence {
  lastFailedRunId: string;
  /** 그 run 의 `created_at` (ISO). 빈 문자열이면 하한선이 없다는 뜻이고 게이트는 적용되지 않는다. */
  lastFailedAt: string;
  /** 하한선 run 이 속한 workflow (`CiRedAlert.workflow_id`). 같은 초 동률을 run id 로 깨는
   *  것은 green run 이 **이 workflow 소속임이 확인될 때만** 허용된다 — 아래 게이트 주석
   *  참고. 비어 있으면 판별 불가로 보고 동률을 깨지 않는다. */
  workflowId?: string;
}

/**
 * green run 이 하한선과 **같은 workflow** 임이 확인되는가. 양쪽 중 하나라도 workflow 를
 * 모르면 `false` — 모르는 것을 "같다" 로 취급하면 이 티켓이 막으려던 형제 run 오탐이
 * 그대로 되돌아온다. `listWorkflowRuns` 는 `workflow_id` 필드가 아예 없는 run 을
 * (이물질이라는 증거가 없으므로) 버리지 않고 남기기 때문에, 그런 run 이 여기까지 온다.
 */
function isSameWorkflowAsEvidence(green: GitHubWorkflowRun, evidence?: RedStreakEvidence | null): boolean {
  const recorded = String(evidence?.workflowId || '').trim();
  const actual = String(green?.workflow_id || '').trim();
  if (!recorded || !actual) return false;
  return recorded === actual;
}

/**
 * 복구 단조성 게이트 — CI 상태를 green 으로 되돌리려면 그 근거가 red 를 만든 근거보다
 * **엄격히 최신**이어야 한다 (ticket 0ef405f9).
 *
 * 왜 필요한가: 복구 판정은 filtered 목록 API 의 단발 응답 하나만 보고 durable 상태
 * (`CiRedAlert` 행 + 추적 티켓 연결)를 지운다. 그 응답이 한 번만 어긋나면 — 다른
 * workflow 의 run 이 섞이든, 최신 run 이 빠지든, 같은 초에 생성된 run 의 순서가 뒤집히든
 * — 그 한 번이 그대로 "복구" 가 되고, 감시 상태까지 함께 사라진다. 실제로 성공 run 이
 * 하나도 없는 main 에 복구 알림이 두 차례 발송됐다. 근거가 기존 실패보다 최신이 아니면
 * 그것은 복구가 아니라 앞뒤가 맞지 않는 읽기이므로 red 를 유지한다.
 *
 * **"더 최신" 은 정렬과 같은 전체 순서 `(created_at, run id)` 로 판정한다** (리뷰 지적).
 * `created_at` 만 비교하면 `sortWorkflowRunsNewestFirst` 가 "가장 최신" 으로 골라 놓은
 * run 을 이 게이트가 거부하는 모순이 생긴다 — 같은 workflow 에서 실패 run 직후 성공 run
 * 이 같은 초에 만들어지는 **정상 복구**가 영구히 거부돼 alert 행이 갇힌다. 두 경로가 같은
 * 비교(`compareRunIds`)를 쓰는 것이 이 함수의 계약이다.
 *
 * 다만 동률을 run id 로 깨는 것은 green 이 **같은 workflow** 일 때뿐이다. 한 푸시가 나란히
 * 띄운 다른 workflow 의 성공은 id 가 더 클 수도 있지만 그 실패를 고친 run 이 아니다 —
 * 이 티켓의 원래 오탐이 바로 그 형태이므로 workflow 판별이 안 되면 fail-closed 로 둔다.
 *
 * 예외 하나: **같은 run 이 재실행되어 green 으로 뒤집힌 경우**(`run_attempt` 증가)는 진짜
 * 복구다. run id 가 같고 `created_at` 도 그대로이므로 시각 비교만으로는 영원히 거부돼
 * 행이 갇힌다 — id 일치를 먼저 확인해 통과시킨다.
 */
function isRecoveryNewerThanEvidence(green: GitHubWorkflowRun, evidence?: RedStreakEvidence | null): boolean {
  const floorIso = evidence?.lastFailedAt || '';
  if (!floorIso) return true; // 하한선 자체가 없음 — 비교 대상이 없으므로 게이트하지 않는다
  if (evidence?.lastFailedRunId && green.id === evidence.lastFailedRunId) return true; // 같은 run 의 재실행 flip
  const floorMs = new Date(floorIso).getTime();
  if (!Number.isFinite(floorMs)) return true; // 하한선을 못 읽으면 게이트 근거가 없다
  const greenMs = new Date(green.created_at || '').getTime();
  if (!Number.isFinite(greenMs)) return false; // 시점을 못 읽는 run 으로는 복구를 주장할 수 없다
  if (greenMs !== floorMs) return greenMs > floorMs;
  // 같은 초 — 정렬이 쓰는 것과 같은 2순위 키로 깬다. 단, 같은 workflow 임이 확인될 때만.
  return isSameWorkflowAsEvidence(green, evidence)
    && compareRunIds(green.id || '', evidence?.lastFailedRunId || '') > 0;
}

/**
 * Pure red-streak decision — no DB, no HTTP — so the threshold logic is
 * deterministically unit-testable against fixture run lists. `runs` is
 * already narrowed to one workflow + branch; 최신순은 응답 순서를 믿지 않고
 * `sortWorkflowRunsNewestFirst` 로 (created_at, run id) 에서 다시 만든다.
 *
 * `evidence` 를 넘기면 복구 판정에 단조성 게이트가 걸린다 — `isRecoveryNewerThanEvidence`
 * 참고. 넘기지 않으면(하한선 없음) 기존 동작 그대로다.
 */
export function evaluateRedStreak(
  runs: GitHubWorkflowRun[],
  now: Date,
  config: { minConsecutiveRuns: number; minAgeMs: number },
  evidence?: RedStreakEvidence | null,
): RedStreakResult {
  // schedule(cron) 트리거 run은 워크플로 대부분의 잡이 `if: ... != 'schedule'`로 skip되지만
  // run-level conclusion은 그대로 success로 찍힌다 — signal에서 통째로 제외해 잡 5/6 skip인
  // run이 진짜 복구로도, 스트릭 브레이커로도 오판되지 않게 한다(ticket 654465c8). event가 빈
  // 문자열(누락)인 run도 같은 이유로 제외한다(fail-closed) — schedule 여부를 확인할 수 없는
  // run을 신호로 받아들이면, wire 경로에서 event 필드가 유실되는 순간 이 수정 자체가
  // 조용히 무력화된다(리뷰 지적).
  // 응답이 준 순서는 쓰지 않는다 — "가장 최신 run" 은 데이터(created_at, run id)에서
  // 다시 만든다 (ticket 0ef405f9).
  const ordered = sortWorkflowRunsNewestFirst(runs || []);
  const signal = ordered.filter((r) => SIGNAL_CONCLUSIONS.has(r.conclusion || '') && !!r.event && r.event !== 'schedule');
  if (signal.length === 0) {
    return { isRed: false, isGreen: false, streak: 0, firstFailedRun: null, lastRun: null, staleGreenRun: null };
  }
  const lastRun = signal[0];
  if (lastRun.conclusion === 'success') {
    if (!isRecoveryNewerThanEvidence(lastRun, evidence)) {
      // 복구로도 red 로도 넘기지 않는다 — 기존 상태를 그대로 유지시키고, 호출자가
      // 이 앞뒤 안 맞는 읽기를 관측할 수 있게 run 만 실어 보낸다.
      return { isRed: false, isGreen: false, streak: 0, firstFailedRun: null, lastRun, staleGreenRun: lastRun };
    }
    return { isRed: false, isGreen: true, streak: 0, firstFailedRun: null, lastRun, staleGreenRun: null };
  }
  let streak = 0;
  let firstFailedRun = lastRun;
  for (const run of signal) {
    if (!RED_CONCLUSIONS.has(run.conclusion || '')) break;
    streak += 1;
    firstFailedRun = run;
  }
  const firstFailedAtMs = new Date(firstFailedRun.updated_at).getTime();
  const ageMs = Number.isFinite(firstFailedAtMs) ? now.getTime() - firstFailedAtMs : 0;
  const isRed = streak >= config.minConsecutiveRuns || (streak >= 1 && ageMs >= config.minAgeMs);
  return { isRed, isGreen: false, streak, firstFailedRun, lastRun, staleGreenRun: null };
}

function isUniqueConstraintError(error: unknown): boolean {
  const value = error as {
    code?: string;
    errno?: number;
    message?: string;
    driverError?: { code?: string; errno?: number; message?: string };
  } | null;
  const driverError = value?.driverError;
  const code = driverError?.code ?? value?.code;
  const errno = driverError?.errno ?? value?.errno;
  const message = driverError?.message ?? value?.message ?? '';
  return code === '23505'
    || code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'ER_DUP_ENTRY'
    || errno === 1062
    || /unique constraint failed/i.test(message);
}

/**
 * 한 CI 장애(incident)의 신원. **project id 는 들어가지 않는다** — 같은 workspace 안에서
 * 같은 저장소·브랜치·workflow 를 감시하는 프로젝트가 여럿이면 그것은 장애 N 건이 아니라
 * 1 건이고, 실행 티켓도 1 건이어야 한다 (ticket 3886473a).
 *
 * workspace 는 반드시 들어간다 — 티켓·프로젝트가 workspace 스코프라 다른 workspace 의
 * 티켓을 가리키면 그 workspace 에서 열 수도 dispatch 할 수도 없다.
 */
export function ciIncidentDedupeKey(
  accountId: string, repoFullName: string, branch: string, workflowId: string,
): string {
  return `ci_red:${accountId}:${repoFullName}:${branch}:${workflowId}`;
}

interface MonitorTarget {
  owner: string;
  repo: string;
  repoFullName: string;
  branch: string;
  credentialId: string | null;
}

interface CiSweepStats {
  projects_scanned: number;
  targets_checked: number;
  alerts_created: number;
  alerts_updated: number;
  tickets_created: number;
  /** 새 티켓을 만드는 대신 다른 프로젝트가 이미 연 canonical incident 티켓을 채택한 횟수
   *  (ticket 3886473a). `tickets_created` 와 합쳐 "이번 sweep 이 incident 티켓을 해소한
   *  프로젝트 수" 가 된다 — 같은 저장소의 프로젝트가 여럿인데 채택이 0 이면 수렴이
   *  동작하지 않는다는 신호다. */
  tickets_linked: number;
  delivery_failures: number;
  recovered: number;
  skipped_disabled: boolean;
  /** GitHub reads that failed non-degradably (401/403/429/5xx/network) — see
   *  isGitHubDegradableError. Each one is also logged under 'CI' with
   *  project/repo/workflow context; a nonzero count here means the sweep did
   *  NOT get a full picture this pass, even though it didn't throw. */
  fetch_failures: number;
  /** 최신 run 이 success 로 보였지만 기존 red 근거보다 최신이 아니라 복구로 인정하지 않은
   *  횟수 (ticket 0ef405f9). 0 이 아니면 GitHub 응답이 그 sweep 에서 앞뒤가 맞지 않았다는
   *  뜻이다 — 알림은 나가지 않지만 'CI' 카테고리 warn 로그로 남는다. */
  stale_green_rejected: number;
}

/** `_resolveIncidentTicket` 의 결과 — 이 프로젝트가 canonical 티켓을 직접 만들었는지
 *  (`created`), 아니면 다른 프로젝트가 이미 연 것을 채택했는지 구분한다. 채택 쪽만
 *  canonical 티켓에 교차 프로젝트 코멘트를 남긴다. */
interface IncidentTicketOutcome {
  ticketId: string;
  created: boolean;
}

@Injectable()
export class CiHealthMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly config: CiHealthMonitorConfig;
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly github: GitHubConnectorService;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly messaging: RoomMessagingService,
    private readonly tickets: TicketService,
  ) {
    this.config = readConfigFromEnv();
    // GitHubConnectorService lives in McpServicesModule, which AgentsModule
    // does not import (avoids a cross-module cycle). Constructed directly —
    // it only needs the DataSource.
    this.github = new GitHubConnectorService(this.dataSource);
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logService.info('CI', 'CiHealthMonitorService disabled via CI_MONITOR_ENABLED=false', {
        config: this.config,
      });
      return;
    }
    this.tickHandle = setInterval(() => {
      this.sweep().catch((e: unknown) => {
        this.logService.error('CI', 'sweep failed', { err: String(e) });
      });
    }, this.config.sweepMs);
    // The tick loop must never keep the process alive on its own; Nest's
    // lifecycle owns shutdown.
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();
    this.logService.info('CI', 'CI health sweep loop initialized', { config: this.config });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** Test helper — read the loaded config so a spec can assert env parsing. */
  getConfig(): CiHealthMonitorConfig {
    return { ...this.config };
  }

  /**
   * Public test hook — equivalent to one tick of the internal loop. Returns
   * light stats so a spec can assert "one alert row created, one ticket
   * created" without observing internal state.
   */
  async sweep(now: Date = new Date()): Promise<CiSweepStats> {
    const stats: CiSweepStats = {
      projects_scanned: 0, targets_checked: 0, alerts_created: 0, alerts_updated: 0,
      tickets_created: 0, tickets_linked: 0, delivery_failures: 0, recovered: 0,
      skipped_disabled: !this.config.enabled,
      fetch_failures: 0,
      stale_green_rejected: 0,
    };
    if (!this.config.enabled) return stats;

    const projects = await this.dataSource.getRepository(Project).find();
    // Cache API responses per (owner/repo/credential) and
    // (owner/repo/credential/workflow/branch) for the DURATION of this sweep
    // only — several projects can point at the same repo, and each still needs
    // its own per-project alert/ticket evaluation, but the underlying GitHub
    // calls should fire once PER CREDENTIAL. credentialId is part of the key
    // (ticket cc1c494e review) — two projects on the same repo with different
    // credentials must never share a cached success or a cached rejection. A
    // rejected promise is cached too — a second project hitting the same
    // broken repo/workflow/credential this sweep reuses the failure instead
    // of hammering an endpoint already known to be down this pass.
    const workflowsCache = new Map<string, Promise<GitHubWorkflow[]>>();
    const runsCache = new Map<string, Promise<GitHubWorkflowRun[]>>();

    for (const project of projects) {
      stats.projects_scanned += 1;
      const target = this._resolveMonitorTarget(project);
      if (!target) continue;
      // No token resolves for THIS target — neither the project's credential
      // nor the env fallback. Checked per-target (never globally up front):
      // env GITHUB_TOKEN being unset must not blind the sweep to every OTHER
      // project that carries its own working credential (ticket cc1c494e
      // review — this was the bug: a global env-only check skipped the entire
      // sweep even when a per-repo credential was valid).
      if (!(await this.github.isEnabled(target.credentialId))) continue;

      // credentialId is part of the cache key (with an explicit sentinel for
      // the env-token fallback) — two projects can point at the SAME repo with
      // DIFFERENT credentials, and each credential's success/failure must
      // stay independent. Keying by owner/repo alone made the first cached
      // promise (success OR rejection) get reused for a second, different
      // credential (ticket cc1c494e review — a private repo watched with an
      // invalid credential would poison a valid credential on the same repo).
      const credKey = target.credentialId ?? '__env__';
      const wfKey = `${target.owner}/${target.repo}/${credKey}`;
      if (!workflowsCache.has(wfKey)) {
        workflowsCache.set(wfKey, this.github.listWorkflows(target.owner, target.repo, target.credentialId));
      }
      let workflows: GitHubWorkflow[];
      try {
        workflows = await workflowsCache.get(wfKey)!;
      } catch (e) {
        stats.fetch_failures += 1;
        this.logService.warn('CI', 'GitHub workflow list fetch failed — skipping this project this sweep', {
          project_id: project.id, repo: target.repoFullName, branch: target.branch, ...this._describeFetchError(e),
        });
        continue;
      }

      for (const workflow of workflows) {
        stats.targets_checked += 1;
        const runsKey = `${wfKey}/${workflow.id}/${target.branch}`;
        if (!runsCache.has(runsKey)) {
          runsCache.set(
            runsKey,
            this.github.listWorkflowRuns(target.owner, target.repo, workflow.id, target.branch, target.credentialId),
          );
        }
        let runs: GitHubWorkflowRun[];
        try {
          runs = await runsCache.get(runsKey)!;
        } catch (e) {
          stats.fetch_failures += 1;
          this.logService.warn('CI', 'GitHub workflow runs fetch failed — skipping this workflow this sweep', {
            project_id: project.id, repo: target.repoFullName, branch: target.branch,
            workflow_id: workflow.id, workflow_name: workflow.name, ...this._describeFetchError(e),
          });
          continue;
        }
        // 평가는 `_applyEvaluation` 안에서 한다 — 복구 단조성 게이트의 하한선이 기존
        // `CiRedAlert` 행에 있으므로, 행을 먼저 읽은 뒤에야 올바른 평가가 가능하다
        // (ticket 0ef405f9).
        await this._applyEvaluation(project, target, workflow, runs, now, stats);
      }
    }
    return stats;
  }

  /** Loggable fields for a caught GitHub fetch error — surfaces the
   *  Retry-After hint on a rate-limit error since that's actionable context
   *  a plain message string would bury. */
  private _describeFetchError(e: unknown): { err: string; retry_after_ms?: number } {
    const out: { err: string; retry_after_ms?: number } = { err: e instanceof Error ? e.message : String(e) };
    if (e instanceof GitHubRateLimitError) out.retry_after_ms = e.retryAfterMs;
    return out;
  }

  /**
   * Resolve a project's monitored GitHub target: its repo url on its default
   * branch, read with its own credential. Returns null — never a guess — when
   * the project names no repo or branch, or the url isn't github.com. An empty
   * default_branch means "origin/HEAD" to the agents, but resolving that here
   * would cost an extra API call per project per sweep to watch a branch
   * nobody named, so it stays unwatched.
   */
  private _resolveMonitorTarget(project: Project): MonitorTarget | null {
    if (!project.account_id) return null;
    const url = (project.repo_url || '').trim();
    const branch = (project.default_branch || '').trim();
    if (!url || !branch) return null;

    const parsed = parseGitHubUrl(url);
    if (!parsed) return null; // not a github.com url — silently skip, never guess elsewhere
    return {
      owner: parsed.owner,
      repo: parsed.repo,
      repoFullName: `${parsed.owner}/${parsed.repo}`,
      branch,
      credentialId: project.credential_id || null,
    };
  }

  private async _applyEvaluation(
    project: Project,
    target: MonitorTarget,
    workflow: GitHubWorkflow,
    runs: GitHubWorkflowRun[],
    now: Date,
    stats: CiSweepStats,
  ): Promise<void> {
    const alertRepo = this.dataSource.getRepository(CiRedAlert);
    const existing = await alertRepo.findOne({
      where: { project_id: project.id, repo_full_name: target.repoFullName, branch: target.branch, workflow_id: workflow.id },
    });

    const evalResult = evaluateRedStreak(
      runs,
      now,
      { minConsecutiveRuns: this.config.minRuns, minAgeMs: this.config.minAgeMs },
      existing
        ? {
          lastFailedRunId: existing.last_run_id || '',
          lastFailedAt: existing.last_run_at || '',
          // 같은 초 동률을 run id 로 깨도 되는지 판단하려면 하한선의 workflow 가 필요하다.
          workflowId: existing.workflow_id || '',
        }
        : null,
    );

    if (evalResult.staleGreenRun) {
      // 응답의 최신 run 이 success 로 보였지만 기존 red 근거보다 최신이 아니다. 알림도
      // 보내지 않고 행도 건드리지 않는다 — 다만 조용히 넘기면 이 모니터가 잡으라고
      // 존재하는 바로 그 "아무도 모르는" 실패가 되므로 반드시 남긴다 (ticket 0ef405f9).
      stats.stale_green_rejected += 1;
      this.logService.warn('CI', 'CI 복구 신호를 거부했다 — 기존 red 근거보다 최신이 아니다 (상태 유지)', {
        project_id: project.id, repo: target.repoFullName, branch: target.branch,
        workflow_id: workflow.id, workflow_name: workflow.name,
        green_run_id: evalResult.staleGreenRun.id,
        green_run_created_at: evalResult.staleGreenRun.created_at,
        green_run_url: evalResult.staleGreenRun.html_url,
        recorded_last_run_id: existing?.last_run_id || '',
        recorded_last_run_at: existing?.last_run_at || '',
      });
      return;
    }

    if (evalResult.isGreen) {
      if (existing) await this._handleRecovery(project, target, workflow, existing, stats);
      return;
    }
    if (!evalResult.isRed) return; // no signal yet, or below threshold — wait for more data

    let row = existing;
    const isNewRow = !row;
    if (!row) {
      row = alertRepo.create({
        project_id: project.id,
        account_id: project.account_id,
        repo_full_name: target.repoFullName,
        branch: target.branch,
        workflow_id: workflow.id,
        delivered_at: null,
        delivery_attempts: 0,
        created_ticket_id: null,
      });
    }
    row.workflow_name = workflow.name;
    row.streak = evalResult.streak;
    row.first_failed_run_id = evalResult.firstFailedRun?.id || '';
    row.last_run_id = evalResult.lastRun?.id || '';
    // 이 시점의 `lastRun` 은 red 를 성립시킨 가장 최신 실패 run 이다 — 그 생성 시각이
    // 다음 sweep 의 복구 단조성 하한선이 된다 (ticket 0ef405f9).
    row.last_run_at = evalResult.lastRun?.created_at || '';
    await alertRepo.save(row);
    if (isNewRow) stats.alerts_created += 1; else stats.alerts_updated += 1;

    // 에피소드당 프로젝트당 한 번만 티켓을 해소한다 — 다만 그 기준은 "연결이 있는가" 가
    // 아니라 **"연결된 티켓이 아직 이 incident 의 canonical 로 살아 있는가"** 다 (ticket
    // 3886473a 리뷰 지적). `!row.created_ticket_id` 만 보면, canonical 이 **복구 없이**
    // done 으로 옮겨진 뒤에는 "연결이 남아 있다" 는 이유로 재평가 자체를 영원히 건너뛴다 — 그 뒤의
    // 새 실패는 아무도 보지 않는 Done 티켓에 계속 매달린 채 새 incident 도 dispatch 도
    // 생기지 않는다. 복구 경로는 행을 **지우므로** 이 전이를 가리지 못한다: 이것은 CI 가
    // red 인 채로 벌어지는 전이라 행이 살아 있는 상태에서만 드러난다.
    if (this.config.createTicket && !(await this._hasLiveIncidentTicket(row))) {
      try {
        const outcome = await this._resolveIncidentTicket(project, target, workflow, evalResult);
        // 관계를 먼저 영속화한다 — 아래 교차 프로젝트 코멘트가 실패하더라도 이 프로젝트는
        // 이미 canonical 티켓을 가리키고 있어야 다음 sweep 이 새 티켓을 열지 않는다.
        row.created_ticket_id = outcome.ticketId;
        await alertRepo.save(row);
        if (outcome.created) {
          stats.tickets_created += 1;
        } else {
          stats.tickets_linked += 1;
          await this._noteAdditionalProject(outcome.ticketId, project, target, workflow);
        }
      } catch (e) {
        this.logService.warn('CI', 'CI-red ticket auto-creation failed — will retry next sweep', {
          err: String(e), project_id: project.id, repo: target.repoFullName,
        });
      }
    }

    // Re-alert cooldown keys off delivered_at (last SUCCESSFUL post), never
    // off a plain last-attempt timestamp — a first delivery that fails is
    // retried every sweep instead of silenced for a full cooldown window
    // (durable-delivery contract, ticket e7c87517 blocker #3).
    if (row.delivered_at && now.getTime() - new Date(row.delivered_at).getTime() < this.config.realertMs) {
      return;
    }
    row.delivery_attempts = (row.delivery_attempts || 0) + 1;
    await alertRepo.save(row);
    const delivered = await this._postRedAlert(project, target, workflow, row, evalResult, now);
    if (delivered) {
      row.delivered_at = now;
      await alertRepo.save(row);
    } else {
      stats.delivery_failures += 1;
      this.logService.warn('CI', 'CI-red alert delivery failed — will retry next sweep', {
        project_id: project.id, repo: target.repoFullName, delivery_attempts: row.delivery_attempts,
      });
    }
  }

  private async _postRedAlert(
    project: Project,
    target: MonitorTarget,
    workflow: GitHubWorkflow,
    row: CiRedAlert,
    evalResult: RedStreakResult,
    now: Date,
  ): Promise<boolean> {
    const roomId = await this._resolveAlertRoomId(project.account_id);
    if (!roomId) {
      this.logService.warn('CI', 'no chat room available for CI-red alert — will retry next sweep', {
        project_id: project.id, repo: target.repoFullName,
      });
      return false;
    }
    let failedJobs: string[] = [];
    if (evalResult.lastRun) {
      try {
        failedJobs = await this.github.listRunFailedJobs(target.owner, target.repo, evalResult.lastRun.id, target.credentialId);
      } catch (e) {
        // Decorative only (job names in the alert body) — post the alert
        // without them rather than losing the whole alert over this, but the
        // failure must still be logged, not silently dropped.
        this.logService.warn('CI', 'GitHub failed-jobs fetch failed — posting alert without job detail', {
          project_id: project.id, repo: target.repoFullName, run_id: evalResult.lastRun.id, ...this._describeFetchError(e),
        });
      }
    }
    const ageH = evalResult.firstFailedRun
      ? Math.max(0, (now.getTime() - new Date(evalResult.firstFailedRun.updated_at).getTime()) / 3_600_000)
      : 0;
    const lines = [
      `🔴 **CI red** — \`${target.repoFullName}@${target.branch}\` · ${workflow.name} (프로젝트 ${project.name})`,
      `연속 ${row.streak}회 실패 · 최초 실패 후 ${ageH.toFixed(1)}시간 경과`,
      failedJobs.length > 0 ? `실패한 잡: ${failedJobs.join(', ')}` : '',
      evalResult.lastRun?.html_url ? `[최신 run 보기](${evalResult.lastRun.html_url})` : '',
      row.created_ticket_id ? `추적 티켓: [열기](/tickets?ticket=${row.created_ticket_id})` : '',
    ].filter(Boolean);
    try {
      await this.messaging.sendSystemMessage(roomId, project.account_id, lines.join('\n\n'));
      this.logService.info('CI', 'CI-red alert posted', {
        project_id: project.id, repo: target.repoFullName, streak: row.streak,
      });
      return true;
    } catch (e) {
      this.logService.warn('CI', 'CI-red alert post failed', {
        err: String(e), project_id: project.id, repo: target.repoFullName,
      });
      return false;
    }
  }

  /**
   * Recovery: newest completed run is green. Posts a one-shot "CI 복구" chat
   * message, appends a recovery comment on the tracked ticket (if one was
   * created) WITHOUT moving it to done — a green run may just mean someone
   * else's push happened to fix it, or masked the issue; closing the loop is
   * left to the ticket's assignee — then deletes the row (self-pruning).
   *
   * 채팅 알림은 프로젝트별로 나가지만, **티켓 코멘트는 incident 당 1회**다 (ticket
   * 3886473a): 여러 프로젝트가 같은 canonical 티켓을 가리킬 수 있으므로 프로젝트마다 남기면
   * 같은 문장이 그 수만큼 쌓인다. 내 행을 먼저 지운 뒤 그 티켓을 아직 red 로 보고 있는
   * `CiRedAlert` 행이 0 건일 때만 남긴다 — 어느 프로젝트의 조회가 실패해 red 로 남아 있는
   * sweep 에서 성급히 복구를 선언하지 않는다는 뜻이기도 하다.
   */
  private async _handleRecovery(
    project: Project,
    target: MonitorTarget,
    workflow: GitHubWorkflow,
    row: CiRedAlert,
    stats: CiSweepStats,
  ): Promise<void> {
    const roomId = await this._resolveAlertRoomId(project.account_id);
    if (roomId) {
      const lines = [
        `✅ **CI 복구** — \`${target.repoFullName}@${target.branch}\` · ${workflow.name}`,
        `연속 ${row.streak}회 실패 후 최신 run이 성공으로 복구됐습니다.`,
      ];
      try {
        await this.messaging.sendSystemMessage(roomId, project.account_id, lines.join('\n\n'));
        this.logService.info('CI', 'CI recovery posted', { project_id: project.id, repo: target.repoFullName });
      } catch (e) {
        this.logService.warn('CI', 'CI recovery post failed (row still cleared)', {
          err: String(e), project_id: project.id, repo: target.repoFullName,
        });
      }
    }
    // 먼저 지운다 — 아래 "이 incident 를 아직 red 로 보는 행이 남았는가" 판정에 내
    // 행이 끼면 코멘트가 영원히 남지 않는다.
    await this.dataSource.getRepository(CiRedAlert).delete({ id: row.id });

    const stillRedElsewhere = row.created_ticket_id
      ? await this.dataSource.getRepository(CiRedAlert).count({ where: { created_ticket_id: row.created_ticket_id } })
      : 0;
    if (row.created_ticket_id && stillRedElsewhere === 0) {
      try {
        const commentRepo = this.dataSource.getRepository(Comment);
        await commentRepo.save(commentRepo.create({
          ticket_id: row.created_ticket_id,
          account_id: project.account_id,
          author_type: 'system',
          author_id: '',
          author: 'CiHealthMonitor',
          content: `✅ CI가 복구됐습니다 — \`${target.repoFullName}@${target.branch}\`(${workflow.name}) 최신 run이 성공했습니다. 자동으로 완료 처리하지 않으니 확인 후 필요 시 직접 마무리해주세요.`,
          type: 'note',
        }));
      } catch (e) {
        this.logService.warn('CI', 'CI recovery ticket comment failed', {
          err: String(e), ticket_id: row.created_ticket_id,
        });
      }
    }
    stats.recovered += 1;
  }

  /**
   * Resolve the chat room to publish into for a workspace. Order:
   *   1. Account.alerts_chat_room_id, if set and the room exists.
   *   2. Oldest chat room in the workspace by `created_at ASC`.
   */
  private async _resolveAlertRoomId(accountId: string): Promise<string | null> {
    if (!accountId) return null;
    const ws = await this.dataSource.getRepository(Account).findOne({ where: { id: accountId } });
    const roomRepo = this.dataSource.getRepository(ChatRoom);
    if (ws?.alerts_chat_room_id) {
      const configured = await roomRepo.findOne({ where: { id: ws.alerts_chat_room_id, account_id: accountId } });
      if (configured) return configured.id;
    }
    const fallback = await roomRepo
      .createQueryBuilder('r')
      .where('r.account_id = :wsId', { wsId: accountId })
      .orderBy('r.created_at', 'ASC')
      .limit(1)
      .getOne();
    return fallback?.id ?? null;
  }

  private _buildTicketDescription(target: MonitorTarget, workflow: GitHubWorkflow, evalResult: RedStreakResult, now: Date): string {
    const ageH = evalResult.firstFailedRun
      ? Math.max(0, (now.getTime() - new Date(evalResult.firstFailedRun.updated_at).getTime()) / 3_600_000)
      : 0;
    const lines = [
      `main CI(\`${workflow.name}\`, workflow ${workflow.id})가 \`${target.repoFullName}@${target.branch}\`에서 연속 ${evalResult.streak}회 실패했습니다(최초 실패 후 약 ${ageH.toFixed(1)}시간 경과).`,
      '',
      `기본 브랜치의 CI 실패는 PR 체크로 드러나지 않습니다(특히 use_pr=false 로 직접 머지하는 프로젝트) — 원인을 조사해 고쳐주세요.`,
      '',
      `이 티켓은 이 장애(저장소·브랜치·workflow) 전체의 canonical incident 티켓입니다 — 같은 저장소를 가리키는 다른 프로젝트는 새 티켓을 만들지 않고 이 티켓을 가리킵니다. 수정은 여기서만 진행하세요.`,
      '',
      evalResult.lastRun?.html_url ? `최신 run: ${evalResult.lastRun.html_url}` : '',
      '',
      `자동 생성: CiHealthMonitorService (ticket #[ticket:cc1c494e-b1ae-4e9c-a364-7323071492c0|main CI가 use_pr=false 환경에서 장기간 red여도 아무도 인지 못 함 — 상태 가시성 장치 필요])`,
    ].filter((l) => l !== undefined);
    return lines.join('\n');
  }

  /**
   * 이 red 에피소드가 가리킬 incident 티켓을 확정한다 — 새로 만들거나(`created: true`),
   * 다른 프로젝트가 이미 연 canonical 을 채택한다(`created: false`).
   *
   * 채택은 **예외 경로가 아니라 정상 경로**다 (ticket 3886473a): 키에서 project id 를
   * 뺐으므로 같은 장애를 보는 두 번째 프로젝트는 매번 unique 위반을 거쳐 여기로 온다.
   * 그래도 INSERT-first 를 유지하는 이유는 pre-SELECT 가 경합을 막지 못하기 때문이다 —
   * 승자를 정하는 것은 DB 의 UNIQUE 이고, 조회는 그 결과를 읽을 뿐이다. 에피소드당
   * 프로젝트당 한 번만 실행된다(`_hasLiveIncidentTicket` 가드).
   */
  private async _resolveIncidentTicket(
    project: Project,
    target: MonitorTarget,
    workflow: GitHubWorkflow,
    evalResult: RedStreakResult,
  ): Promise<IncidentTicketOutcome> {
    const now = new Date();
    const dedupeKey = ciIncidentDedupeKey(project.account_id, target.repoFullName, target.branch, workflow.id);
    const title = `CI red: ${target.repoFullName}@${target.branch} — ${workflow.name}`;
    const description = this._buildTicketDescription(target, workflow, evalResult, now);
    try {
      return { ticketId: await this._insertTicket(project, dedupeKey, title, description), created: true };
    } catch (e) {
      if (!isUniqueConstraintError(e)) throw e;
      return await this._resolveTicketDedupeCollision(project, dedupeKey, title, description, e);
    }
  }

  /**
   * 이 감시 행이 가리키는 티켓이 **아직 이 incident 의 canonical 로 쓸 수 있는가**.
   * 연결이 없거나, 티켓이 사라졌거나, archive 됐거나, done 이면 false — 그때는 다음
   * 실패에서 새 incident 를 열어야 한다 (ticket 3886473a 리뷰 지적). done 티켓에 새
   * 실패를 붙이면 아무도 보지 않는 곳에 조용히 묻힌다.
   *
   * 살아 있으면 true 라서, 정상적인 red 에피소드에서는 `_resolveIncidentTicket` 이 다시
   * 돌지 않는다(에피소드당 프로젝트당 1회 시도 규약 유지). 죽은 링크일 때만 재해소한다.
   */
  private async _hasLiveIncidentTicket(row: CiRedAlert): Promise<boolean> {
    if (!row.created_ticket_id) return false;
    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: row.created_ticket_id } });
    if (!ticket) return false;        // 하드 삭제됨 — 가리킬 것이 없다
    if (ticket.archived_at) return false;
    return !isDoneStatus(ticket.status);
  }

  /**
   * 끝난(done 이거나 archive 된) 홀더에게서 incident 키를 반납받고 새 티켓을 연다.
   * 반납 자체가 새 INSERT 의 자리를 비우는 유일한 방법이다 — 키는 UNIQUE 이므로.
   * 반납은 그 컬럼 하나만 쓴다 — 읽어 둔 홀더 행 전체를 다시 저장하면 그 사이에 바뀐
   * status 등을 낡은 값으로 덮어쓴다.
   */
  private async _reopenIncident(
    project: Project, dedupeKey: string, title: string, description: string, staleHolder: Ticket,
  ): Promise<IncidentTicketOutcome> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    await ticketRepo.update({ id: staleHolder.id }, { operational_dedupe_key: null });
    try {
      return { ticketId: await this._insertTicket(project, dedupeKey, title, description), created: true };
    } catch (retryError) {
      if (!isUniqueConstraintError(retryError)) throw retryError;
      // 키를 반납받은 직후 다른 프로젝트의 sweep 이 먼저 새 incident 를 열었다 — 그것이 승자다.
      const fallbackWinner = await ticketRepo.findOne({ where: { operational_dedupe_key: dedupeKey, archived_at: IsNull() } });
      if (fallbackWinner) return { ticketId: fallbackWinner.id, created: false };
      throw retryError;
    }
  }

  /**
   * 이 프로젝트가 새 티켓 대신 기존 canonical 티켓을 채택했음을 그 티켓에 남긴다 — 티켓만
   * 보고도 이 장애가 어느 프로젝트들에 걸쳐 있는지 알 수 있어야, 두 담당 흐름이 같은
   * 원인을 각자 조사하고 사람이 선행조건을 걸었다 풀었다 하며 손으로 조정하는 일이
   * 되풀이되지 않는다 (ticket 3886473a). 복구 코멘트와 같은 경로로 Comment 행만 쓰고
   * activity log 는 남기지 않으므로 담당자를 재-dispatch 하지 않는다 — 수렴의 목적이
   * 중복 dispatch 제거인데 그 사실을 알리는 코멘트가 dispatch 를 유발하면 모순이다.
   */
  private async _noteAdditionalProject(
    ticketId: string, project: Project, target: MonitorTarget, workflow: GitHubWorkflow,
  ): Promise<void> {
    try {
      const commentRepo = this.dataSource.getRepository(Comment);
      await commentRepo.save(commentRepo.create({
        ticket_id: ticketId,
        account_id: project.account_id,
        author_type: 'system',
        author_id: '',
        author: 'CiHealthMonitor',
        content: `🔗 같은 CI 장애가 프로젝트 \`${project.name}\` 에서도 감지됐습니다 — \`${target.repoFullName}@${target.branch}\`(${workflow.name}) 로 동일한 장애라 별도 실행 티켓을 만들지 않고 이 티켓으로 수렴시켰습니다. 수정은 이 티켓 한 건에서만 진행하세요.`,
        type: 'note',
      }));
    } catch (e) {
      // 관계(`CiRedAlert.created_ticket_id`)와 프로젝트별 채팅 알림이 이미 수렴을 성립시키므로
      // 이 코멘트 하나 때문에 sweep 을 실패시키지 않는다 — 다만 조용히 넘기지도 않는다.
      this.logService.warn('CI', '교차 프로젝트 채택 코멘트 작성 실패 (수렴 자체는 성립)', {
        err: String(e), ticket_id: ticketId, project_id: project.id, repo: target.repoFullName,
      });
    }
  }

  /**
   * Files the incident ticket through TicketService so it gets the same
   * position / activity / dispatch treatment as any other ticket. `assignee`
   * is deliberately omitted (not null): omission is what makes TicketService
   * apply the project's default_assignee. A unique violation on the dedupe
   * key propagates to the caller — that is the INSERT-first race signal.
   */
  private async _insertTicket(project: Project, dedupeKey: string, title: string, description: string): Promise<string> {
    const { ticket } = await this.tickets.create(project.account_id, {
      title,
      description,
      priority: 'high',
      status: CI_RED_TICKET_STATUS,
      tags: CI_RED_TICKET_TAGS,
      project_id: project.id,
      operational_dedupe_key: dedupeKey,
    }, CI_MONITOR_ACTOR);
    return ticket.id;
  }

  /**
   * _insertTicket()'s INSERT hit the operational_dedupe_key unique index —
   * this incident already has a holder. 두 갈래다:
   *
   *   - 홀더가 **열려 있다** (archive 되지 않았고 status 가 done 이 아니다) → 그게
   *     canonical 이다. 이 프로젝트는 새 티켓을 만들지 않고 그것을 채택한다
   *     (`created: false`). 다른 프로젝트의 sweep 이 먼저 연 경우와, 이 프로세스가 앞
   *     tick 이 끝나기 전에 재진입한 경우가 여기로 온다.
   *   - 홀더가 **archive 됐거나 done 이다** → 그 incident 는 끝났다. 키를 반납시키고
   *     새 incident 를 연다 (ticket 3886473a: 본문이 요구한 "canonical 이 완료된 뒤 새
   *     실패는 새 incident"). 완료 판정이 없던 시절에는 `archived_at IS NULL` 만 보고
   *     Done 티켓을 그대로 재사용했고, 그러면 새 실패가 아무도 보지 않는 티켓에 붙어
   *     묻혔다.
   *
   * 어느 갈래든 승자를 정하는 것은 DB 의 UNIQUE 이고 조회는 그 결과를 읽을 뿐이다 —
   * OutreachIngestService._resolveDedupeCollision 과 같은 INSERT-first 규약(ticket
   * cc1c494e Plan decision D), pre-SELECT / 보상삭제 춤이 아니다.
   */
  private async _resolveTicketDedupeCollision(
    project: Project, dedupeKey: string, title: string, description: string, originalError: unknown,
  ): Promise<IncidentTicketOutcome> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const openWinner = await ticketRepo.findOne({ where: { operational_dedupe_key: dedupeKey, archived_at: IsNull() } });
    if (openWinner) {
      if (!isDoneStatus(openWinner.status)) return { ticketId: openWinner.id, created: false };
      return await this._reopenIncident(project, dedupeKey, title, description, openWinner);
    }

    const holder = await ticketRepo.findOne({ where: { operational_dedupe_key: dedupeKey } });
    if (!holder) throw originalError; // holder vanished mid-race — propagate, caller retries next sweep
    // committed between our two lookups — 열려 있으면 그대로 채택한다.
    if (!holder.archived_at && !isDoneStatus(holder.status)) {
      return { ticketId: holder.id, created: false };
    }
    return await this._reopenIncident(project, dedupeKey, title, description, holder);
  }
}
