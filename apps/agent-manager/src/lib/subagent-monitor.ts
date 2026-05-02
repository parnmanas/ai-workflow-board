// Subagent monitor client — tracks every subagent spawned by this manager
// and reports its stream-json traffic to the AWB server so the web UI can
// render a live transcript across every agent machine.
//
// Pattern: each spawn site calls `register(...)` with a unique subagent_id
// and metadata; that returns a Tap whose inLine/outLine batches the lines
// (200 ms or 50 lines) and POSTs them to /api/agent-subagents/:id/lines so
// we don't hammer the server with one POST per token. Failures are logged
// but never thrown — a degraded monitor must NEVER block the actual
// subagent traffic.
//
// Reconcile loop reports the live subagent_id list every 5 minutes so the
// server can mark any record NOT in the list as ended (signal='disappeared')
// — that's the only path that cleans up records left behind by manager
// crashes or lost taps.

import { randomUUID } from 'node:crypto';
import { REQUEST_TIMEOUT_MS } from './constants.js';
import { log } from './logging.js';
import type { AwbConfig } from './rest.js';

const FLUSH_INTERVAL_MS = 200;
const FLUSH_LINE_THRESHOLD = 50;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const RECONCILE_INITIAL_DELAY_MS = 5_000;

export interface SubagentMonitorConfig extends AwbConfig {
  subagent_monitor?: { enabled?: boolean };
}

export interface SubagentRegisterArgs {
  kind: 'oneshot' | 'chat' | 'ticket';
  sessionKey?: string;
  pid?: number;
  label?: string;
  ticketId?: string;
  ticketTitle?: string;
  role?: string;
  /** Per-call apiKey override. When set, the registration POST and all
   *  follow-up lines/end/reconcile calls for this subagent authenticate as
   *  this agent (typically the managed agent the subagent is running for),
   *  so the server attributes the subagent to it instead of the manager.
   *  Defaults to the manager's own apiKey. */
  apiKey?: string;
}

export interface SubagentTapHandle {
  inLine(line: string): void;
  outLine(line: string): void;
  end(info?: { exit_code?: number | null; signal?: NodeJS.Signals | null }): Promise<void> | void;
  readonly subagentId: string | null;
  readonly startedAt: string;
}

type PostResult = 'ok' | 'dead' | 'transient';

export class SubagentMonitor {
  #config: SubagentMonitorConfig;
  #workspaceId: string | null;
  #enabled: boolean;
  // Live subagent_ids partitioned by the apiKey they were registered under.
  // Each partition reconciles independently against the server because the
  // /reconcile endpoint scopes to whatever agent the apiKey resolves to —
  // a manager-key reconcile would only ever see manager-attributed
  // subagents, never the managed-agent ones.
  #liveIdsByKey = new Map<string, Set<string>>();
  // Per-subagent apiKey lookup so SubagentTap.flush/end and stream-of-record
  // reconcile use the same identity the register call used. Set on register,
  // dropped on end/dead.
  #apiKeyForSubagent = new Map<string, string>();
  #reconcileTimer: NodeJS.Timeout | null = null;
  #reconcileInitialTimer: NodeJS.Timeout | null = null;

  constructor(config: SubagentMonitorConfig, workspaceId: string | null) {
    this.#config = config;
    this.#workspaceId = workspaceId || null;
    this.#enabled = this.#config?.subagent_monitor?.enabled !== false;
    if (this.#enabled) {
      log(
        `[subagent-monitor] enabled (workspace=${
          this.#workspaceId ? this.#workspaceId.slice(0, 8) + '...' : 'auto-bind via api key'
        })`,
      );
      this.#startReconcileLoop();
    } else {
      log('[subagent-monitor] disabled (config.subagent_monitor.enabled=false)');
    }
  }

  register(args: SubagentRegisterArgs): SubagentTapHandle {
    if (!this.#enabled) return makeNoopTap();
    const subagentId = randomUUID();
    const startedAt = new Date().toISOString();
    const apiKey = args.apiKey || this.#config.apiKey;
    let bucket = this.#liveIdsByKey.get(apiKey);
    if (!bucket) {
      bucket = new Set<string>();
      this.#liveIdsByKey.set(apiKey, bucket);
    }
    bucket.add(subagentId);
    this.#apiKeyForSubagent.set(subagentId, apiKey);

    const body: Record<string, unknown> = {
      subagent_id: subagentId,
      kind: args.kind,
      session_key: args.sessionKey || '',
      pid: args.pid || 0,
      started_at: startedAt,
      label: args.label,
    };
    if (this.#workspaceId) body.workspace_id = this.#workspaceId;
    if (args.ticketId) body.ticket_id = args.ticketId;
    if (args.ticketTitle) body.ticket_title = args.ticketTitle;
    if (args.role) body.role = args.role;
    this.#post('/api/agent-subagents', body, apiKey).catch(() => {});

    return new SubagentTap(this, subagentId, startedAt);
  }

  async _flushLines(
    subagentId: string,
    lines: Array<{ direction: 'in' | 'out'; line: string; ts: string }>,
  ): Promise<PostResult> {
    if (!this.#enabled || !lines.length) return 'ok';
    const apiKey = this.#apiKeyForSubagent.get(subagentId) || this.#config.apiKey;
    return this.#post(
      `/api/agent-subagents/${encodeURIComponent(subagentId)}/lines`,
      { lines },
      apiKey,
    );
  }

  async _end(
    subagentId: string,
    info: { exit_code?: number | null; signal?: NodeJS.Signals | null } | null | undefined,
  ): Promise<PostResult> {
    if (!this.#enabled) return 'ok';
    const apiKey = this.#apiKeyForSubagent.get(subagentId) || this.#config.apiKey;
    const bucket = this.#liveIdsByKey.get(apiKey);
    if (bucket) {
      bucket.delete(subagentId);
      if (bucket.size === 0) this.#liveIdsByKey.delete(apiKey);
    }
    this.#apiKeyForSubagent.delete(subagentId);
    return this.#post(
      `/api/agent-subagents/${encodeURIComponent(subagentId)}/end`,
      info || {},
      apiKey,
    );
  }

  stop(): void {
    if (this.#reconcileTimer) {
      clearInterval(this.#reconcileTimer);
      this.#reconcileTimer = null;
    }
    if (this.#reconcileInitialTimer) {
      clearTimeout(this.#reconcileInitialTimer);
      this.#reconcileInitialTimer = null;
    }
  }

  #startReconcileLoop(): void {
    this.#reconcileInitialTimer = setTimeout(() => {
      this.#reportLiveList().catch((err: any) =>
        log(`[subagent-monitor] initial reconcile failed: ${err?.message ?? err}`),
      );
    }, RECONCILE_INITIAL_DELAY_MS);
    this.#reconcileInitialTimer.unref?.();
    this.#reconcileTimer = setInterval(() => {
      this.#reportLiveList().catch((err: any) =>
        log(`[subagent-monitor] reconcile failed: ${err?.message ?? err}`),
      );
    }, RECONCILE_INTERVAL_MS);
    this.#reconcileTimer.unref?.();
  }

  async #reportLiveList(): Promise<void> {
    // Reconcile per apiKey — server scopes /reconcile to whatever agent the
    // caller's apiKey resolves to, so we can't dump every subagent_id under
    // the manager's identity (the server would mark managed-agent
    // attributed ones as ended). Always include the manager's own bucket
    // even when empty so the server can still mark stale manager-side
    // entries as disappeared after a manager crash.
    const buckets = new Map<string, string[]>();
    if (!this.#liveIdsByKey.has(this.#config.apiKey)) {
      buckets.set(this.#config.apiKey, []);
    }
    for (const [apiKey, ids] of this.#liveIdsByKey) {
      buckets.set(apiKey, Array.from(ids));
    }
    for (const [apiKey, ids] of buckets) {
      await this.#post(
        '/api/agent-subagents/reconcile',
        { live_subagent_ids: ids },
        apiKey,
      );
    }
  }

  async #post(path: string, body: unknown, apiKey?: string): Promise<PostResult> {
    try {
      const url = `${this.#config.url.replace(/\/$/, '')}${path}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Agent-Key': apiKey || this.#config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (resp.status >= 400 && resp.status < 500) return 'dead';
      if (!resp.ok) return 'transient';
      return 'ok';
    } catch (err: any) {
      log(`[subagent-monitor] POST ${path} failed: ${err?.message ?? err}`);
      return 'transient';
    }
  }
}

class SubagentTap implements SubagentTapHandle {
  #monitor: SubagentMonitor;
  #subagentId: string;
  #buffer: Array<{ direction: 'in' | 'out'; line: string; ts: string }> = [];
  #flushTimer: NodeJS.Timeout | null = null;
  #ended = false;
  #dead = false;
  startedAt: string;

  constructor(monitor: SubagentMonitor, subagentId: string, startedAt: string) {
    this.#monitor = monitor;
    this.#subagentId = subagentId;
    this.startedAt = startedAt;
  }

  get subagentId(): string {
    return this.#subagentId;
  }

  inLine(line: string): void {
    this.#append('in', line);
  }
  outLine(line: string): void {
    this.#append('out', line);
  }

  #append(direction: 'in' | 'out', line: string): void {
    if (this.#ended || this.#dead || !line) return;
    this.#buffer.push({ direction, line, ts: new Date().toISOString() });
    if (this.#buffer.length >= FLUSH_LINE_THRESHOLD) {
      this.#flushNow();
    } else if (!this.#flushTimer) {
      this.#flushTimer = setTimeout(() => this.#flushNow(), FLUSH_INTERVAL_MS);
    }
  }

  #flushNow(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#dead) {
      this.#buffer = [];
      return;
    }
    const batch = this.#buffer.splice(0);
    if (!batch.length) return;
    this.#monitor
      ._flushLines(this.#subagentId, batch)
      .then((result) => {
        if (result === 'dead') this.#markDead();
      })
      .catch(() => {});
  }

  #markDead(): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#buffer = [];
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    log(
      `[subagent-monitor] tap ${this.#subagentId} marked dead — server doesn't recognize it, dropping further lines`,
    );
  }

  async end(info?: { exit_code?: number | null; signal?: NodeJS.Signals | null }): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    this.#flushNow();
    setTimeout(() => {
      if (this.#dead) return;
      this.#monitor
        ._end(this.#subagentId, info)
        .then((result) => {
          if (result === 'dead') this.#markDead();
        })
        .catch(() => {});
    }, 50);
  }
}

function makeNoopTap(): SubagentTapHandle {
  const startedAt = new Date().toISOString();
  return {
    inLine(): void {},
    outLine(): void {},
    async end(): Promise<void> {},
    get subagentId(): string | null {
      return null;
    },
    startedAt,
  };
}
