// Agent Session (CLI 직접 세션) 러너 — docs/agent-sessions.md.
//
// AWB 서버가 `agent_session_request` SSE 로 보내는 제어 요청(open / prompt /
// permission / cancel / set_mode / close)을 받아, 세션당 하나의 ACP 에이전트
// 프로세스(claude-agent-acp / codex-acp / hermes-acp / 사용자 지정 명령)를 띄우고
// 그 스트림(text · reasoning · tool call · permission · usage)을 **가공 없이**
// 서버의 append-only 트랜스크립트로 릴레이한다.
//
// 기존 ChatSessionManager 와 의도적으로 다른 점:
//   - 프롬프트 래핑 없음. 사용자의 텍스트가 그대로 session/prompt 로 간다.
//   - 답변은 MCP 툴 호출이 아니라 agent_message_chunk 스트림이다.
//   - 세션 id 는 서버 레코드(AgentSession.id)이며 방(room)과 무관하다.
//   - 권한 요청(session/request_permission)은 사용자에게 릴레이해 결정을 기다린다.
//
// 프로세스 수명: 유휴(idleMinutes) 또는 close 시 종료. 종료된 세션은 서버에서
// `suspended` 로 표시되고, 다음 prompt 가 오면 native_session_id 로 session/load
// (어댑터가 지원할 때)를 시도한 뒤 아니면 새 세션을 연다 — 트랜스크립트는 서버에
// 남아 있으므로 UI 쪽 히스토리는 어느 경우든 보존된다.

import { access, constants as fsConstants } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';

import { createAdapter } from './cli-adapters/index.js';
import { log } from './logging.js';
import { terminateDetachedProcessTree } from './process-tree.js';
import {
  patchAgentSession,
  postAgentSessionEvents,
  type AgentSessionEventInput,
  type AgentSessionPatch,
  type AwbConfig,
} from './rest.js';
import { AcpClient } from './runtime/acp/acp-client.js';
import type {
  AcpMcpServer,
  AcpPermissionOutcome,
  AcpPermissionRequest,
} from './runtime/acp/acp-types.js';
import { resolveHermesAcpCommand } from './runtime/hermes/hermes-command.js';
import type { RuntimeEvent } from './runtime/runtime-events.js';

/** 서버 payload (apps/server/src/common/types/stream-events.ts AgentSessionRequestPayload). */
export interface AgentSessionRequest {
  session_id: string;
  workspace_id: string;
  agent_id: string;
  owner_user_id: string;
  op: 'open' | 'prompt' | 'permission' | 'cancel' | 'set_mode' | 'close';
  runtime: string;
  cwd: string;
  native_session_id: string | null;
  permission_policy: string;
  turn_id?: string;
  text?: string;
  request_id?: string;
  option_id?: string | null;
  mode_id?: string;
  issued_at: string;
}

/** 디스패처의 AgentExecutionContext 중 러너가 쓰는 부분(순환 import 방지용 구조 타입). */
export interface AgentSessionAgentContext {
  agent_id: string;
  workspace_id: string;
  api_key: string;
  cwd: string;
  cli: string;
  cli_home_dir: string;
  extra_env?: Record<string, string>;
  model?: string | null;
  runtime_config?: { extra?: Record<string, unknown> } | null;
}

export interface ResolvedAcpCommand {
  command: string;
  args: string[];
}

export interface AgentSessionRunnerOptions {
  /** 30분 유휴 시 프로세스 회수(세션 레코드는 suspended 로 유지). */
  idleMinutes?: number;
  /** 사용자가 permission 을 결정하지 않으면 cancelled 로 응답하는 상한. */
  permissionTimeoutMs?: number;
  /** initialize / session/new 등 제어 요청의 타임아웃. prompt 는 별도(promptTimeoutMs). */
  requestTimeoutMs?: number;
  /** 한 프롬프트 턴 상한(툴 승인 대기 포함). 기본 6시간. */
  promptTimeoutMs?: number;
  /** 텍스트 청크 합치기 간격. */
  flushIntervalMs?: number;
  /** 테스트용 명령 해석 override. */
  commandResolver?: (runtime: string, ctx: AgentSessionAgentContext) => Promise<ResolvedAcpCommand>;
  /** 테스트용 env override(없으면 process.env 기반). */
  baseEnv?: NodeJS.ProcessEnv;
  clientVersion?: string;
}

interface PendingPermission {
  resolve: (outcome: AcpPermissionOutcome) => void;
  timer: NodeJS.Timeout;
}

interface LiveSession {
  sessionId: string;
  agentId: string;
  workspaceId: string;
  runtime: string;
  cwd: string;
  client: AcpClient;
  nativeSessionId: string;
  loadSupported: boolean;
  permissionPolicy: string;
  rest: AwbConfig;
  pendingPermissions: Map<string, PendingPermission>;
  turn: { turnId: string; startedAt: number } | null;
  textBuffer: string;
  reasoningBuffer: string;
  flushTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  /** 세션당 REST 전송을 직렬화해 서버 seq 가 스트림 순서와 일치하게 한다. */
  postChain: Promise<void>;
  closing: boolean;
  exited: boolean;
}

const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_PERMISSION_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 6 * 60 * 60_000;
const DEFAULT_FLUSH_INTERVAL_MS = 150;
/** 툴 input/output 문자열 상한 — 서버 payload 상한(256k) 아래로 여유 있게. */
const MAX_TOOL_TEXT_CHARS = 16_000;
const MAX_PAYLOAD_CHARS = 200_000;
const ALLOW_KINDS = new Set(['allow_once', 'allow_always', 'allow_session']);

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]` : value;
}

/** 툴 input/output 을 JSON 안전 + 크기 제한된 값으로. */
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

async function findOnPath(name: string): Promise<string | null> {
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
 * 런타임별 ACP 어댑터 명령. 우선순위:
 *   1. Agent.runtime_config.extra.acp_command (+ acp_args) — 운영자 명시
 *   2. env AWB_ACP_COMMAND_<RUNTIME> (예: AWB_ACP_COMMAND_CLAUDE="node /opt/acp.js")
 *   3. 런타임 기본값: PATH 의 어댑터 바이너리, 없으면 npx --yes <패키지>
 * 어느 것도 없으면 throw — 서버 쪽 resolveAgentSessionRuntime 과 같은 집합이다.
 */
export async function resolveAcpCommandForRuntime(
  runtime: string,
  ctx: AgentSessionAgentContext,
): Promise<ResolvedAcpCommand> {
  const extra = (ctx.runtime_config?.extra ?? {}) as Record<string, unknown>;
  if (typeof extra.acp_command === 'string' && extra.acp_command.trim()) {
    const args = Array.isArray(extra.acp_args) ? extra.acp_args.map((a) => String(a)) : [];
    return { command: extra.acp_command.trim(), args };
  }
  const envOverride = process.env[`AWB_ACP_COMMAND_${runtime.toUpperCase()}`]?.trim();
  if (envOverride) return parseCommandLine(envOverride);
  switch (runtime) {
    case 'claude':
    case 'deepseek': {
      const found = await findOnPath('claude-agent-acp');
      return found
        ? { command: found, args: [] }
        : { command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp'] };
    }
    case 'codex': {
      const found = await findOnPath('codex-acp');
      return found
        ? { command: found, args: [] }
        : { command: 'npx', args: ['--yes', '@zed-industries/codex-acp'] };
    }
    case 'hermes': {
      const resolved = await resolveHermesAcpCommand();
      return { command: resolved.command, args: [...resolved.argsPrefix] };
    }
    default:
      throw new Error(`No ACP adapter is known for runtime "${runtime}". Set runtime_config.extra.acp_command on the agent.`);
  }
}

export class AgentSessionRunner {
  readonly #config: AwbConfig;
  readonly #options: Required<Pick<AgentSessionRunnerOptions, 'idleMinutes' | 'permissionTimeoutMs' | 'requestTimeoutMs' | 'promptTimeoutMs' | 'flushIntervalMs'>>
    & Pick<AgentSessionRunnerOptions, 'commandResolver' | 'baseEnv' | 'clientVersion'>;
  readonly #live = new Map<string, LiveSession>();
  readonly #opening = new Map<string, Promise<LiveSession>>();

  constructor(config: AwbConfig, options: AgentSessionRunnerOptions = {}) {
    this.#config = config;
    this.#options = {
      idleMinutes: options.idleMinutes ?? DEFAULT_IDLE_MINUTES,
      permissionTimeoutMs: options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      promptTimeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      commandResolver: options.commandResolver,
      baseEnv: options.baseEnv,
      clientVersion: options.clientVersion,
    };
  }

  /** self-update drain / 하트비트용: 턴이 진행 중인 세션. */
  _snapshot(): Array<{ session_id: string; agent_id: string; runtime: string; busy: boolean; pid: number | null }> {
    return Array.from(this.#live.values()).map((live) => ({
      session_id: live.sessionId,
      agent_id: live.agentId,
      runtime: live.runtime,
      busy: live.turn !== null || live.pendingPermissions.size > 0,
      pid: live.client.process.pid ?? null,
    }));
  }

  countInFlight(): number {
    return this._snapshot().filter((s) => s.busy).length;
  }

  /** 디스패처 진입점. ctx 가 없으면(이 매니저가 부트스트랩하지 않은 agent) 서버에 error 로 남긴다. */
  async handle(request: AgentSessionRequest, ctx: AgentSessionAgentContext | undefined): Promise<void> {
    const sid = request.session_id;
    if (!sid || !request.agent_id) return;
    const tag = `[agent-session ${sid.slice(0, 8)}]`;
    if (!ctx) {
      if (request.op === 'open' || request.op === 'prompt' || request.op === 'set_mode') {
        log(`${tag} ${request.op}: agent ${request.agent_id.slice(0, 8)} has no bootstrapped context on this manager`);
        await patchAgentSession(this.#config, sid, request.agent_id, {
          status: 'error',
          last_error: 'This agent is registered on the Runtime Host but its runtime context is not bootstrapped (missing api key / working_dir). Spawn or restart the agent from the AI Agents page, then prompt again.',
          reason: 'agent_context_missing',
        });
      }
      return;
    }
    const rest: AwbConfig = { ...this.#config, apiKey: ctx.api_key, retryApiKey: this.#config.apiKey };
    // op 도중 프로세스가 죽어 live 가 맵에서 빠져도 그 세션의 전송 체인은 같은 객체에
    // 이어 붙으므로, 여기서 잡아 둔 핸들로 끝까지 기다릴 수 있다.
    const liveBefore = this.#live.get(sid);
    try {
      switch (request.op) {
        case 'open':
          await this.#ensureLive(request, ctx, rest);
          return;
        case 'prompt': {
          const live = await this.#ensureLive(request, ctx, rest);
          await this.#runPrompt(live, request.turn_id || randomUUID(), request.text || '');
          return;
        }
        case 'permission':
          this.#resolvePermission(sid, request.request_id || '', request.option_id ?? null);
          return;
        case 'cancel': {
          const live = this.#live.get(sid);
          if (!live) return;
          await live.client.cancel(live.nativeSessionId).catch(() => undefined);
          return;
        }
        case 'set_mode': {
          const live = await this.#ensureLive(request, ctx, rest);
          const modeId = request.mode_id || '';
          if (!modeId) return;
          await live.client.request('session/set_mode', { sessionId: live.nativeSessionId, modeId }, { timeoutMs: this.#options.requestTimeoutMs });
          this.#enqueue(live, [{ type: 'system', payload: { text: `Mode set to ${modeId}.` } }], { current_mode: modeId, reason: 'mode' });
          return;
        }
        case 'close':
          await this.#closeLive(sid, 'closed');
          return;
        default:
          log(`${tag} unknown op ${String((request as any).op)}`);
      }
      // 호출자(디스패처/테스트)가 돌아왔을 때 서버가 이미 행을 가진 상태이도록,
      // 이 op 가 큐에 넣은 전송까지 기다린다. 스트림은 세션당 FIFO 라 순서는 그대로다.
      const settled = this.#live.get(sid) ?? liveBefore;
      if (settled) await settled.postChain;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log(`${tag} ${request.op} failed: ${message}`);
      const live = this.#live.get(sid);
      if (live) {
        this.#enqueue(live, [{ type: 'error', payload: { message, code: err?.code ?? undefined }, turn_id: request.turn_id }], {
          status: live.turn ? 'busy' : 'error',
          last_error: message,
          reason: `${request.op}_failed`,
        });
      } else {
        await postAgentSessionEvents(rest, sid, ctx.agent_id, [{ type: 'error', payload: { message, code: err?.code ?? undefined }, turn_id: request.turn_id }], {
          status: 'error',
          last_error: message,
          reason: `${request.op}_failed`,
        });
      }
    }
  }

  async stopAll(reason = 'manager_shutdown'): Promise<void> {
    const ids = Array.from(this.#live.keys());
    await Promise.all(ids.map((id) => this.#closeLive(id, 'suspended', reason).catch(() => undefined)));
  }

  // ─── 프로세스/세션 열기 ───────────────────────────────────────────────

  async #ensureLive(request: AgentSessionRequest, ctx: AgentSessionAgentContext, rest: AwbConfig): Promise<LiveSession> {
    const sid = request.session_id;
    const existing = this.#live.get(sid);
    if (existing && !existing.exited && !existing.closing) return existing;
    const inFlight = this.#opening.get(sid);
    if (inFlight) return inFlight;
    const opening = this.#open(request, ctx, rest).finally(() => this.#opening.delete(sid));
    this.#opening.set(sid, opening);
    return opening;
  }

  async #open(request: AgentSessionRequest, ctx: AgentSessionAgentContext, rest: AwbConfig): Promise<LiveSession> {
    const sid = request.session_id;
    const tag = `[agent-session ${sid.slice(0, 8)}]`;
    const runtime = (request.runtime || ctx.cli || 'claude').toLowerCase();
    const cwd = (request.cwd || ctx.cwd || '').trim();
    if (!cwd) throw new Error('No working directory: set cwd on the session or working_dir on the agent.');
    try {
      await access(cwd, fsConstants.R_OK);
    } catch {
      throw new Error(`Working directory does not exist on this Runtime Host: ${cwd}`);
    }
    const resolver = this.#options.commandResolver ?? resolveAcpCommandForRuntime;
    const { command, args } = await resolver(runtime, ctx);
    const env = this.#buildEnv(runtime, ctx, sid);
    log(`${tag} spawning ACP adapter runtime=${runtime} cmd=${command} ${args.join(' ')} cwd=${cwd}`);

    const client = await AcpClient.spawn({
      command,
      args,
      cwd,
      env,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      onEvent: (event) => this.#onEvent(sid, event),
      onPermissionRequest: (permission) => this.#onPermission(sid, permission),
      onStderr: (line) => log(`${tag} stderr: ${line}`),
      spawnOptions: { detached: process.platform !== 'win32' },
    });

    const live: LiveSession = {
      sessionId: sid,
      agentId: ctx.agent_id,
      workspaceId: request.workspace_id,
      runtime,
      cwd,
      client,
      nativeSessionId: '',
      loadSupported: false,
      permissionPolicy: request.permission_policy || 'ask',
      rest,
      pendingPermissions: new Map(),
      turn: null,
      textBuffer: '',
      reasoningBuffer: '',
      flushTimer: null,
      idleTimer: null,
      postChain: Promise.resolve(),
      closing: false,
      exited: false,
    };
    // 이벤트 콜백이 live 를 찾을 수 있도록 세션 협상 전에 등록한다.
    this.#live.set(sid, live);
    client.process.once('exit', (code, signal) => this.#onProcessExit(sid, code, signal));

    try {
      const initialized = await client.initialize({
        clientInfo: { name: 'awb-agent-session', version: this.#options.clientVersion || '1' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const caps = (initialized?.agentCapabilities ?? {}) as Record<string, unknown>;
      live.loadSupported = caps.loadSession === true;

      const mcpServers = this.#mcpServers(ctx, sid);
      let resumed = false;
      let modes: unknown = undefined;
      if (request.native_session_id && live.loadSupported) {
        try {
          const loaded = await client.loadSession({ sessionId: request.native_session_id, cwd, mcpServers });
          live.nativeSessionId = request.native_session_id;
          modes = (loaded as any)?.modes;
          resumed = true;
        } catch (err: any) {
          log(`${tag} session/load failed (${err?.message ?? err}); opening a fresh session`);
        }
      }
      if (!resumed) {
        const created = await client.newSession({ cwd, mcpServers });
        live.nativeSessionId = created.sessionId;
        modes = created.modes;
      }
      const modeInfo = this.#parseModes(modes);
      this.#enqueue(live, [{
        type: 'system',
        payload: {
          text: resumed
            ? `Session resumed (${runtime}, ${cwd}).`
            : `Session opened (${runtime}, ${cwd}).`,
          runtime,
          cwd,
          resumed,
          command: `${command} ${args.join(' ')}`.trim(),
        },
      }], {
        status: 'ready',
        native_session_id: live.nativeSessionId,
        resume_supported: live.loadSupported,
        current_mode: modeInfo.current,
        available_modes: modeInfo.available,
        last_error: null,
        reason: resumed ? 'resumed' : 'opened',
      });
      this.#touch(live);
      return live;
    } catch (err) {
      this.#live.delete(sid);
      await this.#killClient(live).catch(() => undefined);
      throw err;
    }
  }

  #buildEnv(runtime: string, ctx: AgentSessionAgentContext, sessionId: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.#options.baseEnv ?? process.env) };
    if (runtime === 'hermes') {
      // HermesRuntime 과 같은 격리 상태 디렉터리(<MANAGED_AGENTS_DIR>/<agent>/hermes)를
      // 공유한다 — cli_home_dir 은 <MANAGED_AGENTS_DIR>/<agent>/cli-home 이므로 형제 경로.
      if (ctx.cli_home_dir) env.HERMES_HOME = join(dirname(ctx.cli_home_dir), 'hermes');
    } else if (ctx.cli_home_dir) {
      try {
        const adapter = createAdapter(runtime === 'deepseek' ? 'deepseek' : runtime);
        const configDirEnv = adapter.configDirEnv();
        if (configDirEnv) env[configDirEnv] = ctx.cli_home_dir;
      } catch {
        /* 알 수 없는 런타임(사용자 지정 명령) — CLI 홈 주입 없음 */
      }
    }
    Object.assign(env, ctx.extra_env ?? {});
    env.AWB_AGENT_ID = ctx.agent_id;
    env.AWB_SESSION_ID = sessionId;
    env.AWB_API_KEY = ctx.api_key;
    env.AWB_URL = this.#config.url;
    return env;
  }

  #mcpServers(ctx: AgentSessionAgentContext, sessionId: string): AcpMcpServer[] {
    return [{
      type: 'http',
      name: 'awb',
      url: `${this.#config.url.replace(/\/$/, '')}/mcp`,
      headers: [
        { name: 'Authorization', value: `Bearer ${ctx.api_key}` },
        { name: 'X-AWB-Client-Type', value: 'agent-session' },
        { name: 'X-AWB-Agent-Id', value: ctx.agent_id },
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

  // ─── 턴 실행 ──────────────────────────────────────────────────────────

  async #runPrompt(live: LiveSession, turnId: string, text: string): Promise<void> {
    if (live.turn) {
      this.#enqueue(live, [{ type: 'error', payload: { message: 'A turn is already in progress.', code: 'turn_in_progress' }, turn_id: turnId }]);
      return;
    }
    live.turn = { turnId, startedAt: Date.now() };
    this.#clearIdle(live);
    this.#enqueue(live, [{ type: 'turn', payload: { phase: 'started' }, turn_id: turnId }], { status: 'busy', reason: 'turn_started' });
    try {
      const response = await live.client.prompt(
        { sessionId: live.nativeSessionId, prompt: [{ type: 'text', text }] },
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
    } catch (err: any) {
      this.#flushBuffers(live, turnId);
      const message = err?.message ?? String(err);
      this.#enqueue(live, [
        { type: 'error', payload: { message, code: err?.code ?? undefined }, turn_id: turnId },
        { type: 'turn', payload: { phase: 'finished', stop_reason: 'error' }, turn_id: turnId },
      ], { status: live.exited ? 'suspended' : 'error', last_error: message, reason: 'turn_failed' });
    } finally {
      live.turn = null;
      this.#touch(live);
    }
  }

  // ─── ACP 스트림 → 서버 ───────────────────────────────────────────────

  #onEvent(sessionId: string, event: RuntimeEvent): void {
    const live = this.#live.get(sessionId);
    if (!live) return;
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
      case 'tool_completed': {
        this.#flushBuffers(live, turnId);
        this.#enqueue(live, [{
          type: 'tool_update',
          payload: { tool_call_id: event.toolCallId, status: event.status ?? (event.type === 'tool_completed' ? 'completed' : 'in_progress'), output: boundedValue(event.output) },
          turn_id: turnId,
        }]);
        return;
      }
      case 'child_finished':
        this.#flushBuffers(live, turnId);
        this.#enqueue(live, [{
          type: 'tool_update',
          payload: { tool_call_id: event.childRunId, status: event.status, output: boundedValue(event.output) },
          turn_id: turnId,
        }]);
        return;
      case 'usage':
        this.#enqueue(live, [{
          type: 'usage',
          payload: {
            input_tokens: event.inputTokens, output_tokens: event.outputTokens, total_tokens: event.totalTokens,
            cached_read_tokens: event.cachedReadTokens, thought_tokens: event.thoughtTokens,
          },
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
        // available_commands_update 등 나머지는 로그만 — UI 계약에 없는 정보.
        log(`[agent-session ${sessionId.slice(0, 8)}] diagnostic ${event.method}${kind ? ` (${kind})` : ''}`);
        return;
      }
      default:
        return;
    }
  }

  async #onPermission(sessionId: string, permission: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    const live = this.#live.get(sessionId);
    if (!live) return { outcome: 'cancelled' };
    const turnId = live.turn?.turnId;
    this.#flushBuffers(live, turnId);
    const requestId = randomUUID();
    const options = (permission.options ?? []).map((o) => ({ option_id: o.optionId, name: o.name, kind: o.kind }));
    const requestEvent: AgentSessionEventInput = {
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
    };

    if (live.permissionPolicy === 'auto_allow') {
      const pick = (permission.options ?? []).find((o) => ALLOW_KINDS.has(o.kind)) ?? permission.options?.[0];
      this.#enqueue(live, [requestEvent, {
        type: 'permission_decision',
        payload: { request_id: requestId, outcome: pick ? 'selected' : 'cancelled', option_id: pick?.optionId ?? null, decided_by: 'policy' },
        turn_id: turnId,
      }]);
      return pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' };
    }

    this.#enqueue(live, [requestEvent], { status: 'awaiting_permission', reason: 'permission' });
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

  #resolvePermission(sessionId: string, requestId: string, optionId: string | null): void {
    const live = this.#live.get(sessionId);
    if (!live) return;
    const pending = live.pendingPermissions.get(requestId);
    if (!pending) {
      log(`[agent-session ${sessionId.slice(0, 8)}] permission ${requestId.slice(0, 8)} not pending (late or duplicate decision)`);
      return;
    }
    clearTimeout(pending.timer);
    live.pendingPermissions.delete(requestId);
    // 결정 행(permission_decision, decided_by=user)은 서버가 소유자 경로에서 이미 썼다.
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

  /** 세션당 FIFO 로 서버에 보낸다 — 서버 seq 가 스트림 순서와 일치해야 UI 병합이 맞는다. */
  #enqueue(live: LiveSession, events: AgentSessionEventInput[], patch?: AgentSessionPatch): void {
    const bounded = events.map((e) => ({ ...e, payload: boundedPayload(e.payload) }));
    live.postChain = live.postChain
      .then(() => postAgentSessionEvents(live.rest, live.sessionId, live.agentId, bounded, patch ?? null))
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
      void this.#closeLive(live.sessionId, 'suspended', 'idle');
    }, ms);
    live.idleTimer.unref?.();
  }

  #clearIdle(live: LiveSession): void {
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = null;
    }
  }

  #onProcessExit(sessionId: string, code: number | null, signal: NodeJS.Signals | null): void {
    const live = this.#live.get(sessionId);
    if (!live) return;
    live.exited = true;
    for (const [id, pending] of live.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ outcome: 'cancelled' });
      live.pendingPermissions.delete(id);
    }
    this.#clearIdle(live);
    if (live.closing) return; // #closeLive 가 상태를 보고한다
    this.#live.delete(sessionId);
    const detail = `Agent process exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).`;
    log(`[agent-session ${sessionId.slice(0, 8)}] ${detail}`);
    this.#flushBuffers(live, live.turn?.turnId);
    // 턴 진행 중이면 #runPrompt 의 catch 가 error/turn 행을 쓴다(prompt 요청이 peer 종료로 reject).
    this.#enqueue(live, [{ type: 'system', payload: { text: `${detail} The next prompt reopens the session.` } }],
      live.turn ? undefined : { status: 'suspended', reason: 'process_exit' });
  }

  async #closeLive(sessionId: string, finalStatus: 'closed' | 'suspended', reason: string = finalStatus): Promise<void> {
    const live = this.#live.get(sessionId);
    if (!live) {
      if (finalStatus === 'closed') return; // 서버가 이미 closed 로 표시했다
      return;
    }
    live.closing = true;
    this.#clearIdle(live);
    for (const [id, pending] of live.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ outcome: 'cancelled' });
      live.pendingPermissions.delete(id);
    }
    if (live.turn) await live.client.cancel(live.nativeSessionId).catch(() => undefined);
    this.#flushBuffers(live, live.turn?.turnId);
    if (!live.exited && live.nativeSessionId) {
      await live.client.closeSession(live.nativeSessionId).catch(() => undefined);
    }
    this.#live.delete(sessionId);
    await this.#killClient(live);
    const text = finalStatus === 'closed'
      ? 'Agent process stopped.'
      : reason === 'idle'
        ? `Idle for ${this.#options.idleMinutes} min — agent process stopped. The next prompt reopens the session.`
        : `Agent process stopped (${reason}). The next prompt reopens the session.`;
    this.#enqueue(live, [{ type: 'system', payload: { text } }], finalStatus === 'closed'
      ? { reason: 'process_stopped' }
      : { status: 'suspended', reason });
    await live.postChain;
  }

  async #killClient(live: LiveSession): Promise<void> {
    const child = live.client.process;
    const pid = child?.pid;
    live.client.close();
    if (pid && child) await terminateDetachedProcessTree(pid, 250, { child }).catch(() => undefined);
  }
}
