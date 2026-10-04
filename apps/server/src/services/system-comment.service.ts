import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { activityEvents } from './activity.service';
import { LogService } from './log.service';
import { Comment } from '../entities/Comment';
import { Ticket } from '../entities/Ticket';
import { ActivityLog } from '../entities/ActivityLog';
import { TICKET_STATUS_LABELS, isTicketStatus } from '../common/ticket-status';

/** Status id → its board-less label ("in_progress" → "In Progress"). */
function statusLabel(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return isTicketStatus(value) ? TICKET_STATUS_LABELS[value] : value;
}

@Injectable()
export class SystemCommentService implements OnModuleInit, OnModuleDestroy {
  private activityListener: (log: ActivityLog) => void;

  constructor(
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    private readonly logService: LogService,
  ) {}

  onModuleDestroy() {
    if (this.activityListener) {
      activityEvents.removeListener('activity', this.activityListener);
    }
  }

  onModuleInit() {
    this.activityListener = async (log: ActivityLog) => {
      try {
        if (!log.ticket_id) return;
        const content = await this.buildSystemComment(log);
        if (content) {
          await this.createSystemComment(log.ticket_id, content);
        }
      } catch (err) {
        this.logService.error('SystemComment', 'Error processing activity', { error: String(err) });
      }
    };
    activityEvents.on('activity', this.activityListener);
    this.logService.info('SystemComment', 'Service initialized');
  }

  private async buildSystemComment(log: ActivityLog): Promise<string | null> {
    const actor = log.actor_name ? ` by **${log.actor_name}**` : '';

    // Dispatch deferred — the target agent is not reachable (never-started /
    // offline) so the trigger was held (ticket bfdd80b7). Surface it as a
    // prominent ticket comment (not just an Activity-tab row) so the user
    // immediately sees WHY nothing is progressing. `new_value` carries the
    // pre-composed human message (state + auto-start outcome).
    if (log.entity_type === 'ticket' && log.action === 'dispatch_deferred') {
      const detail = log.new_value || 'agent 미시작';
      return `⏳ **dispatch 보류** — ${detail}`;
    }

    // Check if this is a child ticket (subtask) action:
    // Child tickets use entity_type='ticket' but have ticket_id != entity_id
    // (ticket_id points to parent, entity_id is the child itself)
    const isChildTicket = log.entity_type === 'ticket' && log.ticket_id && log.ticket_id !== log.entity_id;
    const isLegacySubtask = log.entity_type === 'subtask';

    if (isChildTicket || isLegacySubtask) {
      if (log.action === 'created') {
        const title = log.new_value || await this.getSubtaskTitle(log.entity_id);
        return `➕ Subtask added: **${title}**${actor}`;
      }
      if (log.action === 'deleted') {
        return `🗑️ Subtask removed: **${log.new_value || `#${log.entity_id}`}**${actor}`;
      }
      if (log.action === 'status_changed') {
        const title = await this.getSubtaskTitle(log.entity_id);
        return `🔄 Subtask **${title}** status changed: **${log.old_value || 'unknown'}** → **${log.new_value || 'unknown'}**${actor}`;
      }
    }

    if (log.entity_type === 'ticket') {
      if (log.action === 'moved' && log.field_changed === 'status') {
        return `📋 Ticket moved from **${statusLabel(log.old_value)}** to **${statusLabel(log.new_value)}**${actor}`;
      }
    }

    return null;
  }

  private async getSubtaskTitle(entityId: string): Promise<string> {
    try {
      const ticket = await this.ticketRepo.findOne({ where: { id: entityId } });
      return ticket?.title || `#${entityId}`;
    } catch {
      return `#${entityId}`;
    }
  }

  private async createSystemComment(ticketId: string, content: string): Promise<void> {
    try {
      await this.commentRepo.save(this.commentRepo.create({
        ticket_id: ticketId,
        author_type: 'system',
        author_id: '',
        author: 'System',
        content,
        type: 'system',
      }));
    } catch (err) {
      this.logService.error('SystemComment', 'Failed to create system comment', { error: String(err) });
    }
  }
}
