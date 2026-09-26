/**
 * Terminal (Runtime Host 셸) 공유 상수·타입.
 *
 * 터미널의 단위는 **(Runtime Host, 매니저가 발급한 terminal id)** 다. Agent Session 과 달리
 * 장비에 남는 기록이 없다 — PTY 프로세스가 곧 터미널이고, 죽으면 그 터미널은 사라진다.
 * 그래서 목록은 **살아 있는 것만** 나오고(매니저의 라이브 테이블이 유일한 원천), 서버는
 * 아무것도 저장하지 않는다. 스크롤백은 매니저가 바이트 상한 안에서 들고 있다가 attach 때
 * 한 번 넘겨준다.
 *
 * 서버 모듈(modules/terminals), SSE contract(stream-events.ts), agent-manager
 * (apps/agent-manager/src/lib/terminal-runner.ts)가 같은 문자열 집합을 본다.
 * 값 추가/변경은 서버·agent-manager 를 같은 PR 로.
 */

export const TERMINAL_STATUSES = [
  'starting',  // PTY 를 띄우는 중
  'live',      // 셸이 살아 있고 입력을 받는다
  'exited',    // 셸이 끝났다(exit_code) — 목록에서 곧 사라진다
  'error',     // 띄우지 못했다(last_error)
] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** 아직 살아 있는 상태 — 매니저가 "없다" 고 하면 유령이다. */
export const TERMINAL_IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(['starting', 'live']);

/** 서버 → 매니저 요청. `request_id` 가 있으면 매니저가 `POST /api/agent/terminals/rpc/:id` 로 응답하는 RPC 다. */
export const TERMINAL_REQUEST_OPS = [
  'list',    // RPC: 이 장비에 살아 있는 터미널 목록
  'open',    // RPC: 새 PTY — { shell, cwd, title, cols, rows } → { terminal_id, … }
  'attach',  // RPC: 스크롤백 스냅샷 + 현재 상태(다시 그리기용)
  'input',   // { data } — 키 입력(그대로 PTY stdin 으로). Ctrl-C 도 여기로 온다(0x03)
  'resize',  // { cols, rows }
  'close',   // PTY 종료
] as const;
export type TerminalRequestOp = (typeof TERMINAL_REQUEST_OPS)[number];

/** 장비에서 띄울 수 있는 셸 한 줄 — 하트비트 `terminal_shells` 로 온다. */
export interface TerminalShellInfo {
  /** 안정적인 id(`bash` / `powershell` / `cmd` …) — open 요청이 이 값을 싣는다. */
  id: string;
  label: string;
  /** 실제 실행 파일 경로. 화면에는 보조 정보로만 쓴다. */
  path: string;
  /** 매니저가 아무것도 고르지 않았을 때 쓰는 셸. */
  default?: boolean;
}

/** 살아 있는 터미널 한 줄. 매니저의 라이브 테이블이 원천이고 서버는 그대로 비춘다. */
export interface TerminalSummary {
  manager_id: string;
  manager_name: string;
  terminal_id: string;
  shell: string;
  shell_label: string;
  cwd: string;
  title: string;
  cols: number;
  rows: number;
  pid: number | null;
  status: TerminalStatus | string;
  exit_code: number | null;
  last_error: string | null;
  driver_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** attach RPC 의 답 — 매니저가 들고 있던 스크롤백과, 그 마지막 청크의 절대 seq. */
export interface TerminalSnapshot {
  terminal: TerminalSummary;
  /** base64 로 실린 원문 바이트(ANSI 포함). 화면은 그대로 xterm 에 write 한다. */
  data: string;
  /** 스냅샷에 포함된 마지막 출력 청크의 seq. 화면은 이보다 작거나 같은 라이브 청크를 버린다. */
  seq: number;
  /** 상한을 넘겨 앞부분을 버렸는가. */
  truncated: boolean;
}

/** 매니저 → 서버 → driver 로 흐르는 출력 청크 1건. 서버는 저장하지 않는다. */
export interface TerminalOutputChunk {
  seq: number;
  /** base64 원문 바이트. */
  data: string;
  created_at: string;
}

/** 하트비트가 싣는 살아 있는 터미널 한 줄 — 유령 상태 되돌림용. */
export interface TerminalHeartbeatEntry {
  terminal_id: string;
  status: string;
}

export const TERMINAL_LIST_LIMIT = 100;
/** 한 장비에 동시에 열 수 있는 터미널 수 — 매니저도 같은 값으로 막는다. */
export const TERMINAL_PER_HOST_MAX = 16;
export const TERMINAL_INPUT_MAX_CHARS = 64_000;
/** 출력 청크 하나(base64 이전 원문 기준)의 상한. 매니저가 이 크기로 잘라 보낸다. */
export const TERMINAL_CHUNK_MAX_BYTES = 64 * 1024;
export const TERMINAL_OUTPUT_BATCH_MAX = 64;
/** attach 스냅샷(스크롤백) 상한 — 매니저가 이 바이트만 들고 있는다. */
export const TERMINAL_SCROLLBACK_MAX_BYTES = 256 * 1024;
export const TERMINAL_COLS_MIN = 2;
export const TERMINAL_COLS_MAX = 1000;
export const TERMINAL_ROWS_MIN = 1;
export const TERMINAL_ROWS_MAX = 500;

export function clampCols(value: unknown, fallback = 80): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(TERMINAL_COLS_MAX, Math.max(TERMINAL_COLS_MIN, n));
}

export function clampRows(value: unknown, fallback = 24): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(TERMINAL_ROWS_MAX, Math.max(TERMINAL_ROWS_MIN, n));
}
