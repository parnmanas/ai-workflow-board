import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { activityEvents } from './activity.service';
import { DiscordService } from './discord.service';
import { LogService } from './log.service';
import { Ticket } from '../entities/Ticket';
import { Comment } from '../entities/Comment';
import { User } from '../entities/User';
import { BoardColumn } from '../entities/BoardColumn';
import { ActivityLog } from '../entities/ActivityLog';

const ACTION_COLORS: Record<string, number> = {
  created: 0x34d399,
  updated: 0x60a5fa,
  moved: 0xfbbf24,
  deleted: 0xef4444,
  status_changed: 0xa78bfa,
};

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private activityListener: (log: ActivityLog) => void;

  constructor(
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    private readonly discordService: DiscordService,
    private readonly logService: LogService,
  ) {}

  /** Walk from a ticket up to the root, returning the hierarchy path (top-down). */
  private async getTicketHierarchy(ticketId: string): Promise<Ticket[]> {
    const hierarchy: Ticket[] = [];
    const visited = new Set<string>();
    let current = await this.ticketRepo.findOne({ where: { id: ticketId } });
    while (current && hierarchy.length < 10) {
      if (visited.has(current.id)) {
        this.logService.warn('Notification', `Circular parent reference detected at ticket ${current.id}`);
        break;
      }
      visited.add(current.id);
      hierarchy.unshift(current); // prepend so root is first
      if (!current.parent_id) break;
      current = await this.ticketRepo.findOne({ where: { id: current.parent_id } });
    }
    return hierarchy;
  }

  /** Collect channel_ids from a ticket and all its ancestors (deduplicated). */
  private async collectChannelIds(ticketId: string): Promise<string[]> {
    const hierarchy = await this.getTicketHierarchy(ticketId);
    const allIds = new Set<string>();
    for (const t of hierarchy) {
      try {
        const ids: string[] = JSON.parse(t.channel_ids || '[]');
        ids.forEach(id => allIds.add(id));
      } catch {}
    }
    return [...allIds];
  }

  onModuleDestroy() {
    if (this.activityListener) {
      activityEvents.removeListener('activity', this.activityListener);
    }
  }

  onModuleInit() {
    this.activityListener = async (log: ActivityLog) => {
      try {
        const notifyActions = ['created', 'updated', 'moved', 'status_changed', 'deleted'];
        if (!notifyActions.includes(log.action)) {
          this.logService.debug('Notification', `Skipped: action "${log.action}" not in notify list`, { ticket_id: log.ticket_id });
          return;
        }

        this.logService.info('Notification', `Processing: ${log.action} on ${log.entity_type} #${log.entity_id}`, {
          ticket_id: log.ticket_id, field_changed: log.field_changed,
        });

        // For subtask changes, collect channel_ids from the changed ticket itself
        // and all ancestor tickets to ensure parent watchers get notified
        const changedTicketId = log.entity_type === 'ticket' ? log.entity_id : log.ticket_id;
        let ticketChannelIds: string[] = [];
        if (changedTicketId) {
          ticketChannelIds = await this.collectChannelIds(changedTicketId);
          this.logService.debug('Notification', `Collected channel_ids (incl. ancestors): [${ticketChannelIds.join(', ')}]`);
        }

        if (ticketChannelIds.length === 0) {
          this.logService.info('Notification', 'Skipped: no channel_ids on ticket or ancestors', { ticket_id: log.ticket_id });
          return;
        }

        const channels = await this.discordService.getChannelsByIds(ticketChannelIds);
        this.logService.debug('Notification', `Active channels found: ${channels.length}`, {
          ids: channels.map(c => c.id), names: channels.map(c => c.name),
        });
        if (channels.length === 0) {
          this.logService.info('Notification', 'Skipped: no active channels found for IDs', { channelIds: ticketChannelIds });
          return;
        }

        const filteredChannels = channels.filter(ch => {
          if (log.action === 'status_changed' || log.action === 'moved') return !!ch.notify_on_status_change;
          if (log.action === 'updated') return !!ch.notify_on_update;
          if (log.entity_type === 'comment') return !!ch.notify_on_comment;
          return true;
        });

        if (filteredChannels.length === 0) {
          this.logService.info('Notification', `Skipped: all channels filtered out for action "${log.action}"`, {
            channelSettings: channels.map(c => ({
              name: c.name, notify_on_status_change: c.notify_on_status_change,
              notify_on_update: c.notify_on_update, notify_on_comment: c.notify_on_comment,
            })),
          });
          return;
        }

        const message = await this.buildNotificationMessage(log);
        if (!message) {
          this.logService.warn('Notification', 'Skipped: buildNotificationMessage returned null');
          return;
        }

        for (const channel of filteredChannels) {
          const ok = await this.discordService.sendDiscordMessage(channel, message);
          this.logService.info('Notification', `Discord send to "${channel.name}": ${ok ? 'OK' : 'FAILED'}`);
        }
      } catch (err) {
        this.logService.error('Notification', 'Error processing activity', { error: String(err), stack: (err as Error)?.stack });
      }
    };
    activityEvents.on('activity', this.activityListener);

    this.logService.info('Notification', 'Service initialized');
  }

  /** Build a hierarchy breadcrumb string like "RootTicket > ChildTicket > GrandchildTicket" */
  private async buildHierarchyBreadcrumb(ticketId: string): Promise<string> {
    const hierarchy = await this.getTicketHierarchy(ticketId);
    if (hierarchy.length <= 1) return ''; // no breadcrumb for root tickets
    return hierarchy.map(t => t.title).join(' > ');
  }

  private async buildNotificationMessage(log: ActivityLog): Promise<{ content: string; embeds: any[] } | null> {
    let ticketTitle = '';
    let reporterId = '';
    let reporterName = '';
    let assigneeId = '';
    let assigneeName = '';
    let isChildTicket = false;

    if (log.entity_type === 'comment') {
      // Comment notification: load the parent ticket info
      const ticket = await this.ticketRepo.findOne({ where: { id: log.ticket_id } });
      if (ticket) {
        ticketTitle = ticket.title;
        reporterId = ticket.reporter_id;
        reporterName = ticket.reporter;
        assigneeId = ticket.assignee_id;
        assigneeName = ticket.assignee;
        isChildTicket = ticket.depth > 0;
      }

      const reporterDiscordId = await this.resolveDiscordId(reporterId, reporterName);
      const assigneeDiscordId = await this.resolveDiscordId(assigneeId, assigneeName);
      const mentions = new Set<string>();
      if (reporterDiscordId) mentions.add(`<@${reporterDiscordId}>`);
      if (assigneeDiscordId) mentions.add(`<@${assigneeDiscordId}>`);
      const mentionStr = [...mentions].join(' ');

      const hierarchyBreadcrumb = isChildTicket
        ? await this.buildHierarchyBreadcrumb(log.ticket_id)
        : '';

      // Truncate comment content for notification
      const commentContent = log.new_value
        ? (log.new_value.length > 200 ? log.new_value.substring(0, 200) + '...' : log.new_value)
        : '';

      let description = '';
      if (hierarchyBreadcrumb) {
        description += `**Hierarchy**: ${hierarchyBreadcrumb}\n`;
      }
      description += `**Ticket**: ${ticketTitle}`;
      if (commentContent) description += `\n\n💬 ${commentContent}`;

      const assigneeDisplay = assigneeDiscordId ? `<@${assigneeDiscordId}>` : assigneeName;
      const reporterDisplay = reporterDiscordId ? `<@${reporterDiscordId}>` : reporterName;
      if (assigneeDisplay) description += `\n\n**Assignee**: ${assigneeDisplay}`;
      if (reporterDisplay) description += `\n**Reporter**: ${reporterDisplay}`;
      if (log.actor_name) description += `\n**By**: ${log.actor_name}`;

      const titlePrefix = isChildTicket ? '[Subtask] ' : '';

      return {
        content: mentionStr ? `${mentionStr} New comment:` : '',
        embeds: [{
          title: `${titlePrefix}💬 NEW COMMENT: ${ticketTitle}`,
          description,
          color: 0x38bdf8,
          timestamp: new Date().toISOString(),
        }],
      };
    }

    if (log.entity_type === 'ticket') {
      const ticket = await this.ticketRepo.findOne({ where: { id: log.entity_id } });
      if (ticket) {
        ticketTitle = ticket.title;
        reporterId = ticket.reporter_id;
        reporterName = ticket.reporter;
        assigneeId = ticket.assignee_id;
        assigneeName = ticket.assignee;
        isChildTicket = ticket.depth > 0;
      }
    } else if (log.entity_type === 'subtask') {
      // Subtasks are now child tickets
      const childTicket = await this.ticketRepo.findOne({
        where: { id: log.entity_id },
      });
      if (childTicket) {
        ticketTitle = childTicket.title;
        reporterId = childTicket.reporter_id;
        reporterName = childTicket.reporter;
        assigneeId = childTicket.assignee_id;
        assigneeName = childTicket.assignee;
        isChildTicket = true;
      }
    }

    if (log.ticket_id && !ticketTitle) {
      const ticket = await this.ticketRepo.findOne({ where: { id: log.ticket_id } });
      if (ticket) {
        ticketTitle = ticket.title;
        if (!reporterId) reporterId = ticket.reporter_id;
        if (!reporterName) reporterName = ticket.reporter;
        if (!assigneeId) assigneeId = ticket.assignee_id;
        if (!assigneeName) assigneeName = ticket.assignee;
      }
    }

    const reporterDiscordId = await this.resolveDiscordId(reporterId, reporterName);
    const assigneeDiscordId = await this.resolveDiscordId(assigneeId, assigneeName);
    const mentions = new Set<string>();
    if (reporterDiscordId) mentions.add(`<@${reporterDiscordId}>`);
    if (assigneeDiscordId) mentions.add(`<@${assigneeDiscordId}>`);
    const mentionStr = [...mentions].join(' ');

    const actionLabel = log.action.replace('_', ' ').toUpperCase();

    // Build hierarchy breadcrumb for child tickets
    const hierarchyBreadcrumb = isChildTicket
      ? await this.buildHierarchyBreadcrumb(log.entity_id)
      : '';

    let description = '';
    if (hierarchyBreadcrumb) {
      description += `**Hierarchy**: ${hierarchyBreadcrumb}\n`;
    }
    description += `**${log.entity_type.toUpperCase()}** #${log.entity_id} — ${ticketTitle}`;

    if (log.field_changed) {
      description += `\n**Field**: ${log.field_changed}`;
      if (log.old_value) description += `\n**From**: ${log.old_value}`;
      if (log.new_value) description += `\n**To**: ${log.new_value}`;
    }

    const assigneeDisplay = assigneeDiscordId ? `<@${assigneeDiscordId}>` : assigneeName;
    const reporterDisplay = reporterDiscordId ? `<@${reporterDiscordId}>` : reporterName;
    if (assigneeDisplay) description += `\n**Assignee**: ${assigneeDisplay}`;
    if (reporterDisplay) description += `\n**Reporter**: ${reporterDisplay}`;
    if (log.actor_name) description += `\n**By**: ${log.actor_name}`;

    const titlePrefix = isChildTicket ? `[Subtask] ${actionLabel}` : actionLabel;

    return {
      content: mentionStr ? `${mentionStr} Ticket update:` : '',
      embeds: [{
        title: `${titlePrefix}: ${ticketTitle}`,
        description,
        color: ACTION_COLORS[log.action] || 0x94a3b8,
        timestamp: new Date().toISOString(),
      }],
    };
  }

  private async resolveDiscordId(id: string, name: string): Promise<string> {
    // Agent-to-Discord mapping was removed with AgentChannelIdentity — only
    // user.discord_user_id remains. Agents don't get @-mentioned in Discord
    // anymore; their activity is reported through the channel but without
    // a per-agent mention target.
    if (id) {
      const user = await this.userRepo.findOne({ where: { id } }).catch(() => null);
      if (user?.discord_user_id) return user.discord_user_id;
    }
    if (name) {
      const user = await this.userRepo.findOne({ where: { name } }).catch(() => null);
      if (user?.discord_user_id) return user.discord_user_id;
    }
    return '';
  }

  private async resolveColumnName(columnId: string): Promise<string> {
    if (!columnId) return '';
    const col = await this.colRepo.findOne({ where: { id: columnId } });
    return col ? col.name : `Column #${columnId}`;
  }
}
