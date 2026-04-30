import { ApiTags } from '@nestjs/swagger';
import { Controller, Sse, Req, Header, UnauthorizedException, OnModuleDestroy, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Request } from 'express';
import { Observable, Subject, filter, map, finalize, of, merge, interval } from 'rxjs';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { ActivityLog } from '../../entities/ActivityLog';
import { activityEvents } from '../../services/activity.service';
import { AuthService } from '../../services/auth.service';
import { ApiKeyService } from '../../services/api-key.service';
import { LogService } from '../../services/log.service';
import { StreamEvent } from '../../common/types/stream-events';
import { EVENT_TYPES } from './event-registry';
import { EventDefinition, EventMapContext, SubscriberIdentity } from './types';

interface RegisteredListener {
  def: EventDefinition;
  handler: (rawEvent: any) => void;
}

interface SseSessionDetail {
  session_id: string;       // server-generated UUID for this SSE connection
  connected_at: string;     // ISO timestamp
  ip: string;               // peer IP (x-real-ip / x-forwarded-for / req.ip)
  user_agent: string;       // request user-agent header
  board_id: string | null;  // boardId scope from query string (proxies pass 'all')
}

@ApiTags('events')
@Controller('api/events')
export class EventsController implements OnModuleDestroy {
  private readonly eventSubject = new Subject<StreamEvent>();
  private clientCount = 0;
  // Tracks live SSE connections per agent_id with full per-connection
  // detail (connect timestamp, peer IP, user-agent, board scope). The
  // Agent Details modal renders the list so the user can see whether
  // multiple proxies are actually concurrent — including the case where
  // a SINGLE Claude Code session opens more than one SSE stream (each
  // claude CLI MCP-client lifecycle phase can create its own connection),
  // which a bare count would obscure.
  private readonly agentSseSessions = new Map<string, Map<string, SseSessionDetail>>();
  private readonly listeners: RegisteredListener[] = [];

  constructor(
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly apiKeyService: ApiKeyService,
    private readonly logService: LogService,
  ) {
    // Table-driven listener registration: EVENT_TYPES drives everything.
    // One loop replaces the 9 hand-written listener blocks that previously lived here.
    const mapCtx: EventMapContext = {
      resolveBoardId: (ticketId, entityId) => this.resolveBoardId(ticketId, entityId),
    };

    for (const def of EVENT_TYPES) {
      const handler = async (rawEvent: any) => {
        try {
          const mapped = await def.map(rawEvent, mapCtx);
          if (!mapped) return;
          const envelope: StreamEvent = {
            event_type: def.eventType,
            scope: mapped.scope,
            payload: mapped.payload,
            timestamp: mapped.timestamp || new Date().toISOString(),
          };
          this.eventSubject.next(envelope);
        } catch (err) {
          this.logService.error('SSE', `Failed to process ${def.emitterEvent} event: ${err}`);
        }
      };
      activityEvents.on(def.emitterEvent, handler);
      this.listeners.push({ def, handler });
    }
  }

  onModuleDestroy() {
    for (const { def, handler } of this.listeners) {
      activityEvents.removeListener(def.emitterEvent, handler);
    }
    this.listeners.length = 0;
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
    const token =
      (req.query.token as string) ||
      req.headers['authorization']?.toString().replace('Bearer ', '');
    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    // Try user session auth first, then API key auth
    let authIdentity: SubscriberIdentity | null = null;

    const user = await this.authService.getSessionUser(token);
    if (user) {
      authIdentity = {
        type: 'user',
        name: user.name || user.email || 'user',
        userId: user.id,
      };
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
      } catch {
        /* key validation failed, authIdentity stays null */
      }
    }

    if (!authIdentity) {
      throw new UnauthorizedException('Invalid or expired session/API key');
    }

    const identity: SubscriberIdentity = {
      ...authIdentity,
      boardId: (req.query.boardId as string) || undefined,
    };

    this.clientCount++;
    const sseSessionId = randomUUID();
    let proxyCountNow = 0;
    if (identity.agentId) {
      const detail: SseSessionDetail = {
        session_id: sseSessionId,
        connected_at: new Date().toISOString(),
        ip: this._extractIp(req),
        user_agent: String(req.headers['user-agent'] || '').slice(0, 200),
        board_id: identity.boardId || null,
      };
      let bucket = this.agentSseSessions.get(identity.agentId);
      if (!bucket) { bucket = new Map(); this.agentSseSessions.set(identity.agentId, bucket); }
      bucket.set(sseSessionId, detail);
      proxyCountNow = bucket.size;
      // ActivityLog entry so this connect lands in the agent's Recent
      // Activity feed alongside ticket events.
      this._recordProxyActivity(identity.agentId, identity.name, 'proxy_connected', detail);
    }
    this.logService.info(
      'SSE',
      `Client connected (${identity.type}: ${identity.name}, board: ${
        identity.boardId || 'all'
      }, total: ${this.clientCount}${identity.agentId ? `, agent_proxies=${proxyCountNow}` : ''})`,
    );

    // Quick lookup: event_type → EventDefinition.
    const registry = new Map<string, EventDefinition>(
      EVENT_TYPES.map((def) => [def.eventType, def]),
    );

    // Emit protocol version on connect so clients can detect legacy/mismatch (CHAT-20)
    const versionEvent = of({
      data: JSON.stringify({ chat_protocol_version: 2 }),
      type: 'server_meta',
    } as MessageEvent);

    // Keepalive — push a named `ping` event every 15s so reverse proxies
    // (nginx/ALB/Cloudflare) don't hit their idle-connection timeout and
    // kill the stream with 502/terminated after 1-5 min of silence. The
    // EventSource client ignores unknown event types, so this is a no-op on
    // the consumer side beyond keeping the TCP connection warm.
    const KEEPALIVE_MS = 15_000;
    const keepalive = interval(KEEPALIVE_MS).pipe(
      map(() => ({ data: JSON.stringify({ ts: Date.now() }), type: 'ping' } as MessageEvent)),
    );

    return merge(
      versionEvent,
      keepalive,
      this.eventSubject.pipe(
        filter((event: StreamEvent) => {
          const def = registry.get(event.event_type);
          if (!def) return false;
          return def.filter ? def.filter(event, identity) : true;
        }),
        map((event: StreamEvent) => {
          const def = registry.get(event.event_type);
          // Legacy types flatten payload fields up for proxy.mjs; newer types ship the
          // envelope natively (no flatten fn → envelope as-is).
          const dataObj = def?.flatten ? def.flatten(event) : event;
          return {
            data: JSON.stringify(dataObj),
            type: event.event_type,
          } as MessageEvent;
        }),
        finalize(() => {
          this.clientCount--;
          let endedDetail: SseSessionDetail | undefined;
          let bucketSize = 0;
          if (identity.agentId) {
            const bucket = this.agentSseSessions.get(identity.agentId);
            if (bucket) {
              endedDetail = bucket.get(sseSessionId);
              bucket.delete(sseSessionId);
              bucketSize = bucket.size;
              if (bucketSize === 0) this.agentSseSessions.delete(identity.agentId);
            }
            if (endedDetail) {
              this._recordProxyActivity(identity.agentId, identity.name, 'proxy_disconnected', endedDetail);
            }
          }
          this.logService.info('SSE', `Client disconnected (total: ${this.clientCount}${identity.agentId ? `, agent_proxies=${bucketSize}` : ''})`);
        }),
      ),
    );
  }

  /**
   * Snapshot of live SSE connections per agent_id with full per-session
   * detail. The dashboard's Agent Details modal renders the list so the
   * user can spot multi-proxy situations directly: connect timestamp +
   * peer IP + user-agent let them tell apart "two terminals on this host"
   * vs "Claude CLI internally opens two streams for one session" vs
   * "remote workstation also connected".
   */
  @Get('active-agent-sessions')
  @UseGuards(AuthGuard)
  getActiveAgentSessions(): Record<string, SseSessionDetail[]> {
    const out: Record<string, SseSessionDetail[]> = {};
    for (const [agentId, bucket] of this.agentSseSessions) {
      out[agentId] = Array.from(bucket.values()).sort((a, b) =>
        a.connected_at.localeCompare(b.connected_at),
      );
    }
    return out;
  }

  private _extractIp(req: Request): string {
    const xri = req.headers['x-real-ip'];
    if (typeof xri === 'string' && xri) return xri;
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    return req.ip || '';
  }

  /**
   * Stash the proxy connect/disconnect event on the agent's ActivityLog
   * timeline. actor_id = agent_id so it surfaces in `getAgentActivity` and
   * the existing dashboard "Recent Activity" feed without any wiring on
   * the consumer side. Best-effort: a write failure shouldn't break the
   * SSE pipeline, so errors are swallowed with a log warning.
   */
  private _recordProxyActivity(
    agentId: string,
    agentName: string,
    action: 'proxy_connected' | 'proxy_disconnected',
    detail: SseSessionDetail,
  ): void {
    const repo = this.dataSource.getRepository(ActivityLog);
    repo
      .save(
        repo.create({
          entity_type: 'agent',
          entity_id: agentId,
          actor_id: agentId,
          actor_name: agentName,
          action,
          field_changed: 'proxy_session',
          old_value: '',
          new_value: JSON.stringify(detail),
        }),
      )
      .catch((e: unknown) => {
        this.logService.warn('SSE', 'proxy activity log save failed', { err: e });
      });
  }
}
