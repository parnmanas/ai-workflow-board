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
  'awaiting_input',        // 에이전트가 구조화된 입력(ACP elicitation: 질문/폼)을 요청하고 사용자 답을 기다림
  'error',                 // 마지막 동작이 실패 — last_error 참조, 다음 prompt 로 재시도
  'closed',                // 사용자가 닫음 — 프로세스 종료. 다시 prompt 하면 idle 처럼 재오픈
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

/** 사용자 결정을 기다리는 상태 — 카드(permission / elicitation)에 답해야 턴이 이어진다. */
export const AGENT_SESSION_WAITING_STATUSES: ReadonlySet<string> = new Set(['awaiting_permission', 'awaiting_input']);

/** 프롬프트를 받을 수 있는 상태 — 진행 중(busy / 대기 / starting)만 아니면 매니저가 (재)오픈한다. */
export function agentSessionAcceptsPrompt(status: string | null | undefined): boolean {
  return status !== 'busy' && status !== 'starting' && !AGENT_SESSION_WAITING_STATUSES.has(status || '');
}

export const AGENT_SESSION_EVENT_TYPES = [
  'user_prompt',          // { text }
  'text',                 // { text } — 스트리밍 청크. 같은 turn 의 연속 text 는 UI 가 병합
  'reasoning',            // { text }
  'tool_call',            // { tool_call_id, title, kind?, input? }
  'tool_update',          // { tool_call_id, status?, output? }
  'permission_request',   // { request_id, tool_call_id, title?, description?, kind?, options: [{ option_id, name, kind }] }
  'permission_decision',  // { request_id, outcome, option_id?, decided_by: 'user'|'policy'|'timeout'|'system' } — system: 프로세스 종료/close 로 매니저가 취소
  'elicitation_request',  // { elicitation_id, mode: 'form'|'url', message, schema? (ACP ElicitationSchema), url?, tool_call_id? } — 에이전트의 질문/폼
  'elicitation_decision', // { elicitation_id, action: 'accept'|'decline'|'cancel', content?, decided_by: 'user'|'agent'|'system' }
  'plan',                 // { entries: [{ content, priority, status }] } — 같은 turn 의 최신 plan 이 이전 것을 대체한다
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
  'elicitation', // { elicitation_id, elicitation_action: 'accept'|'decline'|'cancel', elicitation_content? } — 질문/폼 답
  'cancel',
  'set_mode',    // { mode_id }
  'set_config_option', // { config_id, config_value: string | boolean } — 모델·reasoning 등 ACP session config option
  'close',       // 프로세스 종료
] as const;
export type AgentSessionRequestOp = (typeof AGENT_SESSION_REQUEST_OPS)[number];

/** 세션을 열 수 있는 CLI. deepseek 는 Claude CLI 홈을 공유하므로 claude 로 흡수된다.
 *  opencode 는 어댑터 사이드카 없이 자기 자신이 ACP 서버다(`opencode acp`). */
export const ACP_SESSION_CLIS: ReadonlySet<string> = new Set(['claude', 'codex', 'opencode', 'hermes']);

export interface AgentSessionModeOption {
  id: string;
  name: string;
  description?: string;
}

/**
 * ACP session config option(모델·reasoning·mode 등)의 서버/UI 투영. 어댑터가 `session/new` 응답과
 * `config_option_update` 로 전체 목록을 주고, `session/set_config_option` 으로 바꾼다.
 * `type: 'select'` 는 `options` 중 하나(`current_value` 는 value id), `'boolean'` 은 on/off.
 */
export interface AgentSessionConfigOption {
  config_id: string;
  name: string;
  description?: string;
  /** ACP SessionConfigOptionCategory — 'model' | 'mode' | 'thought_level' | 'model_config' | 그 외 문자열. UI 배치 힌트일 뿐. */
  category: string;
  type: 'select' | 'boolean' | string;
  current_value: string | boolean | null;
  options: Array<{ value: string; name: string; description?: string; group?: string }>;
}

/** 어댑터가 `available_commands_update` 로 알려 준 slash command. 프롬프트 텍스트에 `/name …` 로 실어 보낸다. */
export interface AgentSessionCommand {
  name: string;
  description: string;
  /** 명령 뒤에 자유 텍스트를 받는다면 그 힌트. */
  input_hint?: string;
}

/**
 * `default_config` 안에서 레거시 `session/set_mode`(config option 이 아닌 modes) 를 가리키는 예약 키.
 * 실제 config option id 와 겹치지 않도록 `__` 접두어를 쓴다.
 */
export const AGENT_SESSION_MODE_DEFAULT_KEY = '__mode';

/**
 * 이 세션이 어떤 계정으로 도는지. 두 축이 있다:
 *   - `source` — 자격증명의 출처. `'credential'` 은 워크스페이스 Credential(CLI 설정),
 *     `'operator'` 은 그 장비 운영자의 CLI 로그인(`claude login` / `codex login`) 그대로.
 *     매니저만 아는 사실이라 매니저가 보고한다.
 *   - 나머지(`kind`/`label`/`account`) — CLI 가 실제로 쓰고 있는 신원. 어댑터가
 *     `_auth/status_update` 로 밀어 준다(claude-agent-acp · codex-acp 공통 `_meta` 확장).
 *     어댑터가 알려 주지 않으면 통째로 null — "모른다" 와 "로그아웃(`kind:'none'`)" 은 다르다.
 */
export interface AgentSessionAuth {
  source: 'credential' | 'operator';
  /** 'account' | 'api_key' | 'gateway' | 'external' | 'none' — 어댑터가 준 값 그대로. */
  kind: string;
  /** 그 자체로 화면에 쓸 수 있는 한 줄. "Claude Max", "Anthropic API key", "AWS Bedrock". */
  label: string;
  /** 두 번째 줄(키 출처, 게이트웨이 호스트 …). 없으면 `account.email` 로 대체한다. */
  detail?: string;
  account?: { email?: string; organization?: string; plan?: string };
}

export const AGENT_SESSION_CONFIG_OPTIONS_MAX = 32;
export const AGENT_SESSION_COMMANDS_MAX = 200;

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
  /** 매니저에 살아 있는 프로세스가 있을 때의 상태(list RPC 가 세션마다 실어 보낸다). 없으면 프로세스 없음. */
  live_status?: AgentSessionStatus | string;
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
