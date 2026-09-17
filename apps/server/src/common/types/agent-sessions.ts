/**
 * Agent Session (CLI 직접 세션) 공유 상수·타입.
 *
 * 세션의 단위는 **(Runtime Host, CLI, CLI 네이티브 세션 id)** 다. AWB 는 세션 내용을
 * 저장하지 않는다 — Claude Code(`~/.claude/projects`), Codex(`~/.codex/sessions`) 가
 * 자기 홈에 전문을 갖고 있으므로, 서버는 매니저에게 "이 장비의 이 CLI 에 어떤 세션이
 * 있는가 / 이 세션의 기록은 무엇인가" 를 reverse RPC 로 묻고, 살아 있는 턴의 스트림만
 * 소유자 브라우저로 중계한다.
 *
 * 서버 모듈(modules/agent-sessions), SSE contract(stream-events.ts), agent-manager
 * (apps/agent-manager/src/lib/agent-session-runner.ts · agent-session-store.ts)가 같은
 * 문자열 집합을 본다. 값 추가/변경은 서버·agent-manager 를 같은 PR 로.
 */

export const AGENT_SESSION_STATUSES = [
  'idle',                  // 매니저에 살아 있는 프로세스 없음 — 다음 prompt 가 연다(기록은 CLI 홈에 있음)
  'starting',              // ACP 프로세스를 여는 중
  'ready',                 // ACP 세션이 열려 있고 프롬프트를 받을 수 있음
  'busy',                  // 프롬프트 턴 진행 중
  'awaiting_permission',   // 에이전트가 permission 을 요청하고 사용자 결정을 기다림
  'error',                 // 마지막 동작이 실패 — last_error 참조, 다음 prompt 로 재시도
  'closed',                // 사용자가 닫음 — 프로세스 종료. 다시 prompt 하면 idle 처럼 재오픈
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

/** 프롬프트를 받을 수 있는 상태 — 진행 중(busy / awaiting_permission)만 아니면 매니저가 (재)오픈한다. */
export function agentSessionAcceptsPrompt(status: string | null | undefined): boolean {
  return status !== 'busy' && status !== 'awaiting_permission' && status !== 'starting';
}

export const AGENT_SESSION_EVENT_TYPES = [
  'user_prompt',          // { text }
  'text',                 // { text } — 스트리밍 청크. 같은 turn 의 연속 text 는 UI 가 병합
  'reasoning',            // { text }
  'tool_call',            // { tool_call_id, title, kind?, input? }
  'tool_update',          // { tool_call_id, status?, output? }
  'permission_request',   // { request_id, tool_call_id, title?, kind?, options: [{ option_id, name, kind }] }
  'permission_decision',  // { request_id, outcome, option_id?, decided_by: 'user'|'policy'|'timeout' }
  'usage',                // { input_tokens, output_tokens, total_tokens, … }
  'turn',                 // { phase: 'started'|'finished', stop_reason? }
  'error',                // { message, code? }
  'system',               // { text }
] as const;
export type AgentSessionEventType = (typeof AGENT_SESSION_EVENT_TYPES)[number];

/** 서버 → 매니저 요청. `request_id` 가 있으면 매니저가 `POST /api/agent/sessions/rpc/:id` 로 응답하는 RPC 다. */
export const AGENT_SESSION_REQUEST_OPS = [
  'list',        // RPC: 이 CLI 의 장비 내 세션 목록
  'history',     // RPC: 세션 기록(CLI 홈의 파일을 트랜스크립트 이벤트로 변환)
  'open',        // RPC: 세션을 연다(session_id 없으면 session/new, 있으면 session/load)
  'prompt',      // { turn_id, text } — 살아 있지 않으면 매니저가 먼저 연다
  'permission',  // { permission_request_id, option_id | null }
  'cancel',
  'set_mode',    // { mode_id }
  'close',       // 프로세스 종료
] as const;
export type AgentSessionRequestOp = (typeof AGENT_SESSION_REQUEST_OPS)[number];

/** 세션을 열 수 있는 CLI. deepseek 는 Claude CLI 홈을 공유하므로 claude 로 흡수된다. */
export const ACP_SESSION_CLIS: ReadonlySet<string> = new Set(['claude', 'codex', 'hermes']);

export interface AgentSessionModeOption {
  id: string;
  name: string;
  description?: string;
}

/** 장비의 CLI 홈에서 읽은 세션 한 줄. */
export interface AgentSessionSummary {
  cli: string;
  session_id: string;
  cwd: string;
  title: string;
  created_at: string | null;
  updated_at: string;
  /** 'cli' = CLI 홈에서 발견, 'awb' = AWB 세션 화면에서 만든 것(매니저 로컬 인덱스). */
  source: 'cli' | 'awb';
  size_bytes?: number;
}

export interface AgentSessionEventRecord {
  id: string;
  seq: number;
  turn_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** RPC 응답 크기 상한. */
export const AGENT_SESSION_LIST_LIMIT = 200;
export const AGENT_SESSION_HISTORY_EVENT_LIMIT = 4000;
export const AGENT_SESSION_PROMPT_MAX_CHARS = 100_000;
export const AGENT_SESSION_EVENT_BATCH_MAX = 200;
export const AGENT_SESSION_EVENT_PAYLOAD_MAX_CHARS = 256_000;
