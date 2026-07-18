import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { LogService } from '../../services/log.service';
import { ActivityService, activityEvents } from '../../services/activity.service';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import {
  AgentManagerCommandService,
  SpawnAgentResult,
} from '../agent-manager/agent-manager-command.service';
import { AgentStatusService } from './agent-status.service';
import {
  AgentLifecycleState,
  AutostartFeasibility,
  agentLifecycleLabel,
  autostartFeasibilityLabel,
  deriveAgentLifecycleState,
} from '../../common/agent-lifecycle';
import {
  AGENT_AUTOSTART_REQUESTED,
  AutostartRequestEvent,
} from '../../common/agent-autostart-events';

export interface ReachabilityClassification {
  agent: Agent | null;
  reachable: boolean;
  state: AgentLifecycleState;
  autostart: AutostartFeasibility;
}

// Don't re-issue spawn_agent for the same agent more than once per window — the
// supervisor/reconciler re-push a stuck ticket every 60s, and a chat user can
// fire several messages in a row; one spawn attempt per window is enough.
const SPAWN_DEBOUNCE_MS = 45_000;
// Re-surface the same ticket "dispatch 보류" comment at most this often per
// (ticket, agent, role) — unless the state/reason changed, which always
// re-emits so a never_started→error transition is visible immediately.
const TICKET_FEEDBACK_DEBOUNCE_MS = 10 * 60_000;
// Chat feedback is more interactive; a shorter window avoids a wall of system
// messages when a user types several lines while the agent is starting.
const CHAT_FEEDBACK_DEBOUNCE_MS = 60_000;
// Debounce-map eviction cadence (ticket 1f750878). The three maps are tiny and
// their entries stop mattering once past their own window, so a slow sweep is
// plenty — it only reclaims keys that will never be read again (a finished
// ticket / closed room / deleted agent). Interval < every window so no entry
// lingers more than window + one tick.
const DEBOUNCE_SWEEP_INTERVAL_MS = 5 * 60_000;

const AUTOSTART_ISSUED_BY = 'system:autostart';

/**
 * AgentAutostartService (ticket bfdd80b7) — the single hub for "a dispatch /
 * chat targeted an agent that is not reachable."
 *
 * It answers three questions and acts on them:
 *   1. Is the agent reachable right now? (`is_online` OR a live instance carries
 *      it.) — drives the dispatch/chat decision.
 *   2. Can it be auto-started? (linked manager online + working dir) — if so it
 *      issues spawn_agent via AgentManagerCommandService and marks the agent
 *      "starting"; the DispatchIntent outbox (ticket-path) then re-dispatches
 *      once the agent comes online, so the ticket resumes with no human step.
 *   3. If it can't be auto-started (no manager / manager offline / no working
 *      dir) — surface the specific reason to the user (chat system message /
 *      ticket comment + activity) so the silent drop becomes an explicit,
 *      actionable state.
 *
 * Placement: AgentsModule, which can reach InstanceRegistry + AgentManager-
 * CommandService (via forwardRef(AgentManagerModule)), RoomMessagingService
 * (via ChatRoomsModule import), ActivityService and AgentStatusService (local).
 * TriggerLoopService (same module) calls it directly; the chat path reaches it
 * through the AGENT_AUTOSTART_REQUESTED bus event so no new module cycle forms.
 */
@Injectable()
export class AgentAutostartService implements OnModuleInit, OnModuleDestroy {
  private _chatListener?: (evt: AutostartRequestEvent) => void;
  // Debounce-map TTL eviction handle (ticket 1f750878); cleared in onModuleDestroy.
  private _sweepHandle: NodeJS.Timeout | null = null;

  // agent_id → epoch ms of the last spawn_agent issue (spawn debounce).
  private readonly lastSpawnAt = new Map<string, number>();
  // `${ticket}:${agent}:${role}` → { at, sig } for the ticket-feedback debounce.
  // `sig` = state+autostart-reason so a changed situation always re-surfaces.
  private readonly lastTicketFeedback = new Map<string, { at: number; sig: string }>();
  // `${room}:${agent}` → epoch ms of the last chat feedback (chat debounce).
  private readonly lastChatFeedback = new Map<string, number>();

  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly managerCommand: AgentManagerCommandService,
    // Reachability now delegates to AgentStatusService.isReachable (ticket
    // 1f750878) — the single shared definition — so this service no longer
    // injects InstanceRegistryService / AgentConnectivityRegistry directly.
    private readonly agentStatus: AgentStatusService,
    private readonly activityService: ActivityService,
    private readonly roomMessaging: RoomMessagingService,
    private readonly logService: LogService,
    metrics: MemoryMetricsRegistry,
  ) {
    // Debounce-map size gauges (ticket 1f750878) for /api/diagnostics/memory —
    // a persistent climb means the TTL sweep regressed. Mirrors the
    // agentStatus.* marker gauges.
    metrics.register('agentAutostart.lastSpawnAt', () => this.lastSpawnAt.size);
    metrics.register('agentAutostart.lastTicketFeedback', () => this.lastTicketFeedback.size);
    metrics.register('agentAutostart.lastChatFeedback', () => this.lastChatFeedback.size);
  }

  onModuleInit(): void {
    this._chatListener = (evt) => {
      this._handleChatRequest(evt).catch((e: unknown) => {
        this.logService.error('AgentAutostart', 'chat autostart handler failed', { err: String(e) });
      });
    };
    activityEvents.on(AGENT_AUTOSTART_REQUESTED, this._chatListener);

    // Debounce-map TTL eviction (ticket 1f750878). Unlike the agent-status
    // markers these three maps had NO sweep, so distinct (agent) / (ticket:
    // agent:role) / (room:agent) keys accumulated monotonically over a long-
    // running process. An entry is only meaningful within its own debounce
    // window — past it every get() already treats it as absent — so dropping
    // expired entries is behavior-preserving. Handle stored + unref'd + cleared
    // in onModuleDestroy, mirroring AgentStatusService's sweep.
    this._sweepHandle = setInterval(() => this._evictStaleDebounce(), DEBOUNCE_SWEEP_INTERVAL_MS);
    if (typeof (this._sweepHandle as any).unref === 'function') (this._sweepHandle as any).unref();
  }

  onModuleDestroy(): void {
    if (this._chatListener) {
      activityEvents.removeListener(AGENT_AUTOSTART_REQUESTED, this._chatListener);
      this._chatListener = undefined;
    }
    if (this._sweepHandle) {
      clearInterval(this._sweepHandle);
      this._sweepHandle = null;
    }
  }

  /**
   * Drop debounce-map entries older than their own window (ticket 1f750878).
   * Safe because an entry past its window is already treated as absent by the
   * get()-side checks (`Date.now() - at < WINDOW`), so this only reclaims memory
   * for keys that will never be read again. Each map uses its matching window as
   * the TTL. Exposed for the unit test (deterministic eviction assertion).
   */
  private _evictStaleDebounce(): void {
    const now = Date.now();
    for (const [k, at] of this.lastSpawnAt) {
      if (now - at > SPAWN_DEBOUNCE_MS) this.lastSpawnAt.delete(k);
    }
    for (const [k, rec] of this.lastTicketFeedback) {
      if (now - rec.at > TICKET_FEEDBACK_DEBOUNCE_MS) this.lastTicketFeedback.delete(k);
    }
    for (const [k, at] of this.lastChatFeedback) {
      if (now - at > CHAT_FEEDBACK_DEBOUNCE_MS) this.lastChatFeedback.delete(k);
    }
  }

  // ── Reachability + lifecycle classification ─────────────────────────────

  /**
   * Classify an agent's reachability + lifecycle + auto-start feasibility. A
   * cheap DB read plus the in-memory reachability check. `reachable` is the
   * gate the dispatch/chat paths test; `autostart` tells the caller whether a
   * spawn will even be attempted (and, if not, why) so feedback is accurate.
   */
  async classify(agentId: string): Promise<ReachabilityClassification> {
    const agent = agentId ? await this.agentRepo.findOne({ where: { id: agentId } }) : null;
    if (!agent) {
      return { agent: null, reachable: false, state: 'offline', autostart: 'no_manager_linked' };
    }
    // Reachability = the SINGLE shared definition (ticket 1f750878): a live SSE
    // session (the TRUE signal — covers proxy/SSE + manager-supervised agents
    // that never ping) OR a live instance OR the DB is_online fallback. is_online
    // alone is NOT relied upon. This was the canonical of the three previously-
    // divergent inlinings; it now lives in AgentStatusService.isReachable and the
    // REST/SSE badges call the same helper.
    const reachable = this.agentStatus.isReachable(agent.id, !!agent.is_online);
    const state = deriveAgentLifecycleState({
      isOnline: reachable,
      connectedAt: agent.connected_at ?? null,
      isStarting: this.agentStatus.isStarting(agent.id),
      hasRecentStartError: this.agentStatus.getStartError(agent.id) !== undefined,
    });

    let autostart: AutostartFeasibility;
    if (reachable) autostart = 'already_live';
    else if (!agent.manager_agent_id) autostart = 'no_manager_linked';
    else if (!this.managerCommand.resolveLiveManagerInstance(agent.manager_agent_id)) autostart = 'manager_offline';
    else if (!agent.working_dir || !agent.working_dir.trim()) autostart = 'no_working_dir';
    else autostart = 'ok';

    return { agent, reachable, state, autostart };
  }

  // ── Auto-start execution ────────────────────────────────────────────────

  /**
   * Issue spawn_agent for the target (debounced per agent). Marks the agent
   * `starting` on success / `error` on a classified failure so the UI reflects
   * it. Returns the spawn result, or `null` when suppressed by the debounce
   * (the caller then reads the current markers for its feedback copy).
   */
  private async _attemptAutostart(agentId: string): Promise<SpawnAgentResult | null> {
    const last = this.lastSpawnAt.get(agentId);
    if (last !== undefined && Date.now() - last < SPAWN_DEBOUNCE_MS) return null;
    this.lastSpawnAt.set(agentId, Date.now());

    const result = await this.managerCommand.issueSpawnAgent(agentId, AUTOSTART_ISSUED_BY);
    if (result.ok) {
      this.agentStatus.markStarting(agentId);
      this.logService.info('AgentAutostart', 'auto-start dispatched', {
        agent_id: agentId, instance_id: result.instance_id,
      });
    } else if (result.reason !== 'agent_not_found') {
      this.agentStatus.markStartError(agentId, result.reason);
      this.logService.warn('AgentAutostart', 'auto-start not possible', {
        agent_id: agentId, reason: result.reason,
      });
    }
    return result;
  }

  /**
   * Derive the effective spawn outcome for feedback: the fresh attempt result,
   * or — when the spawn was debounce-suppressed — the current marker state so
   * the message still reads correctly ("시작 중" vs the last error).
   */
  private _effectiveOutcome(agentId: string, attempted: SpawnAgentResult | null): { ok: boolean; reason: AutostartFeasibility } {
    if (attempted && attempted.reason !== 'agent_not_found') {
      return { ok: attempted.ok, reason: attempted.reason as AutostartFeasibility };
    }
    // Suppressed by debounce (or agent vanished) — reflect current markers.
    const err = this.agentStatus.getStartError(agentId);
    if (err) return { ok: false, reason: err as AutostartFeasibility };
    if (this.agentStatus.isStarting(agentId)) return { ok: true, reason: 'ok' };
    return { ok: false, reason: 'manager_offline' };
  }

  private _composeMessage(who: string, state: AgentLifecycleState, outcome: { ok: boolean; reason: AutostartFeasibility }): string {
    const stateLabel = agentLifecycleLabel(state);
    if (outcome.ok) {
      return `${who} 가 아직 준비되지 않았습니다 (${stateLabel}). 자동 시작을 요청했으니 준비되면 자동으로 진행됩니다.`;
    }
    return `${who} 가 ${stateLabel} 상태이고 자동 시작할 수 없습니다: ${autostartFeasibilityLabel(outcome.reason)}.`;
  }

  // ── Ticket path (called directly by TriggerLoopService) ─────────────────

  /**
   * If `agentId` is not reachable, surface a ticket-activity event ("dispatch
   * 보류: agent 미시작") and attempt auto-start. Returns whether the agent was
   * unreachable — INFORMATIONAL only: the caller does NOT gate on it (the emit
   * proceeds so the durable outbox still records the retryable in_flight intent;
   * this is purely the missing user-facing feedback + a spawn). Returns false
   * when the agent IS reachable (nothing surfaced).
   *
   * Feedback is debounced per (ticket, agent, role): the supervisor/reconciler
   * re-push the same ticket every ~60s, so re-writing the comment each time
   * would spam. A changed auto-start outcome always re-surfaces.
   */
  async maybeHandleUnreachableTicket(input: {
    ticket: Ticket;
    agentId: string;
    role: string;
    triggerSource: string;
    triggeredBy: string;
  }): Promise<boolean> {
    const { ticket, agentId, role, triggerSource } = input;
    const cls = await this.classify(agentId);
    if (cls.reachable) return false;
    // Agent row vanished mid-flight (rare delete race) — nothing to start or
    // feed back about; still skip the emit (there's no live target).
    if (!cls.agent) return true;

    const attempted = await this._attemptAutostart(agentId);
    const outcome = this._effectiveOutcome(agentId, attempted);
    const message = this._composeMessage('담당 에이전트', cls.state, outcome);

    const key = `${ticket.id}:${agentId}:${role}`;
    // Debounce signature is the auto-start OUTCOME, not the lifecycle state: the
    // state legitimately flips never_started→starting the instant WE mark it, so
    // keying on state would re-post the same "auto-start requested" comment for
    // that self-induced flip. A CHANGED outcome (especially a new failure
    // reason) always re-surfaces so the user sees when auto-start stops working.
    const sig = outcome.ok ? 'ok' : outcome.reason;
    const prev = this.lastTicketFeedback.get(key);
    const debounced = prev !== undefined && prev.sig === sig && Date.now() - prev.at < TICKET_FEEDBACK_DEBOUNCE_MS;
    if (!debounced) {
      this.lastTicketFeedback.set(key, { at: Date.now(), sig });
      try {
        // logActivity (NOT raw repo.save) so it rides the live 'activity' SSE
        // AND SystemCommentService projects it into a visible ticket comment.
        await this.activityService.logActivity({
          entity_type: 'ticket',
          entity_id: ticket.id,
          ticket_id: ticket.id,
          action: 'dispatch_deferred',
          field_changed: cls.state,
          new_value: message,
          actor_id: 'system',
          actor_name: 'AutoStart',
          role,
          trigger_source: triggerSource,
        });
      } catch (e) {
        // Feedback failure must not gate the skip — the dispatch is already
        // deferred; a missed row is the only collateral.
        this.logService.warn('AgentAutostart', 'ticket dispatch-deferred feedback write failed', {
          err: String(e), ticket_id: ticket.id, agent_id: agentId,
        });
      }
    }
    return true;
  }

  // ── Chat path (via AGENT_AUTOSTART_REQUESTED bus event) ─────────────────

  private async _handleChatRequest(evt: AutostartRequestEvent): Promise<void> {
    if (!evt?.agent_id || !evt.room_id) return;
    const cls = await this.classify(evt.agent_id);
    if (cls.reachable) return; // came online between send and here — nothing to do
    if (!cls.agent) return;    // agent deleted between send and here

    const attempted = await this._attemptAutostart(evt.agent_id);
    const outcome = this._effectiveOutcome(evt.agent_id, attempted);

    const key = `${evt.room_id}:${evt.agent_id}`;
    const last = this.lastChatFeedback.get(key);
    if (last !== undefined && Date.now() - last < CHAT_FEEDBACK_DEBOUNCE_MS) return;
    this.lastChatFeedback.set(key, Date.now());

    const who = evt.agent_name ? `**${evt.agent_name}**` : '이 에이전트';
    const message = this._composeMessage(who, cls.state, outcome);
    try {
      await this.roomMessaging.sendSystemMessage(evt.room_id, evt.workspace_id, `⏳ ${message}`);
    } catch (e) {
      this.logService.warn('AgentAutostart', 'chat unreachable-agent system message failed', {
        err: String(e), room_id: evt.room_id, agent_id: evt.agent_id,
      });
    }
  }
}
