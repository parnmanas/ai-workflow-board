import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { activityEvents } from '../activity.service';
import { LogService } from '../log.service';
import { decrypt } from '../encryption.service';
import { UserChannel } from '../../entities/UserChannel';
import { Ticket } from '../../entities/Ticket';
import { ActivityLog } from '../../entities/ActivityLog';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { NotificationProviderRegistry } from './registry.service';
import { NotifyPayload } from './types';

interface UserMentionEvent {
  mention_id: string;
  user_id: string;
  workspace_id: string;
  source_type: 'comment' | 'chat_message';
  source_id: string;
  ticket_id: string | null;
  board_id: string | null;
  room_id: string | null;
  actor_id: string;
  actor_type: string;
  actor_name: string;
  preview: string;
  created_at: string;
}

interface ChatRoomMessageEvent {
  room_id: string;
  workspace_id: string;
  message_id: string;
  sender_type: 'user' | 'agent';
  sender_id: string;
  sender_name: string;
  type?: 'message' | 'progress';
  content: string;
  // Upstream forwards the Set returned by RoomMembershipService.getRoomMemberIds()
  // unchanged; allow either shape and normalize at the listener.
  member_ids?: Set<string> | string[];
  created_at: string;
}

/**
 * Listens for `user_mention` activity events and fans them out to each of
 * the target user's active per-user notification channels (UserChannel rows).
 *
 * Sibling of NotificationService (which handles ticket-bound channel_ids ➜
 * Discord broadcast). The two are intentionally decoupled: this surface is
 * "AWB → user inbox", the legacy one is "ticket → workspace ops channel".
 */
@Injectable()
export class UserChannelDispatcherService implements OnModuleInit, OnModuleDestroy {
  private mentionListener: (ev: UserMentionEvent) => void;
  private chatListener: (ev: ChatRoomMessageEvent) => void;
  private activityListener: (log: ActivityLog) => void;

  constructor(
    @InjectRepository(UserChannel) private readonly userChannelRepo: Repository<UserChannel>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(TicketRoleAssignment) private readonly assignRepo: Repository<TicketRoleAssignment>,
    private readonly registry: NotificationProviderRegistry,
    private readonly logService: LogService,
  ) {}

  onModuleInit() {
    this.mentionListener = (ev: UserMentionEvent) => {
      // Fire-and-forget: provider sends are I/O-bound and we don't want to
      // block the event-emit caller on slow third-party APIs.
      this._handleMention(ev).catch((err) => {
        this.logService.error('UserChannel:Dispatcher', 'Unhandled mention dispatch error', { error: String(err) });
      });
    };
    this.chatListener = (ev: ChatRoomMessageEvent) => {
      this._handleChat(ev).catch((err) => {
        this.logService.error('UserChannel:Dispatcher', 'Unhandled chat dispatch error', { error: String(err) });
      });
    };
    this.activityListener = (log: ActivityLog) => {
      this._handleActivity(log).catch((err) => {
        this.logService.error('UserChannel:Dispatcher', 'Unhandled activity dispatch error', { error: String(err) });
      });
    };
    activityEvents.on('user_mention', this.mentionListener);
    activityEvents.on('chat_room_message', this.chatListener);
    activityEvents.on('activity', this.activityListener);
    this.logService.info('UserChannel:Dispatcher', 'Service initialized');
  }

  onModuleDestroy() {
    if (this.mentionListener) activityEvents.removeListener('user_mention', this.mentionListener);
    if (this.chatListener) activityEvents.removeListener('chat_room_message', this.chatListener);
    if (this.activityListener) activityEvents.removeListener('activity', this.activityListener);
  }

  /**
   * Send a notification through every active UserChannel of `user_id`,
   * filtered by `notifyKey` (e.g. 'notify_mention').
   * Used by the dispatcher and exposed for direct calls (e.g. test endpoint).
   */
  async dispatchForUser(
    user_id: string,
    notifyKey: 'notify_mention' | 'notify_chat' | 'notify_ticket',
    payload: NotifyPayload,
  ): Promise<{ sent: number; failed: number }> {
    const bindings = await this.userChannelRepo.find({ where: { user_id, is_active: 1 } });
    const eligible = bindings.filter((b) => (b as any)[notifyKey] === 1);
    if (eligible.length === 0) return { sent: 0, failed: 0 };

    let sent = 0;
    let failed = 0;
    await Promise.all(eligible.map(async (binding) => {
      const provider = this.registry.get(binding.provider);
      if (!provider) {
        this.logService.warn('UserChannel:Dispatcher', `Unknown provider "${binding.provider}" on binding ${binding.id}`);
        failed += 1;
        return;
      }
      const creds = this._readCredentials(binding);
      const res = await provider.send(binding.target, creds, payload).catch((err): { ok: false; error: string } => ({
        ok: false,
        error: String(err),
      }));
      if (res.ok) {
        sent += 1;
      } else {
        failed += 1;
        this.logService.warn(
          'UserChannel:Dispatcher',
          `Provider ${binding.provider} send failed on binding ${binding.id}: ${res.error}`,
        );
      }
    }));
    return { sent, failed };
  }

  private async _handleMention(ev: UserMentionEvent): Promise<void> {
    if (!ev.user_id) return;

    const url = this._buildDeepLink(ev);
    const sourceLabel = ev.source_type === 'chat_message' ? 'chat message' : 'comment';
    const payload: NotifyPayload = {
      title: `You were mentioned in a ${sourceLabel}`,
      body: ev.preview || '',
      actor: ev.actor_name || undefined,
      url: url || undefined,
    };

    const result = await this.dispatchForUser(ev.user_id, 'notify_mention', payload);
    if (result.sent > 0 || result.failed > 0) {
      this.logService.info(
        'UserChannel:Dispatcher',
        `Mention dispatched to user ${ev.user_id}: sent=${result.sent} failed=${result.failed}`,
      );
    }
  }

  /**
   * Fan a chat-room message out to each room member's user channels (with
   * `notify_chat=1`). The sender themselves is excluded so a user never
   * gets a Discord ping for their own message.
   *
   * Mention dispatch already covered in `_handleMention`, so this listener
   * skips users who would also be receiving a `user_mention` event for
   * the same message.
   */
  private async _handleChat(ev: ChatRoomMessageEvent): Promise<void> {
    // Progress heartbeats (tool-call narration) are visible live in the room
    // but not actionable chat — never fire external notifications for them.
    if (ev.type === 'progress') return;

    const memberIds = Array.from(ev.member_ids || []).filter((id) => !!id && id !== ev.sender_id);
    if (memberIds.length === 0) return;

    // Skip pure-mention deliveries — those go through user_mention with the
    // richer "you were mentioned" framing. We only want this listener to
    // surface ambient room activity, not duplicate mention pings. Heuristic:
    // strip @[…] tokens and anything left? deliver here.
    const ambientContent = ev.content.replace(/@\[[^\]]+\]/g, '').trim();
    if (!ambientContent) return;

    const url = process.env.AWB_PUBLIC_URL
      ? `${process.env.AWB_PUBLIC_URL.replace(/\/$/, '')}/ws/${ev.workspace_id}/chat?room=${ev.room_id}&message=${ev.message_id}`
      : undefined;

    const payload: NotifyPayload = {
      title: `New chat message`,
      body: ev.content.slice(0, 500),
      actor: ev.sender_name || undefined,
      url,
    };

    let totalSent = 0;
    let totalFailed = 0;
    await Promise.all(memberIds.map(async (memberId) => {
      const r = await this.dispatchForUser(memberId, 'notify_chat', payload);
      totalSent += r.sent;
      totalFailed += r.failed;
    }));
    if (totalSent > 0 || totalFailed > 0) {
      this.logService.info(
        'UserChannel:Dispatcher',
        `Chat dispatched in room ${ev.room_id}: members=${memberIds.length} sent=${totalSent} failed=${totalFailed}`,
      );
    }
  }

  /**
   * Ticket activity → notify role-assigned humans (assignee/reporter/reviewer)
   * with `notify_ticket=1`. Comment activity is intentionally skipped here
   * since the comment-mention path already covers the pinged users; a
   * future setting could surface "all comments on tickets I own".
   */
  private async _handleActivity(log: ActivityLog): Promise<void> {
    if (log.entity_type !== 'ticket') return;
    const notifyActions = ['created', 'updated', 'moved', 'status_changed', 'deleted'];
    if (!notifyActions.includes(log.action)) return;

    const ticketId = log.entity_id;
    if (!ticketId) return;
    const ticket = await this.ticketRepo.findOne({ where: { id: ticketId } }).catch(() => null);
    if (!ticket) return;

    const assignments = await this.assignRepo.find({ where: { ticket_id: ticketId } }).catch(() => [] as TicketRoleAssignment[]);
    const userIds = Array.from(new Set(
      assignments.map((a) => a.user_id).filter((id): id is string => !!id && id !== log.actor_id),
    ));
    if (userIds.length === 0) return;

    const url = process.env.AWB_PUBLIC_URL
      ? `${process.env.AWB_PUBLIC_URL.replace(/\/$/, '')}/?ticket=${ticketId}`
      : undefined;

    const action = log.action.replace('_', ' ');
    const fieldNote = log.field_changed
      ? `${log.field_changed}${log.old_value || log.new_value ? `: ${log.old_value || '∅'} → ${log.new_value || '∅'}` : ''}`
      : '';

    const payload: NotifyPayload = {
      title: `Ticket ${action}: ${ticket.title}`,
      body: fieldNote,
      actor: log.actor_name || undefined,
      url,
    };

    let totalSent = 0;
    let totalFailed = 0;
    await Promise.all(userIds.map(async (uid) => {
      const r = await this.dispatchForUser(uid, 'notify_ticket', payload);
      totalSent += r.sent;
      totalFailed += r.failed;
    }));
    if (totalSent > 0 || totalFailed > 0) {
      this.logService.info(
        'UserChannel:Dispatcher',
        `Ticket activity dispatched for ticket ${ticketId}: users=${userIds.length} sent=${totalSent} failed=${totalFailed}`,
      );
    }
  }

  private _readCredentials(binding: UserChannel): Record<string, string> {
    if (!binding.credentials) return {};
    try {
      const decrypted = decrypt(binding.credentials);
      const parsed = JSON.parse(decrypted || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      this.logService.error('UserChannel:Dispatcher', `Failed to read credentials for binding ${binding.id}`, { error: String(err) });
      return {};
    }
  }

  /**
   * Stitch together a deep link to the source the mention happened in. The
   * AWB UI itself derives the same URL from `user_mention` SSE payloads —
   * we mirror the same shape here so external notifications point to the
   * same view the in-app inbox would.
   */
  private _buildDeepLink(ev: UserMentionEvent): string | null {
    const base = process.env.AWB_PUBLIC_URL?.replace(/\/$/, '') || '';
    if (!base) return null;
    if (ev.source_type === 'chat_message' && ev.room_id) {
      const params = new URLSearchParams({ room: ev.room_id, message: ev.source_id });
      return `${base}/ws/${ev.workspace_id}/chat?${params.toString()}`;
    }
    if (ev.ticket_id && ev.board_id) {
      const params = new URLSearchParams({ ticket: ev.ticket_id, comment: ev.source_id });
      return `${base}/ws/${ev.workspace_id}/boards/${ev.board_id}?${params.toString()}`;
    }
    return null;
  }
}
