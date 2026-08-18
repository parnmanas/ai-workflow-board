import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
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

/**
 * Hermes 루트 디렉터리 — 프로파일이 사는 곳의 부모.
 *
 * hermes_constants._get_platform_default_hermes_home() 의 이식이다:
 * win32 는 `%LOCALAPPDATA%\hermes`, 그 외는 `~/.hermes`. 여기서 벗어나면
 * Hermes 가 우리가 넘긴 HERMES_HOME 을 "커스텀 배포 루트"로 오인하므로
 * 계산식을 그쪽과 반드시 일치시킨다.
 */
function hermesRoot(): string {
  if (process.platform === 'win32') {
    const localAppData = (process.env.LOCALAPPDATA ?? '').trim();
    return join(localAppData || join(homedir(), 'AppData', 'Local'), 'hermes');
  }
  return join(homedir(), '.hermes');
}

/** hermes_cli.profiles.normalize_profile_name 이식 — 디스크상 id 는 소문자. */
function normalizeProfileName(name: string): string {
  const stripped = name.trim();
  return stripped.toLowerCase();
}

/**
 * 프로파일 이름을 실제 HERMES_HOME 경로로 해석한다.
 *
 * 우리가 띄우는 실행 파일은 `hermes` CLI 가 아니라 **`hermes-acp`**(acp_adapter/
 * entry.py)이고, 이쪽 argparse 는 `--version/--check/--setup/--setup-browser/
 * --yes` 만 받는다. `--profile` 을 넘기면 argparse 가 exit(2) 로 즉사한다.
 * hermes-acp 가 프로파일을 인식하는 유일한 통로는 HERMES_HOME 이며, 프로파일
 * home 은 `<root>/profiles/<name>` 이다(profiles.py `_get_profiles_root`).
 * `default` 는 루트 home 자체를 가리키는 별칭이라 profiles/ 아래가 아니다.
 */
function resolveProfileHome(profile: string): string {
  const name = normalizeProfileName(profile);
  if (!name || name === 'default') return hermesRoot();
  return join(hermesRoot(), 'profiles', name);
}

function buildEnvironment(options: HermesProcessOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_INHERITED_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, options.env ?? {});
  // 프로파일이 지정되면 그 프로파일의 home 을, 아니면 agent 별 격리 상태
  // 디렉터리를 HERMES_HOME 으로 넘긴다. 예전 구현은 프로파일이 있으면
  // HERMES_HOME 을 아예 세팅하지 않고 `--profile` 로 넘겼는데, 그건 `hermes`
  // CLI 의 계약이지 `hermes-acp` 의 계약이 아니었다(resolveProfileHome 주석).
  env.HERMES_HOME = options.profile ? resolveProfileHome(options.profile) : options.stateDir;
  env.AWB_AGENT_ID = options.agentId;
  // 프로파일 선택에는 쓰이지 않지만(선택은 위의 HERMES_HOME 이 전담한다)
  // kanban 툴의 assignee/author 라벨이 이 env var 를 읽으므로 유지한다.
  if (options.profile) env.HERMES_PROFILE = options.profile;
  return env;
}

function buildArgs(options: HermesProcessOptions): string[] {
  // `hermes-acp` 에는 프로파일 플래그가 없다 — 프로파일은 buildEnvironment 의
  // HERMES_HOME 으로만 전달한다. 여기에 `--profile` 을 다시 넣으면 argparse
  // exit(2) 로 spawn 자체가 실패한다.
  return [...(options.args ?? [])];
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
      args: buildArgs(this.#options),
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

