import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { EventEmitter } from 'events';
import { ActivityLog } from '../entities/ActivityLog';
import { Agent } from '../entities/Agent';
import { LogService } from './log.service';
import { resolveAgentDisplayNamesByIds } from '../utils/agent-name';

export const activityEvents = new EventEmitter();

export interface LogActivityParams {
  // 'board' | 'agent' added for cross-workspace move (WorkspaceMoveService):
  // a board/agent move is not tied to a single ticket, so entity_type widens
  // beyond the ticket/comment pair and `ticket_id` is passed as '' for them.
  // 'workspace' added (ticket 1fcba693) for the workspace config-change audit —
  // a settings PATCH (e.g. supervisor_stale_ms) is workspace-scoped, not tied to
  // a ticket, so `ticket_id` is '' and `workspace_id` carries the scope.
  entity_type: 'ticket' | 'comment' | 'board' | 'agent' | 'workspace';
  entity_id: string | number;
  // The three `respawn_*` actions are first-class events written by
  // RespawnStormDetectorService (ticket ab06eac2). ActivityLog.action is a bare
  // varchar (no DB constraint) and the event-registry `board_update` entry
  // forwards `action` verbatim, so widening this union is the only step needed
  // for them to persist AND ride the live SSE stream like any other activity.
  // 'config_changed' (ticket 1fcba693) is the grep-able workspace settings-change
  // audit action (actor + old→new + source), so a value like the 4 h
  // supervisor_stale_ms band-aid can never again be applied without a trail.
  action:
    | 'created' | 'updated' | 'moved' | 'deleted' | 'status_changed' | 'archived' | 'unarchived'
    | 'respawn_storm_halted' | 'respawn_twin_detected' | 'respawn_twin_autostop_intent'
    | 'config_changed'
    // 'dispatch_deferred' (ticket bfdd80b7): a dispatch targeted an agent that
    // is not reachable (never-started / offline). Written via logActivity — NOT
    // the raw repo.save the silent drop-gates use — so it rides the live
    // 'activity' SSE (board update) AND SystemCommentService projects it into a
    // visible ticket comment. `new_value` carries the human-readable reason +
    // the auto-start outcome; `field_changed` carries the lifecycle state.
    | 'dispatch_deferred'
    // 'comment_pingpong_suppressed' (ticket 3970db66): agent-comment-pingpong
    // guard (common/agent-comment-pingpong.ts) suppressed an agent's comment —
    // `field_changed` carries which of the 3 reasons (repeated_waiting_without_
    // work_target | pending_user_action | duplicate_terminal_acknowledgement),
    // `actor_id`/`actor_name` the REAL agent whose comment was blocked (prior to
    // this, only the internal auto-pend's field-change row existed, and it
    // always attributed to the guard itself, never the suppressed agent).
    | 'comment_pingpong_suppressed';
  field_changed?: string;
  old_value?: string;
  new_value?: string;
  actor_id?: string;
  actor_name?: string;
  ticket_id: string;
  workspace_id?: string;   // scope for non-ticket entities (workspace config); '' if omitted
  role?: string;           // agent role; written as '' if omitted
  trigger_source?: string; // 'agent_trigger' | 'manual' | ''; written as '' if omitted
}

@Injectable()
export class ActivityService {
  constructor(
    @InjectRepository(ActivityLog) private readonly repo: Repository<ActivityLog>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly logService: LogService,
  ) {}

  /**
   * Re-resolve `actor_name` to the canonical `<Manager>/<Agent>` display for
   * every row whose `actor_id` points at an agent, so the ticket Activity tab
   * (and the dashboard feed) render one stable identity regardless of which
   * write path stamped the row — several store the bare leaf `caller.agentName`
   * instead of the manager-prefixed display. Non-agent actors (users, system
   * labels like "QA" / "Handoff" / "BacklogPromotionService", whose actor_id is
   * empty or foreign) keep their stored name. Done on the READ side so rows
   * already persisted with a bare name render correctly too — a write-side-only
   * fix would leave the high-churn activity_logs history inconsistent, and this
   * table is deliberately never backfilled (see entity header). Batched: at
   * most two id-keyed queries (agents, then their managers) per call.
   */
  private async resolveActorDisplayNames(rows: ActivityLog[]): Promise<ActivityLog[]> {
    if (rows.length === 0) return rows;
    const displayById = await resolveAgentDisplayNamesByIds(
      this.agentRepo,
      rows.map(r => r.actor_id),
    );
    if (displayById.size === 0) return rows;
    return rows.map(r => {
      const display = r.actor_id ? displayById.get(r.actor_id) : undefined;
      return display && display !== r.actor_name ? { ...r, actor_name: display } : r;
    });
  }

  /** Build the (unsaved) row from params — shared by the immediate and the
   *  transaction-scoped write paths so both stamp identical fields. */
  private _buildLog(params: LogActivityParams): ActivityLog {
    return this.repo.create({
      entity_type: params.entity_type,
      entity_id: String(params.entity_id),
      action: params.action,
      field_changed: params.field_changed || '',
      old_value: params.old_value || '',
      new_value: params.new_value || '',
      actor_id: params.actor_id || '',
      actor_name: params.actor_name || '',
      ticket_id: params.ticket_id,
      workspace_id: params.workspace_id || '',
      role: params.role || '',
      trigger_source: params.trigger_source || '',
    });
  }

  /** Emit the live SSE 'activity' event for a persisted row. Split out so the
   *  immediate and the deferred (post-commit) write paths share one emit. */
  private _emitActivity(saved: ActivityLog): void {
    const listenerCount = activityEvents.listenerCount('activity');
    this.logService.info('Activity', `Emitting "${saved.action}" on ${saved.entity_type} #${saved.entity_id}`, {
      ticket_id: saved.ticket_id, listeners: listenerCount,
    });
    activityEvents.emit('activity', saved);
  }

  async logActivity(params: LogActivityParams): Promise<ActivityLog> {
    const saved = await this.repo.save(this._buildLog(params));
    this._emitActivity(saved);
    return saved;
  }

  /**
   * Transaction-scoped write (ticket 1fcba693). Persists the row via the
   * caller's EntityManager so it commits — or rolls back — ATOMICALLY with the
   * caller's other writes, and returns it WITHOUT emitting the live SSE event.
   * The caller must call emitLogged() once the enclosing transaction commits, so
   * a row that ends up rolled back never rides the activity stream. Used by the
   * workspace config-change audit, which must be atomic with the settings save:
   * a cadence value (e.g. the incident's 4 h supervisor_stale_ms) can never
   * persist without its audit row — best-effort swallowing would re-open exactly
   * the "changed with no trail" gap this audit closes.
   */
  async logActivityTx(manager: EntityManager, params: LogActivityParams): Promise<ActivityLog> {
    return manager.save(this._buildLog(params));
  }

  /** Emit the deferred SSE 'activity' events for rows persisted via
   *  logActivityTx, after their transaction committed. No-op on []. */
  emitLogged(rows: ActivityLog[]): void {
    for (const row of rows) this._emitActivity(row);
  }

  async getTicketActivity(ticketId: string, limit = 50): Promise<ActivityLog[]> {
    const rows = await this.repo.find({
      where: { ticket_id: ticketId },
      order: { created_at: 'DESC' },
      take: limit,
    });
    return this.resolveActorDisplayNames(rows);
  }

  async getRecentActivity(limit = 100): Promise<ActivityLog[]> {
    const rows = await this.repo.find({
      order: { created_at: 'DESC' },
      take: limit,
    });
    return this.resolveActorDisplayNames(rows);
  }
}
