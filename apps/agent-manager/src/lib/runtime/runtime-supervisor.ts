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
import {
  CollaborationGovernor,
  CollaborationPolicyError,
} from './collaboration-governor.js';

export type RuntimeDispatchErrorCode =
  | RuntimeErrorCode
  | 'runtime_not_supported'
  | 'runtime_collaboration_denied';

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
  // ticket a837879c 2차 재리뷰 지적 #1: this dispatch's own RuntimeEvent stream
  // (scoped to just this call, unlike the constructor-level `onEvent` which
  // fans out across every session). Lets a caller collect e.g. `message_delta`
  // text to confirm what was actually said, instead of inferring delivery
  // from `stopReason` alone.
  onEvent?: (event: RuntimeEvent) => void;
}

export interface RuntimeDispatchContext {
  agentId: string;
  runId: string;
  sessionId: string;
  strategy: AgentRuntimeConfig['strategy'];
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
  onEvent?: (event: RuntimeEvent) => void;
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
  readonly #collaboration = new CollaborationGovernor();
  readonly #healthyAgents = new Set<string>();

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
    // A successful ACP initialize handshake is the Runtime Host's live
    // capability probe. Swarm is never downgraded if this probe fails.
    this.#healthyAgents.add(request.agentId);
    this.#collaboration.assertStrategy(
      config,
      this.#healthyAgents.has(request.agentId),
    );
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
          { name: 'X-AWB-Execution-Strategy', value: config.strategy },
        ],
      }],
    });
    const context: RuntimeDispatchContext = {
      agentId: request.agentId,
      runId: request.runId,
      sessionId: record.sessionId,
      strategy: config.strategy,
    };
    this.#policies.set(this.#sessionKey(request.agentId, record.sessionId), {
      context,
      config,
      onEvent: request.onEvent,
    });

    const prompt = [
      request.systemContext?.trim()
        ? `AWB CONTROL CONTEXT\n${request.systemContext.trim()}`
        : '',
      request.model ? `RUNTIME MODEL PROFILE\n${request.model}` : '',
      `AWB COLLABORATION POLICY\n${JSON.stringify({
        strategy: config.strategy,
        max_children: config.max_children ?? (config.strategy === 'single' ? 0 : 3),
        max_iterations: config.max_iterations ?? (config.strategy === 'single' ? 0 : 3),
        max_depth: config.extra?.max_depth ?? (config.strategy === 'single' ? 0 : 2),
        max_concurrency: config.extra?.max_concurrency ?? (config.strategy === 'single' ? 0 : 3),
        allowed_child_tools: config.extra?.allowed_child_tools ?? [],
        allowed_child_skills: config.extra?.allowed_child_skills ?? [],
        child_terminal_transitions: false,
        skill_changes: 'proposal_only',
      })}`,
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
    if (record) {
      const key = this.#sessionKey(agentId, record.sessionId);
      this.#policies.delete(key);
      this.#collaboration.clear(key);
    }
  }

  getSession(agentId: string, runId: string): HermesSessionRecord | null {
    return this.#runtime.getSession(agentId, runId);
  }

  async stopForAgent(agentId: string): Promise<{ count: number; inflight: [] }> {
    const stopped = await this.#runtime.stopAgent(agentId);
    this.#healthyAgents.delete(agentId);
    for (const [key, policy] of this.#policies) {
      if (policy.context.agentId === agentId) {
        this.#policies.delete(key);
        this.#collaboration.clear(key);
      }
    }
    return { count: stopped ? 1 : 0, inflight: [] };
  }

  stopAll(): Promise<void> {
    this.#healthyAgents.clear();
    for (const key of this.#policies.keys()) this.#collaboration.clear(key);
    this.#policies.clear();
    return this.#runtime.stopAll();
  }

  #handleEvent(agentId: string, event: RuntimeEvent): void {
    const sessionId = 'sessionId' in event ? event.sessionId : undefined;
    if (!sessionId) return;
    const key = this.#sessionKey(agentId, sessionId);
    const policy = this.#policies.get(key);
    if (!policy) return;
    if (event.type === 'child_started') {
      if (policy.config.permission_mode === 'strict') {
        this.#onEvent?.(policy.context, {
          type: 'diagnostic',
          method: 'collaboration/denied',
          sessionId,
          data: { reason: 'strict permission mode forbids child creation' },
        });
        void this.#runtime.cancelRun(agentId, policy.context.runId);
        return;
      }
      try {
        this.#collaboration.observeStarted(
          key,
          policy.config,
          event,
          this.#healthyAgents.has(agentId),
        );
      } catch (error) {
        this.#onEvent?.(policy.context, {
          type: 'diagnostic',
          method: 'collaboration/denied',
          sessionId,
          data: { reason: error instanceof Error ? error.message : String(error) },
        });
        void this.#runtime.cancelRun(agentId, policy.context.runId);
        return;
      }
    } else if (event.type === 'child_finished') {
      this.#collaboration.finish(key, event.childRunId);
    }
    this.#onEvent?.(policy.context, event);
    policy.onEvent?.(event);
  }

  async #handlePermission(
    agentId: string,
    request: AcpPermissionRequest,
  ): Promise<AcpPermissionOutcome> {
    const policy = this.#policies.get(this.#sessionKey(agentId, request.sessionId));
    if (!policy || policy.config.permission_mode === 'strict') {
      return { outcome: 'cancelled' };
    }
    let outcome: AcpPermissionOutcome;
    if (policy.config.permission_mode === 'approve') {
      outcome = this.#requestApproval
        ? await this.#requestApproval(policy.context, request)
        : { outcome: 'cancelled' };
    } else {
      const allowed = request.options.find((option) =>
        option.kind === 'allow_once'
        || option.kind === 'allow_session'
        || option.kind === 'allow_always',
      );
      outcome = allowed
        ? { outcome: 'selected', optionId: allowed.optionId }
        : { outcome: 'cancelled' };
    }
    if (outcome.outcome !== 'selected') return outcome;
    try {
      this.#collaboration.reservePermission(
        this.#sessionKey(agentId, request.sessionId),
        policy.config,
        request,
        this.#healthyAgents.has(agentId),
      );
      return outcome;
    } catch (error) {
      if (error instanceof CollaborationPolicyError) {
        this.#onEvent?.(policy.context, {
          type: 'diagnostic',
          method: 'collaboration/denied',
          sessionId: request.sessionId,
          data: { reason: error.message },
        });
        return { outcome: 'cancelled' };
      }
      throw error;
    }
  }

  #sessionKey(agentId: string, sessionId: string): string {
    return `${agentId}:${sessionId}`;
  }
}
