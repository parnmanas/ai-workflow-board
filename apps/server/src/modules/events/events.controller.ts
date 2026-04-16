import { Controller, Sse, Query, Req, Header, UnauthorizedException, OnModuleDestroy } from '@nestjs/common';
import { Request } from 'express';
import { Observable, Subject, filter, map, finalize, of, merge } from 'rxjs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { activityEvents } from '../../services/activity.service';
import { AuthService } from '../../services/auth.service';
import { ApiKeyService } from '../../services/api-key.service';
import { LogService } from '../../services/log.service';
import {
  StreamEvent,
  BoardUpdatePayload,
  AgentTypingPayload,
  AgentTriggerPayload,
  ChatMessagePayload,
  AgentStatusPayload,
  ChatRequestPayload,      // Phase 4 D-71/D-72
  ChatRoomMessagePayload,  // Phase 7
  ChatRoomUpdatePayload,   // Phase 7
} from '../../common/types/stream-events';

@Controller('api/events')
export class EventsController implements OnModuleDestroy {
  private readonly eventSubject = new Subject<StreamEvent>();
  private clientCount = 0;
  private readonly activityListener: (activity: any) => void;
  private readonly typingListener: (event: any) => void;
  private readonly triggerListener: (event: any) => void;
  private readonly chatListener: (event: any) => void;
  private readonly agentStatusListener: (event: any) => void;
  private readonly chatRequestListener: (event: any) => void;
  private readonly chatRoomMessageListener: (event: any) => void;
  private readonly chatRoomUpdateListener: (event: any) => void;

  constructor(
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    private readonly authService: AuthService,
    private readonly apiKeyService: ApiKeyService,
    private readonly logService: LogService,
  ) {
    // Subscribe to activity events and enrich with board_id
    this.activityListener = async (activity: any) => {
      try {
        const boardId = await this.resolveBoardId(activity.ticket_id, activity.entity_id);
        if (!boardId) return;
        const payload: BoardUpdatePayload = {
          ticket_id: activity.ticket_id,
          entity_type: activity.entity_type,
          action: activity.action,
          field_changed: activity.field_changed || '',
          actor_name: activity.actor_name || '',
        };
        const envelope: StreamEvent<BoardUpdatePayload> = {
          event_type: 'board_update',
          scope: { board_id: boardId },
          payload,
          timestamp: new Date().toISOString(),
        };
        this.eventSubject.next(envelope);
      } catch (err) {
        this.logService.error('SSE', `Failed to process activity event: ${err}`);
      }
    };
    activityEvents.on('activity', this.activityListener);

    this.typingListener = (event: any) => {
      const payload: AgentTypingPayload = {
        ticket_id: event.ticket_id,
        agent_id: event.agent_id,
        is_typing: !!event.is_typing,
      };
      const envelope: StreamEvent<AgentTypingPayload> = {
        event_type: 'agent_typing',
        scope: {}, // typing events are broadcast (no scope filter)
        payload,
        timestamp: event.timestamp || new Date().toISOString(),
      };
      this.eventSubject.next(envelope);
    };
    activityEvents.on('agent_typing', this.typingListener);

    // Push trigger events to agents connected via SSE
    this.triggerListener = (event: any) => {
      const payload: AgentTriggerPayload = {
        trigger_id: event.trigger_id || '',
        ticket_id: event.ticket_id,
        agent_id: event.agent_id,
        role: event.role || '',
        role_prompt: event.role_prompt || '',      // D-20 — producer in Task 3
        ticket_prompt: event.ticket_prompt || '',  // D-20 — producer in Task 3
        trigger_source: event.trigger_source || '',
      };
      const envelope: StreamEvent<AgentTriggerPayload> = {
        event_type: 'agent_trigger',
        scope: { agent_id: event.agent_id },
        payload,
        timestamp: event.timestamp || new Date().toISOString(),
      };
      this.eventSubject.next(envelope);
    };
    activityEvents.on('agent_trigger', this.triggerListener);

    // Phase 2 D-26 — chat_message SSE producer.
    // ChatService (and the send_chat_message MCP tool) emits 'chat_message' on the
    // activityEvents bus; this listener wraps it into a StreamEvent envelope and
    // pushes it through the per-event-type filter, which routes by scope.user_id
    // (for the authenticated user) or scope.agent_id (for the authenticated agent).
    this.chatListener = (event: any) => {
      const payload: ChatMessagePayload = {
        message_id: event.message_id,
        sender_type: event.sender_type,
        sender_id: event.sender_id,
        recipient_agent_id: event.agent_id,
        content: event.content,
        ticket_id: event.ticket_id || undefined,
        created_at: event.created_at || new Date().toISOString(),
      };
      const envelope: StreamEvent<ChatMessagePayload> = {
        event_type: 'chat_message',
        scope: {
          agent_id: event.agent_id,
          user_id: event.user_id,
          ticket_id: event.ticket_id || undefined,
        },
        payload,
        timestamp: event.created_at || new Date().toISOString(),
      };
      this.eventSubject.next(envelope);
    };
    activityEvents.on('chat_message', this.chatListener);

    // Phase 3 D-40 — agent_status SSE producer.
    // AgentStatusService emits 'agent_status' on the activityEvents bus with the
    // internal Date-containing shape; this listener converts Dates to ISO strings
    // and wraps into a StreamEvent<AgentStatusPayload> envelope. Broadcast to all
    // authenticated subscribers per D-41 (filter branch already returns true).
    this.agentStatusListener = (event: any) => {
      const payload: AgentStatusPayload = {
        agent_id: event.agent_id,
        is_online: !!event.is_online,
        last_seen_at: event.last_seen_at
          ? (event.last_seen_at instanceof Date
              ? event.last_seen_at.toISOString()
              : String(event.last_seen_at))
          : null,
        current_task: event.current_task
          ? {
              ticket_id: event.current_task.ticket_id,
              ticket_title: event.current_task.ticket_title,
              claimed_at: event.current_task.claimed_at instanceof Date
                ? event.current_task.claimed_at.toISOString()
                : String(event.current_task.claimed_at),
            }
          : undefined,
      };
      const envelope: StreamEvent<AgentStatusPayload> = {
        event_type: 'agent_status',
        scope: { agent_id: event.agent_id },
        payload,
        timestamp: new Date().toISOString(),
      };
      this.eventSubject.next(envelope);
    };
    activityEvents.on('agent_status', this.agentStatusListener);

    // Phase 4 D-71/D-72/D-73 — chat_request SSE producer.
    // ChatService.sendUserMessage emits 'chat_request' on activityEvents with role_prompt
    // already fresh-read. Wrap into an envelope-native StreamEvent (NOT flattened — see the
    // map() branch below) and scope by target agent_id so only that agent's connected proxy
    // sees it. Proxy.mjs consumes this to spawn a dedicated chat subagent per conversation.
    this.chatRequestListener = (event: any) => {
      const payload: ChatRequestPayload = {
        agent_id: event.agent_id,
        user_id: event.user_id,
        ticket_id: event.ticket_id || null,
        role_prompt: event.role_prompt || '',
        new_message: event.new_message,
        history: Array.isArray(event.history) ? event.history : [],
      };
      const envelope: StreamEvent<ChatRequestPayload> = {
        event_type: 'chat_request',
        scope: { agent_id: event.agent_id },
        payload,
        timestamp: event.timestamp || new Date().toISOString(),
      };
      this.eventSubject.next(envelope);
    };
    activityEvents.on('chat_request', this.chatRequestListener);

    this.chatRoomMessageListener = (event: any) => {
      const payload: ChatRoomMessagePayload = {
        room_id: event.room_id,
        message_id: event.message_id,
        sender_type: event.sender_type,
        sender_id: event.sender_id,
        sender_name: event.sender_name,
        content: event.content,
        created_at: event.created_at,
      };
      const envelope: StreamEvent<ChatRoomMessagePayload> = {
        event_type: 'chat_room_message',
        scope: {
          room_id: event.room_id,
          member_ids: event.member_ids, // Set<string> — user participant IDs
          agent_member_ids: event.agent_member_ids, // Set<string> — agent participant IDs
        },
        payload,
        timestamp: new Date().toISOString(),
      };
      this.eventSubject.next(envelope);
    };
    activityEvents.on('chat_room_message', this.chatRoomMessageListener);

    this.chatRoomUpdateListener = (event: any) => {
      const payload: ChatRoomUpdatePayload = {
        room_id: event.room_id,
        update_type: event.update_type,
        new_name: event.new_name,
        participant_id: event.participant_id,
        participant_ids: event.participant_ids,
      };
      const envelope: StreamEvent<ChatRoomUpdatePayload> = {
        event_type: 'chat_room_update',
        scope: {
          room_id: event.room_id,
          member_ids: event.member_ids,
          agent_member_ids: event.agent_member_ids,
        },
        payload,
        timestamp: new Date().toISOString(),
      };
      this.eventSubject.next(envelope);
    };
    activityEvents.on('chat_room_update', this.chatRoomUpdateListener);
  }

  onModuleDestroy() {
    activityEvents.removeListener('activity', this.activityListener);
    activityEvents.removeListener('agent_typing', this.typingListener);
    activityEvents.removeListener('agent_trigger', this.triggerListener);
    activityEvents.removeListener('chat_message', this.chatListener);
    activityEvents.removeListener('agent_status', this.agentStatusListener);
    activityEvents.removeListener('chat_request', this.chatRequestListener);
    activityEvents.removeListener('chat_room_message', this.chatRoomMessageListener);
    activityEvents.removeListener('chat_room_update', this.chatRoomUpdateListener);
    this.eventSubject.complete();
  }

  private async resolveBoardId(ticketId: string, entityId: string): Promise<string | null> {
    // Try to find the ticket and its column's board_id
    const id = ticketId || entityId;
    if (!id) return null;

    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return null;

    // If ticket has a column_id, look up the board
    if (ticket.column_id) {
      const col = await this.colRepo.findOne({ where: { id: ticket.column_id } });
      return col?.board_id || null;
    }

    // If it's a subtask, find the root parent's column
    if (ticket.parent_id) {
      const parent = await this.ticketRepo.findOne({ where: { id: ticket.parent_id } });
      if (parent?.column_id) {
        const col = await this.colRepo.findOne({ where: { id: parent.column_id } });
        return col?.board_id || null;
      }
      // depth 2 - go up one more level
      if (parent?.parent_id) {
        const grandparent = await this.ticketRepo.findOne({ where: { id: parent.parent_id } });
        if (grandparent?.column_id) {
          const col = await this.colRepo.findOne({ where: { id: grandparent.column_id } });
          return col?.board_id || null;
        }
      }
    }

    return null;
  }

  @Sse('stream')
  @Header('X-Accel-Buffering', 'no')
  async stream(@Req() req: Request): Promise<Observable<MessageEvent>> {
    // Manual auth check since SSE uses query param for token
    const token = (req.query.token as string) || req.headers['authorization']?.toString().replace('Bearer ', '');
    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    // Try user session auth first, then API key auth
    let authIdentity: { type: 'user' | 'agent'; name: string; agentId?: string; userId?: string } | null = null;

    const user = await this.authService.getSessionUser(token);
    if (user) {
      authIdentity = { type: 'user', name: user.name || user.email || 'user', userId: user.id };
    } else {
      // Try API key (for AI agents)
      try {
        const keyResult = await this.apiKeyService.validateApiKey(token);
        if (keyResult.valid && keyResult.apiKey) {
          authIdentity = {
            type: 'agent',
            name: keyResult.apiKey.agent?.name || keyResult.apiKey.name || 'agent',
            agentId: keyResult.apiKey.agent_id ?? undefined,
          };
        }
      } catch { /* key validation failed, authIdentity stays null */ }
    }

    if (!authIdentity) {
      throw new UnauthorizedException('Invalid or expired session/API key');
    }
    const identity = authIdentity;

    const boardId = req.query.boardId as string;

    this.clientCount++;
    this.logService.info('SSE', `Client connected (${identity.type}: ${identity.name}, board: ${boardId || 'all'}, total: ${this.clientCount})`);

    // Emit protocol version on connect so clients can detect legacy/mismatch (CHAT-20)
    const versionEvent = of({
      data: JSON.stringify({ chat_protocol_version: 2 }),
      type: 'server_meta',
    } as MessageEvent);

    return merge(versionEvent, this.eventSubject.pipe(
      filter((event: StreamEvent) => {
        switch (event.event_type) {
          case 'board_update':
            // D-07: filter by board_id match OR pass through if no boardId requested (existing behavior)
            return !boardId || event.scope.board_id === boardId;
          case 'agent_typing':
            // D-28: chat-mode typing carries a user_id scope → narrow to the scoped
            // user or scoped agent so chat typing indicators do not leak across users.
            // Board-level typing (no user_id scope) still broadcasts for backward compat.
            if (event.scope.user_id) {
              if (identity.type === 'user') return event.scope.user_id === identity.userId;
              if (identity.type === 'agent') return event.scope.agent_id === identity.agentId;
              return false;
            }
            return true;
          case 'agent_trigger':
            // Phase 1 keeps existing broadcast behavior (proxy.mjs filters client-side).
            // D-07 recipient-scoping is skeleton for future tightening.
            return true;
          case 'chat_message':
            // D-07 / D-27: recipient-only. Deliver to the agent whose API key identity
            // matches scope.agent_id, OR the user whose session identity matches
            // scope.user_id. Cross-user leak is impossible because both sides must
            // match strictly (undefined === undefined is NOT a valid match in practice
            // because the chatListener always populates scope.user_id from the bus
            // payload for user-recipient events).
            if (identity.type === 'agent') {
              return event.scope.agent_id === identity.agentId;
            }
            return event.scope.user_id === identity.userId;
          case 'agent_status':
            // D-07: broadcast to all authenticated subscribers
            return true;
          case 'chat_request':
            // D-72: per-agent delivery — only the target agent's connected proxy spawns the chat subagent.
            // Users never see this event type; they see 'chat_message' (the persisted reply) instead.
            if (identity.type === 'agent') return event.scope.agent_id === identity.agentId;
            return false;
          case 'chat_room_message': {
            // CHAT-19: server-side participant filter — room members only
            if (identity.type === 'user') {
              const memberSet = event.scope.member_ids as Set<string> | undefined;
              return memberSet ? memberSet.has(identity.userId!) : false;
            }
            if (identity.type === 'agent') {
              const agentSet = event.scope.agent_member_ids as Set<string> | undefined;
              return agentSet ? agentSet.has(identity.agentId!) : false;
            }
            return false;
          }
          case 'chat_room_update': {
            // Same participant filter for room metadata updates
            if (identity.type === 'user') {
              const memberSet2 = event.scope.member_ids as Set<string> | undefined;
              return memberSet2 ? memberSet2.has(identity.userId!) : false;
            }
            if (identity.type === 'agent') {
              const agentSet2 = event.scope.agent_member_ids as Set<string> | undefined;
              return agentSet2 ? agentSet2.has(identity.agentId!) : false;
            }
            return false;
          }
          default:
            return false;
        }
      }),
      map((event: StreamEvent) => {
        // ─── FLATTEN-ON-EMIT for backward compatibility with proxy.mjs ───
        // proxy.mjs reads ev.ticket_id, ev.action, ev.field_changed, ev.actor_name at
        // the TOP LEVEL of the data JSON. The internal envelope shape is NOT sent on
        // the wire for board_update / agent_trigger / agent_typing — we flatten the
        // payload back up. See .planning/phases/01-foundation/01-RESEARCH.md §P-01.
        // New event types (chat_message, agent_status) ship the envelope natively.
        let dataObj: any;
        if (event.event_type === 'board_update') {
          const p = event.payload as BoardUpdatePayload;
          dataObj = {
            board_id: event.scope.board_id || '',
            event_type: 'board_update',
            ticket_id: p.ticket_id,
            entity_type: p.entity_type,
            action: p.action,
            field_changed: p.field_changed || '',
            actor_name: p.actor_name || '',
            timestamp: event.timestamp,
          };
        } else if (event.event_type === 'agent_trigger') {
          const p = event.payload as AgentTriggerPayload;
          dataObj = {
            board_id: '__trigger__',
            event_type: 'agent_trigger',
            ticket_id: p.ticket_id,
            entity_type: 'trigger',
            action: p.role,
            field_changed: p.trigger_id,
            actor_name: p.agent_id,
            // D-20: new fields added at top level. proxy.mjs ignores unknown fields.
            role_prompt: p.role_prompt,
            ticket_prompt: p.ticket_prompt,
            trigger_source: p.trigger_source,
            timestamp: event.timestamp,
          };
        } else if (event.event_type === 'agent_typing') {
          const p = event.payload as AgentTypingPayload;
          dataObj = {
            board_id: '__typing__',
            event_type: 'agent_typing',
            ticket_id: p.ticket_id,
            entity_type: 'agent',
            action: p.is_typing ? 'started' : 'stopped',
            actor_name: p.agent_id,
            timestamp: event.timestamp,
          };
        } else if (event.event_type === 'chat_room_message') {
          // Send payload directly — client expects ChatRoomMessageItem at top level
          const p = event.payload as ChatRoomMessagePayload;
          dataObj = { ...p, id: p.message_id };
        } else if (event.event_type === 'chat_room_update') {
          // Send payload directly — client expects ChatRoomUpdatePayload at top level
          dataObj = event.payload;
        } else {
          // New event types (chat_message, agent_status) ship the envelope natively.
          dataObj = event;
        }
        return {
          data: JSON.stringify(dataObj),
          type: event.event_type,
        } as MessageEvent;
      }),
      // Cleanup on disconnect
      finalize(() => {
        this.clientCount--;
        this.logService.info('SSE', `Client disconnected (total: ${this.clientCount})`);
      }),
    ));
  }
}
