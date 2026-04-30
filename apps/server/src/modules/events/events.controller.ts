import { ApiTags } from '@nestjs/swagger';
import { Controller, Sse, Req, Header, UnauthorizedException, OnModuleDestroy, Get, Post, Delete, Param, Body, UseGuards } from '@nestjs/common';
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
  ip: string;               // X-Plugin-Ip header from plugin (preferred);
                            // falls back to x-real-ip / x-forwarded-for /
                            // req.ip; 'unknown' if neither resolves
  plugin_version: string;   // X-Plugin-Version header; 'unknown' for
                            // pre-v0.35.5 plugins that don't ship it
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
  /**
   * agent_id → session_id of the user-pinned "main" SSE session for that
   * agent. Populated only when 2+ proxies are concurrently connected for the
   * same agent and the user explicitly picks one via the Agent Details panel
   * (POST /events/active-agent-sessions/:agentId/main).
   *
   * When this map has no entry for an agent, agent-targeted events default
   * to the oldest-connected session (auto-main) so the duplicate-subagent
   * race is avoided even before the user picks. Cleared on disconnect of
   * the pinned session (cleanup() below) and on explicit DELETE.
   */
  private readonly agentMainSession = new Map<string, string>();
  private readonly listeners: RegisteredListener[] = [];

  /**
   * Event types whose delivery to an agent's SSE stream causes the proxy to
   * spawn a subagent or otherwise act on a single-recipient request. With
   * multiple concurrent proxy sessions for the same agent, delivering these
   * to every session would fan out into duplicate subagents racing each
   * other. We pin them to the agent's "main" session (user-picked, or
   * oldest-connected as auto-fallback). Broadcast/observability events
   * (board_update, agent_status, subagent_*, ticket_presence, comment_typing)
   * still flow to every session unchanged.
   */
  private static readonly AGENT_ROUTED_EVENTS = new Set<string>([
    'agent_trigger',
    'comment_mention',
    'chat_request',
    'chat_room_message',
    'chat_room_typing',
    'fs_request',
    'agent_typing',
  ]);

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

    this.clientCount++;
    const sseSessionId = randomUUID();
    const identity: SubscriberIdentity = {
      ...authIdentity,
      boardId: (req.query.boardId as string) || undefined,
      sseSessionId,
    };
    let proxyCountNow = 0;
    if (identity.agentId) {
      const detail: SseSessionDetail = {
        session_id: sseSessionId,
        connected_at: new Date().toISOString(),
        ip: this._extractIp(req),
        plugin_version: this._extractPluginVersion(req),
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

    // Idempotent cleanup invoked from EITHER req.on('close') (fires the
    // moment the TCP socket drops, even when a reverse proxy is in the
    // middle) OR the rxjs `finalize` (fallback for cases where the close
    // event doesn't propagate). Without the close hook, a flaky network
    // / server restart leaves stale entries in agentSseSessions until
    // the upstream-pool idle timeout, which is exactly the failure mode
    // the user hit (one live proxy, modal shows two).
    let cleanedUp = false;
    const cleanup = (source: 'finalize' | 'req-close' | 'req-error' | 'socket-error' | 'socket-close') => {
      if (cleanedUp) return;
      cleanedUp = true;
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
        // Clear pinned main if this disconnecting session was it. Without
        // this, agentMainSession would point at a dead session_id and the
        // routing fallback ("oldest connected") would never re-engage.
        if (this.agentMainSession.get(identity.agentId) === sseSessionId) {
          this.agentMainSession.delete(identity.agentId);
        }
        if (endedDetail) {
          this._recordProxyActivity(identity.agentId, identity.name, 'proxy_disconnected', endedDetail);
        }
      }
      this.logService.info('SSE', `Client disconnected via ${source} (total: ${this.clientCount}${identity.agentId ? `, agent_proxies=${bucketSize}` : ''})`);
    };
    // Multiple disconnect signals — whichever fires first wins, the rest
    // are no-ops. Express + NestJS @Sse don't surface SSE write failures
    // through any single hook; chasing each underlying signal cuts the
    // window where a stale entry can sit in agentSseSessions:
    //   - req.on('close')   socket-level close, fires fastest in the
    //                       common case (client disconnected, no proxy
    //                       buffer)
    //   - req.on('error')   request-side error (network hiccup, the
    //                       client side TCP RST)
    //   - socket events     when the upstream-pool socket between
    //                       reverse proxy and AWB resets, those events
    //                       fire on req.socket directly
    //   - finalize          rxjs unsubscribe — fallback that always
    //                       eventually fires when the Observable
    //                       completes
    req.on('close', () => cleanup('req-close'));
    req.on('error', () => cleanup('req-error'));
    if (req.socket) {
      req.socket.on('error', () => cleanup('socket-error'));
      req.socket.on('close', () => cleanup('socket-close'));
    }

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
          if (def.filter && !def.filter(event, identity)) return false;
          // Per-agent routing: when this agent has 2+ concurrent proxy
          // sessions, agent-recipient events (triggers, mentions, chat,
          // fs_request, agent_typing) flow only to the pinned "main"
          // session — or to the oldest-connected session as auto-fallback
          // when the user hasn't pinned one. Single-session and user
          // identities are unaffected.
          if (
            identity.type === 'agent' &&
            identity.agentId &&
            EventsController.AGENT_ROUTED_EVENTS.has(event.event_type)
          ) {
            const target = this._resolveRoutingTargetSession(identity.agentId);
            if (target && target !== sseSessionId) return false;
          }
          return true;
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
        finalize(() => cleanup('finalize')),
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
  getActiveAgentSessions(): Record<string, (SseSessionDetail & { is_main: boolean; main_pinned: boolean })[]> {
    const out: Record<string, (SseSessionDetail & { is_main: boolean; main_pinned: boolean })[]> = {};
    for (const [agentId, bucket] of this.agentSseSessions) {
      const target = this._resolveRoutingTargetSession(agentId);
      const pinned = this.agentMainSession.get(agentId);
      out[agentId] = Array.from(bucket.values())
        .map((s) => ({
          ...s,
          // is_main = the session that currently receives agent-routed
          // events (either user-pinned or auto-elected oldest).
          is_main: s.session_id === target,
          // main_pinned = user explicitly picked it (vs. auto-fallback).
          // The UI uses this to distinguish "MAIN" (pinned) from "MAIN (auto)".
          main_pinned: !!pinned && s.session_id === pinned,
        }))
        .sort((a, b) => a.connected_at.localeCompare(b.connected_at));
    }
    return out;
  }

  /**
   * Pin a specific SSE session as the routing target for an agent. Used by
   * the Agent Details panel when the user has 2+ proxies connected and wants
   * to direct ticket triggers + chat events to a specific terminal.
   *
   * The pinned session must currently be in `agentSseSessions` for this
   * agent — we don't accept pre-pinning a session that hasn't connected yet
   * because the session_id is server-generated per-connection and clients
   * never see one until the SSE stream is open.
   */
  @Post('active-agent-sessions/:agentId/main')
  @UseGuards(AuthGuard)
  setAgentMainSession(
    @Param('agentId') agentId: string,
    @Body() body: { session_id?: string },
  ) {
    const sessionId = (body?.session_id || '').trim();
    if (!sessionId) {
      return { ok: false, error: 'session_id required' };
    }
    const bucket = this.agentSseSessions.get(agentId);
    if (!bucket || !bucket.has(sessionId)) {
      return { ok: false, error: 'session not connected for this agent' };
    }
    this.agentMainSession.set(agentId, sessionId);
    this.logService.info(
      'SSE',
      `Agent main session pinned (agent=${agentId}, session=${sessionId})`,
    );
    return { ok: true, agent_id: agentId, session_id: sessionId };
  }

  /**
   * Clear the user-pinned main for an agent. Routing falls back to the
   * oldest-connected session (auto-main) until the user pins another.
   */
  @Delete('active-agent-sessions/:agentId/main')
  @UseGuards(AuthGuard)
  clearAgentMainSession(@Param('agentId') agentId: string) {
    this.agentMainSession.delete(agentId);
    this.logService.info('SSE', `Agent main session cleared (agent=${agentId})`);
    return { ok: true, agent_id: agentId };
  }

  /**
   * Decide which of an agent's SSE sessions should receive agent-recipient
   * events (triggers, mentions, chat). Returns null when the agent has no
   * live sessions — caller skips delivery in that case (the event was a
   * miss anyway).
   *
   * Resolution order:
   *   1. User-pinned main, if still connected.
   *   2. Sole live session, when there's only one.
   *   3. Oldest-connected session (auto-main) — picked deterministically so
   *      a server restart while two proxies are connected doesn't bounce
   *      routing between them.
   *
   * The single-session case is intentionally a separate branch from the
   * multi-session fallback so a cold connection (no pinned main yet) still
   * delivers events from the moment the first SSE stream opens.
   */
  private _resolveRoutingTargetSession(agentId: string): string | null {
    const bucket = this.agentSseSessions.get(agentId);
    if (!bucket || bucket.size === 0) return null;
    const pinned = this.agentMainSession.get(agentId);
    if (pinned && bucket.has(pinned)) return pinned;
    if (bucket.size === 1) {
      const [only] = bucket.keys();
      return only;
    }
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [sid, det] of bucket) {
      const ts = new Date(det.connected_at).getTime();
      if (Number.isFinite(ts) && ts < oldestAt) {
        oldestAt = ts;
        oldestId = sid;
      }
    }
    return oldestId;
  }

  private _extractIp(req: Request): string {
    // Plugin-supplied IP wins — the plugin knows what NIC it actually
    // bound to, which the upstream reverse proxy can mangle. Older
    // plugins (pre-v0.35.5) don't ship this header; fall back to the
    // standard reverse-proxy chain inference, then req.ip, then mark
    // 'unknown' so the dashboard doesn't render an empty cell.
    const plugin = req.headers['x-plugin-ip'];
    if (typeof plugin === 'string' && plugin.trim()) return plugin.trim();
    const xri = req.headers['x-real-ip'];
    if (typeof xri === 'string' && xri) return xri;
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    return req.ip || 'unknown';
  }

  private _extractPluginVersion(req: Request): string {
    const v = req.headers['x-plugin-version'];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 32);
    return 'unknown';
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
