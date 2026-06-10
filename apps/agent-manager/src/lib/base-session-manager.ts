// Shared lifecycle skeleton for persistent per-key CLI children.
// ChatSessionManager (key = roomId) and TicketSessionManager
// (key = `${ticketId}:${role}`) both extend this class.
//
// Parameterized by a CliAdapter — the adapter contributes everything that
// varies across CLIs (argv shape, stream-json formatting, line parsing).
// Sessions are only available when the adapter declares PERSISTENT_SESSION;
// _spawnSession() refuses to spawn for stateless adapters (antigravity, …) so
// the manager can fail fast instead of leaving a half-broken child running.

import { promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { SUBAGENTS_BASE_DIR, STOP_GRACE_MS } from './constants.js';
import { log } from './logging.js';
import { createAdapter } from './cli-adapters/index.js';
import { ADAPTER_CAPABILITIES, PARSE_STAGE, type CliAdapter, type ParseResult, type TurnImage } from './cli-adapters/base.js';
import type { AwbConfig } from './rest.js';
import type { SubagentMonitor, SubagentTapHandle } from './subagent-monitor.js';

const { PERSISTENT_SESSION } = ADAPTER_CAPABILITIES;

// Health watchdog. A session is "responding" as long as its CLI keeps
// emitting output — ANY assistant/thinking line, not just a final `result`,
// clears the unresponded counters (see #wireStdio). Only a genuinely silent
// child (no output at all) lets turns stack on stdin without acks while the
// AWB server re-fires the same trigger forever. Two thresholds, OR'd:
//   - 5 turns dispatched with zero output lines seen back
//   - 30 minutes elapsed since the first unanswered turn, still silent
// NOTE: an earlier version reset only on `result`. A worker mid-long-turn
// (which never emits `result` until done) whose own board-update echoes
// stacked extra turns onto stdin raced this counter to 5 in ~85s and got
// SIGTERM'd before writing a line of code. Reset-on-any-output fixes that.
const UNHEALTHY_TURN_THRESHOLD = 5;
const UNHEALTHY_DURATION_MS = 30 * 60 * 1000;
const HEALTH_SWEEP_INTERVAL_MS = 60 * 1000;
/** Max lines kept in the per-pid stdout/stderr ring used by silent-exit
 *  fallback hooks. Chat and ticket subclasses both consume this buffer. */
const OUTPUT_RING_MAX = 100;

export interface BaseSessionOptions {
  keyField: string;
  logTag: string;
  cfgPrefix: string;
  kindLabel: 'chat_session' | 'ticket_session';
}

export interface SessionDelegationConfig {
  enabled?: boolean;
  maxConcurrent?: number;
  ttlMinutes?: number;
  idleMinutes?: number;
  maxTurnsPerSession?: number;
  claudeBin?: string;
  persistentChatSessions?: boolean;
  persistentTicketSessions?: boolean;
  /** ticket 9f26f091: per-(ticket,role) git worktree isolation. Default true
   *  (DELEGATION_DEFAULTS); false reverts to the shared single-cwd behavior. */
  worktreeIsolation?: boolean;
}

export interface SessionAwareConfig extends AwbConfig {
  delegation: SessionDelegationConfig;
}

export interface MonitorMeta {
  ticket_id?: string;
  ticket_title?: string;
  role?: string;
  trigger_source?: string;
}

export interface SpawnOpts {
  onProgress?: (stage: string) => void;
  monitorMeta?: MonitorMeta;
  /**
   * ST-6: per-call managed-agent runtime context. When provided, the
   * spawned CLI runs with cwd=ctx.cwd, MCP auth = ctx.api_key, reuses
   * ctx.mcp_config_path instead of a freshly-written temp config, and
   * (ST-7) picks the adapter for ctx.cli — claude / codex / antigravity.
   * Optional — undefined falls back to manager-config defaults + the
   * default-claude adapter.
   */
  agentContext?: {
    agent_id: string;
    api_key: string;
    cwd: string;
    mcp_config_path: string;
    cli: string;
    cli_home_dir: string;
    extra_env?: Record<string, string>;
    /** Provider string of the per-agent credential. When set, _spawnSession
     *  strips operator-inherited auth env vars (per adapter.authEnvKeys())
     *  before merging extra_env so the agent's credential isn't silently
     *  overridden by the operator's shell environment. */
    credential_provider?: string | null;
  };
  /** Per-turn image attachments for chat sessions. Only honored by adapters
   *  that support inline image content blocks (Claude); other adapters
   *  ignore the list (metadata already in the prompt text). */
  firstTurnImages?: TurnImage[];
}

interface TurnState {
  onProgress: (stage: string) => void;
  stage: string | null;
  fired: { thinking: boolean; composing: boolean };
  heartbeatTimer: NodeJS.Timeout | null;
}

export interface SessionRecord {
  // Subclass-defined identity field (`roomId` or `sessionKey`).
  [key: string]: any;
  pid: number;
  cli_type: string;
  /** ST-7 cli refactor: the adapter instance the child was spawned with.
   *  Persistent sessions stay bound to one adapter for their entire life
   *  (formatTurn / parseStdoutLine across many turns), so we hold the ref
   *  rather than re-resolving from cli_type on every callback. */
  adapter: CliAdapter;
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  configPath: string | null;
  /** ST-6: false when configPath is the agent's persistent mcp-config.json
   *  and must not be unlinked on session teardown. */
  configPathIsTemp: boolean;
  pidPath: string | null;
  turnCount: number;
  startedAt: number;
  lastTouchedAt: number;
  idleTimer: NodeJS.Timeout | null;
  unrespondedTurnCount: number;
  unrespondedSince: number | null;
  unhealthyKilled: boolean;
  tap: SubagentTapHandle | null;
  _currentTurn?: TurnState | null;
  onResult?: (raw: any) => void;
  /** Set when the running subagent emitted the session-split sentinel in its
   *  output (TicketSessionManager only). The next dispatchTrigger for this
   *  (ticket, role) force-respawns a fresh session instead of reusing this
   *  one. The default policy stays "same (ticket,role) → same session"; this
   *  is the explicit agent-driven escape hatch. */
  splitRequested?: boolean;
  /** Human-readable reason captured from the split sentinel line (capped). */
  splitReason?: string;
  /** Effective MCP api key the child authenticates with — the managed
   *  agent's key when running for one, else the manager's. Used to attribute
   *  manager-posted audit comments (silent-exit, session-split) to the right
   *  identity instead of always the manager. */
  _effectiveApiKey?: string;
}

/** Reservation placed on `_inflight` from the moment a dispatcher commits to
 *  spawning a session until the child is either registered in `_sessions` or
 *  the spawn fails. Subclass-specific identity fields (`ticketId`, `roomId`)
 *  are optional so the same map can host both ticket-session and chat-session
 *  reservations; the base class only cares that the key is occupied so a
 *  concurrent dispatch on the same sessionKey can short-circuit instead of
 *  racing past the `_getLiveSession` check and double-spawning. */
export interface InflightReservation {
  agentId?: string;
  ticketId?: string;
  roomId?: string;
}

export class BaseSessionManager {
  protected readonly _config: SessionAwareConfig;
  /** ST-7: per-cliType adapter cache. Same scheme as SubagentManager —
   *  one createAdapter() per cli over the manager's lifetime. */
  #adapters = new Map<string, CliAdapter>();
  protected readonly _sessions = new Map<string, SessionRecord>();
  /** Synchronous reservation table for in-flight spawns. `_sessions` only
   *  gets the new record at the END of `_spawnSession`, so without this map
   *  two near-simultaneous `dispatchTrigger` / `dispatch` calls can both pass
   *  `_getLiveSession(sessionKey) === undefined` and each spawn a child. The
   *  reservation flips synchronously between the live-session check and the
   *  await on `_spawnSession`, giving the second caller a deterministic
   *  "spawn already in-flight" signal it can drop on. Subclasses store their
   *  own identity metadata (`ticketId`, `roomId`, …) on the value so any
   *  cap-accounting they do across spawned + reserved sessions stays
   *  consistent. */
  protected readonly _inflight = new Map<string, InflightReservation>();
  /** Per-pid plain-text stdout/stderr tail. Wired in `#wireStdio` for every
   *  session the base class spawns; subclasses read it in their
   *  `_onChildExit` hook to build silent-exit fallback messages without
   *  re-implementing the buffering. Non-JSON stdout lines and all stderr
   *  lines land here — stream-json events stay out so the buffer is
   *  human-readable. */
  protected readonly _outputRings = new Map<number, string[]>();
  #dedupSet = new Set<string>();
  #dedupQueue: string[] = [];
  #DEDUP_MAX = 200;
  #healthTimer: NodeJS.Timeout | null = null;

  #keyField: string;
  #logTag: string;
  #cfgPrefix: string;
  #kindLabel: 'chat_session' | 'ticket_session';

  #monitor: SubagentMonitor | null = null;

  constructor(config: SessionAwareConfig, options: BaseSessionOptions) {
    this._config = config;
    this.#keyField = options.keyField;
    this.#logTag = options.logTag;
    this.#cfgPrefix = options.cfgPrefix;
    this.#kindLabel = options.kindLabel;
  }

  /** Default-claude getter for legacy callers that introspect the manager. */
  protected get _adapter(): CliAdapter {
    return this._adapterFor('claude');
  }

  protected _adapterFor(cli: string | null | undefined): CliAdapter {
    const t = String(cli || 'claude').toLowerCase();
    let a = this.#adapters.get(t);
    if (!a) {
      a = createAdapter(t);
      this.#adapters.set(t, a);
    }
    return a;
  }

  setMonitor(monitor: SubagentMonitor | null): void {
    this.#monitor = monitor;
  }

  protected _getSession(sessionKey: string): SessionRecord | undefined {
    return this._sessions.get(sessionKey);
  }

  /** OS-level liveness probe for a child pid. `process.kill(pid, 0)` is a
   *  non-destructive existence check — ESRCH means the kernel has reaped the
   *  process, EPERM means it exists but we lack permission to signal it
   *  (treat as alive — same uid in practice for us). Used by
   *  `_getLiveSession` to detect a stale `_sessions` entry whose child died
   *  without the exit handler firing (defensive — shouldn't happen with
   *  `#wireExit` always attached, but cheap to verify and we've observed the
   *  failure mode in operator reports). */
  protected _isPidAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // EPERM means the process exists but we can't signal it — count as
      // alive. Anything else (ESRCH most commonly) means dead.
      return err?.code === 'EPERM';
    }
  }

  /** Return the SessionRecord under `sessionKey` only when its child pid is
   *  still alive at the OS level. If the in-memory record is stale (pid was
   *  reaped but exit cleanup didn't run), purge it and return undefined so
   *  the caller falls through to a fresh spawn. This is the dispatch-side
   *  source-of-truth reconciliation between `_sessions` and the OS process
   *  table that the dedup ticket called out as missing. */
  protected _getLiveSession(sessionKey: string): SessionRecord | undefined {
    const sess = this._sessions.get(sessionKey);
    if (!sess) return undefined;
    // A session flagged unhealthy is mid-teardown (SIGTERM delivered, SIGKILL
    // scheduled) — its child may still be pid-alive during the grace window,
    // but dispatching a follow-up turn into a dying stdin would stall the AWB
    // trigger loop. Treat it as not-live and purge so the caller fresh-spawns.
    // `#killUnhealthy` normally deletes the record itself; this is the
    // defensive belt for any path that flags-then-defers the delete, and it
    // satisfies the "stuck session is not reused" acceptance criterion.
    if (sess.unhealthyKilled) {
      log(
        `${this.#logTag} unhealthy ${this.#keyField}=${sessionKey} pid=${sess.pid} — not reusing a session under teardown; purging in-memory record`,
      );
      if (sess.idleTimer) {
        clearTimeout(sess.idleTimer);
        sess.idleTimer = null;
      }
      this.#endTurn(sess);
      this._sessions.delete(sessionKey);
      return undefined;
    }
    if (this._isPidAlive(sess.pid)) return sess;
    log(
      `${this.#logTag} stale ${this.#keyField}=${sessionKey} pid=${sess.pid} — child reaped without exit-handler cleanup; purging in-memory record`,
    );
    if (sess.idleTimer) {
      clearTimeout(sess.idleTimer);
      sess.idleTimer = null;
    }
    this.#endTurn(sess);
    this._sessions.delete(sessionKey);
    return undefined;
  }

  protected _ensureCapacity(): boolean {
    const cap = this._config.delegation.maxConcurrent ?? 5;
    if (this._sessions.size < cap) return true;
    return this.#evictLru();
  }

  protected async _spawnSession(
    sessionKey: string,
    rolePrompt: string,
    firstTurnText: string,
    { onProgress, monitorMeta, agentContext, firstTurnImages }: SpawnOpts = {},
  ): Promise<SessionRecord | null> {
    // ST-7: pick the adapter for this agent's CLI choice (claude/codex/antigravity)
    // and bind it to the session record so future turns formatTurn /
    // parseStdoutLine through the same adapter even if the manager later
    // hosts agents with different CLIs.
    const adapter = this._adapterFor(agentContext?.cli);

    if (!adapter.has(PERSISTENT_SESSION)) {
      log(
        `${this.#logTag} adapter cli=${adapter.cliType} does not support persistent sessions; refusing to spawn`,
      );
      return null;
    }

    // ST-6: per-call managed-agent context — same semantics as
    // SubagentManager.spawn. Reuse the agent's pre-written mcp-config when
    // available; auth + cwd from the managed agent's identity.
    const effectiveApiKey = agentContext?.api_key || this._config.apiKey;
    const effectiveCwd = agentContext?.cwd || undefined;

    let configPath: string | null = null;
    let configPathIsTemp = false;
    let pidPath: string | null = null;
    try {
      let descriptor = adapter.buildSessionSpawn({
        rolePrompt: rolePrompt || '',
        mcpConfigPath: null,
      });

      if (descriptor.needsMcpConfig) {
        // Per-session config is required whenever the server needs to attribute
        // a comment to a specific (ticket, role) — without the
        // X-AWB-Subagent-Role / X-AWB-Subagent-Ticket-Id headers, the server's
        // resolveAuthorRole falls back to listing every role the agent holds on
        // the ticket, so a comment from one role lands tagged with all of them.
        // The static per-agent mcp_config_path written by spawn_agent only
        // carries Authorization + X-AWB-Client-Type, so we can't use it for
        // ticket sessions. Chat / non-ticket sessions stay on the static path
        // (no role pinning needed there).
        const needsSessionPin = !!(monitorMeta?.ticket_id && monitorMeta?.role);

        if (agentContext?.mcp_config_path && !needsSessionPin) {
          configPath = agentContext.mcp_config_path;
          configPathIsTemp = false;
        } else {
          configPath = join(
            SUBAGENTS_BASE_DIR,
            `${this.#cfgPrefix}${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
          );
          configPathIsTemp = true;
          await fsp.mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
          const headers: Record<string, string> = {
            Authorization: `Bearer ${effectiveApiKey}`,
            'X-AWB-Client-Type': agentContext ? 'managed-subagent' : 'subagent',
          };
          if (monitorMeta?.ticket_id) headers['X-AWB-Subagent-Ticket-Id'] = monitorMeta.ticket_id;
          if (monitorMeta?.role) headers['X-AWB-Subagent-Role'] = monitorMeta.role;
          if (monitorMeta?.trigger_source) headers['X-AWB-Subagent-Trigger-Source'] = monitorMeta.trigger_source;
          const mcpConfig = {
            mcpServers: {
              awb: {
                type: 'http',
                url: `${this._config.url.replace(/\/$/, '')}/mcp`,
                headers,
              },
            },
          };
          await fsp.writeFile(configPath, JSON.stringify(mcpConfig), { mode: 0o600 });
        }

        descriptor = adapter.buildSessionSpawn({
          rolePrompt: rolePrompt || '',
          mcpConfigPath: configPath,
        });
      }

      // `delegation.claudeBin` is the legacy operator override for the
      // claude binary path only — passing it to non-claude adapters
      // caused codex / antigravity spawns to launch the literal "claude" bin
      // (resolver short-circuits on `configured`, returning it verbatim).
      const binOverride =
        adapter.cliType === 'claude' ? this._config.delegation.claudeBin : null;
      const resolvedBin = adapter.resolveBin(binOverride);
      // ST-7 follow-up: per-agent CLI home isolation (see SubagentManager).
      const cliHomeEnvKey = adapter.configDirEnv();
      const cliHomeEnv = cliHomeEnvKey && agentContext?.cli_home_dir
        ? { [cliHomeEnvKey]: agentContext.cli_home_dir }
        : {};
      // Per-agent credential extras — see SubagentManager for the
      // matching one-shot path.
      const credentialEnv = agentContext?.extra_env ?? {};
      // Strip operator-inherited auth env vars when this agent has its
      // own credential — otherwise the operator's shell-level
      // ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY
      // silently overrides the per-agent .credentials.json / auth.json /
      // oauth_creds.json file the adapter wrote into cli-home.
      const baseEnv = { ...process.env };
      if (agentContext?.credential_provider) {
        const stripped: string[] = [];
        for (const k of adapter.authEnvKeys()) {
          if (k in baseEnv) {
            delete baseEnv[k];
            stripped.push(k);
          }
        }
        if (stripped.length > 0) {
          log(
            `${this.#logTag} env strip: agent=${agentContext.agent_id.slice(0, 8)} ` +
              `provider=${agentContext.credential_provider} removed=${stripped.join(',')} ` +
              `(operator-inherited auth would have overridden per-agent credential)`,
          );
        }
      }
      // See subagent-manager spawn site for why detached is POSIX-only:
      // DETACHED_PROCESS on win32 fights with CREATE_NO_WINDOW and flashes a
      // cmd console when the resolved binary is a .cmd/.bat shim.
      const child = spawn(resolvedBin, descriptor.args, {
        stdio: descriptor.stdio || ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        cwd: effectiveCwd,
        env: { ...baseEnv, AWB_API_KEY: effectiveApiKey, ...cliHomeEnv, ...credentialEnv },
        shell: descriptor.shell ?? /\.(cmd|bat|ps1)$/i.test(resolvedBin),
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
      child.once('error', (err: any) => {
        log(
          `${this.#logTag} spawn error: code=${err?.code || ''} cli=${adapter.cliType} bin=${resolvedBin} msg=${err?.message}`,
        );
      });
      child.unref();

      if (!child.pid) {
        if (configPath && configPathIsTemp) await fsp.unlink(configPath).catch(() => {});
        return null;
      }
      if (configPath && configPathIsTemp) {
        // Per-spawn pid sidecar so #sweep + orphan cleanup can find this
        // child by its tempfile. Skipped for the persistent agent-owned
        // mcp-config — the per-agent dir already groups its children.
        pidPath = configPath.replace(/\.json$/, '.pid');
        await fsp.writeFile(pidPath, String(child.pid), { mode: 0o600 }).catch(() => {});
      }

      const sess: SessionRecord = {
        [this.#keyField]: sessionKey,
        pid: child.pid,
        cli_type: adapter.cliType,
        adapter,
        child,
        configPath,
        configPathIsTemp,
        pidPath,
        turnCount: 0,
        startedAt: Date.now(),
        lastTouchedAt: Date.now(),
        idleTimer: null,
        unrespondedTurnCount: 0,
        unrespondedSince: null,
        unhealthyKilled: false,
        tap: null,
      };
      sess.tap =
        this.#monitor?.register({
          kind:
            this.#kindLabel === 'chat_session'
              ? 'chat'
              : this.#kindLabel === 'ticket_session'
                ? 'ticket'
                : 'oneshot',
          sessionKey,
          pid: child.pid,
          ticketId: monitorMeta?.ticket_id,
          ticketTitle: monitorMeta?.ticket_title,
          role: monitorMeta?.role,
          // Attribute managed-agent subagents to the managed agent (not the
          // manager) by re-using the per-agent apiKey for the monitor POSTs.
          // Without this, every subagent on the AWB UI's subagent list lands
          // under the manager identity even though it's executing for a
          // managed agent — see subagent-monitor.ts for the per-key bucket
          // and reconcile fan-out that supports this.
          apiKey: agentContext?.api_key,
        }) || null;
      this.#wireStdio(sess);
      this.#wireExit(sess);

      // Greppable counterpart to subclass "reused existing pid=…" lines. The
      // dedup ticket's acceptance asks for unambiguous "spawned new" vs
      // "reused existing" — keep this format stable.
      log(
        `${this.#logTag} spawned new pid=${sess.pid} cli=${adapter.cliType} kind=${this.#kindLabel} ${this.#keyField}=${sessionKey}`,
      );

      this.#startTurn(sess, onProgress);
      this._writeTurn(sess, firstTurnText, firstTurnImages);
      sess.turnCount = 1;
      this._resetIdleTimer(sess);
      this._sessions.set(sessionKey, sess);
      this.#ensureHealthSweep();
      return sess;
    } catch (err: any) {
      log(`${this.#logTag} spawn error ${this.#keyField}=${sessionKey}: ${err?.message ?? err}`);
      if (configPath && configPathIsTemp) await fsp.unlink(configPath).catch(() => {});
      return null;
    }
  }

  protected _sendFollowUp(
    sess: SessionRecord,
    turnText: string,
    {
      checkMaxTurns = true,
      onProgress,
      images,
    }: { checkMaxTurns?: boolean; onProgress?: (stage: string) => void; images?: TurnImage[] } = {},
  ): void {
    this.#startTurn(sess, onProgress);
    this._writeTurn(sess, turnText, images);
    sess.turnCount++;
    sess.lastTouchedAt = Date.now();
    this._resetIdleTimer(sess);
    if (!checkMaxTurns) return;
    const maxTurns = this._config.delegation.maxTurnsPerSession ?? 30;
    if (sess.turnCount >= maxTurns) {
      log(
        `${this.#logTag} ${this.#keyField}=${sess[this.#keyField]} hit maxTurns=${maxTurns}, closing stdin for respawn`,
      );
      try {
        sess.child.stdin.end();
      } catch {
        /* already closed */
      }
    }
  }

  #startTurn(sess: SessionRecord, onProgress?: (stage: string) => void): void {
    this.#endTurn(sess);
    if (typeof onProgress !== 'function') return;
    const turn: TurnState = {
      onProgress,
      stage: null,
      fired: { thinking: false, composing: false },
      heartbeatTimer: null,
    };
    sess._currentTurn = turn;
    turn.heartbeatTimer = setInterval(() => {
      if (sess._currentTurn === turn && turn.stage) {
        try {
          turn.onProgress(turn.stage);
        } catch (err: any) {
          log(`${this.#logTag} onProgress heartbeat error: ${err?.message ?? err}`);
        }
      }
    }, 10_000);
    turn.heartbeatTimer.unref?.();
  }

  #endTurn(sess: SessionRecord): void {
    const turn = sess._currentTurn;
    if (!turn) return;
    if (turn.heartbeatTimer) clearInterval(turn.heartbeatTimer);
    sess._currentTurn = null;
  }

  #advanceTurn(sess: SessionRecord, parsed: ParseResult): void {
    const turn = sess._currentTurn;
    if (!turn) return;
    if (!turn.fired.thinking && parsed.stage) {
      turn.fired.thinking = true;
      turn.stage = PARSE_STAGE.THINKING;
      try {
        turn.onProgress(PARSE_STAGE.THINKING);
      } catch (err: any) {
        log(`${this.#logTag} onProgress(thinking) error: ${err?.message ?? err}`);
      }
    }
    if (!turn.fired.composing && parsed.stage === PARSE_STAGE.COMPOSING) {
      turn.fired.composing = true;
      turn.stage = PARSE_STAGE.COMPOSING;
      try {
        turn.onProgress(PARSE_STAGE.COMPOSING);
      } catch (err: any) {
        log(`${this.#logTag} onProgress(composing) error: ${err?.message ?? err}`);
      }
    }
    if (parsed.isResult) {
      sess.unrespondedTurnCount = 0;
      sess.unrespondedSince = null;
      try {
        sess.onResult?.(parsed.raw);
      } catch (err: any) {
        log(`${this.#logTag} onResult error: ${err?.message ?? err}`);
      }
      this.#endTurn(sess);
    }
  }

  protected _writeTurn(sess: SessionRecord, text: string, images?: TurnImage[]): void {
    const wire = sess.adapter.formatTurn(String(text), images);
    try {
      sess.child.stdin.write(wire + '\n');
      sess.tap?.inLine(wire);
      sess.unrespondedTurnCount = (sess.unrespondedTurnCount || 0) + 1;
      if (!sess.unrespondedSince) sess.unrespondedSince = Date.now();
      log(
        `${this.#logTag} dispatched turn ${this.#keyField}=${sess[this.#keyField]} pid=${sess.pid} turn=${
          sess.turnCount + 1
        } bytes=${Buffer.byteLength(text)}`,
      );
    } catch (err: any) {
      log(`${this.#logTag} stdin write failed pid=${sess.pid}: ${err?.message ?? err}`);
      return;
    }
    if (sess.unrespondedTurnCount >= UNHEALTHY_TURN_THRESHOLD) {
      this.#killUnhealthy(
        sess,
        `${sess.unrespondedTurnCount} consecutive turns without an LLM response`,
      );
    }
  }

  #wireStdio(sess: SessionRecord): void {
    if (sess.child.stdout) {
      const rlOut = createInterface({ input: sess.child.stdout });
      const tag = this.#logTag.replace(/^\[|\]$/g, '');
      rlOut.on('line', (line) => {
        sess.tap?.outLine(line);
        const parsed = sess.adapter.parseStdoutLine(line);
        // Health-watchdog liveness: any model output (thinking/composing
        // stage, or a final result) proves the LLM is responding, so clear
        // the unresponded counters here — not only on `result`. A worker
        // mid-long-turn emits assistant/tool/system lines constantly; if its
        // own board-update echoes stack extra turns onto stdin, a result-only
        // reset let unrespondedTurnCount race to the kill threshold (~85s)
        // while the agent was actively working. A truly silent CLI emits
        // nothing → stage stays null → the watchdog still fires as intended.
        if (parsed.stage || parsed.isResult) {
          sess.unrespondedTurnCount = 0;
          sess.unrespondedSince = null;
        }
        this.#advanceTurn(sess, parsed);
        // Buffer plain-text stdout (non-JSON parser misses) into the tail
        // ring so subclasses can surface "what went wrong" on silent exit.
        // Stream-json events are excluded — they're machine-readable noise.
        if (!parsed.raw) {
          const trimmed = line.trim();
          if (trimmed) this.#pushOutputLine(sess.pid, trimmed);
        }
        this._onStdoutParsed(sess, parsed, line);
        if (parsed.isResult) {
          const subtype = parsed.raw?.subtype || '-';
          const isError = parsed.isError === true ? 'true' : (parsed.raw?.is_error ?? '-');
          log(`[${tag}:${sess.pid}] result subtype=${subtype} is_error=${isError}`);
        }
      });
    }
    if (sess.child.stderr) {
      const rlErr = createInterface({ input: sess.child.stderr });
      const tag = this.#logTag.replace(/^\[|\]$/g, '');
      rlErr.on('line', (line) => {
        log(`[${tag}:${sess.pid}:err] ${line}`);
        const trimmed = line.trim();
        if (trimmed) this.#pushOutputLine(sess.pid, trimmed);
        this._onStderrLine(sess, line);
      });
    }
  }

  /** Push a line into the per-pid output ring with a fixed cap. Internal —
   *  subclasses read via `_collectOutputTail`. */
  #pushOutputLine(pid: number, line: string): void {
    let ring = this._outputRings.get(pid);
    if (!ring) {
      ring = [];
      this._outputRings.set(pid, ring);
    }
    ring.push(line);
    while (ring.length > OUTPUT_RING_MAX) ring.shift();
  }

  /** Join the buffered stdout/stderr tail for a session and trim to
   *  `maxChars` characters (keeps the last slice — the bottom of a CLI's
   *  error output is almost always where the diagnostic lives). Returns an
   *  empty string when nothing was buffered. Safe to call after exit so
   *  long as `_clearOutputBuffer` hasn't run yet. */
  protected _collectOutputTail(pid: number, maxChars: number): string {
    const ring = this._outputRings.get(pid);
    if (!ring || ring.length === 0) return '';
    let body = ring.join('\n').trim();
    if (maxChars > 0 && body.length > maxChars) {
      body = '…' + body.slice(-maxChars);
    }
    return body;
  }

  /** Drop the buffered tail for `pid`. Called automatically after the
   *  subclass-visible `_onChildExit` hook so subclasses can read the tail
   *  before it's collected. */
  protected _clearOutputBuffer(pid: number): void {
    this._outputRings.delete(pid);
  }

  #wireExit(sess: SessionRecord): void {
    sess.child.once('exit', async (code, signal) => {
      if (sess.idleTimer) {
        clearTimeout(sess.idleTimer);
        sess.idleTimer = null;
      }
      this.#endTurn(sess);
      const durationSec = Math.round((Date.now() - sess.startedAt) / 1000);
      const key = sess[this.#keyField];
      sess.tap?.end({ exit_code: code, signal });
      log(
        `${this.#logTag} exit pid=${sess.pid} ${this.#keyField}=${key} code=${code} signal=${signal || '-'} turns=${sess.turnCount} duration=${durationSec}s`,
      );
      try {
        await this._onChildExit(sess, code, signal);
      } catch (err: any) {
        log(`${this.#logTag} _onChildExit error: ${err?.message ?? err}`);
      }
      // Drop the buffered output AFTER the subclass hook so a silent-exit
      // detector can read it; safe to no-op when the subclass already
      // cleared it.
      this._clearOutputBuffer(sess.pid);
      if (this._sessions.get(key) === sess) this._sessions.delete(key);
      if (sess.configPath && sess.configPathIsTemp) {
        try {
          await fsp.unlink(sess.configPath);
        } catch {
          /* best-effort */
        }
      }
      if (sess.pidPath) {
        try {
          await fsp.unlink(sess.pidPath);
        } catch {
          /* best-effort */
        }
      }
    });
    sess.child.once('error', (err: any) =>
      log(`${this.#logTag} child error pid=${sess.pid}: ${err?.message ?? err}`),
    );
  }

  protected _resetIdleTimer(sess: SessionRecord): void {
    if (sess.idleTimer) clearTimeout(sess.idleTimer);
    const mins = this._config.delegation.idleMinutes ?? 10;
    sess.idleTimer = setTimeout(
      () => {
        log(
          `${this.#logTag} idle, closing stdin ${this.#keyField}=${sess[this.#keyField]} pid=${sess.pid}`,
        );
        try {
          sess.child.stdin.end();
        } catch {
          /* already closed */
        }
      },
      mins * 60_000,
    );
    sess.idleTimer.unref?.();
  }

  /** Override in subclasses to react to each parsed stdout line. */
  protected _onStdoutParsed(_sess: SessionRecord, _parsed: ParseResult, _rawLine: string): void {}

  /** Override in subclasses to react to each stderr line. */
  protected _onStderrLine(_sess: SessionRecord, _line: string): void {}

  /** Override in subclasses to run logic when a child exits (before session
   *  record cleanup). Runs inside the exit handler — keep it fast. */
  protected async _onChildExit(
    _sess: SessionRecord,
    _code: number | null,
    _signal: NodeJS.Signals | null,
  ): Promise<void> {}

  #ensureHealthSweep(): void {
    if (this.#healthTimer) return;
    this.#healthTimer = setInterval(() => this.#healthSweep(), HEALTH_SWEEP_INTERVAL_MS);
    this.#healthTimer.unref?.();
  }

  #healthSweep(): void {
    const now = Date.now();
    for (const sess of this._sessions.values()) {
      if (sess.unhealthyKilled) continue;
      if (!sess.unrespondedSince) continue;
      const elapsed = now - sess.unrespondedSince;
      if (elapsed >= UNHEALTHY_DURATION_MS) {
        this.#killUnhealthy(sess, `${Math.round(elapsed / 60_000)}m elapsed without an LLM response`);
      }
    }
  }

  #killUnhealthy(sess: SessionRecord, reason: string): void {
    if (sess.unhealthyKilled) return;
    sess.unhealthyKilled = true;
    const key = sess[this.#keyField];
    log(
      `${this.#logTag} UNHEALTHY ${this.#keyField}=${key} pid=${sess.pid} — ${reason}; killing for respawn`,
    );
    if (this._sessions.get(key) === sess) this._sessions.delete(key);
    if (sess.idleTimer) {
      clearTimeout(sess.idleTimer);
      sess.idleTimer = null;
    }
    try {
      sess.child.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      process.kill(sess.pid, 'SIGTERM');
    } catch {
      /* already dead */
    }
    setTimeout(() => {
      try {
        process.kill(sess.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, STOP_GRACE_MS);
  }

  #evictLru(): boolean {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, s] of this._sessions.entries()) {
      if (s.lastTouchedAt < oldest) {
        oldest = s.lastTouchedAt;
        oldestKey = k;
      }
    }
    if (!oldestKey) return false;
    const s = this._sessions.get(oldestKey)!;
    log(`${this.#logTag} evicting lru ${this.#keyField}=${oldestKey} pid=${s.pid}`);
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
    try {
      s.child.stdin.end();
    } catch {
      /* already closed */
    }
    this._sessions.delete(oldestKey);
    return true;
  }

  protected _rememberDedup(key: string): boolean {
    if (this.#dedupSet.has(key)) return false;
    this.#dedupSet.add(key);
    this.#dedupQueue.push(key);
    while (this.#dedupQueue.length > this.#DEDUP_MAX) {
      const old = this.#dedupQueue.shift();
      if (old !== undefined) this.#dedupSet.delete(old);
    }
    return true;
  }

  protected _forgetDedup(key: string): void {
    if (!this.#dedupSet.delete(key)) return;
    const idx = this.#dedupQueue.indexOf(key);
    if (idx >= 0) this.#dedupQueue.splice(idx, 1);
  }

  /**
   * Force-terminate every live session owned by `agentId`. Used by
   * stop_agent / restart_agent so that a credential rotation actually
   * takes effect — a SessionRecord's child captured the per-agent
   * .credentials.json + env at spawn time, and would otherwise keep
   * authenticating with the stale credential until idle timeout or
   * maxTurns retired it on its own (10+ minutes). Without this,
   * pasting a fresh credential in AWB Admin → Credentials and
   * clicking restart_agent only refreshed disk artefacts; the running
   * child kept dispatching turns against the expired OAuth token.
   *
   * Caller-side cleanup (configPath/pidPath unlink, tap.end, _sessions
   * delete) lives in `#wireExit`; we only deliver the signals and let
   * the exit handler do the bookkeeping. SIGTERM first, then SIGKILL
   * after STOP_GRACE_MS for any survivor — same pattern as stop().
   * Returns the number of sessions that were signalled plus the in-flight
   * (ticketId, role) pairs they were holding, so restart_agent can re-push
   * the interrupted work on the fresh credential instead of waiting for the
   * server supervisor's stale sweep. Chat sessions carry no ticketId and so
   * contribute nothing to `inflight`.
   */
  async stopForAgent(
    agentId: string,
  ): Promise<{ count: number; inflight: Array<{ ticketId: string; role: string }> }> {
    if (!agentId) return { count: 0, inflight: [] };
    const victims = Array.from(this._sessions.values()).filter((s) => s.agentId === agentId);
    if (victims.length === 0) return { count: 0, inflight: [] };
    for (const sess of victims) {
      if (sess.idleTimer) {
        clearTimeout(sess.idleTimer);
        sess.idleTimer = null;
      }
      try {
        sess.child.stdin.end();
      } catch {
        /* already closed */
      }
      try {
        process.kill(sess.pid, 'SIGTERM');
      } catch {
        /* already dead */
      }
    }
    log(
      `${this.#logTag} stopForAgent: agent=${agentId.slice(0, 8)} signalled ${victims.length} session(s) — SIGTERM`,
    );
    setTimeout(() => {
      for (const sess of victims) {
        try {
          process.kill(sess.pid, 0);
          // Still alive — escalate.
          try {
            process.kill(sess.pid, 'SIGKILL');
          } catch {
            /* gone between probe and kill */
          }
        } catch {
          /* already exited; nothing to do */
        }
      }
    }, STOP_GRACE_MS).unref?.();
    const inflight = victims
      .filter((s) => s.ticketId)
      .map((s) => ({ ticketId: s.ticketId as string, role: (s.role as string) || '' }));
    return { count: victims.length, inflight };
  }

  async stop(): Promise<void> {
    if (this.#healthTimer) {
      clearInterval(this.#healthTimer);
      this.#healthTimer = null;
    }
    const sessions = Array.from(this._sessions.values());
    for (const sess of sessions) {
      if (sess.idleTimer) {
        clearTimeout(sess.idleTimer);
        sess.idleTimer = null;
      }
      try {
        sess.child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        process.kill(sess.pid, 'SIGTERM');
      } catch {
        /* dead */
      }
    }
    if (sessions.length === 0) {
      this._sessions.clear();
      return;
    }
    await new Promise((r) => setTimeout(r, STOP_GRACE_MS));
    for (const sess of sessions) {
      try {
        process.kill(sess.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    this._sessions.clear();
    log(`${this.constructor.name} stopped (terminated ${sessions.length} sessions)`);
  }
}
