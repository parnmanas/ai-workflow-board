import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  entity_type: 'ticket' | 'comment' | 'board' | 'agent';
  entity_id: string | number;
  // The three `respawn_*` actions are first-class events written by
  // RespawnStormDetectorService (ticket ab06eac2). ActivityLog.action is a bare
  // varchar (no DB constraint) and the event-registry `board_update` entry
  // forwards `action` verbatim, so widening this union is the only step needed
  // for them to persist AND ride the live SSE stream like any other activity.
  action:
    | 'created' | 'updated' | 'moved' | 'deleted' | 'status_changed' | 'archived' | 'unarchived'
    | 'respawn_storm_halted' | 'respawn_twin_detected' | 'respawn_twin_autostop_intent';
  field_changed?: string;
  old_value?: string;
  new_value?: string;
  actor_id?: string;
  actor_name?: string;
  ticket_id: string;
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

  async logActivity(params: LogActivityParams): Promise<ActivityLog> {
    const log = this.repo.create({
      entity_type: params.entity_type,
      entity_id: String(params.entity_id),
      action: params.action,
      field_changed: params.field_changed || '',
      old_value: params.old_value || '',
      new_value: params.new_value || '',
      actor_id: params.actor_id || '',
      actor_name: params.actor_name || '',
      ticket_id: params.ticket_id,
      role: params.role || '',
      trigger_source: params.trigger_source || '',
    });
    const saved = await this.repo.save(log);
    const listenerCount = activityEvents.listenerCount('activity');
    this.logService.info('Activity', `Emitting "${saved.action}" on ${saved.entity_type} #${saved.entity_id}`, {
      ticket_id: saved.ticket_id, listeners: listenerCount,
    });
    activityEvents.emit('activity', saved);
    return saved;
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
