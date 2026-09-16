/**
 * Agent Session (CLI 직접 세션) 공유 상수·타입.
 *
 * 서버 모듈(modules/agent-sessions), SSE contract(stream-events.ts), agent-manager
 * (apps/agent-manager/src/lib/agent-session-runner.ts)가 같은 문자열 집합을 본다.
 * 값 추가/변경은 서버·agent-manager 를 같은 PR 로 묶을 것 — CLAUDE.md "Agent
 * Manager sync" 규칙과 동일한 contract 다.
 */

export const AGENT_SESSION_STATUSES = [
  'starting',              // 서버가 생성, 매니저가 아직 ACP 프로세스를 열지 않음
  'ready',                 // ACP 세션이 열려 있고 프롬프트를 받을 수 있음
  'busy',                  // 프롬프트 턴 진행 중
  'awaiting_permission',   // 에이전트가 permission 을 요청하고 사용자 결정을 기다림
  'suspended',             // 살아 있는 프로세스 없음(유휴 회수/매니저 재시작) — 다음 프롬프트가 다시 연다
  'closed',                // 사용자가 닫음. 트랜스크립트는 남고 프롬프트 불가
  'error',                 // 마지막 동작이 실패. last_error 참조. 다음 프롬프트로 재시도 가능
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

/** 프롬프트를 받을 수 있는 상태 — closed 만 아니면 매니저가 (재)오픈을 시도한다. */
export function agentSessionAcceptsPrompt(status: string): boolean {
  return status !== 'closed';
}

export const AGENT_SESSION_EVENT_TYPES = [
  'user_prompt',          // { text }
  'text',                 // { text } — 스트리밍 청크. 같은 turn 의 연속 text 는 UI 가 병합
  'reasoning',            // { text } — 사고 청크(접힘 표시)
  'tool_call',            // { tool_call_id, title, kind?, input? }
  'tool_update',          // { tool_call_id, status?, output? }
  'permission_request',   // { request_id, tool_call_id, title?, kind?, options: [{ option_id, name, kind }] }
  'permission_decision',  // { request_id, outcome: 'selected'|'cancelled', option_id?: string|null, decided_by: 'user'|'policy'|'timeout' }
  'usage',                // { input_tokens, output_tokens, total_tokens, cached_read_tokens?, thought_tokens? }
  'turn',                 // { phase: 'started'|'finished', stop_reason?: string }
  'error',                // { message, code? }
  'system',               // { text } — 세션 열림/복원/프로세스 종료 등 매니저 안내
] as const;
export type AgentSessionEventType = (typeof AGENT_SESSION_EVENT_TYPES)[number];

export const AGENT_SESSION_REQUEST_OPS = [
  'open',        // ACP 프로세스/세션을 미리 연다(생성 직후 워밍업)
  'prompt',      // { turn_id, text } — 세션이 없으면 매니저가 먼저 연다
  'permission',  // { request_id, option_id | null } — 사용자의 권한 결정
  'cancel',      // 진행 중 턴 취소 (session/cancel)
  'set_mode',    // { mode_id } — ACP session/set_mode
  'close',       // 프로세스 종료 + 세션 닫힘
] as const;
export type AgentSessionRequestOp = (typeof AGENT_SESSION_REQUEST_OPS)[number];

export const AGENT_SESSION_PERMISSION_POLICIES = ['ask', 'auto_allow'] as const;
export type AgentSessionPermissionPolicy = (typeof AGENT_SESSION_PERMISSION_POLICIES)[number];

/**
 * ACP 어댑터가 알려진 런타임. agent-manager 의 `resolveAcpCommandForRuntime` 이 같은
 * 집합을 기본 명령으로 매핑한다(claude → claude-agent-acp, codex → codex-acp,
 * hermes → hermes-acp, deepseek → claude-agent-acp + 자체 env). 그 밖의 타입은
 * `runtime_config.extra.acp_command` 가 있어야 세션을 열 수 있다.
 */
export const ACP_NATIVE_RUNTIMES: ReadonlySet<string> = new Set(['claude', 'codex', 'hermes', 'deepseek']);

export interface AgentSessionRuntimeResolution {
  runtime: string;
  supported: boolean;
  reason: string | null;
}

export function resolveAgentSessionRuntime(agent: {
  type?: string | null;
  runtime_config?: Record<string, any> | null;
}): AgentSessionRuntimeResolution {
  const runtime = String(agent.type || '').trim().toLowerCase();
  if (!runtime) return { runtime: '', supported: false, reason: 'agent_type_missing' };
  if (runtime === 'manager') return { runtime, supported: false, reason: 'manager_identity' };
  const override = agent.runtime_config?.extra?.acp_command;
  if (typeof override === 'string' && override.trim()) return { runtime, supported: true, reason: null };
  if (ACP_NATIVE_RUNTIMES.has(runtime)) return { runtime, supported: true, reason: null };
  return { runtime, supported: false, reason: 'no_acp_adapter' };
}

/** 프롬프트 1건 최대 길이(문자). 첨부는 v1 범위 밖. */
export const AGENT_SESSION_PROMPT_MAX_CHARS = 100_000;
/** 매니저가 한 번에 append 할 수 있는 이벤트 수 상한. */
export const AGENT_SESSION_EVENT_BATCH_MAX = 200;
/** 이벤트 payload(JSON 직렬화) 상한 — 초과분은 매니저가 잘라 보낸다. */
export const AGENT_SESSION_EVENT_PAYLOAD_MAX_CHARS = 256_000;
