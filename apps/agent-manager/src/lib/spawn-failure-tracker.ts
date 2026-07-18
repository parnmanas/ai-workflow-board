// CLI subagent/session spawn 실패를 집계해 AWB 관리자 대시보드에 노출한다
// (ticket e299c6b3). 이전에는 codex spawn 이 ENOENT(Windows npm `.cmd` shim, 형제
// `.exe` 없음)로 죽어도 로그 한 줄만 남기고 드롭됐다 — reviewer 에이전트는 여전히
// "online" 으로 보이는데 모든 트리거가 죽어 리뷰 티켓 10건이 쌓였다. 이제 매니저는
// 여기에 작은 요약을 누적하고 매 instance heartbeat 에 REST-only additive 필드로
// 실어 보내며, 대시보드가 "degraded" 배지를 렌더한다. 또 동일 실패가 반복되면 더 큰
// WARN 로그로 에스컬레이션해 5분마다 묻히던 한 줄 대신 실질적인 신호를 준다.

import { log } from './logging.js';

export interface SpawnFailureSnapshot {
  /** 매니저 부팅 이후 누적된 spawn 실패 횟수(monotonic). */
  spawn_failure_count: number;
  /** 가장 최근의 아직-해소되지-않은 spawn 실패 메시지. 같은 CLI 가 이후에 정상
   *  spawn 되면 null 로 지워져 배지가 현재 상태를 반영한다. */
  last_spawn_error: string | null;
  /** 마지막 미해소 실패의 CLI(claude/codex/…), 정상일 때 null. */
  last_spawn_error_cli: string | null;
  /** 마지막 미해소 실패의 ISO 타임스탬프, 정상일 때 null. */
  last_spawn_error_at: string | null;
}

// 같은 (cli, code) 시그니처가 중간 성공 없이 이 횟수만큼 연속 실패하면 더 큰 WARN
// 으로 에스컬레이션한다 — "동일 오류 반복 시 알림" 요구사항.
const REPEAT_ALERT_EVERY = 3;

const MAX_MESSAGE_LEN = 300;

export class SpawnFailureTracker {
  #count = 0;
  #lastError: string | null = null;
  #lastCli: string | null = null;
  #lastAt: string | null = null;
  // 시그니처별 연속 실패 횟수. 해당 CLI 가 성공하면 리셋된다.
  #consecutive = new Map<string, number>();

  /** spawn 실패를 기록한다. 각 spawn 사이트의 `error` 핸들러가 호출하며, 거기서
   *  OS 에러 `code`(Windows `.cmd` 케이스의 ENOENT)를 함께 넘긴다. */
  record(input: { cli: string; code?: string | null; message?: string | null }): void {
    const cli = input.cli || 'unknown';
    const code = input.code || '';
    const message = (input.message || 'spawn failed').slice(0, MAX_MESSAGE_LEN);
    this.#count += 1;
    this.#lastError = code ? `${code}: ${message}` : message;
    this.#lastCli = cli;
    this.#lastAt = new Date().toISOString();
    const sig = `${cli}|${code}`;
    const n = (this.#consecutive.get(sig) ?? 0) + 1;
    this.#consecutive.set(sig, n);
    // 첫 발생은 이미 spawn 사이트가 로그로 남기므로, 지속 반복될 때만
    // 에스컬레이션해 막힌 CLI 를 매니저 로그에서 놓치지 않게 한다.
    if (n >= REPEAT_ALERT_EVERY && n % REPEAT_ALERT_EVERY === 0) {
      log(
        `[spawn-failure] ALERT cli=${cli} code=${code || '-'} repeated ${n}x consecutively — ` +
          `this agent-manager is now DEGRADED on the AWB dashboard. last: ${message}`,
      );
    }
  }

  /** spawn 성공을 기록한다. 해당 CLI 의 현재-상태 필드를 지워(count 는 누적
   *  informational 총계로 유지) 회복된 CLI 가 다음 heartbeat 에서 degraded 로
   *  보이지 않게 한다. */
  recordSuccess(cli: string): void {
    if (this.#lastCli === cli) {
      this.#lastError = null;
      this.#lastCli = null;
      this.#lastAt = null;
    }
    for (const key of [...this.#consecutive.keys()]) {
      if (key.startsWith(`${cli}|`)) this.#consecutive.delete(key);
    }
  }

  snapshot(): SpawnFailureSnapshot {
    return {
      spawn_failure_count: this.#count,
      last_spawn_error: this.#lastError,
      last_spawn_error_cli: this.#lastCli,
      last_spawn_error_at: this.#lastAt,
    };
  }
}

/** 프로세스 전역 공유 tracker — spawn 사이트들이 여기에 보고하고, instance
 *  heartbeat 가 snapshot 을 읽는다. subagent/session 두 spawn 경로와 main 의
 *  heartbeat wiring 이 같은 인스턴스를 써야 하므로 생성자 주입 대신 싱글턴이다. */
export const spawnFailureTracker = new SpawnFailureTracker();
