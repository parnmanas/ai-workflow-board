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
import { AgentUsageDailyRollup } from '../../entities/AgentUsageDailyRollup';

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

export interface LongTermUsageStats {
  // 실제로 조회한 UTC-day 경계(양끝 포함), 'YYYY-MM-DD'. `from: null`은
  // 하한 없음(all-time)을 뜻한다.
  from: string | null;
  to: string;
  coverage: { runs_with_usage: number; runs_total: number };
  totals: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    total_cost_usd: number;
  };
  priced_runs: number;
  avg_cost_per_run_usd_priced_only: number | null;
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

  /**
   * All-time / 장기 usage (ticket 8d5c6f5d, 6dd3f968 후속) — `AgentUsageDailyRollup`
   * (영속 쪽) + 같은 구간에 아직 `subagents`에 남아있는 live 쪽을 합산한다.
   * 마진/cutoff 없이 정확하다: `SubagentMonitorService._sweepEnded`/
   * `_rollupBeforeDelete`가 run을 롤업에 접어 넣는 것과 `subagents`에서
   * 지우는 것을 하나의 트랜잭션으로 처리하므로, 어떤 순간에도 run은 두
   * 테이블 중 정확히 하나에만 있다 — 같은 구간에 대해 둘을 합산해도
   * 이중집계도, gap도 생기지 않는다.
   *
   * 구간은 UTC-DAY 단위만 지원한다 — `from`/`to`는 timestamp가 아니라
   * 달력 날짜이고, 두 서브쿼리 모두 경계 날짜의 하루 전체로 넓혀진다. 롤업
   * 테이블은 애초에 "어느 날인지"만 알기 때문에, sub-day 구간을 허용하면
   * 경계 날짜의 24시간 전체를 롤업 쪽에서 끌어오면서 live 쪽은 그 날의
   * 일부만 커버해 조용히 과다집계된다. 최근 데이터에 sub-day 정밀도가
   * 필요한 호출부는 대신 `getTokenUsageStats`의 윈도우 쿼리를 쓸 것(100%
   * live-table 기반이라 롤업이 관여하지 않으므로 day-정렬 제약도 없다).
   *
   * workspace 스코프만 지원하고 board 스코프는 없다: 롤업 grain이
   * (workspace_id, usage_date, agent_id)라 ticket/board 차원이 없다
   * (8d5c6f5d에서의 planner 판단 — 그쪽은 위 `top_tickets`처럼
   * live-window 전용으로 남는다). `from` 생략 = all-time(하한 없음).
   */
  async getLongTermUsageStats(opts: {
    workspaceId: string;
    from?: Date;
    to?: Date;
  }): Promise<LongTermUsageStats> {
    const { workspaceId } = opts;
    const toDay = (opts.to ?? new Date()).toISOString().slice(0, 10);
    const fromDay = opts.from ? opts.from.toISOString().slice(0, 10) : null;

    // live 테이블 경계: [fromDay, toDay]의 UTC 하루 전체 범위로 잡아
    // live 슬라이스가 롤업 슬라이스와 정확히 같은 달력 날짜들을 커버하게 한다.
    const liveUpperBound = new Date(`${toDay}T23:59:59.999Z`);
    const liveLowerBound = fromDay ? new Date(`${fromDay}T00:00:00.000Z`) : new Date(0);

    const rollupQb = this.dataSource
      .getRepository(AgentUsageDailyRollup)
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.runs_total), 0)', 'runs_total')
      .addSelect('COALESCE(SUM(r.runs_with_usage), 0)', 'runs_with_usage')
      .addSelect('COALESCE(SUM(r.priced_runs), 0)', 'priced_runs')
      .addSelect('COALESCE(SUM(r.input_tokens), 0)', 'input_tokens')
      .addSelect('COALESCE(SUM(r.output_tokens), 0)', 'output_tokens')
      .addSelect('COALESCE(SUM(r.cache_read_input_tokens), 0)', 'cache_read_input_tokens')
      .addSelect('COALESCE(SUM(r.cache_creation_input_tokens), 0)', 'cache_creation_input_tokens')
      .addSelect('COALESCE(SUM(r.total_cost_usd), 0)', 'total_cost_usd')
      .where('r.workspace_id = :workspaceId', { workspaceId })
      .andWhere('r.usage_date <= :toDay', { toDay });
    if (fromDay) rollupQb.andWhere('r.usage_date >= :fromDay', { fromDay });
    const rollupRow = await rollupQb.getRawOne<Record<string, string | number>>();

    const liveRow = await this.dataSource
      .getRepository(Subagent)
      .createQueryBuilder('s')
      .select('COUNT(*)', 'runs_total')
      .addSelect('COUNT(s.input_tokens)', 'runs_with_usage')
      .addSelect('COUNT(s.total_cost_usd)', 'priced_runs')
      .addSelect('COALESCE(SUM(s.input_tokens), 0)', 'input_tokens')
      .addSelect('COALESCE(SUM(s.output_tokens), 0)', 'output_tokens')
      .addSelect('COALESCE(SUM(s.cache_read_input_tokens), 0)', 'cache_read_input_tokens')
      .addSelect('COALESCE(SUM(s.cache_creation_input_tokens), 0)', 'cache_creation_input_tokens')
      .addSelect('COALESCE(SUM(s.total_cost_usd), 0)', 'total_cost_usd')
      .where('s.workspace_id = :workspaceId', { workspaceId })
      .andWhere('s.started_at >= :liveLowerBound', { liveLowerBound })
      .andWhere('s.started_at <= :liveUpperBound', { liveUpperBound })
      .getRawOne<Record<string, string | number>>();

    const pricedRuns = num(rollupRow?.priced_runs) + num(liveRow?.priced_runs);
    const totalCostUsd = num(rollupRow?.total_cost_usd) + num(liveRow?.total_cost_usd);

    return {
      from: fromDay,
      to: toDay,
      coverage: {
        runs_with_usage: num(rollupRow?.runs_with_usage) + num(liveRow?.runs_with_usage),
        runs_total: num(rollupRow?.runs_total) + num(liveRow?.runs_total),
      },
      totals: {
        input_tokens: num(rollupRow?.input_tokens) + num(liveRow?.input_tokens),
        output_tokens: num(rollupRow?.output_tokens) + num(liveRow?.output_tokens),
        cache_read_input_tokens: num(rollupRow?.cache_read_input_tokens) + num(liveRow?.cache_read_input_tokens),
        cache_creation_input_tokens: num(rollupRow?.cache_creation_input_tokens) + num(liveRow?.cache_creation_input_tokens),
        total_cost_usd: totalCostUsd,
      },
      priced_runs: pricedRuns,
      avg_cost_per_run_usd_priced_only: pricedRuns > 0 ? totalCostUsd / pricedRuns : null,
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
