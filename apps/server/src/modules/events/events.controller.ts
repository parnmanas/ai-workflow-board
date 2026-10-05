import { ApiTags } from '@nestjs/swagger';
import { withLegacyOwnershipFields } from '../../common/ownership-contract';
import { Controller, Sse, Req, Header, UnauthorizedException, OnModuleDestroy, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Request } from 'express';
import { Observable, Subject, ReplaySubject, filter, map, finalize, of, merge, interval, takeUntil } from 'rxjs';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Repository, In } from 'typeorm';
import { randomUUID } from 'crypto';
import { Ticket } from '../../entities/Ticket';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { ApiKey } from '../../entities/ApiKey';
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
import { AccountAccessService } from '../../services/account-access.service';

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
  /**
   * Fires once on shutdown to end every live SSE stream.
   *
   * `stream()` returns `merge(versionEvent, keepalive, eventSubject…)`, and
   * `merge` completes only when **every** source completes. `keepalive` is an
   * `interval(15s)` that never does, so completing `eventSubject` in
   * `onModuleDestroy` was not enough: each connected agent kept an open
   * response, `server.close()` waited on them forever, and systemd SIGKILLed
   * the process at the stop timeout on every restart (observed on rolf
   * 2026-09-16 — the full 90s default, then `status=9/KILL`).
   */
  private readonly shutdown$ = new Subject<void>();
  // Reconnect browsers with fresh membership after administration changes.
  // Replay closes the auth-read/observable-subscribe race as well.
  private readonly ownershipChanges$ = new ReplaySubject<number>(1);
  private ownershipRevision = 0;
  private readonly nativeOwners = new Map<string, Promise<string | null>>();
  private readonly onOwnershipChange = () => {
    this.nativeOwners.clear();
    this.ownershipChanges$.next(++this.ownershipRevision);
  };

  private nativeOwner(session: { manager_id: string; cli: string; session_id: string }): Promise<string | null> {
    const key = JSON.stringify([session.manager_id, session.cli, session.session_id]);
    const cached = this.nativeOwners.get(key);
    if (cached) return cached;
    const pending = this.dataSource.getRepository('AgentSessionExecution').findOne({
      where: { manager_id: session.manager_id, cli: session.cli, session_id: session.session_id }, select: ['account_id'],
    }).then(binding => binding?.account_id || null);
    if (this.nativeOwners.size >= 2048) this.nativeOwners.delete(this.nativeOwners.keys().next().value!);
    this.nativeOwners.set(key, pending);
    // Unbound sessions may be pinned later. Sharing the lookup also preserves
    // chunk order without a database round trip for every text delta.
    void pending.then(owner => {
      if (!owner && this.nativeOwners.get(key) === pending) this.nativeOwners.delete(key);
    }, () => { if (this.nativeOwners.get(key) === pending) this.nativeOwners.delete(key); });
    return pending;
  }
  private clientCount = 0;
  // Runtime Host API-key SSE connections keyed by the Host Agent identity.
  // Executable Agent identities are never added to this map.
  private readonly runtimeHostSseSessions = new Map<string, Set<string>>();
  private readonly listeners: RegisteredListener[] = [];

  constructor(
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(RuntimeHost) private readonly hostRepo: Repository<RuntimeHost>,
    @InjectRepository(ApiKey) private readonly apiKeyRepo: Repository<ApiKey>,
    private readonly authService: AuthService,
    private readonly apiKeyService: ApiKeyService,
    private readonly logService: LogService,
    private readonly instanceRegistry: InstanceRegistryService,
    // Live SSE reachability (ticket bfdd80b7). Fed on connect/disconnect below
    // so the dispatch/chat feedback gate can tell a truly-unreachable agent
    // from one that's connected-but-not-pinging.
    private readonly connectivity: AgentConnectivityRegistry,
    metrics: MemoryMetricsRegistry,
    private readonly accountAccess: AccountAccessService,
  ) {
    // Memory observability gauges for the SSE maps. `sse.connections` is the
    // raw live-stream count; `sse.runtimeHosts` is distinct Runtime Host
    // identities holding at least one stream.
    metrics.register('sse.connections', () => this.clientCount);
    metrics.register('sse.runtimeHosts', () => this.runtimeHostSseSessions.size);
    activityEvents.on('account_membership_changed', this.onOwnershipChange);

    // Table-driven listener registration: EVENT_TYPES drives everything.
    // One loop replaces the 9 hand-written listener blocks that previously lived here.
    const mapCtx: EventMapContext = {
      resolveTicketSnapshot: (ticketId, entityId) => this.resolveTicketSnapshot(ticketId, entityId),
      // Same (id → canonical display) resolver ActivityService uses on read, so
      // the realtime board_update frame and a later refetch never disagree.
      //
      // 이름 보강은 장식이므로 어떤 이유로든 프레임을 죽이지 못하게 2차 방어로
      // 감싼다 — 감싸지 않았을 때 actor_id 하나의 uuid 캐스팅 오류가 아래 catch
      // 까지 올라가 eventSubject.next() 를 건너뛰고 board_update 를 통째로
      // 유실시켰다. 유실되면 agent-manager 의 worktree 회수(moved/archived)와 웹
      // UI 실시간 갱신이 함께 죽는다. resolveTicketSnapshot 은 반대로 감싸지 말 것 —
      // 티켓이 없으면 scope 를 만들 수 없어 현재의 skip 이 정답이다.
      resolveActorDisplayName: async (actorId) => {
        if (!actorId) return null;
        try {
          return await resolveAgentDisplayName(this.dataSource, actorId);
        } catch (err) {
          this.logService.warn(
            'SSE',
            `actor 이름 보강 실패 — 저장된 actor_name 으로 프레임을 내보낸다: ${err}`,
            { actor_id: actorId },
          );
          return null;
        }
      },
    };

    for (const def of EVENT_TYPES) {
      const handler = async (rawEvent: any) => {
        try {
          const mapped = await def.map(rawEvent, mapCtx);
          if (!mapped) return;
          if (def.eventType === 'agent_session_update' || def.eventType === 'agent_session_event') {
            const payload = mapped.payload as any;
            const session = payload.session || payload;
            if (session.manager_id && session.cli && session.session_id) {
              const owner = await this.nativeOwner(session);
              if (owner) mapped.scope.account_id = owner;
            }
          }
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
    activityEvents.removeListener('account_membership_changed', this.onOwnershipChange);
    this.ownershipChanges$.complete();
    this.nativeOwners.clear();
    for (const { def, handler } of this.listeners) {
      activityEvents.removeListener(def.emitterEvent, handler);
    }
    this.listeners.length = 0;
    // Order matters only in that both must happen: shutdown$ ends the
    // never-completing keepalive, eventSubject.complete() ends the event feed.
    // Each live stream then completes, Nest ends the response, and the sockets
    // holding server.close() open are released.
    this.shutdown$.next();
    this.shutdown$.complete();
    this.eventSubject.complete();
  }

  /** The root ticket behind an activity — subtasks walk up (max depth 2). */
  private async resolveTicketSnapshot(ticketId: string, entityId: string): Promise<{
    root_id: string;
    account_id: string;
    status: string;
    project_id: string;
  } | null> {
    const id = ticketId || entityId;
    if (!id) return null;
    let ticket = await this.ticketRepo.findOne({ where: { id } });
    for (let depth = 0; ticket && ticket.parent_id && depth < 2; depth += 1) {
      ticket = await this.ticketRepo.findOne({ where: { id: ticket.parent_id } });
    }
    if (!ticket) return null;
    return {
      root_id: ticket.id,
      account_id: ticket.account_id || '',
      status: ticket.status,
      project_id: ticket.project_id || '',
    };
  }

  @Sse('stream')
  @Header('X-Accel-Buffering', 'no')
  async stream(@Req() req: Request): Promise<Observable<MessageEvent>> {
    const ownershipRevision = this.ownershipRevision;
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
        accountIds: new Set(await this.accountAccess.accessibleIds(user)),
      };
    } else {
      // Try API key (for AI agents)
      try {
        const keyResult = await this.apiKeyService.validateApiKey(token);
        if (keyResult.valid && keyResult.apiKey) {
          authIdentity = {
            type: 'agent',
            name: keyResult.apiKey.name || 'agent',
            // P4c-4: host-only 키는 agent 바인딩이 없다 — Host id 를 agentId
            // 자리에 넣어 legacy uuid 스코프 비교가 null 추락하지 않게 한다.
            // host-affinity 분기는 아래 hostId 로 탄다.
            agentId: keyResult.apiKey.host_id ?? undefined,
            // P4c-2b: host-affinity 분기용. 구 키에는 host_id가 없어 undefined.
            hostId: keyResult.apiKey.host_id ?? undefined,
          };
        }
      } catch {
        /* key validation failed, authIdentity stays null */
      }
    }

    if (!authIdentity) {
      throw new UnauthorizedException('Invalid or expired session/API key');
    }
    // P4c-4: SSE agent 정체성은 RuntimeHost 행만 본다 (Agent 테이블 없음).
    // fanoutHostId: 이 연결이 배달받을 legacy holder 집합의 주인 Host.
    let fanoutHostId: string | null = null;
    if (authIdentity.type === 'agent') {
      const hostRow = authIdentity.agentId
        ? await this.hostRepo.findOne({ where: { id: authIdentity.agentId } })
        : null;
      if (!hostRow) throw new UnauthorizedException('Runtime Host credentials are required');
      fanoutHostId = hostRow.id;
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
    // P4c-4: managed-agent fan-out 집합은 api_keys 페어링 링크에서 복원한다
    // (Agent 자식 행 없음 — 예전 manager_agent_id 행 스캔 대신).
    // 연결당 1회 조회라 이벤트 핫 패스는 그대로 O(1) 이다. rt- 멤버는 기존
    // host-affinity 분기로 배달된다.
    let managedAgentIds: Set<string> | undefined = undefined;

    const identity: SubscriberIdentity = {
      ...authIdentity,
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
      `Client connected (${identity.type}: ${identity.name}, total: ${this.clientCount}${identity.agentId ? `, runtime_host_streams=${runtimeHostStreamCount}` : ''})`,
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
          if (identity.type === 'user' && event.scope.account_id && !identity.accountIds?.has(event.scope.account_id)) return false;

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
          // P4c-2b: single-recipient 이벤트의 rt- 타깃. payload.runtime의
          // spec.manager_agent_id가 이 연결의 hostId/legacy agentId와 일치하면
          // 그 매니저에게 배달한다 (managedAgentIds에는 rt 키가 없다).
          if (
            identity.type === 'agent' &&
            typeof event.scope.agent_id === 'string' &&
            event.scope.agent_id.startsWith('rt-') &&
            (identity.hostId || identity.agentId)
          ) {
            const runtime = (event.payload as any)?.runtime;
            const owner = runtime && typeof runtime === 'object'
              ? String((runtime as Record<string, any>).manager_agent_id || '')
              : '';
            if (
              owner &&
              (owner === identity.hostId || owner === identity.agentId)
            ) {
              effectiveIdentity = { ...identity, agentId: event.scope.agent_id };
            }
          }
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
          // P4c-2b: rt- 멤버 host-affinity. broadcast의 agent_member_runtimes
          // 맵에서 spec.manager_agent_id가 이 연결의 hostId/legacy agentId와
          // 일치하는 멤버가 있으면 그 매니저에게 배달하고 effectiveIdentity를
          // 그 rt 키로 둔다. 매니저는 wire의 같은 맵에서 spec을 읽어 해소한다.
          // 기존 managedAgentIds 분기와 OR — 둘 중 하나만 맞으면 된다.
          if (
            identity.type === 'agent' &&
            (identity.hostId || identity.agentId) &&
            event.scope.agent_member_ids instanceof Set
          ) {
            const runtimes = (event.payload as any)?.agent_member_runtimes;
            if (runtimes && typeof runtimes === 'object' && !Array.isArray(runtimes)) {
              const selfIds = new Set(
                [identity.hostId, identity.agentId].filter((v): v is string => !!v),
              );
              for (const memberId of event.scope.agent_member_ids) {
                if (typeof memberId !== 'string' || !memberId.startsWith('rt-')) continue;
                const spec = (runtimes as Record<string, any>)[memberId];
                const owner = spec && typeof spec === 'object' ? String(spec.manager_agent_id || '') : '';
                if (owner && selfIds.has(owner)) {
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
            data: JSON.stringify(identity.type === 'agent' ? withLegacyOwnershipFields(dataObj) : dataObj),
            type: event.event_type,
          } as MessageEvent;
        }),
        finalize(() => cleanup('finalize')),
      ),
      // Applied to the merged stream rather than to `keepalive` alone, so any
      // source added here later is covered by the same shutdown guarantee.
      // Completing this way still runs the `finalize` cleanup above.
    ).pipe(takeUntil(identity.type === 'user'
      ? merge(this.shutdown$, this.ownershipChanges$.pipe(filter(revision => revision > ownershipRevision)))
      : this.shutdown$));
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
        // P4c-4: Host 행에서 이름 조회 (Agent 테이블 없음).
        const hostRows = lookupIds.length > 0
          ? await this.hostRepo.find({
            where: { id: In(lookupIds) },
            select: ['id', 'name'],
          })
          : [];
        for (const h of hostRows) {
          if (!nameById.has(h.id)) nameById.set(h.id, h.name);
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
