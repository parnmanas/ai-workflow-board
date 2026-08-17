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
}

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
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    [key: string]: unknown;
  };
  options: AcpPermissionOption[];
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

