// Agent Session (CLI 직접 세션) 러너 — docs/agent-sessions.md.
//
// 세션의 단위는 **(이 Runtime Host, CLI, CLI 네이티브 세션 id)** 다. AWB 서버는
// `agent_session_request` SSE 로 (1) list / history / open 을 RPC 로 묻고, (2) prompt /
// permission / cancel / set_mode / close 를 fire-and-forget 으로 보낸다. 러너는
//   - 목록·기록은 AgentSessionStore(CLI 홈의 세션 파일)에서 읽어 RPC 로 응답하고,
//   - 세션당 하나의 ACP 어댑터 프로세스(claude-agent-acp / codex-acp / hermes-acp /
//     사용자 지정)를 띄워 **운영자의 CLI 홈 그대로** session/load 또는 session/new 로 연 뒤,
//   - 스트림(text · reasoning · tool call · permission · usage)을 가공 없이 서버로 중계한다.
//
// 기존 chat/ticket 세션 매니저와 달리 AWB Agent identity·프롬프트 래핑·히스토리 재조립이
// 없다. 답변은 MCP 툴 호출이 아니라 agent_message_chunk 스트림이다.

import { access, constants as fsConstants, lstat, mkdir, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { delimiter, join } from 'node:path';

import { AgentSessionStore, resolveClaudeHome, resolveCodexHome, type HistoryEvent, type SessionSummary } from './agent-session-store.js';
import { AGENT_MANAGER_HOME } from './constants.js';
import { normalizeCredentialFields } from './credential-fields.js';
import { log } from './logging.js';
import { terminateDetachedProcessTree } from './process-tree.js';
import {
  fetchSessionCredential,
  patchAgentSessionState,
  postAgentSessionEvents,
  postAgentSessionRpcResponse,
  type AgentSessionEventInput,
  type AgentSessionRef,
  type AgentSessionStatePatch,
  type AwbConfig,
} from './rest.js';
import { createRuntimeCliAdapter } from './runtime/runtime-registry.js';
import { AcpClient } from './runtime/acp/acp-client.js';
import type { AcpMcpServer, AcpPermissionOutcome, AcpPermissionRequest } from './runtime/acp/acp-types.js';
import { resolveHermesAcpCommand } from './runtime/hermes/hermes-command.js';
import type { RuntimeEvent } from './runtime/runtime-events.js';

/** 서버 payload (apps/server/src/common/types/stream-events.ts AgentSessionRequestPayload). */
export interface AgentSessionRequest {
  manager_id: string;
  workspace_id?: string;
  cli: string;
  op: 'list' | 'history' | 'open' | 'prompt' | 'permission' | 'cancel' | 'set_mode' | 'close';
  request_id?: string;
  session_id?: string | null;
  cwd?: string;
  title?: string;
  turn_id?: string;
  text?: string;
  permission_request_id?: string;
  option_id?: string | null;
  mode_id?: string;
  /** CLI 설정에 묶인 워크스페이스 Credential(open/prompt). 없으면 운영자 로그인 그대로. */
  credential_id?: string | null;
  driver_user_id: string;
  issued_at: string;
}

export interface ResolvedAcpCommand {
  command: string;
  args: string[];
}

export interface AgentSessionRunnerOptions {
  /** 매니저 자신의 agent identity — 서버 라우팅/응답 소유 검증에 쓴다. */
  getManagerId: () => string;
  store?: AgentSessionStore;
  /** 30분 유휴 시 프로세스 회수(세션은 CLI 홈에 남아 있으므로 다음 prompt 가 다시 연다). */
  idleMinutes?: number;
  permissionTimeoutMs?: number;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  flushIntervalMs?: number;
  /** 테스트용 명령 해석 override. */
  commandResolver?: (cli: string) => Promise<ResolvedAcpCommand>;
  baseEnv?: NodeJS.ProcessEnv;
  clientVersion?: string;
  /** 세션 프로세스에 주입할 AWB MCP 서버 — 기본은 매니저 키로 인증하는 http 서버. */
  mcpServers?: (sessionId: string) => AcpMcpServer[];
  /** credential 이 묶인 세션의 전용 cli-home 루트. 기본 `$AWB_AGENT_MANAGER_HOME/session-homes`. */
  sessionHomesDir?: string;
  /** 테스트용 credential 조회 override. */
  credentialFetcher?: (credentialId: string, workspaceId: string) => Promise<SessionCredential | null>;
}

export interface SessionCredential {
  credential_id: string;
  provider: string;
  fields: Record<string, string>;
}

/** CLI → 호환 credential provider 접두어(서버 SESSION_CLI_CREDENTIAL_PREFIX 와 같은 규약). */
export const SESSION_CLI_CREDENTIAL_PREFIX: Record<string, string> = {
  claude: 'claude_',
  codex: 'codex_',
};

/** provider 별 비어 있으면 안 되는 필드 — agent-manager-commands.ts 의 REQUIRED_CREDENTIAL_FIELDS 와 같은 규약. */
const SESSION_REQUIRED_CREDENTIAL_FIELDS: Record<string, string[]> = {
  claude_subscription: ['credentials_json'],
  claude_api_key: ['api_key'],
  claude_oauth_token: ['oauth_token'],
  codex_subscription: ['auth_json'],
  codex_api_key: ['api_key'],
};

/**
 * 오류 문구에서 bearer 토큰/API 키를 가린다. CLI/SDK 오류가 헤더 값을 그대로 인용하는
 * 경우가 있어(예: 잘못된 헤더 값 오류에 토큰 전체가 실린다) 그대로 중계하면 트랜스크립트와
 * 로그에 비밀이 남는다.
 */
export function redactSecrets(text: string): string {
  return String(text ?? '')
    .replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer <redacted>')
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-<redacted>')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-<redacted>')
    .replace(/(api[_-]?key|oauth[_-]?token|access[_-]?token|refresh[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2<redacted>');
}

/** CLI 홈 안에서 세션 기록이 사는 하위 디렉터리 — 세션 전용 홈에서 운영자 홈으로 링크한다. */
const SESSION_STORE_SUBDIR: Record<string, string> = {
  claude: 'projects',
  codex: 'sessions',
};

interface SessionAuth {
  label: string;
  env: Record<string, string>;
  stripEnvKeys: string[];
  cliHome: string | null;
}

interface PendingPermission {
  resolve: (outcome: AcpPermissionOutcome) => void;
  timer: NodeJS.Timeout;
}

interface LiveSession {
  cli: string;
  sessionId: string;
  cwd: string;
  title: string;
  client: AcpClient;
  loadSupported: boolean;
  /** session/load 가 기록을 재생하는 동안 true — 재생 이벤트는 UI 가 이미 history 로 가졌으므로 버린다. */
  loading: boolean;
  pendingPermissions: Map<string, PendingPermission>;
  turn: { turnId: string; startedAt: number } | null;
  textBuffer: string;
  reasoningBuffer: string;
  flushTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  postChain: Promise<void>;
  seq: number;
  /** 프로세스마다 다른 id 접두어 — 라이브 seq 는 프로세스마다 1 부터라 id 만으로 중복을 걸러야 한다. */
  nonce: string;
  /** 이 프로세스에 적용된 CLI 설정 credential('' = 운영자 로그인). 바인딩이 바뀌면 재오픈한다. */
  credentialId: string;
  closing: boolean;
  exited: boolean;
}

const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_PERMISSION_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 6 * 60 * 60_000;
const DEFAULT_FLUSH_INTERVAL_MS = 150;
const MAX_TOOL_TEXT_CHARS = 16_000;
const MAX_PAYLOAD_CHARS = 200_000;
const ALLOW_KINDS = new Set(['allow_once', 'allow_always', 'allow_session']);
export const ACP_SESSION_CLIS = ['claude', 'codex', 'hermes'] as const;

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]` : value;
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return truncateText(value, MAX_TOOL_TEXT_CHARS);
  if (typeof value !== 'object' || value === null) return value;
  if (depth > 6) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => boundedValue(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    out[key] = boundedValue(entry, depth + 1);
  }
  return out;
}

function boundedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundedValue(payload) as Record<string, unknown>;
  const serialized = JSON.stringify(bounded);
  if (serialized.length <= MAX_PAYLOAD_CHARS) return bounded;
  return { truncated: true, preview: serialized.slice(0, 4_000) };
}

export async function findOnPath(name: string): Promise<string | null> {
  const candidates = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      try {
        await access(full, fsConstants.X_OK);
        return full;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function parseCommandLine(line: string): ResolvedAcpCommand {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] || '', args: parts.slice(1) };
}

/**
 * CLI 별 ACP 어댑터 명령. 우선순위:
 *   1. env AWB_ACP_COMMAND_<CLI> (예: AWB_ACP_COMMAND_CLAUDE="node /opt/acp.js")
 *   2. PATH 의 어댑터 바이너리(claude-agent-acp / codex-acp / hermes-acp)
 *   3. npx --yes <패키지> (claude / codex)
 */
export async function resolveAcpCommandForCli(cli: string): Promise<ResolvedAcpCommand> {
  const envOverride = process.env[`AWB_ACP_COMMAND_${cli.toUpperCase()}`]?.trim();
  if (envOverride) return parseCommandLine(envOverride);
  switch (cli) {
    case 'claude': {
      const found = await findOnPath('claude-agent-acp');
      return found ? { command: found, args: [] } : { command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp'] };
    }
    case 'codex': {
      const found = await findOnPath('codex-acp');
      return found ? { command: found, args: [] } : { command: 'npx', args: ['--yes', '@zed-industries/codex-acp'] };
    }
    case 'hermes': {
      const resolved = await resolveHermesAcpCommand();
      return { command: resolved.command, args: [...resolved.argsPrefix] };
    }
    default:
      throw new Error(`No ACP adapter is known for CLI "${cli}".`);
  }
}

/** 이 장비에서 세션을 열 수 있는 CLI — 하트비트 `acp_session_clis`. PATH 만 본다(spawn 없음). */
export async function detectAcpSessionClis(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const out: string[] = [];
  if (env.AWB_ACP_COMMAND_CLAUDE || await findOnPath('claude-agent-acp') || await findOnPath('claude')) out.push('claude');
  if (env.AWB_ACP_COMMAND_CODEX || await findOnPath('codex-acp') || await findOnPath('codex')) out.push('codex');
  if (env.AWB_ACP_COMMAND_HERMES || env.HERMES_ACP_COMMAND || await findOnPath('hermes-acp') || await findOnPath('hermes')) out.push('hermes');
  return out;
}

export class AgentSessionRunner {
  readonly #config: AwbConfig;
  readonly #options: Required<Pick<AgentSessionRunnerOptions, 'idleMinutes' | 'permissionTimeoutMs' | 'requestTimeoutMs' | 'promptTimeoutMs' | 'flushIntervalMs' | 'sessionHomesDir'>>
    & Pick<AgentSessionRunnerOptions, 'commandResolver' | 'baseEnv' | 'clientVersion' | 'mcpServers' | 'getManagerId' | 'credentialFetcher'>;
  readonly #store: AgentSessionStore;
  readonly #live = new Map<string, LiveSession>();
  readonly #opening = new Map<string, Promise<LiveSession>>();

  constructor(config: AwbConfig, options: AgentSessionRunnerOptions) {
    this.#config = config;
    this.#store = options.store ?? new AgentSessionStore();
    this.#options = {
      getManagerId: options.getManagerId,
      idleMinutes: options.idleMinutes ?? DEFAULT_IDLE_MINUTES,
      permissionTimeoutMs: options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      promptTimeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      commandResolver: options.commandResolver,
      baseEnv: options.baseEnv,
      clientVersion: options.clientVersion,
      mcpServers: options.mcpServers,
      sessionHomesDir: options.sessionHomesDir ?? join(AGENT_MANAGER_HOME, 'session-homes'),
      credentialFetcher: options.credentialFetcher,
    };
  }

  get store(): AgentSessionStore {
    return this.#store;
  }

  _snapshot(): Array<{ cli: string; session_id: string; busy: boolean; pid: number | null }> {
    return Array.from(this.#live.values()).map((live) => ({
      cli: live.cli,
      session_id: live.sessionId,
      busy: live.turn !== null || live.pendingPermissions.size > 0,
      pid: live.client.process.pid ?? null,
    }));
  }

  countInFlight(): number {
    return this._snapshot().filter((s) => s.busy).length;
  }

  #ref(cli: string, sessionId: string): AgentSessionRef {
    return { manager_id: this.#options.getManagerId(), cli, session_id: sessionId };
  }

  #key(cli: string, sessionId: string): string {
    return `${cli}:${sessionId}`;
  }

  // ─── 디스패처 진입점 ──────────────────────────────────────────────────

  async handle(request: AgentSessionRequest): Promise<void> {
    const cli = String(request.cli || '').toLowerCase();
    const sessionId = request.session_id || '';
    const tag = `[agent-session ${cli}${sessionId ? ` ${sessionId.slice(0, 8)}` : ''}]`;
    if (request.request_id) {
      await this.#handleRpc(request, cli, sessionId, tag);
      return;
    }
    const liveBefore = sessionId ? this.#live.get(this.#key(cli, sessionId)) : undefined;
    try {
      switch (request.op) {
        case 'prompt': {
          if (!sessionId) return;
          const live = await this.#ensureLive(cli, sessionId, request.cwd || '', request.title || '', request);
          await this.#runPrompt(live, request.turn_id || randomUUID(), request.text || '');
          return;
        }
        case 'permission':
          this.#resolvePermission(cli, sessionId, request.permission_request_id || '', request.option_id ?? null);
          return;
        case 'cancel': {
          const live = this.#live.get(this.#key(cli, sessionId));
          if (live) await live.client.cancel(live.sessionId).catch(() => undefined);
          return;
        }
        case 'set_mode': {
          const live = this.#live.get(this.#key(cli, sessionId));
          const modeId = request.mode_id || '';
          if (!live || !modeId) return;
          await live.client.request('session/set_mode', { sessionId: live.sessionId, modeId }, { timeoutMs: this.#options.requestTimeoutMs });
          this.#enqueue(live, [{ type: 'system', payload: { text: `Mode set to ${modeId}.` } }], { current_mode: modeId, reason: 'mode' });
          return;
        }
        case 'close':
          await this.#closeLive(cli, sessionId, 'closed');
          return;
        default:
          log(`${tag} unknown op ${String(request.op)}`);
      }
      const settled = this.#live.get(this.#key(cli, sessionId)) ?? liveBefore;
      if (settled) await settled.postChain;
    } catch (err: any) {
      const message = redactSecrets(err?.message ?? String(err));
      log(`${tag} ${request.op} failed: ${message}`);
      const live = this.#live.get(this.#key(cli, sessionId));
      const failure: AgentSessionEventInput = { type: 'error', payload: { message, code: err?.code ?? undefined }, turn_id: request.turn_id };
      const state: AgentSessionStatePatch = { status: live?.turn ? 'busy' : 'error', last_error: message, reason: `${request.op}_failed` };
      if (live) {
        this.#enqueue(live, [failure], state);
        await live.postChain;
      } else if (sessionId) {
        await postAgentSessionEvents(this.#config, this.#ref(cli, sessionId), [{ ...failure, seq: 0, id: `${sessionId}:err:${Date.now()}`, created_at: new Date().toISOString() }], state);
      }
    }
  }

  async #handleRpc(request: AgentSessionRequest, cli: string, sessionId: string, tag: string): Promise<void> {
    const requestId = request.request_id!;
    const managerId = this.#options.getManagerId();
    try {
      switch (request.op) {
        case 'list': {
          const sessions = await this.#store.listSessions(cli);
          const withLive = sessions.map((s) => ({ ...s, live_status: this.#live.get(this.#key(cli, s.session_id)) ? this.#statusOf(this.#live.get(this.#key(cli, s.session_id))!) : undefined }));
          await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: true, result: { sessions: withLive } });
          return;
        }
        case 'history': {
          if (!sessionId) throw Object.assign(new Error('session_id is required'), { code: 'not_found' });
          const history = await this.#store.readHistory(cli, sessionId);
          const live = this.#live.get(this.#key(cli, sessionId));
          if (!history.session && !live) {
            await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: false, error: 'Session not found on this Runtime Host.', code: 'not_found' });
            return;
          }
          await postAgentSessionRpcResponse(this.#config, managerId, requestId, {
            ok: true,
            result: {
              session: history.session ?? (live ? this.#summaryOf(live) : null),
              events: history.events,
              truncated: history.truncated,
              live: live ? this.#stateOf(live) : null,
            },
          });
          return;
        }
        case 'open': {
          const live = await this.#ensureLive(cli, sessionId, request.cwd || '', request.title || '', request);
          await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: true, result: this.#stateOf(live) });
          return;
        }
        default:
          await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: false, error: `Unknown RPC op ${String(request.op)}`, code: 'bad_request' });
      }
    } catch (err: any) {
      const message = redactSecrets(err?.message ?? String(err));
      log(`${tag} ${request.op} rpc failed: ${message}`);
      await postAgentSessionRpcResponse(this.#config, managerId, requestId, { ok: false, error: message, code: err?.code ?? 'manager_error' });
    }
  }

  async stopAll(reason = 'manager_shutdown'): Promise<void> {
    const keys = Array.from(this.#live.values()).map((l) => [l.cli, l.sessionId] as const);
    await Promise.all(keys.map(([cli, id]) => this.#closeLive(cli, id, 'idle', reason).catch(() => undefined)));
  }

  // ─── 프로세스/세션 열기 ───────────────────────────────────────────────

  async #ensureLive(cli: string, sessionId: string, cwd: string, title: string, request: AgentSessionRequest): Promise<LiveSession> {
    if (sessionId) {
      const existing = this.#live.get(this.#key(cli, sessionId));
      if (existing && !existing.exited && !existing.closing) {
        // CLI 설정이 바뀌었으면(credential 을 묶거나 풀었으면) 살아 있는 프로세스는 옛
        // 인증으로 떠 있는 것이다 — 턴 중이 아니면 닫고 새 인증으로 다시 연다.
        const wanted = request.credential_id || '';
        if (existing.credentialId === wanted || existing.turn) return existing;
        log(`[agent-session ${cli} ${sessionId.slice(0, 8)}] credential binding changed (${existing.credentialId || 'operator-login'} → ${wanted || 'operator-login'}); reopening`);
        await this.#closeLive(cli, sessionId, 'idle', 'credential_changed');
      }
      const inFlight = this.#opening.get(this.#key(cli, sessionId));
      if (inFlight) return inFlight;
    }
    const opening = this.#open(cli, sessionId, cwd, title, request);
    if (sessionId) {
      this.#opening.set(this.#key(cli, sessionId), opening);
      opening.finally(() => this.#opening.delete(this.#key(cli, sessionId))).catch(() => undefined);
    }
    return opening;
  }

  async #open(cli: string, requestedSessionId: string, requestedCwd: string, title: string, request: AgentSessionRequest): Promise<LiveSession> {
    const tag = `[agent-session ${cli}${requestedSessionId ? ` ${requestedSessionId.slice(0, 8)}` : ' new'}]`;
    let cwd = requestedCwd.trim();
    if (requestedSessionId && !cwd) {
      // 기존 세션은 원래 cwd 로 열어야 한다(Claude Code 는 cwd 별 폴더에 기록을 둔다).
      const history = await this.#store.readHistory(cli, requestedSessionId).catch(() => null);
      cwd = history?.session?.cwd || '';
    }
    if (!cwd) throw new Error('No working directory: pass cwd for a new session.');
    try {
      await access(cwd, fsConstants.R_OK);
    } catch {
      throw new Error(`Working directory does not exist on this Runtime Host: ${cwd}`);
    }
    const resolver = this.#options.commandResolver ?? resolveAcpCommandForCli;
    const { command, args } = await resolver(cli);
    const auth = await this.#prepareAuth(cli, cwd, request);
    log(`${tag} spawning ACP adapter cmd=${command} ${args.join(' ')} cwd=${cwd} auth=${auth.label}`);

    let live: LiveSession | null = null;
    const client = await AcpClient.spawn({
      command,
      args,
      cwd,
      env: this.#buildEnv(cli, requestedSessionId || 'new', auth),
      requestTimeoutMs: this.#options.requestTimeoutMs,
      onEvent: (event) => { if (live) this.#onEvent(live, event); },
      onPermissionRequest: (permission) => (live ? this.#onPermission(live, permission) : Promise.resolve({ outcome: 'cancelled' as const })),
      onStderr: (line) => log(`${tag} stderr: ${redactSecrets(line)}`),
      spawnOptions: { detached: process.platform !== 'win32' },
    });

    try {
      const initialized = await client.initialize({
        clientInfo: { name: 'awb-agent-session', version: this.#options.clientVersion || '1' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const caps = (initialized?.agentCapabilities ?? {}) as Record<string, unknown>;
      const loadSupported = caps.loadSession === true;
      const sessionIdForMcp = requestedSessionId || 'new';
      const mcpServers = this.#options.mcpServers ? this.#options.mcpServers(sessionIdForMcp) : this.#defaultMcpServers(sessionIdForMcp);

      live = {
        cli,
        sessionId: requestedSessionId,
        cwd,
        title,
        client,
        loadSupported,
        loading: false,
        pendingPermissions: new Map(),
        turn: null,
        textBuffer: '',
        reasoningBuffer: '',
        flushTimer: null,
        idleTimer: null,
        postChain: Promise.resolve(),
        seq: 0,
        nonce: randomUUID().slice(0, 8),
        credentialId: request.credential_id || '',
        closing: false,
        exited: false,
      };

      let modes: unknown;
      let resumed = false;
      if (requestedSessionId) {
        if (!loadSupported) {
          throw Object.assign(new Error(`The ${cli} ACP adapter cannot resume existing sessions (no loadSession capability).`), { code: 'resume_unsupported' });
        }
        live.loading = true;
        try {
          const loaded = await client.loadSession({ sessionId: requestedSessionId, cwd, mcpServers });
          modes = (loaded as any)?.modes;
          resumed = true;
        } finally {
          live.loading = false;
        }
      } else {
        const created = await client.newSession({ cwd, mcpServers });
        live.sessionId = created.sessionId;
        modes = created.modes;
        await this.#store.recordAwbSession({ cli, session_id: live.sessionId, cwd, title }).catch(() => undefined);
      }
      if (!live.sessionId) throw new Error('ACP adapter returned no session id.');
      const key = this.#key(cli, live.sessionId);
      this.#live.set(key, live);
      client.process.once('exit', (code, signal) => this.#onProcessExit(key, code, signal));
      const modeInfo = this.#parseModes(modes);
      this.#enqueue(live, [{
        type: 'system',
        payload: {
          text: resumed ? `Session resumed (${cli}, ${cwd}).` : `Session opened (${cli}, ${cwd}).`,
          cli, cwd, resumed, command: `${command} ${args.join(' ')}`.trim(),
        },
      }], {
        status: 'ready',
        cwd,
        ...(title ? { title } : {}),
        current_mode: modeInfo.current,
        available_modes: modeInfo.available,
        resume_supported: loadSupported,
        last_error: null,
        reason: resumed ? 'resumed' : 'opened',
      });
      this.#touch(live);
      return live;
    } catch (err) {
      const child = client.process;
      client.close();
      if (child?.pid) await terminateDetachedProcessTree(child.pid, 250, { child }).catch(() => undefined);
      throw err;
    }
  }

  #buildEnv(cli: string, sessionId: string, auth: SessionAuth): NodeJS.ProcessEnv {
    // 기본은 운영자의 CLI 홈 그대로 — 장비에 이미 있는 세션을 그 CLI 로 이어 쓰는 것이
    // 목적이다. CLI 설정에 credential 이 묶여 있으면 세션 전용 cli-home(기록 디렉터리만
    // 운영자 홈으로 링크)과 credential env 로 바꿔 끼운다.
    const env: NodeJS.ProcessEnv = { ...(this.#options.baseEnv ?? process.env) };
    for (const key of auth.stripEnvKeys) delete env[key];
    Object.assign(env, auth.env);
    env.AWB_URL = this.#config.url;
    env.AWB_MANAGER_ID = this.#options.getManagerId();
    env.AWB_SESSION_CLI = cli;
    env.AWB_SESSION_ID = sessionId;
    return env;
  }

  /**
   * CLI 설정의 credential 을 세션 프로세스에 적용한다. 운영자 홈의 로그인 파일은 절대
   * 건드리지 않는다: credential 이 있으면 `<session-homes>/<cli>/<credential_id>` 를
   * 세션 전용 cli-home 으로 만들고(어댑터 prepareCliHome 이 자격증명 파일/env 를
   * 만든다), 그 안의 기록 디렉터리(projects / sessions)만 운영자 홈으로 심볼릭 링크해
   * 기존 세션이 그대로 보이고 이어지게 한다.
   */
  async #prepareAuth(cli: string, cwd: string, request: AgentSessionRequest): Promise<SessionAuth> {
    const none: SessionAuth = { label: 'operator-login', env: {}, stripEnvKeys: [], cliHome: null };
    const credentialId = request.credential_id || '';
    if (!credentialId) return none;
    const prefix = SESSION_CLI_CREDENTIAL_PREFIX[cli];
    if (!prefix) throw Object.assign(new Error(`${cli} sessions cannot use an AWB credential.`), { code: 'credential_unsupported' });
    const fetcher = this.#options.credentialFetcher
      ?? ((id: string, ws: string) => fetchSessionCredential(this.#config, this.#options.getManagerId(), id, ws));
    const fetched = await fetcher(credentialId, request.workspace_id || '');
    if (!fetched) throw Object.assign(new Error('The credential assigned in CLI settings could not be fetched from AWB.'), { code: 'credential_unavailable' });
    if (!fetched.provider.startsWith(prefix)) {
      throw Object.assign(new Error(`CLI settings credential provider ${fetched.provider} does not match ${cli}.`), { code: 'credential_provider_mismatch' });
    }
    // 줄바꿈 등 공백이 섞인 토큰(터미널에서 접혀 복사된 `claude setup-token` 값)은 헤더
    // 생성부터 실패한다 — managed-agent 경로와 같은 규칙으로 정리한다.
    const { fields, repaired } = normalizeCredentialFields(fetched.fields);
    if (repaired.length) log(`[agent-session ${cli}] credential ${fetched.credential_id.slice(0, 8)} whitespace repaired in: ${repaired.join(', ')}`);
    const missing = (SESSION_REQUIRED_CREDENTIAL_FIELDS[fetched.provider] ?? []).filter((key) => !fields[key]);
    if (missing.length) {
      throw Object.assign(new Error(`CLI settings credential ${fetched.provider} is missing ${missing.join(', ')} — re-save it in Settings → Credentials.`), { code: 'credential_incomplete' });
    }
    const credential: SessionCredential = { ...fetched, fields };
    const adapter = createRuntimeCliAdapter(cli);
    const cliHome = join(this.#options.sessionHomesDir, cli, credential.credential_id);
    await mkdir(cliHome, { recursive: true, mode: 0o700 });
    await this.#linkSessionStore(cli, cliHome);
    const prep = await adapter.prepareCliHome(cliHome, credential, null);
    const env: Record<string, string> = { ...(prep.extraEnv ?? {}) };
    const configDirEnv = adapter.configDirEnv();
    if (configDirEnv) env[configDirEnv] = cliHome;
    // 운영자 셸의 API 키(ANTHROPIC_API_KEY / OPENAI_API_KEY …)가 credential 을 덮지 않게 걷어낸다.
    const stripEnvKeys = adapter.authEnvKeys().filter((key) => !(key in env));
    await adapter.ensureWorkspaceTrust(cliHome, cwd).catch((err: any) => log(`[agent-session ${cli}] trust seed failed: ${err?.message ?? err}`));
    return { label: `credential:${credential.provider}`, env, stripEnvKeys, cliHome };
  }

  /** 세션 전용 cli-home 의 기록 디렉터리를 운영자 홈으로 링크한다(멱등). */
  async #linkSessionStore(cli: string, cliHome: string): Promise<void> {
    const subdir = SESSION_STORE_SUBDIR[cli];
    if (!subdir) return;
    const operatorHome = cli === 'claude' ? resolveClaudeHome(this.#options.baseEnv ?? process.env) : resolveCodexHome(this.#options.baseEnv ?? process.env);
    const target = join(operatorHome, subdir);
    const linkPath = join(cliHome, subdir);
    await mkdir(target, { recursive: true });
    try {
      const existing = await lstat(linkPath);
      if (existing.isSymbolicLink() || existing.isDirectory()) return; // 이미 링크됐거나 실제 디렉터리
    } catch {
      /* 없음 → 만든다 */
    }
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  }

  #defaultMcpServers(sessionId: string): AcpMcpServer[] {
    return [{
      type: 'http',
      name: 'awb',
      url: `${this.#config.url.replace(/\/$/, '')}/mcp`,
      headers: [
        { name: 'Authorization', value: `Bearer ${this.#config.apiKey}` },
        { name: 'X-AWB-Client-Type', value: 'agent-session' },
        { name: 'X-AWB-Session-Id', value: sessionId },
      ],
    }];
  }

  #parseModes(modes: unknown): { current: string | null; available: Array<{ id: string; name: string; description?: string }> } {
    if (!modes || typeof modes !== 'object') return { current: null, available: [] };
    const m = modes as Record<string, unknown>;
    const current = typeof m.currentModeId === 'string' ? m.currentModeId
      : typeof m.current_mode_id === 'string' ? m.current_mode_id : null;
    const list = Array.isArray(m.availableModes) ? m.availableModes : Array.isArray(m.available_modes) ? m.available_modes : [];
    const available = list
      .filter((entry: any) => entry && typeof entry.id === 'string')
      .map((entry: any) => ({
        id: entry.id as string,
        name: typeof entry.name === 'string' ? entry.name : entry.id,
        description: typeof entry.description === 'string' ? entry.description : undefined,
      }));
    return { current, available };
  }

  #statusOf(live: LiveSession): string {
    if (live.exited || live.closing) return 'idle';
    if (live.pendingPermissions.size > 0) return 'awaiting_permission';
    if (live.turn) return 'busy';
    return 'ready';
  }

  #summaryOf(live: LiveSession): SessionSummary {
    const now = new Date().toISOString();
    return { cli: live.cli, session_id: live.sessionId, cwd: live.cwd, title: live.title, created_at: now, updated_at: now, source: 'awb' };
  }

  #stateOf(live: LiveSession): Record<string, unknown> {
    return {
      session_id: live.sessionId,
      cwd: live.cwd,
      title: live.title,
      status: this.#statusOf(live),
      resume_supported: live.loadSupported,
    };
  }

  // ─── 턴 실행 ──────────────────────────────────────────────────────────

  async #runPrompt(live: LiveSession, turnId: string, text: string): Promise<void> {
    if (live.turn) {
      this.#enqueue(live, [{ type: 'error', payload: { message: 'A turn is already in progress.', code: 'turn_in_progress' }, turn_id: turnId }]);
      return;
    }
    live.turn = { turnId, startedAt: Date.now() };
    this.#clearIdle(live);
    if (!live.title) {
      live.title = text.trim().replace(/\s+/g, ' ').slice(0, 80);
      await this.#store.touchAwbSession(live.cli, live.sessionId, { title: live.title }).catch(() => undefined);
    }
    this.#enqueue(live, [{ type: 'turn', payload: { phase: 'started' }, turn_id: turnId }], { status: 'busy', title: live.title, reason: 'turn_started' });
    try {
      const response = await live.client.prompt(
        { sessionId: live.sessionId, prompt: [{ type: 'text', text }] },
        { timeoutMs: this.#options.promptTimeoutMs },
      );
      this.#flushBuffers(live, turnId);
      const events: AgentSessionEventInput[] = [];
      if (response?.usage) {
        events.push({
          type: 'usage',
          payload: {
            input_tokens: response.usage.inputTokens ?? 0,
            output_tokens: response.usage.outputTokens ?? 0,
            total_tokens: response.usage.totalTokens ?? 0,
            cached_read_tokens: response.usage.cachedReadTokens,
            thought_tokens: response.usage.thoughtTokens,
          },
          turn_id: turnId,
        });
      }
      events.push({ type: 'turn', payload: { phase: 'finished', stop_reason: response?.stopReason || 'end_turn' }, turn_id: turnId });
      this.#enqueue(live, events, { status: 'ready', last_error: null, reason: 'turn_finished' });
      await this.#store.touchAwbSession(live.cli, live.sessionId).catch(() => undefined);
    } catch (err: any) {
      this.#flushBuffers(live, turnId);
      const message = redactSecrets(err?.message ?? String(err));
      this.#enqueue(live, [
        { type: 'error', payload: { message, code: err?.code ?? undefined }, turn_id: turnId },
        { type: 'turn', payload: { phase: 'finished', stop_reason: 'error' }, turn_id: turnId },
      ], { status: live.exited ? 'idle' : 'error', last_error: message, reason: 'turn_failed' });
    } finally {
      live.turn = null;
      this.#touch(live);
      await live.postChain;
    }
  }

  // ─── ACP 스트림 → 서버 ───────────────────────────────────────────────

  #onEvent(live: LiveSession, event: RuntimeEvent): void {
    if (live.loading) return; // session/load 재생분 — history 가 이미 UI 에 있다
    const turnId = live.turn?.turnId;
    switch (event.type) {
      case 'message_delta':
        live.textBuffer += event.text;
        this.#scheduleFlush(live);
        return;
      case 'reasoning_delta':
        live.reasoningBuffer += event.text;
        this.#scheduleFlush(live);
        return;
      case 'tool_started':
      case 'child_started': {
        this.#flushBuffers(live, turnId);
        const id = event.type === 'tool_started' ? event.toolCallId : event.childRunId;
        this.#enqueue(live, [{
          type: 'tool_call',
          payload: { tool_call_id: id, title: event.title, kind: event.kind, input: boundedValue(event.input), delegated: event.type === 'child_started' || undefined },
          turn_id: turnId,
        }]);
        return;
      }
      case 'tool_updated':
      case 'tool_completed':
        this.#flushBuffers(live, turnId);
        this.#enqueue(live, [{
          type: 'tool_update',
          payload: { tool_call_id: event.toolCallId, status: event.status ?? (event.type === 'tool_completed' ? 'completed' : 'in_progress'), output: boundedValue(event.output) },
          turn_id: turnId,
        }]);
        return;
      case 'child_finished':
        this.#flushBuffers(live, turnId);
        this.#enqueue(live, [{ type: 'tool_update', payload: { tool_call_id: event.childRunId, status: event.status, output: boundedValue(event.output) }, turn_id: turnId }]);
        return;
      case 'usage':
        this.#enqueue(live, [{
          type: 'usage',
          payload: { input_tokens: event.inputTokens, output_tokens: event.outputTokens, total_tokens: event.totalTokens, cached_read_tokens: event.cachedReadTokens, thought_tokens: event.thoughtTokens },
          turn_id: turnId,
        }]);
        return;
      case 'diagnostic': {
        const data = (event.data ?? {}) as Record<string, unknown>;
        const kind = String(data.sessionUpdate ?? data.session_update ?? '');
        if (event.method === 'session/update' && kind === 'current_mode_update') {
          const modeId = String(data.currentModeId ?? data.current_mode_id ?? '');
          if (modeId) this.#enqueue(live, [], { current_mode: modeId, reason: 'mode' });
          return;
        }
        log(`[agent-session ${live.cli} ${live.sessionId.slice(0, 8)}] diagnostic ${event.method}${kind ? ` (${kind})` : ''}`);
        return;
      }
      default:
        return;
    }
  }

  async #onPermission(live: LiveSession, permission: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    if (live.loading) return { outcome: 'cancelled' };
    const turnId = live.turn?.turnId;
    this.#flushBuffers(live, turnId);
    const requestId = randomUUID();
    const options = (permission.options ?? []).map((o) => ({ option_id: o.optionId, name: o.name, kind: o.kind }));
    this.#enqueue(live, [{
      type: 'permission_request',
      payload: {
        request_id: requestId,
        tool_call_id: permission.toolCall?.toolCallId ?? '',
        title: permission.toolCall?.title ?? '',
        kind: permission.toolCall?.kind ?? '',
        options,
        raw_input: boundedValue((permission.toolCall as any)?.rawInput ?? (permission.toolCall as any)?.raw_input),
      },
      turn_id: turnId,
    }], { status: 'awaiting_permission', reason: 'permission' });
    return new Promise<AcpPermissionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        live.pendingPermissions.delete(requestId);
        this.#enqueue(live, [{
          type: 'permission_decision',
          payload: { request_id: requestId, outcome: 'cancelled', option_id: null, decided_by: 'timeout' },
          turn_id: live.turn?.turnId,
        }], { status: 'busy', reason: 'permission_timeout' });
        resolve({ outcome: 'cancelled' });
      }, this.#options.permissionTimeoutMs);
      timer.unref?.();
      live.pendingPermissions.set(requestId, { resolve, timer });
    });
  }

  #resolvePermission(cli: string, sessionId: string, requestId: string, optionId: string | null): void {
    const live = this.#live.get(this.#key(cli, sessionId));
    if (!live) return;
    const pending = live.pendingPermissions.get(requestId);
    if (!pending) {
      log(`[agent-session ${cli} ${sessionId.slice(0, 8)}] permission ${requestId.slice(0, 8)} not pending (late or duplicate decision)`);
      return;
    }
    clearTimeout(pending.timer);
    live.pendingPermissions.delete(requestId);
    const allowed = !!optionId && (ALLOW_KINDS.size > 0);
    this.#enqueue(live, [{
      type: 'permission_decision',
      payload: { request_id: requestId, outcome: optionId ? 'selected' : 'cancelled', option_id: optionId, decided_by: 'user' },
      turn_id: live.turn?.turnId,
    }], { status: 'busy', reason: allowed ? 'permission_allowed' : 'permission_denied' });
    pending.resolve(optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' });
  }

  // ─── 버퍼/전송 ────────────────────────────────────────────────────────

  #scheduleFlush(live: LiveSession): void {
    if (live.flushTimer) return;
    live.flushTimer = setTimeout(() => {
      live.flushTimer = null;
      this.#flushBuffers(live, live.turn?.turnId);
    }, this.#options.flushIntervalMs);
  }

  #flushBuffers(live: LiveSession, turnId: string | undefined): void {
    if (live.flushTimer) {
      clearTimeout(live.flushTimer);
      live.flushTimer = null;
    }
    const events: AgentSessionEventInput[] = [];
    if (live.reasoningBuffer) {
      events.push({ type: 'reasoning', payload: { text: live.reasoningBuffer }, turn_id: turnId });
      live.reasoningBuffer = '';
    }
    if (live.textBuffer) {
      events.push({ type: 'text', payload: { text: live.textBuffer }, turn_id: turnId });
      live.textBuffer = '';
    }
    if (events.length) this.#enqueue(live, events);
  }

  /** 세션당 FIFO — 서버는 저장하지 않지만 소유자 UI 는 seq 순서로 병합한다. */
  #enqueue(live: LiveSession, events: AgentSessionEventInput[], state?: AgentSessionStatePatch): void {
    const now = new Date().toISOString();
    const stamped = events.map((e) => {
      live.seq += 1;
      return { ...e, payload: boundedPayload(e.payload), seq: live.seq, id: `${live.sessionId}:live:${live.nonce}:${live.seq}`, created_at: now };
    });
    const ref = this.#ref(live.cli, live.sessionId);
    live.postChain = live.postChain
      .then(() => (stamped.length || state
        ? postAgentSessionEvents(this.#config, ref, stamped, state ?? null)
        : Promise.resolve({ ok: true, status: 204 })))
      .then(() => undefined, () => undefined);
  }

  // ─── 수명주기 ─────────────────────────────────────────────────────────

  #touch(live: LiveSession): void {
    this.#clearIdle(live);
    if (live.turn) return;
    const ms = this.#options.idleMinutes * 60_000;
    if (ms <= 0) return;
    live.idleTimer = setTimeout(() => {
      if (live.turn || live.pendingPermissions.size > 0) {
        this.#touch(live);
        return;
      }
      void this.#closeLive(live.cli, live.sessionId, 'idle', 'idle');
    }, ms);
    live.idleTimer.unref?.();
  }

  #clearIdle(live: LiveSession): void {
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = null;
    }
  }

  #onProcessExit(key: string, code: number | null, signal: NodeJS.Signals | null): void {
    const live = this.#live.get(key);
    if (!live) return;
    live.exited = true;
    for (const [id, pending] of live.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ outcome: 'cancelled' });
      live.pendingPermissions.delete(id);
    }
    this.#clearIdle(live);
    if (live.closing) return;
    this.#live.delete(key);
    const detail = `Agent process exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).`;
    log(`[agent-session ${live.cli} ${live.sessionId.slice(0, 8)}] ${detail}`);
    this.#flushBuffers(live, live.turn?.turnId);
    this.#enqueue(live, [{ type: 'system', payload: { text: `${detail} The next prompt reopens the session.` } }],
      live.turn ? undefined : { status: 'idle', reason: 'process_exit' });
  }

  async #closeLive(cli: string, sessionId: string, finalStatus: 'closed' | 'idle', reason: string = finalStatus): Promise<void> {
    const key = this.#key(cli, sessionId);
    const live = this.#live.get(key);
    if (!live) return;
    live.closing = true;
    this.#clearIdle(live);
    for (const [id, pending] of live.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ outcome: 'cancelled' });
      live.pendingPermissions.delete(id);
    }
    if (live.turn) await live.client.cancel(live.sessionId).catch(() => undefined);
    this.#flushBuffers(live, live.turn?.turnId);
    if (!live.exited) await live.client.closeSession(live.sessionId).catch(() => undefined);
    this.#live.delete(key);
    const child = live.client.process;
    const pid = child?.pid;
    live.client.close();
    if (pid && child) await terminateDetachedProcessTree(pid, 250, { child }).catch(() => undefined);
    const text = finalStatus === 'closed'
      ? 'Agent process stopped.'
      : reason === 'idle'
        ? `Idle for ${this.#options.idleMinutes} min — agent process stopped. The next prompt reopens the session.`
        : reason === 'credential_changed'
          ? 'CLI settings changed — reopening the session with the new credential.'
          : `Agent process stopped (${reason}). The next prompt reopens the session.`;
    this.#enqueue(live, [{ type: 'system', payload: { text } }], { status: finalStatus, reason });
    await live.postChain;
  }
}
