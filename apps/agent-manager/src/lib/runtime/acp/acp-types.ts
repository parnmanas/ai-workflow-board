export const ACP_PROTOCOL_VERSION = 1;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export interface AcpImplementation {
  name: string;
  version: string;
}

export interface AcpInitializeRequest {
  protocolVersion?: number;
  clientCapabilities?: Record<string, unknown>;
  clientInfo: AcpImplementation;
}

export interface AcpInitializeResponse {
  protocolVersion: number;
  agentCapabilities: Record<string, unknown>;
  agentInfo: AcpImplementation;
  authMethods?: unknown[];
}

export interface AcpNameValue {
  name: string;
  value: string;
}

// ACP models mcpServers as a union discriminated on `type`: the http/sse
// variants REQUIRE the literal, and the stdio variant (which carries no
// `type`) REQUIRES command/args/env. A transport-less `{ name, url, headers }`
// matches no variant and the agent rejects session/new with -32602 Invalid
// params, so these fields must not be optional on a single flat interface.
export interface AcpHttpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers: AcpNameValue[];
}

export interface AcpSseMcpServer {
  type: 'sse';
  name: string;
  url: string;
  headers: AcpNameValue[];
}

export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: AcpNameValue[];
}

export type AcpMcpServer =
  | AcpHttpMcpServer
  | AcpSseMcpServer
  | AcpStdioMcpServer;

export interface AcpNewSessionRequest {
  cwd: string;
  mcpServers?: AcpMcpServer[];
}

export interface AcpNewSessionResponse {
  sessionId: string;
  models?: unknown;
  modes?: unknown;
  /** ACP session config options(모델·reasoning·mode …). `session/load` 응답과 `config_option_update` 도 같은 모양. */
  configOptions?: unknown;
}

/** ACP SessionConfigOption — `select` 는 options 중 하나(currentValue = value id), `boolean` 은 on/off. */
export interface AcpSessionConfigOption {
  configId: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: 'select' | 'boolean' | string;
  currentValue?: unknown;
  options?: unknown;
  [key: string]: unknown;
}

/** `session/set_config_option` — value 는 select 면 `{ type: 'id', value }`, boolean 이면 `{ type: 'boolean', value }`. */
export type AcpSetConfigOptionRequest =
  | { sessionId: string; configId: string; type: 'id'; value: string }
  | { sessionId: string; configId: string; type: 'boolean'; value: boolean };

/**
 * `_auth/status_update` — 어댑터가 자기 로그인 신원을 알려 주는 push 전용 알림
 * (claude-agent-acp · codex-acp 가 같은 `_meta` 확장을 구현한다). 연결 단위이고 요청 경로는
 * 없다. 바뀔 때만 오고, "모른다" 는 침묵으로 표현된다 — `kind:'none'` 은 "로그아웃됨" 이라는 값이다.
 */
export const ACP_AUTH_STATUS_METHOD = '_auth/status_update';

export interface AcpAuthStatus {
  kind: string;
  label: string;
  detail?: string;
  account?: { email?: string; organization?: string; plan?: string };
  [key: string]: unknown;
}

export interface AcpAvailableCommand {
  name: string;
  description?: string;
  input?: { type?: string; hint?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}

/** `elicitation/create` — 에이전트가 사용자에게 구조화된 입력(폼) 또는 URL 방문을 요청한다. */
export interface AcpElicitationRequest {
  message: string;
  mode: 'form' | 'url' | string;
  /** form: JSON Schema(primitive 속성만). */
  requestedSchema?: Record<string, unknown>;
  /** url */
  elicitationId?: string;
  url?: string;
  sessionId?: string;
  toolCallId?: string | null;
  requestId?: string | number;
  _meta?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type AcpElicitationOutcome =
  | { action: 'accept'; content?: Record<string, unknown> | null }
  | { action: 'decline' }
  | { action: 'cancel' };

export interface AcpLoadSessionRequest extends AcpNewSessionRequest {
  sessionId: string;
}

export interface AcpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AcpPromptRequest {
  sessionId: string;
  prompt: AcpContentBlock[];
}

export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  thoughtTokens?: number;
}

export interface AcpPromptResponse {
  stopReason: string;
  usage?: AcpUsage;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  /** 어댑터(claude-agent-acp / codex-acp)가 보내는 대상 tool call. 최신 스키마는 `subject`/`title` 로도 온다. */
  toolCall?: {
    toolCallId: string;
    title?: string;
    kind?: string;
    [key: string]: unknown;
  };
  /** 권한 프롬프트 제목/설명(ACP 최신 스키마, claude-agent-acp 는 `_meta.permission` 에도 같은 값을 둔다). */
  title?: string;
  description?: string | null;
  subject?: { toolCallId?: string; [key: string]: unknown } | null;
  options: AcpPermissionOption[];
  _meta?: Record<string, unknown> | null;
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: {
    sessionUpdate?: string;
    session_update?: string;
    [key: string]: unknown;
  };
}

