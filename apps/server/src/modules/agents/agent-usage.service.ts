/**
 * AgentUsageService — token/cost usage observability (ticket 6dd3f968).
 *
 * Reads the `subagents` table's usage columns (populated by the
 * agent-manager's `end` POST — see SubagentMonitorService.end /
 * Subagent.ts) and aggregates them into a windowed dashboard rollup.
 *
 * Windowing, not all-time: ended Subagent rows are reaped after
 * SUBAGENT_ENDED_RETENTION_HOURS (default 48h — subagent-monitor.service.ts),
 * so any window here MUST stay comfortably under that retention or the
 * aggregate would silently lose rows mid-window. Default 24h.
 *
 * Coverage is intentionally exposed, not hidden: Antigravity (and any custom/
 * pre-6dd3f968 manager build) never reports usage, and only Claude-family
 * runs report a real `total_cost_usd` (Codex has no cost concept; DeepSeek's
 * would-be Anthropic-priced figure is deliberately nulled by the adapter —
 * see deepseek.ts). `avg_cost_per_run_usd_priced_only` and
 * `estimated_saved_usd` are therefore both a LOWER BOUND, never a full
 * cross-CLI total — the dashboard tile must label them as such.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Subagent } from '../../entities/Subagent';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_TOP_TICKETS_LIMIT = 5;

// The 3 suppression event kinds a repeated-dispatch storm produces (ticket
// 3970db66's getSuppressionStats reads the same 3, but lifetime-cumulative —
// this needs a WINDOWED count to pair with a windowed avg-cost, so it's a
// separate query rather than a reuse of that method).
const SUPPRESSION_ACTIONS = [
  'respawn_storm_halted',
  'respawn_twin_detected',
  'comment_pingpong_suppressed',
] as const;

function readWindowHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_USAGE_WINDOW_HOURS;
  const hours = raw ? Number(raw) : DEFAULT_WINDOW_HOURS;
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_WINDOW_HOURS;
}

/** pg returns SUM/COUNT over integer-family columns as a STRING (bigint
 *  precision safety) while sql.js returns a plain number — coerce uniformly.
 *  NULL (no rows matched) → 0, since every stat here is a "total so far". */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface TicketUsageBreakdown {
  ticket_id: string;
  ticket_title: string;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
  runs: number;
}

export interface TokenUsageStats {
  window_minutes: number;
  // "instrumented" coverage — runs_with_usage counts rows where extractUsage
  // produced ANY snapshot (input_tokens is the proxy: both Claude and Codex
  // populate it together with the rest of their snapshot). runs_total counts
  // every dispatch attempt in the window regardless of instrumentation.
  coverage: { runs_with_usage: number; runs_total: number };
  totals: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    total_cost_usd: number;
  };
  // Runs where the CLI itself reported a dollar cost (Claude-family only,
  // DeepSeek excluded — see module docstring). The denominator for
  // avg_cost_per_run_usd_priced_only, so a window with zero priced runs
  // yields null rather than a division by zero.
  priced_runs: number;
  avg_cost_per_run_usd_priced_only: number | null;
  top_tickets: TicketUsageBreakdown[];
  suppressed_attempts_in_window: number;
  // avg_cost_per_run_usd_priced_only * suppressed_attempts_in_window — a
  // conservative estimate (suppressed attempts never actually spawned a CLI,
  // so there is no real per-attempt cost to sum; this is "what an average
  // instrumented run costs" applied to "how many attempts were suppressed").
  // null whenever avg_cost_per_run_usd_priced_only is null (no priced runs to
  // estimate from) — never silently rendered as 0.
  estimated_saved_usd: number | null;
}

@Injectable()
export class AgentUsageService {
  private readonly windowMs = readWindowHours() * 3_600_000;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async getTokenUsageStats(
    opts: { windowMs?: number; now?: Date; topTicketsLimit?: number; boardId?: string } = {},
  ): Promise<TokenUsageStats> {
    const now = opts.now ?? new Date();
    const windowMs = opts.windowMs ?? this.windowMs;
    const since = new Date(now.getTime() - windowMs);
    const limit = opts.topTicketsLimit ?? DEFAULT_TOP_TICKETS_LIMIT;

    // `boardId` scoping mirrors RespawnStormDetectorService.getWorkflowHealth's
    // scopedColIds pattern (ticket → column → board), resolved once up front —
    // null = unscoped (workspace-wide); [] = the board has zero tickets right
    // now, so every query below is answered without touching Subagent/
    // ActivityLog at all (an empty array in a SQL IN(...) is invalid/always-
    // false depending on dialect, so this is special-cased rather than passed
    // through).
    const scopedTicketIds = await this._resolveScopedTicketIds(opts.boardId);
    if (scopedTicketIds && scopedTicketIds.length === 0) {
      return {
        window_minutes: Math.round(windowMs / 60_000),
        coverage: { runs_with_usage: 0, runs_total: 0 },
        totals: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 },
        priced_runs: 0,
        avg_cost_per_run_usd_priced_only: null,
        top_tickets: [],
        suppressed_attempts_in_window: 0,
        estimated_saved_usd: null,
      };
    }

    const subRepo = this.dataSource.getRepository(Subagent);

    const totalsQb = subRepo
      .createQueryBuilder('s')
      .select('COUNT(*)', 'runs_total')
      .addSelect('COUNT(s.input_tokens)', 'runs_with_usage')
      .addSelect('COUNT(s.total_cost_usd)', 'priced_runs')
      .addSelect('COALESCE(SUM(s.input_tokens), 0)', 'input_tokens')
      .addSelect('COALESCE(SUM(s.output_tokens), 0)', 'output_tokens')
      .addSelect('COALESCE(SUM(s.cache_read_input_tokens), 0)', 'cache_read_input_tokens')
      .addSelect('COALESCE(SUM(s.cache_creation_input_tokens), 0)', 'cache_creation_input_tokens')
      .addSelect('COALESCE(SUM(s.total_cost_usd), 0)', 'total_cost_usd')
      .where('s.started_at >= :since', { since })
      .andWhere('s.started_at <= :now', { now });
    if (scopedTicketIds) totalsQb.andWhere('s.ticket_id IN (:...tids)', { tids: scopedTicketIds });
    const totalsRow = await totalsQb.getRawOne<Record<string, string | number>>();

    const runsTotal = num(totalsRow?.runs_total);
    const runsWithUsage = num(totalsRow?.runs_with_usage);
    const pricedRuns = num(totalsRow?.priced_runs);
    const totalCostUsd = num(totalsRow?.total_cost_usd);
    const avgCostPerRun = pricedRuns > 0 ? totalCostUsd / pricedRuns : null;

    const topTicketsQb = subRepo
      .createQueryBuilder('s')
      .select('s.ticket_id', 'ticket_id')
      // MAX rather than a GROUP BY on title: a ticket's title can change
      // between runs, and every dialect this project supports (sqlite/pg)
      // accepts an aggregate on a non-grouped column here without also
      // adding it to GROUP BY.
      .addSelect('MAX(s.ticket_title)', 'ticket_title')
      .addSelect('COALESCE(SUM(s.input_tokens), 0)', 'input_tokens')
      .addSelect('COALESCE(SUM(s.output_tokens), 0)', 'output_tokens')
      .addSelect('COALESCE(SUM(s.total_cost_usd), 0)', 'total_cost_usd')
      .addSelect('COUNT(*)', 'runs')
      .where('s.started_at >= :since', { since })
      .andWhere('s.started_at <= :now', { now })
      .andWhere('s.ticket_id IS NOT NULL')
      .andWhere('s.input_tokens IS NOT NULL')
      .groupBy('s.ticket_id');
    if (scopedTicketIds) topTicketsQb.andWhere('s.ticket_id IN (:...tids)', { tids: scopedTicketIds });
    const topTicketsRaw = await topTicketsQb.getRawMany<Record<string, string | number>>();

    const topTickets: TicketUsageBreakdown[] = topTicketsRaw
      .map((r) => ({
        ticket_id: String(r.ticket_id),
        ticket_title: (r.ticket_title as string) || '(제목 없음)',
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        total_cost_usd: num(r.total_cost_usd),
        runs: num(r.runs),
      }))
      .sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens))
      .slice(0, limit);

    // Covered by idx_activity_logs_action_created (migration 1760000000063) —
    // action_field alone (added for getSuppressionStats' lifetime counts)
    // can't serve this query's created_at range past its leading column.
    const suppressedQb = this.dataSource
      .getRepository(ActivityLog)
      .createQueryBuilder('a')
      .where('a.action IN (:...actions)', { actions: [...SUPPRESSION_ACTIONS] })
      .andWhere('a.created_at >= :since', { since })
      .andWhere('a.created_at <= :now', { now });
    if (scopedTicketIds) suppressedQb.andWhere('a.ticket_id IN (:...tids)', { tids: scopedTicketIds });
    const suppressedCount = await suppressedQb.getCount();

    return {
      window_minutes: Math.round(windowMs / 60_000),
      coverage: { runs_with_usage: runsWithUsage, runs_total: runsTotal },
      totals: {
        input_tokens: num(totalsRow?.input_tokens),
        output_tokens: num(totalsRow?.output_tokens),
        cache_read_input_tokens: num(totalsRow?.cache_read_input_tokens),
        cache_creation_input_tokens: num(totalsRow?.cache_creation_input_tokens),
        total_cost_usd: totalCostUsd,
      },
      priced_runs: pricedRuns,
      avg_cost_per_run_usd_priced_only: avgCostPerRun,
      top_tickets: topTickets,
      suppressed_attempts_in_window: suppressedCount,
      estimated_saved_usd: avgCostPerRun != null ? avgCostPerRun * suppressedCount : null,
    };
  }

  /** Resolve `boardId` → the concrete ticket_id allowlist Subagent/ActivityLog
   *  rows must fall within to belong to that board (ticket → column → board,
   *  the same resolution RespawnStormDetectorService.getWorkflowHealth uses
   *  for its `scopedColIds`). Returns null when unscoped (workspace-wide). A
   *  board with zero tickets resolves to `[]` — callers must treat that as
   *  "matches nothing" rather than passing an empty array into a SQL
   *  IN(...) clause. */
  private async _resolveScopedTicketIds(boardId: string | undefined): Promise<string[] | null> {
    if (!boardId) return null;
    const colIds = (await this.dataSource.getRepository(BoardColumn).find({ where: { board_id: boardId } })).map((c) => c.id);
    if (colIds.length === 0) return [];
    const tickets = await this.dataSource.getRepository(Ticket).find({ where: { column_id: In(colIds) } });
    return tickets.map((t) => t.id);
  }
}
