import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import { OrchestrationApproval } from '../../entities/OrchestrationApproval';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { OrchestrationStep } from '../../entities/OrchestrationStep';
import { ChatRoom } from '../../entities/ChatRoom';
import { Account } from '../../entities/Account';
import { LogService } from '../../services/log.service';
import { UserChannelDispatcherService } from '../../services/notification-providers';
import type { NotifyPayload } from '../../services/notification-providers/types';
import { publicBaseUrl } from '../../common/public-url';
import { resolveAgentDisplayName } from '../../utils/agent-name';
import { callerHoldsId } from '../mcp/shared/session-auth';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { IN_FLIGHT_STEP_STATUSES, isInFlight, isTerminalMissionStatus, type OrchestrationCaller } from './orchestration.constants';
import { orchestrationError } from './orchestration-errors';
import { OrchestrationMissionService } from './orchestration-mission.service';
import { readRuntimeRoster } from './orchestration-roster';
import {
  APPROVAL_REQUESTER_GONE_MS,
  APPROVAL_WAIT_MAX_MS,
  approvalRouteFor,
  approvalWireView,
  describeApprovalRequest,
  isApprovalDecision,
  isOrchestratorApprovalDecision,
  orchestratorAnswerWindowMs,
  orchestratorMayApprove,
  renderApprovalWakePrompt,
  statusForDecision,
  summarizeApprovalInput,
  type ApprovalDecision,
  type ApprovalRequesterRole,
  type ApprovalRouteReason,
  projectApproval,
  type ApprovalView,
  type ApprovalWireView,
} from './orchestration-approval';

/** Same pseudo-sender every orchestration wake uses (orchestration-runner.service.ts). */
const SYSTEM_SENDER_ID = 'system';
const SYSTEM_SENDER_NAME = 'Orchestration';
/** Upper bound on one notice fan-out — same reason as the confirm-gate notice. */
const SEND_TIMEOUT_MS = 15_000;

/** Who is calling the Runtime Host endpoints (stamped by AgentAuthGuard). */
export interface ApprovalHostCaller {
  /** Scope of the presented key; null = full scope (env/admin key). */
  accountId: string | null;
  /** Set when the key is a runtime key — it may only speak for that identity. */
  runtimeKey: string | null;
  /** Set for host-bound keys — the requester must run on this host. */
  hostId: string | null;
}

export interface ApprovalRequestInput {
  room_id?: unknown;
  agent_id?: unknown;
  request_key?: unknown;
  tool_name?: unknown;
  title?: unknown;
  description?: unknown;
  input?: unknown;
  can_allow_session?: unknown;
}

export interface ApprovalDecider {
  type: 'orchestrator' | 'user';
  id: string;
  name: string;
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Tool approvals for mission runtimes (docs/orchestration.md → "실행 승인").
 *
 * The Runtime Host relays a CLI's permission prompt here (`request`) and long-polls the answer
 * (`wait`). The answer comes from the orchestrator (MCP `decide_orchestration_approval`) when its
 * slot is trusted, otherwise from the user (mission screen). Routing rules live in
 * `orchestration-approval.ts`; this service owns the row's lifecycle:
 *
 *   - Every transition is a compare-and-set on `status = 'pending'` — two deciders racing (the
 *     orchestrator and a user overriding it, two servers) end with exactly one decision.
 *   - The requester's polls are its liveness. A poll also counts as the member step's heartbeat —
 *     a member blocked on an answer cannot call `report_orchestration_progress`, and the step
 *     reaper must not time it out for waiting on someone else.
 *   - A request whose requester is gone or whose attempt is superseded is cancelled rather than
 *     left for a user to approve into nowhere.
 *
 * Public notice/announce paths never throw into a decision — losing a notice is better than
 * failing the transition that needed it.
 */
@Injectable()
export class OrchestrationApprovalService {
  /** approval id → resolvers of long-polls waiting on it (this process only; others re-read). */
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    @InjectRepository(OrchestrationApproval) private readonly approvalRepo: Repository<OrchestrationApproval>,
    @InjectRepository(OrchestrationMission) private readonly missionRepo: Repository<OrchestrationMission>,
    @InjectRepository(OrchestrationStep) private readonly stepRepo: Repository<OrchestrationStep>,
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly missions: OrchestrationMissionService,
    private readonly messaging: RoomMessagingService,
    private readonly dispatcher: UserChannelDispatcherService,
    private readonly logService: LogService,
  ) {}

  // ── Runtime Host side ─────────────────────────────────────────────────────

  /**
   * A CLI in a mission room asks to use a tool. Idempotent on (requester, request_key): a
   * manager that re-sends after a lost response lands on the same row.
   */
  async request(input: ApprovalRequestInput, caller: ApprovalHostCaller): Promise<ApprovalWireView> {
    const roomId = str(input.room_id, 100);
    const agentId = str(input.agent_id, 200);
    const requestKey = str(input.request_key, 200);
    const toolName = str(input.tool_name, 200);
    if (!roomId || !agentId || !requestKey || !toolName) {
      throw orchestrationError(400, 'room_id, agent_id, request_key and tool_name are required');
    }
    const existing = await this.approvalRepo.findOne({ where: { requester_agent_id: agentId, request_key: requestKey } });
    if (existing) {
      this.assertRequester(existing.requester_agent_id, existing.account_id, caller, agentId);
      return approvalWireView(existing);
    }

    const room = await this.roomRepo.findOne({ where: { id: roomId } });
    if (!room?.orchestration_mission_id) throw orchestrationError(404, 'not a mission room');
    if (caller.accountId && caller.accountId !== room.account_id) throw orchestrationError(403, 'account_scope_denied');
    const mission = await this.missionRepo.findOne({ where: { id: room.orchestration_mission_id } });
    if (!mission) throw orchestrationError(404, 'mission not found');

    const requester = await this.resolveRequester(room, mission, agentId, caller);
    if (isTerminalMissionStatus(mission.status)) return this.refusal(`the mission is ${mission.status}`);
    if (requester.step && (!isInFlight(requester.step.status) || requester.step.room_id !== room.id)) {
      return this.refusal('this step attempt is no longer running');
    }

    const now = new Date();
    const { route, reason } = approvalRouteFor({
      requesterRole: requester.role,
      orchestratorTrusted: orchestratorMayApprove(mission),
    });
    let row: OrchestrationApproval;
    try {
      row = await this.approvalRepo.save(this.approvalRepo.create({
        account_id: mission.account_id,
        mission_id: mission.id,
        step_id: requester.step?.id ?? null,
        step_key: requester.step?.step_key ?? null,
        room_id: room.id,
        requester_role: requester.role,
        requester_agent_id: agentId,
        requester_name: requester.name,
        request_key: requestKey,
        tool_name: toolName,
        title: str(input.title, 1000),
        description: str(input.description, 4000),
        input: summarizeApprovalInput(input.input),
        can_allow_session: input.can_allow_session === true,
        status: 'pending',
        route,
        route_reason: reason,
        routed_at: now,
        last_polled_at: now,
      }));
    } catch (e) {
      // Two sends of the same request raced past the lookup — the unique index kept one.
      const winner = await this.approvalRepo.findOne({ where: { requester_agent_id: agentId, request_key: requestKey } });
      if (winner) return approvalWireView(winner);
      throw e;
    }

    await this.missions.recordEvent(mission, {
      type: 'approval_requested',
      step_id: row.step_id,
      step_key: row.step_key ?? '',
      message:
        `${row.requester_name} asks to use ${describeApprovalRequest(row)} — ` +
        (route === 'orchestrator' ? 'the orchestrator decides' : 'waiting for your approval'),
      actor_type: 'agent',
      actor_id: agentId,
      data: { approval_id: row.id, tool_name: row.tool_name, route, route_reason: reason },
    });

    if (route === 'orchestrator') {
      const delivered = await this.wakeOrchestrator(mission, row, requester.step);
      if (!delivered) {
        const moved = await this.escalate(row, 'orchestrator_unreachable', '');
        return approvalWireView(moved);
      }
    } else {
      this.scheduleUserNotice(row);
    }
    return approvalWireView(row);
  }

  /**
   * Long-poll for the answer. Each call proves the requester still waits (and keeps a member
   * step's lease alive), settles requests that can no longer be answered usefully, and moves an
   * unanswered orchestrator request to the user once its window passes.
   */
  async wait(id: string, agentId: string, caller: ApprovalHostCaller, timeoutMs: number): Promise<ApprovalWireView> {
    let row = await this.approvalRepo.findOne({ where: { id } });
    if (!row) throw orchestrationError(404, 'approval not found');
    this.assertRequester(row.requester_agent_id, row.account_id, caller, agentId);
    if (row.status !== 'pending') return approvalWireView(row);

    // 기다리는 자리를 먼저 잡는다 — 아래 확인들(DB 왕복) 사이에 답이 오면 그 신호를 놓치고 타임아웃까지
    // 잠들게 된다. 자리를 잡은 뒤의 결정은 신호로, 그 전의 결정은 아래 재조회로 잡힌다.
    const ms = Math.max(0, Math.min(APPROVAL_WAIT_MAX_MS, Number.isFinite(timeoutMs) ? timeoutMs : APPROVAL_WAIT_MAX_MS));
    const waiter = this.waitForSignal(row.id, ms);
    try {
      await this.touch(row);
      row = await this.settle(row, new Date());
      if (row.status !== 'pending') return approvalWireView(row);
      const current = await this.approvalRepo.findOne({ where: { id } });
      if (!current || current.status !== 'pending' || ms === 0) return approvalWireView(current ?? row);
      await waiter.done;
      return approvalWireView((await this.approvalRepo.findOne({ where: { id } })) ?? row);
    } finally {
      waiter.release();
    }
  }

  /** The requester stopped waiting (CLI interrupted, process exiting). */
  async cancelByRequester(id: string, agentId: string, caller: ApprovalHostCaller, reason: string): Promise<ApprovalWireView> {
    const row = await this.approvalRepo.findOne({ where: { id } });
    if (!row) throw orchestrationError(404, 'approval not found');
    this.assertRequester(row.requester_agent_id, row.account_id, caller, agentId);
    if (row.status !== 'pending') return approvalWireView(row);
    return approvalWireView(await this.cancel(row, str(reason, 500) || 'the requesting session stopped waiting'));
  }

  // ── Deciders ──────────────────────────────────────────────────────────────

  /** MCP `decide_orchestration_approval` — the mission's trusted orchestrator answers a member. */
  async decideAsOrchestrator(
    id: string,
    caller: OrchestrationCaller,
    decision: unknown,
    reason: unknown,
  ): Promise<{ approval: ApprovalView; already_decided: boolean }> {
    if (!caller.agentId && !caller.runtimeKey) throw orchestrationError(401, 'this tool requires an authenticated agent session');
    if (!isOrchestratorApprovalDecision(decision)) {
      throw orchestrationError(400, 'decision must be one of: allow, allow_session, deny, escalate');
    }
    const row = await this.approvalRepo.findOne({ where: { id } });
    if (!row) throw orchestrationError(404, 'approval not found');
    const mission = await this.missions.requireMission(row.mission_id);
    if (!callerHoldsId(caller, mission.orchestrator_agent_id)) {
      throw orchestrationError(403, `only the orchestrator of mission ${mission.id} may decide its members' approvals`);
    }
    if (!orchestratorMayApprove(mission)) {
      throw orchestrationError(
        403,
        'your slot is not trusted, so you cannot approve for others — the user decides this request in the AWB mission screen',
      );
    }
    const note = str(reason, 2000);
    if (row.status !== 'pending') {
      if (decision !== 'escalate' && row.decision === decision) return { approval: projectApproval(row), already_decided: true };
      throw orchestrationError(409, `this request is already ${row.status}`);
    }
    if (row.route !== 'orchestrator') {
      throw orchestrationError(409, 'this request is with the user now — they decide it in the mission screen');
    }
    const name = (await resolveAgentDisplayName(this.dataSource, caller.runtimeKey || caller.agentId)) || 'Orchestrator';
    if (decision === 'escalate') {
      const moved = await this.escalate(row, 'orchestrator_escalated', note);
      if (moved.route !== 'user' && moved.status === 'pending') throw orchestrationError(409, 'the request changed while you decided — read it again');
      return { approval: projectApproval(moved), already_decided: false };
    }
    return this.finalize(row, decision, { type: 'orchestrator', id: caller.runtimeKey || caller.agentId, name }, note, mission);
  }

  /** REST — the user answers from the mission screen. May overrule a request still with the orchestrator. */
  async decideAsUser(
    id: string,
    accountId: string,
    user: { id: string; name: string },
    decision: unknown,
    note: unknown,
  ): Promise<{ approval: ApprovalView; already_decided: boolean }> {
    if (!isApprovalDecision(decision)) throw orchestrationError(400, 'decision must be one of: allow, allow_session, deny');
    const row = await this.approvalRepo.findOne({ where: { id } });
    if (!row || (accountId && row.account_id !== accountId)) throw orchestrationError(404, 'approval not found');
    const mission = await this.missions.requireMission(row.mission_id, row.account_id);
    if (row.status !== 'pending') {
      if (row.decision === decision) return { approval: projectApproval(row), already_decided: true };
      throw orchestrationError(409, `this request is already ${row.status}`);
    }
    return this.finalize(row, decision, { type: 'user', id: user.id, name: user.name }, str(note, 2000), mission);
  }

  // ── Reaper ────────────────────────────────────────────────────────────────

  /**
   * Settle what no poll will settle: requests whose requester stopped polling, and orchestrator
   * requests past their window when the requester's poll hasn't come around yet. Bounded per sweep;
   * the oldest go first so nothing starves.
   */
  async sweep(now: Date = new Date()): Promise<{ cancelled: number; escalated: number }> {
    let cancelled = 0;
    let escalated = 0;
    const gone = await this.approvalRepo.find({
      where: { status: 'pending', last_polled_at: LessThan(new Date(now.getTime() - APPROVAL_REQUESTER_GONE_MS)) },
      order: { last_polled_at: 'ASC' },
      take: 100,
    });
    for (const row of gone) {
      const after = await this.cancel(row, 'the requesting session is no longer waiting for an answer');
      if (after.status === 'cancelled') cancelled += 1;
    }
    const overdue = await this.approvalRepo.find({
      where: { status: 'pending', route: 'orchestrator', routed_at: LessThan(new Date(now.getTime() - orchestratorAnswerWindowMs())) },
      order: { routed_at: 'ASC' },
      take: 100,
    });
    for (const row of overdue) {
      const after = await this.escalate(row, 'orchestrator_timeout', '');
      if (after.route === 'user' && after.status === 'pending') escalated += 1;
    }
    return { cancelled, escalated };
  }

  /** Missions with a runtime blocked on an answer — the stall reaper leaves them alone. */
  async missionsWithPendingRequests(missionIds: string[]): Promise<Set<string>> {
    if (missionIds.length === 0) return new Set();
    const rows = await this.approvalRepo.find({
      where: { mission_id: In(missionIds), status: 'pending' },
      select: ['id', 'mission_id'],
    });
    return new Set(rows.map((r) => r.mission_id));
  }

  /** Wait for in-flight notices (tests, shutdown). Never throws. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled(Array.from(this.inFlight));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private refusal(reason: string): ApprovalWireView {
    return { id: null, status: 'cancelled', route: null, decision: null, message: `Not asked: ${reason}. Do not retry the same action.` };
  }

  /**
   * A runtime key speaks only for itself. A host-bound manager key speaks for the runtimes on its
   * host. The account scope of the key must match the request either way.
   */
  private assertRequester(storedAgentId: string, accountId: string, caller: ApprovalHostCaller, presentedAgentId: string): void {
    if (caller.accountId && caller.accountId !== accountId) throw orchestrationError(403, 'account_scope_denied');
    if (presentedAgentId && presentedAgentId !== storedAgentId) throw orchestrationError(403, 'this approval belongs to another runtime');
    if (caller.runtimeKey && caller.runtimeKey !== storedAgentId) throw orchestrationError(403, 'this approval belongs to another runtime');
  }

  private async resolveRequester(
    room: ChatRoom,
    mission: OrchestrationMission,
    agentId: string,
    caller: ApprovalHostCaller,
  ): Promise<{ role: ApprovalRequesterRole; step: OrchestrationStep | null; name: string }> {
    if (caller.runtimeKey && caller.runtimeKey !== agentId) throw orchestrationError(403, 'a runtime key may only ask for itself');
    const roster = readRuntimeRoster(mission.runtime_roster);
    if (room.orchestration_step_id) {
      const step = await this.stepRepo.findOne({ where: { id: room.orchestration_step_id } });
      if (!step || step.mission_id !== mission.id) throw orchestrationError(404, 'step not found');
      if (!callerHoldsId({ agentId, runtimeKey: agentId }, step.assignee_agent_id)) {
        throw orchestrationError(403, `step "${step.step_key}" is assigned to another runtime`);
      }
      this.assertHost(caller, (step.assignee_spec as any)?.manager_agent_id);
      const slotName = roster?.members.find((m) => m.slot_id === step.assignee_slot)?.name;
      const name = slotName || (await resolveAgentDisplayName(this.dataSource, agentId)) || agentId;
      return { role: 'member', step, name };
    }
    if (room.id !== mission.room_id || !callerHoldsId({ agentId, runtimeKey: agentId }, mission.orchestrator_agent_id)) {
      throw orchestrationError(403, 'only the mission orchestrator runs in this room');
    }
    this.assertHost(caller, (mission.orchestrator_spec as any)?.manager_agent_id);
    const name = roster?.orchestrator?.name || (await resolveAgentDisplayName(this.dataSource, agentId)) || agentId;
    return { role: 'orchestrator', step: null, name };
  }

  private assertHost(caller: ApprovalHostCaller, requesterHost: unknown): void {
    if (caller.runtimeKey || !caller.hostId) return;
    if (typeof requesterHost === 'string' && requesterHost && requesterHost !== caller.hostId) {
      throw orchestrationError(403, 'this runtime runs on another host');
    }
  }

  /** Requester liveness + the member step's heartbeat (see class comment). */
  private async touch(row: OrchestrationApproval): Promise<void> {
    const now = new Date();
    try {
      await this.approvalRepo.update({ id: row.id, status: 'pending' }, { last_polled_at: now });
      if (row.step_id) {
        await this.stepRepo
          .createQueryBuilder()
          .update(OrchestrationStep)
          .set({ last_heartbeat_at: now, lease_stale_since: null })
          .where('id = :id', { id: row.step_id })
          .andWhere('room_id = :roomId', { roomId: row.room_id })
          .andWhere('status IN (:...statuses)', { statuses: IN_FLIGHT_STEP_STATUSES as unknown as string[] })
          .execute();
      }
    } catch (e: any) {
      this.logService.warn('Orchestration', `approval poll bookkeeping failed for ${row.id}: ${e?.message || e}`);
    }
  }

  /** Cancel what can no longer be answered usefully; hand overdue orchestrator requests to the user. */
  private async settle(row: OrchestrationApproval, now: Date): Promise<OrchestrationApproval> {
    const mission = await this.missionRepo.findOne({ where: { id: row.mission_id } });
    if (!mission || isTerminalMissionStatus(mission.status)) {
      return this.cancel(row, mission ? `the mission is ${mission.status}` : 'the mission was deleted');
    }
    if (row.step_id) {
      const step = await this.stepRepo.findOne({ where: { id: row.step_id } });
      if (!step || step.room_id !== row.room_id || !isInFlight(step.status)) {
        return this.cancel(row, 'this step attempt is no longer running');
      }
    } else if (mission.room_id !== row.room_id) {
      return this.cancel(row, 'the mission conversation moved to another room');
    }
    if (row.route === 'orchestrator') {
      if (!orchestratorMayApprove(mission)) return this.escalate(row, 'orchestrator_not_trusted', '');
      if (now.getTime() - new Date(row.routed_at).getTime() > orchestratorAnswerWindowMs()) {
        return this.escalate(row, 'orchestrator_timeout', '');
      }
    }
    return row;
  }

  private async finalize(
    row: OrchestrationApproval,
    decision: ApprovalDecision,
    by: ApprovalDecider,
    note: string,
    mission: OrchestrationMission,
  ): Promise<{ approval: ApprovalView; already_decided: boolean }> {
    const decidedAt = new Date();
    const patch = {
      status: statusForDecision(decision),
      decision,
      decided_by_type: by.type,
      decided_by: by.id,
      decided_by_name: by.name.slice(0, 200),
      decision_note: note,
      decided_at: decidedAt,
    };
    const won = await this.compareAndSet(row.id, patch, by.type === 'orchestrator' ? { route: 'orchestrator' } : {});
    const fresh = (await this.approvalRepo.findOne({ where: { id: row.id } })) ?? row;
    if (!won) {
      if (fresh.status !== 'pending' && fresh.decision === decision) return { approval: projectApproval(fresh), already_decided: true };
      throw orchestrationError(409, `this request is already ${fresh.status === 'pending' ? 'with the user' : fresh.status}`);
    }
    this.signal(row.id);
    const verb = decision === 'deny' ? 'denied' : decision === 'allow_session' ? 'allowed for the session' : 'allowed';
    await this.missions.recordEvent(mission, {
      type: 'approval_decided',
      step_id: row.step_id,
      step_key: row.step_key ?? '',
      message:
        `${by.type === 'user' ? by.name || 'User' : 'Orchestrator'} ${verb} ${describeApprovalRequest(row)} for ${row.requester_name}` +
        (note ? `: ${note.slice(0, 300)}` : '') +
        (by.type === 'user' && row.route === 'orchestrator' ? ' (overruling the orchestrator)' : ''),
      actor_type: by.type === 'user' ? 'user' : 'agent',
      actor_id: by.id,
      actor_name: by.name,
      data: { approval_id: row.id, decision, decided_by_type: by.type },
    });
    return { approval: projectApproval(fresh), already_decided: false };
  }

  private async cancel(row: OrchestrationApproval, reason: string): Promise<OrchestrationApproval> {
    const won = await this.compareAndSet(row.id, {
      status: 'cancelled',
      decided_by_type: 'system',
      decided_by: null,
      decided_by_name: 'AWB',
      decision_note: reason.slice(0, 500),
      decided_at: new Date(),
    });
    const fresh = (await this.approvalRepo.findOne({ where: { id: row.id } })) ?? row;
    if (!won) return fresh;
    this.signal(row.id);
    const mission = await this.missionRepo.findOne({ where: { id: row.mission_id } });
    if (mission) {
      await this.missions.recordEvent(mission, {
        type: 'approval_cancelled',
        step_id: row.step_id,
        step_key: row.step_key ?? '',
        message: `Approval request for ${describeApprovalRequest(row)} by ${row.requester_name} withdrawn — ${reason}`,
        actor_type: 'system',
        data: { approval_id: row.id },
      });
    }
    return fresh;
  }

  private async escalate(row: OrchestrationApproval, reason: ApprovalRouteReason, note: string): Promise<OrchestrationApproval> {
    const won = await this.compareAndSet(
      row.id,
      { route: 'user', route_reason: reason, routed_at: new Date(), ...(note ? { decision_note: note } : {}) },
      { route: 'orchestrator' },
    );
    const fresh = (await this.approvalRepo.findOne({ where: { id: row.id } })) ?? row;
    if (!won) return fresh;
    this.signal(row.id);
    const mission = await this.missionRepo.findOne({ where: { id: row.mission_id } });
    if (mission) {
      const why = reason === 'orchestrator_escalated'
        ? `the orchestrator asked you to decide${note ? `: ${note.slice(0, 300)}` : ''}`
        : reason === 'orchestrator_timeout'
          ? 'the orchestrator did not answer in time'
          : reason === 'orchestrator_unreachable'
            ? 'the orchestrator could not be reached'
            : 'the orchestrator is no longer trusted to approve';
      await this.missions.recordEvent(mission, {
        type: 'approval_escalated',
        step_id: row.step_id,
        step_key: row.step_key ?? '',
        message: `${row.requester_name}'s request to use ${describeApprovalRequest(row)} needs your approval — ${why}`,
        actor_type: reason === 'orchestrator_escalated' ? 'agent' : 'system',
        actor_id: reason === 'orchestrator_escalated' ? mission.orchestrator_agent_id || '' : '',
        data: { approval_id: row.id, route_reason: reason },
      });
    }
    this.scheduleUserNotice(fresh);
    return fresh;
  }

  /** One UPDATE decides the race: only a still-pending row (on the expected route) moves. */
  private async compareAndSet(id: string, patch: Record<string, unknown>, extra: { route?: string } = {}): Promise<boolean> {
    try {
      const qb = this.approvalRepo
        .createQueryBuilder()
        .update(OrchestrationApproval)
        .set(patch)
        .where('id = :id', { id })
        .andWhere('status = :status', { status: 'pending' });
      if (extra.route) qb.andWhere('route = :route', { route: extra.route });
      const result = await qb.execute();
      return (result.affected ?? 0) > 0;
    } catch (e: any) {
      this.logService.warn('Orchestration', `approval ${id} transition failed: ${e?.message || e}`);
      return false;
    }
  }

  /** Registers synchronously; `done` resolves on a signal or after `ms`, `release` drops the slot early. */
  private waitForSignal(id: string, ms: number): { done: Promise<void>; release: () => void } {
    let set = this.waiters.get(id);
    if (!set) {
      set = new Set();
      this.waiters.set(id, set);
    }
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (timer) clearTimeout(timer);
      const current = this.waiters.get(id);
      current?.delete(release);
      if (current && current.size === 0) this.waiters.delete(id);
      resolve();
    };
    timer = setTimeout(release, ms);
    timer.unref?.();
    set.add(release);
    return { done, release };
  }

  private signal(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    for (const done of Array.from(set)) done();
  }

  /** Post the request into the mission room — the same wake path every orchestration nudge uses. */
  private async wakeOrchestrator(mission: OrchestrationMission, row: OrchestrationApproval, step: OrchestrationStep | null): Promise<boolean> {
    if (!mission.room_id) return false;
    try {
      await this.messaging.sendMessage(
        mission.room_id,
        mission.account_id,
        'user',
        SYSTEM_SENDER_ID,
        SYSTEM_SENDER_NAME,
        renderApprovalWakePrompt({
          approvalId: row.id,
          memberName: row.requester_name,
          stepKey: row.step_key || '',
          stepTitle: step?.title || row.step_key || '',
          toolName: row.tool_name,
          title: row.title,
          description: row.description,
          inputText: row.input,
          canAllowSession: row.can_allow_session,
          answerWindowMs: orchestratorAnswerWindowMs(),
        }),
        undefined,
        undefined,
        'message',
        { bypassContentLimit: true },
      );
      return true;
    } catch (e: any) {
      this.logService.warn('Orchestration', `could not deliver approval ${row.id} to the orchestrator: ${e?.message || e}`, {
        mission_id: mission.id,
      });
      return false;
    }
  }

  /** Notify the user once per request, outside the caller's path (same contract as confirm gates). */
  private scheduleUserNotice(row: OrchestrationApproval): void {
    const job = this.sendUserNotice(row).catch((e: any) => {
      this.logService.warn('Orchestration', `approval notice for ${row.id} failed: ${e?.message || e}`);
    });
    const tracked: Promise<unknown> = job.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  private async sendUserNotice(row: OrchestrationApproval): Promise<void> {
    const claim = await this.approvalRepo
      .createQueryBuilder()
      .update(OrchestrationApproval)
      .set({ user_notified_at: new Date() })
      .where('id = :id', { id: row.id })
      .andWhere('status = :status', { status: 'pending' })
      .andWhere('route = :route', { route: 'user' })
      .andWhere('user_notified_at IS NULL')
      .execute();
    if (!(claim.affected ?? 0)) return;
    const mission = await this.missionRepo.findOne({ where: { id: row.mission_id } });
    if (!mission) return;

    const recipients = await this.recipients(mission);
    const base = publicBaseUrl();
    const payload: NotifyPayload = {
      title: `Approval needed: ${mission.title}`,
      body: [
        `${row.requester_name}${row.step_key ? ` (step ${row.step_key})` : ''} wants to use ${describeApprovalRequest(row)}.`,
        row.description ? `\n${row.description.slice(0, 800)}` : '',
        row.input ? `\n${row.input.slice(0, 1500)}` : '',
        '\nIt is blocked until you allow or deny it in the mission screen.',
      ].join('').slice(0, 3500),
      url: base ? `${base}/missions/${mission.id}` : undefined,
    };
    let sent = 0;
    let failed = 0;
    await Promise.all(recipients.map(async (uid) => {
      try {
        const r = await withTimeout(this.dispatcher.dispatchForUser(uid, 'notify_mention', payload), SEND_TIMEOUT_MS);
        sent += r.sent;
        failed += r.failed;
      } catch {
        failed += 1;
      }
    }));
    // The timeline row is what the voice announcer turns into the "needs your approval" cue.
    await this.missions.recordEvent(mission, {
      type: 'approval_notified',
      step_id: row.step_id,
      step_key: row.step_key ?? '',
      message: `Asked ${recipients.length} recipient(s) to approve ${describeApprovalRequest(row)} — ${sent} channel(s) reached`,
      actor_type: 'system',
      data: { approval_id: row.id, recipients: recipients.length, sent, failed },
    });
  }

  /** The person who started the mission; for an agent-created one, the owner of its Account. */
  private async recipients(mission: OrchestrationMission): Promise<string[]> {
    if (mission.created_by_type === 'user' && mission.created_by) return [mission.created_by];
    const account = await this.dataSource.getRepository(Account).findOne({ where: { id: mission.account_id } });
    return account?.owner_user_id ? [account.owner_user_id] : [];
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`notification send timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
