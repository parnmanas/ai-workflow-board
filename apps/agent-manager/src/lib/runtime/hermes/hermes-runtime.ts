import { join, resolve } from 'node:path';

import type { AcpClientSpawnOptions } from '../acp/acp-client.js';
import type {
  AcpContentBlock,
  AcpMcpServer,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpPromptResponse,
} from '../acp/acp-types.js';
import type { RuntimeEvent } from '../runtime-events.js';
import { HermesProcess } from './hermes-process.js';
import {
  HermesSessionOwnershipError,
  HermesSessionStore,
  type HermesSessionIdentity,
  type HermesSessionRecord,
} from './hermes-session-store.js';

export { HermesSessionOwnershipError } from './hermes-session-store.js';

export interface HermesRuntimeOptions {
  rootDir: string;
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onEvent?: (agentId: string, event: RuntimeEvent) => void;
  onPermissionRequest?: (
    agentId: string,
    request: AcpPermissionRequest,
  ) => AcpPermissionOutcome | Promise<AcpPermissionOutcome>;
  onStderr?: (agentId: string, line: string) => void;
}

export interface HermesAgentOptions {
  agentId: string;
  profile?: string;
  env?: NodeJS.ProcessEnv;
}

export interface HermesRunIdentity extends HermesSessionIdentity {
  mcpServers?: AcpMcpServer[];
}

export class HermesRuntime {
  readonly #options: Required<Pick<HermesRuntimeOptions, 'command' | 'args'>> & HermesRuntimeOptions;
  readonly #rootDir: string;
  readonly #sessions: HermesSessionStore;
  readonly #processes = new Map<string, HermesProcess>();
  readonly #starting = new Map<string, Promise<HermesProcess>>();
  #loaded = false;

  constructor(options: HermesRuntimeOptions) {
    this.#rootDir = resolve(options.rootDir);
    this.#options = {
      ...options,
      command: options.command?.trim() || process.env.HERMES_ACP_COMMAND?.trim() || 'hermes-acp',
      args: options.args ?? [],
    };
    this.#sessions = new HermesSessionStore(join(this.#rootDir, 'sessions.json'));
  }

  async ensureAgent(options: HermesAgentOptions): Promise<HermesProcess> {
    await this.#ensureLoaded();
    const existing = this.#processes.get(options.agentId);
    if (existing) {
      if (
        options.profile !== undefined
        && (existing.profile ?? '') !== options.profile
      ) {
        throw new Error(`Hermes profile changed for running Agent ${options.agentId}`);
      }
      return existing;
    }
    const inFlight = this.#starting.get(options.agentId);
    if (inFlight) return inFlight;

    const processOwner = new HermesProcess({
      agentId: options.agentId,
      stateDir: join(this.#rootDir, options.agentId, 'hermes'),
      profile: options.profile,
      command: this.#options.command,
      args: this.#options.args,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      env: { ...this.#options.env, ...options.env },
      onEvent: (event) => this.#options.onEvent?.(options.agentId, event),
      onPermissionRequest: (request) => this.#options.onPermissionRequest
        ? this.#options.onPermissionRequest(options.agentId, request)
        : { outcome: 'cancelled' },
      onStderr: (line) => this.#options.onStderr?.(options.agentId, line),
    });
    const starting = processOwner.start().then(() => {
      this.#processes.set(options.agentId, processOwner);
      this.#starting.delete(options.agentId);
      return processOwner;
    }).catch((error) => {
      this.#starting.delete(options.agentId);
      throw error;
    });
    this.#starting.set(options.agentId, starting);
    return starting;
  }

  async openSession(identity: HermesRunIdentity): Promise<HermesSessionRecord> {
    await this.#ensureLoaded();
    const existing = this.#sessions.get(identity.runId);
    if (existing) return this.restoreSession(identity);
    const processOwner = await this.ensureAgent({ agentId: identity.agentId });
    const response = await processOwner.newSession({
      cwd: resolve(identity.cwd),
      mcpServers: identity.mcpServers ?? [],
    });
    return this.#sessions.set(identity, response.sessionId);
  }

  async restoreSession(identity: HermesRunIdentity): Promise<HermesSessionRecord> {
    await this.#ensureLoaded();
    const record = this.#sessions.require(identity);
    const processOwner = await this.ensureAgent({ agentId: identity.agentId });
    await processOwner.loadSession({
      sessionId: record.sessionId,
      cwd: resolve(identity.cwd),
      mcpServers: identity.mcpServers ?? [],
    });
    return record;
  }

  getSession(agentId: string, runId: string): HermesSessionRecord | null {
    const record = this.#sessions.get(runId);
    return record?.agentId === agentId ? record : null;
  }

  async promptRun(
    agentId: string,
    runId: string,
    prompt: AcpContentBlock[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AcpPromptResponse> {
    const record = this.#sessions.require({
      ...(this.#sessions.get(runId) ?? {
        runId,
        leaseId: '',
        cwd: '',
      }),
      agentId,
    });
    const processOwner = await this.ensureAgent({ agentId });
    return processOwner.prompt({ sessionId: record.sessionId, prompt }, options);
  }

  async cancelRun(agentId: string, runId: string): Promise<void> {
    await this.#ensureLoaded();
    const record = this.#sessions.get(runId);
    if (!record || record.agentId !== agentId) {
      throw new HermesSessionOwnershipError(
        'hermes_session_owner_mismatch',
        `Run ${runId} is not owned by Agent ${agentId}`,
      );
    }
    const processOwner = await this.ensureAgent({ agentId });
    await processOwner.cancel(record.sessionId);
  }

  async closeRun(agentId: string, runId: string): Promise<void> {
    await this.#ensureLoaded();
    const record = this.#sessions.get(runId);
    if (!record || record.agentId !== agentId) return;
    const processOwner = await this.ensureAgent({ agentId });
    await processOwner.closeSession(record.sessionId);
    await this.#sessions.delete(runId);
  }

  async stopAgent(agentId: string): Promise<void> {
    const processOwner = this.#processes.get(agentId);
    this.#processes.delete(agentId);
    await processOwner?.stop();
  }

  async stopAll(): Promise<void> {
    const processes = Array.from(this.#processes.values());
    this.#processes.clear();
    await Promise.allSettled(processes.map((owner) => owner.stop()));
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    await this.#sessions.load();
    this.#loaded = true;
  }
}
