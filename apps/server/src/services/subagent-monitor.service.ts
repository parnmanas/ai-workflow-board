import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, LessThan } from 'typeorm';
import { Subagent } from '../entities/Subagent';
import { SubagentLogLine } from '../entities/SubagentLogLine';
import { activityEvents } from './activity.service';
import { LogService } from './log.service';
import { MemoryMetricsRegistry } from './memory-metrics.registry';

/**
 * Persistent registry + live transcript bus for plugin-spawned subagents.
 *
 * The plugin posts (a) a registration when it spawns a Claude CLI subagent,
 * (b) every stream-json line in/out, (c) an end record when the process exits,
 * and (d) a periodic reconcile call listing the subagent_ids it currently has
 * alive. End and reconcile-driven termination both stamp expires_at = now +
 * retentionMs; the sweep DELETEs rows past expires_at and the FK CASCADE drops
 * the associated log lines.
 *
 * Why DB-backed (was in-memory):
 *   - Survives server restarts, so the UI keeps the transcript while the
 *     plugin process is still alive.
 *   - Reconcile path closes the gap left by plugin crashes: previously a
 *     half-finished run sat in memory until the proxy restarted; now it is
 *     marked ended on the next reconcile tick and reaped 48h later.
 */

export type SubagentKind = 'chat' | 'ticket' | 'oneshot';

export interface SubagentSummary {
  subagent_id: string;
  agent_id: string;
  workspace_id: string;
  kind: SubagentKind;
  session_key: string;
  pid: number;
  started_at: string;
  label?: string;
  ended_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  duration_ms?: number;
  line_count: number;
  // ISO-8601 timestamp at which the ended record will be purged by the sweep.
  // Only set once `ended_at` is set; undefined while the subagent is live.
  expires_at?: string;
  // Ticket-kind subagents carry both fields so the UI can render
  // "Ticket title · reviewer" instead of an opaque session key. Optional
  // because chat/oneshot subagents leave them undefined.
  ticket_id?: string;
  ticket_title?: string;
  role?: string;
}

export interface SubagentLogLineDto {
  direction: 'in' | 'out';
  line: string;
  ts: string;
}

// Token/cost usage the agent-manager reports on the `end` POST (ticket
// 6dd3f968). All fields optional/nullable — a pre-6dd3f968 manager build
// sends no `usage` key at all, and even an instrumented run may not have a
// figure for every field (Codex has no cost concept; Antigravity has none of
// this at all). Every numeric field is independently nullable so aggregation
// can tell "the CLI reported zero" apart from "never instrumented".
export interface SubagentEndUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  total_cost_usd?: number | null;
  model?: string | null;
}

// Sanity ceilings for a single run's reported usage — generous enough for any
// legitimate long multi-turn session, but tight enough to reject a corrupt/
// adversarial payload before it poisons a SUM aggregate. A negative value or
// one past the ceiling is treated as "not reported" (null) rather than
// clamped-and-kept, since a value this implausible carries no useful signal.
const MAX_TOKEN_COUNT = 50_000_000;
const MAX_COST_USD = 1000;
const MAX_MODEL_LEN = 100;

const DEFAULT_ENDED_RETENTION_HOURS = 48;
function endedRetentionMs(): number {
  const raw = process.env.SUBAGENT_ENDED_RETENTION_HOURS;
  const hours = raw ? Number(raw) : DEFAULT_ENDED_RETENTION_HOURS;
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_ENDED_RETENTION_HOURS * 3_600_000;
  return hours * 3_600_000;
}

@Injectable()
export class SubagentMonitorService {
  private readonly retentionMs = endedRetentionMs();
  // appendLines runs `read line_count → INSERT N lines → UPDATE line_count`,
  // which is racy if two appends for the same subagent overlap. Plugin posts
  // are serialized per subagent today (one-shot taps and session managers
  // each flush behind a single batch timer), but the chain guards against a
  // future change shipping concurrent posts and corrupting `seq`.
  private readonly appendLocks = new Map<string, Promise<unknown>>();

  constructor(
    @InjectRepository(Subagent) private readonly subagents: Repository<Subagent>,
    @InjectRepository(SubagentLogLine) private readonly lines: Repository<SubagentLogLine>,
    private readonly logService: LogService,
    metrics: MemoryMetricsRegistry,
  ) {
    // appendLocks is the highest-churn in-memory map in this service: one
    // transient entry per (concurrently-appending) subagentId. With the
    // _serialize self-eviction working it should sit at ~0 at rest; a
    // non-zero steady-state reading on /api/diagnostics/memory is the early
    // warning that the eviction guard regressed again (see the dead-guard
    // leak fixed for ticket 59090d37).
    metrics.register('subagent.appendLocks', () => this.appendLocks.size);
    setInterval(() => {
      this._sweepEnded().catch((err) =>
        this.logService.warn('SubagentMonitor', `sweep failed: ${err.message}`),
      );
    }, 5 * 60_000).unref?.();
  }

  async register(input: {
    subagent_id: string;
    agent_id: string;
    workspace_id: string;
    kind: SubagentKind;
    session_key: string;
    pid: number;
    started_at?: string;
    label?: string;
    ticket_id?: string;
    ticket_title?: string;
    role?: string;
  }): Promise<SubagentSummary> {
    const startedAt = input.started_at ? new Date(input.started_at) : new Date();
    // Re-register of an existing id is a no-op for idempotency: the plugin
    // POSTs `register` fire-and-forget, and a transient retry must not
    // overwrite line_count / ended_at on a record that has been making
    // progress in the meantime.
    const existing = await this.subagents.findOne({ where: { subagent_id: input.subagent_id } });
    if (existing) {
      return this._summary(existing);
    }
    const row = this.subagents.create({
      subagent_id: input.subagent_id,
      agent_id: input.agent_id,
      workspace_id: input.workspace_id,
      kind: input.kind,
      session_key: input.session_key || '',
      pid: input.pid || 0,
      started_at: startedAt,
      label: input.label ?? null,
      ticket_id: input.ticket_id ?? null,
      ticket_title: input.ticket_title ?? null,
      role: input.role ?? null,
      ended_at: null,
      exit_code: null,
      signal: null,
      duration_ms: null,
      expires_at: null,
      line_count: 0,
    });
    await this.subagents.save(row);
    const summary = this._summary(row);
    activityEvents.emit('subagent_registered', { ...summary });
    this.logService.info(
      'SubagentMonitor',
      `registered ${row.kind} subagent ${row.subagent_id} for agent ${row.agent_id} (${row.session_key})`,
    );
    return summary;
  }

  async appendLines(
    subagentId: string,
    expectedAgentId: string,
    incoming: Array<{ direction: 'in' | 'out'; line: string; ts?: string }>,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!incoming || incoming.length === 0) return { ok: true };
    const run = async () => {
      const rec = await this.subagents.findOne({ where: { subagent_id: subagentId } });
      if (!rec) return { ok: false as const, reason: 'unknown subagent_id' };
      if (rec.agent_id !== expectedAgentId) return { ok: false as const, reason: 'agent mismatch' };

      const baseSeq = rec.line_count;
      const rows: SubagentLogLine[] = [];
      const events: Array<{ direction: 'in' | 'out'; line: string; ts: string }> = [];
      let i = 0;
      for (const entry of incoming) {
        const ts = entry.ts ? new Date(entry.ts) : new Date();
        rows.push(this.lines.create({
          subagent_id: rec.subagent_id,
          seq: baseSeq + i + 1,
          direction: entry.direction,
          line: entry.line,
          ts,
        }));
        events.push({ direction: entry.direction, line: entry.line, ts: ts.toISOString() });
        i++;
      }
      await this.lines.save(rows);
      rec.line_count = baseSeq + rows.length;
      await this.subagents.update({ subagent_id: rec.subagent_id }, { line_count: rec.line_count });

      for (const evt of events) {
        activityEvents.emit('subagent_log', {
          subagent_id: rec.subagent_id,
          agent_id: rec.agent_id,
          workspace_id: rec.workspace_id,
          direction: evt.direction,
          line: evt.line,
          ts: evt.ts,
        });
      }
      return { ok: true as const };
    };
    return this._serialize(subagentId, run);
  }

  async end(input: {
    subagent_id: string;
    agent_id: string;
    exit_code?: number | null;
    signal?: string | null;
    usage?: SubagentEndUsage | null;
  }): Promise<{ ok: boolean; reason?: string }> {
    const rec = await this.subagents.findOne({ where: { subagent_id: input.subagent_id } });
    if (!rec) return { ok: false, reason: 'unknown subagent_id' };
    if (rec.agent_id !== input.agent_id) return { ok: false, reason: 'agent mismatch' };
    if (rec.ended_at) return { ok: true }; // idempotent — usage from a resend is dropped, same as exit_code/signal

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - new Date(rec.started_at).getTime();
    const expiresAt = new Date(endedAt.getTime() + this.retentionMs);
    const usage = this._sanitizeUsage(input.usage);
    rec.ended_at = endedAt;
    rec.exit_code = input.exit_code ?? null;
    rec.signal = input.signal ?? null;
    rec.duration_ms = durationMs;
    rec.expires_at = expiresAt;
    Object.assign(rec, usage);
    await this.subagents.update(
      { subagent_id: rec.subagent_id },
      {
        ended_at: endedAt,
        exit_code: rec.exit_code,
        signal: rec.signal,
        duration_ms: durationMs,
        expires_at: expiresAt,
        ...usage,
      },
    );
    activityEvents.emit('subagent_ended', {
      subagent_id: rec.subagent_id,
      agent_id: rec.agent_id,
      workspace_id: rec.workspace_id,
      exit_code: rec.exit_code,
      signal: rec.signal,
      duration_ms: durationMs,
      ended_at: endedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
    return { ok: true };
  }

  /**
   * Plugin reports the full set of subagent_ids it currently has alive. Any
   * record we have for this agent that isn't in that set — and isn't already
   * ended — gets stamped ended with signal='disappeared'. The 48h retention
   * countdown begins from this moment, so the row is reaped on a later sweep.
   *
   * Empty live_subagent_ids is the post-restart case: plugin lost its tap
   * registry and reports zero, server marks every previously-registered live
   * record for that agent as disappeared.
   */
  async reconcile(agentId: string, liveSubagentIds: string[]): Promise<{ ended: number }> {
    const live = new Set(liveSubagentIds.filter((s): s is string => typeof s === 'string' && s.length > 0));
    // Pull only live records (ended_at IS NULL) for this agent so reconcile
    // doesn't churn through long-retained ended history.
    const candidates = await this.subagents.find({
      where: { agent_id: agentId, ended_at: IsNull() },
    });
    const stale = candidates.filter((c) => !live.has(c.subagent_id));
    if (stale.length === 0) return { ended: 0 };

    const endedAt = new Date();
    const expiresAt = new Date(endedAt.getTime() + this.retentionMs);
    for (const rec of stale) {
      const durationMs = endedAt.getTime() - new Date(rec.started_at).getTime();
      await this.subagents.update(
        { subagent_id: rec.subagent_id },
        {
          ended_at: endedAt,
          signal: 'disappeared',
          duration_ms: durationMs,
          expires_at: expiresAt,
        },
      );
      activityEvents.emit('subagent_ended', {
        subagent_id: rec.subagent_id,
        agent_id: rec.agent_id,
        workspace_id: rec.workspace_id,
        exit_code: null,
        signal: 'disappeared',
        duration_ms: durationMs,
        ended_at: endedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      });
    }
    this.logService.info(
      'SubagentMonitor',
      `reconcile: ${stale.length} stale subagent(s) marked disappeared for agent=${agentId}`,
    );
    return { ended: stale.length };
  }

  /** All current records (active + recently-ended) for a workspace. */
  async listForWorkspace(workspaceId: string): Promise<SubagentSummary[]> {
    const rows = await this.subagents.find({
      where: { workspace_id: workspaceId },
      order: { started_at: 'DESC' },
    });
    return rows.map((r) => this._summary(r));
  }

  async getTranscript(
    subagentId: string,
    workspaceId: string,
  ): Promise<{ summary: SubagentSummary; lines: SubagentLogLineDto[] } | null> {
    const rec = await this.subagents.findOne({ where: { subagent_id: subagentId } });
    if (!rec || rec.workspace_id !== workspaceId) return null;
    const lineRows = await this.lines.find({
      where: { subagent_id: subagentId },
      order: { seq: 'ASC' },
    });
    const lines = lineRows.map((l) => ({
      direction: l.direction as 'in' | 'out',
      line: l.line,
      ts: l.ts.toISOString(),
    }));
    return { summary: this._summary(rec), lines };
  }

  /**
   * Validate + clamp the optional `usage` block on an `end` POST (ticket
   * 6dd3f968) into the exact Subagent column shape. A malformed/out-of-range
   * value is dropped to null rather than clamped-and-kept — a bad reading is
   * not a useful lower/upper bound once it's this implausible. Never throws;
   * an adversarial or buggy payload degrades to "not reported", same as an
   * older manager build that sends no `usage` key at all.
   */
  private _sanitizeUsage(usage: SubagentEndUsage | null | undefined): {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
    total_cost_usd: number | null;
    usage_model: string | null;
  } {
    const count = (v: unknown): number | null => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_TOKEN_COUNT) return null;
      return Math.round(v);
    };
    const cost = (v: unknown): number | null => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_COST_USD) return null;
      return v;
    };
    const model = (v: unknown): string | null => {
      if (typeof v !== 'string') return null;
      const trimmed = v.trim();
      if (!trimmed) return null;
      return trimmed.length > MAX_MODEL_LEN ? trimmed.slice(0, MAX_MODEL_LEN) : trimmed;
    };
    return {
      input_tokens: count(usage?.input_tokens),
      output_tokens: count(usage?.output_tokens),
      cache_read_input_tokens: count(usage?.cache_read_input_tokens),
      cache_creation_input_tokens: count(usage?.cache_creation_input_tokens),
      total_cost_usd: cost(usage?.total_cost_usd),
      usage_model: model(usage?.model),
    };
  }

  private _summary(r: Subagent): SubagentSummary {
    return {
      subagent_id: r.subagent_id,
      agent_id: r.agent_id,
      workspace_id: r.workspace_id,
      kind: r.kind as SubagentKind,
      session_key: r.session_key || '',
      pid: r.pid,
      started_at: r.started_at.toISOString(),
      label: r.label ?? undefined,
      ended_at: r.ended_at ? r.ended_at.toISOString() : undefined,
      exit_code: r.exit_code,
      signal: r.signal,
      duration_ms: r.duration_ms ?? undefined,
      line_count: r.line_count,
      expires_at: r.expires_at ? r.expires_at.toISOString() : undefined,
      ticket_id: r.ticket_id ?? undefined,
      ticket_title: r.ticket_title ?? undefined,
      role: r.role ?? undefined,
    };
  }

  private async _serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.appendLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    // The value stored under `key` is the CHAINED promise (prior → next), not
    // `next` itself — the next caller awaits this chain so its run starts only
    // after ours releases, preserving per-subagent serialization. Cleanup must
    // therefore compare against `chained`: the previous code compared the map
    // head against `next`, which is never the stored value, so the guard was
    // dead and every subagentId left a permanent entry (prod OOM, ticket
    // 59090d37). Keep both bindings identical.
    const chained = prior.then(() => next);
    this.appendLocks.set(key, chained);
    try {
      await prior;
      return await fn();
    } finally {
      release();
      // Best-effort cleanup so the map doesn't grow unboundedly with finished
      // subagents. Only delete if the head is still ours — a later overlapping
      // append for the same key will have replaced it, and that caller owns
      // the eviction.
      if (this.appendLocks.get(key) === chained) this.appendLocks.delete(key);
    }
  }

  private async _sweepEnded() {
    const now = new Date();
    // Filter expires_at < now in SQL so we don't fan a full-table read into
    // app memory on every tick. expires_at is null for live records, so the
    // index hit only touches reaped/ended ones.
    const stale = await this.subagents.find({
      where: { expires_at: LessThan(now) },
      select: ['subagent_id'],
    });
    if (stale.length === 0) return;
    const ids = stale.map((r) => r.subagent_id);
    // Lines first so the row delete doesn't trip a deferred FK on databases
    // where the CASCADE rule lags behind a freshly-synchronized schema.
    // SQLite/Postgres both honor `onDelete: 'CASCADE'` once the FK is in
    // place; the explicit delete keeps the sweep correct in either state.
    await this.lines.delete({ subagent_id: In(ids) });
    await this.subagents.delete({ subagent_id: In(ids) });
    this.logService.info('SubagentMonitor', `sweep: deleted ${ids.length} expired subagent record(s)`);
  }
}
