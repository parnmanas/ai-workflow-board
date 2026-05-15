/**
 * StuckTicketDetectorService — Layer-1 stale-WAIT detector (ticket 8e934802).
 *
 * Problem (silent forever-WAIT): AWB manages intra-ticket lifecycle
 * (column moves, lock, trigger emission) but had no detector for the
 * "agent keeps writing WAIT comments and nothing actually changes"
 * failure mode. When an assignee subagent reaches a self-imposed gate
 * (BLOCKED-* label / external dependency) it logs a re-check comment
 * each cycle and exits without `move_ticket` / `claim_ticket`. If the
 * external dependency is also unattended, the ticket can sit in this
 * loop indefinitely with zero human signal.
 *
 * Sweep contract:
 *   - Runs every `STUCK_DETECTOR_SWEEP_MS` (default 15 min) via
 *     `setInterval` from `onModuleInit`, mirroring TicketSupervisorService.
 *   - Iterates active / intake column tickets that aren't currently
 *     locked, are older than the grace window, and whose last N agent
 *     comments span at least `STUCK_DETECTOR_MIN_SPAN_MS` without a
 *     lifecycle event (column move, claim, release) in between.
 *   - Posts a single chat-room alert per newly-stuck ticket; dedupes
 *     via the `stuck_alerts` row so re-sweeps inside the cooldown stay
 *     silent.
 *   - On unstuck transition (column move, claim, fresh non-agent
 *     comment), emits a one-shot "ticket_unstuck" message and clears
 *     the row.
 *
 * Heuristic (intentionally text-agnostic):
 *   The "WAIT" signature is N consecutive agent comments with zero
 *   intervening lifecycle event over a real time span — not a phrase
 *   match. Text matching would just produce false negatives for agents
 *   that phrase the wait differently. Keep the rule simple.
 *
 * Storage:
 *   `stuck_alerts` is additive (PK = ticket_id). No FK cascade — the
 *   detector tolerates a missing ticket by skipping the row. Queries
 *   go through TypeORM repositories only so sqlite + postgres pass.
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThan } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { ChatRoom } from '../../entities/ChatRoom';
import { Comment } from '../../entities/Comment';
import { StuckTicketAlert } from '../../entities/StuckTicketAlert';
import { Ticket } from '../../entities/Ticket';
import { Workspace } from '../../entities/Workspace';
import { LogService } from '../../services/log.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import {
  ColumnRolePolicyService,
  PolicyEvaluation,
} from '../column-policies/column-role-policy.service';

const DEFAULTS = {
  ENABLED: true,
  SWEEP_MS: 15 * 60_000,         // 15 min
  WINDOW: 4,                     // N consecutive agent comments
  MIN_SPAN_MS: 2 * 60 * 60_000,  // 2 h — fast-loop guard
  MIN_AGE_MS: 2 * 60 * 60_000,   // 2 h — brand-new ticket grace period
  REALERT_MS: 24 * 60 * 60_000,  // 24 h — cooldown between re-alerts
} as const;

export interface StuckDetectorConfig {
  enabled: boolean;
  sweepMs: number;
  window: number;
  minSpanMs: number;
  minAgeMs: number;
  realertMs: number;
}

function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StuckDetectorConfig {
  const parseInt = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  // 'false' / '0' / 'no' / 'off' all disable; anything else (including unset) → default
  const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
    if (raw == null) return fallback;
    const v = raw.trim().toLowerCase();
    if (v === '' ) return fallback;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return true;
  };
  return {
    enabled:   parseBool(env.STUCK_DETECTOR_ENABLED,    DEFAULTS.ENABLED),
    sweepMs:   parseInt(env.STUCK_DETECTOR_SWEEP_MS,    DEFAULTS.SWEEP_MS),
    window:    parseInt(env.STUCK_DETECTOR_WINDOW,      DEFAULTS.WINDOW),
    minSpanMs: parseInt(env.STUCK_DETECTOR_MIN_SPAN_MS, DEFAULTS.MIN_SPAN_MS),
    minAgeMs:  parseInt(env.STUCK_DETECTOR_MIN_AGE_MS,  DEFAULTS.MIN_AGE_MS),
    realertMs: parseInt(env.STUCK_DETECTOR_REALERT_MS,  DEFAULTS.REALERT_MS),
  };
}

// Exposed for unit tests so the spec can construct configs without
// touching the host environment.
export const __test__ = { readConfigFromEnv, DEFAULTS };

interface SweepStats {
  scanned: number;
  flagged: number;
  realerted: number;
  unstuck: number;
  skipped_disabled: boolean;
}

@Injectable()
export class StuckTicketDetectorService implements OnModuleInit, OnModuleDestroy {
  private readonly config: StuckDetectorConfig;
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly messaging: RoomMessagingService,
    private readonly policies: ColumnRolePolicyService,
  ) {
    this.config = readConfigFromEnv();
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logService.info('StuckDetector', 'service disabled via STUCK_DETECTOR_ENABLED=false', {
        config: this.config,
      });
      return;
    }
    this.tickHandle = setInterval(() => {
      this.sweep().catch((e: unknown) => {
        this.logService.error('StuckDetector', 'sweep failed', { err: String(e) });
      });
    }, this.config.sweepMs);
    // setInterval shouldn't keep the process alive on its own — same
    // as the supervisor service. The Nest lifecycle owns shutdown.
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();
    this.logService.info('StuckDetector', 'sweep loop initialized', { config: this.config });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * Public test hook — equivalent to one tick of the internal loop.
   * Returns light stats so a spec can assert "one ticket flagged,
   * one alert posted" without observing internal state.
   */
  async sweep(now: Date = new Date()): Promise<SweepStats> {
    const stats: SweepStats = {
      scanned: 0, flagged: 0, realerted: 0, unstuck: 0,
      skipped_disabled: !this.config.enabled,
    };
    if (!this.config.enabled) return stats;

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const colRepo    = this.dataSource.getRepository(BoardColumn);
    const alertRepo  = this.dataSource.getRepository(StuckTicketAlert);

    // Step 1 — candidate ticket set. Restrict to active / intake
    // columns up front via an IN-clause so we don't read every ticket
    // in the database. The grace-period guard (ticket.updated_at older
    // than MIN_AGE_MS) is also applied here.
    const candidateCols = await colRepo
      .createQueryBuilder('c')
      .where("c.kind IN (:...kinds)", { kinds: ['active', 'intake'] })
      .getMany();
    if (candidateCols.length === 0) return stats;
    const colIds = candidateCols.map(c => c.id);

    const ageThreshold = new Date(now.getTime() - this.config.minAgeMs);
    const tickets = await ticketRepo
      .createQueryBuilder('t')
      .where('t.column_id IN (:...colIds)', { colIds })
      .andWhere('t.updated_at < :ageThreshold', { ageThreshold })
      .getMany();

    // Pre-fetch the existing alert rows in one shot — used for both
    // dedup (already-alerted) and unstuck detection (alert row exists
    // but ticket no longer matches stale-WAIT shape).
    const allAlerts = await alertRepo.find();
    const alertByTicketId = new Map(allAlerts.map(a => [a.ticket_id, a]));

    // Step 2 — per-ticket evaluation.
    for (const ticket of tickets) {
      stats.scanned += 1;
      const existing = alertByTicketId.get(ticket.id) ?? null;
      // Locked tickets are deliberately excluded FROM NEW FLAGS — the
      // lock alone is "someone is actively working on it", even if
      // their last comment was a WAIT. But if there's an existing
      // alert and the ticket just got locked (claim landed AFTER the
      // alert), that IS the unstuck signal — fall through to
      // _evaluateTicket so the row gets cleaned up and the operator
      // sees the resolution message.
      if (ticket.locked_by_agent_id && !existing) continue;
      try {
        await this._evaluateTicket(ticket, existing, now, stats);
      } catch (e) {
        this.logService.warn('StuckDetector', 'per-ticket evaluation failed (continuing)', {
          err: String(e), ticket_id: ticket.id,
        });
      }
    }

    // Step 3 — alert rows for tickets that fell OUT of the candidate
    // set since the last sweep. Two distinct cases:
    //
    //   (a) Ticket was deleted from the DB entirely. Nothing to notify
    //       about — the audit trail is the only consumer. Silent prune.
    //
    //   (b) Ticket still exists but no longer matches the candidate
    //       filter — typically because the candidate filter is keyed
    //       off `ticket.updated_at` and an operator move / claim /
    //       reassign just bumped it. That bump is exactly the signal
    //       the spec wants to surface as "ticket_unstuck", so emit
    //       the resolution message before pruning.
    //
    // Note: this is the primary unstuck path for column-move
    // resolutions, since the move itself bumps updated_at and pushes
    // the ticket below the MIN_AGE_MS threshold. `_evaluateTicket`
    // covers the in-window resolution cases (fresh non-agent comment,
    // claim that left the ticket old enough to still be a candidate).
    const scannedIds = new Set(tickets.map(t => t.id));
    for (const alert of allAlerts) {
      if (scannedIds.has(alert.ticket_id)) continue;
      const liveTicket = await ticketRepo.findOne({ where: { id: alert.ticket_id } });
      if (liveTicket) {
        // Resolution-side delete + unstuck post.
        await this._emitUnstuck(liveTicket, alert, now, stats, 'fell_out_of_window');
      } else {
        // Silent prune — no consumer to notify.
        await alertRepo.delete({ ticket_id: alert.ticket_id });
        stats.unstuck += 1;
      }
    }

    this.logService.info('StuckDetector', 'sweep complete', { stats });
    return stats;
  }

  /**
   * Evaluate one ticket. Possible outcomes:
   *   - matches stale-WAIT → upsert alert row + post chat message
   *     (first alert OR re-alert when cycle grew or cooldown lapsed)
   *   - previously alerted but no longer stale-WAIT (column moved,
   *     claimed, or fresh user/system comment landed) → emit unstuck
   *     message + delete alert row
   *   - no match and no prior alert → no-op
   */
  private async _evaluateTicket(
    ticket: Ticket,
    existingAlert: StuckTicketAlert | null,
    now: Date,
    stats: SweepStats,
  ): Promise<void> {
    const commentRepo = this.dataSource.getRepository(Comment);
    const alertRepo   = this.dataSource.getRepository(StuckTicketAlert);

    // Fast-path for the resolution signal: any lifecycle event newer
    // than the existing alert means the operator (or another agent)
    // intervened — column move, claim, or release. This catches the
    // three resolution paths from the spec without re-checking the
    // comment shape (the shape may still match if the move happened
    // AFTER the last comment, which would otherwise leave the alert
    // row sticky forever).
    if (existingAlert) {
      const recentLifecycle = await this._countLifecycleEvents(
        ticket.id, existingAlert.last_alerted_at, now,
      );
      // Lock state change also counts: an in-process claim that
      // bypassed the activity log (defensive — the canonical path
      // writes one, but a future code path that doesn't would
      // otherwise leave the row sticky).
      if (recentLifecycle > 0 || ticket.locked_by_agent_id) {
        await this._emitUnstuck(ticket, existingAlert, now, stats, 'lifecycle_after_alert');
        return;
      }
    }

    // Last N comments by created_at DESC. We over-fetch slightly so
    // we can detect a "fresh non-agent comment" (the unstuck signal
    // mid-window) even when the window itself satisfies the WAIT
    // shape — see the `latestIsAgent` check below.
    const window = Math.max(1, this.config.window);
    const recentComments = await commentRepo.find({
      where: { ticket_id: ticket.id },
      order: { created_at: 'DESC' },
      take: window + 1,
    });

    // Exclude `type='system'` housekeeping rows (reviewer / assignee
    // changes, etc.) from the count — those are not author activity.
    const realComments = recentComments.filter(c => c.type !== 'system');
    if (realComments.length === 0) {
      if (existingAlert) await this._emitUnstuck(ticket, existingAlert, now, stats, 'no_real_comments');
      return;
    }

    // The most recent real comment determines the "is the agent still
    // looping?" question. If the latest comment is a human (or a
    // system actor we accept as breaking the loop), the ticket is by
    // definition unstuck even if older comments still match.
    const latestIsAgent = realComments[0].author_type === 'agent';
    if (!latestIsAgent) {
      if (existingAlert) await this._emitUnstuck(ticket, existingAlert, now, stats, 'non_agent_comment');
      return;
    }

    if (realComments.length < window) {
      if (existingAlert) await this._emitUnstuck(ticket, existingAlert, now, stats, 'short_window');
      return;
    }

    // Top `window` comments — verify they're all agent-authored.
    const windowSlice = realComments.slice(0, window);
    if (!windowSlice.every(c => c.author_type === 'agent')) {
      if (existingAlert) await this._emitUnstuck(ticket, existingAlert, now, stats, 'window_mixed_authors');
      return;
    }

    // Time span guard — fast-loop comments (e.g. 4 in 30 seconds) are
    // explicitly excluded. Window is DESC, so first = latest, last = oldest.
    const latest = windowSlice[0];
    const oldest = windowSlice[window - 1];
    const spanMs = latest.created_at.getTime() - oldest.created_at.getTime();
    if (spanMs < this.config.minSpanMs) {
      if (existingAlert) await this._emitUnstuck(ticket, existingAlert, now, stats, 'short_span');
      return;
    }

    // Lifecycle activity between oldest and latest comment — any
    // column move, claim, or release breaks the stale-WAIT shape.
    const intervening = await this._countLifecycleEvents(
      ticket.id, oldest.created_at, latest.created_at,
    );
    if (intervening > 0) {
      if (existingAlert) await this._emitUnstuck(ticket, existingAlert, now, stats, 'lifecycle_event');
      return;
    }

    // === Stale-WAIT confirmed. ===
    const cycleCount = windowSlice.length; // == window
    const latestCommentId = latest.id;

    if (existingAlert) {
      const elapsedMs = now.getTime() - new Date(existingAlert.last_alerted_at).getTime();
      const cycleGrew = cycleCount > existingAlert.last_cycle_count
        || latestCommentId !== existingAlert.last_comment_id;
      if (!cycleGrew && elapsedMs < this.config.realertMs) {
        // Dedup: same situation, still in cooldown. Drop silently —
        // acceptance #5 (two sweeps inside 5 min → one alert).
        return;
      }
      existingAlert.last_alerted_at = now;
      existingAlert.last_cycle_count = cycleCount;
      existingAlert.last_comment_id = latestCommentId;
      await alertRepo.save(existingAlert);
      stats.realerted += 1;
    } else {
      await alertRepo.save(alertRepo.create({
        ticket_id: ticket.id,
        last_alerted_at: now,
        last_cycle_count: cycleCount,
        last_comment_id: latestCommentId,
      }));
      stats.flagged += 1;
    }

    await this._postStuckAlert(ticket, latest, cycleCount, now);
  }

  /**
   * Count column_move / claim / release activity rows between two
   * timestamps for a ticket. Bound to the actual action shape used
   * by the rest of the codebase:
   *   - column move:  action='moved', field_changed='column'
   *   - lock change:  action='updated', field_changed='locked_by_agent_id'
   *     (covers both claim and release — agent_claim and agent_release
   *     trigger_sources land on this same row shape).
   *
   * Using both an action filter AND a field_changed filter avoids
   * false positives from unrelated `updated` rows (e.g. assignee
   * reassign) so a benign edit doesn't accidentally mark a ticket
   * "not stuck".
   */
  private async _countLifecycleEvents(
    ticketId: string,
    fromTime: Date,
    toTime: Date,
  ): Promise<number> {
    const repo = this.dataSource.getRepository(ActivityLog);
    // Precision-mismatch guard. ActivityLog.created_at is populated by
    // @CreateDateColumn — which on SQLite uses SQL `CURRENT_TIMESTAMP`
    // and stores second-precision values (e.g. "2026-05-14 15:23:23").
    // The detector, however, writes `last_alerted_at` from a JS Date
    // with millisecond precision (e.g. "2026-05-14 15:23:23.483").
    // A strict `created_at > from` would then drop a same-second move
    // (15:23:23.000 > 15:23:23.483 is false) and silently leave the
    // alert sticky. Floor `from` and ceiling `to` to second boundaries
    // so any activity that landed in those bounding seconds is caught.
    const floorSec = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);
    const ceilSec = (d: Date) => new Date(Math.ceil(d.getTime() / 1000) * 1000);
    return repo
      .createQueryBuilder('a')
      .where('a.ticket_id = :tid', { tid: ticketId })
      .andWhere('a.created_at >= :from', { from: floorSec(fromTime) })
      .andWhere('a.created_at <= :to', { to: ceilSec(toTime) })
      .andWhere(
        "((a.action = 'moved' AND a.field_changed = 'column') " +
        "OR (a.action = 'updated' AND a.field_changed = 'locked_by_agent_id'))",
      )
      .getCount();
  }

  /**
   * Compose and dispatch a "stale-WAIT" chat message for a newly-
   * flagged or re-alerted ticket. Includes ticket UUID, board name,
   * cycle count, age in hours, and a one-line excerpt of the latest
   * agent comment so the operator can triage from the notification
   * itself without opening the ticket.
   *
   * Policy enrichment (ticket f886ada7): if there's an enabled
   * `expected_action=move` policy for the ticket's (column, role) pair
   * AND no gate label matches AND `cycleCount` is at-or-past the policy's
   * `max_cycles_without_progress`, the same alert is upgraded to
   * "Stale-WAIT + policy violation" with the configured target column,
   * gate-label vs. attached-label diff, and a structured activity_log
   * row gets written. Re-uses the same `stuck_alerts` dedup row so the
   * operator gets exactly one notification per dedup window — not one
   * stale-WAIT + one policy_violation in lockstep.
   */
  private async _postStuckAlert(
    ticket: Ticket,
    latestComment: Comment,
    cycleCount: number,
    now: Date,
  ): Promise<void> {
    const targetRoomId = await this._resolveAlertRoomId(ticket.workspace_id);
    if (!targetRoomId) {
      this.logService.warn('StuckDetector', 'no chat room available for alert — skipping post', {
        ticket_id: ticket.id, workspace_id: ticket.workspace_id,
      });
      return;
    }
    const column = ticket.column_id
      ? await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } })
      : null;
    const boardName = column ? await this._resolveBoardNameForColumn(column) : '(no board)';
    const ageH = Math.max(0,
      (now.getTime() - new Date(ticket.updated_at || ticket.created_at).getTime()) / 3_600_000);
    const excerpt = oneLineExcerpt(latestComment.content);
    const ticketLink = `/ws/${ticket.workspace_id}/ticket/${ticket.id}`;

    // ── Policy enrichment ──
    //
    // The detector confirmed stale-WAIT shape independently. The policy
    // layer (ticket f886ada7) classifies whether that WAIT was *expected*
    // (legitimate gate label attached) or *unexpected* (no gate label =
    // agent forgot to move_ticket). We only escalate the message when
    // the violation cycle threshold is crossed; otherwise the original
    // stale-WAIT alert ships unchanged.
    const labels = parseTicketLabels(ticket.labels);
    const evaluation = column
      ? await this.policies.evaluate(column, labels)
      : null;
    const isPolicyViolation = !!evaluation
      && evaluation.isViolation
      && cycleCount >= evaluation.minCyclesThreshold;

    const lines: string[] = [];
    if (isPolicyViolation && evaluation) {
      const targetColName = evaluation.targetColumnIds.length > 0
        ? await this._resolveColumnName(evaluation.targetColumnIds[0])
        : '(unset)';
      const roleList = evaluation.roleSlugs.join(', ') || '(none)';
      const gateList = evaluation.gateLabels.length > 0
        ? evaluation.gateLabels.join(', ')
        : '(none)';
      const attachedList = labels.length > 0 ? labels.join(', ') : '(none)';
      lines.push(`⚠️ **Stale-WAIT + policy violation** — \`${ticket.id}\``);
      lines.push(`**${ticket.title}**`);
      lines.push(
        `Board: ${boardName} · current column: ${column?.name ?? '(unknown)'} ` +
        `→ expected: ${targetColName} · role(s): ${roleList}`,
      );
      lines.push(
        `cycles: ${cycleCount} (threshold ${evaluation.minCyclesThreshold}) · age: ${ageH.toFixed(1)}h`,
      );
      lines.push(`Gate labels (configured): ${gateList}`);
      lines.push(`Attached labels: ${attachedList}`);
      lines.push(`Latest agent comment: _${excerpt}_`);
      lines.push(`[Open ticket](${ticketLink})`);
      await this._writePolicyViolationActivity(ticket, evaluation, cycleCount, now);
    } else {
      lines.push(`⚠️ **Stale-WAIT detected** — \`${ticket.id}\``);
      lines.push(`**${ticket.title}**`);
      lines.push(`Board: ${boardName} · cycles: ${cycleCount} · age: ${ageH.toFixed(1)}h`);
      lines.push(`Latest agent comment: _${excerpt}_`);
      lines.push(`[Open ticket](${ticketLink})`);
    }
    try {
      await this.messaging.sendSystemMessage(targetRoomId, ticket.workspace_id, lines.join('\n\n'));
      this.logService.info('StuckDetector', 'alert posted', {
        ticket_id: ticket.id, room_id: targetRoomId, cycle_count: cycleCount,
        policy_violation: isPolicyViolation,
      });
    } catch (e) {
      this.logService.error('StuckDetector', 'alert post failed', {
        err: String(e), ticket_id: ticket.id, room_id: targetRoomId,
      });
    }
  }

  private async _writePolicyViolationActivity(
    ticket: Ticket,
    evaluation: PolicyEvaluation,
    cycleCount: number,
    now: Date,
  ): Promise<void> {
    try {
      const repo = this.dataSource.getRepository(ActivityLog);
      await repo.save(repo.create({
        workspace_id: ticket.workspace_id ?? '',
        entity_type: 'ticket',
        entity_id: ticket.id,
        action: 'policy_violation',
        // Encode the policy id(s) so an admin tool can join back; field_changed
        // is otherwise meaningless for this synthetic event.
        field_changed: 'column_role_policy',
        old_value: '',
        new_value: JSON.stringify({
          policy_ids: evaluation.movePolicies.map(p => p.id),
          role_slugs: evaluation.roleSlugs,
          target_column_ids: evaluation.targetColumnIds,
          cycle_count: cycleCount,
          gate_labels: evaluation.gateLabels,
        }),
        actor_id: '',
        actor_name: 'StuckTicketDetector',
        ticket_id: ticket.id,
        role: '',
        trigger_source: 'system',
        created_at: now,
      }));
    } catch (e) {
      this.logService.warn('StuckDetector', 'policy_violation activity write failed (continuing)', {
        err: String(e), ticket_id: ticket.id,
      });
    }
  }

  private async _resolveColumnName(columnId: string): Promise<string> {
    if (!columnId) return '(unset)';
    const col = await this.dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: columnId } });
    return col?.name ?? '(unknown)';
  }

  private async _resolveBoardNameForColumn(col: BoardColumn): Promise<string> {
    const board = await this.dataSource
      .getRepository(Board)
      .findOne({ where: { id: col.board_id } });
    return board?.name ?? '(unknown board)';
  }

  private async _emitUnstuck(
    ticket: Ticket,
    alert: StuckTicketAlert,
    now: Date,
    stats: SweepStats,
    reason: string,
  ): Promise<void> {
    const alertRepo = this.dataSource.getRepository(StuckTicketAlert);
    // Delete first so a failed chat post doesn't keep the row "stuck"
    // — the user-facing alert is best-effort, the row cleanup is the
    // ground truth.
    await alertRepo.delete({ ticket_id: alert.ticket_id });
    stats.unstuck += 1;

    const targetRoomId = await this._resolveAlertRoomId(ticket.workspace_id);
    if (!targetRoomId) return;

    const boardName = await this._resolveBoardName(ticket);
    const lines: string[] = [
      `✅ **ticket_unstuck** — \`${ticket.id}\``,
      `**${ticket.title}**`,
      `Board: ${boardName} · reason: ${reason}`,
    ];
    try {
      await this.messaging.sendSystemMessage(targetRoomId, ticket.workspace_id, lines.join('\n\n'));
      this.logService.info('StuckDetector', 'unstuck posted', {
        ticket_id: ticket.id, room_id: targetRoomId, reason,
      });
    } catch (e) {
      this.logService.error('StuckDetector', 'unstuck post failed', {
        err: String(e), ticket_id: ticket.id, reason,
      });
    }
  }

  /**
   * Resolve the chat room to publish into for a workspace. Order:
   *   1. Workspace.alerts_chat_room_id, if set and the room exists.
   *   2. Oldest chat room in the workspace by `created_at ASC`.
   * Returns null if the workspace has no chat rooms at all (a fresh
   * workspace with no operator presence — the detector logs the miss
   * and the row still gets created so future sweeps re-attempt).
   */
  private async _resolveAlertRoomId(workspaceId: string): Promise<string | null> {
    if (!workspaceId) return null;
    const wsRepo = this.dataSource.getRepository(Workspace);
    const ws = await wsRepo.findOne({ where: { id: workspaceId } });
    const roomRepo = this.dataSource.getRepository(ChatRoom);
    if (ws?.alerts_chat_room_id) {
      const configured = await roomRepo.findOne({
        where: { id: ws.alerts_chat_room_id, workspace_id: workspaceId },
      });
      if (configured) return configured.id;
      // Stale id (room deleted) — fall through to the oldest-room lookup.
    }
    const fallback = await roomRepo
      .createQueryBuilder('r')
      .where('r.workspace_id = :wsId', { wsId: workspaceId })
      .orderBy('r.created_at', 'ASC')
      .limit(1)
      .getOne();
    return fallback?.id ?? null;
  }

  private async _resolveBoardName(ticket: Ticket): Promise<string> {
    if (!ticket.column_id) return '(no board)';
    const col = await this.dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: ticket.column_id } });
    if (!col) return '(unknown board)';
    const board = await this.dataSource
      .getRepository(Board)
      .findOne({ where: { id: col.board_id } });
    return board?.name ?? '(unknown board)';
  }

  /** Test helper — read the loaded config so a spec can assert env parsing. */
  getConfig(): StuckDetectorConfig {
    return { ...this.config };
  }

  /**
   * Admin endpoint helper — list current `stuck_alerts` rows joined
   * with ticket title and board name. Kept on the service so the
   * controller stays a thin pass-through.
   */
  async listActiveAlerts(): Promise<Array<{
    ticket_id: string;
    title: string;
    board_id: string;
    board_name: string;
    workspace_id: string;
    cycle_count: number;
    last_alerted_at: Date;
    last_comment_id: string;
  }>> {
    const alertRepo = this.dataSource.getRepository(StuckTicketAlert);
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const colRepo = this.dataSource.getRepository(BoardColumn);
    const boardRepo = this.dataSource.getRepository(Board);

    const alerts = await alertRepo.find({ order: { last_alerted_at: 'DESC' } });
    if (alerts.length === 0) return [];

    const ticketIds = alerts.map(a => a.ticket_id);
    const tickets = await ticketRepo.findByIds(ticketIds);
    const ticketsById = new Map(tickets.map(t => [t.id, t]));

    const colIds = Array.from(new Set(tickets.map(t => t.column_id).filter(Boolean) as string[]));
    const cols = colIds.length ? await colRepo.findByIds(colIds) : [];
    const colsById = new Map(cols.map(c => [c.id, c]));

    const boardIds = Array.from(new Set(cols.map(c => c.board_id).filter(Boolean) as string[]));
    const boards = boardIds.length ? await boardRepo.findByIds(boardIds) : [];
    const boardsById = new Map(boards.map(b => [b.id, b]));

    return alerts.map(a => {
      const t = ticketsById.get(a.ticket_id);
      const col = t?.column_id ? colsById.get(t.column_id) : null;
      const board = col?.board_id ? boardsById.get(col.board_id) : null;
      return {
        ticket_id: a.ticket_id,
        title: t?.title ?? '(ticket missing)',
        board_id: board?.id ?? '',
        board_name: board?.name ?? '(unknown)',
        workspace_id: t?.workspace_id ?? '',
        cycle_count: a.last_cycle_count,
        last_alerted_at: a.last_alerted_at,
        last_comment_id: a.last_comment_id,
      };
    });
  }

  /**
   * Admin action — force a re-alert for a specific ticket. Resets the
   * cooldown so the next sweep treats the alert as fresh; the actual
   * chat message still routes through the standard sweep so the
   * heuristic verifies the ticket is still stale-WAIT.
   *
   * Returns true if a row existed and was reset, false otherwise.
   */
  async forceRealert(ticketId: string): Promise<boolean> {
    const alertRepo = this.dataSource.getRepository(StuckTicketAlert);
    const existing = await alertRepo.findOne({ where: { ticket_id: ticketId } });
    if (!existing) return false;
    // Set last_alerted_at to the epoch so any next sweep is past the
    // cooldown without needing to know the cooldown value.
    existing.last_alerted_at = new Date(0);
    existing.last_cycle_count = 0; // also force "cycleGrew" path
    await alertRepo.save(existing);
    return true;
  }

  /**
   * Admin action — dismiss a stuck alert. Deletes the row without
   * emitting an unstuck message (the operator already saw it and
   * decided to silence it manually).
   */
  async dismissAlert(ticketId: string): Promise<boolean> {
    const alertRepo = this.dataSource.getRepository(StuckTicketAlert);
    const r = await alertRepo.delete({ ticket_id: ticketId });
    return (r.affected ?? 0) > 0;
  }
}

/**
 * Single-line, length-bounded excerpt suitable for embedding in a chat
 * markdown blockquote. Strips leading markdown headers / lists so the
 * preview reads naturally. Caller decides whether to italicise it.
 */
function oneLineExcerpt(content: string, max = 240): string {
  if (!content) return '(empty)';
  const firstLine = content
    .split('\n')
    .map(l => l.replace(/^\s*[-*>#]+\s*/g, '').trim())
    .find(l => l.length > 0) || content.trim();
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Parse the `Ticket.labels` JSON string defensively. Returns `[]` on any
 * malformed input — labels are operator-curated and a malformed blob
 * shouldn't crash the sweep.
 */
function parseTicketLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

// Exported helpers for unit tests
export const __test_helpers__ = { oneLineExcerpt, parseTicketLabels };

// Suppress unused-import warnings in builds where these are only
// referenced from query strings (TypeORM operator imports kept for
// future range-query refactors).
void IsNull; void LessThan;
