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
  #liveIds = new Set<string>();
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
    this.#liveIds.add(subagentId);

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
    this.#post('/api/agent-subagents', body).catch(() => {});

    return new SubagentTap(this, subagentId, startedAt);
  }

  async _flushLines(
    subagentId: string,
    lines: Array<{ direction: 'in' | 'out'; line: string; ts: string }>,
  ): Promise<PostResult> {
    if (!this.#enabled || !lines.length) return 'ok';
    return this.#post(`/api/agent-subagents/${encodeURIComponent(subagentId)}/lines`, { lines });
  }

  async _end(
    subagentId: string,
    info: { exit_code?: number | null; signal?: NodeJS.Signals | null } | null | undefined,
  ): Promise<PostResult> {
    if (!this.#enabled) return 'ok';
    this.#liveIds.delete(subagentId);
    return this.#post(`/api/agent-subagents/${encodeURIComponent(subagentId)}/end`, info || {});
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
    const ids = Array.from(this.#liveIds);
    await this.#post('/api/agent-subagents/reconcile', { live_subagent_ids: ids });
  }

  async #post(path: string, body: unknown): Promise<PostResult> {
    try {
      const url = `${this.#config.url.replace(/\/$/, '')}${path}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Agent-Key': this.#config.apiKey,
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
