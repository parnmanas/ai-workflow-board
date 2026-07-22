import { ApiTags } from '@nestjs/swagger';
import { Controller, Sse, Req, Header, UnauthorizedException, OnModuleDestroy, Get, Post, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Request } from 'express';
import { Observable, Subject, filter, map, finalize, of, merge, interval } from 'rxjs';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { randomUUID } from 'crypto';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { ActivityLog } from '../../entities/ActivityLog';
import { Agent } from '../../entities/Agent';
import { activityEvents } from '../../services/activity.service';
import { resolveAgentDisplayName } from '../../utils/agent-name';
import { AuthService } from '../../services/auth.service';
import { ApiKeyService } from '../../services/api-key.service';
import { LogService } from '../../services/log.service';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';
import { AgentConnectivityRegistry } from '../../services/agent-connectivity.registry';
import { StreamEvent } from '../../common/types/stream-events';
import { EVENT_TYPES } from './event-registry';
import { EventDefinition, EventMapContext, SubscriberIdentity } from './types';
import { InstanceRegistryService } from '../agent-manager/instance-registry.service';

interface RegisteredListener {
  def: EventDefinition;
  handler: (rawEvent: any) => void;
}

/**
 * Credential firewall for the run-dispatch SSE frame. A QA/security run
 * `chat_room_message` carries the repo git credential at
 * `run_provision.repo.credential` so the agent-manager can clone a PRIVATE repo
 * (ticket 622bc350 server wiring). That token must reach ONLY an agent (machine-
 * key-authenticated) SSE stream — never a human's browser, even one that happens
 * to be a member of the run room. Given the frame about to be serialized and the
 * recipient's
 * identity type, return the frame to send: unchanged for an agent recipient (or
 * any frame with no run_provision credential), and a credential-stripped copy
 * for a non-agent recipient.
 *
 * Rebuilds the nested object rather than deleting in place: `flatten()` shallow-
 * spreads the shared envelope's payload, so `dataObj.run_provision` is the SAME
 * reference every other subscriber's frame holds — including the manager's. An
 * in-place delete would blank the credential for the real consumer. `undefined`
 * drops out of `JSON.stringify`, so the wire simply omits the field.
 */
export function redactRunProvisionCredential(
  dataObj: any,
  eventType: string,
  recipientType: 'user' | 'agent' | string,
): any {
  if (
    recipientType === 'agent' ||
    eventType !== 'chat_room_message' ||
    !dataObj?.run_provision?.repo?.credential
  ) {
    return dataObj;
  }
  const rp = dataObj.run_provision;
  return {
    ...dataObj,
    run_provision: { ...rp, repo: { ...rp.repo, credential: undefined } },
  };
}

interface SseSessionDetail {
  // Discriminator for unified SESSIONS panel rendering. 'proxy' rows are real
  // SSE buckets owned by a proxy.mjs process; 'manager' rows are synthesized
  // from InstanceRegistry at read time so the UI can show managed agents
  // (which never open their own SSE — the manager mediates) under the same
  // panel without losing routing semantics. Only 'proxy' rows participate
  // in main-pin selection (AGENT_ROUTED_EVENTS resolution).
  source: 'proxy' | 'manager';
  session_id: string;       // server-generated UUID for this SSE connection
                            // (proxy); for 'manager' rows, `mgr:<instance_id>`
  connected_at: string;     // ISO timestamp
  ip: string;               // X-Plugin-Ip header from plugin (preferred);
                            // falls back to x-real-ip / x-forwarded-for /
                            // req.ip; 'unknown' if neither resolves
  plugin_version: string;   // X-Plugin-Version header; 'unknown' for
                            // pre-v0.35.5 plugins that don't ship it
  user_agent: string;       // request user-agent header
  board_id: string | null;  // boardId scope from query string (proxies pass 'all')

  // ── Manager-source only (undefined for proxy rows) ───────────────────
  instance_id?: string;        // InstanceRecord.instance_id of the manager
  manager_agent_id?: string;   // Agent.id of the supervising manager
  manager_name?: string;       // Display name of the manager (for row label)
  cli?: string;                // 'claude' | 'codex' | 'antigravity' | 'pi' | custom
  cli_adapters?: string[];     // additional adapter identifiers known to the manager
  hostname?: string;           // host running the manager
  pid?: number;                // pid of the manager process
  started_at?: string;         // ISO when the manager process started
  paired_at?: string;          // ISO when the manager redeemed its pairing token
  working_dir?: string;        // managed agent's working_dir on the manager host
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
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly apiKeyService: ApiKeyService,
    private readonly logService: LogService,
    private readonly instanceRegistry: InstanceRegistryService,
    // Live SSE reachability (ticket bfdd80b7). Fed on connect/disconnect below
    // so the dispatch/chat feedback gate can tell a truly-unreachable agent
    // from one that's connected-but-not-pinging.
    private readonly connectivity: AgentConnectivityRegistry,
    metrics: MemoryMetricsRegistry,
  ) {
    // Memory observability gauges for the SSE maps. `sse.connections` is the
    // raw live-stream count; `sse.agents` is distinct agents holding at least
    // one stream (a single agent can hold several — see agentSseSessions);
    // `sse.mainPins` tracks the pinned-session map, which is the most
    // leak-prone of the three (entries must be cleared on disconnect/DELETE).
    metrics.register('sse.connections', () => this.clientCount);
    metrics.register('sse.agents', () => this.agentSseSessions.size);
    metrics.register('sse.mainPins', () => this.agentMainSession.size);

    // Table-driven listener registration: EVENT_TYPES drives everything.
    // One loop replaces the 9 hand-written listener blocks that previously lived here.
    const mapCtx: EventMapContext = {
      resolveBoardId: (ticketId, entityId) => this.resolveBoardId(ticketId, entityId),
      resolveTicketRepositoryResourceId: (ticketId) => this.resolveTicketRepositoryResourceId(ticketId),
      // Same (id → canonical display) resolver ActivityService uses on read, so
      // the realtime board_update frame and a later refetch never disagree.
      resolveActorDisplayName: (actorId) =>
        actorId ? resolveAgentDisplayName(this.agentRepo, actorId) : Promise.resolve(null),
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

          // Defensive: admin-dispatched commands (agent_manager_command) and
          // similar agent-targeted events fail silently when no SSE subscriber
          // matches the per-event filter. Without this warn the operator
          // sees "restart_manager dispatched 200 OK" but the manager never
          // executes — and there's nothing in the logs to point at the
          // gap. Specifically catches the `apiKey.agent_id = NULL` /
          // identity.agentId = undefined class of bug where the subscriber
          // bucket for the target agent is empty even though the manager's
          // SSE is connected.
          if (
            def.eventType === 'agent_manager_command' &&
            typeof mapped.scope.agent_id === 'string' &&
            mapped.scope.agent_id
          ) {
            const subscribers = this.agentSseSessions.get(mapped.scope.agent_id);
            const subscriberCount = subscribers?.size ?? 0;
            if (subscriberCount === 0) {
              const cmd = (mapped.payload as any)?.command || 'unknown';
              const cmdId = (mapped.payload as any)?.command_id || 'unknown';
              this.logService.warn(
                'SSE',
                `${def.eventType} ${cmd} for agent_id=${mapped.scope.agent_id.slice(0, 8)} has 0 SSE subscribers — command will silently no-op (id=${cmdId})`,
                {
                  event_type: def.eventType,
                  command: cmd,
                  command_id: cmdId,
                  scope_agent_id: mapped.scope.agent_id,
                  total_sse_clients: this.clientCount,
                  hint: 'Check apiKey.agent_id NULL (FK ON DELETE SET NULL aftermath), or manager SSE disconnect, or wrong instance.',
                },
              );
            }
          }
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

  private async resolveTicketRepositoryResourceId(ticketId: string): Promise<string> {
    if (!ticketId) return '';
    const ticket = await this.ticketRepo.findOne({ where: { id: ticketId } });
    return ticket?.base_repo_resource_id || '';
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

    // ST-6: when an agent identity is also a manager (i.e., has any Agent
    // rows linking back via manager_agent_id), resolve the owned set ONCE
    // here so the per-event filter loop is O(1) and doesn't hit the DB on
    // the hot path. Set is recomputed only on a fresh SSE connect, so a
    // newly-created managed agent won't show up until the manager
    // reconnects. The agent-manager side honors this contract by calling
    // EventStream.reconnect() at the end of every spawn_agent — see
    // apps/agent-manager/src/lib/agent-manager-commands.ts (#spawnAgent
    // step 7) and event-stream.ts (#reconnect). Without that pairing the
    // server silently drops chat_request / agent_trigger / comment_mention
    // events for any agent created after the manager's current SSE connect.
    let managedAgentIds: Set<string> | undefined;
    if (authIdentity.type === 'agent' && authIdentity.agentId) {
      try {
        const owned = await this.agentRepo.find({
          where: { manager_agent_id: authIdentity.agentId },
          select: ['id'],
        });
        if (owned.length > 0) {
          managedAgentIds = new Set(owned.map((a) => a.id));
        }
      } catch (err) {
        this.logService.warn('SSE', `managedAgentIds lookup failed for agent ${authIdentity.agentId.slice(0, 8)}: ${err}`);
      }
    }

    const identity: SubscriberIdentity = {
      ...authIdentity,
      boardId: (req.query.boardId as string) || undefined,
      sseSessionId,
      managedAgentIds,
    };
    let proxyCountNow = 0;
    if (identity.agentId) {
      const detail: SseSessionDetail = {
        source: 'proxy',
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
      // Live reachability (ticket bfdd80b7): this session can deliver events
      // scoped to its own agent id AND (for a manager identity) to every agent
      // it supervises — the exact keys the fan-out below routes to.
      this.connectivity.noteConnected(sseSessionId, identity.agentId, identity.managedAgentIds);
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
      // Drop this session's reachability contribution (ticket bfdd80b7).
      this.connectivity.noteDisconnected(sseSessionId);
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

          // ST-6: managed-agent fan-out. If this is a manager identity and
          // the event is targeted at one of its managed agents, run the
          // per-event filter as if WE are that managed agent. This lets
          // existing agent-targeted filters (`env.scope.agent_id ===
          // identity.agentId`) match without a per-filter rewrite. Pinning
          // logic below uses the effective agent_id too — for managed
          // agents the manager is normally the only stream so pinning is
          // a no-op (no entry in agentSseSessions for the managed id);
          // when a legacy proxy is also connected for the same managed
          // agent, the pinning naturally picks that proxy and skips the
          // manager, which is the correct precedence.
          //
          // Two shapes of "targeted at a managed agent":
          //   1. Single-recipient events (agent_trigger, comment_mention,
          //      chat_request, fs_request, agent_manager_command): one
          //      target id sits at scope.agent_id.
          //   2. Multi-recipient room events (chat_room_message /
          //      chat_room_update / chat_room_typing): the room's agent
          //      participants live in scope.agent_member_ids. The manager
          //      should accept the event when ANY of its managed agents is
          //      a member; effective identity becomes that managed agent so
          //      roomMemberFilter passes. The agent-manager side derives
          //      WHICH managed agents to dispatch to from the wire payload's
          //      agent_member_ids array — for multi-managed-agent rooms it
          //      can spawn one chat session per matching agent.
          let effectiveIdentity = identity;
          let effectiveAgentId = identity.agentId;
          if (
            identity.type === 'agent' &&
            identity.managedAgentIds
          ) {
            if (
              typeof event.scope.agent_id === 'string' &&
              identity.managedAgentIds.has(event.scope.agent_id)
            ) {
              effectiveAgentId = event.scope.agent_id;
              effectiveIdentity = { ...identity, agentId: event.scope.agent_id };
            } else if (event.scope.agent_member_ids instanceof Set) {
              for (const memberId of event.scope.agent_member_ids) {
                if (identity.managedAgentIds.has(memberId)) {
                  effectiveAgentId = memberId;
                  effectiveIdentity = { ...identity, agentId: memberId };
                  break;
                }
              }
            }
          }

          if (def.filter && !def.filter(event, effectiveIdentity)) return false;
          // Per-agent routing: when this agent has 2+ concurrent proxy
          // sessions, agent-recipient events (triggers, mentions, chat,
          // fs_request, agent_typing) flow only to the pinned "main"
          // session — or to the oldest-connected session as auto-fallback
          // when the user hasn't pinned one. Single-session and user
          // identities are unaffected.
          if (
            identity.type === 'agent' &&
            effectiveAgentId &&
            EventsController.AGENT_ROUTED_EVENTS.has(event.event_type)
          ) {
            const target = this._resolveRoutingTargetSession(effectiveAgentId);
            if (target && target !== sseSessionId) return false;
          }
          return true;
        }),
        map((event: StreamEvent) => {
          const def = registry.get(event.event_type);
          // Legacy types flatten payload fields up for proxy.mjs; newer types ship the
          // envelope natively (no flatten fn → envelope as-is).
          const rawDataObj = def?.flatten ? def.flatten(event) : event;
          // Credential firewall: never ship run_provision.repo.credential to a
          // non-agent (human) SSE recipient — the git token is for an agent
          // recipient's clone only. See redactRunProvisionCredential (module scope).
          const dataObj = redactRunProvisionCredential(rawDataObj, event.event_type, identity.type);
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
  async getActiveAgentSessions(): Promise<Record<string, (SseSessionDetail & { is_main: boolean; main_pinned: boolean })[]>> {
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

    // Synthesize manager-source rows from InstanceRegistry. A managed agent
    // never opens its own SSE — the manager mediates everything via its own
    // proxy/SSE connection plus per-call MCP HTTP — so without this merge
    // the SESSIONS panel would always be empty for managed agents even
    // while the manager is actively heartbeating. Each manager InstanceRecord
    // contributes one row per agent_id it supervises into that agent's
    // bucket. is_main / main_pinned are forced to false because manager
    // rows don't participate in AGENT_ROUTED_EVENTS routing (proxy rows do).
    const managers = this.instanceRegistry.list().filter(
      (r) => r.mode === 'manager' && Array.isArray(r.agent_ids) && r.agent_ids.length > 0,
    );
    if (managers.length > 0) {
      // Batch-resolve names + per-agent working_dir so the row can show
      // "via {manager}" + the actual cwd of the managed agent (which can
      // differ from the manager's working_dirs[] aggregate).
      const managerIds = Array.from(new Set(managers.map((m) => m.agent_id)));
      const managedAgentIds = Array.from(
        new Set(managers.flatMap((m) => m.agent_ids ?? [])),
      );
      const lookupIds = Array.from(new Set([...managerIds, ...managedAgentIds]));

      let nameById = new Map<string, string>();
      let cwdById = new Map<string, string>();
      try {
        const rows = lookupIds.length > 0
          ? await this.agentRepo.find({
              where: { id: In(lookupIds) },
              select: ['id', 'name', 'working_dir'],
            })
          : [];
        for (const r of rows) {
          nameById.set(r.id, r.name);
          if (r.working_dir) cwdById.set(r.id, r.working_dir);
        }
      } catch (err) {
        this.logService.warn('SSE', `Manager-row name/cwd lookup failed: ${err}`);
      }

      for (const m of managers) {
        for (const managedId of m.agent_ids ?? []) {
          if (!out[managedId]) out[managedId] = [];
          const row: SseSessionDetail & { is_main: boolean; main_pinned: boolean } = {
            source: 'manager',
            // Stable, collision-proof key for React + de-dupe.
            session_id: `mgr:${m.instance_id}`,
            connected_at: m.started_at,
            ip: 'via manager',
            plugin_version: m.plugin_version,
            user_agent: '',
            board_id: null,
            instance_id: m.instance_id,
            manager_agent_id: m.agent_id,
            manager_name: nameById.get(m.agent_id),
            cli: m.cli,
            cli_adapters: m.cli_adapters,
            hostname: m.hostname,
            pid: m.pid,
            started_at: m.started_at,
            paired_at: m.paired_at,
            working_dir: cwdById.get(managedId),
            is_main: false,
            main_pinned: false,
          };
          out[managedId].push(row);
        }
      }
      // Re-sort each touched bucket so manager rows interleave with proxy
      // rows by connect-time rather than appearing as a trailing block.
      for (const agentId of Object.keys(out)) {
        out[agentId].sort((a, b) => a.connected_at.localeCompare(b.connected_at));
      }
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
