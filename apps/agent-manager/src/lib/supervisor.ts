/**
 * 이 프로세스가 어떤 감독자 아래서 도는지 / 어떤 맥락에서 실행됐는지.
 *
 * - systemd v232+ 는 unit 이 띄운 프로세스에 INVOCATION_ID 를 항상 넣고, JOURNAL_STREAM 은
 *   그보다 오래된 폴백이다. 둘 다 없으면 systemd 밖(Windows, 셸, launchd …)이다.
 *   /proc/1/comm 은 보지 않는다 — 사용자 세션 매니저가 non-systemd init 아래 돌 수 있다.
 * - AWB_SESSION_ID 는 agent-session-runner 가 세션 프로세스(ACP 어댑터와 그 자식)에 넣는다.
 *   그 안에서 매니저 바이너리를 직접 실행하면 세션이 끝날 때 함께 죽는다 — 락 takeover 를
 *   막고 실행 중인 서비스에 넘기는 근거로 쓴다.
 *
 * self-update.ts(재기동 경로)와 agent-lockfile.ts(takeover 판정)가 같은 판정을 봐야 하므로
 * 여기 한 곳에만 둔다.
 */

export type Supervisor = 'systemd' | null;

export function detectSupervisor(env: NodeJS.ProcessEnv = process.env): Supervisor {
  return env.INVOCATION_ID || env.JOURNAL_STREAM ? 'systemd' : null;
}

export function insideAgentSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AWB_SESSION_ID);
}

/** 운영자가 감독 중인 매니저까지 `--force` 로 밀어내겠다고 명시하는 탈출구. */
export const FORCE_TAKEOVER_ENV = 'AWB_AGENT_MANAGER_TAKEOVER';

export function forceTakeoverAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FORCE_TAKEOVER_ENV] === '1';
}
