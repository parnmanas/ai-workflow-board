import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';

import type { RuntimeEvent } from '../runtime-events.js';
import type {
  AcpInitializeRequest,
  AcpInitializeResponse,
  AcpLoadSessionRequest,
  AcpNewSessionRequest,
  AcpNewSessionResponse,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpPromptRequest,
  AcpPromptResponse,
  AcpSessionUpdateParams,
  AcpUsage,
} from './acp-types.js';
import { ACP_PROTOCOL_VERSION } from './acp-types.js';
import {
  AcpProtocolError,
  JsonRpcPeer,
  type JsonRpcPeerOptions,
  type JsonRpcRequestOptions,
} from './json-rpc-peer.js';
import { isChildTool } from '../collaboration-governor.js';

export { AcpProtocolError } from './json-rpc-peer.js';

export interface AcpClientSpawnOptions extends JsonRpcPeerOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnOptions?: Omit<SpawnOptionsWithoutStdio, 'cwd' | 'env' | 'shell'>;
  onEvent?: (event: RuntimeEvent) => void;
  onPermissionRequest?: (
    request: AcpPermissionRequest,
  ) => AcpPermissionOutcome | Promise<AcpPermissionOutcome>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function field(value: Record<string, unknown>, camel: string, snake: string): unknown {
  return value[camel] ?? value[snake];
}

function sanitizeDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, 2_048);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeDiagnostic(entry, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    result[key] = /token|secret|password|authorization|api.?key/i.test(key)
      ? '[REDACTED]'
      : sanitizeDiagnostic(entry, depth + 1);
  }
  return result;
}

function normalizeUsage(sessionId: string, usageValue: unknown): RuntimeEvent {
  const usage = objectValue(usageValue);
  return {
    type: 'usage',
    sessionId,
    inputTokens: numberValue(field(usage, 'inputTokens', 'input_tokens')),
    outputTokens: numberValue(field(usage, 'outputTokens', 'output_tokens')),
    totalTokens: numberValue(field(usage, 'totalTokens', 'total_tokens')),
    cachedReadTokens: numberValue(field(usage, 'cachedReadTokens', 'cached_read_tokens')),
    thoughtTokens: numberValue(field(usage, 'thoughtTokens', 'thought_tokens')),
  };
}

function normalizeUpdate(
  paramsValue: unknown,
  childToolCalls: Set<string>,
): RuntimeEvent {
  const params = objectValue(paramsValue) as unknown as AcpSessionUpdateParams;
  const sessionId = stringValue(
    (params as unknown as Record<string, unknown>).sessionId
      ?? (params as unknown as Record<string, unknown>).session_id,
  );
  const update = objectValue(params.update);
  const kind = stringValue(field(update, 'sessionUpdate', 'session_update'));

  if (kind === 'agent_message_chunk' || kind === 'user_message_chunk') {
    const content = objectValue(update.content);
    return { type: 'message_delta', sessionId, text: stringValue(content.text) };
  }
  if (kind === 'agent_thought_chunk') {
    const content = objectValue(update.content);
    return { type: 'reasoning_delta', sessionId, text: stringValue(content.text) };
  }
  if (kind === 'tool_call') {
    const toolCallId = stringValue(field(update, 'toolCallId', 'tool_call_id'));
    const title = stringValue(update.title);
    const toolKind = stringValue(update.kind) || undefined;
    if (isChildTool({ title, kind: toolKind })) {
      childToolCalls.add(toolCallId);
      return {
        type: 'child_started',
        sessionId,
        childRunId: toolCallId,
        title,
        kind: toolKind,
        input: field(update, 'rawInput', 'raw_input'),
      };
    }
    return {
      type: 'tool_started',
      sessionId,
      toolCallId,
      title,
      kind: toolKind,
      input: field(update, 'rawInput', 'raw_input'),
    };
  }
  if (kind === 'tool_call_update') {
    const status = stringValue(update.status);
    const toolCallId = stringValue(field(update, 'toolCallId', 'tool_call_id'));
    if (
      childToolCalls.has(toolCallId)
      && (status === 'completed' || status === 'failed' || status === 'cancelled')
    ) {
      childToolCalls.delete(toolCallId);
      return {
        type: 'child_finished',
        sessionId,
        childRunId: toolCallId,
        status: status as 'completed' | 'failed' | 'cancelled',
        output: field(update, 'rawOutput', 'raw_output'),
      };
    }
    return {
      type: status === 'completed' || status === 'failed'
        ? 'tool_completed'
        : 'tool_updated',
      sessionId,
      toolCallId,
      status: status || undefined,
      output: field(update, 'rawOutput', 'raw_output'),
    };
  }
  if (kind === 'usage_update') {
    const nativeUsage = update.usage ?? {
      inputTokens: update.inputTokens,
      outputTokens: update.outputTokens,
      totalTokens: update.used,
    };
    return normalizeUsage(sessionId, nativeUsage);
  }
  return {
    type: 'diagnostic',
    method: 'session/update',
    sessionId,
    data: sanitizeDiagnostic(update),
  };
}

export class AcpClient {
  readonly #peer: JsonRpcPeer;
  readonly #onEvent?: (event: RuntimeEvent) => void;
  readonly #onPermissionRequest?: AcpClientSpawnOptions['onPermissionRequest'];
  readonly #childToolCalls = new Set<string>();

  private constructor(
    peer: JsonRpcPeer,
    options: Pick<AcpClientSpawnOptions, 'onEvent' | 'onPermissionRequest'>,
  ) {
    this.#peer = peer;
    this.#onEvent = options.onEvent;
    this.#onPermissionRequest = options.onPermissionRequest;
  }

  static async spawn(options: AcpClientSpawnOptions): Promise<AcpClient> {
    if (!options.command.trim()) {
      throw new AcpProtocolError('acp_write_failed', 'ACP command is required');
    }
    let client: AcpClient | undefined;
    const child = spawn(options.command, options.args ?? [], {
      ...options.spawnOptions,
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const peer = new JsonRpcPeer(child, {
      requestTimeoutMs: options.requestTimeoutMs,
      maxLineBytes: options.maxLineBytes,
      maxMessageBytes: options.maxMessageBytes,
      onStderr: options.onStderr,
      onNotification: (method, params) => {
        if (client) client.#handleNotification(method, params);
      },
      onRequest: (method, params) => {
        if (!client) throw new Error('ACP client is not ready');
        return client.#handleRequest(method, params);
      },
    });
    client = new AcpClient(peer, options);
    return client;
  }

  get process() {
    return this.#peer.process;
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: JsonRpcRequestOptions,
  ): Promise<T> {
    return this.#peer.request<T>(method, params, options);
  }

  initialize(request: AcpInitializeRequest): Promise<AcpInitializeResponse> {
    return this.request('initialize', {
      protocolVersion: request.protocolVersion ?? ACP_PROTOCOL_VERSION,
      clientCapabilities: request.clientCapabilities ?? {},
      clientInfo: request.clientInfo,
    });
  }

  newSession(request: AcpNewSessionRequest): Promise<AcpNewSessionResponse> {
    return this.request('session/new', request);
  }

  loadSession(request: AcpLoadSessionRequest): Promise<Record<string, unknown>> {
    return this.request('session/load', request);
  }

  prompt(
    request: AcpPromptRequest,
    options?: JsonRpcRequestOptions,
  ): Promise<AcpPromptResponse> {
    return this.request('session/prompt', request, options);
  }

  cancel(sessionId: string): Promise<void> {
    this.#peer.notify('session/cancel', { sessionId });
    return Promise.resolve();
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request('session/close', { sessionId });
  }

  close(): void {
    this.#peer.close();
  }

  #handleNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      this.#onEvent?.(normalizeUpdate(params, this.#childToolCalls));
      return;
    }
    const data = objectValue(params);
    this.#onEvent?.({
      type: 'diagnostic',
      method,
      sessionId: stringValue(data.sessionId ?? data.session_id) || undefined,
      data: sanitizeDiagnostic(params),
    });
  }

  async #handleRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== 'session/request_permission') {
      throw new Error(`Unsupported ACP client request: ${method}`);
    }
    const request = params as AcpPermissionRequest;
    const outcome = this.#onPermissionRequest
      ? await this.#onPermissionRequest(request)
      : { outcome: 'cancelled' as const };
    return { outcome };
  }
}

export function runtimeEventFromPromptUsage(
  sessionId: string,
  usage?: AcpUsage,
): RuntimeEvent | null {
  return usage ? normalizeUsage(sessionId, usage) : null;
}
