import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { activityEvents } from './activity.service';
import { DiscordService } from './discord.service';
import { LogService } from './log.service';
import { Ticket } from '../entities/Ticket';
import { Comment } from '../entities/Comment';
import { User } from '../entities/User';
import { ActivityLog } from '../entities/ActivityLog';
import { resolveAgentDisplayName } from '../utils/agent-name';
import { displayNameForRuntime, parseRuntimeSpec } from '../common/runtime-spec';
import { ticketParticipantUserIds } from './notification-providers/ticket-participants';

const ACTION_COLORS: Record<string, number> = {
  created: 0x34d399,
  updated: 0x60a5fa,
  moved: 0xfbbf24,
  deleted: 0xef4444,
  status_changed: 0xa78bfa,
};

interface TicketPeople {
  assignee_name: string;
  creator_name: string;
  creator_user_id: string;
  participant_user_ids: string[];
}

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private activityListener: (log: ActivityLog) => void;

  constructor(
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly discordService: DiscordService,
    private readonly logService: LogService,
  ) {}

  /**
   * Who to show and ping for a ticket. The assignee is an agent (a
   * RuntimeSpec, docs/tickets.md) — shown by its `<Host>/<label>` display,
   * never @-mentioned (agents have no Discord identity). The people pinged are
   * the ticket's human participants: its creator, commenters and mentioned
   * users (ticketParticipantUserIds).
   */
  private async _resolvePeople(ticket: Ticket): Promise<TicketPeople> {
    let assignee_name = '';
    const spec = parseRuntimeSpec(ticket.assignee);
    if (spec) {
      const hostName = await resolveAgentDisplayName(this.dataSource, spec.manager_agent_id);
      assignee_name = displayNameForRuntime(hostName || spec.manager_agent_id.slice(0, 8), spec);
    }
    const creator_user_id = ticket.created_by_type === 'user' ? (ticket.created_by_id || '') : '';
    const participant_user_ids = await ticketParticipantUserIds(this.dataSource, ticket).catch(() => [] as string[]);
    return { assignee_name, creator_name: ticket.created_by || '', creator_user_id, participant_user_ids };
  }

  /** `<@discordId>` for every given participant who linked a Discord account
   *  (callers drop the actor — nobody is pinged about their own change). */
  private async _mentionString(userIds: string[]): Promise<string> {
    const mentions = new Set<string>();
    for (const id of userIds) {
      const discordId = await this.resolveDiscordId(id, '');
      if (discordId) mentions.add(`<@${discordId}>`);
    }
    return [...mentions].join(' ');
  }

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
    let people: TicketPeople | null = null;
    let isChildTicket = false;

    if (log.entity_type === 'comment') {
      // Comment notification: load the parent ticket info
      const ticket = await this.ticketRepo.findOne({ where: { id: log.ticket_id } });
      if (ticket) {
        ticketTitle = ticket.title;
        people = await this._resolvePeople(ticket);
        isChildTicket = ticket.depth > 0;
      }

      const mentionStr = await this._mentionString((people?.participant_user_ids ?? []).filter(id => id !== log.actor_id));

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

      description += await this._peopleLines(people, '\n\n');
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
        people = await this._resolvePeople(ticket);
        isChildTicket = ticket.depth > 0;
      }
    } else if (log.entity_type === 'subtask') {
      // Subtasks are now child tickets
      const childTicket = await this.ticketRepo.findOne({
        where: { id: log.entity_id },
      });
      if (childTicket) {
        ticketTitle = childTicket.title;
        people = await this._resolvePeople(childTicket);
        isChildTicket = true;
      }
    }

    if (log.ticket_id && !ticketTitle) {
      const ticket = await this.ticketRepo.findOne({ where: { id: log.ticket_id } });
      if (ticket) {
        ticketTitle = ticket.title;
        people = await this._resolvePeople(ticket);
      }
    }

    const mentionStr = await this._mentionString((people?.participant_user_ids ?? []).filter(id => id !== log.actor_id));

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

    description += await this._peopleLines(people, '\n');
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

  /** "Assignee" (agent display) + "Created by" (Discord mention when linked) lines. */
  private async _peopleLines(
    people: TicketPeople | null,
    leading: string,
  ): Promise<string> {
    if (!people) return '';
    const lines: string[] = [];
    if (people.assignee_name) lines.push(`**Assignee**: ${people.assignee_name}`);
    const creatorDiscordId = await this.resolveDiscordId(people.creator_user_id, '');
    const creatorDisplay = creatorDiscordId ? `<@${creatorDiscordId}>` : people.creator_name;
    if (creatorDisplay) lines.push(`**Created by**: ${creatorDisplay}`);
    return lines.length > 0 ? leading + lines.join('\n') : '';
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
}
