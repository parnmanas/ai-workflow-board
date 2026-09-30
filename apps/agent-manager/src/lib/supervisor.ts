/**
 * 이 프로세스가 어떤 감독자 아래서 도는지 / 어떤 맥락에서 실행됐는지.
 *
 * 감독자 판정은 **부모 프로세스**로 한다: systemd user unit 의 main 프로세스는 부모가
 * `systemd --user`(comm "systemd")다. 환경변수 INVOCATION_ID / JOURNAL_STREAM 은 쓰지 않는다
 * — systemd 가 띄운 데스크톱 앱(예: Claude Code)의 자식 셸까지 그 변수를 물려받아, 거기서
 * 매니저를 직접 띄우면 "서비스가 띄운 프로세스" 로 오판했다(rolf 에서 실제로 그렇게 서비스가
 * 대체돼 내려갔다).
 *
 * `AWB_AGENT_MANAGER_SUPERVISOR=systemd|none` 은 테스트/운영 seam 이다. 감독 중이라고 주장하면
 * `--force` 로부터 **보호**될 뿐 어떤 권한도 생기지 않으므로 오용 위험이 없다.
 *
 * AWB_SESSION_ID 는 agent-session-runner 가 세션 프로세스(ACP 어댑터와 그 자식)에 넣는다.
 * 그 안에서 매니저 바이너리를 직접 실행하면 세션이 끝날 때 함께 죽는다 — 락 takeover 를
 * 막고 실행 중인 서비스에 넘기는 근거로 쓴다.
 *
 * self-update.ts(재기동 경로)와 agent-lockfile.ts(takeover 판정)가 같은 판정을 봐야 하므로
 * 여기 한 곳에만 둔다.
 */
import { readFileSync } from 'node:fs';

export type Supervisor = 'systemd' | null;

export const SUPERVISOR_OVERRIDE_ENV = 'AWB_AGENT_MANAGER_SUPERVISOR';

function parentComm(pid: number): string | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /^PPid:\s*(\d+)/m.exec(status);
    const ppid = m ? Number(m[1]) : 0;
    if (!(ppid > 0)) return null;
    return readFileSync(`/proc/${ppid}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}

export function detectSupervisor(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): Supervisor {
  const override = env[SUPERVISOR_OVERRIDE_ENV]?.trim().toLowerCase();
  if (override === 'systemd') return 'systemd';
  if (override === 'none') return null;
  if (process.platform !== 'linux') return null;
  return parentComm(pid) === 'systemd' ? 'systemd' : null;
}

export function insideAgentSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AWB_SESSION_ID);
}

/**
 * `--force` 판정이 보는 플랫폼. `AWB_AGENT_MANAGER_PLATFORM` 은
 * `AWB_AGENT_MANAGER_SUPERVISOR` 와 같은 성질의 seam 이다 — 이 값으로 갈리는 것은
 * "SIGUSR2 재기동을 넘길 수 있는가" 하나뿐이고, 그 답이 no 면 takeover 를 **거부**하는
 * 쪽으로만 움직이므로 어떤 권한도 생기지 않는다. 대신 win32 전용 분기를 어느 OS 에서든
 * 통합 테스트로 고정할 수 있다 — 그 분기를 Windows 잡에만 맡겨 두면, 그 잡이 언젠가
 * 빠지는 순간 같은 구멍이 다시 조용해진다.
 */
export const PLATFORM_OVERRIDE_ENV = 'AWB_AGENT_MANAGER_PLATFORM';

export function effectivePlatform(env: NodeJS.ProcessEnv = process.env): NodeJS.Platform {
  const override = env[PLATFORM_OVERRIDE_ENV]?.trim();
  return override ? (override as NodeJS.Platform) : process.platform;
}

/** 운영자가 감독 중인 매니저까지 `--force` 로 밀어내겠다고 명시하는 탈출구. */
export const FORCE_TAKEOVER_ENV = 'AWB_AGENT_MANAGER_TAKEOVER';

export function forceTakeoverAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FORCE_TAKEOVER_ENV] === '1';
}
