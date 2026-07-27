import type {
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpPromptResponse,
  AcpUsage,
} from './acp/acp-types.js';
import {
  HermesRuntime,
  type HermesRuntimeOptions,
} from './hermes/hermes-runtime.js';
import type { HermesSessionRecord } from './hermes/hermes-session-store.js';
import { getRuntimeDescriptor, validateRuntimeConfig } from './runtime-registry.js';
import type {
  AgentRuntimeConfig,
  RuntimeErrorCode,
} from './runtime-types.js';
import type { RuntimeEvent } from './runtime-events.js';

export type RuntimeDispatchErrorCode = RuntimeErrorCode | 'runtime_not_supported';

export class RuntimeDispatchError extends Error {
  readonly code: RuntimeDispatchErrorCode;
  readonly runtimeId: string | null;

  constructor(code: RuntimeDispatchErrorCode, runtimeId: string | null, message: string) {
    super(message);
    this.name = 'RuntimeDispatchError';
    this.code = code;
    this.runtimeId = runtimeId;
  }
}

export interface RuntimeDispatchRequest {
  agentId: string;
  runId: string;
  leaseId: string;
  cwd: string;
  apiKey: string;
  runtimeId: string;
  runtimeConfig: AgentRuntimeConfig | null | undefined;
  systemContext?: string;
  task: string;
  model?: string | null;
}

export interface RuntimeDispatchContext {
  agentId: string;
  runId: string;
  sessionId: string;
}

export interface RuntimeDispatchResult {
  sessionId: string;
  stopReason: string;
  usage: Required<Pick<AcpUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'>>
    & AcpUsage;
}

export interface RuntimeSupervisorOptions
  extends Pick<
    HermesRuntimeOptions,
    'rootDir' | 'command' | 'args' | 'requestTimeoutMs' | 'env'
  > {
  awbUrl: string;
  onEvent?: (context: RuntimeDispatchContext, event: RuntimeEvent) => void;
  requestApproval?: (
    context: RuntimeDispatchContext,
    request: AcpPermissionRequest,
  ) => AcpPermissionOutcome | Promise<AcpPermissionOutcome>;
  onStderr?: (agentId: string, line: string) => void;
}

interface SessionPolicy {
  context: RuntimeDispatchContext;
  config: AgentRuntimeConfig;
}

function normalizedUsage(value?: AcpUsage): RuntimeDispatchResult['usage'] {
  return {
    ...value,
    inputTokens: value?.inputTokens ?? 0,
    outputTokens: value?.outputTokens ?? 0,
    totalTokens: value?.totalTokens ?? 0,
  };
}

export class RuntimeSupervisor {
  readonly #runtime: HermesRuntime;
  readonly #awbUrl: string;
  readonly #onEvent?: RuntimeSupervisorOptions['onEvent'];
  readonly #requestApproval?: RuntimeSupervisorOptions['requestApproval'];
  readonly #policies = new Map<string, SessionPolicy>();

  constructor(options: RuntimeSupervisorOptions) {
    this.#awbUrl = options.awbUrl.replace(/\/$/, '');
    this.#onEvent = options.onEvent;
    this.#requestApproval = options.requestApproval;
    this.#runtime = new HermesRuntime({
      rootDir: options.rootDir,
      command: options.command,
      args: options.args,
      requestTimeoutMs: options.requestTimeoutMs,
      env: options.env,
      onEvent: (agentId, event) => this.#handleEvent(agentId, event),
      onPermissionRequest: (agentId, request) =>
        this.#handlePermission(agentId, request),
      onStderr: options.onStderr,
    });
  }

  async dispatch(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResult> {
    const runtimeId = String(request.runtimeId ?? '').trim().toLowerCase();
    let config: AgentRuntimeConfig;
    try {
      const descriptor = getRuntimeDescriptor(runtimeId);
      if (descriptor.id !== 'hermes') {
        throw new RuntimeDispatchError(
          'runtime_not_supported',
          descriptor.id,
          `RuntimeSupervisor does not own ${descriptor.id}; use its CLI adapter`,
        );
      }
      config = validateRuntimeConfig(descriptor.id, request.runtimeConfig);
    } catch (error: any) {
      if (error instanceof RuntimeDispatchError) throw error;
      throw new RuntimeDispatchError(
        error?.code ?? 'runtime_config_invalid',
        error?.runtimeId ?? (runtimeId || null),
        error?.message ?? 'Invalid runtime configuration',
      );
    }

    await this.#runtime.ensureAgent({
      agentId: request.agentId,
      profile: config.profile,
    });
    const record = await this.#runtime.openSession({
      agentId: request.agentId,
      runId: request.runId,
      leaseId: request.leaseId,
      cwd: request.cwd,
      mcpServers: [{
        name: 'awb',
        url: `${this.#awbUrl}/mcp`,
        headers: [
          { name: 'Authorization', value: `Bearer ${request.apiKey}` },
          { name: 'X-AWB-Client-Type', value: 'runtime-child' },
          { name: 'X-AWB-Agent-Id', value: request.agentId },
          { name: 'X-AWB-Run-Id', value: request.runId },
        ],
      }],
    });
    const context: RuntimeDispatchContext = {
      agentId: request.agentId,
      runId: request.runId,
      sessionId: record.sessionId,
    };
    this.#policies.set(this.#sessionKey(request.agentId, record.sessionId), {
      context,
      config,
    });

    const prompt = [
      request.systemContext?.trim()
        ? `AWB CONTROL CONTEXT\n${request.systemContext.trim()}`
        : '',
      request.model ? `RUNTIME MODEL PROFILE\n${request.model}` : '',
      `TASK\n${request.task.trim()}`,
    ].filter(Boolean).join('\n\n');
    const response = await this.#runtime.promptRun(
      request.agentId,
      request.runId,
      [{ type: 'text', text: prompt }],
    );
    return {
      sessionId: record.sessionId,
      stopReason: response.stopReason,
      usage: normalizedUsage(response.usage),
    };
  }

  async steer(
    agentId: string,
    runId: string,
    instruction: string,
  ): Promise<AcpPromptResponse> {
    return this.#runtime.promptRun(
      agentId,
      runId,
      [{ type: 'text', text: `STEERING UPDATE\n${instruction.trim()}` }],
    );
  }

  cancel(agentId: string, runId: string): Promise<void> {
    return this.#runtime.cancelRun(agentId, runId);
  }

  async close(agentId: string, runId: string): Promise<void> {
    const record = this.#runtime.getSession(agentId, runId);
    await this.#runtime.closeRun(agentId, runId);
    if (record) this.#policies.delete(this.#sessionKey(agentId, record.sessionId));
  }

  getSession(agentId: string, runId: string): HermesSessionRecord | null {
    return this.#runtime.getSession(agentId, runId);
  }

  async stopForAgent(agentId: string): Promise<{ count: number; inflight: [] }> {
    await this.#runtime.stopAgent(agentId);
    for (const [key, policy] of this.#policies) {
      if (policy.context.agentId === agentId) this.#policies.delete(key);
    }
    return { count: 1, inflight: [] };
  }

  stopAll(): Promise<void> {
    this.#policies.clear();
    return this.#runtime.stopAll();
  }

  #handleEvent(agentId: string, event: RuntimeEvent): void {
    const sessionId = 'sessionId' in event ? event.sessionId : undefined;
    if (!sessionId) return;
    const policy = this.#policies.get(this.#sessionKey(agentId, sessionId));
    if (policy) this.#onEvent?.(policy.context, event);
  }

  async #handlePermission(
    agentId: string,
    request: AcpPermissionRequest,
  ): Promise<AcpPermissionOutcome> {
    const policy = this.#policies.get(this.#sessionKey(agentId, request.sessionId));
    if (!policy || policy.config.permission_mode === 'strict') {
      return { outcome: 'cancelled' };
    }
    if (policy.config.permission_mode === 'approve') {
      return this.#requestApproval
        ? this.#requestApproval(policy.context, request)
        : { outcome: 'cancelled' };
    }
    const allowed = request.options.find((option) =>
      option.kind === 'allow_once'
      || option.kind === 'allow_session'
      || option.kind === 'allow_always',
    );
    return allowed
      ? { outcome: 'selected', optionId: allowed.optionId }
      : { outcome: 'cancelled' };
  }

  #sessionKey(agentId: string, sessionId: string): string {
    return `${agentId}:${sessionId}`;
  }
}

