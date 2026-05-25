import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter } from 'events';
import { ActivityLog } from '../entities/ActivityLog';
import { LogService } from './log.service';

export const activityEvents = new EventEmitter();

export interface LogActivityParams {
  entity_type: 'ticket' | 'comment';
  entity_id: string | number;
  action: 'created' | 'updated' | 'moved' | 'deleted' | 'status_changed' | 'archived' | 'unarchived';
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
    private readonly logService: LogService,
  ) {}

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
    return this.repo.find({
      where: { ticket_id: ticketId },
      order: { created_at: 'DESC' },
      take: limit,
    });
  }

  async getRecentActivity(limit = 100): Promise<ActivityLog[]> {
    return this.repo.find({
      order: { created_at: 'DESC' },
      take: limit,
    });
  }
}
