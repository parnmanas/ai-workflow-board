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
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { ActionsService } from '../actions/actions.service';
import { LogService } from '../../services/log.service';
import { OrchestrationMissionService, countSteps } from './orchestration-mission.service';
import { OrchestrationTeamService } from './orchestration-team.service';
import { orchestrationError } from './orchestration-errors';
import { resolveAgentDisplayMap, resolveAgentDisplayName } from '../../utils/agent-name';
import {
  DEPENDENCY_SATISFYING_STATUSES,
  MAX_ARTIFACTS_PER_STEP,
  MissionCompletionCriterion,
  PlanStepInput,
  POST_ACTION_STALE_IN_FLIGHT_MS,
  SUMMARY_MAX,
  TERMINAL_MISSION_STATUSES,
  allCriteriaMet,
  computePlanProgress,
  isInFlight,
  isTerminalStepStatus,
  normalizeCompletionCriteria,
  postActionApplies,
  validatePlan,
} from './orchestration.constants';
import {
  DependencyContext,
  RosterEntry,
  renderMissionPrompt,
  renderStepPrompt,
  renderWakePrompt,
} from './orchestration-prompt';
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
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly messaging: RoomMessagingService,
    private readonly missions: OrchestrationMissionService,
    private readonly teams: OrchestrationTeamService,
    private readonly actionsService: ActionsService,
    private readonly logService: LogService,
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
   *     남은 흔적)은 **절대 재시도하지 않는다** — dispatch()가 실제로는 이미
   *     발화했을 수 있어 재시도하면 ActionRun이 중복 생성될 위험이 있다. 대신
   *     `POST_ACTION_STALE_IN_FLIGHT_MS`보다 오래 멈춰 있으면 결과 불명으로
   *     `dispatch_failed` 처리해 감사 기록을 남긴다(reapPendingPostActions가
   *     주기적으로 재호출).
   *   - dispatch() 호출 **직전**에 `in_flight` + `dispatched_at`을 먼저
   *     저장한다 — completeMission()이 terminal status를 저장한 직후 ~ 이
   *     메서드가 끝나기 전 사이에 프로세스가 죽어도(리뷰 지적의 첫 번째
   *     crash-window), 남은 `pending`/`in_flight` 항목이 그대로 감사
   *     이력에 남아 reaper가 이어받을 수 있다.
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
        pa.status = 'dispatch_failed';
        pa.error =
          'in_flight 상태로 멈춰 있었습니다(프로세스 재시작 등으로 중단된 것으로 추정) — 실제 디스패치 여부를 ' +
          '알 수 없어 재시도하지 않고 결과 불명으로 기록합니다. run_id가 비어있으면 실제로는 디스패치되지 ' +
          '않았을 가능성이 높습니다.';
        await this.missionRepo.save(mission);
        await this.missions.recordEvent(mission, {
          type: 'post_action_dispatch_failed',
          message: `Post-action ${pa.action_id} left stuck in-flight (likely a crash) — treated as failed without retrying`,
          actor_type: 'system',
          data: { action_id: pa.action_id, error: pa.error, stale_in_flight: true },
        });
        continue;
      }
      if (pa.status !== 'pending') continue; // 이미 확정됨 — 재처리하지 않음(resumable의 핵심)

      if (!postActionApplies(pa.condition, mission.status)) {
        pa.status = 'skipped';
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
          triggeredById: `orchestration:${mission.id}`,
        });
        pa.status = 'dispatched';
        pa.run_id = result.run.id;
        pa.room_id = result.room_id;
        pa.error = '';
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
    input: { summary?: string; steps: PlanStepInput[] },
  ): Promise<{ mission: OrchestrationMission; created: string[]; updated: string[]; dispatched: string[] }> {
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
        data: { plan_version: nextVersion, created, updated },
      });

      const pumped = await this.pump(mission);
      await this.wakeAfterPump(mission, pumped);
      return { mission, created, updated, dispatched: pumped.dispatched };
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

  /** Non-terminal heartbeat from a member. Flips `dispatched` → `running`. */
  async reportProgress(stepId: string, callerAgentId: string, message: string): Promise<OrchestrationStep> {
    const step = await this.missions.requireStep(stepId);
    return this.withMissionLock(step.mission_id, async () => {
      const fresh = await this.missions.requireStep(stepId);
      const mission = await this.missions.requireMission(fresh.mission_id);
      this.requireStepActor(fresh, mission, callerAgentId);
      if (isTerminalStepStatus(fresh.status)) {
        throw orchestrationError(409, `step "${fresh.step_key}" is already ${fresh.status}`);
      }
      if (fresh.status === 'dispatched') {
        fresh.status = 'running';
        fresh.started_at = fresh.started_at ?? new Date();
        await this.stepRepo.save(fresh);
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
    },
  ): Promise<{ step: OrchestrationStep; dispatched: string[]; orchestrator_woken: boolean }> {
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

      const actorName = await this.agentName(callerAgentId);
      step.status = input.status;
      step.result_summary = (input.summary || '').slice(0, SUMMARY_MAX);
      step.artifacts = normalizeArtifacts(input.artifacts);
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
        data: { artifacts: step.artifacts ?? [] },
      });

      const blocked = await this.propagateBlocking(mission);
      const pumped = await this.pump(mission);
      const woken = await this.wakeAfterPump(mission, pumped, { justFinished: step, blockedKeys: blocked });

      return { step, dispatched: pumped.dispatched, orchestrator_woken: woken };
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
  private async pump(mission: OrchestrationMission): Promise<{ dispatched: string[]; failed: OrchestrationStep[] }> {
    if (mission.status !== 'running') return { dispatched: [], failed: [] };

    const steps = await this.missions.listSteps(mission.id);
    const progress = computePlanProgress(
      steps.map((s) => ({ step_key: s.step_key, status: s.status, depends_on: s.depends_on })),
    );
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
    if (slots <= 0) return { dispatched: [], failed: [] };

    const dispatched: string[] = [];
    const failed: OrchestrationStep[] = [];
    const candidates = progress.dispatchable
      .map((k) => byKey.get(k)!)
      .filter(Boolean)
      .sort((a, b) => a.position - b.position);

    for (const step of candidates) {
      if (slots <= 0) break;
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
    step.status = 'dispatched';
    step.room_id = room.id;
    step.dispatched_at = new Date();
    step.started_at = null;
    step.finished_at = null;
    await this.stepRepo.save(step);

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

    const prompt = renderStepPrompt({
      mission,
      step,
      teamName: team?.name ?? '',
      orchestratorName,
      dependencies,
      isRetry: step.attempt > 1,
      workspaceFolder: runProvision.workspace_folder,
    });

    await this.postToRoom(room.id, mission.workspace_id, prompt, runProvision);

    await this.missions.recordEvent(mission, {
      type: 'step_dispatched',
      step_id: step.id,
      step_key: step.step_key,
      message: `Step "${step.title}" dispatched to ${await this.agentName(agent.id)} (attempt ${step.attempt}/${step.max_attempts})`,
      actor_type: 'system',
      data: { room_id: room.id, assignee_agent_id: agentId, attempt: step.attempt },
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
    const progress = computePlanProgress(
      steps.map((s) => ({ step_key: s.step_key, status: s.status, depends_on: s.depends_on })),
    );
    if (progress.newlyBlocked.length === 0) return [];

    const byKey = new Map(steps.map((s) => [s.step_key, s]));
    const changed: OrchestrationStep[] = [];
    for (const key of progress.newlyBlocked) {
      const s = byKey.get(key);
      if (!s || s.status === 'blocked') continue;
      s.status = 'blocked';
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
    const progress = computePlanProgress(
      steps.map((s) => ({ step_key: s.step_key, status: s.status, depends_on: s.depends_on })),
    );
    const counts = countSteps(steps);
    const quiet = progress.inFlight.length === 0;
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
      const unassigned = steps.filter((s) => !isTerminalStepStatus(s.status) && !s.assignee_agent_id);
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
  async failStepExternally(stepId: string, reason: string): Promise<void> {
    const found = await this.missions.requireStep(stepId);
    return this.withMissionLock(found.mission_id, async () => {
      const step = await this.missions.requireStep(stepId);
      if (isTerminalStepStatus(step.status)) return;
      const mission = await this.missions.requireMission(step.mission_id);
      if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) return;

      step.status = 'failed';
      step.result_summary = reason.slice(0, SUMMARY_MAX);
      step.finished_at = new Date();
      await this.stepRepo.save(step);
      await this.missions.recordEvent(mission, {
        type: 'step_failed',
        step_id: step.id,
        step_key: step.step_key,
        message: `Step "${step.title}" failed: ${reason.slice(0, 300)}`,
        actor_type: 'system',
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
