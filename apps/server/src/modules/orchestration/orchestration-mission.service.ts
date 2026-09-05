/**
 * Mission reads, timeline writes, and the live-update fan-out.
 *
 * Split from the runner so that "what does the UI see" and "how does work get
 * dispatched" stay independently reviewable: this file never sends a chat
 * message or changes a step's status, and the runner never assembles a view
 * model. The one thing they share is `recordEvent`, which is deliberately here
 * because every timeline write must be paired with the same SSE push — putting
 * it anywhere else invites a state change that the board never learns about.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository, In, Not } from 'typeorm';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { OrchestrationStep } from '../../entities/OrchestrationStep';
import { OrchestrationEvent } from '../../entities/OrchestrationEvent';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { Agent } from '../../entities/Agent';
import { ChatRoom } from '../../entities/ChatRoom';
import { resolveAgentDisplayMap, resolveAgentDisplayName } from '../../utils/agent-name';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { orchestrationError } from './orchestration-errors';
import { GraphSpec, computeMissionProgress } from './orchestration-graph';
import { renderConfirmPolicyGuidance } from './orchestration-prompt';
import { enforceRunBudget } from '../../common/run-budget-guard';
import { sinceBoundaryParam } from '../../common/created-at-since-param';
import { visibleScopeWhere } from '../skills/skill-scope';
import {
  MAX_PARALLEL_CEILING,
  MAX_STEPS_CEILING,
  TERMINAL_MISSION_STATUSES,
  ConfirmDecision,
  ConfirmPolicy,
  MissionCompletionCriterion,
  MissionPostAction,
  isAwaitingUser,
  isInFlight,
  isTerminalStepStatus,
  normalizeCompletionCriteria,
  normalizeConfirmPolicy,
  normalizePostActions,
  UserChatMode,
  normalizeUserChatMode,
  openJoinForUserChatMode,
} from './orchestration.constants';
import {
  CheckoutMode,
  WorkspaceFolderRepoRef,
  normalizeCheckoutMode,
  normalizeRepoRef,
  normalizeWorkspaceFolder,
  resolveWorkspaceFolder,
} from '../../common/workspace-folder-options';

export interface MissionCounts {
  total: number;
  done: number;
  failed: number;
  inFlight: number;
  pending: number;
  /**
   * 사람의 confirm 판정을 기다리는 step 수(티켓 5dbe4aa2). `pending`에서 분리했다 —
   * "아직 시작 안 함"과 "당신의 답을 기다리는 중"은 운영자가 해야 할 행동이 정반대다.
   */
  awaitingUser: number;
}

export interface MissionListItem {
  id: string;
  workspace_id: string;
  team_id: string;
  team_name: string;
  title: string;
  status: string;
  orchestrator_agent_id: string | null;
  orchestrator_name: string;
  plan_version: number;
  counts: MissionCounts;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MissionStepView {
  id: string;
  step_key: string;
  title: string;
  instructions: string;
  acceptance_criteria: string;
  depends_on: string[];
  assignee_agent_id: string | null;
  assignee_name: string;
  assignee_online: boolean;
  status: string;
  position: number;
  plan_version: number;
  room_id: string | null;
  result_summary: string;
  artifacts: Array<{ kind: string; ref: string; label: string }>;
  attempt: number;
  max_attempts: number;
  dispatched_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  /** 이 step의 assignee가 (이미 또는 앞으로) 고정될 working_dir-relative 폴더. */
  workspace_folder: string;
  /** loop 재진입 횟수(1-based, 미실행 0). attempt(같은 iteration의 재시도)와 다른 축. */
  visit: number;
  /** 마지막으로 보고된 verdict — 조건 분기의 근거. '' = 없음. */
  verdict: string;
  /** 'auto' | 'manual'. manual 이면 lease 만료 시 자동 재실행 대신 needs_recovery. */
  retry_policy: string;
  /** needs_recovery 사유. 다른 상태에서는 ''. */
  recovery_reason: string;
  /** 마지막 생존 신호 시각 — 리퍼 타임아웃의 기준선. */
  last_heartbeat_at: Date | null;
  /** confirm node 에 사람이 내린 판정(티켓 5dbe4aa2). null = 아직 판정 전/해당 없음. */
  confirm_decision: ConfirmDecision | null;
}

export interface MissionDetail extends MissionListItem {
  objective: string;
  context: string;
  acceptance_criteria: string;
  method: string;
  completion_criteria: MissionCompletionCriterion[];
  post_actions: MissionPostAction[];
  /** 해석 완료된 working_dir-relative 루트(절대 ''가 아님) — `.awb/orch/<leaf>`. */
  resolved_workspace_folder: string;
  workspace_folder: string;
  repo_ref: WorkspaceFolderRepoRef | null;
  checkout_mode: CheckoutMode;
  plan_summary: string;
  result_summary: string;
  failure_reason: string;
  room_id: string | null;
  max_parallel_steps: number;
  max_steps: number;
  max_plan_versions: number;
  step_timeout_minutes: number;
  created_by_type: string;
  created_by: string;
  /** 그래프 모드 여부(티켓 1ca9e49b) — false면 기존 depends_on 실행 계약. */
  graph_enabled: boolean;
  /** 확정된 실행 그래프. null = wave/DAG 모드. */
  graph_spec: GraphSpec | null;
  /** 그래프가 부분 수정된 횟수(티켓 2fc8f99a). 0 = 확정 이후 patch 없음. */
  graph_revision: number;
  /** 지금까지 소진된 node 실행 횟수(global budget). */
  total_visits: number;
  /** 사용자 확인 강도 — 항상 정규화된 값이다(티켓 5dbe4aa2). */
  confirm_policy: ConfirmPolicy;
  /** 미션 대화의 사용자 chat 옵션 — 항상 정규화된 값이다(티켓 9cfd8161). */
  user_chat_mode: UserChatMode;
  steps: MissionStepView[];
  events: Array<{
    id: string;
    type: string;
    step_id: string | null;
    step_key: string;
    actor_type: string;
    actor_id: string;
    actor_name: string;
    message: string;
    data: Record<string, any> | null;
    created_at: Date;
    write_seq: number;
  }>;
}

@Injectable()
export class OrchestrationMissionService {
  constructor(
    @InjectRepository(OrchestrationMission) private readonly missionRepo: Repository<OrchestrationMission>,
    @InjectRepository(OrchestrationStep) private readonly stepRepo: Repository<OrchestrationStep>,
    @InjectRepository(OrchestrationEvent) private readonly eventRepo: Repository<OrchestrationEvent>,
    @InjectRepository(OrchestrationTeam) private readonly teamRepo: Repository<OrchestrationTeam>,
    @InjectRepository(OrchestrationTeamMember) private readonly memberRepo: Repository<OrchestrationTeamMember>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  // ── Lookups ───────────────────────────────────────────────────────────────

  async requireMission(missionId: string, workspaceId?: string): Promise<OrchestrationMission> {
    const where: any = { id: missionId };
    if (workspaceId) where.workspace_id = workspaceId;
    const mission = await this.missionRepo.findOne({ where });
    if (!mission) throw orchestrationError(404, 'mission not found');
    return mission;
  }

  async requireStep(stepId: string, workspaceId?: string): Promise<OrchestrationStep> {
    const where: any = { id: stepId };
    if (workspaceId) where.workspace_id = workspaceId;
    const step = await this.stepRepo.findOne({ where });
    if (!step) throw orchestrationError(404, 'step not found');
    return step;
  }

  listSteps(missionId: string): Promise<OrchestrationStep[]> {
    return this.stepRepo.find({ where: { mission_id: missionId }, order: { position: 'ASC', created_at: 'ASC' } });
  }

  /**
   * Steps an agent still owes a report on. The recovery path for a member whose
   * session died with the work order in it — without this, its only route back
   * to an in-flight assignment is the room history the manager may no longer
   * replay. Uses the repository API rather than raw SQL because parameter
   * placeholders differ between the sql.js and Postgres backends.
   */
  async listOpenStepsForAgent(agentId: string): Promise<Array<Record<string, any>>> {
    if (!agentId) return [];
    const steps = await this.stepRepo.find({
      where: { assignee_agent_id: agentId, status: In(['dispatched', 'running']) },
      order: { dispatched_at: 'ASC' },
      take: 50,
    });
    if (steps.length === 0) return [];
    const missions = await this.missionRepo.find({
      where: { id: In(Array.from(new Set(steps.map((s) => s.mission_id)))) },
    });
    const missionById = new Map(missions.map((m) => [m.id, m]));
    return steps.map((s) => ({
      step_id: s.id,
      step_key: s.step_key,
      title: s.title,
      status: s.status,
      // 세션을 잃은 agent 가 복구하는 바로 그 경로다 — 여기서 lease token 을 돌려주지
      // 않으면, 재시작 뒤 살아난 agent 가 자기 work order 를 잃어버린 채 보고에 필요한
      // 토큰을 어디서도 얻지 못해 **영원히 보고할 수 없게** 된다(티켓 4d065f82).
      // 조회 자체가 assignee 본인으로 제한돼 있으므로 노출 범위는 늘지 않는다.
      lease_token: s.lease_token || '',
      checkpoint: s.checkpoint ?? null,
      checkpoint_at: s.checkpoint_at ?? null,
      dispatched_at: s.dispatched_at,
      mission_id: s.mission_id,
      mission_title: missionById.get(s.mission_id)?.title ?? '',
      mission_status: missionById.get(s.mission_id)?.status ?? '',
    }));
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async createMission(input: {
    workspace_id: string;
    team_id: string;
    title: string;
    objective?: string;
    context?: string;
    acceptance_criteria?: string;
    method?: string;
    completion_criteria?: unknown;
    post_actions?: unknown;
    workspace_folder?: string;
    repo_ref?: unknown;
    checkout_mode?: string;
    max_parallel_steps?: number;
    max_steps?: number;
    max_plan_versions?: number;
    step_timeout_minutes?: number;
    /** 실행 그래프(조건 분기/join/bounded loop) 사용 여부 — 티켓 1ca9e49b. */
    graph_enabled?: boolean;
    /** 사용자 확인 강도 — 'none' | 'auto'(기본) | 'key_steps' | 'every_step'. 티켓 5dbe4aa2. */
    confirm_policy?: string;
    /** 미션 대화의 사용자 chat 옵션 — 'open'(기본) | 'participants_only' | 'off'. 티켓 9cfd8161. */
    user_chat_mode?: string;
    created_by_type?: string;
    created_by?: string;
    /**
     * Stamp the orchestrator at creation time rather than leaving it null
     * until startMission runs (ticket b7127aae review round 2). Without this,
     * a mission that is left `draft` (start:false, or startMission throwing
     * before it stamps this field — e.g. an empty roster) has
     * orchestrator_agent_id=null forever: requireOrchestrator's `!==
     * callerAgentId` check then 403s EVERY caller, including the real
     * orchestrator, so complete_orchestration_mission/get_orchestration_mission
     * can't reach it either — a team-slot wedge with no MCP escape hatch.
     * Must equal team.orchestrator_agent_id (checked below); startMission
     * overwrites this with the same value when it actually starts, so
     * pre-stamping it here is idempotent with that path.
     */
    orchestrator_agent_id?: string;
  }): Promise<OrchestrationMission> {
    const workspaceId = (input.workspace_id || '').trim();
    const title = (input.title || '').trim();
    if (!workspaceId) throw orchestrationError(400, 'workspace_id is required');
    if (!title) throw orchestrationError(400, 'title is required');

    // Run-creation-rate ceiling (ticket a51ec6d9) — head of the chokepoint,
    // before any side effect below (mission row save, recordEvent). No
    // roomMessagingService here deliberately — this file's own header
    // contract is "never sends a chat message" (that's the runner's job), so
    // a breach still rejects/logs via logService but skips the optional chat
    // alert rather than crossing that boundary for one notify call.
    await enforceRunBudget({ dataSource: this.dataSource, logger: this.logService }, 'orchestration', workspaceId);

    // 이 workspace 소유 팀 OR 글로벌 팀(티켓 1b62b437)에 매칭된다 — 글로벌 팀의
    // 로스터는 workspace 비종속이지만, 이 팀이 실행하는 MISSION은 여전히 호출자가
    // 해석한 workspace에 귀속/과금된다.
    const team = await this.teamRepo.findOne({
      where: visibleScopeWhere<OrchestrationTeam>(workspaceId, { id: input.team_id }),
    });
    if (!team) throw orchestrationError(404, 'orchestration team not found in workspace');
    if (!team.orchestrator_agent_id) {
      throw orchestrationError(400, `team "${team.name}" has no orchestrator agent set`);
    }
    // 글로벌 팀의 allowed_workspace_ids를 권위 있게 강제하는 지점 — "MANAGE_ACTIONS을
    // 가진 아무 호출자"와 "팀이 허가받은 적 없는 workspace에 미션을 과금"을 가르는
    // 유일한 게이트(티켓 1b62b437). create_orchestration_mission의 사전 검사만이
    // 아니라 여기에도 있어야, team-scope 검사가 따로 없는 REST/human 경로
    // (POST /orchestration/missions)에도 똑같이 적용된다 — 안 그러면 그 컨트롤러는
    // 글로벌 팀에 대해 호출자가 준 workspace_id를 아무 검증 없이 그대로 통과시킨다.
    if (team.workspace_id === null) {
      const allowed = Array.isArray(team.allowed_workspace_ids) ? team.allowed_workspace_ids : [];
      if (allowed.length === 0) {
        throw orchestrationError(
          409,
          `team "${team.name}" is global but has no allowed workspaces configured — a human operator must ` +
            `set the team's workspace allow-list before it can create missions.`,
        );
      }
      if (!allowed.includes(workspaceId)) {
        throw orchestrationError(400, `workspace_id "${workspaceId}" is not on team "${team.name}"'s allowed workspace list.`);
      }
    }
    if (input.orchestrator_agent_id && input.orchestrator_agent_id !== team.orchestrator_agent_id) {
      throw orchestrationError(403, 'orchestrator_agent_id must match the team\'s own orchestrator');
    }

    const objective = (input.objective || '').trim();
    if (!objective) throw orchestrationError(400, 'objective is required — the orchestrator plans from it');

    const criteriaResult = normalizeCompletionCriteria(input.completion_criteria);
    if ('error' in criteriaResult) throw orchestrationError(400, criteriaResult.error);
    const postActionsResult = normalizePostActions(input.post_actions);
    if ('error' in postActionsResult) throw orchestrationError(400, postActionsResult.error);

    const mission = await this.missionRepo.save(
      this.missionRepo.create({
        workspace_id: workspaceId,
        team_id: team.id,
        title,
        objective,
        context: (input.context || '').trim(),
        acceptance_criteria: (input.acceptance_criteria || '').trim(),
        method: (input.method || '').trim(),
        completion_criteria: criteriaResult.criteria.length ? criteriaResult.criteria : null,
        post_actions: postActionsResult.postActions.length ? postActionsResult.postActions : null,
        // 정의 직후엔 전 항목이 normalizePostActions()에 의해 'pending'이므로,
        // "미확정 항목 있음" == "배열이 비어있지 않음"이다(post_actions_pending
        // 문서 참고). 이후 runPostActions()가 실제 처리 진행에 맞춰 갱신한다.
        post_actions_pending: postActionsResult.postActions.length > 0,
        workspace_folder: normalizeWorkspaceFolder(input.workspace_folder),
        repo_ref: normalizeRepoRef(input.repo_ref),
        checkout_mode: normalizeCheckoutMode(input.checkout_mode),
        status: 'draft',
        orchestrator_agent_id: input.orchestrator_agent_id || null,
        max_parallel_steps: clampInt(input.max_parallel_steps, team.max_parallel_steps, 1, MAX_PARALLEL_CEILING),
        max_steps: clampInt(input.max_steps, 60, 1, MAX_STEPS_CEILING),
        max_plan_versions: clampInt(input.max_plan_versions, 6, 1, 50),
        step_timeout_minutes: clampInt(input.step_timeout_minutes, 90, 0, 60 * 24 * 7),
        graph_enabled: input.graph_enabled === true,
        confirm_policy: normalizeConfirmPolicy(input.confirm_policy),
        user_chat_mode: normalizeUserChatMode(input.user_chat_mode),
        created_by_type: input.created_by_type || 'user',
        created_by: input.created_by || '',
      }),
    );

    await this.recordEvent(mission, {
      type: 'mission_created',
      actor_type: input.created_by_type || 'user',
      actor_id: input.created_by || '',
      actor_name: '',
      message: `Mission "${mission.title}" created for team ${team.name}`,
    });

    return mission;
  }

  async updateMission(
    missionId: string,
    workspaceId: string,
    patch: {
      title?: string;
      objective?: string;
      context?: string;
      acceptance_criteria?: string;
      method?: string;
      completion_criteria?: unknown;
      post_actions?: unknown;
      workspace_folder?: string;
      repo_ref?: unknown;
      checkout_mode?: string;
      max_parallel_steps?: number;
      max_steps?: number;
      max_plan_versions?: number;
      step_timeout_minutes?: number;
      graph_enabled?: boolean;
      confirm_policy?: string;
      user_chat_mode?: string;
    },
  ): Promise<OrchestrationMission> {
    const mission = await this.requireMission(missionId, workspaceId);
    if ((TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) {
      throw orchestrationError(409, `mission is ${mission.status} and can no longer be edited`);
    }
    // 브리핑(title/objective/context/criteria/method/workspace/post-actions)은
    // orchestrator가 브리핑되기 전, draft 상태일 때만 편집 가능하다. 미션
    // 프롬프트가 이미 전송된 뒤에 여기서 편집하면 orchestrator가 들은 내용과
    // UI가 보여주는 내용이 조용히 어긋난다 — orchestrator는 그 편집을 알 방법이
    // 없다. workspace_folder/repo_ref/checkout_mode도 함께 잠근다: 미션 도중
    // 체크아웃 위치를 바꾸면 이미 디스패치된 step(다른 폴더)과 이후 디스패치될
    // step이 서로 어긋난다. completion_criteria의 구조(어떤 criteria가 있는지)도
    // 여기서 잠긴다 — `met`을 런타임에 뒤집는 건 대신
    // `update_orchestration_criteria`(mission-locked, orchestrator 전용)로 한다.
    const briefLocked = mission.status !== 'draft';
    const touchesBrief =
      patch.title !== undefined ||
      patch.objective !== undefined ||
      patch.context !== undefined ||
      patch.acceptance_criteria !== undefined ||
      patch.method !== undefined ||
      patch.completion_criteria !== undefined ||
      patch.post_actions !== undefined ||
      patch.workspace_folder !== undefined ||
      patch.repo_ref !== undefined ||
      patch.checkout_mode !== undefined ||
      // graph_enabled도 브리핑 계약의 일부다: 미션이 이미 시작된 뒤 켜면
      // orchestrator는 자기가 분기/loop를 쓸 수 있다는 사실을 들은 적이 없고,
      // 끄면 이미 확정된 graph_spec이 실행 규칙과 어긋난다.
      patch.graph_enabled !== undefined ||
      // confirm_policy 도 브리핑 계약이다(티켓 5dbe4aa2): orchestrator 는 브리핑에서 들은
      // 정책대로 그래프를 짜므로, 미션이 시작된 뒤 조이면 이미 확정된 confirm 노드가
      // 실행 규칙과 어긋나고, 풀면 orchestrator 는 게이트를 쓸 수 있다는 사실을 들은 적이
      // 없어 정책이 아무 효과도 내지 못한다.
      patch.confirm_policy !== undefined;
    // `user_chat_mode` 는 **의도적으로 이 목록에 없다**(티켓 9cfd8161). 위 필드들이 잠기는
    // 이유는 전부 "orchestrator 가 브리핑에서 들은 내용과 어긋난다" 인데, 이 옵션은
    // orchestrator 가 들은 내용을 바꾸지 않는다 — 사람이 이 방에서 말할 수 있는지만
    // 정한다. 오히려 요구사항이 "옵션을 바꾸면 실행 중인 미션 방에도 즉시 반영" 이므로
    // running 중 편집이 가능해야 하며, 여기 넣으면 그 요구가 draft 미션에서만 성립한다.
    if (briefLocked && touchesBrief) {
      throw orchestrationError(
        409,
        'the mission brief can only be edited while the mission is a draft — the orchestrator has already ' +
          'been briefed. Add direction through the mission room instead, or cancel and create a new mission.',
      );
    }

    if (patch.title !== undefined) {
      const t = String(patch.title).trim();
      if (!t) throw orchestrationError(400, 'title cannot be empty');
      mission.title = t;
    }
    if (patch.objective !== undefined) {
      const o = String(patch.objective).trim();
      if (!o) throw orchestrationError(400, 'objective cannot be empty');
      mission.objective = o;
    }
    if (patch.context !== undefined) mission.context = String(patch.context).trim();
    if (patch.acceptance_criteria !== undefined) mission.acceptance_criteria = String(patch.acceptance_criteria).trim();
    if (patch.method !== undefined) mission.method = String(patch.method).trim();
    if (patch.completion_criteria !== undefined) {
      const result = normalizeCompletionCriteria(patch.completion_criteria);
      if ('error' in result) throw orchestrationError(400, result.error);
      mission.completion_criteria = result.criteria.length ? result.criteria : null;
    }
    if (patch.post_actions !== undefined) {
      const result = normalizePostActions(patch.post_actions);
      if ('error' in result) throw orchestrationError(400, result.error);
      mission.post_actions = result.postActions.length ? result.postActions : null;
      mission.post_actions_pending = result.postActions.length > 0;
    }
    if (patch.workspace_folder !== undefined) mission.workspace_folder = normalizeWorkspaceFolder(patch.workspace_folder);
    if (patch.repo_ref !== undefined) mission.repo_ref = normalizeRepoRef(patch.repo_ref);
    if (patch.checkout_mode !== undefined) mission.checkout_mode = normalizeCheckoutMode(patch.checkout_mode);
    if (patch.max_parallel_steps !== undefined) {
      mission.max_parallel_steps = clampInt(patch.max_parallel_steps, mission.max_parallel_steps, 1, MAX_PARALLEL_CEILING);
    }
    if (patch.max_steps !== undefined) {
      mission.max_steps = clampInt(patch.max_steps, mission.max_steps, 1, MAX_STEPS_CEILING);
    }
    if (patch.max_plan_versions !== undefined) {
      mission.max_plan_versions = clampInt(patch.max_plan_versions, mission.max_plan_versions, 1, 50);
    }
    if (patch.graph_enabled !== undefined) mission.graph_enabled = patch.graph_enabled === true;
    if (patch.confirm_policy !== undefined) mission.confirm_policy = normalizeConfirmPolicy(patch.confirm_policy);
    if (patch.user_chat_mode !== undefined) mission.user_chat_mode = normalizeUserChatMode(patch.user_chat_mode);
    if (patch.step_timeout_minutes !== undefined) {
      mission.step_timeout_minutes = clampInt(patch.step_timeout_minutes, mission.step_timeout_minutes, 0, 60 * 24 * 7);
    }

    // 미션 저장과 파생 캐시(방 플래그) 갱신을 **한 트랜잭션**으로 묶는다
    // (티켓 9cfd8161 리뷰 지적 3). 예전에는 미션을 먼저 커밋하고 방을 따로 갱신해서,
    // 두 번째 쓰기가 실패하면 호출자는 실패 응답을 받는데 `user_chat_mode` 만 바뀐 채
    // 남았다 — 옵션과 방 플래그가 갈린 상태로 영속되고, 되돌릴 신호도 없다.
    // "옵션을 바꾸면 즉시 반영된다"는 계약은 둘이 함께 성립하거나 함께 실패해야 한다.
    await this.dataSource.transaction(async (em) => {
      await em.save(OrchestrationMission, mission);
      await this.syncMissionRoomOpenJoin(em, mission);
    });
    // SSE 는 커밋 **뒤**에 낸다 — 트랜잭션 안에서 내면 롤백된 변경을 알리는 프레임이 나간다.
    this.emitUpdate(mission);
    return mission;
  }

  /**
   * 미션의 `user_chat_mode` 를 그 미션 방의 `ChatRoom.open_join` 에 반영한다(티켓 9cfd8161).
   *
   * 발화 가부의 **판정 자체는 이 플래그에 의존하지 않는다** — 게이트는 미션 컬럼을 직접
   * 읽는다. 그런데도 방 플래그를 맞추는 이유는 채팅 레이어의 다른 표면들이 이 플래그를
   * 보기 때문이다(관전 없이 읽기를 허용하는 `_isOpenJoinReadable`, 첫 발화 시 auto-join).
   * 맞춰 두지 않으면 발화는 되는데 읽기는 관전으로 떨어지는 식으로 표면끼리 어긋난다.
   *
   * 방 저장소를 주입받지 않고 호출자의 `EntityManager` 로만 접근한다 — 주입된 저장소를 쓰면
   * 그 쓰기가 트랜잭션 **밖**에서 일어나 함께 롤백되지 않는다. 원자성이 이 메서드의 존재
   * 이유이므로, 틀리게 쓸 수 있는 경로를 아예 두지 않고 seam 을 인자로 강제한다.
   *
   * 아직 시작되지 않은(방이 없는) 미션은 조용히 넘어간다 — `startMission` 이 방을 만들 때
   * 같은 `openJoinForUserChatMode` 로 초기값을 계산하므로 여기서 미리 할 일이 없다.
   * 값이 이미 같으면 쓰지 않는다(재호출 무해).
   */
  private async syncMissionRoomOpenJoin(em: EntityManager, mission: OrchestrationMission): Promise<void> {
    if (!mission.room_id) return;
    const desired = openJoinForUserChatMode(normalizeUserChatMode(mission.user_chat_mode));
    const room = await em.getRepository(ChatRoom).findOne({ where: { id: mission.room_id } });
    if (!room || room.open_join === desired) return;
    await em.update(ChatRoom, room.id, { open_join: desired });
  }

  async deleteMission(missionId: string, workspaceId: string): Promise<void> {
    const mission = await this.requireMission(missionId, workspaceId);
    if (!(TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status) && mission.status !== 'draft') {
      throw orchestrationError(409, `mission is ${mission.status} — cancel it before deleting`);
    }
    await this.stepRepo.delete({ mission_id: mission.id });
    await this.eventRepo.delete({ mission_id: mission.id });
    await this.missionRepo.delete({ id: mission.id });
    this.emitDeleted(mission);
    this.logService.info('Orchestration', `mission deleted ${mission.id}`, { workspace_id: workspaceId });
  }

  // ── Projections ───────────────────────────────────────────────────────────

  async listMissions(
    workspaceId: string,
    opts?: { teamId?: string; status?: string; limit?: number },
  ): Promise<MissionListItem[]> {
    if (!workspaceId) throw orchestrationError(400, 'workspace_id is required');
    const where: any = { workspace_id: workspaceId };
    if (opts?.teamId) where.team_id = opts.teamId;
    if (opts?.status === 'active') where.status = Not(In(TERMINAL_MISSION_STATUSES as unknown as string[]));
    else if (opts?.status) where.status = opts.status;

    const missions = await this.missionRepo.find({
      where,
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(opts?.limit ?? 100, 1), 500),
    });
    return this.projectMissionList(missions);
  }

  /**
   * Missions an agent belongs to, as orchestrator or team member — the
   * agent-scoped counterpart to `listMissions` (workspace-scoped, human/REST
   * use). No workspace_id input, same rationale as `listTeamsForAgent`: the
   * caller may be a workspace-less manager identity. Defaults to non-terminal
   * missions only (an orchestrator recovering a lost mission_id cares about
   * what's still open); pass status to widen it.
   */
  async listMissionsForAgent(
    agentId: string,
    opts?: { status?: string; limit?: number },
  ): Promise<MissionListItem[]> {
    if (!agentId) return [];
    const teamIds = await this.teamIdsForAgent(agentId);
    if (teamIds.length === 0) return [];

    // 'all' (list_orchestration_missions' include_finished:true) means no status
    // filter at all; anything else (including omitted, the default) means
    // non-terminal only. Deliberately NOT `opts?.status ?? 'active'` — that
    // collapses "caller wants everything" and "caller wants the default" onto
    // the same undefined value and silently drops the include_finished case.
    const where: any = { team_id: In(teamIds) };
    if (opts?.status === 'all') {
      // no status filter
    } else if (opts?.status && opts.status !== 'active') {
      where.status = opts.status;
    } else {
      where.status = Not(In(TERMINAL_MISSION_STATUSES as unknown as string[]));
    }

    const missions = await this.missionRepo.find({
      where,
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(opts?.limit ?? 100, 1), 500),
    });
    return this.projectMissionList(missions);
  }

  /** team_ids where `agentId` is the orchestrator or a roster member. */
  private async teamIdsForAgent(agentId: string): Promise<string[]> {
    const [orchTeams, memberRows] = await Promise.all([
      this.teamRepo.find({ where: { orchestrator_agent_id: agentId }, select: ['id'] }),
      this.memberRepo.find({ where: { agent_id: agentId }, select: ['team_id'] }),
    ]);
    return Array.from(new Set<string>([...orchTeams.map((t) => t.id), ...memberRows.map((m) => m.team_id)]));
  }

  private async projectMissionList(missions: OrchestrationMission[]): Promise<MissionListItem[]> {
    if (missions.length === 0) return [];

    const steps = await this.stepRepo.find({
      where: { mission_id: In(missions.map((m) => m.id)) },
      select: ['id', 'mission_id', 'status'],
    });
    const teams = await this.teamRepo.find({ where: { id: In(missions.map((m) => m.team_id)) } });
    const teamById = new Map(teams.map((t) => [t.id, t]));
    const orchIds = missions.map((m) => m.orchestrator_agent_id).filter((v): v is string => !!v);
    const agents = orchIds.length ? await this.agentRepo.find({ where: { id: In(orchIds) } }) : [];
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const displayById = await resolveAgentDisplayMap(this.agentRepo, agents);

    return missions.map((m) => ({
      id: m.id,
      workspace_id: m.workspace_id,
      team_id: m.team_id,
      team_name: teamById.get(m.team_id)?.name ?? '(deleted team)',
      title: m.title,
      status: m.status,
      orchestrator_agent_id: m.orchestrator_agent_id,
      orchestrator_name: m.orchestrator_agent_id ? displayById.get(m.orchestrator_agent_id) ?? '' : '',
      plan_version: m.plan_version,
      counts: countSteps(steps.filter((s) => s.mission_id === m.id)),
      started_at: m.started_at,
      finished_at: m.finished_at,
      created_at: m.created_at,
      updated_at: m.updated_at,
    }));
  }

  async getMissionDetail(missionId: string, workspaceId: string, eventLimit = 200): Promise<MissionDetail> {
    const mission = await this.requireMission(missionId, workspaceId);
    const steps = await this.listSteps(mission.id);
    const team = await this.teamRepo.findOne({ where: { id: mission.team_id } });

    const agentIds = new Set<string>();
    if (mission.orchestrator_agent_id) agentIds.add(mission.orchestrator_agent_id);
    for (const s of steps) if (s.assignee_agent_id) agentIds.add(s.assignee_agent_id);
    const agents = agentIds.size ? await this.agentRepo.find({ where: { id: In(Array.from(agentIds)) } }) : [];
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const displayById = await resolveAgentDisplayMap(this.agentRepo, agents);

    const events = await this.eventRepo.find({
      where: { mission_id: mission.id },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(eventLimit, 1), 1000),
    });
    const stepKeyById = new Map(steps.map((s) => [s.id, s.step_key]));

    return {
      id: mission.id,
      workspace_id: mission.workspace_id,
      team_id: mission.team_id,
      team_name: team?.name ?? '(deleted team)',
      title: mission.title,
      status: mission.status,
      orchestrator_agent_id: mission.orchestrator_agent_id,
      orchestrator_name: mission.orchestrator_agent_id
        ? displayById.get(mission.orchestrator_agent_id) ?? ''
        : '',
      plan_version: mission.plan_version,
      counts: countSteps(steps),
      started_at: mission.started_at,
      finished_at: mission.finished_at,
      created_at: mission.created_at,
      updated_at: mission.updated_at,
      objective: mission.objective,
      context: mission.context,
      acceptance_criteria: mission.acceptance_criteria,
      method: mission.method,
      completion_criteria: Array.isArray(mission.completion_criteria) ? mission.completion_criteria : [],
      post_actions: Array.isArray(mission.post_actions) ? mission.post_actions : [],
      resolved_workspace_folder: resolveWorkspaceFolder(mission.workspace_folder, 'orchestration', mission.id),
      workspace_folder: mission.workspace_folder,
      repo_ref: mission.repo_ref,
      checkout_mode: mission.checkout_mode,
      plan_summary: mission.plan_summary,
      result_summary: mission.result_summary,
      failure_reason: mission.failure_reason,
      room_id: mission.room_id,
      max_parallel_steps: mission.max_parallel_steps,
      max_steps: mission.max_steps,
      max_plan_versions: mission.max_plan_versions,
      step_timeout_minutes: mission.step_timeout_minutes,
      created_by_type: mission.created_by_type,
      created_by: mission.created_by,
      graph_enabled: !!mission.graph_enabled,
      graph_spec: mission.graph_spec ?? null,
      graph_revision: mission.graph_revision ?? 0,
      total_visits: mission.total_visits ?? 0,
      // 읽기는 항상 정규화를 거친다 — DDL 마이그레이션 없이 추가된 컬럼이라 기존 행이
      // 빈 문자열/NULL 로 남아 있을 수 있고, 그 값이 그대로 UI 셀렉트에 들어가면 어느
      // 옵션에도 걸리지 않는 "선택 없음" 상태가 된다.
      confirm_policy: normalizeConfirmPolicy(mission.confirm_policy),
      user_chat_mode: normalizeUserChatMode(mission.user_chat_mode),
      steps: steps.map((s) => {
        const a = s.assignee_agent_id ? agentById.get(s.assignee_agent_id) ?? null : null;
        return {
          id: s.id,
          step_key: s.step_key,
          title: s.title,
          instructions: s.instructions,
          acceptance_criteria: s.acceptance_criteria,
          depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
          assignee_agent_id: s.assignee_agent_id,
          assignee_name: a ? displayById.get(a.id) ?? a.name : (s.assignee_agent_id ? '(deleted agent)' : ''),
          assignee_online: !!a?.is_online,
          status: s.status,
          position: s.position,
          plan_version: s.plan_version,
          room_id: s.room_id,
          result_summary: s.result_summary,
          artifacts: Array.isArray(s.artifacts) ? s.artifacts : [],
          attempt: s.attempt,
          max_attempts: s.max_attempts,
          dispatched_at: s.dispatched_at,
          started_at: s.started_at,
          finished_at: s.finished_at,
          workspace_folder: `${resolveWorkspaceFolder(mission.workspace_folder, 'orchestration', mission.id)}/${s.step_key}`,
          visit: s.visit ?? 0,
          verdict: s.verdict ?? '',
          retry_policy: s.retry_policy || 'auto',
          recovery_reason: s.recovery_reason || '',
          last_heartbeat_at: s.last_heartbeat_at ?? null,
          confirm_decision: s.confirm_decision ?? null,
        };
      }),
      // Oldest-first for rendering; the DESC + take above is only there so the
      // limit keeps the RECENT tail rather than the first N events of a long run.
      events: events.reverse().map((e) => ({
        id: e.id,
        type: e.type,
        step_id: e.step_id,
        step_key: e.step_id ? stepKeyById.get(e.step_id) ?? '' : '',
        actor_type: e.actor_type,
        actor_id: e.actor_id,
        actor_name: e.actor_name,
        message: e.message,
        data: e.data,
        created_at: e.created_at,
        // 커서의 타이브레이커 — 이 값이 없으면 클라이언트가 첫 페이지 끝에서
        // 이어받을 정확한 지점을 만들 수 없다.
        write_seq: e.write_seq ?? 0,
      })),
    };
  }

  /**
   * The compact state block handed to the orchestrator by
   * `get_orchestration_mission`. Deliberately not the same shape as the UI
   * detail view: the orchestrator needs dependency edges and per-step results,
   * not room ids or timestamps it cannot act on, and every extra field is
   * context budget spent on something it will not use.
   */
  async getMissionForOrchestrator(missionId: string): Promise<Record<string, any>> {
    const mission = await this.requireMission(missionId);
    const steps = await this.listSteps(mission.id);
    const progress = computeMissionProgress(mission.graph_spec, steps);
    const agentIds = Array.from(new Set(steps.map((s) => s.assignee_agent_id).filter((v): v is string => !!v)));
    const agents = agentIds.length ? await this.agentRepo.find({ where: { id: In(agentIds) } }) : [];
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const displayById = await resolveAgentDisplayMap(this.agentRepo, agents);

    const events = await this.eventRepo.find({
      where: { mission_id: mission.id },
      order: { created_at: 'DESC' },
      take: 40,
    });

    return {
      mission_id: mission.id,
      title: mission.title,
      status: mission.status,
      objective: mission.objective,
      context: mission.context,
      acceptance_criteria: mission.acceptance_criteria,
      method: mission.method,
      completion_criteria: Array.isArray(mission.completion_criteria) ? mission.completion_criteria : [],
      completion_criteria_note: Array.isArray(mission.completion_criteria) && mission.completion_criteria.length
        ? 'complete_orchestration_mission(status:"completed") is BLOCKED until every entry here has met:true — use update_orchestration_criteria to flip one.'
        : 'No structured completion criteria defined — acceptance_criteria (prose) is the only definition of done.',
      post_actions: Array.isArray(mission.post_actions) ? mission.post_actions : [],
      plan_version: mission.plan_version,
      plan_summary: mission.plan_summary,
      limits: {
        max_steps: mission.max_steps,
        max_parallel_steps: mission.max_parallel_steps,
        max_plan_versions: mission.max_plan_versions,
        plan_versions_used: mission.plan_version,
        steps_used: steps.length,
      },
      counts: countSteps(steps),
      dispatchable_now: progress.dispatchable,
      waiting_on_dependencies: progress.waiting,
      confirm_policy: normalizeConfirmPolicy(mission.confirm_policy),
      graph: mission.graph_enabled
        ? {
            enabled: true,
            spec: mission.graph_spec ?? null,
            revision: mission.graph_revision ?? 0,
            confirm_policy: normalizeConfirmPolicy(mission.confirm_policy),
            confirm_note: renderConfirmPolicyGuidance(mission.confirm_policy),
            budget: {
              total_visits: mission.total_visits ?? 0,
              max_total_visits: mission.graph_spec?.max_total_visits ?? null,
            },
            note:
              'This mission executes a graph, not a flat dependency list. Edges can be conditional, and a ' +
              'loop_back edge sends work back for another pass when its condition matches. Steps whose node ' +
              'is an evaluator/router MUST report a verdict — that verdict is what selects the branch. ' +
              'To change part of this graph while it runs — open a branch, retarget a dependency, raise a ' +
              'loop cap, or stop a runaway loop — use patch_orchestration_graph rather than resubmitting the ' +
              'whole plan; a patch preserves execution history and does not spend a plan version.',
          }
        : { enabled: false },
      steps: steps.map((s) => ({
        step_id: s.id,
        step_key: s.step_key,
        title: s.title,
        status: s.status,
        depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
        assignee_agent_id: s.assignee_agent_id,
        assignee_name: s.assignee_agent_id ? displayById.get(s.assignee_agent_id) ?? '' : '',
        attempt: s.attempt,
        max_attempts: s.max_attempts,
        visit: s.visit ?? 0,
        verdict: s.verdict ?? '',
        retry_policy: s.retry_policy || 'auto',
        recovery_reason: s.recovery_reason || '',
        result_summary: s.result_summary,
        artifacts: Array.isArray(s.artifacts) ? s.artifacts : [],
        confirm_decision: s.confirm_decision ?? null,
      })),
      recent_timeline: events
        .reverse()
        .map((e) => ({ at: e.created_at, type: e.type, actor: e.actor_name, message: e.message })),
    };
  }

  // ── Timeline + live updates ───────────────────────────────────────────────

  /**
   * Append a timeline row AND push the matching live update. Always use this —
   * a bare `eventRepo.save` leaves the mission board stale until a refetch.
   */
  async recordEvent(
    mission: OrchestrationMission,
    input: {
      type: string;
      message: string;
      step_id?: string | null;
      step_key?: string;
      actor_type?: string;
      actor_id?: string;
      actor_name?: string;
      data?: Record<string, any> | null;
    },
  ): Promise<void> {
    // Choke point for agent identity in the mission timeline: whatever name the
    // caller passed (MCP `agentName`, a bare `agent.name`, or nothing at all) is
    // replaced by the canonical `<Manager>/<Agent>` display. Doing it here means
    // no recordEvent call site can ever regress the format — see
    // utils/agent-name.ts and .claude/skills/awb-agent-display-name.
    let actorName = input.actor_name || '';
    if (input.actor_type === 'agent' && input.actor_id) {
      actorName = (await resolveAgentDisplayName(this.agentRepo, input.actor_id)) || actorName;
    }
    try {
      await this.eventRepo.save(
        this.eventRepo.create({
          mission_id: mission.id,
          workspace_id: mission.workspace_id,
          step_id: input.step_id ?? null,
          type: input.type,
          actor_type: input.actor_type || 'system',
          actor_id: input.actor_id || '',
          actor_name: actorName,
          message: (input.message || '').slice(0, 4000),
          data: input.data ?? null,
          write_seq: await this.nextEventWriteSeq(mission.id),
        }),
      );
    } catch (e: any) {
      // A timeline write must never take down a dispatch — losing one audit row
      // is strictly better than stranding a step because the log table hiccuped.
      this.logService.error('Orchestration', `failed to record event for mission ${mission.id}: ${e?.message || e}`);
    }
    this.emitUpdate(mission, { type: input.type, message: input.message, step_key: input.step_key || '' });
  }

  /**
   * 미션 타임라인의 **커서 페이지네이션**(티켓 4d065f82, 리뷰 라운드1 P1-3).
   *
   * `getMissionDetail` 은 최신 N건만 실어주는 bounded window 라, 긴 미션의 이전 이력은
   * 어떤 API 로도 가져올 수 없었다. 이 메서드가 그 창을 뒤로 밀 수 있게 한다.
   *
   * 커서는 `(created_at, write_seq)` 복합 keyset 이다. `created_at` 단독으로는 안 된다 —
   * fan-out 한 번이면 수십 건이 같은 타임스탬프를 갖고, 그러면 `created_at < cursor` 는
   * 그 그룹을 통째로 건너뛰고 `<=` 는 무한히 되돌린다. 표준 keyset 술어로 전순서를 만든다.
   *
   * 최신 → 과거 순(DESC)으로 돌려준다. 호출자가 화면에 붙일 때 뒤집는다.
   */
  async listMissionEvents(
    missionId: string,
    workspaceId: string,
    opts?: { limit?: number; before_at?: string; before_seq?: number },
  ): Promise<{ events: OrchestrationEvent[]; has_more: boolean; next_cursor: { at: string; seq: number } | null }> {
    const mission = await this.requireMission(missionId);
    if (workspaceId && mission.workspace_id !== workspaceId) {
      throw orchestrationError(404, 'mission not found in this workspace');
    }
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);

    const qb = this.eventRepo
      .createQueryBuilder('e')
      .where('e.mission_id = :missionId', { missionId })
      .orderBy('e.created_at', 'DESC')
      .addOrderBy('e.write_seq', 'DESC')
      // 한 건 더 읽어 has_more 를 별도 COUNT 없이 판정한다.
      .take(limit + 1);

    if (opts?.before_at) {
      const beforeSeq = Number.isFinite(Number(opts.before_seq)) ? Number(opts.before_seq) : 0;
      qb.andWhere(
        '(e.created_at < :beforeAt OR (e.created_at = :beforeAtEq AND e.write_seq < :beforeSeq))',
        {
          beforeAt: sinceBoundaryParam(this.dataSource, new Date(opts.before_at)),
          beforeAtEq: sinceBoundaryParam(this.dataSource, new Date(opts.before_at)),
          beforeSeq,
        },
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      events: page,
      has_more: hasMore,
      next_cursor: last ? { at: new Date(last.created_at).toISOString(), seq: last.write_seq ?? 0 } : null,
    };
  }

  /**
   * 다음 이벤트의 `write_seq` 를 **DB 상태에서** 유도한다(티켓 4d065f82).
   *
   * comment-tools.ts 의 `_comment_write_seq` 와 같은 tied-group 기법이다: 이 미션의
   * 가장 최근 `created_at` 을 찾고, 그와 **정확히 같은** created_at 을 가진 row 를
   * LIMIT 없이 전부 가져와 그 안의 최댓값 + 1 을 쓴다. 같은 타임스탬프에 몇 건이 몰리든
   * 개수와 무관하게 전량을 보므로 burst 크기에 영향받지 않고, 프로세스 메모리에
   * 의존하지 않으므로 재시작에도 리셋되지 않는다.
   *
   * 이 값이 필요한 이유는 커서 페이지네이션이다 — `created_at` 만으로는 fan-out 한 번에
   * 수십 건이 같은 타임스탬프를 갖는 이 테이블에서 페이지 경계가 이벤트를 건너뛴다.
   */
  private async nextEventWriteSeq(missionId: string): Promise<number> {
    try {
      const mostRecent = await this.eventRepo.findOne({
        where: { mission_id: missionId },
        order: { created_at: 'DESC' },
      });
      if (!mostRecent) return 1;
      const tied = await this.eventRepo
        .createQueryBuilder('e')
        .where('e.mission_id = :missionId', { missionId })
        .andWhere('e.created_at = :tiedAt', {
          tiedAt: sinceBoundaryParam(this.dataSource, mostRecent.created_at),
        })
        .getMany();
      let max = 0;
      for (const e of tied) if ((e.write_seq ?? 0) > max) max = e.write_seq ?? 0;
      return max + 1;
    } catch {
      // seq 유도 실패가 타임라인 기록 자체를 막으면 안 된다 — 0 은 "순서 미상"이고
      // 커서는 created_at 으로만 비교하게 되어 예전 동작으로 우아하게 후퇴한다.
      return 0;
    }
  }

  /**
   * Push an `orchestration_update` SSE frame.
   *
   * UI fuel only (the event-registry filter restricts it to `user` subscribers),
   * exactly like `consensus_update` — agents learn about mission state through
   * their MCP tools and their room messages, never through this stream, so this
   * event type is outside the agent-manager SSE contract.
   */
  emitUpdate(
    mission: OrchestrationMission,
    lastEvent?: { type: string; message: string; step_key: string },
  ): void {
    // Counts are read fresh rather than threaded through every caller: the
    // frame is a "something changed, here is the headline" nudge and the client
    // refetches the detail view for anything it renders in depth.
    this.stepRepo
      .find({ where: { mission_id: mission.id }, select: ['id', 'mission_id', 'status'] })
      .then((steps) => {
        activityEvents.emit('orchestration_update', {
          mission_id: mission.id,
          workspace_id: mission.workspace_id,
          team_id: mission.team_id,
          title: mission.title,
          status: mission.status,
          plan_version: mission.plan_version,
          counts: countSteps(steps),
          last_event: lastEvent ?? null,
          timestamp: new Date().toISOString(),
        });
      })
      .catch(() => {
        /* live nudge is best-effort; the client polls the detail view anyway */
      });
  }

  /**
   * Push the `deleted` variant of the same frame (티켓 03ca8b5b).
   *
   * 미션 목록을 그리는 화면(사이드바 WORK > Orchestrations, 미션 목록 페이지)은
   * 삭제를 알 방법이 이 프레임밖에 없다 — 삭제는 REST
   * `DELETE /api/orchestration/missions/:id` 로만 일어나므로 페이지가 쏘는
   * 브라우저 내 커스텀 이벤트로는 다른 탭·다른 클라이언트의 삭제를 절대 못 본다.
   * 신호가 없으면 사라진 미션이 목록에 남고 클릭 시 없는 상세로 이동한다.
   *
   * emitUpdate 와 달리 step 재조회 없이 동기적으로 쏜다: 스텝은 방금 다 지워져
   * 세어봐야 0 이고, 삭제 통지가 best-effort 비동기 조회 실패에 묻히면 목록이
   * 영구히 stale 해지기 때문이다.
   */
  private emitDeleted(mission: OrchestrationMission): void {
    activityEvents.emit('orchestration_update', {
      mission_id: mission.id,
      workspace_id: mission.workspace_id,
      team_id: mission.team_id,
      title: mission.title,
      status: mission.status,
      plan_version: mission.plan_version,
      counts: { total: 0, done: 0, failed: 0, inFlight: 0, pending: 0 },
      last_event: null,
      deleted: true,
      timestamp: new Date().toISOString(),
    });
  }
}

export function countSteps(steps: Array<{ status: string }>): MissionCounts {
  const counts: MissionCounts = { total: steps.length, done: 0, failed: 0, inFlight: 0, pending: 0, awaitingUser: 0 };
  for (const s of steps) {
    if (s.status === 'done' || s.status === 'skipped') counts.done += 1;
    else if (s.status === 'failed' || s.status === 'blocked' || s.status === 'cancelled') counts.failed += 1;
    else if (isInFlight(s.status)) counts.inFlight += 1;
    // `pending` 앞에 둔다 — awaiting_user 는 terminal 이 아니라서 그냥 두면 아래
    // pending 으로 흡수되고, 운영자 화면에서 "당신의 답 대기 중"이 "아직 시작 안 함"과
    // 구분되지 않는다(티켓 5dbe4aa2).
    else if (isAwaitingUser(s.status)) counts.awaitingUser += 1;
    else if (!isTerminalStepStatus(s.status)) counts.pending += 1;
  }
  return counts;
}

function clampInt(value: any, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
