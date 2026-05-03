// Shared lifecycle skeleton for persistent per-key CLI children.
// ChatSessionManager (key = roomId) and TicketSessionManager
// (key = `${ticketId}:${role}`) both extend this class.
//
// Parameterized by a CliAdapter — the adapter contributes everything that
// varies across CLIs (argv shape, stream-json formatting, line parsing).
// Sessions are only available when the adapter declares PERSISTENT_SESSION;
// _spawnSession() refuses to spawn for stateless adapters (gemini, …) so
// the manager can fail fast instead of leaving a half-broken child running.

import { promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { SUBAGENTS_BASE_DIR, STOP_GRACE_MS } from './constants.js';
import { log } from './logging.js';
import { createAdapter } from './cli-adapters/index.js';
import { ADAPTER_CAPABILITIES, PARSE_STAGE, type CliAdapter, type ParseResult } from './cli-adapters/base.js';
import type { AwbConfig } from './rest.js';
import type { SubagentMonitor, SubagentTapHandle } from './subagent-monitor.js';

const { PERSISTENT_SESSION } = ADAPTER_CAPABILITIES;

// Health watchdog. A session is "responding" when the adapter reports a
// `result` line for each turn we wrote. If the LLM goes silent, turns stack
// on stdin without acks and the AWB server keeps re-firing the same trigger
// forever. Two thresholds, OR'd together:
//   - 5 turns dispatched without seeing a single `result` line back
//   - 30 minutes elapsed since the first unresponded turn was written
const UNHEALTHY_TURN_THRESHOLD = 5;
const UNHEALTHY_DURATION_MS = 30 * 60 * 1000;
const HEALTH_SWEEP_INTERVAL_MS = 60 * 1000;

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
}

export interface SessionAwareConfig extends AwbConfig {
  delegation: SessionDelegationConfig;
}

export interface MonitorMeta {
  ticket_id?: string;
  ticket_title?: string;
  role?: string;
}

export interface SpawnOpts {
  onProgress?: (stage: string) => void;
  monitorMeta?: MonitorMeta;
  /**
   * ST-6: per-call managed-agent runtime context. When provided, the
   * spawned CLI runs with cwd=ctx.cwd, MCP auth = ctx.api_key, reuses
   * ctx.mcp_config_path instead of a freshly-written temp config, and
   * (ST-7) picks the adapter for ctx.cli — claude / codex / gemini.
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
  };
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
}

export class BaseSessionManager {
  protected readonly _config: SessionAwareConfig;
  /** ST-7: per-cliType adapter cache. Same scheme as SubagentManager —
   *  one createAdapter() per cli over the manager's lifetime. */
  #adapters = new Map<string, CliAdapter>();
  protected readonly _sessions = new Map<string, SessionRecord>();
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

  protected _ensureCapacity(): boolean {
    const cap = this._config.delegation.maxConcurrent ?? 5;
    if (this._sessions.size < cap) return true;
    return this.#evictLru();
  }

  protected async _spawnSession(
    sessionKey: string,
    rolePrompt: string,
    firstTurnText: string,
    { onProgress, monitorMeta, agentContext }: SpawnOpts = {},
  ): Promise<SessionRecord | null> {
    // ST-7: pick the adapter for this agent's CLI choice (claude/codex/gemini)
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
      // caused codex / gemini spawns to launch the literal "claude" bin
      // (resolver short-circuits on `configured`, returning it verbatim).
      const binOverride =
        adapter.cliType === 'claude' ? this._config.delegation.claudeBin : null;
      const resolvedBin = adapter.resolveBin(binOverride);
      // ST-7 follow-up: per-agent CLI home isolation (see SubagentManager).
      const cliHomeEnvKey = adapter.configDirEnv();
      const cliHomeEnv = cliHomeEnvKey && agentContext?.cli_home_dir
        ? { [cliHomeEnvKey]: agentContext.cli_home_dir }
        : {};
      const child = spawn(resolvedBin, descriptor.args, {
        stdio: descriptor.stdio || ['pipe', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
        cwd: effectiveCwd,
        env: { ...process.env, AWB_API_KEY: effectiveApiKey, ...cliHomeEnv },
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

      log(
        `Subagent spawned: pid=${sess.pid} cli=${adapter.cliType} kind=${this.#kindLabel} ${this.#keyField}=${sessionKey}`,
      );

      this.#startTurn(sess, onProgress);
      this._writeTurn(sess, firstTurnText);
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
    }: { checkMaxTurns?: boolean; onProgress?: (stage: string) => void } = {},
  ): void {
    this.#startTurn(sess, onProgress);
    this._writeTurn(sess, turnText);
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

  protected _writeTurn(sess: SessionRecord, text: string): void {
    const wire = sess.adapter.formatTurn(String(text));
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
        this.#advanceTurn(sess, parsed);
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
      rlErr.on('line', (line) => log(`[${tag}:${sess.pid}:err] ${line}`));
    }
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
