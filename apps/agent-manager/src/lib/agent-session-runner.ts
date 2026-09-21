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

import { access, constants as fsConstants, lstat, mkdir, readdir, rm, stat, symlink } from 'node:fs/promises';
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
  type AgentSessionAuthPatch,
  type AgentSessionConfigOptionPatch,
  type AgentSessionEventInput,
  type AgentSessionRef,
  type AgentSessionStatePatch,
  type AwbConfig,
} from './rest.js';
import { createRuntimeCliAdapter } from './runtime/runtime-registry.js';
import { AcpClient } from './runtime/acp/acp-client.js';
import type {
  AcpAuthStatus,
  AcpElicitationOutcome,
  AcpElicitationRequest,
  AcpMcpServer,
  AcpPermissionOutcome,
  AcpPermissionRequest,
} from './runtime/acp/acp-types.js';
import { resolveHermesAcpCommand } from './runtime/hermes/hermes-command.js';
import type { RuntimeEvent } from './runtime/runtime-events.js';

/** 서버 payload (apps/server/src/common/types/stream-events.ts AgentSessionRequestPayload). */
export interface AgentSessionRequest {
  manager_id: string;
  workspace_id?: string;
  cli: string;
  op: 'list' | 'history' | 'open' | 'prompt' | 'permission' | 'elicitation' | 'cancel' | 'set_mode' | 'set_config_option' | 'close';
  request_id?: string;
  session_id?: string | null;
  cwd?: string;
  title?: string;
  turn_id?: string;
  text?: string;
  permission_request_id?: string;
  option_id?: string | null;
  mode_id?: string;
  /** set_config_option */
  config_id?: string;
  config_value?: string | boolean;
  /** open/prompt — 세션이 열린 직후 다시 걸 설정(`{ [configId]: value }`, `__mode` 는 레거시 set_mode). */
  config_defaults?: Record<string, string | boolean>;
  /** elicitation — 에이전트 질문/폼에 대한 답 */
  elicitation_id?: string;
  elicitation_action?: 'accept' | 'decline' | 'cancel';
  elicitation_content?: Record<string, unknown> | null;
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
  /** stdout 한 줄 상한 override — 테스트가 64MiB 를 쓰지 않고 초과 경로를 돌기 위한 주입점. */
  maxLineBytes?: number;
}

export interface SessionCredential {
  credential_id: string;
  provider: string;
  fields: Record<string, string>;
}

/** CLI → 호환 credential provider 접두어(서버 SESSION_CLI_CREDENTIAL_PREFIX 와 같은 규약). */
/** `config_defaults` 의 예약 키 — 레거시 `session/set_mode`(config option 이 아닌 modes). 서버와 같은 값. */
const MODE_DEFAULT_KEY = '__mode';

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
  /** 자격증명의 출처 — 워크스페이스 Credential 인지, 그 장비 운영자의 CLI 로그인인지. */
  source: 'credential' | 'operator';
  env: Record<string, string>;
  stripEnvKeys: string[];
  cliHome: string | null;
}

/** 서버로 이미 보낸(seq/id 가 찍힌) 이벤트 행. */
type StampedEvent = AgentSessionEventInput & { seq: number; id: string; created_at: string };

interface PendingPermission {
  resolve: (outcome: AcpPermissionOutcome) => void;
  timer: NodeJS.Timeout;
  /** 중계했던 permission_request 행 — history RPC 가 미결 요청을 다시 실어 보낸다(같은 id 라 UI 가 중복을 거른다). */
  event: StampedEvent;
}

/** 어댑터의 `elicitation/create`(질문/폼) — 사용자가 답할 때까지 JSON-RPC 요청을 열어 둔다. */
interface PendingElicitation {
  resolve: (outcome: AcpElicitationOutcome) => void;
  timer: NodeJS.Timeout;
  event: StampedEvent;
}

type CommandPatch = { name: string; description: string; input_hint?: string };

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
  pendingElicitations: Map<string, PendingElicitation>;
  /** 세션 id 를 알기 전(session/new 응답 전)에 어댑터가 보낸 행 — 열리는 즉시 순서대로 흘려보낸다. */
  preSessionEvents: AgentSessionEventInput[];
  /** 어댑터가 준 세션 설정(모델·reasoning …)·slash command·모드 — history RPC 의 `live` 로 서버가 다시 받는다. */
  configOptions: AgentSessionConfigOptionPatch[];
  availableCommands: CommandPatch[];
  currentMode: string | null;
  availableModes: Array<{ id: string; name: string; description?: string }>;
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
  /** 자격증명의 출처 — 매니저가 아는 사실. 어댑터가 알려 주는 신원과 합쳐 `auth` 로 보고한다. */
  authSource: 'credential' | 'operator';
  /** 어댑터가 `_auth/status_update` 로 알려 준 신원. 안 알려 주면 null("모른다"). */
  authStatus: AgentSessionAuthPatch | null;
  closing: boolean;
  exited: boolean;
}

const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_PERMISSION_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 6 * 60 * 60_000;
const DEFAULT_FLUSH_INTERVAL_MS = 150;
const MAX_TOOL_TEXT_CHARS = 16_000;
/**
 * 세션 어댑터의 stdout 한 줄 상한. 기본값(4MiB)은 세션에는 작다 — 큰 파일 읽기나 긴 명령
 * 출력이 한 줄짜리 알림으로 오면 그 줄 하나가 프로세스를 통째로 죽였다("ACP stdout line
 * exceeds the configured byte limit" → SIGTERM). 넉넉히 올리되 무한 버퍼는 만들지 않고,
 * 넘치면 그 줄만 버리고 스트림은 이어 간다(skipOversizedLines).
 */
const SESSION_MAX_LINE_BYTES = 64 * 1024 * 1024;
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

/** ACP SessionConfigOption[] → 서버 패치 모양. 그룹(`{group, name, options}`)은 평탄화하고 group 라벨을 남긴다. */
export function parseConfigOptions(raw: unknown): AgentSessionConfigOptionPatch[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentSessionConfigOptionPatch[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    // 실제 어댑터(codex-acp 1.12, claude-agent-acp 0.79)는 SDK 1.x 스키마의 `id` 로 보낸다. v2 초안은 `configId`.
    const configId = typeof o.configId === 'string' ? o.configId : typeof o.id === 'string' ? o.id : typeof o.config_id === 'string' ? o.config_id : '';
    if (!configId) continue;
    const type = typeof o.type === 'string' ? o.type : (typeof o.currentValue === 'boolean' ? 'boolean' : 'select');
    const options: AgentSessionConfigOptionPatch['options'] = [];
    const pushOption = (v: unknown, group?: string) => {
      if (!v || typeof v !== 'object') return;
      const opt = v as Record<string, unknown>;
      const value = typeof opt.value === 'string' ? opt.value : typeof opt.id === 'string' ? opt.id : '';
      if (!value) return;
      options.push({
        value,
        name: typeof opt.name === 'string' && opt.name ? opt.name : value,
        ...(typeof opt.description === 'string' && opt.description ? { description: opt.description } : {}),
        ...(group ? { group } : {}),
      });
    };
    if (Array.isArray(o.options)) {
      for (const v of o.options) {
        const g = v as Record<string, unknown> | null;
        if (g && typeof g === 'object' && Array.isArray(g.options)) {
          const label = typeof g.name === 'string' ? g.name : typeof g.group === 'string' ? g.group : '';
          for (const inner of g.options) pushOption(inner, label || undefined);
        } else {
          pushOption(v);
        }
      }
    }
    const current = o.currentValue ?? o.current_value;
    out.push({
      config_id: configId,
      name: typeof o.name === 'string' && o.name ? o.name : configId,
      ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
      category: typeof o.category === 'string' && o.category ? o.category : 'unknown',
      type,
      current_value: typeof current === 'boolean' ? current : typeof current === 'string' ? current : null,
      options,
    });
  }
  return out;
}

/** ACP AvailableCommand[] → `{ name, description, input_hint? }`. */
export function parseCommands(raw: unknown): CommandPatch[] {
  if (!Array.isArray(raw)) return [];
  const out: CommandPatch[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as Record<string, unknown>;
    const name = typeof c.name === 'string' ? c.name.trim().replace(/^\//, '') : '';
    if (!name) continue;
    const input = c.input && typeof c.input === 'object' ? (c.input as Record<string, unknown>) : null;
    const hint = input && typeof input.hint === 'string' ? input.hint : '';
    out.push({ name, description: typeof c.description === 'string' ? c.description : '', ...(hint ? { input_hint: hint } : {}) });
  }
  return out;
}

/** ACP Plan / PlanUpdate(items) entries → `{ content, priority, status }[]`. 항목이 없으면 null. */
export function parsePlanEntries(raw: unknown): Array<{ content: string; priority: string; status: string }> | null {
  if (!Array.isArray(raw)) return null;
  const entries = raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      content: typeof e.content === 'string' ? e.content.slice(0, 2_000) : '',
      priority: typeof e.priority === 'string' ? e.priority : 'medium',
      status: typeof e.status === 'string' ? e.status : 'pending',
    }))
    .filter((e) => e.content);
  return entries;
}

/** `mcp_startup.<server>` (codex-acp 의 MCP 연결 알림) 이면 서버 이름, 아니면 null. */
export function mcpStartupServerOf(toolCallId: string): string | null {
  const m = /^mcp_startup\.(.+)$/.exec(String(toolCallId || ''));
  return m ? m[1] : null;
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
      // `@agentclientprotocol/codex-acp` 가 유지되는 어댑터다 — 설치된 codex CLI 와 같은 세대의 코어를
      // 번들해 최신 모델을 쓴다. zed-industries 것은 2026-07 에 archive 됐고 옛 코어라 새 모델을
      // "requires a newer version of Codex" 로 거부한다.
      const found = await findOnPath('codex-acp');
      return found ? { command: found, args: [] } : { command: 'npx', args: ['--yes', '@agentclientprotocol/codex-acp'] };
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
    & Pick<AgentSessionRunnerOptions, 'commandResolver' | 'baseEnv' | 'clientVersion' | 'mcpServers' | 'getManagerId' | 'credentialFetcher' | 'maxLineBytes'>;
  readonly #store: AgentSessionStore;
  readonly #live = new Map<string, LiveSession>();
  readonly #opening = new Map<string, Promise<LiveSession>>();
  /** 프로세스가 먼저 죽어 #live 에서 빠진 세션 — stopAll 이 마지막 상태 전송까지 기다린다. */
  readonly #exited: LiveSession[] = [];

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
      maxLineBytes: options.maxLineBytes,
    };
  }

  get store(): AgentSessionStore {
    return this.#store;
  }

  _snapshot(): Array<{ cli: string; session_id: string; busy: boolean; pid: number | null }> {
    return Array.from(this.#live.values()).map((live) => ({
      cli: live.cli,
      session_id: live.sessionId,
      busy: live.turn !== null || live.pendingPermissions.size > 0 || live.pendingElicitations.size > 0,
      pid: live.client.process.pid ?? null,
    }));
  }

  countInFlight(): number {
    return this._snapshot().filter((s) => s.busy).length;
  }

  /** 하트비트용 — 살아 있는 세션 전체와 서버 contract 의 status. 닫히는 중/죽은 것은 뺀다. */
  liveStates(): Array<{ cli: string; session_id: string; status: string }> {
    return Array.from(this.#live.values())
      .filter((live) => !live.exited && !live.closing)
      .map((live) => ({ cli: live.cli, session_id: live.sessionId, status: this.#statusOf(live) }));
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
        case 'elicitation':
          this.#resolveElicitation(cli, sessionId, request.elicitation_id || '', request.elicitation_action || 'cancel', request.elicitation_content ?? null);
          return;
        case 'set_config_option': {
          if (!sessionId || !request.config_id || request.config_value === undefined) return;
          // 살아 있지 않으면 먼저 연다 — 목록에서 들어온 기존 세션도 프롬프트 전에 모델을 바꿀 수 있다.
          const live = await this.#ensureLive(cli, sessionId, request.cwd || '', request.title || '', request);
          await this.#setConfigOption(live, request.config_id, request.config_value);
          return;
        }
        case 'cancel': {
          const live = this.#live.get(this.#key(cli, sessionId));
          if (live) await live.client.cancel(live.sessionId).catch(() => undefined);
          return;
        }
        case 'set_mode': {
          const modeId = request.mode_id || '';
          if (!sessionId || !modeId) return;
          // 살아 있지 않으면 먼저 연다(prompt 와 같다) — 첫 프롬프트 전에 approval 모드를 고를 수 있어야 한다.
          const live = await this.#ensureLive(cli, sessionId, request.cwd || '', request.title || '', request);
          await live.client.request('session/set_mode', { sessionId: live.sessionId, modeId }, { timeoutMs: this.#options.requestTimeoutMs });
          live.currentMode = modeId;
          const modeName = live.availableModes.find((m) => m.id === modeId)?.name || modeId;
          this.#enqueue(live, [{ type: 'system', payload: { text: `Mode set to ${modeName}.` } }], { current_mode: modeId, reason: 'mode' });
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
          // 아직 결정되지 않은 permission 요청은 CLI 홈 파일에 없다(SSE 로만 흘렀다). 화면을
          // 다시 열거나 새로고침한 사용자가 "Needs your approval" 만 보고 카드는 못 보는 일이
          // 없도록 기록 끝에 다시 실어 보낸다 — id 가 같아 라이브로 이미 받은 행과 겹치지 않는다.
          const pending = live
            ? [...Array.from(live.pendingPermissions.values()), ...Array.from(live.pendingElicitations.values())].map((p) => p.event)
            : [];
          const events = pending.length
            ? [...history.events, ...pending.map((e, i) => ({ ...e, seq: history.events.length + i + 1 }))]
            : history.events;
          await postAgentSessionRpcResponse(this.#config, managerId, requestId, {
            ok: true,
            result: {
              session: history.session ?? (live ? this.#summaryOf(live) : null),
              events,
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
    // systemd 는 SIGTERM 을 cgroup 전체에 보내므로 세션 프로세스가 매니저보다 먼저 죽는 일이
    // 흔하다. 그 세션은 #onProcessExit 로 이미 #live 에서 빠졌지만 마지막 상태(idle) 전송이
    // 아직 날아가는 중일 수 있다 — 매니저가 그걸 끊고 종료하면 서버에는 busy/awaiting_permission
    // 유령이 남는다. 잠깐(최대 3s) 기다려 준다.
    const drains = this.#exited.splice(0).map((l) => l.postChain);
    if (drains.length) {
      await Promise.race([Promise.all(drains), new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref?.())]);
    }
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
    const env = this.#buildEnv(cli, requestedSessionId || 'new', auth);
    const client = await AcpClient.spawn({
      command,
      args,
      cwd,
      env,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      onEvent: (event) => { if (live) this.#onEvent(live, event); },
      onPermissionRequest: (permission) => (live ? this.#onPermission(live, permission) : Promise.resolve({ outcome: 'cancelled' as const })),
      onElicitation: (elicitation) => (live ? this.#onElicitation(live, elicitation) : Promise.resolve({ action: 'cancel' as const })),
      onAuthStatus: (status) => { if (live) this.#onAuthStatus(live, status); },
      // 한 줄이 상한을 넘으면 그 메시지만 버리고 세션은 살려 둔다 — 잃는 것은 그 출력 하나다.
      maxLineBytes: this.#options.maxLineBytes ?? SESSION_MAX_LINE_BYTES,
      maxMessageBytes: this.#options.maxLineBytes ?? SESSION_MAX_LINE_BYTES,
      skipOversizedLines: true,
      onOversizedLine: (bytes) => {
        const mib = Math.round(bytes / (1024 * 1024));
        log(`${tag} dropped an oversized ACP message (${mib} MiB) — the session continues`);
        if (live) {
          this.#enqueue(live, [{
            type: 'system',
            payload: { text: `The agent sent a ${mib} MiB message, larger than this session can relay. That one message was dropped; the session is still running.` },
            turn_id: live.turn?.turnId,
          }]);
        }
      },
      onStderr: (line) => log(`${tag} stderr: ${redactSecrets(line)}`),
      spawnOptions: { detached: process.platform !== 'win32' },
    });

    try {
      const initialized = await client.initialize({
        clientInfo: { name: 'awb-agent-session', version: this.#options.clientVersion || '1' },
        // elicitation(form/url): 에이전트의 질문·폼(claude AskUserQuestion 등)을 카드로 받는다.
        // session.configOptions.boolean / plan: 어댑터가 boolean 설정과 plan 업데이트를 보내도 된다는 뜻.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {}, url: {} },
          session: { configOptions: { boolean: {} } },
          plan: {},
        },
      });
      const caps = (initialized?.agentCapabilities ?? {}) as Record<string, unknown>;
      const loadSupported = caps.loadSession === true;
      const authMethods = Array.isArray(initialized?.authMethods) ? initialized.authMethods : [];
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
        pendingElicitations: new Map(),
        preSessionEvents: [],
        configOptions: [],
        availableCommands: [],
        currentMode: null,
        availableModes: [],
        turn: null,
        textBuffer: '',
        reasoningBuffer: '',
        flushTimer: null,
        idleTimer: null,
        postChain: Promise.resolve(),
        seq: 0,
        nonce: randomUUID().slice(0, 8),
        credentialId: request.credential_id || '',
        authSource: auth.source,
        authStatus: null,
        closing: false,
        exited: false,
      };

      let modes: unknown;
      let configOptions: unknown;
      let resumed = false;
      if (requestedSessionId) {
        if (!loadSupported) {
          throw Object.assign(new Error(`The ${cli} ACP adapter cannot resume existing sessions (no loadSession capability).`), { code: 'resume_unsupported' });
        }
        live.loading = true;
        try {
          const loaded = await this.#withAuthRetry(client, cli, authMethods, env, () => client.loadSession({ sessionId: requestedSessionId, cwd, mcpServers }));
          modes = (loaded as any)?.modes;
          configOptions = (loaded as any)?.configOptions;
          resumed = true;
        } catch (err: any) {
          if (err?.code === 'auth_required') throw err;
          // 어댑터는 `Internal error` 한 줄만 내고 진짜 이유는 `data.details` 에 담는다
          // (예: `no rollout found for thread id …`). 그것까지 사용자에게 보여 준다.
          const details = (err?.data as { details?: unknown } | undefined)?.details;
          const detail = redactSecrets(String(details || err?.message || err));
          throw Object.assign(
            new Error(`${cli} could not resume this session: ${detail}. Fix that and reload, or start a new session in the same folder.`),
            { code: 'resume_failed', cause: err },
          );
        } finally {
          live.loading = false;
        }
      } else {
        const created = await this.#withAuthRetry(client, cli, authMethods, env, () => client.newSession({ cwd, mcpServers }));
        live.sessionId = created.sessionId;
        modes = created.modes;
        configOptions = created.configOptions;
        await this.#store.recordAwbSession({ cli, session_id: live.sessionId, cwd, title }).catch(() => undefined);
      }
      if (!live.sessionId) throw new Error('ACP adapter returned no session id.');
      const key = this.#key(cli, live.sessionId);
      this.#live.set(key, live);
      client.process.once('exit', (code, signal) => this.#onProcessExit(key, code, signal));
      if (live.preSessionEvents.length) {
        const buffered = live.preSessionEvents.splice(0);
        this.#enqueue(live, buffered);
      }
      const modeInfo = this.#parseModes(modes);
      live.currentMode = modeInfo.current;
      live.availableModes = modeInfo.available;
      live.configOptions = parseConfigOptions(configOptions);
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
        config_options: live.configOptions,
        available_commands: live.availableCommands,
        // 어댑터가 initialize 직후 신원을 밀어 주면 여기 이미 차 있다 — 없으면 나중 push 가 채운다.
        ...(live.authStatus ? { auth: live.authStatus } : {}),
        resume_supported: loadSupported,
        last_error: null,
        reason: resumed ? 'resumed' : 'opened',
      });
      // 기억된 설정(approval 모드·모델 …)을 다시 건다 — 어댑터는 프로세스마다 기본값으로 시작하므로
      // 이걸 하지 않으면 유휴 회수·재접속 때마다 사용자의 선택이 사라진다. 실패해도 세션은 연다.
      await this.#applyConfigDefaults(live, request.config_defaults);
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
    // 세션 홈의 `config.toml` 은 awb MCP 서버를 `bearer_token_env_var = "AWB_API_KEY"` 로 적고
    // `required = true` 로 표시한다(cli-adapters/codex.ts). 이 값이 없으면 codex 가 세션 초기화를
    // 통째로 중단한다 — 재개는 **그 대화에 기록된** MCP 설정을 다시 띄우므로 지금 config 를 고쳐도
    // 옛 대화는 계속 막힌다. 매니저 키는 이미 ACP mcpServers 의 Authorization 헤더로 같은 세션에
    // 넘어가므로 새로 노출되는 비밀은 없다(managed agent 경로도 같은 변수를 쓴다).
    env.AWB_API_KEY = this.#config.apiKey;
    env.AWB_MANAGER_ID = this.#options.getManagerId();
    env.AWB_SESSION_CLI = cli;
    env.AWB_SESSION_ID = sessionId;
    // codex-acp: 매니저 프로세스에는 브라우저가 없다 — ChatGPT 브라우저 로그인 auth method 를 숨겨
    // 어댑터가 장비의 codex 로그인(auth.json)이나 API 키만 쓰게 한다.
    if (cli === 'codex' && env.NO_BROWSER === undefined) env.NO_BROWSER = '1';
    return env;
  }

  /**
   * `session/new` / `session/load` 가 "authentication required"(-32000) 로 거부되면 ACP `authenticate`
   * 를 한 번 시도한다. 환경에 API 키가 있으면 api-key 계열 method, 없으면 남은 method 를 이름으로
   * 안내하는 오류를 낸다 — 장비에서 `<cli> login` 하거나 CLI 설정에 credential 을 묶으라는 뜻이다.
   */
  async #withAuthRetry<T>(client: AcpClient, cli: string, authMethods: unknown[], env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err: any) {
      const rpcCode = err?.rpcCode ?? err?.code;
      const message = String(err?.message ?? '');
      const authRequired = rpcCode === -32000 || /auth(entication)? required|not (logged|signed) in|unauthenticated/i.test(message);
      if (!authRequired) throw err;
      const methods = authMethods
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .map((m) => ({ id: String(m.id ?? ''), name: String(m.name ?? m.id ?? ''), type: String(m.type ?? '') }))
        .filter((m) => m.id);
      const hasApiKey = !!(env.CODEX_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
      const apiKeyMethod = methods.find((m) => /api[-_]?key|token/i.test(m.id) || /api[-_]?key|token/i.test(m.name));
      if (hasApiKey && apiKeyMethod) {
        log(`[agent-session ${cli}] authentication required — trying ACP auth method ${apiKeyMethod.id}`);
        await client.authenticate(apiKeyMethod.id, { timeoutMs: this.#options.requestTimeoutMs });
        return await run();
      }
      const listed = methods.length ? ` Available methods: ${methods.map((m) => m.name || m.id).join(', ')}.` : '';
      throw Object.assign(
        new Error(`Authentication required for ${cli} on this Runtime Host — run \`${cli} login\` there, or bind a credential in CLI settings.${listed}`),
        { code: 'auth_required' },
      );
    }
  }

  /**
   * 어댑터가 알려 준 로그인 신원(`_auth/status_update`). 연결 단위 알림이고 바뀔 때만 오므로,
   * 받은 그대로 상태에 얹어 화면이 "이 세션은 누구로 도는가" 를 보여 줄 수 있게 한다.
   * 출처(`source`)는 어댑터가 모르는 사실이라 매니저가 채운다.
   */
  #onAuthStatus(live: LiveSession, status: AcpAuthStatus): void {
    const account = status.account && typeof status.account === 'object' ? status.account : undefined;
    const next: AgentSessionAuthPatch = {
      source: live.authSource,
      kind: typeof status.kind === 'string' ? status.kind : 'unknown',
      label: typeof status.label === 'string' ? status.label : '',
      ...(typeof status.detail === 'string' && status.detail ? { detail: status.detail } : {}),
      ...(account ? {
        account: {
          ...(typeof account.email === 'string' ? { email: account.email } : {}),
          ...(typeof account.organization === 'string' ? { organization: account.organization } : {}),
          ...(typeof account.plan === 'string' ? { plan: account.plan } : {}),
        },
      } : {}),
    };
    if (JSON.stringify(live.authStatus) === JSON.stringify(next)) return;
    live.authStatus = next;
    this.#enqueue(live, [], { auth: next, reason: 'auth' });
  }

  /**
   * 서버가 기억해 둔 설정을 세션에 다시 건다. 어댑터가 이미 그 값이면 건너뛴다(불필요한 왕복·system 행 방지).
   * 목록에 없는 키는 조용히 무시한다 — 어댑터를 바꾸거나 업그레이드하면 없어진 옵션이 있을 수 있다.
   */
  async #applyConfigDefaults(live: LiveSession, defaults: Record<string, string | boolean> | undefined): Promise<void> {
    if (!defaults) return;
    for (const [key, value] of Object.entries(defaults)) {
      try {
        if (key === MODE_DEFAULT_KEY) {
          if (typeof value !== 'string' || !value || live.currentMode === value) continue;
          if (!live.availableModes.some((m) => m.id === value)) continue;
          await live.client.request('session/set_mode', { sessionId: live.sessionId, modeId: value }, { timeoutMs: this.#options.requestTimeoutMs });
          live.currentMode = value;
          continue;
        }
        const option = live.configOptions.find((o) => o.config_id === key);
        if (!option || option.current_value === value) continue;
        if (option.type === 'select' && (typeof value !== 'string' || (option.options.length > 0 && !option.options.some((o) => o.value === value)))) continue;
        if (option.type === 'boolean' && typeof value !== 'boolean') continue;
        await this.#setConfigOption(live, key, value);
      } catch (err: any) {
        log(`[agent-session ${live.cli} ${live.sessionId.slice(0, 8)}] could not restore ${key}: ${redactSecrets(err?.message ?? String(err))}`);
      }
    }
  }

  /** ACP `session/set_config_option` — 응답의 전체 목록으로 상태를 갱신하고 system 행으로 남긴다. */
  async #setConfigOption(live: LiveSession, configId: string, value: string | boolean): Promise<void> {
    const before = live.configOptions.find((o) => o.config_id === configId);
    const response = await live.client.setConfigOption(
      typeof value === 'boolean'
        ? { sessionId: live.sessionId, configId, type: 'boolean', value }
        : { sessionId: live.sessionId, configId, type: 'id', value },
      { timeoutMs: this.#options.requestTimeoutMs },
    );
    if (Array.isArray(response?.configOptions)) live.configOptions = parseConfigOptions(response.configOptions);
    else if (before) {
      before.current_value = value;
    }
    const after = live.configOptions.find((o) => o.config_id === configId);
    // codex-acp 는 approval 모드를 config option(category 'mode') 으로도 노출한다 — legacy current_mode 와 맞춘다.
    if (after?.category === 'mode' && typeof after.current_value === 'string') live.currentMode = after.current_value;
    const label = after?.name || before?.name || configId;
    const chosen = typeof value === 'boolean'
      ? (value ? 'on' : 'off')
      : (after?.options.find((o) => o.value === value)?.name || String(value));
    this.#enqueue(live, [{ type: 'system', payload: { text: `${label} set to ${chosen}.` } }], {
      config_options: live.configOptions,
      ...(after?.category === 'mode' ? { current_mode: live.currentMode } : {}),
      reason: 'config_option',
    });
  }

  /**
   * CLI 설정의 credential 을 세션 프로세스에 적용한다. 운영자 홈의 로그인 파일은 절대
   * 건드리지 않는다: credential 이 있으면 `<session-homes>/<cli>/<credential_id>` 를
   * 세션 전용 cli-home 으로 만들고(어댑터 prepareCliHome 이 자격증명 파일/env 를
   * 만든다), 그 안의 기록 디렉터리(projects / sessions)만 운영자 홈으로 심볼릭 링크해
   * 기존 세션이 그대로 보이고 이어지게 한다.
   */
  async #prepareAuth(cli: string, cwd: string, request: AgentSessionRequest): Promise<SessionAuth> {
    const none: SessionAuth = { label: 'operator-login', source: 'operator', env: {}, stripEnvKeys: [], cliHome: null };
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
    const prep = await adapter.prepareCliHome(cliHome, credential, { url: this.#config.url, apiKey: this.#config.apiKey });
    const env: Record<string, string> = { ...(prep.extraEnv ?? {}) };
    const configDirEnv = adapter.configDirEnv();
    if (configDirEnv) env[configDirEnv] = cliHome;
    // 운영자 셸의 API 키(ANTHROPIC_API_KEY / OPENAI_API_KEY …)가 credential 을 덮지 않게 걷어낸다.
    const stripEnvKeys = adapter.authEnvKeys().filter((key) => !(key in env));
    await adapter.ensureWorkspaceTrust(cliHome, cwd).catch((err: any) => log(`[agent-session ${cli}] trust seed failed: ${err?.message ?? err}`));
    return { label: `credential:${credential.provider}`, source: 'credential', env, stripEnvKeys, cliHome };
  }

  /**
   * 링크가 실제로 운영자의 기록을 **보여 주는가**. 존재 여부만으로는 알 수 없다 — Windows junction 은
   * 끊어져도 경로가 그대로 남아 빈 디렉터리처럼 보인다(실측: ralf 의 credential 홈에서 `sessions` 는
   * 있는데 그 아래가 통째로 비어 codex 가 `no rollout found for thread id` 로 재개를 거부했다).
   * 대상의 첫 항목이 링크를 통해 보이는지로 판정한다. 대상이 비어 있으면 판정할 수 없으므로 건드리지 않는다.
   */
  async #sessionStoreVisible(linkPath: string, target: string): Promise<boolean> {
    let entries: string[];
    try {
      entries = await readdir(target);
    } catch {
      return true;
    }
    if (!entries.length) return true;
    try {
      await stat(join(linkPath, entries[0]));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 세션 전용 cli-home 의 기록 디렉터리를 운영자 홈으로 링크한다(멱등).
   * 이미 있으면 **내용이 보이는지 확인하고**, 끊어져 있으면 다시 만든다 — 예전에는 경로가 존재하기만
   * 하면 성공으로 보고 넘어가서, 한 번 끊어진 링크가 영영 고쳐지지 않았다(그 credential 로 여는 모든
   * 세션의 재개가 실패했다). 링크가 아니라 진짜 디렉터리가 들어 있으면 지우지 않는다 — 운영자의 자료일 수 있다.
   */
  async #linkSessionStore(cli: string, cliHome: string): Promise<void> {
    const subdir = SESSION_STORE_SUBDIR[cli];
    if (!subdir) return;
    const operatorHome = cli === 'claude' ? resolveClaudeHome(this.#options.baseEnv ?? process.env) : resolveCodexHome(this.#options.baseEnv ?? process.env);
    const target = join(operatorHome, subdir);
    const linkPath = join(cliHome, subdir);
    await mkdir(target, { recursive: true });
    let existing: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      existing = await lstat(linkPath);
    } catch {
      /* 없음 → 만든다 */
    }
    if (existing) {
      if (await this.#sessionStoreVisible(linkPath, target)) return;
      // 지워도 되는 경우만 지운다: 링크이거나(끊어진 junction 포함), 내용이 없는 디렉터리.
      // 내용이 있는 진짜 디렉터리는 운영자의 자료일 수 있으므로 손대지 않는다.
      const empty = (await readdir(linkPath).catch(() => [] as string[])).length === 0;
      if (!existing.isSymbolicLink() && !empty) {
        log(`[agent-session ${cli}] ${linkPath} is a real directory that does not mirror ${target} — leaving it alone (sessions started elsewhere will not resume here)`);
        return;
      }
      log(`[agent-session ${cli}] session store link was broken (${linkPath} → ${target}); recreating`);
      await rm(linkPath, { recursive: true, force: true });
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
    if (live.pendingElicitations.size > 0) return 'awaiting_input';
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
      auth: live.authStatus,
      current_mode: live.currentMode,
      available_modes: live.availableModes,
      config_options: live.configOptions,
      available_commands: live.availableCommands,
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
        const startupServer = event.type === 'tool_started' ? mcpStartupServerOf(event.toolCallId) : null;
        if (startupServer !== null) {
          // codex-acp 는 MCP 서버 연결을 `mcp_startup.<server>` 라는 한 번짜리 tool_call 로 알린다
          // (update 가 따라오지 않는다). 에이전트가 한 일이 아니라 세션이 열리는 과정이므로 카드로
          // 띄우지 않는다 — 성공은 조용히 버리고, 실패만 "툴을 못 쓴다" 는 사실이라 system 으로 남긴다.
          if (event.type === 'tool_started' && event.status === 'failed') {
            this.#flushBuffers(live, turnId);
            this.#enqueue(live, [{
              type: 'system',
              payload: { text: `MCP server "${startupServer}" did not connect — its tools are unavailable in this session.` },
              turn_id: turnId,
            }]);
          }
          return;
        }
        this.#flushBuffers(live, turnId);
        const id = event.type === 'tool_started' ? event.toolCallId : event.childRunId;
        // 초기 status 를 그대로 싣는다 — codex-acp 의 `mcp_startup.<server>` 처럼 update 없이 한 번에
        // failed/completed 로 오는 호출이 있어, 없으면 화면이 영원히 "running" 으로 남는다.
        const status = event.type === 'tool_started' && event.status ? event.status : undefined;
        this.#enqueue(live, [{
          type: 'tool_call',
          payload: { tool_call_id: id, title: event.title, kind: event.kind, input: boundedValue(event.input), delegated: event.type === 'child_started' || undefined, ...(status ? { status } : {}) },
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
        if (event.method === 'session/update') {
          switch (kind) {
            case 'current_mode_update': {
              const modeId = String(data.currentModeId ?? data.current_mode_id ?? '');
              if (modeId) {
                live.currentMode = modeId;
                this.#enqueue(live, [], { current_mode: modeId, reason: 'mode' });
              }
              return;
            }
            case 'config_option_update':
              live.configOptions = parseConfigOptions(data.configOptions ?? data.config_options);
              this.#enqueue(live, [], { config_options: live.configOptions, reason: 'config_option' });
              return;
            case 'available_commands_update':
              live.availableCommands = parseCommands(data.availableCommands ?? data.available_commands);
              this.#enqueue(live, [], { available_commands: live.availableCommands, reason: 'commands' });
              return;
            case 'plan':
            case 'plan_update': {
              const entries = parsePlanEntries(kind === 'plan' ? data.entries : (data.plan as any)?.entries ?? data.entries);
              if (entries) {
                this.#flushBuffers(live, turnId);
                this.#enqueue(live, [{ type: 'plan', payload: { entries }, turn_id: turnId }]);
              }
              return;
            }
            case 'plan_removed':
              return;
            case 'session_info_update': {
              const title = typeof data.title === 'string' ? data.title.trim().slice(0, 200) : '';
              if (title && title !== live.title) {
                live.title = title;
                this.#enqueue(live, [], { title, reason: 'title' });
                void this.#store.touchAwbSession(live.cli, live.sessionId, { title }).catch(() => undefined);
              }
              return;
            }
            default:
              break;
          }
        }
        if (event.method === 'elicitation/complete') {
          // URL 방식 elicitation 이 끝났다는 어댑터의 알림 — 카드를 '완료' 로 닫는다.
          const elicitationId = String(data.elicitationId ?? data.elicitation_id ?? '');
          if (elicitationId) {
            this.#enqueue(live, [{ type: 'elicitation_decision', payload: { elicitation_id: elicitationId, action: 'accept', decided_by: 'agent' }, turn_id: turnId }]);
          }
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
    const meta = (permission._meta?.permission ?? null) as Record<string, unknown> | null;
    const title = permission.title || permission.toolCall?.title || (typeof meta?.title === 'string' ? meta.title : '');
    const description = permission.description || (typeof meta?.description === 'string' ? meta.description : '');
    const [requestEvent] = this.#enqueue(live, [{
      type: 'permission_request',
      payload: {
        request_id: requestId,
        tool_call_id: permission.toolCall?.toolCallId ?? permission.subject?.toolCallId ?? '',
        title,
        ...(description ? { description } : {}),
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
      live.pendingPermissions.set(requestId, { resolve, timer, event: requestEvent });
    });
  }

  /**
   * 미결 permission 을 전부 cancelled 로 푼다(프로세스 종료·close·credential 재오픈). 결정 행을
   * 같이 중계해야 화면의 권한 카드가 "대기 중" 으로 영원히 남지 않는다 — 결정자는 사용자가
   * 아니므로 `decided_by: 'system'`.
   */
  #cancelPendingPermissions(live: LiveSession): void {
    const events: AgentSessionEventInput[] = [];
    for (const [requestId, pending] of live.pendingPermissions) {
      clearTimeout(pending.timer);
      live.pendingPermissions.delete(requestId);
      events.push({
        type: 'permission_decision',
        payload: { request_id: requestId, outcome: 'cancelled', option_id: null, decided_by: 'system' },
        turn_id: live.turn?.turnId,
      });
      pending.resolve({ outcome: 'cancelled' });
    }
    for (const [elicitationId, pending] of live.pendingElicitations) {
      clearTimeout(pending.timer);
      live.pendingElicitations.delete(elicitationId);
      events.push({
        type: 'elicitation_decision',
        payload: { elicitation_id: elicitationId, action: 'cancel', decided_by: 'system' },
        turn_id: live.turn?.turnId,
      });
      pending.resolve({ action: 'cancel' });
    }
    if (events.length) this.#enqueue(live, events);
  }

  /**
   * 어댑터의 `elicitation/create` — 에이전트가 사용자에게 구조화된 입력을 요청한다(claude 의
   * AskUserQuestion, codex 의 질문 등). form 은 JSON Schema 를 그대로 카드로 넘기고 답이 올 때까지
   * 요청을 연다. url 은 링크 카드만 남기고 바로 accept 한다(완료는 `elicitation/complete` 로 온다).
   */
  async #onElicitation(live: LiveSession, request: AcpElicitationRequest): Promise<AcpElicitationOutcome> {
    if (live.loading) return { action: 'cancel' };
    const turnId = live.turn?.turnId;
    this.#flushBuffers(live, turnId);
    const mode = request.mode === 'url' ? 'url' : 'form';
    const elicitationId = (mode === 'url' && typeof request.elicitationId === 'string' && request.elicitationId) ? request.elicitationId : randomUUID();
    const payload: Record<string, unknown> = {
      elicitation_id: elicitationId,
      mode,
      message: typeof request.message === 'string' ? request.message.slice(0, 8_000) : '',
      tool_call_id: typeof request.toolCallId === 'string' ? request.toolCallId : '',
    };
    if (mode === 'form') payload.schema = boundedValue(request.requestedSchema ?? {});
    if (mode === 'url') payload.url = typeof request.url === 'string' ? request.url.slice(0, 2_048) : '';
    if (mode === 'url') {
      this.#enqueue(live, [{ type: 'elicitation_request', payload, turn_id: turnId }]);
      return { action: 'accept' };
    }
    const [requestEvent] = this.#enqueue(live, [{ type: 'elicitation_request', payload, turn_id: turnId }], { status: 'awaiting_input', reason: 'elicitation' });
    return new Promise<AcpElicitationOutcome>((resolve) => {
      const timer = setTimeout(() => {
        live.pendingElicitations.delete(elicitationId);
        this.#enqueue(live, [{
          type: 'elicitation_decision',
          payload: { elicitation_id: elicitationId, action: 'cancel', decided_by: 'timeout' },
          turn_id: live.turn?.turnId,
        }], { status: this.#statusOf(live) === 'awaiting_input' ? 'busy' : this.#statusOf(live), reason: 'elicitation_timeout' });
        resolve({ action: 'cancel' });
      }, this.#options.permissionTimeoutMs);
      timer.unref?.();
      live.pendingElicitations.set(elicitationId, { resolve, timer, event: requestEvent });
    });
  }

  #resolveElicitation(cli: string, sessionId: string, elicitationId: string, action: 'accept' | 'decline' | 'cancel', content: Record<string, unknown> | null): void {
    const live = this.#live.get(this.#key(cli, sessionId));
    if (!live) return;
    const pending = live.pendingElicitations.get(elicitationId);
    if (!pending) {
      log(`[agent-session ${cli} ${sessionId.slice(0, 8)}] elicitation ${elicitationId.slice(0, 8)} not pending (late or duplicate answer)`);
      return;
    }
    clearTimeout(pending.timer);
    live.pendingElicitations.delete(elicitationId);
    this.#enqueue(live, [{
      type: 'elicitation_decision',
      payload: { elicitation_id: elicitationId, action, ...(action === 'accept' ? { content: boundedValue(content ?? {}) } : {}), decided_by: 'user' },
      turn_id: live.turn?.turnId,
    }], { status: live.pendingPermissions.size > 0 ? 'awaiting_permission' : 'busy', reason: `elicitation_${action}` });
    pending.resolve(action === 'accept' ? { action: 'accept', content: content ?? {} } : { action });
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

  /** 세션당 FIFO — 서버는 저장하지 않지만 소유자 UI 는 seq 순서로 병합한다. 찍힌 행을 돌려준다. */
  #enqueue(live: LiveSession, events: AgentSessionEventInput[], state?: AgentSessionStatePatch): StampedEvent[] {
    // 세션 id 가 정해지기 전(session/new 응답 전)에 어댑터가 보내는 알림은 보낼 곳이 없다. 예전엔
    // seq 만 올리고 버려서 이후 행의 seq 가 한 칸씩 어긋났고, UI 의 유실 감지(hasSeqGap)가 계속
    // 재조회를 돌게 했다. 아예 세지 않는다.
    // 세션 id 가 정해지기 전(session/new 응답 전)에 어댑터가 보내는 행은 보낼 곳이 없다 — 예전엔
    // seq 만 올리고 버려서 이후 행의 seq 가 한 칸씩 어긋났다(UI 의 유실 감지가 계속 재조회를 돌았다).
    // 세지 말고 모아 뒀다가 세션이 열리면 순서대로 내보낸다(MCP 연결 실패 안내가 여기 실린다).
    if (!live.sessionId) {
      live.preSessionEvents.push(...events);
      return [];
    }
    const now = new Date().toISOString();
    const stamped: StampedEvent[] = events.map((e) => {
      live.seq += 1;
      return { ...e, payload: boundedPayload(e.payload), seq: live.seq, id: `${live.sessionId}:live:${live.nonce}:${live.seq}`, created_at: now };
    });
    const ref = this.#ref(live.cli, live.sessionId);
    live.postChain = live.postChain
      .then(() => (stamped.length || state
        ? postAgentSessionEvents(this.#config, ref, stamped, state ?? null)
        : Promise.resolve({ ok: true, status: 204 })))
      .then(() => undefined, () => undefined);
    return stamped;
  }

  // ─── 수명주기 ─────────────────────────────────────────────────────────

  #touch(live: LiveSession): void {
    this.#clearIdle(live);
    if (live.turn) return;
    const ms = this.#options.idleMinutes * 60_000;
    if (ms <= 0) return;
    live.idleTimer = setTimeout(() => {
      if (live.turn || live.pendingPermissions.size > 0 || live.pendingElicitations.size > 0) {
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
    this.#clearIdle(live);
    if (live.closing) {
      this.#cancelPendingPermissions(live);
      return;
    }
    this.#live.delete(key);
    const detail = `Agent process exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).`;
    log(`[agent-session ${live.cli} ${live.sessionId.slice(0, 8)}] ${detail}`);
    this.#flushBuffers(live, live.turn?.turnId);
    this.#cancelPendingPermissions(live);
    // 프로세스가 없으니 상태는 무조건 idle 이다 — 턴 중이었어도 마찬가지(#runPrompt 의 catch 가
    // 곧 error 행 + turn(finished) 을 덧붙이고 같은 idle 을 다시 보낸다). 예전엔 턴 중이면 상태를
    // 안 보냈고, 그 사이 매니저가 종료되면 서버에 busy/awaiting_permission 이 그대로 남았다.
    this.#enqueue(live, [{ type: 'system', payload: { text: `${detail} The next prompt reopens the session.` } }],
      { status: 'idle', reason: 'process_exit' });
    this.#exited.push(live);
    if (this.#exited.length > 50) this.#exited.splice(0, this.#exited.length - 50);
  }

  async #closeLive(cli: string, sessionId: string, finalStatus: 'closed' | 'idle', reason: string = finalStatus): Promise<void> {
    const key = this.#key(cli, sessionId);
    const live = this.#live.get(key);
    if (!live) return;
    live.closing = true;
    this.#clearIdle(live);
    this.#cancelPendingPermissions(live);
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
