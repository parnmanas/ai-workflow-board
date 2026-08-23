import { ApiTags } from '@nestjs/swagger';
import { Controller, Sse, Req, Header, UnauthorizedException, OnModuleDestroy, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Request } from 'express';
import { Observable, Subject, filter, map, finalize, of, merge, interval } from 'rxjs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { randomUUID } from 'crypto';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Board } from '../../entities/Board';
import { Workspace } from '../../entities/Workspace';
import { Agent } from '../../entities/Agent';
import { activityEvents } from '../../services/activity.service';
import { resolveAgentDisplayName } from '../../utils/agent-name';
import { pickBaseRepoResourceId } from '../../common/base-repo-binding';
import { mergeEnvironmentConfig } from '../../common/environment-config';
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
  source: 'manager';
  session_id: string;
  connected_at: string;     // ISO timestamp
  ip: string;               // X-Plugin-Ip header from plugin (preferred);
                            // falls back to x-real-ip / x-forwarded-for /
                            // req.ip; 'unknown' if neither resolves
  plugin_version: string;   // X-Plugin-Version header; 'unknown' for
                            // pre-v0.35.5 plugins that don't ship it
  user_agent: string;       // request user-agent header
  board_id: string | null;  // boardId scope from query string (proxies pass 'all')

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
  // Runtime Host API-key SSE connections keyed by the Host Agent identity.
  // Executable Agent identities are never added to this map.
  private readonly runtimeHostSseSessions = new Map<string, Set<string>>();
  private readonly listeners: RegisteredListener[] = [];

  constructor(
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
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
    // raw live-stream count; `sse.runtimeHosts` is distinct Runtime Host
    // identities holding at least one stream.
    metrics.register('sse.connections', () => this.clientCount);
    metrics.register('sse.runtimeHosts', () => this.runtimeHostSseSessions.size);

    // Table-driven listener registration: EVENT_TYPES drives everything.
    // One loop replaces the 9 hand-written listener blocks that previously lived here.
    const mapCtx: EventMapContext = {
      resolveBoardId: (ticketId, entityId) => this.resolveBoardId(ticketId, entityId),
      resolveTicketRepositoryResourceId: (ticketId) => this.resolveTicketRepositoryResourceId(ticketId),
      resolveTicketColumnSnapshot: (ticketId, entityId) =>
        this.resolveTicketColumnSnapshot(ticketId, entityId),
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
            const subscribers = this.runtimeHostSseSessions.get(mapped.scope.agent_id);
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

  /**
   * ticket 112ea3c5: `base_repo_resource_id`가 비어 있으면 board environment
   * repository를 상속한다 — dispatch 경로(trigger-loop.service.ts, ticket
   * 8c3befa8)와 `loadTicketFull`이 이미 적용하는 것과 동일한 board-env 백필이다.
   * 이 값이 먹이는 archive 시점 worktree 정리(agent-manager의
   * `#cleanupArchivedTicketWorkspace`)가 티켓이 실제로 작업한 그 resource를
   * 정확히 타깃하도록 하고, "모든 managed repo 스캔"으로 퇴화하지 않게 한다.
   */
  private async resolveTicketRepositoryResourceId(ticketId: string): Promise<string> {
    if (!ticketId) return '';
    const ticket = await this.ticketRepo.findOne({ where: { id: ticketId } });
    if (!ticket) return '';
    if (ticket.base_repo_resource_id) return ticket.base_repo_resource_id;
    try {
      const col = ticket.column_id
        ? await this.colRepo.findOne({ where: { id: ticket.column_id } })
        : null;
      const [board, workspace] = await Promise.all([
        col?.board_id ? this.boardRepo.findOne({ where: { id: col.board_id } }) : Promise.resolve(null),
        ticket.workspace_id ? this.workspaceRepo.findOne({ where: { id: ticket.workspace_id } }) : Promise.resolve(null),
      ]);
      const merged = mergeEnvironmentConfig(workspace?.environment_config, board?.environment_config);
      return pickBaseRepoResourceId('', merged?.repositories || []).resourceId;
    } catch {
      return '';
    }
  }

  private async resolveTicketColumnSnapshot(ticketId: string, entityId: string): Promise<{
    id: string;
    name: string;
    kind: string;
  } | null> {
    let ticket = await this.ticketRepo.findOne({ where: { id: ticketId || entityId } });
    for (let depth = 0; ticket && !ticket.column_id && ticket.parent_id && depth < 2; depth += 1) {
      ticket = await this.ticketRepo.findOne({ where: { id: ticket.parent_id } });
    }
    if (!ticket?.column_id) return null;
    const column = await this.colRepo.findOne({ where: { id: ticket.column_id } });
    return column ? { id: column.id, name: column.name, kind: column.kind || '' } : null;
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
    if (authIdentity.type === 'agent') {
      const runtimeHost = authIdentity.agentId
        ? await this.agentRepo.findOne({ where: { id: authIdentity.agentId } })
        : null;
      if (!runtimeHost || runtimeHost.type !== 'manager') {
        throw new UnauthorizedException('Runtime Host credentials are required');
      }
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
    let runtimeHostStreamCount = 0;
    if (identity.agentId) {
      let sessions = this.runtimeHostSseSessions.get(identity.agentId);
      if (!sessions) {
        sessions = new Set();
        this.runtimeHostSseSessions.set(identity.agentId, sessions);
      }
      sessions.add(sseSessionId);
      runtimeHostStreamCount = sessions.size;
      this.connectivity.noteConnected(sseSessionId, identity.agentId, identity.managedAgentIds);
    }
    this.logService.info(
      'SSE',
      `Client connected (${identity.type}: ${identity.name}, board: ${
        identity.boardId || 'all'
      }, total: ${this.clientCount}${identity.agentId ? `, runtime_host_streams=${runtimeHostStreamCount}` : ''})`,
    );

    // Idempotent cleanup invoked from EITHER req.on('close') (fires the
    // moment the TCP socket drops, even when a reverse proxy is in the
    // middle) OR the rxjs `finalize` (fallback for cases where the close
    // event doesn't propagate). Without the close hook, a flaky network
    // / server restart leaves stale Runtime Host session entries until the
    // upstream-pool idle timeout.
    let cleanedUp = false;
    const cleanup = (source: 'finalize' | 'req-close' | 'req-error' | 'socket-error' | 'socket-close') => {
      if (cleanedUp) return;
      cleanedUp = true;
      this.clientCount--;
      // Drop this session's reachability contribution (ticket bfdd80b7).
      this.connectivity.noteDisconnected(sseSessionId);
      let bucketSize = 0;
      if (identity.agentId) {
        const sessions = this.runtimeHostSseSessions.get(identity.agentId);
        if (sessions) {
          sessions.delete(sseSessionId);
          bucketSize = sessions.size;
          if (bucketSize === 0) this.runtimeHostSseSessions.delete(identity.agentId);
        }
      }
      this.logService.info('SSE', `Client disconnected via ${source} (total: ${this.clientCount}${identity.agentId ? `, runtime_host_streams=${bucketSize}` : ''})`);
    };
    // Multiple disconnect signals — whichever fires first wins, the rest
    // are no-ops. Express + NestJS @Sse don't surface SSE write failures
    // through any single hook; chasing each underlying signal cuts the
    // window where a stale Runtime Host stream can remain registered:
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
          // identity.agentId`) match without a per-filter rewrite.
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
          if (
            identity.type === 'agent' &&
            identity.managedAgentIds
          ) {
            if (
              typeof event.scope.agent_id === 'string' &&
              identity.managedAgentIds.has(event.scope.agent_id)
            ) {
              effectiveIdentity = { ...identity, agentId: event.scope.agent_id };
            } else if (event.scope.agent_member_ids instanceof Set) {
              for (const memberId of event.scope.agent_member_ids) {
                if (identity.managedAgentIds.has(memberId)) {
                  effectiveIdentity = { ...identity, agentId: memberId };
                  break;
                }
              }
            }
          }

          if (def.filter && !def.filter(event, effectiveIdentity)) return false;
          return true;
        }),
        map((event: StreamEvent) => {
          const def = registry.get(event.event_type);
          // Runtime Host-consumed types flatten payload fields; newer UI-only
          // types ship the envelope natively.
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

  /** Runtime Host sessions synthesized per supervised executable Agent. */
  @Get('active-agent-sessions')
  @UseGuards(AuthGuard)
  async getActiveAgentSessions(): Promise<Record<string, SseSessionDetail[]>> {
    const out: Record<string, SseSessionDetail[]> = {};

    // Each Runtime Host record contributes one diagnostic row per executable
    // Agent it supervises. These rows are observability only; routing ownership
    // is the Agent.manager_agent_id link.
    const managers = this.instanceRegistry.list().filter(
      (r) => Array.isArray(r.agent_ids) && r.agent_ids.length > 0,
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
          const row: SseSessionDetail = {
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
          };
          out[managedId].push(row);
        }
      }
      for (const agentId of Object.keys(out)) {
        out[agentId].sort((a, b) => a.connected_at.localeCompare(b.connected_at));
      }
    }

    return out;
  }
}
