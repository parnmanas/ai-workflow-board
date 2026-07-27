import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { terminateDetachedProcessTree } from '../../process-tree.js';
import {
  AcpClient,
  type AcpClientSpawnOptions,
} from '../acp/acp-client.js';
import type {
  AcpLoadSessionRequest,
  AcpNewSessionRequest,
  AcpNewSessionResponse,
  AcpPromptRequest,
  AcpPromptResponse,
} from '../acp/acp-types.js';

const SAFE_INHERITED_ENV = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]);

export interface HermesProcessOptions
  extends Pick<
    AcpClientSpawnOptions,
    'command' | 'args' | 'requestTimeoutMs' | 'onEvent' | 'onPermissionRequest' | 'onStderr'
  > {
  agentId: string;
  stateDir: string;
  profile?: string;
  env?: NodeJS.ProcessEnv;
}

function buildEnvironment(options: HermesProcessOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_INHERITED_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, options.env ?? {});
  env.HERMES_HOME = options.stateDir;
  env.AWB_AGENT_ID = options.agentId;
  if (options.profile) env.HERMES_PROFILE = options.profile;
  return env;
}

export class HermesProcess {
  readonly agentId: string;
  readonly stateDir: string;
  readonly profile?: string;
  readonly #options: HermesProcessOptions;
  #client: AcpClient | null = null;
  #healthy = false;

  constructor(options: HermesProcessOptions) {
    this.agentId = options.agentId;
    this.stateDir = options.stateDir;
    this.profile = options.profile;
    this.#options = options;
  }

  get healthy(): boolean {
    return this.#healthy;
  }

  get processPid(): number | null {
    return this.#client?.process.pid ?? null;
  }

  async start(): Promise<this> {
    if (this.#client && this.#healthy) return this;
    await fsp.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const client = await AcpClient.spawn({
      command: this.#options.command,
      args: this.#options.args,
      env: buildEnvironment(this.#options),
      requestTimeoutMs: this.#options.requestTimeoutMs,
      onEvent: this.#options.onEvent,
      onPermissionRequest: this.#options.onPermissionRequest,
      onStderr: this.#options.onStderr,
      spawnOptions: {
        detached: process.platform !== 'win32',
      },
    });
    this.#client = client;
    try {
      await client.initialize({
        clientInfo: { name: 'awb-runtime-host', version: '1' },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      const pid = client.process.pid;
      if (!pid) throw new Error('Hermes ACP process did not expose a pid');
      await fsp.writeFile(
        join(this.stateDir, 'runtime-owner.json'),
        JSON.stringify({ pid, ownerPid: process.pid, agentId: this.agentId }),
        { mode: 0o600 },
      );
      this.#healthy = true;
      return this;
    } catch (error) {
      client.close();
      this.#client = null;
      throw error;
    }
  }

  async newSession(request: AcpNewSessionRequest): Promise<AcpNewSessionResponse> {
    return this.#requireClient().newSession(request);
  }

  async loadSession(request: AcpLoadSessionRequest): Promise<void> {
    await this.#requireClient().loadSession(request);
  }

  prompt(
    request: AcpPromptRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<AcpPromptResponse> {
    return this.#requireClient().prompt(request, options);
  }

  cancel(sessionId: string): Promise<void> {
    return this.#requireClient().cancel(sessionId);
  }

  closeSession(sessionId: string): Promise<void> {
    return this.#requireClient().closeSession(sessionId);
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#healthy = false;
    const pid = client?.process.pid;
    client?.close();
    if (pid) await terminateDetachedProcessTree(pid, 250);
    await fsp.unlink(join(this.stateDir, 'runtime-owner.json')).catch(() => undefined);
  }

  #requireClient(): AcpClient {
    if (!this.#client || !this.#healthy) {
      throw new Error(`Hermes process for Agent ${this.agentId} is not healthy`);
    }
    return this.#client;
  }
}

