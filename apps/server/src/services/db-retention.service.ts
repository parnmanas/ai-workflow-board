import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '../entities/ActivityLog';
import { AgentErrorLog } from '../entities/AgentErrorLog';
import { LogService } from './log.service';

/**
 * Periodic pruner for tables that grow unbounded and have no natural
 * retention story baked in elsewhere:
 *
 *   - `activity_logs` — every column move / claim / release / comment
 *     / trigger_emitted / backlog_promotion_* writes a row. User-driven
 *     rows (column moves the operator initiated, comments, manual
 *     triggers) are part of the audit trail and stay forever; the system
 *     emits its OWN audit rows (`trigger_emitted`,
 *     `backlog_promoted`, `backlog_promotion_skipped_focus_held`,
 *     `trigger_dispatched` from supervisor backstops) on the order of
 *     tens of thousands per active day and are the dominant disk consumer.
 *     We prune only those — keyed on `actor_id IN ('system', '')` AND
 *     the four system-only actions above. Anything else stays.
 *
 *   - `agent_error_logs` — every plugin/manager crash / SSE drop / IPC
 *     warning lands a row. Useful for a few weeks of triage, useless
 *     thereafter; no admin tool reads month-old rows.
 *
 * Two off-by-default retention envs:
 *   ACTIVITY_LOG_RETENTION_DAYS    (default 30)
 *   AGENT_ERROR_LOG_RETENTION_DAYS (default 30)
 * Set either to 0 (or any non-positive value) to disable that table's
 * pruner entirely — the service then logs the disabled state on boot
 * and never queries that table again.
 *
 * Cadence: daily tick (default 24h, override via `DB_RETENTION_TICK_MS`).
 * Each tick runs a small bounded DELETE per enabled table — bounded by
 * the `created_at < cutoff` predicate which uses the indices added in
 * migration 1760000000027, so the DELETE plan is an index range scan,
 * not the table scan the previous "no-retention" state would have
 * needed for any cleanup. Failure on one table never blocks the other
 * — each table's prune wraps its own try/catch.
 *
 * Why daily, not hourly: the rows being pruned are audit logs an admin
 * might still want to consult for incidents in the last day. A daily
 * cadence is plenty to keep the table size bounded; hourly would only
 * trade earlier purges for log spam.
 *
 * SQLite (dev): runs the same DELETE statements. Sqlite handles the
 * filter via the same composite indices the entity declares; the tick
 * is harmless even on a tiny dev DB because there's nothing matching
 * the cutoff in fresh dev data.
 */

const DEFAULT_ACTIVITY_LOG_RETENTION_DAYS = 30;
const DEFAULT_AGENT_ERROR_LOG_RETENTION_DAYS = 30;
const DEFAULT_TICK_MS = 24 * 60 * 60_000; // 24h
const MIN_TICK_MS = 60 * 60_000;          // 1h (lowest sensible)
const MAX_TICK_MS = 7 * 24 * 60 * 60_000; // 1 week

// Actions emitted by SYSTEM (TriggerLoopService, BacklogPromotionService,
// TicketSupervisorService) that exist purely as observability rows for
// post-mortems. None of them carry information a user might want to
// inspect months later — the per-ticket audit lives in `moved` /
// `updated` / `created` rows written by humans/agents, which we leave
// alone. Keep this list in sync with the writers in
// trigger-loop.service.ts and backlog-promotion.service.ts.
const SYSTEM_AUDIT_ACTIONS = [
  'trigger_emitted',
  'trigger_dispatched',
  'backlog_promoted',
  'backlog_promotion_skipped_focus_held',
];

function readPositiveInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return n; // may be <= 0 — caller interprets that as "disabled"
}

function clampTickMs(): number {
  const raw = Number.parseInt(process.env.DB_RETENTION_TICK_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TICK_MS;
  return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, raw));
}

@Injectable()
export class DbRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly activityLogRetentionDays = readPositiveInt(
    'ACTIVITY_LOG_RETENTION_DAYS',
    DEFAULT_ACTIVITY_LOG_RETENTION_DAYS,
  );
  private readonly agentErrorLogRetentionDays = readPositiveInt(
    'AGENT_ERROR_LOG_RETENTION_DAYS',
    DEFAULT_AGENT_ERROR_LOG_RETENTION_DAYS,
  );
  private readonly tickMs = clampTickMs();
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    if (this.activityLogRetentionDays <= 0 && this.agentErrorLogRetentionDays <= 0) {
      this.logService.info(
        'DbRetention',
        'service disabled (both retention envs <= 0); no pruning will occur',
        {
          activity_log_retention_days: this.activityLogRetentionDays,
          agent_error_log_retention_days: this.agentErrorLogRetentionDays,
        },
      );
      return;
    }

    // Fire a sweep on boot too — primes the table size on a server
    // that's been running for weeks without this service. Without the
    // immediate kick the first prune wouldn't land for `tickMs` (a
    // full day in default config), which on a NAS already at 100%
    // disk I/O is exactly the moment when sooner help matters.
    this.sweep().catch((e: unknown) => {
      this.logService.error('DbRetention', 'initial sweep failed', { err: String(e) });
    });
    this.tickHandle = setInterval(() => {
      this.sweep().catch((e: unknown) => {
        this.logService.error('DbRetention', 'sweep failed', { err: String(e) });
      });
    }, this.tickMs);
    // setInterval shouldn't keep the process alive on its own — mirror
    // the pattern used by every other sweep service in the codebase.
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();

    this.logService.info('DbRetention', 'sweep loop initialized', {
      activity_log_retention_days: this.activityLogRetentionDays,
      agent_error_log_retention_days: this.agentErrorLogRetentionDays,
      tick_hours: Math.round(this.tickMs / 3_600_000),
    });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * Public test hook + one logical sweep tick. Each table's prune is
   * isolated so a failure on activity_logs doesn't block
   * agent_error_logs (or vice versa). Returns the per-table delete
   * counts so a future admin tool / unit test can assert "the sweep
   * deleted N old rows" without observing internal state.
   */
  async sweep(now: Date = new Date()): Promise<{
    activity_logs_deleted: number;
    agent_error_logs_deleted: number;
  }> {
    const stats = { activity_logs_deleted: 0, agent_error_logs_deleted: 0 };

    if (this.activityLogRetentionDays > 0) {
      try {
        stats.activity_logs_deleted = await this._pruneActivityLogs(now);
      } catch (err: unknown) {
        this.logService.error('DbRetention', 'activity_logs prune failed', { err: String(err) });
      }
    }

    if (this.agentErrorLogRetentionDays > 0) {
      try {
        stats.agent_error_logs_deleted = await this._pruneAgentErrorLogs(now);
      } catch (err: unknown) {
        this.logService.error('DbRetention', 'agent_error_logs prune failed', { err: String(err) });
      }
    }

    if (stats.activity_logs_deleted + stats.agent_error_logs_deleted > 0) {
      this.logService.info('DbRetention', 'sweep completed', stats);
    }
    return stats;
  }

  private async _pruneActivityLogs(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.activityLogRetentionDays * 24 * 3_600_000);
    // Two filters compose: (a) system-actor rows, (b) recognised audit
    // actions. Either alone would over-prune (a system 'moved' row from
    // BacklogPromotionService IS a real ticket transition the user
    // wants to keep; an `actor_id = ''` row with `action = 'created'`
    // on a comment is real user activity stored before the actor field
    // was reliable). The intersection is exactly the synthetic
    // observability rows that have no other purpose.
    //
    // QueryBuilder over the createQueryBuilder().delete() shape so the
    // generated SQL is portable between sqlite and postgres — TypeORM's
    // .delete(criteria) helper doesn't support `IN` predicates without
    // some loss of cross-driver portability for arrays.
    const result = await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(ActivityLog)
      .where('actor_id IN (:...actors)', { actors: ['system', ''] })
      .andWhere('action IN (:...actions)', { actions: SYSTEM_AUDIT_ACTIONS })
      .andWhere('created_at < :cutoff', { cutoff })
      .execute();
    return result.affected ?? 0;
  }

  private async _pruneAgentErrorLogs(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.agentErrorLogRetentionDays * 24 * 3_600_000);
    const result = await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(AgentErrorLog)
      .where('occurred_at < :cutoff', { cutoff })
      .execute();
    return result.affected ?? 0;
  }
}
