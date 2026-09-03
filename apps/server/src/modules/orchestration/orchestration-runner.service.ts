/**
 * The Orchestration engine: mission start, plan intake, step dispatch, result
 * intake, orchestrator wake-ups, and finalization.
 *
 * ── Why it dispatches through chat rooms ─────────────────────────────────────
 * Every outbound instruction — the orchestrator's brief, each member's work
 * order, each wake-up — is posted as the opening/subsequent message of a
 * ChatRoom via RoomMessagingService, exactly the way QaRunService and
 * ActionsService dispatch their runs. That pipeline already ends in
 * `chat_room_message` → agent-manager → subagent spawn, so orchestration needs
 * NO agent-manager change and no new SSE contract. Messages are sent as
 * sender_type 'user' with the synthetic 'system' sender id (not as a system
 * message) because that is the shape the manager treats as work to execute.
 *
 * ── Why there is a per-mission mutex ────────────────────────────────────────
 * `reportStep` is called concurrently by however many members are in flight.
 * Each call recomputes what is dispatchable and hands out parallelism slots, so
 * two simultaneous reports could each see "1 slot free" and both dispatch —
 * overshooting max_parallel_steps, or worse, dispatching the same step twice
 * into two rooms. Serializing per mission removes the read-modify-write race
 * without a DB-level lock (which sql.js could not honour anyway — see the
 * transaction-serialization note in CLAUDE.md).
 *
 * ── The two rules that keep a mission from silently dying ───────────────────
 * 1. A step only ever leaves flight through `reportStep`, an orchestrator
 *    decision, or the reaper. Nothing else can strand it.
 * 2. Whenever the engine can no longer make progress on its own — a failure, a
 *    blocked subtree, or nothing left that can be dispatched — it WAKES the
 *    orchestrator instead of stopping. While work IS progressing it stays quiet,
 *    so a parallel plan is never serialized behind the orchestrator's turnaround.
 *    The mission never ends implicitly; only `completeMission` (or an operator
 *    cancel) ends it.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { OrchestrationStep } from '../../entities/OrchestrationStep';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { Agent } from '../../entities/Agent';
import { Action } from '../../entities/Action';
import { ActionRun } from '../../entities/ActionRun';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { ActionsService } from '../actions/actions.service';
import { LogService } from '../../services/log.service';
import { OrchestrationMissionService, countSteps } from './orchestration-mission.service';
import { OrchestrationTeamService } from './orchestration-team.service';
import { OrchestrationConfirmNotifyService } from './orchestration-confirm-notify.service';
import { orchestrationError } from './orchestration-errors';
import { resolveAgentDisplayMap, resolveAgentDisplayName } from '../../utils/agent-name';
import {
  CONFIRM_FEEDBACK_MAX,
  CONFIRM_VERDICTS,
  ConfirmDecision,
  ConfirmVerdict,
  DEPENDENCY_SATISFYING_STATUSES,
  MAX_ARTIFACTS_PER_STEP,
  MissionCompletionCriterion,
  MissionPostAction,
  PlanStepInput,
  POST_ACTION_STALE_IN_FLIGHT_MS,
  SUMMARY_MAX,
  TERMINAL_MISSION_STATUSES,
  allCriteriaMet,
  isAwaitingUser,
  isInFlight,
  isTerminalStepStatus,
  normalizeCompletionCriteria,
  normalizeConfirmPolicy,
  postActionApplies,
  validatePlan,
} from './orchestration.constants';
import {
  ConfirmFeedbackContext,
  DependencyContext,
  RosterEntry,
  renderMissionPrompt,
  renderLeaseRecoveryNudge,
  renderStepPrompt,
  renderWakePrompt,
} from './orchestration-prompt';
import {
  GraphNode,
  GraphPatchChange,
  GraphPatchInput,
  GraphSpec,
  GraphSpecInput,
  MAX_GRAPH_PATCHES,
  MissionProgress,
  applyGraphPatch,
  carryGraphThroughReplan,
  computeMissionProgress,
  evaluateEdge,
  firedLoopBacks,
  graphFromWavePlan,
  loopBodyNodes,
  reachableVia,
  selectOutgoingEdges,
  validateGraphSpec,
} from './orchestration-graph';
import { expandGraphTemplate } from './orchestration-graph-templates';
import { RunProvision, resolveWorkspaceFolder } from '../../common/workspace-folder-options';
import { buildRunProvision } from '../../common/run-workspace-resolver';

/** Synthetic sender the dispatch messages are attributed to, mirroring QA/Actions. */
const SYSTEM_SENDER_ID = 'system';
const SYSTEM_SENDER_NAME = 'Orchestration';

export interface ActorRef {
  type: 'user' | 'agent' | 'system';
  id: string;
  name: string;
}

@Injectable()
export class OrchestrationRunnerService {
  /**
   * Per-mission serialization chain. Keyed by mission id; the value is the tail
   * of the promise chain for that mission. Entries are deleted when their chain
   * drains, so the map cannot grow without bound across a long-lived process.
   */
  private readonly missionLocks = new Map<string, Promise<unknown>>();

  constructor(
    @InjectRepository(OrchestrationMission) private readonly missionRepo: Repository<OrchestrationMission>,
    @InjectRepository(OrchestrationStep) private readonly stepRepo: Repository<OrchestrationStep>,
    @InjectRepository(OrchestrationTeam) private readonly teamRepo: Repository<OrchestrationTeam>,
    @InjectRepository(OrchestrationTeamMember) private readonly memberRepo: Repository<OrchestrationTeamMember>,
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectRepository(ChatRoomParticipant) private readonly participantRepo: Repository<ChatRoomParticipant>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(Action) private readonly actionRepo: Repository<Action>,
    @InjectRepository(ActionRun) private readonly actionRunRepo: Repository<ActionRun>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly messaging: RoomMessagingService,
    private readonly missions: OrchestrationMissionService,
    private readonly teams: OrchestrationTeamService,
    private readonly actionsService: ActionsService,
    private readonly logService: LogService,
    // 게이트 대기 사실을 AWB 화면 밖으로 내보낸다(티켓 a78cb566). 발송은 미션 락
    // 밖에서 배경으로 돈다 — 아래 openConfirmGate 주석 참고.
    //
    // **맨 뒤에 둔다.** 이 서비스는 여러 유닛 테스트가 스텁으로 직접 생성하므로,
    // 중간에 끼우면 그 호출부의 뒤쪽 인자가 통째로 한 칸씩 밀려 `logService` 가
    // undefined 가 된다(실제로 그렇게 깨졌다). 추가는 항상 뒤로.
    private readonly confirmNotify: OrchestrationConfirmNotifyService,
  ) {}

  /** Run `fn` with exclusive access to this mission's state machine. */
  private withMissionLock<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.missionLocks.get(missionId) ?? Promise.resolve();
    // `.catch` on the tail so one failed critical section never poisons the
    // chain for every later caller (they would all reject with the old error).
    const next = prev.catch(() => undefined).then(fn);
    this.missionLocks.set(missionId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.missionLocks.get(missionId) === next) this.missionLocks.delete(missionId);
      });
    return next;
  }

  // ── Mission lifecycle ─────────────────────────────────────────────────────

  /**
   * Brief the orchestrator and move the mission into `planning`.
   *
   * The room is created and the mission row is stamped BEFORE the prompt is
   * sent, so a send failure leaves a mission the operator can retry (status
   * rolls back to `draft`) rather than an orphaned room with no mission
   * pointing at it.
   */
  async startMission(missionId: string, workspaceId: string, actor: ActorRef): Promise<OrchestrationMission> {
    return this.withMissionLock(missionId, async () => {
      const mission = await this.missions.requireMission(missionId, workspaceId);
      if (mission.status !== 'draft') {
        throw orchestrationError(409, `mission is already ${mission.status}`);
      }

      const team = await this.teamRepo.findOne({ where: { id: mission.team_id } });
      if (!team) throw orchestrationError(404, 'orchestration team not found');
      if (team.enabled === 0) throw orchestrationError(409, `team "${team.name}" is disabled`);
      if (!team.orchestrator_agent_id) throw orchestrationError(400, `team "${team.name}" has no orchestrator agent`);

      const orchestrator = await this.agentRepo.findOne({ where: { id: team.orchestrator_agent_id } });
      if (!orchestrator) throw orchestrationError(400, 'orchestrator agent no longer exists');

      const roster = await this.buildRoster(team.id);
      if (roster.length === 0) {
        throw orchestrationError(
          400,
          `team "${team.name}" has no members — add at least one agent for the orchestrator to delegate to`,
        );
      }

      const room = await this.roomRepo.save(
        this.roomRepo.create({
          workspace_id: mission.workspace_id,
          type: 'group',
          name: `Mission: ${mission.title} · ${mission.id.slice(0, 8)}`,
          last_message_at: null,
          orchestration_mission_id: mission.id,
          orchestration_step_id: null,
        }),
      );
      await this.addRoomParticipants(room.id, orchestrator.id);

      mission.room_id = room.id;
      mission.orchestrator_agent_id = orchestrator.id;
      mission.status = 'planning';
      mission.started_at = new Date();
      await this.missionRepo.save(mission);

      const prompt = renderMissionPrompt({
        mission,
        teamName: team.name,
        teamPrompt: team.orchestrator_prompt,
        roster,
      });

      try {
        await this.postToRoom(room.id, mission.workspace_id, prompt);
      } catch (e: any) {
        mission.status = 'draft';
        mission.room_id = null;
        mission.started_at = null;
        await this.missionRepo.save(mission);
        await this.missions.recordEvent(mission, {
          type: 'error',
          message: `Failed to brief the orchestrator: ${e?.message || e}`,
          actor_type: 'system',
        });
        throw orchestrationError(e?.status ?? 502, `failed to brief orchestrator: ${e?.message || e}`);
      }

      await this.missions.recordEvent(mission, {
        type: 'mission_started',
        message: `Mission briefed to orchestrator ${await this.agentName(orchestrator.id)} (${roster.length} member(s) available)`,
        actor_type: actor.type,
        actor_id: actor.id,
        actor_name: actor.name,
        data: { room_id: room.id, orchestrator_agent_id: orchestrator.id },
      });
      this.logService.info('Orchestration', `mission ${mission.id} started → orchestrator ${orchestrator.id}`, {
        workspace_id: mission.workspace_id,
        room_id: room.id,
      });
      return mission;
    });
  }

  async pauseMission(missionId: string, workspaceId: string, actor: ActorRef): Promise<OrchestrationMission> {
    return this.withMissionLock(missionId, async () => {
      const mission = await this.missions.requireMission(missionId, workspaceId);
      if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) {
        throw orchestrationError(409, `mission is ${mission.status}`);
      }
      if (mission.status === 'paused') return mission;
      mission.status = 'paused';
      await this.missionRepo.save(mission);
      await this.missions.recordEvent(mission, {
        type: 'mission_paused',
        message:
          'Mission paused — no new steps will be dispatched. Steps already in flight keep running and their ' +
          'results will still be recorded.',
        actor_type: actor.type,
        actor_id: actor.id,
        actor_name: actor.name,
      });
      return mission;
    });
  }

  async resumeMission(missionId: string, workspaceId: string, actor: ActorRef): Promise<OrchestrationMission> {
    return this.withMissionLock(missionId, async () => {
      const mission = await this.missions.requireMission(missionId, workspaceId);
      if (mission.status !== 'paused') throw orchestrationError(409, `mission is ${mission.status}, not paused`);
      // A mission paused before its first plan landed goes back to `planning`;
      // otherwise it returns to `running` and the pump picks the plan back up.
      mission.status = mission.plan_version > 0 ? 'running' : 'planning';
      await this.missionRepo.save(mission);
      await this.missions.recordEvent(mission, {
        type: 'mission_resumed',
        message: 'Mission resumed',
        actor_type: actor.type,
        actor_id: actor.id,
        actor_name: actor.name,
      });
      await this.wakeAfterPump(mission, await this.pump(mission));
      return mission;
    });
  }

  async cancelMission(
    missionId: string,
    workspaceId: string,
    actor: ActorRef,
    reason: string,
  ): Promise<OrchestrationMission> {
    return this.withMissionLock(missionId, async () => {
      const mission = await this.missions.requireMission(missionId, workspaceId);
      if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) {
        throw orchestrationError(409, `mission is already ${mission.status}`);
      }
      const steps = await this.missions.listSteps(mission.id);
      const open = steps.filter((s) => !isTerminalStepStatus(s.status));
      for (const s of open) {
        s.status = 'cancelled';
        s.finished_at = new Date();
      }
      if (open.length) await this.stepRepo.save(open);

      mission.status = 'cancelled';
      mission.failure_reason = (reason || 'cancelled by operator').slice(0, 2000);
      mission.finished_at = new Date();
      await this.missionRepo.save(mission);
      await this.missions.recordEvent(mission, {
        type: 'mission_cancelled',
        message: `Mission cancelled: ${mission.failure_reason}${open.length ? ` (${open.length} open step(s) cancelled)` : ''}`,
        actor_type: actor.type,
        actor_id: actor.id,
        actor_name: actor.name,
      });
      // In-flight subagents are NOT killed: the manager owns their lifecycle and
      // there is no cancel channel for a chat-room dispatch. Their late reports
      // are rejected by reportStep (the mission is terminal), so a cancelled
      // mission cannot come back to life.
      return mission;
    });
  }

  /**
   * The orchestrator declaring the mission over. This is the ONLY clean exit.
   */
  async completeMission(
    missionId: string,
    callerAgentId: string,
    input: { status: 'completed' | 'failed'; summary: string },
  ): Promise<OrchestrationMission> {
    return this.withMissionLock(missionId, async () => {
      const mission = await this.missions.requireMission(missionId);
      this.requireOrchestrator(mission, callerAgentId);
      if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) {
        throw orchestrationError(409, `mission is already ${mission.status}`);
      }

      const steps = await this.missions.listSteps(mission.id);
      const open = steps.filter((s) => isInFlight(s.status));
      if (input.status === 'completed' && open.length > 0) {
        throw orchestrationError(
          409,
          `cannot complete: ${open.length} step(s) are still in flight (${open.map((s) => s.step_key).join(', ')}). ` +
            `Wait for their reports, or skip them with update_orchestration_step first.`,
        );
      }
      // 구조화된 완료 조건 게이트(티켓 2dc3c62f) — "completed"만 막는다:
      // 정당한 "failed" 종료는 정의상 충족되지 않은 criteria에 절대 발목
      // 잡혀선 안 된다. `[]`/null criteria(이 기능 이전에 만들어진 모든 미션,
      // 그리고 criteria를 정의한 적 없는 미션)는 no-op 게이트다 —
      // allCriteriaMet가 true를 반환하므로 기존 미션에 회귀가 없다.
      if (input.status === 'completed' && !allCriteriaMet(mission.completion_criteria)) {
        const unmet = (mission.completion_criteria ?? []).filter((c) => !c.met);
        throw orchestrationError(
          409,
          `cannot complete: ${unmet.length} completion criterion/criteria not yet met ` +
            `(${unmet.map((c) => c.key).join(', ')}). Verify them and mark each with ` +
            `update_orchestration_criteria, or complete with status:"failed" if the objective ` +
            `truly cannot be delivered.`,
        );
      }
      // Failing a mission mid-flight is legitimate (the orchestrator has decided
      // the objective is unreachable), so open steps are closed out rather than
      // blocking the call — otherwise a wedged step would trap the mission.
      if (open.length > 0) {
        for (const s of open) {
          s.status = 'cancelled';
          s.finished_at = new Date();
        }
        await this.stepRepo.save(open);
      }

      mission.status = input.status;
      mission.result_summary = (input.summary || '').slice(0, SUMMARY_MAX);
      mission.finished_at = new Date();
      if (input.status === 'failed') mission.failure_reason = 'orchestrator declared the mission failed';
      await this.missionRepo.save(mission);

      const orchestratorName = await this.agentName(mission.orchestrator_agent_id);
      await this.missions.recordEvent(mission, {
        type: input.status === 'completed' ? 'mission_completed' : 'mission_failed',
        message:
          input.status === 'completed'
            ? `Mission completed by ${orchestratorName}`
            : `Mission failed: ${mission.result_summary.slice(0, 300)}`,
        actor_type: 'agent',
        actor_id: callerAgentId,
        actor_name: orchestratorName,
        data: { counts: countSteps(await this.missions.listSteps(mission.id)) },
      });
      this.logService.info('Orchestration', `mission ${mission.id} ${input.status}`, {
        workspace_id: mission.workspace_id,
      });
      // 완료 후 Action을 발화한다(티켓 2dc3c62f). 이 기능 전체에서 유일한
      // 호출 지점이다 — cancelMission(운영자 중단)과 reaper의
      // failMissionExternally(포기)는 의도적으로 post_actions를 발화하지
      // 않는다: 둘 다 정상 종료가 아니고, completeMission이 "유일한 정상
      // 종료"이기 때문이다(이 파일 헤더 문서 참고). 위에서 이미 저장된
      // `mission.status`에는 절대 영향을 주지 않는다.
      await this.runPostActions(mission);
      return mission;
    });
  }

  /**
   * Orchestrator가 완료 조건 하나 이상을 met/unmet으로 뒤집는다(선택적 note
   * 포함). updateStep과 동일하게 mission-locked + orchestrator 전용이다.
   * dispatch/pump는 하지 않는다 — criteria는 완료 게이트를 위한 관찰
   * 대상이지 step DAG의 일부가 아니다.
   */
  async updateCriteria(
    missionId: string,
    callerAgentId: string,
    updates: Array<{ key: string; met: boolean; note?: string }>,
  ): Promise<OrchestrationMission> {
    return this.withMissionLock(missionId, async () => {
      const mission = await this.missions.requireMission(missionId);
      this.requireOrchestrator(mission, callerAgentId);
      if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) {
        throw orchestrationError(409, `mission is ${mission.status}`);
      }
      const existing = Array.isArray(mission.completion_criteria) ? mission.completion_criteria : [];
      if (existing.length === 0) {
        throw orchestrationError(
          409,
          'this mission has no structured completion criteria to update — acceptance_criteria (prose) is its ' +
            'only definition of done.',
        );
      }
      const byKey = new Map(existing.map((c) => [c.key, { ...c }]));
      const changed: string[] = [];
      for (const u of updates) {
        const key = String(u?.key ?? '').trim();
        const entry = byKey.get(key);
        if (!entry) {
          throw orchestrationError(400, `unknown completion criterion key "${u?.key}"`);
        }
        entry.met = u.met === true;
        entry.met_at = entry.met ? new Date().toISOString() : null;
        if (u.note !== undefined) entry.note = String(u.note).slice(0, 1000);
        byKey.set(key, entry);
        changed.push(key);
      }
      const next: MissionCompletionCriterion[] = existing.map((c) => byKey.get(c.key)!);
      // 쓰기 경로가 쓰는 것과 같은 normalizer로 재검증한다 — 손수 만든
      // `updates` 배열이 이 런타임 경로를 통해 잘못된 모양을 몰래 통과시키지
      // 못하게 한다(defense-in-depth — 위의 필드별 검사가 이미 흔한 경우는
      // 대부분 막는다).
      const revalidated = normalizeCompletionCriteria(next);
      if ('error' in revalidated) throw orchestrationError(400, revalidated.error);
      mission.completion_criteria = revalidated.criteria;
      await this.missionRepo.save(mission);

      const orchestratorName = await this.agentName(callerAgentId);
      const met = revalidated.criteria.filter((c) => c.met).length;
      await this.missions.recordEvent(mission, {
        type: 'criteria_updated',
        message: `${orchestratorName} updated completion criteria (${changed.join(', ')}) — ${met}/${revalidated.criteria.length} met`,
        actor_type: 'agent',
        actor_id: callerAgentId,
        actor_name: orchestratorName,
        data: { changed, criteria: revalidated.criteria },
      });
      return mission;
    });
  }

  /**
   * mission id + post_action의 `order`로부터 결정론적인 상관관계 키를
   * 만든다(리뷰 지적 2라운드 반영, 티켓 2dc3c62f). `dispatch()` 호출 시
   * `triggeredById`로 넘겨 ActionRun에 그대로 찍히게 하고, 나중에 크래시
   * 복구 시 이 값으로 ActionRun을 되찾아 실제로 디스패치가 성공했는지
   * 재확인하는 용도로 쓴다 — `order`는 미션 안에서 유일하다
   * (normalizePostActions가 배열 인덱스로 정렬하므로).
   */
  private postActionTriggerId(missionId: string, order: number): string {
    return `orchestration:${missionId}:${order}`;
  }

  /** 현재 배열 상태로부터 `post_actions_pending`을 다시 계산해 반영한다. */
  private syncPostActionsPendingFlag(mission: OrchestrationMission, list: MissionPostAction[]): void {
    mission.post_actions_pending = list.some((p) => p.status === 'pending' || p.status === 'in_flight');
  }

  /**
   * `condition`이 미션의 최종 status와 맞는 post_actions 항목을 `order` 순서로
   * 전부 디스패치한다. Fire-and-forget(MissionPostAction 문서 참고): 디스패치
   * 성공(run_id) 또는 실패를 기록할 뿐 재시도하지 않고 `mission.status`도
   * 절대 건드리지 않는다.
   *
   * **재시작/크래시 안전성(리뷰 지적 반영, 티켓 2dc3c62f)** — 이 메서드는 같은
   * 미션에 대해 몇 번을 다시 호출해도 안전하다(resumable):
   *   - `status !== 'pending'`인 항목은 건너뛴다 — 이미 skipped/dispatched/
   *     dispatch_failed로 확정된 항목은 다시 건드리지 않는다.
   *   - `status === 'in_flight'`인 항목(직전 호출이 dispatch() 도중 죽어서
   *     남은 흔적)은 **절대 dispatch()를 다시 호출하지 않는다** — 이미
   *     발화했을 수 있어 재호출하면 ActionRun이 중복 생성될 위험이 있다.
   *     대신 `POST_ACTION_STALE_IN_FLIGHT_MS`보다 오래 멈춰 있으면, 먼저
   *     `postActionTriggerId`로 실제 ActionRun이 이미 만들어졌는지
   *     조회한다(리뷰 2라운드 지적 — "dispatch 성공 후 run_id 저장 전
   *     크래시"의 감사 연결 유실을 여기서 복구한다): 찾으면 그 run_id/
   *     room_id로 `dispatched`를 확정하고, 못 찾으면 그제서야 결과 불명으로
   *     `dispatch_failed` 처리한다.
   *   - dispatch() 호출 **직전**에 `in_flight` + `dispatched_at`을 먼저
   *     저장한다 — completeMission()이 terminal status를 저장한 직후 ~ 이
   *     메서드가 끝나기 전 사이에 프로세스가 죽어도(리뷰 지적의 첫 번째
   *     crash-window), 남은 `pending`/`in_flight` 항목이 그대로 감사
   *     이력에 남아 reaper가 이어받을 수 있다.
   *   - 매 저장마다 `mission.post_actions_pending`을 재계산한다 —
   *     `OrchestrationReaperService`가 이 컬럼으로 미확정 미션을 정확히
   *     찾아내는 근거다(`finished_at DESC` 같은 최신순 창이 아니라).
   *
   * 호출자(completeMission 또는 recoverPostActions)가 이미 mission-lock을
   * 쥐고 있으므로 이 메서드 자신은 추가로 락을 걸지 않는다.
   */
  private async runPostActions(mission: OrchestrationMission): Promise<void> {
    const list = Array.isArray(mission.post_actions) ? mission.post_actions : [];
    if (list.length === 0) return;

    const orderedActions = [...list].sort((a, b) => a.order - b.order);
    mission.post_actions = orderedActions;

    for (const pa of orderedActions) {
      if (pa.status === 'in_flight') {
        const startedMs = pa.dispatched_at ? Date.parse(pa.dispatched_at) : NaN;
        const stale = !Number.isFinite(startedMs) || Date.now() - startedMs >= POST_ACTION_STALE_IN_FLIGHT_MS;
        if (!stale) continue; // 아직 유예시간 이내 — 다음 스윕에서 다시 판단

        // dispatch()가 실제로 ActionRun을 만든 뒤(그래서 재시도는 여전히
        // 금지) 그 run_id를 여기 저장하기 전에 죽었을 수 있다 — 재시도 대신
        // 그때 쓴 상관관계 키로 실제 생성 여부를 조회해 감사 연결을 복구한다.
        const triggerId = this.postActionTriggerId(mission.id, pa.order);
        const existingRun = await this.actionRunRepo.findOne({
          where: { action_id: pa.action_id, triggered_by_type: 'system', triggered_by_id: triggerId },
          order: { created_at: 'DESC' },
        });
        if (existingRun) {
          pa.status = 'dispatched';
          pa.run_id = existingRun.id;
          pa.room_id = existingRun.room_id;
          pa.error = '';
          this.syncPostActionsPendingFlag(mission, orderedActions);
          await this.missionRepo.save(mission);
          await this.missions.recordEvent(mission, {
            type: 'post_action_dispatched',
            message: `Post-action ${pa.action_id} was actually dispatched before a crash (run ${existingRun.id}) — recovered via correlation lookup`,
            actor_type: 'system',
            data: { action_id: pa.action_id, run_id: existingRun.id, room_id: existingRun.room_id, recovered: true },
          });
          continue;
        }

        pa.status = 'dispatch_failed';
        pa.error =
          'in_flight 상태로 멈춰 있었고, 상관관계 키로 조회해도 실제 생성된 ActionRun을 찾지 못했습니다 — ' +
          '디스패치 자체가 일어나지 않은 것으로 보고 재시도하지 않은 채 실패로 기록합니다.';
        this.syncPostActionsPendingFlag(mission, orderedActions);
        await this.missionRepo.save(mission);
        await this.missions.recordEvent(mission, {
          type: 'post_action_dispatch_failed',
          message: `Post-action ${pa.action_id} left stuck in-flight (likely a crash), no matching ActionRun found — treated as failed without retrying`,
          actor_type: 'system',
          data: { action_id: pa.action_id, error: pa.error, stale_in_flight: true },
        });
        continue;
      }
      if (pa.status !== 'pending') continue; // 이미 확정됨 — 재처리하지 않음(resumable의 핵심)

      if (!postActionApplies(pa.condition, mission.status)) {
        pa.status = 'skipped';
        this.syncPostActionsPendingFlag(mission, orderedActions);
        await this.missionRepo.save(mission);
        await this.missions.recordEvent(mission, {
          type: 'post_action_skipped',
          message: `Post-action ${pa.action_id} skipped (condition "${pa.condition}" does not match mission status "${mission.status}")`,
          actor_type: 'system',
          data: { action_id: pa.action_id },
        });
        continue;
      }

      // dispatch() 호출 "직전"에 in_flight로 저장한다 — 이 save와 dispatch()
      // 사이, 또는 dispatch() 도중에 죽어도 다음 재호출이 in_flight 흔적을
      // 보고 재시도 없이 안전하게 마무리 짓는다.
      pa.status = 'in_flight';
      pa.dispatched_at = new Date().toISOString();
      this.syncPostActionsPendingFlag(mission, orderedActions);
      await this.missionRepo.save(mission);

      try {
        const action = await this.actionRepo.findOne({ where: { id: pa.action_id } });
        if (!action) throw new Error(`action ${pa.action_id} not found`);
        if (action.workspace_id !== mission.workspace_id) {
          throw new Error(`action ${pa.action_id} belongs to a different workspace`);
        }
        const result = await this.actionsService.dispatch({
          actionId: action.id,
          triggeredByType: 'system',
          triggeredById: this.postActionTriggerId(mission.id, pa.order),
        });
        pa.status = 'dispatched';
        pa.run_id = result.run.id;
        pa.room_id = result.room_id;
        pa.error = '';
        this.syncPostActionsPendingFlag(mission, orderedActions);
        await this.missionRepo.save(mission);
        await this.missions.recordEvent(mission, {
          type: 'post_action_dispatched',
          message: `Post-action "${action.name}" dispatched (run ${result.run.id})`,
          actor_type: 'system',
          data: { action_id: action.id, run_id: result.run.id, room_id: result.room_id },
        });
      } catch (e: any) {
        pa.status = 'dispatch_failed';
        pa.error = String(e?.message || e).slice(0, 1000);
        this.syncPostActionsPendingFlag(mission, orderedActions);
        await this.missionRepo.save(mission);
        await this.missions.recordEvent(mission, {
          type: 'post_action_dispatch_failed',
          message: `Post-action ${pa.action_id} failed to dispatch: ${pa.error}`,
          actor_type: 'system',
          data: { action_id: pa.action_id, error: pa.error },
        });
        this.logService.warn('Orchestration', `post-action dispatch failed for mission ${mission.id}`, {
          action_id: pa.action_id,
          error: pa.error,
        });
      }
    }
  }

  /**
   * `runPostActions`의 공개 진입점(리뷰 지적 반영, 티켓 2dc3c62f) —
   * `OrchestrationReaperService`가 주기적으로 호출해 크래시로 중단된
   * post_actions를 이어받는다. terminal 미션에만 의미가 있고(그 외엔 no-op),
   * mission-lock 안에서 실행되어 진짜 동시 completeMission/다른 복구 스윕과
   * 안전하게 직렬화된다. `runPostActions` 자체가 resumable하므로 이 메서드는
   * 몇 번을 호출해도 안전하다.
   */
  async recoverPostActions(missionId: string): Promise<void> {
    return this.withMissionLock(missionId, async () => {
      const mission = await this.missions.requireMission(missionId);
      if (!(TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) return;
      await this.runPostActions(mission);
    });
  }

  // ── Plan intake ───────────────────────────────────────────────────────────

  /**
   * Accept a plan from the orchestrator and start executing it.
   *
   * Merge semantics (deliberately additive rather than destructive): a step_key
   * that already exists is UPDATED in place if it has not started, and left
   * alone if it is already in flight or terminal. New keys are appended. Steps
   * absent from the new plan are NOT deleted — deleting them would silently
   * discard completed work and its result context. The orchestrator removes
   * work explicitly with `update_orchestration_step action:"skip"`.
   */
  async submitPlan(
    missionId: string,
    callerAgentId: string,
    input: {
      summary?: string;
      steps: PlanStepInput[];
      graph?: GraphSpecInput | null;
      graph_template?: { name: string; params?: Record<string, unknown> } | null;
      reset_graph?: boolean;
    },
  ): Promise<{
    mission: OrchestrationMission;
    created: string[];
    updated: string[];
    dispatched: string[];
    graph: GraphSpec | null;
  }> {
    return this.withMissionLock(missionId, async () => {
      const mission = await this.missions.requireMission(missionId);
      this.requireOrchestrator(mission, callerAgentId);
      if (mission.status !== 'planning' && mission.status !== 'running') {
        throw orchestrationError(409, `mission is ${mission.status} — plans are only accepted while planning or running`);
      }
      if (mission.plan_version >= mission.max_plan_versions) {
        throw orchestrationError(
          409,
          `plan submission limit reached (${mission.max_plan_versions}). Finish the mission with ` +
            `complete_orchestration_mission, or ask an operator to raise the limit.`,
        );
      }

      const existing = await this.missions.listSteps(mission.id);
      const existingByKey = new Map(existing.map((s) => [s.step_key, s]));

      // Validate the SUBMITTED plan together with the keys already on record, so
      // a new step may depend on an already-completed one.
      const merged: PlanStepInput[] = [
        ...existing
          .filter((s) => !input.steps.some((n) => String(n.step_key).trim() === s.step_key))
          .map((s) => ({
            step_key: s.step_key,
            title: s.title,
            instructions: s.instructions,
            acceptance_criteria: s.acceptance_criteria,
            depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
            assignee_agent_id: s.assignee_agent_id ?? undefined,
          })),
        ...input.steps,
      ];
      const validated = validatePlan(merged, { maxSteps: mission.max_steps });
      if ('error' in validated) throw orchestrationError(400, validated.error);

      // ── 실행 그래프 확정(티켓 1ca9e49b) ────────────────────────────────────
      // graph_enabled=false면 이 미션은 기존 wave/DAG 계약 그대로다 — graph를
      // 보내오면 조용히 무시하지 않고 거부한다(조용한 무시는 오케스트레이터가
      // 분기/loop가 실제로 걸린 줄 알고 계획을 세우게 만든다).
      if ((input.graph || input.graph_template || input.reset_graph) && !mission.graph_enabled) {
        throw orchestrationError(
          400,
          'this mission does not have graph mode enabled — it executes the plain dependency plan. ' +
            'Ask an operator to enable graph mode on the mission, or submit the plan without a "graph", ' +
            '"graph_template" or "reset_graph".',
        );
      }
      // 손으로 쓴 그래프와 템플릿은 둘 다 "그래프 전체"를 확정하므로 동시에 받으면
      // 어느 쪽이 이기는지가 임의 규칙이 된다 — 조용히 하나를 고르지 않고 거부한다.
      if (input.graph && input.graph_template) {
        throw orchestrationError(
          400,
          'give either "graph" or "graph_template", not both — a template expands into a complete graph, ' +
            'so combining the two leaves it ambiguous which one defines the execution rules.',
        );
      }
      // reset_graph는 "그래프를 버리고 depends_on에서 다시 유도하라"는 뜻이므로, 어떤
      // 그래프를 쓸지 함께 지정하는 것과 모순된다 — 조용히 한쪽을 이기게 하지 않는다.
      if (input.reset_graph && (input.graph || input.graph_template)) {
        throw orchestrationError(
          400,
          'reset_graph discards the current graph and re-derives it from depends_on, so it cannot be ' +
            'combined with "graph" or "graph_template" — send the graph you want, or reset, not both.',
        );
      }
      let graphSpec: GraphSpec | null = mission.graph_spec ?? null;
      // 그래프가 통째로 새 기준선으로 갈렸는지. patch 카운터 리셋 판정에 쓴다 —
      // 참조 비교로는 "보존했지만 재검증이 새 객체를 돌려준" 경우를 교체로 오인한다.
      let graphReplaced = false;
      let graphCarriedNodes: string[] = [];
      if (mission.graph_enabled) {
        const nodeKeys = validated.steps.map((st) => String(st.step_key).trim());
        // confirm 정책은 **모든** 그래프 경로(신규/템플릿/보존)에 똑같이 적용된다 —
        // 한 경로만 빠져도 `none` 미션이 그 경로로 confirm 게이트를 얻는다(티켓 5dbe4aa2).
        const confirmPolicy = normalizeConfirmPolicy(mission.confirm_policy);
        if (input.graph_template) {
          const expanded = expandGraphTemplate(input.graph_template.name, input.graph_template.params, {
            nodeKeys,
            confirmPolicy,
          });
          if ('error' in expanded) throw orchestrationError(400, expanded.error);
          graphSpec = expanded.spec;
          graphReplaced = true;
        } else if (input.graph) {
          const checked = validateGraphSpec(input.graph, { nodeKeys, confirmPolicy });
          if ('error' in checked) throw orchestrationError(400, checked.error);
          graphSpec = checked.spec;
          graphReplaced = true;
        } else if (graphSpec && !input.reset_graph) {
          // 이미 확정된 그래프가 있으면 **보존**하고 이번 replan이 새로 만든 step만
          // 고립 node로 편입한다(티켓 301018c5). 재생성하면 조건 분기·bounded loop·
          // 그동안 적용한 patch가 오류도 경고도 없이 사라진다 — step 병합이 additive인
          // 것과 같은 원칙을 그래프에도 적용한다. 버리고 싶으면 reset_graph로 명시한다.
          const carried = carryGraphThroughReplan(graphSpec, { nodeKeys, confirmPolicy });
          if ('error' in carried) {
            throw orchestrationError(
              409,
              `the current execution graph cannot absorb this plan: ${carried.error} ` +
                `Send an explicit "graph"/"graph_template", or "reset_graph": true to re-derive it from depends_on.`,
            );
          }
          graphSpec = carried.spec;
          graphCarriedNodes = carried.added;
        } else {
          // 최초 계획이거나 reset_graph가 명시됐다 — depends_on을 무손실 승격한다
          // (wave adapter). 그래서 graph 모드 미션은 항상 그래프로 구동되고, 그래프를
          // 쓰지 않는 계획도 기존과 완전히 동일하게 동작한다.
          graphSpec = graphFromWavePlan(
            validated.steps.map((st) => ({ step_key: String(st.step_key).trim(), depends_on: st.depends_on ?? [] })),
          );
          graphReplaced = true;
        }
      }

      const roster = await this.buildRoster(mission.team_id);
      const rosterIds = new Set(roster.map((r) => r.agent_id));
      for (const s of input.steps) {
        const assignee = (s.assignee_agent_id || '').trim();
        if (assignee && !rosterIds.has(assignee)) {
          throw orchestrationError(
            400,
            `step "${s.step_key}": agent ${assignee} is not a member of this team. ` +
              `Valid assignees: ${roster.map((r) => `${r.agent_name} (${r.agent_id})`).join(', ')}`,
          );
        }
      }

      const nextVersion = mission.plan_version + 1;
      const created: string[] = [];
      const updated: string[] = [];
      const toSave: OrchestrationStep[] = [];

      validated.steps.forEach((s, index) => {
        const key = String(s.step_key).trim();
        const depends = Array.isArray(s.depends_on)
          ? Array.from(new Set(s.depends_on.map((d) => String(d).trim()).filter(Boolean)))
          : [];
        const found = existingByKey.get(key);
        const submitted = input.steps.some((n) => String(n.step_key).trim() === key);

        if (!found) {
          toSave.push(
            this.stepRepo.create({
              mission_id: mission.id,
              workspace_id: mission.workspace_id,
              team_id: mission.team_id,
              step_key: key,
              title: String(s.title).trim(),
              instructions: String(s.instructions ?? '').trim(),
              acceptance_criteria: String(s.acceptance_criteria ?? '').trim(),
              depends_on: depends,
              assignee_agent_id: (s.assignee_agent_id || '').trim() || null,
              status: 'pending',
              position: index,
              plan_version: nextVersion,
              attempt: 0,
              max_attempts: 2,
              retry_policy: s.retry_policy === 'manual' ? 'manual' : 'auto',
            }),
          );
          created.push(key);
          return;
        }

        // Re-order every surviving step so `position` keeps reflecting a legal
        // topological order after the merge.
        found.position = index;
        if (submitted) {
          if (isInFlight(found.status) || isTerminalStepStatus(found.status)) {
            // Already executing or done — content edits are ignored on purpose so
            // a replan can never rewrite the instructions under a running
            // subagent, or retroactively alter what a finished step was asked to do.
            this.logService.info(
              'Orchestration',
              `plan v${nextVersion} left step ${key} untouched (status=${found.status})`,
              { mission_id: mission.id },
            );
          } else {
            found.title = String(s.title).trim();
            found.instructions = String(s.instructions ?? '').trim();
            found.acceptance_criteria = String(s.acceptance_criteria ?? '').trim();
            found.depends_on = depends;
            const assignee = (s.assignee_agent_id || '').trim();
            if (assignee) found.assignee_agent_id = assignee;
            found.plan_version = nextVersion;
            updated.push(key);
          }
        }
        toSave.push(found);
      });

      await this.stepRepo.save(toSave);

      mission.plan_version = nextVersion;
      mission.plan_summary = (input.summary || '').slice(0, SUMMARY_MAX);
      // 그래프 전체가 새로 확정되면 patch 카운터도 새 기준선에서 다시 센다 — 이전
      // 그래프에 걸었던 patch 횟수를 새 그래프가 물려받을 이유가 없다. 반대로 그래프를
      // 보존한 replan은 그 patch들이 그대로 살아 있으므로 카운터도 이어간다.
      if (graphReplaced) mission.graph_revision = 0;
      mission.graph_spec = graphSpec;
      if (mission.status === 'planning') mission.status = 'running';
      await this.missionRepo.save(mission);

      const orchestratorName = await this.agentName(mission.orchestrator_agent_id);
      await this.missions.recordEvent(mission, {
        type: 'plan_submitted',
        message:
          `Plan v${nextVersion} submitted by ${orchestratorName}: ` +
          `${created.length} new step(s), ${updated.length} revised` +
          (input.summary ? ` — ${String(input.summary).slice(0, 200)}` : ''),
        actor_type: 'agent',
        actor_id: callerAgentId,
        actor_name: orchestratorName,
        data: {
          plan_version: nextVersion,
          created,
          updated,
          graph: graphSpec
            ? {
                nodes: graphSpec.nodes.length,
                edges: graphSpec.edges.length,
                conditional: graphSpec.edges.filter((e) => e.kind === 'conditional').length,
                loops: graphSpec.edges.filter((e) => e.kind === 'loop_back').length,
                max_total_visits: graphSpec.max_total_visits,
                // 그래프를 새로 깐 replan인지, 기존 그래프를 이어받은 replan인지를
                // trace에 남긴다 — 조건/loop가 어느 제출에서 사라졌는지 추적 가능해야 한다.
                carried: !graphReplaced,
                carried_nodes: graphCarriedNodes,
                graph_revision: mission.graph_revision ?? 0,
                confirm_nodes: graphSpec.nodes.filter((n) => n.kind === 'confirm').length,
              }
            : null,
        },
      });

      // 정책이 확인을 요구하는데 확정된 그래프에 confirm 노드가 하나도 없다(티켓 5dbe4aa2).
      // **거부하지 않는다** — "몇 개면 key_steps 를 만족하는가" 를 서버가 셀 방법이 없어
      // 정량 강제는 정상 계획까지 막는 브리틀한 게이트가 되기 때문이다. 대신 운영자가
      // 타임라인에서 "요청한 확인이 계획에 반영되지 않았다" 를 바로 볼 수 있게 남긴다.
      const confirmPolicyNow = normalizeConfirmPolicy(mission.confirm_policy);
      if (
        graphSpec &&
        (confirmPolicyNow === 'key_steps' || confirmPolicyNow === 'every_step') &&
        graphSpec.nodes.every((n) => n.kind !== 'confirm')
      ) {
        await this.missions.recordEvent(mission, {
          type: 'note',
          message:
            `This mission's confirm_policy is "${confirmPolicyNow}", but the submitted plan contains no user ` +
            `confirmation gate. The mission will run to completion without asking anyone.`,
          actor_type: 'system',
          data: { confirm_policy: confirmPolicyNow, confirm_nodes: 0, plan_version: nextVersion },
        });
      }

      const pumped = await this.pump(mission);
      await this.wakeAfterPump(mission, pumped);
      return { mission, created, updated, dispatched: pumped.dispatched, graph: graphSpec };
    });
  }

  /**
   * 실행 중인 미션의 그래프를 **부분** 수정한다(티켓 2fc8f99a).
   *
   * `submitPlan`과의 경계: 이 메서드는 그래프만 바꾼다 — step 을 만들지도, 지우지도,
   * 내용을 고치지도 않으므로 `plan_version`(replan 예산)을 소모하지 않는다. 반대로
   * node 를 늘리려면 step 이 먼저 있어야 하므로 그건 `submitPlan`의 일이다.
   *
   * 안전 규칙(이미 일어난 실행을 소급 무효화하지 않는다)과 구조 재검증은 전부 순수
   * 함수 `applyGraphPatch`에 있다 — 여기서는 락·영속화·이벤트·재펌프만 담당한다.
   *
   * 주의: patch 는 step 의 **상태**를 바꾸지 않는다. 죽은 분기 때문에 이미 `blocked`
   * 로 확정된 step 은 edge 를 고쳐도 스스로 되살아나지 않는다 — 오케스트레이터가
   * `update_orchestration_step action:"retry"` 로 명시적으로 되살려야 한다. 상태
   * 되돌리기를 여기 섞으면 "그래프를 고쳤더니 이미 실패 처리된 작업이 조용히 다시
   * 뛰더라"가 된다.
   */
  async patchGraph(
    missionId: string,
    callerAgentId: string,
    patch: GraphPatchInput,
  ): Promise<{
    mission: OrchestrationMission;
    graph: GraphSpec;
    changes: GraphPatchChange[];
    dispatched: string[];
  }> {
    return this.withMissionLock(missionId, async () => {
      const mission = await this.missions.requireMission(missionId);
      this.requireOrchestrator(mission, callerAgentId);
      if (mission.status !== 'planning' && mission.status !== 'running') {
        throw orchestrationError(
          409,
          `mission is ${mission.status} — the graph can only be patched while planning or running`,
        );
      }
      if (!mission.graph_enabled || !mission.graph_spec) {
        throw orchestrationError(
          400,
          'this mission has no execution graph to patch — it runs the plain dependency plan. Submit a plan ' +
            'with a "graph" (or "graph_template") on a graph-mode mission first.',
        );
      }
      if ((mission.graph_revision ?? 0) >= MAX_GRAPH_PATCHES) {
        throw orchestrationError(
          409,
          `graph patch limit reached (${MAX_GRAPH_PATCHES}). Resubmit the whole graph with ` +
            `submit_orchestration_plan, or finish the mission with complete_orchestration_mission.`,
        );
      }

      const steps = await this.missions.listSteps(mission.id);
      const applied = applyGraphPatch(mission.graph_spec, patch, {
        nodeKeys: steps.map((s) => s.step_key),
        confirmPolicy: normalizeConfirmPolicy(mission.confirm_policy),
        runtime: {
          nodes: steps.map((s) => ({
            key: s.step_key,
            status: s.status,
            visit: s.visit ?? 0,
            verdict: s.verdict ?? '',
          })),
          total_visits: mission.total_visits ?? 0,
        },
      });
      if ('error' in applied) throw orchestrationError(400, applied.error);

      mission.graph_spec = applied.spec;
      mission.graph_revision = (mission.graph_revision ?? 0) + 1;
      await this.missionRepo.save(mission);

      const orchestratorName = await this.agentName(mission.orchestrator_agent_id);
      const summary = applied.changes.map((c) => c.detail).join('; ');
      await this.missions.recordEvent(mission, {
        type: 'graph_patched',
        message:
          `Graph r${mission.graph_revision} patched by ${orchestratorName}: ` +
          `${summary.slice(0, 400)}${summary.length > 400 ? '…' : ''}`,
        actor_type: 'agent',
        actor_id: callerAgentId,
        actor_name: orchestratorName,
        data: {
          graph_revision: mission.graph_revision,
          changes: applied.changes,
          nodes: applied.spec.nodes.length,
          edges: applied.spec.edges.length,
          conditional: applied.spec.edges.filter((e) => e.kind === 'conditional').length,
          loops: applied.spec.edges.filter((e) => e.kind === 'loop_back').length,
          max_total_visits: applied.spec.max_total_visits,
        },
      });

      // patch 가 대기 중이던 node 의 join 조건을 열어줄 수 있으므로 즉시 재펌프한다.
      const pumped = await this.pump(mission);
      await this.wakeAfterPump(mission, pumped);
      return { mission, graph: applied.spec, changes: applied.changes, dispatched: pumped.dispatched };
    });
  }

  // ── Step-level orchestrator controls ──────────────────────────────────────

  /**
   * Orchestrator-driven mutation of one step: retry a failure, reassign it,
   * amend its instructions, or drop it from the plan.
   */
  async updateStep(
    stepId: string,
    callerAgentId: string,
    input: {
      action: 'retry' | 'reassign' | 'amend' | 'skip' | 'cancel';
      assignee_agent_id?: string;
      instructions?: string;
      acceptance_criteria?: string;
      reason?: string;
    },
  ): Promise<{ step: OrchestrationStep; dispatched: string[] }> {
    const step = await this.missions.requireStep(stepId);
    return this.withMissionLock(step.mission_id, async () => {
      const mission = await this.missions.requireMission(step.mission_id);
      this.requireOrchestrator(mission, callerAgentId);
      if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) {
        throw orchestrationError(409, `mission is ${mission.status}`);
      }
      // Re-read inside the lock: a concurrent report may have changed it between
      // the lookup above and our turn in the queue.
      const fresh = await this.missions.requireStep(stepId);
      const orchestratorName = await this.agentName(mission.orchestrator_agent_id);

      if (input.assignee_agent_id) {
        const roster = await this.buildRoster(mission.team_id);
        if (!roster.some((r) => r.agent_id === input.assignee_agent_id)) {
          throw orchestrationError(400, `agent ${input.assignee_agent_id} is not a member of this team`);
        }
      }

      switch (input.action) {
        case 'skip':
        case 'cancel': {
          if (isInFlight(fresh.status)) {
            throw orchestrationError(
              409,
              `step "${fresh.step_key}" is in flight — wait for its report before skipping it`,
            );
          }
          fresh.status = input.action === 'skip' ? 'skipped' : 'cancelled';
          fresh.finished_at = new Date();
          await this.stepRepo.save(fresh);
          await this.missions.recordEvent(mission, {
            type: 'step_skipped',
            step_id: fresh.id,
            step_key: fresh.step_key,
            message: `Step "${fresh.title}" ${fresh.status} by ${orchestratorName}${input.reason ? `: ${input.reason}` : ''}`,
            actor_type: 'agent',
            actor_id: callerAgentId,
            actor_name: orchestratorName,
          });
          break;
        }
        case 'amend': {
          if (isInFlight(fresh.status)) {
            throw orchestrationError(
              409,
              `step "${fresh.step_key}" is in flight — its assignee already has the current instructions. ` +
                `Wait for the report, then retry with amended instructions.`,
            );
          }
          if (input.instructions !== undefined) fresh.instructions = String(input.instructions).trim();
          if (input.acceptance_criteria !== undefined) {
            fresh.acceptance_criteria = String(input.acceptance_criteria).trim();
          }
          if (input.assignee_agent_id) fresh.assignee_agent_id = input.assignee_agent_id;
          await this.stepRepo.save(fresh);
          await this.missions.recordEvent(mission, {
            type: 'note',
            step_id: fresh.id,
            step_key: fresh.step_key,
            message: `Step "${fresh.title}" amended by ${orchestratorName}`,
            actor_type: 'agent',
            actor_id: callerAgentId,
            actor_name: orchestratorName,
          });
          break;
        }
        case 'reassign': {
          if (!input.assignee_agent_id) throw orchestrationError(400, 'assignee_agent_id is required to reassign');
          if (isInFlight(fresh.status)) {
            throw orchestrationError(409, `step "${fresh.step_key}" is in flight — cannot reassign mid-execution`);
          }
          fresh.assignee_agent_id = input.assignee_agent_id;
          if (isTerminalStepStatus(fresh.status)) fresh.status = 'pending';
          // 재배정은 needs_recovery 를 벗어나는 명시적 조치다 — 사유를 남겨두면
          // UI 가 이미 처리된 복구 요청을 계속 띄운다.
          fresh.recovery_reason = '';
          await this.stepRepo.save(fresh);
          await this.missions.recordEvent(mission, {
            type: 'step_assigned',
            step_id: fresh.id,
            step_key: fresh.step_key,
            message: `Step "${fresh.title}" reassigned to ${await this.agentName(input.assignee_agent_id)} by ${orchestratorName}`,
            actor_type: 'agent',
            actor_id: callerAgentId,
            actor_name: orchestratorName,
          });
          break;
        }
        case 'retry': {
          if (isInFlight(fresh.status)) {
            throw orchestrationError(409, `step "${fresh.step_key}" is already in flight`);
          }
          if (fresh.attempt >= fresh.max_attempts) {
            throw orchestrationError(
              409,
              `step "${fresh.step_key}" has used all ${fresh.max_attempts} attempts. Reassign it to a different ` +
                `agent, replace it with new steps, or fail the mission.`,
            );
          }
          if (input.instructions !== undefined) fresh.instructions = String(input.instructions).trim();
          if (input.assignee_agent_id) fresh.assignee_agent_id = input.assignee_agent_id;
          fresh.status = 'pending';
          fresh.finished_at = null;
          fresh.started_at = null;
          // 명시적 retry 는 needs_recovery 의 유일한 정상 탈출구다 — `manual` 정책이
          // 막는 것은 **자동** 재실행이지 사람/orchestrator 의 판단에 따른 재실행이
          // 아니다. 사유를 지워 복구가 처리됐음을 남긴다.
          fresh.recovery_reason = '';
          await this.stepRepo.save(fresh);
          await this.missions.recordEvent(mission, {
            type: 'step_retried',
            step_id: fresh.id,
            step_key: fresh.step_key,
            message: `Step "${fresh.title}" queued for retry (attempt ${fresh.attempt + 1}/${fresh.max_attempts}) by ${orchestratorName}`,
            actor_type: 'agent',
            actor_id: callerAgentId,
            actor_name: orchestratorName,
          });
          break;
        }
        default:
          throw orchestrationError(400, `unknown action "${input.action}"`);
      }

      // An orchestrator edit can change what is reachable — reopening a step
      // whose upstream is still failed, or skipping one that was the only thing
      // blocking a subtree. Re-derive blocking before dispatching so the board
      // never shows a step as merely "waiting" when it can never run.
      //
      // 복원이 차단보다 **먼저** 와야 한다(리뷰 라운드1 P1-4): retry 가 상류를 pending
      // 으로 되살린 직후이므로, 그때 자동 차단됐던 하류를 먼저 pending 으로 돌려놔야
      // 이어지는 propagateBlocking/pump 가 그 하류를 정상 후보로 본다. 순서를 뒤집으면
      // 하류는 blocked 인 채로 남아 미션이 영영 완료되지 않는다.
      await this.unblockAutoBlockedDependents(mission);
      await this.propagateBlocking(mission);
      const pumped = await this.pump(mission);
      await this.wakeAfterPump(mission, pumped);
      // Re-read: pump() loads its own entity instances, so a step it just
      // dispatched has a newer status / attempt / room_id than the `fresh`
      // object we mutated above. Returning the stale one would tell the
      // orchestrator its retry is still `pending` on attempt N — the exact
      // state it would then try to "fix" again.
      return { step: await this.missions.requireStep(stepId), dispatched: pumped.dispatched };
    });
  }

  // ── Member result intake ──────────────────────────────────────────────────

  /**
   * Lease fencing (티켓 4d065f82) — 이 보고가 **현재** attempt 의 것인지 확인한다.
   *
   * 재시도는 `attempt` 만 올리고 `visit` 은 그대로 두므로, 기존 `visit` 가드는 loop
   * 재진입만 막고 재시도로 밀려난 attempt 의 지각 보고는 통과시켰다 — wave 미션이든
   * graph 미션이든 마찬가지였다. 그 구멍을 이 토큰이 닫는다.
   *
   * a3958947 에서 얻은 교훈을 그대로 적용한다: **누락으로 우회할 수 없어야 한다.**
   * step 이 토큰을 들고 있으면 보고에도 반드시 있어야 하고, 없으면 거부한다.
   * 토큰이 빈 step(이 기능 이전에 나간 work order)만 예외로 통과시킨다.
   */
  private async requireFreshLease(
    mission: OrchestrationMission,
    step: OrchestrationStep,
    callerAgentId: string,
    presented: string | undefined | null,
    what: string,
  ): Promise<void> {
    const held = String(step.lease_token || '');
    if (!held) return; // 업그레이드 이전에 디스패치된 step — 토큰을 요구할 수 없다.
    const shown = String(presented ?? '').trim();
    if (shown === held) return;

    // 거부를 타임라인에 남긴다. 이게 없으면 지각 보고는 호출자에게만 409 로 보이고
    // 미션 기록에는 흔적이 남지 않아, 나중에 "왜 내 결과가 반영 안 됐나"를 설명할
    // 근거가 사라진다 — 복구 동작을 사후에 감사할 수 있어야 한다는 게 이 기능의 요점이다.
    const actorName = await this.agentName(callerAgentId);
    await this.missions.recordEvent(mission, {
      type: 'step_lease_rejected',
      step_id: step.id,
      step_key: step.step_key,
      message:
        `Refused a ${what} for "${step.title}" from ${actorName}: ` +
        (shown ? `superseded lease token` : `no lease token`) +
        ` (step is on attempt ${step.attempt})`,
      actor_type: 'system',
      data: { reason: shown ? 'superseded' : 'missing', attempt: step.attempt },
    });

    if (!shown) {
      throw orchestrationError(
        409,
        `step "${step.step_key}" requires the lease token from your work order on every ${what}. ` +
          `Copy the "lease_token" value from the work order verbatim. Without it the server cannot tell your ` +
          `report apart from one sent by a superseded attempt, so it is refused rather than allowed to ` +
          `overwrite newer work.`,
      );
    }
    throw orchestrationError(
      409,
      `stale ${what} for step "${step.step_key}": your work order's lease token is no longer valid — the ` +
        `step was re-dispatched (now on attempt ${step.attempt}) and your attempt was superseded. Stop work ` +
        `on the old work order; the current attempt is handled in its own room.`,
    );
  }

  /** Non-terminal heartbeat from a member. Flips `dispatched` → `running`. */
  async reportProgress(
    stepId: string,
    callerAgentId: string,
    message: string,
    leaseToken?: string,
    checkpoint?: Record<string, any> | null,
  ): Promise<OrchestrationStep> {
    const step = await this.missions.requireStep(stepId);
    return this.withMissionLock(step.mission_id, async () => {
      const fresh = await this.missions.requireStep(stepId);
      const mission = await this.missions.requireMission(fresh.mission_id);
      this.requireStepActor(fresh, mission, callerAgentId);
      if (isTerminalStepStatus(fresh.status)) {
        throw orchestrationError(409, `step "${fresh.step_key}" is already ${fresh.status}`);
      }
      await this.requireFreshLease(mission, fresh, callerAgentId, leaseToken, 'progress report');
      if (fresh.status === 'dispatched') {
        fresh.status = 'running';
      }
      // 매 호출마다 갱신한다 — 이게 "heartbeat 가 시계를 되돌린다"는 계약의 실체다.
      // `started_at` 은 예전처럼 최초 1회만 찍어 "언제 실제로 착수했나"를 보존한다.
      fresh.started_at = fresh.started_at ?? new Date();
      fresh.last_heartbeat_at = new Date();
      // 유예 중이었다면 이 heartbeat 가 곧 재연결 성공이다 — lease 를 되살린다.
      const wasStale = !!fresh.lease_stale_since;
      fresh.lease_stale_since = null;
      // 체크포인트는 마지막 값만 보관한다(last-writer-wins). 재개의 근거이므로
      // 보내지 않은 호출이 기존 값을 지우면 안 된다 — undefined 는 "변경 없음"이다.
      if (checkpoint !== undefined && checkpoint !== null) {
        fresh.checkpoint = checkpoint;
        fresh.checkpoint_at = new Date();
      }
      await this.stepRepo.save(fresh);

      if (wasStale) {
        await this.missions.recordEvent(mission, {
          type: 'step_lease_recovered',
          step_id: fresh.id,
          step_key: fresh.step_key,
          message: `"${fresh.title}" reconnected — the assignee answered before the grace window expired`,
          actor_type: 'agent',
          actor_id: callerAgentId,
        });
      }
      if (checkpoint !== undefined && checkpoint !== null) {
        await this.missions.recordEvent(mission, {
          type: 'step_checkpoint',
          step_id: fresh.id,
          step_key: fresh.step_key,
          message: `Checkpoint saved for "${fresh.title}" — a new attempt would resume from here`,
          actor_type: 'agent',
          actor_id: callerAgentId,
          data: { checkpoint },
        });
      }
      await this.missions.recordEvent(mission, {
        type: 'step_progress',
        step_id: fresh.id,
        step_key: fresh.step_key,
        message: `${await this.agentName(callerAgentId)} on "${fresh.title}": ${String(message || '').slice(0, 500)}`,
        actor_type: 'agent',
        actor_id: callerAgentId,
        actor_name: await this.agentName(callerAgentId),
      });
      return fresh;
    });
  }

  /**
   * Terminal report from a member. Records the outcome, propagates blocking to
   * dependents, dispatches whatever became ready, and decides whether the
   * orchestrator needs to be woken.
   */
  async reportStep(
    stepId: string,
    callerAgentId: string,
    input: {
      status: 'done' | 'failed' | 'blocked';
      summary: string;
      artifacts?: Array<{ kind?: string; ref?: string; label?: string }>;
      verdict?: string;
      visit?: number;
      lease_token?: string;
    },
  ): Promise<{
    step: OrchestrationStep;
    reported_status: string;
    dispatched: string[];
    orchestrator_woken: boolean;
    loop_reentered: string[];
  }> {
    const found = await this.missions.requireStep(stepId);
    return this.withMissionLock(found.mission_id, async () => {
      const step = await this.missions.requireStep(stepId);
      const mission = await this.missions.requireMission(step.mission_id);
      this.requireStepActor(step, mission, callerAgentId);

      if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) {
        throw orchestrationError(
          409,
          `mission is ${mission.status} — this step's result is no longer being collected`,
        );
      }
      if (isTerminalStepStatus(step.status)) {
        throw orchestrationError(
          409,
          `step "${step.step_key}" is already ${step.status}; a result was recorded for it already`,
        );
      }
      // Lease fencing(티켓 4d065f82) — 아래 visit 가드보다 **먼저** 본다. visit 은
      // 재시도로 바뀌지 않으므로 재시도로 밀려난 attempt 는 visit 만으로는 걸러지지
      // 않는다. 두 가드는 서로 다른 축(재시도 / loop 재진입)을 막으므로 둘 다 남긴다.
      await this.requireFreshLease(mission, step, callerAgentId, input.lease_token, 'result report');
      // 중복 실행 통제(티켓 1ca9e49b) — loop 재진입이 만드는 유일한 새 위험:
      // 같은 step_id가 iteration 2로 다시 디스패치된 뒤, iteration 1의 subagent가
      // 뒤늦게 보고하면 status가 terminal이 아니라 위 가드를 그대로 통과해
      // 새 iteration의 결과를 덮어쓴다.
      //
      // 그래서 graph 모드 미션에서는 `visit`이 **필수**다(리뷰 지적). optional로
      // 두면 stale한 iteration 1 작업자가 visit을 그냥 빼고 보고하는 것만으로
      // 가드를 우회해 iteration 2의 결과를 덮어쓸 수 있다 — 있으나 마나인 방어가
      // 된다. `dispatchStep`은 graph 모드에서 어떤 node든 항상 자기 visit 번호를
      // work order에 싣고 나가도록 보장하므로(그쪽 graphNode fallback 참고), 이
      // 요구가 정상 경로를 막는 일은 없다.
      //
      // graph_spec이 없는 기존 wave 미션은 그대로 optional이다 — 재진입 자체가
      // 없어 구분할 iteration이 없고, 기존 호출자를 깨뜨리지 않는다.
      if (mission.graph_spec && (input.visit === undefined || input.visit === null)) {
        throw orchestrationError(
          409,
          `step "${step.step_key}" belongs to a graph mission, so the report must carry the "visit" number ` +
            `from your work order (this step is on iteration ${step.visit ?? 0}). Without it the server cannot ` +
            `tell a current report apart from a superseded one, so the report is refused rather than risk ` +
            `overwriting a newer pass.`,
        );
      }
      if (input.visit !== undefined && input.visit !== null) {
        const claimed = Number(input.visit);
        const current = step.visit ?? 0;
        if (!Number.isFinite(claimed) || claimed !== current) {
          throw orchestrationError(
            409,
            `stale report for step "${step.step_key}": you are reporting iteration ${input.visit} but the ` +
              `step is now on iteration ${current}. The loop re-entered and your work order was superseded — ` +
              `read the newest work order in your current room instead of re-reporting this one.`,
          );
        }
      }

      const actorName = await this.agentName(callerAgentId);
      const reportedStatus = input.status;
      step.status = input.status;
      step.result_summary = (input.summary || '').slice(0, SUMMARY_MAX);
      step.artifacts = normalizeArtifacts(input.artifacts);
      step.verdict = String(input.verdict ?? '').trim().toLowerCase().slice(0, 48);
      step.finished_at = new Date();
      step.started_at = step.started_at ?? new Date();
      await this.stepRepo.save(step);

      await this.missions.recordEvent(mission, {
        type: input.status === 'done' ? 'step_completed' : input.status === 'failed' ? 'step_failed' : 'step_blocked',
        step_id: step.id,
        step_key: step.step_key,
        message:
          `${actorName} reported "${step.title}" as ${input.status}` +
          (step.result_summary ? `: ${step.result_summary.slice(0, 300)}` : ''),
        actor_type: 'agent',
        actor_id: callerAgentId,
        actor_name: actorName,
        data: { artifacts: step.artifacts ?? [], verdict: step.verdict || null, visit: step.visit ?? 0 },
      });

      // 그래프 모드에서만: 어느 outgoing edge가 왜 선택/기각됐는지 trace에 남기고,
      // 조건이 맞은 loop_back이 있으면 본문 node를 리셋해 재진입시킨다. 반드시
      // propagateBlocking 앞에서 해야 한다 — 리셋 전에 판정하면 아직 done 상태인
      // evaluator의 "선택되지 않은" 분기가 하류를 blocked로 확정해버린다.
      const reentered = mission.graph_spec ? await this.applyGraphTransitions(mission, step) : [];

      const blocked = await this.propagateBlocking(mission);
      const pumped = await this.pump(mission);
      const woken = await this.wakeAfterPump(mission, pumped, { justFinished: step, blockedKeys: blocked });

      return {
        step,
        reported_status: reportedStatus,
        dispatched: pumped.dispatched,
        orchestrator_woken: woken,
        loop_reentered: reentered,
      };
    });
  }

  /**
   * 방금 종료한 node의 그래프 후처리 — 실행 trace 기록 + bounded loop 재진입.
   * 재진입된 node key들을 돌려준다. 호출자는 mission lock을 쥐고 있어야 한다.
   */
  private async applyGraphTransitions(
    mission: OrchestrationMission,
    step: OrchestrationStep,
  ): Promise<string[]> {
    const spec = mission.graph_spec!;
    const state = {
      key: step.step_key,
      status: step.status,
      visit: step.visit ?? 0,
      verdict: step.verdict ?? '',
    };

    // ── 1. edge 선택 이유를 trace에 남긴다 ──────────────────────────────────
    const { taken, notTaken } = selectOutgoingEdges(spec, step.step_key, state);
    if (taken.length > 0 || notTaken.length > 0) {
      await this.missions.recordEvent(mission, {
        type: 'edge_selected',
        step_id: step.id,
        step_key: step.step_key,
        message:
          `"${step.step_key}" (iteration ${state.visit}) → ` +
          (taken.length > 0
            ? `took ${taken.map((t) => `${t.edge.to}${t.edge.label ? ` [${t.edge.label}]` : ''}`).join(', ')}`
            : 'took no outgoing edge') +
          (notTaken.length > 0 ? `; skipped ${notTaken.map((t) => t.edge.to).join(', ')}` : ''),
        actor_type: 'system',
        data: {
          visit: state.visit,
          verdict: state.verdict || null,
          taken: taken.map((t) => ({ to: t.edge.to, kind: t.edge.kind, label: t.edge.label ?? null, reason: t.reason })),
          not_taken: notTaken.map((t) => ({ to: t.edge.to, kind: t.edge.kind, label: t.edge.label ?? null, reason: t.reason })),
        },
      });
    }

    // ── 2. 조건이 맞은 loop_back을 발화시킨다 ───────────────────────────────
    const fired = firedLoopBacks(spec, step.step_key, state);
    if (fired.length === 0) return [];

    const steps = await this.missions.listSteps(mission.id);
    const byKey = new Map(steps.map((st) => [st.step_key, st]));
    const nodeByKey = new Map(spec.nodes.map((n) => [n.key, n]));
    const reentered = new Set<string>();
    const changed: OrchestrationStep[] = [];

    for (const loop of fired) {
      const target = byKey.get(loop.to);
      const node = nodeByKey.get(loop.to);
      if (!target || !node) continue;

      // iteration hard cap: 다음 visit이 상한을 넘으면 재진입하지 않는다. 스텝을
      // 실패시키지도 않는다 — evaluator가 남긴 verdict 때문에 하류로 가는 분기가
      // 이미 dead라서, propagateBlocking이 하류를 blocked로 확정하고 decideWake가
      // 오케스트레이터를 깨운다. 즉 "조용히 도는 무한 loop" 대신 "명시적으로 멈춘
      // loop + 오케스트레이터 호출"로 끝난다.
      const nextVisit = (target.visit ?? 0) + 1;
      if (nextVisit > node.max_visits) {
        await this.missions.recordEvent(mission, {
          type: 'loop_exhausted',
          step_id: step.id,
          step_key: step.step_key,
          message:
            `Loop "${loop.from}" → "${loop.to}" hit its iteration cap (${node.max_visits}) and did not ` +
            `re-enter. The orchestrator has to decide what happens next.`,
          actor_type: 'system',
          data: { from: loop.from, to: loop.to, max_visits: node.max_visits, visit: target.visit ?? 0 },
        });
        continue;
      }

      const body = loopBodyNodes(spec.edges, loop);
      for (const key of body) {
        const bodyStep = byKey.get(key);
        if (!bodyStep) continue;
        // 이미 이번 발화로 리셋된 node는 건너뛴다(두 loop의 본문이 겹칠 수 있다).
        if (reentered.has(key)) continue;
        bodyStep.status = 'pending';
        bodyStep.visit = (bodyStep.visit ?? 0) + 1;
        bodyStep.attempt = 0;
        bodyStep.verdict = '';
        bodyStep.result_summary = '';
        bodyStep.artifacts = null;
        // `confirm_decision` 은 **일부러 지우지 않는다**(티켓 5dbe4aa2). verdict 와
        // 정반대 이유다:
        //   - `verdict` 는 라우팅을 여는 값이라 반드시 지워야 한다. 남으면 사람이 답하기
        //     전에 하류 edge 가 이미 만족된 것으로 판정된다.
        //   - `confirm_decision` 은 **왜 되돌아왔는지에 대한 기록**이고, 바로 다음 줄의
        //     pump 가 재작업 step 을 디스패치할 때 work order 에 실려 나가야 하는 값이다.
        //     여기서 지우면 사용자의 fail 피드백이 전달되기 **직전에** 사라져 요구사항 5가
        //     조용히 깨진다(회귀 테스트가 이 순서를 직접 잡는다).
        // 다음 pass 의 답을 막지 않는 것은 `submitConfirmDecision` 의 멱등 검사가
        // `prior.visit === step.visit` 일 때만 발동하기 때문이고, 게이트가 실제로 다시
        // 열릴 때 `openConfirmGate` 가 그 자리에서 null 로 되돌린다.
        bodyStep.room_id = null;
        bodyStep.dispatched_at = null;
        bodyStep.started_at = null;
        bodyStep.finished_at = null;
        reentered.add(key);
        changed.push(bodyStep);
      }

      await this.missions.recordEvent(mission, {
        type: 'node_revisited',
        step_id: step.id,
        step_key: step.step_key,
        message:
          `Loop "${loop.from}" → "${loop.to}"${loop.label ? ` [${loop.label}]` : ''} re-entered ` +
          `(iteration ${nextVisit}/${node.max_visits}): ${body.join(', ')} reset for another pass.`,
        actor_type: 'system',
        data: { from: loop.from, to: loop.to, label: loop.label ?? null, iteration: nextVisit, max_visits: node.max_visits, body },
      });
    }

    if (changed.length > 0) await this.stepRepo.save(changed);
    return Array.from(reentered);
  }

  // ── 사용자 확인 게이트(티켓 5dbe4aa2) ──────────────────────────────────────

  /** 이 step 이 graph 모드의 `confirm` node 라면 그 node 를, 아니면 null. */
  private confirmNodeOf(mission: OrchestrationMission, stepKey: string): GraphNode | null {
    if (!mission.graph_spec) return null;
    const node = mission.graph_spec.nodes.find((n) => n.key === stepKey);
    return node && node.kind === 'confirm' ? node : null;
  }

  /**
   * 이 step 으로 이어지는 confirm node 들의 사용자 판정을 모은다(요구사항 5).
   *
   * `depends_on` 을 쓰지 않는 이유가 이 기능의 핵심 결함점이다. 표준 형태
   * `build → confirm ─(fail, loop_back)→ build` 에서 build 의 `depends_on` 에는 confirm 이
   * 없다 — 있으면 순환이라 계획 검증에서 거부된다. 그래서 dependency context 만 쓰면
   * 사용자의 피드백은 재실행되는 build 에 **절대 도달하지 못한다**.
   *
   * 대신 그래프에서 "이 step 에 도달할 수 있는 confirm node" 를 loop_back 을 포함해 따라간다:
   * confirm 이 이 step 으로 (재)진입시킬 수 있다면, 그 판정은 이 step 이 지금 무엇을 해야
   * 하는지에 대한 근거다. 판정이 없는(아직 안 열렸거나 리셋된) 노드는 자연히 빠진다.
   */
  private confirmFeedbackFor(
    mission: OrchestrationMission,
    step: OrchestrationStep,
    allSteps: OrchestrationStep[],
  ): ConfirmFeedbackContext[] {
    const spec = mission.graph_spec;
    if (!spec) return [];
    const confirmKeys = spec.nodes.filter((n) => n.kind === 'confirm').map((n) => n.key);
    if (confirmKeys.length === 0) return [];

    const byKey = new Map(allSteps.map((s) => [s.step_key, s]));
    const out: ConfirmFeedbackContext[] = [];
    for (const key of confirmKeys) {
      if (key === step.step_key) continue;
      const source = byKey.get(key);
      const decision = source?.confirm_decision;
      if (!source || !decision) continue;
      // loop_back 을 포함해 도달 가능성을 본다 — fail 경로는 정의상 loop_back 이다.
      if (!reachableVia(spec.edges, key, true).has(step.step_key)) continue;
      out.push({
        step_key: source.step_key,
        title: source.title,
        verdict: decision.verdict,
        feedback: decision.feedback || '',
        decided_by_name: decision.decided_by_name || '',
        decided_at: decision.decided_at || '',
        visit: decision.visit ?? 0,
      });
    }
    return out;
  }

  /**
   * confirm node 를 열어 사람의 판정을 기다리는 durable pause 로 보낸다.
   *
   * 요구사항 2의 "결과물을 사용자에게 제공" 은 여기서 성립한다: 만족된 incoming edge 의
   * 상류 step 들이 보고한 `artifacts`(스크린샷/영상/URL/파일 경로)를 이 step 으로 **복사**
   * 해 둔다. 참조로 남겨 화면에서 그때그때 상류를 따라가지 않는 이유는 loop 때문이다 —
   * 재진입하면 상류의 artifacts 가 리셋되므로, 스냅샷하지 않으면 "무엇을 보고 판정했는가"
   * 가 사후에 사라진다.
   *
   * 호출자는 mission lock 을 쥐고 있어야 한다.
   */
  private async openConfirmGate(
    mission: OrchestrationMission,
    step: OrchestrationStep,
    allSteps: OrchestrationStep[],
  ): Promise<void> {
    const spec = mission.graph_spec!;
    const byKey = new Map(allSteps.map((s) => [s.step_key, s]));

    const evidence: Array<{ kind: string; ref: string; label: string }> = [];
    const sources: string[] = [];
    const seen = new Set<string>();
    for (const edge of spec.edges) {
      if (edge.to !== step.step_key || edge.kind === 'loop_back') continue;
      const source = byKey.get(edge.from);
      if (!source) continue;
      const evaluation = evaluateEdge(edge, {
        key: source.step_key,
        status: source.status,
        visit: source.visit ?? 0,
        verdict: source.verdict ?? '',
      });
      if (evaluation.state !== 'satisfied') continue;
      sources.push(source.step_key);
      for (const a of Array.isArray(source.artifacts) ? source.artifacts : []) {
        const dedupe = `${a.kind}\u0000${a.ref}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        if (evidence.length >= MAX_ARTIFACTS_PER_STEP) break;
        evidence.push({ kind: a.kind, ref: a.ref, label: a.label });
      }
    }

    step.status = 'awaiting_user';
    // dispatchStep 과 같은 규칙: 최초 오픈만 0 → 1 로 올린다. 재진입은
    // applyGraphTransitions 가 이미 올려두었다.
    if ((step.visit ?? 0) < 1) step.visit = 1;
    step.dispatched_at = new Date();
    step.started_at = null;
    step.finished_at = null;
    step.confirm_decision = null;
    // 이전 pass 의 verdict 가 남아 있으면 하류 edge 가 사람이 답하기도 전에 판정된다.
    step.verdict = '';
    step.result_summary = '';
    step.artifacts = evidence.length > 0 ? evidence : null;

    // 이 pass 의 알림을 **지금 선점한다**(티켓 a78cb566). 발송 자체는 아래에서 배경으로
    // 돌지만, "이 pass 는 이미 알렸다" 는 사실은 상태 전이와 **같은 save 로** 커밋한다.
    // 그래야 pump 가 몇 번을 더 돌아도, 서버가 그 사이 재기동해도 같은 pass 에 두 번째
    // 알림이 나가지 않는다. `visit` 이 키라서 loop 로 다음 pass 가 열리면 값이 달라지고
    // 새 알림이 나간다 — 각 pass 는 각각 알릴 가치가 있다.
    const alreadyNotified = step.confirm_notice?.visit === (step.visit ?? 1);
    if (!alreadyNotified) {
      step.confirm_notice = { visit: step.visit ?? 1, notified_at: new Date().toISOString() };
    }
    await this.stepRepo.save(step);

    // global budget 은 **node 실행 횟수**이지 subagent 스폰 횟수가 아니다. 게이트가
    // subagent 를 띄우지 않더라도 함께 세는 근거는 폭주 방지가 아니라 **예산 정의의
    // 일관성**이다 — loop 자체는 `node.max_visits` 로 이미 개별 상한이 걸려 있어서
    // 게이트가 예산을 안 써도 종료한다. 예산에 node kind 모양의 구멍을 내면 "왜 이
    // 미션은 예산이 안 깎이지"를 나중에 아무도 재구성하지 못한다(리뷰 라운드1).
    mission.total_visits = (mission.total_visits ?? 0) + 1;
    await this.missionRepo.save(mission);

    await this.missions.recordEvent(mission, {
      type: 'confirm_requested',
      step_id: step.id,
      step_key: step.step_key,
      message:
        `Waiting for a user decision on "${step.title}" (pass ${step.visit ?? 1})` +
        (evidence.length > 0 ? ` — ${evidence.length} artifact(s) attached for review` : ''),
      actor_type: 'system',
      data: {
        visit: step.visit ?? 1,
        artifacts: evidence,
        evidence_from: sources,
      },
    });
    this.logService.info(
      'Orchestration',
      `confirm gate opened for step ${step.step_key} (visit ${step.visit ?? 1})`,
      { mission_id: mission.id, workspace_id: mission.workspace_id },
    );

    // 화면을 연 사람에게만 보이는 배지로는 부족하다 — 게이트 대기 사실을 기존 사용자
    // 알림 채널로 내보낸다(티켓 a78cb566).
    //
    // **await 하지 않는다.** 이 메서드는 미션 락 안에서 돌고, 알림 provider 들은 요청
    // 타임아웃이 없는 raw fetch 다. 응답하지 않는 엔드포인트 하나를 여기서 기다리면 그
    // 미션의 락 체인이 통째로 멈춰 **사용자가 판정을 제출하는 것조차 막힌다** — 알림을
    // 못 보내는 것보다 훨씬 나쁜 결과이고, 요구사항 6("알림 실패가 게이트 오픈을 죽이지
    // 않는다")이 막으려는 실패의 최악 형태다.
    if (!alreadyNotified) {
      this.confirmNotify.scheduleGateNotice(mission, step);
    }
  }

  /**
   * 사람이 confirm node 에 Pass/Fail 을 제출한다 — 이 기능의 유일한 판정 입구다.
   *
   * MCP 툴은 일부러 만들지 않았다: 에이전트가 사람 대신 confirm 에 답할 수 있으면
   * 게이트 자체가 무의미해진다. 그래서 REST(사용자 세션) 전용이다.
   *
   * ── 정확히 한 번 재개(요구사항 6) ─────────────────────────────────────────
   * 중복 제출·새로고침·재접속 전부 같은 경로로 들어온다. 판정이 이미 있고 `(visit,
   * verdict)` 가 같으면 **재개하지 않고** 기존 판정을 그대로 돌려준다(`already_decided`).
   * 그 외의 불일치는 전부 409 다 — 조용히 덮어쓰면 사용자가 A 를 눌렀는데 B 로 진행되는,
   * 사후에 재구성조차 안 되는 상태가 만들어진다.
   */
  async submitConfirmDecision(
    stepId: string,
    workspaceId: string,
    actor: ActorRef,
    input: { verdict: string; feedback?: string; visit: number },
  ): Promise<{
    step: OrchestrationStep;
    already_decided: boolean;
    dispatched: string[];
    loop_reentered: string[];
    orchestrator_woken: boolean;
  }> {
    const verdict = String(input?.verdict ?? '').trim().toLowerCase();
    if (!(CONFIRM_VERDICTS as readonly string[]).includes(verdict)) {
      throw orchestrationError(400, `verdict must be one of ${CONFIRM_VERDICTS.join(', ')}`);
    }
    // `visit` 은 **필수**다(리뷰 라운드1). optional 로 두면 loop 재진입으로 화면이 낡은
    // 클라이언트가 값을 그냥 빼는 것만으로 아래 stale 대조를 통째로 건너뛰고 새 pass 를
    // 잘못 판정한다 — 있으나 마나인 방어가 된다. `reportStep` 이 graph 미션의 모든 보고에
    // visit 을 요구하는 것과 정확히 같은 이유이고, 같은 이유로 여기서도 서버가 강제한다
    // (클라이언트 타입이 required 인 것은 서버 계약이 아니다).
    const claimedVisit = Number(input?.visit);
    if (!Number.isInteger(claimedVisit) || claimedVisit < 1) {
      throw orchestrationError(
        400,
        `"visit" is required and must be a whole number >= 1 — send the pass number shown on the confirmation ` +
          `you are answering. Without it the server cannot tell a current decision apart from one made against ` +
          `a screen that has since been superseded by a loop re-entry.`,
      );
    }
    const feedback = String(input?.feedback ?? '').trim().slice(0, CONFIRM_FEEDBACK_MAX);

    const found = await this.missions.requireStep(stepId);
    return this.withMissionLock(found.mission_id, async () => {
      // lock 안에서 다시 읽는다 — 동시 제출의 두 번째는 첫 번째가 커밋한 상태를 봐야
      // idempotent 분기로 떨어진다.
      const step = await this.missions.requireStep(stepId);
      const mission = await this.missions.requireMission(step.mission_id, workspaceId);

      if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) {
        throw orchestrationError(409, `mission is ${mission.status} — this decision is no longer being collected`);
      }
      if (!this.confirmNodeOf(mission, step.step_key)) {
        throw orchestrationError(
          409,
          `step "${step.step_key}" is not a user confirmation node, so it does not take a Pass/Fail decision`,
        );
      }

      // ── 이미 판정됨: 재제출/새로고침 ──────────────────────────────────────
      // status 검사보다 **먼저** 본다 — 성공한 판정은 step 을 `done` 으로 만들므로,
      // 순서를 뒤집으면 정상적인 중복 제출이 전부 "awaiting_user 가 아니다" 로 떨어진다.
      //
      // 멱등 키는 "step 이 지금 몇 번째 pass 인가"가 아니라 **"이 제출이 몇 번째 pass 에
      // 답하는가"**(`claimedVisit`)다. 전자로 두면 `fail` 쪽만 비대칭으로 깨진다(리뷰
      // 라운드1, 플래너 반례): `fail` 은 같은 lock 안에서 loop 를 발화시키고
      // `loopBodyNodes` 가 **게이트 자신을 본문에 포함**하므로(loop.to 에서 forward 로
      // 닿고 loop.from 에도 닿는다), 반환 시점의 게이트는 이미 `pending` + `visit=2` 다.
      // 그 창에서 같은 `fail` 이 다시 들어오면 `prior.visit(1) !== step.visit(2)` 로 멱등
      // 분기를 건너뛰고 `is pending` 409 가 나간다 — 재개가 두 번 되지는 않으니 안전하지만,
      // 요구사항 6의 "중복·새로고침·재접속" 이 `pass` 에서만 성립하게 된다.
      //
      // 넓어지지 않는 근거: 이 분기는 `prior` 가 살아 있는 동안에만 발화하고, 게이트가
      // 실제로 다시 열리는 순간 `openConfirmGate` 가 `confirm_decision = null` 로 만든다.
      // 따라서 새 pass 의 제출은 `prior === null` 이라 정상 경로로 내려가고, stale 화면
      // (visit 1 vs 현재 2)도 아래 stale 대조에 그대로 걸린다.
      const prior = step.confirm_decision;
      if (prior && claimedVisit === prior.visit) {
        // 같은 답을 다시 보낸 것 = 중복 클릭 / 새로고침 / 네트워크 재시도. 재개하지 않고
        // 기존 판정을 그대로 돌려준다.
        if (prior.verdict === verdict) {
          return {
            step,
            already_decided: true,
            dispatched: [],
            loop_reentered: [],
            orchestrator_woken: false,
          };
        }
        // 같은 pass 에 다른 답을 보낸 것 — 조용히 덮어쓰면 사용자가 A 를 눌렀는데 B 로
        // 진행되고 사후 재구성조차 안 된다.
        throw orchestrationError(
          409,
          `step "${step.step_key}" was already decided "${prior.verdict}" on pass ${prior.visit} by ` +
            `${prior.decided_by_name || 'a user'}. A decision cannot be changed — if the work needs another ` +
            `look, the mission has to route back through the graph.`,
        );
      }

      if (!isAwaitingUser(step.status)) {
        throw orchestrationError(
          409,
          `step "${step.step_key}" is ${step.status}, not waiting for a user decision`,
        );
      }
      const current = step.visit ?? 0;
      if (claimedVisit !== current) {
        throw orchestrationError(
          409,
          `stale confirmation for step "${step.step_key}": you are answering pass ${claimedVisit} but the step ` +
            `is now on pass ${current}. The work was sent back for another round after your screen loaded — ` +
            `reload the mission and review the current result before deciding.`,
        );
      }

      const decision: ConfirmDecision = {
        verdict: verdict as ConfirmVerdict,
        feedback,
        decided_by_user_id: actor.id || '',
        decided_by_name: actor.name || '',
        decided_at: new Date().toISOString(),
        visit: current,
      };
      step.confirm_decision = decision;
      // `verdict` 컬럼에도 실어야 `evaluateEdge` 의 분기 기계가 그대로 작동한다 —
      // confirm 전용 분기 로직을 새로 만들지 않는 이유가 이것이다.
      step.verdict = decision.verdict;
      step.result_summary = (
        `User confirmation: ${decision.verdict.toUpperCase()}` +
        (feedback ? `\n\n${feedback}` : '\n\n(no feedback given)')
      ).slice(0, SUMMARY_MAX);
      step.status = 'done';
      step.started_at = step.started_at ?? new Date();
      step.finished_at = new Date();
      await this.stepRepo.save(step);

      await this.missions.recordEvent(mission, {
        type: 'confirm_decided',
        step_id: step.id,
        step_key: step.step_key,
        message:
          `${actor.name || 'A user'} answered ${decision.verdict.toUpperCase()} on "${step.title}" ` +
          `(pass ${decision.visit})` + (feedback ? `: ${feedback.slice(0, 300)}` : ''),
        actor_type: 'user',
        actor_id: actor.id || '',
        actor_name: actor.name || '',
        data: {
          verdict: decision.verdict,
          visit: decision.visit,
          has_feedback: feedback.length > 0,
          feedback_length: feedback.length,
        },
      });

      // 여기서부터는 `reportStep` 의 종료 처리와 **완전히 같은 경로**다. 별도 재개 경로를
      // 만들지 않는 것이 "정확히 한 번 올바른 edge 로 재개된다" 의 근거다 — 이미 검증된
      // 전이/차단/디스패치/wake 순서를 그대로 물려받는다.
      const reentered = await this.applyGraphTransitions(mission, step);
      const blocked = await this.propagateBlocking(mission);
      const pumped = await this.pump(mission);
      const woken = await this.wakeAfterPump(mission, pumped, { justFinished: step, blockedKeys: blocked });

      return {
        step,
        already_decided: false,
        dispatched: pumped.dispatched,
        loop_reentered: reentered,
        orchestrator_woken: woken,
      };
    });
  }

  // ── Engine internals ──────────────────────────────────────────────────────

  /**
   * 디스패치 가능한 모든 스텝을 미션 전체 병렬 상한과 각 member 자신의
   * `max_concurrent` 안에서 디스패치한다.
   *
   * 실제로 디스패치된 step key들과, 디스패치에 실패한 스텝들(여기서 `failed`로
   * 표시, 이벤트 기록됨)을 함께 반환한다. 의도적으로 `decideWake`를 직접 호출하지
   * 않는다 — 모든 호출자가 어차피 자기 자신의 이유(리포트, 외부 실패 등)로 오케스트레이터를
   * 깨울지 스스로 판단해야 하는데, 여기서도 독자적으로 판단해버리면 디스패치 실패가
   * 이미 그 뒤에서 깨우는 호출자의 같은 pump() 호출 안에서 발생했을 때 wake가
   * 두 번(room 포스트 2회, subagent spawn 2회) 발화한다. 대신 호출자들이 `failed`를
   * 자기 자신의 단일 decideWake 호출에 합쳐 넣는다 — submitPlan/updateStep/
   * resumeMission(티켓 1b62b437 이전에는 decideWake 호출이 아예 없어서 새로 추가해야
   * 했다)과 reportStep/failStepExternally(원래 있었고, 이제는 pump()가 실패를
   * 보고하면 자기 자신의 `justFinished`보다 그 최신 실패를 우선한다) 참고.
   * 호출자는 mission lock을 쥐고 있어야 한다.
   */
  /**
   * 미션의 현재 실행 판정.
   *
   * `graph_spec`이 있으면 그래프 규칙(typed edge / 조건 / join policy)으로, 없으면
   * 기존 `depends_on` 규칙으로 계산한다. 분기를 **여기 한 곳**에만 두는 이유:
   * pump / propagateBlocking / decideWake 세 호출자가 서로 다른 판정을 보면
   * "디스패치는 되는데 곧바로 blocked 처리되는" 식의 모순 상태가 생긴다.
   *
   * 두 경로의 반환 필드는 동일하다 — graph adapter(`graphFromWavePlan`)가 무손실
   * 이므로 legacy 미션을 그래프로 승격해도 같은 값이 나온다(회귀 테스트가 단언).
   */
  private progressOf(mission: OrchestrationMission, steps: OrchestrationStep[]): MissionProgress {
    return computeMissionProgress(mission.graph_spec, steps);
  }

  /** graph 모드에서 남은 global budget. graph가 없으면 무한(Infinity)으로 본다. */
  private remainingVisitBudget(mission: OrchestrationMission): number {
    if (!mission.graph_spec) return Number.POSITIVE_INFINITY;
    return mission.graph_spec.max_total_visits - (mission.total_visits ?? 0);
  }

  private async pump(mission: OrchestrationMission): Promise<{ dispatched: string[]; failed: OrchestrationStep[] }> {
    if (mission.status !== 'running') return { dispatched: [], failed: [] };

    const steps = await this.missions.listSteps(mission.id);
    const progress = this.progressOf(mission, steps);
    if (progress.dispatchable.length === 0) return { dispatched: [], failed: [] };

    const byKey = new Map(steps.map((s) => [s.step_key, s]));
    const members = await this.memberRepo.find({ where: { team_id: mission.team_id } });
    const capByAgent = new Map(members.map((m) => [m.agent_id, m.max_concurrent]));

    // Live per-agent load, counted across THIS mission only. Cross-mission load
    // is intentionally not counted here: a member's real ceiling is enforced by
    // the agent-manager's own per-agent concurrency gate, and double-counting it
    // here would deadlock two missions that share a member.
    const loadByAgent = new Map<string, number>();
    for (const s of steps) {
      if (isInFlight(s.status) && s.assignee_agent_id) {
        loadByAgent.set(s.assignee_agent_id, (loadByAgent.get(s.assignee_agent_id) ?? 0) + 1);
      }
    }
    let slots = mission.max_parallel_steps - progress.inFlight.length;

    const dispatched: string[] = [];
    const failed: OrchestrationStep[] = [];
    const candidates = progress.dispatchable
      .map((k) => byKey.get(k)!)
      .filter(Boolean)
      .sort((a, b) => a.position - b.position);
    // 슬롯이 없어도 **여기서 조기 반환하지 않는다**(티켓 5dbe4aa2): 아래 confirm 게이트
    // 패스는 슬롯을 쓰지 않으므로, 병렬 상한에 걸린 미션에서 사람에게 묻는 일까지
    // 미뤄질 이유가 없다. 슬롯이 없고 게이트도 없으면 아래 두 루프가 모두 no-op 이라
    // 결과는 예전과 같다.
    if (slots <= 0 && !candidates.some((step) => this.confirmNodeOf(mission, step.step_key))) {
      return { dispatched: [], failed: [] };
    }

    // graph 모드의 global budget은 **매 반복마다** 다시 본다.
    //
    // 진입 시 한 번만 "남은 예산 >= 1"을 확인하면 fan-out에서 상한을 넘긴다
    // (리뷰 지적): 남은 예산 1 + ready node 4개 + 슬롯 4개면 네 개를 전부 띄워
    // total_visits가 상한을 3 초과한다. `slots`는 병렬 상한이지 예산이 아니다.
    //
    // 미리 `slots = min(slots, budget)`으로 깎지 않고 루프 안에서 실측을 다시
    // 읽는 이유: `dispatchStep`이 `mission.total_visits`를 그 자리에서 올리므로
    // 이 표현식은 항상 실제 소진량을 반영한다 — 특히 **디스패치가 실패한 경우에도
    // 예산이 이미 소진됐는지 여부가 그대로 반영된다**(work order를 보내기 직전에
    // 커밋하므로, 커밋 전에 던진 실패는 예산을 쓰지 않고 커밋 후 실패는 쓴다).
    // 미리 깎아두면 그 두 경우를 구분하지 못한다.
    let budgetExhausted = false;

    // ── confirm 게이트를 먼저, 그리고 병렬 상한과 **무관하게** 연다(티켓 5dbe4aa2).
    //
    // 아래 디스패치 루프 안에 두면 안 된다. 그 루프는 `slots <= 0`에서 break 하는데,
    // 게이트는 subagent 를 띄우지 않아 슬롯을 쓰지 않으므로 다른 step 이 슬롯을 다
    // 쥐고 있다는 이유로 사람에게 묻는 것을 미룰 근거가 없다. 게다가 break 는 뒤에
    // 남은 후보를 아예 보지 않으므로, 상한에 걸린 미션에서는 게이트가 열리지 않은 채
    // "in-flight 는 있는데 아무도 답을 요구받지 않는" 상태로 늘어진다.
    //
    // 정상적인 assignee 검사보다 먼저 처리되는 것도 의도다 — 사람이 답하는 node 라
    // 담당자가 없는 게 정상인데, `!agentId` 분기에 먼저 걸리면 영원히 `ready` 로
    // 눌러앉아 "배정이 없어 아무것도 못 한다"는 stall wake 만 반복된다.
    //
    // 반면 global budget 은 그대로 적용받는다: 게이트도 node 실행이고 loop 를 한 바퀴
    // 더 돌리므로, 예산에서 빼면 confirm→fail→loop 가 예산 없이 무한히 돌 수 있다.
    const gates = candidates.filter((step) => this.confirmNodeOf(mission, step.step_key));
    const regular = candidates.filter((step) => !this.confirmNodeOf(mission, step.step_key));
    const withheldGates: string[] = [];
    for (const step of gates) {
      if (this.remainingVisitBudget(mission) <= 0) {
        budgetExhausted = true;
        withheldGates.push(step.step_key);
        continue;
      }
      await this.openConfirmGate(mission, step, steps);
      dispatched.push(step.step_key);
    }

    let index = 0;
    for (; index < regular.length; index += 1) {
      const step = regular[index];
      if (slots <= 0) break;
      if (this.remainingVisitBudget(mission) <= 0) {
        budgetExhausted = true;
        break;
      }
      const agentId = step.assignee_agent_id;
      if (!agentId) {
        // An unassigned step cannot be dispatched. Mark it ready so the UI shows
        // it as waiting on the orchestrator rather than on a dependency, and let
        // decideWake surface it.
        if (step.status !== 'ready') {
          step.status = 'ready';
          await this.stepRepo.save(step);
        }
        continue;
      }
      const cap = capByAgent.get(agentId) ?? 1;
      const load = loadByAgent.get(agentId) ?? 0;
      if (load >= cap) {
        if (step.status !== 'ready') {
          step.status = 'ready';
          await this.stepRepo.save(step);
        }
        continue;
      }

      try {
        await this.dispatchStep(mission, step, steps);
        loadByAgent.set(agentId, load + 1);
        slots -= 1;
        dispatched.push(step.step_key);
      } catch (e: any) {
        // 디스패치 실패는 스텝 실패이지 미션 크래시가 아니다: 기록하고, blocking을
        // 전파시키고, 오케스트레이터에게 알리는 건 호출자의 decideWake에 맡긴다
        // (왜 여기서 하지 않는지는 이 메서드의 docstring 참고).
        step.status = 'failed';
        step.result_summary =
          `[dispatch failed] the work order could not be delivered to the assignee: ${e?.message || e}`;
        step.finished_at = new Date();
        await this.stepRepo.save(step);
        await this.missions.recordEvent(mission, {
          type: 'step_failed',
          step_id: step.id,
          step_key: step.step_key,
          message: `Failed to dispatch "${step.title}": ${e?.message || e}`,
          actor_type: 'system',
        });
        this.logService.error(
          'Orchestration',
          `dispatch failed for step ${step.id} (${step.step_key}): ${e?.message || e}`,
          { mission_id: mission.id },
        );
        failed.push(step);
      }
    }

    if (budgetExhausted) {
      // 스텝을 failed로 바꾸지는 않는다 — 예산은 "지금 더 못 띄운다"이지 "이 작업이
      // 실패했다"가 아니고, 운영자가 max_total_visits를 올리면 그대로 재개돼야 한다.
      // 대신 이벤트를 남겨 decideWake가 정지 상태를 오케스트레이터에게 알리게 한다.
      const withheld = [...withheldGates, ...regular.slice(index).map((s) => s.step_key)];
      await this.missions.recordEvent(mission, {
        type: 'graph_budget_exhausted',
        message:
          `Global execution budget exhausted (${mission.total_visits}/${mission.graph_spec?.max_total_visits} ` +
          `node runs). ${withheld.length} node(s) are ready but will not be dispatched.`,
        actor_type: 'system',
        data: {
          total_visits: mission.total_visits,
          max_total_visits: mission.graph_spec?.max_total_visits ?? null,
          withheld,
          dispatched_before_exhaustion: dispatched,
        },
      });
    }

    return { dispatched, failed };
  }

  /**
   * pump() 결과에 대해 오케스트레이터를 정확히 한 번만 깨운다: pump()가 드러낸
   * 가장 최신 디스패치 실패(엔진 자신의 최신 문제)를 옵션으로 주어진 호출자
   * fallback(예: reportStep/failStepExternally가 마무리 짓던 스텝)보다 우선한다 —
   * 절대 둘 다는 아니다. 그래서 pump() 호출 한 번이 하나의 논리적 이벤트에 대해
   * room 포스트 2회 / subagent spawn 2회를 유발하는 일이 없다. pump 실패도
   * fallback도 없으면 false(깨우지 않음)를 반환한다 — submitPlan/updateStep/
   * resumeMission의 흔한 경우로, 이들은 "방금 스텝이 X를 보고했다" 같은 자기
   * 자신의 이유가 없다.
   */
  private async wakeAfterPump(
    mission: OrchestrationMission,
    pumped: { dispatched: string[]; failed: OrchestrationStep[] },
    fallback?: { justFinished: OrchestrationStep; blockedKeys: string[] },
  ): Promise<boolean> {
    const justFinished = pumped.failed.length > 0 ? pumped.failed[pumped.failed.length - 1] : fallback?.justFinished;
    if (!justFinished) return false;
    return this.decideWake(mission, {
      justFinished,
      blockedKeys: fallback?.blockedKeys ?? [],
      dispatched: pumped.dispatched,
    });
  }

  /** Create the step's room, add the member, and post the work order. */
  private async dispatchStep(
    mission: OrchestrationMission,
    step: OrchestrationStep,
    allSteps: OrchestrationStep[],
    opts?: { recovery?: boolean },
  ): Promise<void> {
    const agentId = step.assignee_agent_id!;
    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    if (!agent) throw orchestrationError(400, `assignee agent ${agentId} no longer exists`);
    // 방어적 재검사(티켓 1b62b437): 스텝이 미션 workspace 밖 에이전트에게 디스패치되지
    // 않도록 지금까지 막아온 유일한 장치는 addMember 시점의 로스터 게이트
    // (requireWorkspaceAgent)뿐이었다 — 그 외엔 아무 검사도 없다. 그 게이트의 보장이
    // stale해지는 경로는 두 가지다: (1) 글로벌 팀의 member가 가입 후
    // move_agent_to_workspace로 어느 workspace로 옮겨지거나, (2) workspace 종속
    // 팀의 member가 같은 방식으로 다른 workspace로 옮겨지는 경우(글로벌 팀 이전부터
    // 있던 버그 — 티켓 참고). 둘 다 멤버십 행이 그대로 남고 지금까지는 재검증이
    // 없었다. 이걸 못 잡으면 workspace B의 에이전트에게 workspace A 미션으로 지어진
    // room — 그 objective, context, 선행 스텝 결과까지 — 을 조용히 넘겨주게 된다.
    if (agent.workspace_id && agent.workspace_id !== mission.workspace_id) {
      throw orchestrationError(
        400,
        `assignee agent ${agent.name} no longer belongs to this mission's workspace (moved to a different ` +
          `workspace after joining the team) — refusing to dispatch`,
      );
    }

    const team = await this.teamRepo.findOne({ where: { id: mission.team_id } });
    const orchestratorName = await this.agentName(mission.orchestrator_agent_id);

    // One room per ATTEMPT, not per step: a retry must not inherit the failed
    // attempt's conversation, or the subagent replays its own dead end as history.
    const room = await this.roomRepo.save(
      this.roomRepo.create({
        workspace_id: mission.workspace_id,
        type: 'group',
        name: `Step: ${step.step_key} · ${mission.title.slice(0, 40)} · ${randomUUID().slice(0, 6)}`,
        last_message_at: null,
        orchestration_mission_id: mission.id,
        orchestration_step_id: step.id,
      }),
    );
    await this.addRoomParticipants(room.id, agentId);

    const depKeys = Array.isArray(step.depends_on) ? step.depends_on : [];
    const depSteps = allSteps.filter((s) => depKeys.includes(s.step_key));
    const depAgentIds = Array.from(
      new Set(depSteps.map((s) => s.assignee_agent_id).filter((v): v is string => !!v)),
    );
    const depAgents = depAgentIds.length ? await this.agentRepo.find({ where: { id: In(depAgentIds) } }) : [];
    const depAgentById = new Map(depAgents.map((a) => [a.id, a]));
    const depDisplayById = await resolveAgentDisplayMap(this.agentRepo, depAgents);
    const dependencies: DependencyContext[] = depSteps
      .filter((s) => (DEPENDENCY_SATISFYING_STATUSES as readonly string[]).includes(s.status))
      .map((s) => ({
        step_key: s.step_key,
        title: s.title,
        status: s.status,
        assignee_name: s.assignee_agent_id ? depDisplayById.get(s.assignee_agent_id) ?? '' : '',
        result_summary: s.result_summary,
        artifacts: Array.isArray(s.artifacts) ? s.artifacts : [],
      }));

    // Stamp the attempt BEFORE sending so a send that half-succeeds cannot be
    // replayed as attempt N again.
    step.attempt += 1;
    // visit은 loop 재진입 축이라 재시도로는 늘지 않는다(재진입 시
    // applyGraphTransitions가 올린다). 최초 디스패치만 0 → 1로 올린다.
    if ((step.visit ?? 0) < 1) step.visit = 1;
    // 이번 attempt 의 fencing token 을 새로 발급한다(티켓 4d065f82). visit 과 달리
    // **모든** 재디스패치에서 바뀌므로 재시도로 밀려난 이전 attempt 의 지각 보고까지
    // 걸러낸다. 전송 전에 커밋하는 이유는 attempt 와 같다 — 포스트 도중 죽어도
    // 이전 토큰은 이미 무효가 돼 있어야 한다.
    step.lease_token = randomUUID();
    step.status = 'dispatched';
    step.room_id = room.id;
    step.dispatched_at = new Date();
    step.started_at = null;
    step.finished_at = null;
    // 새 attempt 는 새 lease 다 — 이전 attempt 의 heartbeat 를 물려받으면 리퍼가
    // 죽은 attempt 의 생존 신호를 기준으로 새 attempt 의 시계를 재버린다.
    step.last_heartbeat_at = null;
    step.lease_stale_since = null;
    step.recovery_reason = '';
    // `checkpoint` 는 **일부러 지우지 않는다** — 새 attempt 가 이어서 할 근거이고,
    // 아래 renderStepPrompt 가 work order 에 그대로 실어 보낸다.
    await this.stepRepo.save(step);

    // global budget은 재시도까지 포함해 "subagent를 몇 번 더 띄울 수 있는가"를
    // 센다. room 포스트 **전에** 커밋해 두는 이유: 포스트 도중 크래시가 나도 예산이
    // 소진된 채로 남아야 재시작이 같은 예산을 다시 쓰는 일이 없다(보수적 방향).
    if (mission.graph_spec) {
      mission.total_visits = (mission.total_visits ?? 0) + 1;
      await this.missionRepo.save(mission);
    }

    // 이 step의 격리된 작업폴더 + repo를 해석한다(티켓 2dc3c62f):
    // `.awb/orch/` 아래 `<mission-leaf>/<step_key>` — 같은 미션의 동시 진행
    // step끼리 폴더를 공유하는 일이 없다. `missionLeaf`는 getMissionDetail의
    // `resolved_workspace_folder` 계산과 정확히 동일하다 — leaf를
    // buildRunProvision이 step id로부터 유도하게 두지 않고 미리 계산해두는
    // 이유는 그 메서드의 문서 참고.
    const missionLeaf = mission.workspace_folder || mission.id.slice(0, 8);
    const stepWorkspaceFolder = `${missionLeaf}/${step.step_key}`;
    const runProvision: RunProvision = await buildRunProvision(this.dataSource, {
      kind: 'orchestration',
      id: step.id,
      runId: step.id,
      workspaceId: mission.workspace_id,
      boardId: null,
      workspaceFolder: stepWorkspaceFolder,
      repoRef: mission.repo_ref,
      checkoutMode: mission.checkout_mode,
    });

    // graph 모드에서는 **반드시** graphNode를 넘긴다. null이면 프롬프트에서 visit
    // 안내가 빠지는데, reportStep은 graph 미션의 모든 보고에 visit을 요구하므로
    // 그 조합은 보고 자체가 불가능한 wedge가 된다. validateGraphSpec이 plan의 모든
    // step에 node를 채우므로 조회 실패는 이론상 없지만, 두 조건을 같은 술어
    // (`mission.graph_spec != null`)에 묶어 두는 편이 안전하다.
    const specNode = mission.graph_spec?.nodes.find((n) => n.key === step.step_key) ?? null;
    const graphNode = mission.graph_spec
      ? { kind: specNode?.kind ?? 'task', max_visits: specNode?.max_visits ?? 1 }
      : null;
    const prompt = renderStepPrompt({
      mission,
      step,
      teamName: team?.name ?? '',
      orchestratorName,
      dependencies,
      confirmFeedback: this.confirmFeedbackFor(mission, step, allSteps),
      isRetry: step.attempt > 1 || !!opts?.recovery,
      workspaceFolder: runProvision.workspace_folder,
      graphNode: graphNode
        ? {
            kind: graphNode.kind,
            visit: step.visit ?? 1,
            max_visits: graphNode.max_visits,
            // 이 node에서 나가는 분기 조건 — evaluator/router가 어떤 verdict를
            // 돌려줘야 하는지 알아야 분기가 실제로 작동한다.
            verdicts: Array.from(
              new Set(
                mission.graph_spec!.edges
                  .filter((e) => e.from === step.step_key)
                  .flatMap((e) => e.when?.verdict ?? []),
              ),
            ),
          }
        : null,
    });

    await this.postToRoom(room.id, mission.workspace_id, prompt, runProvision);

    await this.missions.recordEvent(mission, {
      type: 'step_dispatched',
      step_id: step.id,
      step_key: step.step_key,
      message:
        `Step "${step.title}" dispatched to ${await this.agentName(agent.id)} ` +
        `(attempt ${step.attempt}/${step.max_attempts}` +
        (graphNode && graphNode.max_visits > 1 ? `, iteration ${step.visit}/${graphNode.max_visits}` : '') +
        `)`,
      actor_type: 'system',
      data: { room_id: room.id, assignee_agent_id: agentId, attempt: step.attempt, visit: step.visit ?? 1 },
    });
    this.logService.info(
      'Orchestration',
      `step ${step.step_key} dispatched → agent ${agentId} room ${room.id}`,
      { mission_id: mission.id, workspace_id: mission.workspace_id },
    );
  }

  /**
   * Mark every step whose dependency reached a poisoning status as `blocked`.
   * Returns the keys newly blocked so the wake message can name them.
   */
  private async propagateBlocking(mission: OrchestrationMission): Promise<string[]> {
    const steps = await this.missions.listSteps(mission.id);
    const progress = this.progressOf(mission, steps);
    if (progress.newlyBlocked.length === 0) return [];

    const byKey = new Map(steps.map((s) => [s.step_key, s]));
    const changed: OrchestrationStep[] = [];
    for (const key of progress.newlyBlocked) {
      const s = byKey.get(key);
      if (!s || s.status === 'blocked') continue;
      s.status = 'blocked';
      // 엔진이 자동으로 막았다는 표시 — 작업자가 스스로 "막혔다"고 보고한 blocked 와
      // 구분해야 상류 복구 시 전자만 되살릴 수 있다(리뷰 라운드1 P1-4).
      s.auto_blocked = true;
      s.finished_at = new Date();
      s.result_summary =
        s.result_summary ||
        '[auto-blocked] an upstream step this work depends on did not succeed, so this step can never run ' +
          'as planned. The orchestrator must retry the upstream step or restructure the plan.';
      changed.push(s);
    }
    if (changed.length === 0) return [];
    await this.stepRepo.save(changed);
    await this.missions.recordEvent(mission, {
      type: 'step_blocked',
      message: `${changed.length} step(s) blocked by an upstream failure: ${changed.map((s) => s.step_key).join(', ')}`,
      actor_type: 'system',
      data: { blocked: changed.map((s) => s.step_key) },
    });
    return changed.map((s) => s.step_key);
  }

  /**
   * 상류가 복구되면 **엔진이 자동으로 막았던** 하류를 다시 실행 가능하게 되돌린다
   * (티켓 4d065f82, 리뷰 라운드1 P1-4).
   *
   * `propagateBlocking` 은 여태 한 방향뿐이었다 — pending → blocked 로만 갔고 돌아오는
   * 경로가 없었다. 그래서 실패(또는 needs_recovery)한 step 을 retry 로 되살려도 그때
   * 딸려 막힌 하류는 영원히 blocked 로 남아 미션이 완료될 수 없었다. `blocked` 는
   * `computePlanProgress` 에서 terminal 로 분류되므로 다시 dispatchable 이 되는 길도 없다.
   *
   * **작업자가 스스로 보고한 blocked 는 절대 건드리지 않는다** (`auto_blocked=false`) —
   * 그건 "내가 할 수 없다"는 사람/에이전트의 판정이라 상류 복구와 무관하다.
   */
  private async unblockAutoBlockedDependents(mission: OrchestrationMission): Promise<string[]> {
    const steps = await this.missions.listSteps(mission.id);
    const candidates = steps.filter((s) => s.status === 'blocked' && s.auto_blocked);
    if (candidates.length === 0) return [];

    // "지금 풀어도 되는가"를 직접 재계산하지 않는다. blocked 는 두 판정기 모두에서
    // terminal 로 분류되므로 그 상태 그대로는 물어볼 수 없어서, 후보를 pending 으로
    // **가정한 사본**을 만들어 같은 progress 판정기에 다시 태운다. 그래야 wave 와 graph
    // (조건 분기·join policy 포함)가 각자의 규칙으로 답하고, 이 메서드가 세 번째 판정
    // 분기가 되지 않는다 — CLAUDE.md 의 "판정 분기는 computeMissionProgress 한 곳에만".
    const candidateKeys = new Set(candidates.map((s) => s.step_key));
    const hypothetical = steps.map((s) =>
      candidateKeys.has(s.step_key) ? { ...s, status: 'pending' as const } : s,
    );
    const progress = this.progressOf(mission, hypothetical as OrchestrationStep[]);
    const stillBlocked = new Set(progress.newlyBlocked);

    const restored: OrchestrationStep[] = [];
    for (const s of candidates) {
      if (stillBlocked.has(s.step_key)) continue;
      s.status = 'pending';
      s.auto_blocked = false;
      s.finished_at = null;
      // 자동 차단이 남긴 안내문만 지운다 — 작업자가 쓴 결과는 위 가드로 이미 제외됐다.
      if (s.result_summary.startsWith('[auto-blocked]')) s.result_summary = '';
      restored.push(s);
    }
    if (restored.length === 0) return [];

    await this.stepRepo.save(restored);
    await this.missions.recordEvent(mission, {
      type: 'step_unblocked',
      message:
        `${restored.length} step(s) unblocked because the upstream failure was recovered: ` +
        restored.map((s) => s.step_key).join(', '),
      actor_type: 'system',
      data: { unblocked: restored.map((s) => s.step_key) },
    });
    return restored.map((s) => s.step_key);
  }

  /**
   * Decide whether the orchestrator has to make a decision now, and wake it if
   * so. Returns whether a wake-up was posted.
   *
   * Waking on EVERY step completion would burn a subagent spawn per step and
   * serialize a parallel plan behind the orchestrator's turn-around. Waking too
   * rarely strands the mission. The rule: wake on anything the engine cannot
   * resolve by itself — a failure, or a state where nothing is in flight and
   * nothing else can be dispatched.
   */
  private async decideWake(
    mission: OrchestrationMission,
    ctx: { justFinished: OrchestrationStep; blockedKeys: string[]; dispatched: string[] },
  ): Promise<boolean> {
    if (mission.status !== 'running') return false;

    const steps = await this.missions.listSteps(mission.id);
    const progress = this.progressOf(mission, steps);
    const counts = countSteps(steps);
    // 사람의 판정을 기다리는 것은 **정지가 아니다**(티켓 5dbe4aa2). 여기서 awaitingUser 를
    // 세지 않으면 confirm 게이트가 열릴 때마다 "stalled" 로 판정돼 오케스트레이터가
    // 깨어나고, 매번 subagent spawn 을 태우면서 "아무것도 디스패치할 수 없다" 는 잘못된
    // 진단을 반복한다 — 실제로는 사용자의 답만 있으면 그대로 진행되는 상태다.
    const quiet = progress.inFlight.length === 0 && progress.awaitingUser.length === 0;
    const failure = ctx.justFinished.status === 'failed' || ctx.justFinished.status === 'blocked';

    let reason: Parameters<typeof renderWakePrompt>[0]['reason'] | null = null;
    let detail = '';

    if (failure) {
      reason = ctx.justFinished.status === 'failed' ? 'step_failed' : 'step_blocked';
      detail =
        `Step \`${ctx.justFinished.step_key}\` ("${ctx.justFinished.title}") reported ` +
        `**${ctx.justFinished.status}**:\n\n${ctx.justFinished.result_summary || '(no summary given)'}` +
        (ctx.blockedKeys.length
          ? `\n\nThis also blocked downstream steps: ${ctx.blockedKeys.map((k) => `\`${k}\``).join(', ')}.`
          : '');
    } else if (progress.allTerminal) {
      reason = 'all_steps_terminal';
      detail =
        `Every step in the plan has finished. Verify the acceptance criteria and either complete the mission ` +
        `or add the remaining work.`;
    } else if (quiet) {
      // Nothing running. pump() ran just above, so if anything had been
      // dispatchable it would now be in flight and `quiet` would be false —
      // reaching here means nothing CAN be dispatched: either steps are
      // unassigned, or every remaining one waits on something that will never
      // resolve. Either way only the orchestrator can break the tie.
      // confirm node 는 사람이 답하는 게이트라 assignee 가 없는 게 정상이다 — 여기 섞이면
      // 오케스트레이터에게 "이 step 에 담당자를 배정하라" 는 실행 불가능한 지시가 나간다.
      const unassigned = steps.filter(
        (s) =>
          !isTerminalStepStatus(s.status) &&
          !s.assignee_agent_id &&
          !this.confirmNodeOf(mission, s.step_key),
      );
      reason = 'stalled';
      detail = unassigned.length
        ? `These steps have no assignee, so nothing can be dispatched: ` +
          `${unassigned.map((s) => `\`${s.step_key}\``).join(', ')}. Assign them with ` +
          `\`update_orchestration_step\` (action \`reassign\`) or resubmit the plan with assignees.`
        : `No step is running and none can start. Remaining open steps: ` +
          `${progress.waiting.concat(progress.dispatchable).map((k) => `\`${k}\``).join(', ') || '(none)'}.`;
    }
    // Not quiet ⇒ work is still in flight and the engine keeps going on its own.
    // Waking the orchestrator per completed step would burn a subagent spawn
    // each time and serialize a parallel plan behind its turnaround.

    if (!reason) return false;

    const prompt = renderWakePrompt({ mission, reason, detail, counts });
    if (!mission.room_id) return false;
    try {
      await this.postToRoom(mission.room_id, mission.workspace_id, prompt);
    } catch (e: any) {
      this.logService.error(
        'Orchestration',
        `failed to wake orchestrator for mission ${mission.id}: ${e?.message || e}`,
      );
      await this.missions.recordEvent(mission, {
        type: 'error',
        message: `Could not wake the orchestrator (${e?.message || e}). The mission needs operator attention.`,
        actor_type: 'system',
      });
      return false;
    }
    await this.missions.recordEvent(mission, {
      type: 'orchestrator_woken',
      message: `Orchestrator woken — ${reason.replace(/_/g, ' ')}`,
      actor_type: 'system',
      data: { reason },
    });
    return true;
  }

  /**
   * "Look at this again" nudge for a wedged mission.
   *
   * `reasonTag` distinguishes an operator nudge from a reaper re-brief on the
   * timeline. The reaper counts its OWN prior nudges to decide when to give up,
   * so it must not be able to mistake an operator's nudge for one of its
   * attempts — otherwise two manual nudges would make the next sweep fail a
   * mission that was never actually re-briefed by the reaper.
   */
  async nudgeOrchestrator(
    missionId: string,
    workspaceId: string,
    actor: ActorRef,
    note: string,
    reasonTag: string = 'manual',
  ): Promise<void> {
    return this.withMissionLock(missionId, async () => {
      const mission = await this.missions.requireMission(missionId, workspaceId);
      if (!mission.room_id) throw orchestrationError(409, 'mission has not been started yet');
      if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) {
        throw orchestrationError(409, `mission is ${mission.status}`);
      }
      const steps = await this.missions.listSteps(mission.id);
      const prompt = renderWakePrompt({
        mission,
        reason: 'manual',
        detail: note?.trim()
          ? `Operator note:\n\n${note.trim()}`
          : 'An operator asked you to reassess this mission and take the next action.',
        counts: countSteps(steps),
      });
      await this.postToRoom(mission.room_id, mission.workspace_id, prompt);
      await this.missions.recordEvent(mission, {
        type: 'orchestrator_woken',
        message: `Orchestrator nudged by ${actor.name || actor.type}${note ? `: ${note.slice(0, 200)}` : ''}`,
        actor_type: actor.type,
        actor_id: actor.id,
        actor_name: actor.name,
        data: { reason: reasonTag },
      });
    });
  }

  /**
   * Fail a step from outside the member's own report (reaper timeout), then run
   * the same downstream handling a real failure report would.
   */
  /**
   * lease 만료 reconciliation — 리퍼가 in-flight step 마다 부르는 **단일 진입점**이다
   * (티켓 4d065f82, 리뷰 라운드1 P0-1).
   *
   * 이전에는 만료를 보자마자 `failStepExternally` 로 넘겨 step 을 죽였다. 요구된
   * "stale worker 재연결 · 상태조회 · 유예 후 새 attempt 재디스패치"가 통째로 없었고,
   * 복구는 orchestrator 가 수동으로 retry 를 부를 때까지 일어나지 않았다.
   *
   * 이제 두 단계다:
   *
   *   1) **만료 최초 관측** — 죽이지 않는다. `lease_stale_since` 를 찍고, 그 작업자의
   *      현재 상태(online 여부)를 조회해 trace 에 남기고, step room 에 재연결/상태보고
   *      요청을 포스트한다. 작업자가 유예 안에 heartbeat 를 보내면 lease 가 그대로
   *      되살아난다(`reportProgress` 가 `lease_stale_since` 를 지운다).
   *
   *   2) **유예 경과** — 그래도 응답이 없으면 새 attempt 로 **자동** 재디스패치한다.
   *      재디스패치는 `dispatchStep` 그대로라 새 lease token 과 새 room 을 받고, 이전
   *      attempt 의 지각 결과는 fencing 이 이미 거부한다(= idempotent). 예산이
   *      남지 않았거나 `retry_policy='manual'` 이면 재실행하지 않고 종결한다.
   *
   * 이 경로는 "서버 재시작 직후 부팅 스윕"과 "정상 운용 중 주기 스윕"이 **같은**
   * 메서드를 부르므로, 장애 감지와 재시작 복구가 실제로 하나의 reconciliation 경로다.
   */
  async reconcileStaleLease(
    stepId: string,
    now: Date,
    graceMs: number,
    timeoutMinutes: number,
  ): Promise<'noticed' | 'redispatched' | 'terminal' | 'skipped'> {
    const found = await this.missions.requireStep(stepId);
    return this.withMissionLock(found.mission_id, async () => {
      // 락 안에서 다시 읽는다 — 대기 중에 작업자가 보고를 마쳤을 수 있다.
      const step = await this.missions.requireStep(stepId);
      if (!isInFlight(step.status)) return 'skipped';
      const mission = await this.missions.requireMission(step.mission_id);
      if (mission.status !== 'running') return 'skipped';

      const baseline = step.last_heartbeat_at ?? step.started_at ?? step.dispatched_at;
      if (!baseline) return 'skipped';
      const silentMs = now.getTime() - new Date(baseline).getTime();
      if (silentMs < timeoutMinutes * 60_000) {
        // 유예 중에 생존 신호가 돌아왔다 — lease 를 되살리고 흔적을 남긴다.
        if (step.lease_stale_since) {
          step.lease_stale_since = null;
          await this.stepRepo.save(step);
          await this.missions.recordEvent(mission, {
            type: 'step_lease_recovered',
            step_id: step.id,
            step_key: step.step_key,
            message: `"${step.title}" reconnected — the assignee resumed reporting before the grace window expired`,
            actor_type: 'system',
          });
        }
        return 'skipped';
      }

      // ── 1단계: 최초 관측 → 상태조회 + 재연결 요청 ──────────────────────────
      if (!step.lease_stale_since) {
        step.lease_stale_since = now;
        await this.stepRepo.save(step);

        const assignee = step.assignee_agent_id
          ? await this.agentRepo.findOne({ where: { id: step.assignee_agent_id } })
          : null;
        const assigneeName = await this.agentName(step.assignee_agent_id);
        await this.missions.recordEvent(mission, {
          type: 'step_lease_stale',
          step_id: step.id,
          step_key: step.step_key,
          message:
            `"${step.title}" went silent for ${Math.round(silentMs / 60_000)}m — asking ${assigneeName} to ` +
            `reconnect (assignee is ${assignee?.is_online ? 'online' : 'offline'}). ` +
            `A new attempt is dispatched if there is no answer within the grace window.`,
          actor_type: 'system',
          data: {
            assignee_online: !!assignee?.is_online,
            silent_ms: silentMs,
            grace_ms: graceMs,
            attempt: step.attempt,
            has_checkpoint: !!step.checkpoint,
          },
        });

        // 재연결 요청은 그 attempt 의 방으로 보낸다 — 살아 있다면 여기서 읽는다.
        if (step.room_id) {
          try {
            await this.postToRoom(
              step.room_id,
              mission.workspace_id,
              renderLeaseRecoveryNudge({ step, silentMs, graceMs }),
            );
          } catch (e: any) {
            this.logService.warn(
              'Orchestration',
              `failed to post reconnect request for step ${step.step_key}: ${e?.message || e}`,
            );
          }
        }
        return 'noticed';
      }

      // ── 2단계: 유예 경과 판정 ──────────────────────────────────────────────
      if (now.getTime() - new Date(step.lease_stale_since).getTime() < graceMs) return 'noticed';

      const manual = String(step.retry_policy || 'auto') === 'manual';
      const budgetLeft = step.attempt < step.max_attempts;
      const reason =
        `[lease expired] no sign of life for ${Math.round(silentMs / 60_000)} minutes and no answer to the ` +
        `reconnect request within the grace window.`;

      if (manual || !budgetLeft) {
        // 자동 재실행이 금지됐거나 예산이 없다 — 기존 종결 경로로 넘긴다.
        await this.finalizeUnrecoverableStep(mission, step, reason, manual, budgetLeft);
        return 'terminal';
      }

      // 새 attempt 로 자동 재디스패치. dispatchStep 이 attempt/lease/room 을 모두
      // 새로 발급하므로 이전 attempt 의 지각 결과는 fencing 이 거부한다.
      step.lease_stale_since = null;
      await this.stepRepo.save(step);
      await this.missions.recordEvent(mission, {
        type: 'step_auto_redispatched',
        step_id: step.id,
        step_key: step.step_key,
        message:
          `"${step.title}" is being re-dispatched as attempt ${step.attempt + 1}/${step.max_attempts} — ` +
          reason +
          (step.checkpoint ? ' The new attempt resumes from the last saved checkpoint.' : ''),
        actor_type: 'system',
        data: { previous_attempt: step.attempt, resumed_from_checkpoint: !!step.checkpoint },
      });

      // 이전 실패로 하류가 자동 차단됐다면 지금 되살린다 — 이 step 이 다시 실행
      // 중이므로 그 차단의 전제가 사라졌다.
      await this.unblockAutoBlockedDependents(mission);
      const allSteps = await this.missions.listSteps(mission.id);
      try {
        await this.dispatchStep(mission, step, allSteps, { recovery: true });
      } catch (e: any) {
        // budgetLeft 는 여기서 그대로 넘긴다 — 재디스패치가 실패한 것이지 재시도 예산이
        // 바닥난 게 아니다. false 를 넘기면 사유에 "예산 3회를 모두 소진했다"가 붙어
        // 운영자가 원인을 잘못 읽는다.
        await this.finalizeUnrecoverableStep(
          mission,
          step,
          `${reason} Re-dispatch also failed: ${e?.message || e}`,
          manual,
          budgetLeft,
        );
        return 'terminal';
      }
      return 'redispatched';
    });
  }

  /**
   * 자동 복구가 불가능하다고 확정됐을 때의 종결. `retry_policy='manual'` 이면
   * needs_recovery, 아니면 failed 로 간다. 호출자는 mission lock 을 쥐고 있어야 한다.
   */
  private async finalizeUnrecoverableStep(
    mission: OrchestrationMission,
    step: OrchestrationStep,
    reason: string,
    manual: boolean,
    budgetLeft: boolean,
  ): Promise<void> {
    const why = manual
      ? `${reason} 이 step 은 retry_policy='manual'(비멱등·위험 작업)로 선언돼 있어 자동으로 다시 ` +
        `실행하지 않는다. 이미 어디까지 반영됐는지 사람이 확인한 뒤 ` +
        `update_orchestration_step(action='retry') 또는 재배정으로만 재개할 수 있다.`
      : budgetLeft
        ? reason
        : `${reason} 재시도 예산 ${step.max_attempts}회를 모두 소진했다.`;

    step.status = manual ? 'needs_recovery' : 'failed';
    step.recovery_reason = manual ? why : '';
    step.result_summary = why.slice(0, SUMMARY_MAX);
    step.finished_at = new Date();
    step.lease_token = '';
    step.lease_stale_since = null;
    await this.stepRepo.save(step);
    await this.missions.recordEvent(mission, {
      type: manual ? 'step_needs_recovery' : 'step_failed',
      step_id: step.id,
      step_key: step.step_key,
      message: manual
        ? `Step "${step.title}" needs manual recovery: ${why.slice(0, 300)}`
        : `Step "${step.title}" failed: ${why.slice(0, 300)}`,
      actor_type: 'system',
      data: manual ? { retry_policy: 'manual', recovery_reason: why } : undefined,
    });

    const blocked = await this.propagateBlocking(mission);
    const pumped = await this.pump(mission);
    await this.wakeAfterPump(mission, pumped, { justFinished: step, blockedKeys: blocked });
  }

  async failStepExternally(stepId: string, reason: string): Promise<void> {
    const found = await this.missions.requireStep(stepId);
    return this.withMissionLock(found.mission_id, async () => {
      const step = await this.missions.requireStep(stepId);
      if (isTerminalStepStatus(step.status)) return;
      const mission = await this.missions.requireMission(step.mission_id);
      if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) return;

      // 비멱등·위험 작업(`retry_policy='manual'`)은 자동 재실행 경로로 보내지 않는다
      // (티켓 4d065f82). `failed` 로 두면 orchestrator 가 정상 실패 처리로 다시 띄울 수
      // 있는데, 배포·결제·외부 게시처럼 "한 번 더"가 그 자체로 피해인 작업에서는 그게
      // 바로 막아야 할 동작이다. 대신 사유를 붙여 needs_recovery 로 세운다.
      const manual = String(step.retry_policy || 'auto') === 'manual';
      step.status = manual ? 'needs_recovery' : 'failed';
      step.recovery_reason = manual
        ? `${reason} 이 step 은 retry_policy='manual'(비멱등·위험 작업)로 선언돼 있어 자동으로 다시 ` +
          `실행하지 않는다. 이미 어디까지 반영됐는지 사람이 확인한 뒤 update_orchestration_step(action='retry') ` +
          `또는 재배정으로만 재개할 수 있다.`
        : '';
      step.result_summary = reason.slice(0, SUMMARY_MAX);
      step.finished_at = new Date();
      // lease 를 만료시킨다 — 뒤늦게 살아난 subagent 가 이 step 에 다시 쓰지 못하게.
      step.lease_token = '';
      await this.stepRepo.save(step);
      await this.missions.recordEvent(mission, {
        type: manual ? 'step_needs_recovery' : 'step_failed',
        step_id: step.id,
        step_key: step.step_key,
        message: manual
          ? `Step "${step.title}" needs manual recovery: ${reason.slice(0, 300)}`
          : `Step "${step.title}" failed: ${reason.slice(0, 300)}`,
        actor_type: 'system',
        data: manual ? { retry_policy: 'manual', recovery_reason: step.recovery_reason } : undefined,
      });

      const blocked = await this.propagateBlocking(mission);
      const pumped = await this.pump(mission);
      await this.wakeAfterPump(mission, pumped, { justFinished: step, blockedKeys: blocked });
    });
  }

  /**
   * 리퍼가 락 밖 스냅샷만으로 stalled 라고 판단한 미션을 실패 처리한다 — 단,
   * `withMissionLock` 안에서 실제로 다시 검증한 뒤에만. 리퍼는 give-up 을
   * 결정하기까지 여러 번의 락 없는 await(타임라인 집계, nudge 횟수 조회)를
   * 거치는데, 그 틈에 `submit_orchestration_plan` 호출이나 nudge 로 촉발된
   * dispatch 가 끼어들어 리퍼가 덮어쓰려는 바로 그 미션을 바꿔놓을 수 있다.
   * `submitPlan`/`reportStep` 이 쓰는 것과 동일한 락 안에서 상태(그리고
   * `running` 케이스는 in-flight 스텝까지)를 새로 재조회하면, 이미 단일
   * 스텝에 대해 `failStepExternally` 가 제공하는 것과 같은 충돌-안전성을
   * 미션 승격에도 그대로 갖게 된다.
   *
   * 실제로 미션을 실패시켰는지 여부를 반환한다 — false 면 fresh 재조회에서
   * 스냅샷이 이미 stale 해진 것을 발견했다는 뜻(다른 경로가 먼저 미션을
   * 처리함)이므로, 호출자는 이를 리퍼발 실패로 집계하면 안 된다.
   */
  async failMissionExternally(
    missionId: string,
    expectedStatus: 'planning' | 'running',
    reason: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    return this.withMissionLock(missionId, async () => {
      const mission = await this.missions.requireMission(missionId);
      if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) {
        this.logService.warn(
          'Orchestration',
          `reaper give-up on mission ${missionId} skipped — already ${mission.status}`,
        );
        return false;
      }
      if (mission.status !== expectedStatus) {
        this.logService.warn(
          'Orchestration',
          `reaper give-up on mission ${missionId} skipped — expected ${expectedStatus} but found ` +
            `${mission.status} (changed between the reaper's snapshot and this check)`,
        );
        return false;
      }

      const steps = await this.missions.listSteps(mission.id);
      if (expectedStatus === 'running' && steps.some((s) => isInFlight(s.status))) {
        this.logService.warn(
          'Orchestration',
          `reaper give-up on mission ${missionId} skipped — a step is now in flight (just dispatched, no longer stalled)`,
        );
        return false;
      }

      // cancelMission 과 동일한 방식으로 남은 것을 정리한다 — 아직 픽업되지
      // 않은(미배정, 혹은 replan 으로 고아가 된) 스텝은 in-flight 가 아니므로
      // 위 체크를 통과했더라도 이대로 두면 terminal 미션 아래 계속 남는다.
      const open = steps.filter((s) => !isTerminalStepStatus(s.status));
      for (const s of open) {
        s.status = 'cancelled';
        s.finished_at = now;
      }
      if (open.length) await this.stepRepo.save(open);

      mission.status = 'failed';
      mission.failure_reason = reason.slice(0, 2000);
      mission.finished_at = now;
      await this.missionRepo.save(mission);
      await this.missions.recordEvent(mission, {
        type: 'mission_failed',
        message: `Mission failed: ${mission.failure_reason}. Check that the orchestrator agent is online and connected.`,
        actor_type: 'system',
      });
      return true;
    });
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  private requireOrchestrator(mission: OrchestrationMission, callerAgentId: string): void {
    if (!callerAgentId) {
      throw orchestrationError(401, 'this tool requires an authenticated agent session');
    }
    if (mission.orchestrator_agent_id !== callerAgentId) {
      throw orchestrationError(
        403,
        `only the mission's orchestrator may do this. You are not the orchestrator of mission ${mission.id}.`,
      );
    }
  }

  /** A step report may come from its assignee, or from the orchestrator closing it out. */
  private requireStepActor(step: OrchestrationStep, mission: OrchestrationMission, callerAgentId: string): void {
    if (!callerAgentId) {
      throw orchestrationError(401, 'this tool requires an authenticated agent session');
    }
    if (step.assignee_agent_id === callerAgentId) return;
    if (mission.orchestrator_agent_id === callerAgentId) return;
    throw orchestrationError(
      403,
      `step "${step.step_key}" is assigned to another agent — you cannot report on it`,
    );
  }

  /**
   * Canonical `<Manager>/<Agent>` display for an agent id. EVERY user-visible
   * agent name the runner produces (timeline actor, dispatch message, prompt
   * roster) must come through here or resolveAgentDisplayMap — never through a
   * bare `agent.name`. See .claude/skills/awb-agent-display-name.
   */
  private async agentName(agentId: string | null | undefined): Promise<string> {
    if (!agentId) return '';
    return (await resolveAgentDisplayName(this.agentRepo, agentId)) ?? '';
  }

  private async buildRoster(teamId: string): Promise<RosterEntry[]> {
    const members = await this.teams.listMembers(teamId);
    const present = members.filter((m) => m.agent);
    // The roster is what the orchestrator reads in its brief prompt, so it must
    // carry the same full name the operator sees in the UI — otherwise two
    // managers running an agent with the same short name are indistinguishable
    // to the orchestrator when it assigns steps.
    const displayById = await resolveAgentDisplayMap(
      this.agentRepo,
      present.map((m) => m.agent!),
    );
    return present
      .map((m) => ({
        agent_id: m.agent_id,
        agent_name: displayById.get(m.agent_id) ?? m.agent!.name,
        role_label: m.role_label,
        capabilities: m.capabilities,
        max_concurrent: m.max_concurrent,
        is_online: !!m.agent!.is_online,
      }));
  }

  /** Agent participant + the synthetic `system` user that carries dispatch messages. */
  private async addRoomParticipants(roomId: string, agentId: string): Promise<void> {
    const joinedAt = new Date();
    await this.participantRepo.save([
      this.participantRepo.create({
        room_id: roomId,
        participant_type: 'agent',
        participant_id: agentId,
        last_read_at: joinedAt,
        left_at: null,
      }),
      this.participantRepo.create({
        room_id: roomId,
        participant_type: 'user',
        participant_id: SYSTEM_SENDER_ID,
        last_read_at: joinedAt,
        left_at: null,
      }),
    ]);
  }

  /**
   * 기계가 렌더링한 지시문을 room에 게시한다.
   *
   * `sender_type: 'user'`('system'이 아님)는 필수다: agent-manager는 QA run
   * 디스패치와 정확히 동일하게 user가 작성한 room 메시지에 대해서만 작업을
   * 실행하기 때문이다. `bypassContentLimit`은 렌더링된 브리핑이 10k
   * interactive chat 한도를 일상적으로 넘기 때문에 필요하다. `runProvision`
   * (티켓 2dc3c62f, step 디스패치 전용 — mission 브리핑/wake room에는 절대
   * 붙지 않음)은 assignee의 subagent가 스폰되기 전에 agent-manager가 그
   * step의 격리된 작업폴더를 프로비저닝하도록 알려준다 — QA/Action run
   * 디스패치와 정확히 동일하다.
   */
  private postToRoom(roomId: string, workspaceId: string, content: string, runProvision?: RunProvision): Promise<any> {
    return this.messaging.sendMessage(
      roomId,
      workspaceId,
      'user',
      SYSTEM_SENDER_ID,
      SYSTEM_SENDER_NAME,
      content,
      undefined,
      undefined,
      'message',
      { bypassContentLimit: true, ...(runProvision ? { runProvision } : {}) },
    );
  }
}

function normalizeArtifacts(
  input: Array<{ kind?: string; ref?: string; label?: string }> | undefined,
): Array<{ kind: string; ref: string; label: string }> {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, MAX_ARTIFACTS_PER_STEP)
    .map((a) => ({
      kind: String(a?.kind ?? 'link').slice(0, 40),
      ref: String(a?.ref ?? '').slice(0, 500),
      label: String(a?.label ?? '').slice(0, 200),
    }))
    .filter((a) => a.ref);
}
