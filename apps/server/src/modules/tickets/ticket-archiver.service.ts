/**
 * TicketArchiverService — background sweep that soft-archives Done-column
 * tickets older than each board's `auto_archive_days` setting.
 *
 * Pattern mirrors `TicketSupervisorService`: `OnModuleInit` plants a plain
 * `setInterval`, no `@Cron`, no external scheduler dependency. Default tick
 * cadence is 1 hour — operationally cheap and the archive grace window is
 * configured in days, so a single missed tick doesn't change the user-
 * facing experience. Override via env `ARCHIVER_TICK_MS` (clamped 60s..24h).
 *
 * Per-tick mechanics:
 *
 *   1. Find every board with `auto_archive_days IS NOT NULL` and not paused.
 *   2. For each, look up the terminal column(s) (`is_terminal=true` or
 *      `kind='terminal'`) and select tickets where:
 *        - `column_id IN (terminal_col_ids)`
 *        - `archived_at IS NULL`
 *        - `parent_id IS NULL` (subtasks travel with the parent — not
 *          archivable on their own)
 *        - the ticket has been *idle* for the whole window — i.e. its last
 *          activity is older than `now - auto_archive_days*86400s`. "Last
 *          activity" is the most recent of:
 *            • `terminal_entered_at`  (when it entered Done)
 *            • `updated_at`           (any edit / field change)
 *            • the newest comment's `created_at`
 *          So a Done ticket that's still getting comments or edits keeps
 *          resetting its archive clock; only genuinely-quiet tickets archive.
 *          Implemented as three `<= cutoff` predicates (equivalent to
 *          `GREATEST(...) <= cutoff` but portable across SQLite + Postgres,
 *          which spell `GREATEST`/`MAX` differently): `terminal_entered_at`
 *          and `updated_at` compared directly, plus a `NOT EXISTS` over
 *          `comments` for any row newer than the cutoff.
 *      Capped at ARCHIVER_BATCH_LIMIT per board so the first archiver tick
 *      after enabling auto-archive on a board with 10k Done tickets doesn't
 *      issue 10k writes in a single transaction.
 *   3. For each candidate, stamp `archived_at = now` and emit an activity_log
 *      `action='archived'` row (`actor_name='TicketArchiverService'`) so the
 *      audit trail records the sweep.
 *
 * Idempotent: re-running the tick on a board with nothing to archive is a
 * single empty SELECT. Stops cleanly on module destroy.
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { ActivityService } from '../../services/activity.service';
import { LogService } from '../../services/log.service';

const DEFAULT_TICK_MS = 60 * 60_000; // 1 hour
const MIN_TICK_MS = 60_000;          // 1 minute
const MAX_TICK_MS = 24 * 60 * 60_000; // 24 hours
const ARCHIVER_BATCH_LIMIT = 500;

function resolveTickMs(): number {
  const raw = Number.parseInt(process.env.ARCHIVER_TICK_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TICK_MS;
  return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, raw));
}

@Injectable()
export class TicketArchiverService implements OnModuleInit, OnModuleDestroy {
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly tickMs = resolveTickMs();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly activityService: ActivityService,
  ) {}

  onModuleInit(): void {
    this.tickHandle = setInterval(() => {
      this.runOnce().catch((e: unknown) => {
        this.logService.error('Archiver', 'tick failed', { err: String(e) });
      });
    }, this.tickMs);
    this.logService.info('Archiver', 'Service initialized', {
      tick_ms: this.tickMs,
      batch_limit: ARCHIVER_BATCH_LIMIT,
    });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * One archive sweep. Exposed publicly so tests + the operator-triggered
   * admin endpoint can drive it deterministically without waiting for the
   * setInterval. Returns the per-board archive counts.
   */
  async runOnce(): Promise<{ archived_total: number; per_board: Array<{ board_id: string; count: number }> }> {
    const boardRepo = this.dataSource.getRepository(Board);
    const boards = await boardRepo.createQueryBuilder('b')
      .where('b.auto_archive_days IS NOT NULL')
      .andWhere('b.archived_at IS NULL')
      .getMany();

    if (boards.length === 0) {
      return { archived_total: 0, per_board: [] };
    }

    const perBoard: Array<{ board_id: string; count: number }> = [];
    let total = 0;
    for (const board of boards) {
      // Pausing a board pauses its archiver too — the operator likely paused
      // the board for an active investigation, so don't disturb its Done
      // column underneath them.
      if (board.paused_at) continue;
      try {
        const count = await this.archiveBoard(board);
        perBoard.push({ board_id: board.id, count });
        total += count;
      } catch (e) {
        this.logService.error('Archiver', 'board archive failed (continuing)', {
          err: String(e), board_id: board.id,
        });
      }
    }

    if (total > 0) {
      this.logService.info('Archiver', 'tick complete', {
        boards_processed: boards.length,
        archived_total: total,
        per_board: perBoard,
      });
    }
    return { archived_total: total, per_board: perBoard };
  }

  private async archiveBoard(board: Board): Promise<number> {
    const days = board.auto_archive_days;
    if (days === null || days === undefined) return 0;

    const colRepo = this.dataSource.getRepository(BoardColumn);
    const cols = await colRepo.createQueryBuilder('c')
      .where('c.board_id = :boardId', { boardId: board.id })
      // Both forms of the terminal flag are checked; some legacy migrations
      // set kind without is_terminal and vice versa.
      .andWhere('(c.is_terminal = :trueVal OR c.kind = :kindTerminal)', {
        trueVal: true, kindTerminal: 'terminal',
      })
      .getMany();
    if (cols.length === 0) return 0;
    const terminalColIds = cols.map(c => c.id);

    const cutoff = new Date(Date.now() - days * 86_400_000);
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const candidates = await ticketRepo.createQueryBuilder('t')
      .where('t.column_id IN (:...colIds)', { colIds: terminalColIds })
      .andWhere('t.archived_at IS NULL')
      .andWhere('t.parent_id IS NULL')
      // Idle-since gate: every activity signal must predate the cutoff. The
      // three predicates together are GREATEST(terminal_entered_at,
      // updated_at, max(comment.created_at)) <= cutoff, written portably.
      .andWhere('t.terminal_entered_at IS NOT NULL')
      .andWhere('t.terminal_entered_at <= :cutoff', { cutoff })
      .andWhere('t.updated_at <= :cutoff')
      .andWhere(
        'NOT EXISTS (SELECT 1 FROM comments cm WHERE cm.ticket_id = t.id AND cm.created_at > :cutoff)',
      )
      .orderBy('t.terminal_entered_at', 'ASC')
      .take(ARCHIVER_BATCH_LIMIT)
      .getMany();

    if (candidates.length === 0) return 0;

    const now = new Date();
    for (const t of candidates) {
      try {
        t.archived_at = now;
        await ticketRepo.save(t);
        await this.activityService.logActivity({
          entity_type: 'ticket',
          entity_id: t.id,
          action: 'archived',
          ticket_id: t.id,
          // Sentinel non-'system' actor so the audit row is greppable and
          // distinguishable from manual archives without being treated as a
          // system-comment that TriggerLoopService would silently drop.
          actor_id: 'system',
          actor_name: 'TicketArchiverService',
          field_changed: 'archived_at',
          new_value: now.toISOString(),
          trigger_source: 'auto_archive',
        });
      } catch (e) {
        this.logService.warn('Archiver', 'per-ticket archive failed (continuing)', {
          err: String(e), ticket_id: t.id, board_id: board.id,
        });
      }
    }

    this.logService.info('Archiver', 'board sweep archived tickets', {
      board_id: board.id,
      board_name: board.name,
      auto_archive_days: days,
      archived: candidates.length,
      hit_batch_limit: candidates.length >= ARCHIVER_BATCH_LIMIT,
    });
    return candidates.length;
  }
}
