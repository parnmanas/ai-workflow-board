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
import { Brackets, DataSource, EntityManager, Repository, In, Not } from 'typeorm';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { OrchestrationStep } from '../../entities/OrchestrationStep';
import { OrchestrationEvent } from '../../entities/OrchestrationEvent';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { Agent } from '../../entities/Agent';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { resolveAgentDisplayMap, resolveAgentDisplayName } from '../../utils/agent-name';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { orchestrationError } from './orchestration-errors';
import { GraphSpec, computeMissionProgress } from './orchestration-graph';
import { renderConfirmPolicyGuidance } from './orchestration-prompt';
import { enforceRunBudget } from '../../common/run-budget-guard';
import { sinceBoundaryParam, tiedCreatedAtOrderExpr, tiedCreatedAtWhere } from '../../common/created-at-since-param';
import { lockMissionEventWrites } from '../../common/orchestration-event-write-lock';
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
  /**
   * 지금 진행 중인 step 들의 요약 — 목록 카드가 "몇 개가 돌고 있나"를 넘어 **무엇이**
   * 돌고 있고 **마지막 신호가 언제인지**까지 말할 수 있게 한다. 여기에는 CLI 활동
   * 텍스트가 없다(목록에서 미션마다 방을 훑지 않는다 — 그건 상세 화면의 몫이다);
   * step 행에 이미 있는 값만 쓰므로 추가 쿼리가 없다.
   */
  live_steps: MissionLiveStep[];
}

/** 목록 카드용 진행 중 step 한 줄. `last_signal_at` 은 heartbeat → 시작 → 디스패치 순의 첫 값. */
export interface MissionLiveStep {
  id: string;
  step_key: string;
  title: string;
  status: string;
  last_signal_at: Date | null;
}

/**
 * "지금 실제로 무슨 작업을 하고 있나" — 카드 한 줄짜리 활동 신호.
 *
 * step 의 `status` 만으로는 **일하고 있는 것**과 **떠서 즉시 죽은 것**을 구분할 수
 * 없다. 2026-09-25 EmberDelve 사건에서 Windows 의 opencode 멤버는 디스패치마다 0초
 * 만에 죽었는데도 카드는 100분 동안 `dispatched` 로 보였고, 화면에는 그 차이가 아예
 * 존재하지 않았다. 운영자가 리퍼를 기다리지 않고 알아차릴 수 있어야 한다.
 *
 * 출처는 둘이고 **최신 것이 이긴다**:
 *   - `cli`   — 매니저가 step 방에 중계하는 CLI 툴 하트비트(`chat_room_messages.type
 *               = 'progress'`). 몇 초 단위로 "무슨 명령/파일/툴을 건드렸는지"가 남는
 *               가장 촘촘한 신호이고, 에이전트가 한 번도 보고하지 않아도 찍힌다.
 *   - `agent` — 에이전트 자신의 `report_orchestration_progress` 요약(step_progress /
 *               step_checkpoint 이벤트). 드물지만 사람이 읽기에 가장 정확하다.
 */
export interface StepActivity {
  at: Date;
  source: 'cli' | 'agent';
  text: string;
}

/** 카드/목록에 실을 활동 텍스트 상한. 한 줄로 읽히는 길이를 넘으면 잘라 낸다. */
const ACTIVITY_TEXT_MAX = 240;

/**
 * 매니저가 만든 진행 하트비트를 평문으로 되돌린다.
 *
 * 형식 계약은 `SubagentManager#formatChatProgressLine` 에 있다: 줄 전체를 `_..._` 로
 * 감싸고, 안쪽의 `` ` `` · `_` · `*` 는 백슬래시로 이스케이프해 이탤릭 wrapper 가
 * 깨지지 않게 한다. 카드에는 마크다운을 렌더하지 않으므로 그 두 겹을 벗긴다 — 벗기지
 * 않으면 운영자가 `$env:GIT\_TERMINAL\_PROMPT` 같은 문자열을 읽게 된다.
 */
export function plainProgressText(content: string): string {
  let out = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (out.length >= 2 && out.startsWith('_') && out.endsWith('_')) out = out.slice(1, -1).trim();
  out = out.replace(/\\([`_*])/g, '$1');
  return out.length > ACTIVITY_TEXT_MAX ? `${out.slice(0, ACTIVITY_TEXT_MAX - 1)}\u2026` : out;
}

/**
 * step 작업 세션의 한 줄. `kind` 가 렌더링을 가른다:
 *
 *   - `system`   — AWB 가 그 방에 넣은 지시/요청(work order, lease 재연결 요청).
 *                  본문이 마크다운 heading 으로 시작하므로 UI 가 접어서 제목만 보인다.
 *   - `agent`    — 담당 agent 가 방에 남긴 메시지(보고·질문).
 *   - `progress` — 매니저가 중계한 CLI 툴 하트비트. 이미 평문으로 변환돼 있다.
 *   - `user`     — 사람이 남긴 줄. 정상 경로에는 없다(step 방에는 쓰기 입구가 없다).
 *                  과거 데이터/수동 개입으로 존재할 수 있어 버리지 않고 표시한다.
 */
export type StepSessionItemKind = 'system' | 'agent' | 'progress' | 'user';

export interface StepSessionItem {
  id: string;
  at: Date;
  kind: StepSessionItemKind;
  sender_type: string;
  sender_id: string;
  sender_name: string;
  text: string;
  /** 이 메시지에 묶인 파일들(메타만 — 바이트는 `steps/:id/attachments/:attId` 로). */
  attachments: StepAttachmentMeta[];
}

/**
 * step 방에 올라온 파일 하나의 메타. 바이트는 싣지 않는다 — 전사 한 페이지에 10MB 짜리
 * 동영상 여러 개가 base64 로 실리면 세션 패널을 여는 것만으로 수십 MB 를 내려받는다.
 * `is_media` 가 true 면 화면이 인라인(썸네일/플레이어)으로 그린다.
 */
export interface StepAttachmentMeta {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  is_media: boolean;
  uploaded_by_type: string;
  uploaded_by_id: string;
  uploaded_by: string;
  created_at: Date;
}

/**
 * 미션 증거 갤러리의 한 항목 — step 방과 미션 방에 올라온 **이미지·동영상**만.
 *
 * "검증 증거" 를 따로 저장하지 않는 이유: 담당 agent 가 자기 step 방에 스크린샷/녹화를
 * 올리는 경로(`add_chat_message_attachment` → `send_chat_room_message`)가 이미 있고,
 * 사람은 미션 대화에 첨부할 수 있다. 그 두 방의 미디어가 곧 증거다. 별도 엔티티를 만들면
 * agent 가 두 번 올리거나 하나를 빼먹는 경로가 생긴다.
 */
export interface MissionEvidenceItem {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by_type: string;
  uploaded_by_id: string;
  uploaded_by: string;
  created_at: Date;
  room_id: string;
  message_id: string;
  /** null = 미션 방(사람 또는 orchestrator 가 올린 것). */
  step_id: string | null;
  step_key: string;
  step_title: string;
}

/** 화면에 인라인으로 그릴 수 있는 종류 — 증거 갤러리와 카운트가 같은 판정을 쓴다. */
export function isEvidenceMime(mime: string | null | undefined): boolean {
  return /^(image|video)\//i.test(String(mime ?? ''));
}

/** 첨부 행 → 메타(바이트 제외). 세션 전사와 다운로드 응답이 같은 모양을 쓴다. */
function projectStepAttachment(row: TicketAttachment): StepAttachmentMeta {
  return {
    id: row.id,
    file_name: row.file_name,
    mime_type: row.file_mimetype,
    size_bytes: row.file_size,
    is_media: isEvidenceMime(row.file_mimetype),
    uploaded_by_type: row.uploaded_by_type,
    uploaded_by_id: row.uploaded_by_id,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  };
}

/** 저장된 채팅 행 하나를 세션 항목 종류로 분류한다. */
function classifyStepSessionRow(row: {
  type: string;
  sender_type: string;
  sender_id: string;
}): StepSessionItemKind {
  if (row.type === 'progress') return 'progress';
  if (row.sender_type === 'agent') return 'agent';
  // 디스패치와 리퍼 안내는 의사 user `system` 으로 들어온다(방을 만든 주체가 AWB 다).
  if (row.sender_type === 'user' && row.sender_id === 'system') return 'system';
  return 'user';
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
  /**
   * 최신 활동 한 줄. **진행 중인(in-flight) step 만** 채운다 — 종료된 step 은
   * `result_summary` 가 이미 결과를 말하고, 카드를 그릴 때마다 모든 step 의 방을 훑으면
   * 30초 폴링이 그만큼 비싸진다. 진행 중인데도 null 이면 "디스패치된 뒤 아무 신호도
   * 없다"는 뜻이고, 그것 자체가 읽어야 할 신호다.
   */
  activity: StepActivity | null;
  /** 이 step 방에 올라온 이미지·동영상 수 — 레일/카드의 증거 배지. */
  evidence_count: number;
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
  /** 미션 방(step 이 아닌)에 올라온 이미지·동영상 수. step 별 수는 각 step 에. */
  mission_evidence_count: number;
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

    // `select` 를 넓히는 대가는 컬럼 몇 개이고, 얻는 것은 목록 카드의 "무엇이 돌고
    // 있나" 한 줄이다 — 추가 쿼리는 없다. 방(progress 메시지)은 여기서 보지 않는다.
    const steps = await this.stepRepo.find({
      where: { mission_id: In(missions.map((m) => m.id)) },
      select: [
        'id',
        'mission_id',
        'status',
        'step_key',
        'title',
        'position',
        'dispatched_at',
        'started_at',
        'last_heartbeat_at',
      ],
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
      live_steps: steps
        .filter((s) => s.mission_id === m.id && isInFlight(s.status))
        .sort((a, b) => a.position - b.position)
        .map((s) => ({
          id: s.id,
          step_key: s.step_key,
          title: s.title,
          status: s.status,
          last_signal_at: s.last_heartbeat_at ?? s.started_at ?? s.dispatched_at ?? null,
        })),
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
    // events 는 여기서 아직 DESC(최신 우선)다 — 아래 응답 조립에서 reverse() 되므로
    // 활동 스캔은 반드시 그 전에 끝내야 한다.
    const activityByStepId = await this.loadLiveStepActivity(steps, events);
    const evidenceByRoom = await this.loadEvidenceCounts([
      ...steps.map((s) => s.room_id),
      mission.room_id,
    ]);

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
      // 상세 화면은 step 카드마다 `activity` 를 따로 갖지만, 이 요약은 `MissionDetail`
      // 이 `MissionListItem` 을 확장하는 계약을 지키는 값이다 — 목록에서 상세로 들어온
      // 화면이 같은 필드를 읽어도 비어 있지 않아야 한다.
      live_steps: steps
        .filter((s) => isInFlight(s.status))
        .sort((a, b) => a.position - b.position)
        .map((s) => ({
          id: s.id,
          step_key: s.step_key,
          title: s.title,
          status: s.status,
          last_signal_at: s.last_heartbeat_at ?? s.started_at ?? s.dispatched_at ?? null,
        })),
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
          activity: activityByStepId.get(s.id) ?? null,
          evidence_count: s.room_id ? evidenceByRoom.get(s.room_id) ?? 0 : 0,
        };
      }),
      mission_evidence_count: mission.room_id ? evidenceByRoom.get(mission.room_id) ?? 0 : 0,
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
   * 진행 중인 step 들의 최신 활동 한 줄씩.
   *
   * **in-flight 만 본다.** 종료된 step 의 "무엇을 하고 있었나"는 상세 모달의
   * `listStepActivity` 가 요청받을 때만 읽는다 — 카드 목록은 30초마다 새로 그려지므로
   * 여기서 모든 step 의 방을 훑으면 폴링 비용이 step 수에 비례해 늘어난다. 동시 실행은
   * `max_parallel_steps`(기본 3, 상한 MAX_PARALLEL_CEILING) 로 묶여 있으므로 방 조회
   * 수도 그만큼이고, `chat_room_messages` 에는 (room_id, type, created_at) 인덱스가
   * 있어 각 조회가 단일 행 역방향 탐색이다.
   *
   * agent 쪽 신호는 **이미 로드된 이벤트 창**에서 스캔해 쿼리를 쓰지 않는다. 창 밖으로
   * 밀려난 진행 보고는 정의상 오래된 것이고, 그 경우에도 CLI 신호와
   * `last_heartbeat_at` 이 카드에 남는다.
   *
   * 전 구간이 best-effort 다 — 이 값은 읽기 전용 장식이므로, 채팅 테이블 쪽 문제가
   * 미션 화면 전체를 깨뜨리면 안 된다.
   *
   * @param events `created_at` DESC 로 정렬된 이벤트 창(최신 우선).
   */
  private async loadLiveStepActivity(
    steps: OrchestrationStep[],
    events: OrchestrationEvent[],
  ): Promise<Map<string, StepActivity>> {
    const out = new Map<string, StepActivity>();
    const live = steps.filter((s) => isInFlight(s.status));
    if (live.length === 0) return out;

    const liveIds = new Set(live.map((s) => s.id));
    const noteByStepId = new Map<string, OrchestrationEvent>();
    for (const e of events) {
      if (!e.step_id || !liveIds.has(e.step_id) || noteByStepId.has(e.step_id)) continue;
      if (e.type !== 'step_progress' && e.type !== 'step_checkpoint') continue;
      noteByStepId.set(e.step_id, e);
    }

    const messageRepo = this.dataSource.getRepository(ChatRoomMessage);
    for (const step of live) {
      let best: StepActivity | null = null;
      const note = noteByStepId.get(step.id);
      if (note?.message) {
        best = { at: note.created_at, source: 'agent', text: plainProgressText(note.message) };
      }
      if (step.room_id) {
        try {
          const latest = await messageRepo.findOne({
            where: { room_id: step.room_id, type: 'progress' },
            order: { created_at: 'DESC' },
          });
          if (latest && (!best || latest.created_at > best.at)) {
            best = { at: latest.created_at, source: 'cli', text: plainProgressText(latest.content) };
          }
        } catch (err: any) {
          this.logService.warn(
            'Orchestration',
            `step activity lookup failed step=${step.id.slice(0, 8)}: ${err?.message ?? err}`,
          );
        }
      }
      if (best?.text) out.set(step.id, best);
    }
    return out;
  }

  /**
   * 한 step 의 **작업 세션** — 그 step 전용 방의 대화 기록.
   *
   * 미션 화면은 step 을 선택하면 오른쪽 패널에 이 기록을 그린다(선택을 풀면 미션
   * 대화로 돌아간다). 그래서 이 경로는 "이 step 이 무엇을 받아서 무엇을 했고 무엇을
   * 보고했는가" 전체이며, 카드의 최신 한 줄(`step.activity`)과는 깊이가 다르다.
   *
   * 왜 채팅 API 를 쓰지 않는가: step 방은 **사람을 참여자로 넣지 않는 설계**다(티켓
   * 995a9519 — 미션 하나가 수십 개를 만들고 사람이 낄 대화가 아니다). 그래서
   * `chat-rooms/:id/messages` 의 참여자 게이트를 그대로 적용하면 자기 미션의 작업
   * 내용을 **어느 운영자도** 못 읽는다. 읽기 입구를 orchestration 쪽에 두고 미션
   * 권한으로 게이트하는 것이 올바른 위치이고, 쓰기 입구는 만들지 않는다 — 사람이
   * step 방에 말을 걸면 그 지시는 orchestrator 의 계획 밖에서 흐른다.
   *
   * 정렬·커서는 채팅 히스토리와 **같은 관행**을 따른다: 최신순 DESC + `before_id`
   * 복합 커서(created_at, id). 같은 밀리초에 몰린 하트비트 버스트에서 페이지 경계가
   * 유실되지 않으려면 id 타이브레이커가 반드시 함께 가야 한다.
   */
  async getStepSession(
    stepId: string,
    workspaceId: string,
    opts?: { limit?: number; beforeId?: string },
  ): Promise<{
    step_id: string;
    step_key: string;
    room_id: string | null;
    items: StepSessionItem[];
    has_more: boolean;
    next_before_id: string | null;
  }> {
    const step = await this.requireStep(stepId, workspaceId);
    const take = Math.min(Math.max(opts?.limit ?? 60, 1), 200);
    const empty = {
      step_id: step.id,
      step_key: step.step_key,
      room_id: step.room_id ?? null,
      items: [] as StepSessionItem[],
      has_more: false,
      next_before_id: null,
    };
    if (!step.room_id) return empty;

    const repo = this.dataSource.getRepository(ChatRoomMessage);
    const qb = repo
      .createQueryBuilder('m')
      .where('m.room_id = :roomId', { roomId: step.room_id })
      .orderBy('m.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      // 한 건 더 읽어 "더 있음"을 판정한다 — 두 번째 count 쿼리를 아낀다.
      .limit(take + 1);
    if (opts?.beforeId) {
      const cursor = await repo.findOne({ where: { id: opts.beforeId } });
      if (cursor) {
        qb.andWhere('(m.created_at < :cursorAt OR (m.created_at = :cursorAt AND m.id < :cursorId))', {
          cursorAt: cursor.created_at,
          cursorId: cursor.id,
        });
      }
    }
    const rows = await qb.getMany();
    const has_more = rows.length > take;
    const page = has_more ? rows.slice(0, take) : rows;

    // 발신 agent 이름만 해석한다. step 방에 사람이 말하는 경로는 없으므로(위 참고)
    // user 발신은 `sender_type` 만 실어 보내고 이름 조회를 하지 않는다 — 있지도 않은
    // 경로를 위해 매 요청마다 User 조회를 붙이지 않는다.
    const agentIds = Array.from(
      new Set(page.filter((r) => r.sender_type === 'agent' && r.sender_id).map((r) => r.sender_id)),
    );
    const agents = agentIds.length ? await this.agentRepo.find({ where: { id: In(agentIds) } }) : [];
    const displayById = await resolveAgentDisplayMap(this.agentRepo, agents);

    // 페이지에 실린 메시지들의 첨부 메타(바이트 제외). 채팅 히스토리와 같은 조인이지만
    // 참여자 게이트 없이 — 이 경로 자체가 orchestration 권한으로 게이트된다.
    const attachmentsByMessage = new Map<string, StepAttachmentMeta[]>();
    if (page.length) {
      const rows = await this.dataSource.getRepository(TicketAttachment).find({
        where: { owner_type: 'chat_message', owner_id: In(page.map((r) => r.id)) },
        select: [
          'id', 'owner_id', 'file_name', 'file_mimetype', 'file_size',
          'uploaded_by_type', 'uploaded_by_id', 'uploaded_by', 'created_at',
        ],
        order: { created_at: 'ASC', id: 'ASC' },
      });
      for (const a of rows) {
        const list = attachmentsByMessage.get(a.owner_id) ?? [];
        list.push(projectStepAttachment(a));
        attachmentsByMessage.set(a.owner_id, list);
      }
    }

    const items: StepSessionItem[] = page.map((r) => ({
      id: r.id,
      at: r.created_at,
      kind: classifyStepSessionRow(r),
      sender_type: r.sender_type,
      sender_id: r.sender_id,
      sender_name: r.sender_type === 'agent' ? displayById.get(r.sender_id) ?? '' : '',
      text: r.type === 'progress' ? plainProgressText(r.content) : String(r.content ?? ''),
      attachments: attachmentsByMessage.get(r.id) ?? [],
    }));

    return {
      ...empty,
      items,
      has_more,
      next_before_id: has_more && page.length ? page[page.length - 1].id : null,
    };
  }

  /**
   * step 방 첨부 하나의 바이트 — 미션 화면의 썸네일/플레이어/다운로드가 읽는다.
   *
   * 채팅의 `chat-rooms/:room/attachments/:id` 는 참여자 게이트라 step 방에서는 어느
   * 운영자도 못 읽는다(세션 전사와 같은 이유). 여기서는 **첨부가 그 step 의 방에 속하는지**
   * 를 앵커로 잡는다 — step 을 통해 워크스페이스 경계가 강제되고, 다른 방의 첨부 id 를
   * 들이밀어도 방이 다르면 404 다. 미션 방의 첨부는 채팅 경로로 읽는다(사람이 참여자다).
   */
  async getStepAttachment(
    stepId: string,
    workspaceId: string,
    attachmentId: string,
  ): Promise<StepAttachmentMeta & { file_data: string }> {
    const step = await this.requireStep(stepId, workspaceId);
    if (!step.room_id) throw orchestrationError(404, 'attachment not found');
    const row = await this.dataSource.getRepository(TicketAttachment).findOne({
      where: { id: attachmentId, room_id: step.room_id },
    });
    if (!row || (row.owner_type !== 'chat_message' && row.owner_type !== 'chat_room')) {
      throw orchestrationError(404, 'attachment not found');
    }
    return { ...projectStepAttachment(row), file_data: row.file_data };
  }

  /**
   * 미션의 검증 증거 — 모든 step 방과 미션 방의 이미지·동영상, 최신순.
   *
   * 한 쿼리다: room_id 가 미션의 방 집합에 속하고 mime 이 image/* 또는 video/* 인 첨부.
   * `(room_id, created_at)` 인덱스를 타므로 방 수에 비례해 싸다. 상한(`limit`)을 두는 이유는
   * 갤러리 한 화면에 수백 장이 필요한 경우가 없고, 필요하면 step 세션에서 그 step 만 깊게
   * 보면 되기 때문이다.
   */
  async listMissionEvidence(
    missionId: string,
    workspaceId: string,
    limit = 200,
  ): Promise<{ mission_id: string; items: MissionEvidenceItem[] }> {
    const mission = await this.requireMission(missionId, workspaceId);
    const steps = await this.listSteps(mission.id);
    const stepByRoom = new Map<string, OrchestrationStep>();
    for (const s of steps) if (s.room_id) stepByRoom.set(s.room_id, s);
    const roomIds = [...stepByRoom.keys(), ...(mission.room_id ? [mission.room_id] : [])];
    if (roomIds.length === 0) return { mission_id: mission.id, items: [] };

    const rows = await this.dataSource
      .getRepository(TicketAttachment)
      .createQueryBuilder('a')
      .select([
        'a.id', 'a.room_id', 'a.owner_type', 'a.owner_id', 'a.file_name', 'a.file_mimetype', 'a.file_size',
        'a.uploaded_by_type', 'a.uploaded_by_id', 'a.uploaded_by', 'a.created_at',
      ])
      .where('a.room_id IN (:...roomIds)', { roomIds })
      .andWhere("a.owner_type = 'chat_message'")
      .andWhere(
        new Brackets((qb) => {
          qb.where("a.file_mimetype LIKE 'image/%'").orWhere("a.file_mimetype LIKE 'video/%'");
        }),
      )
      .orderBy('a.created_at', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .limit(Math.min(Math.max(limit, 1), 500))
      .getMany();

    // 올린 agent 의 표시 이름은 `<Manager>/<Agent>` 규약을 따른다 — 저장된 `uploaded_by` 는
    // 업로드 시점의 bare name 이라 그대로 그리면 같은 leaf 이름이 매니저마다 겹친다.
    const agentIds = Array.from(
      new Set(rows.filter((r) => r.uploaded_by_type === 'agent' && r.uploaded_by_id).map((r) => r.uploaded_by_id)),
    );
    const agents = agentIds.length ? await this.agentRepo.find({ where: { id: In(agentIds) } }) : [];
    const displayById = await resolveAgentDisplayMap(this.agentRepo, agents);

    const items: MissionEvidenceItem[] = rows.map((r) => {
      const step = stepByRoom.get(r.room_id ?? '') ?? null;
      return {
        id: r.id,
        file_name: r.file_name,
        mime_type: r.file_mimetype,
        size_bytes: r.file_size,
        uploaded_by_type: r.uploaded_by_type,
        uploaded_by_id: r.uploaded_by_id,
        uploaded_by:
          r.uploaded_by_type === 'agent' ? displayById.get(r.uploaded_by_id) ?? r.uploaded_by : r.uploaded_by,
        created_at: r.created_at,
        room_id: r.room_id ?? '',
        message_id: r.owner_id,
        step_id: step?.id ?? null,
        step_key: step?.step_key ?? '',
        step_title: step?.title ?? '',
      };
    });
    return { mission_id: mission.id, items };
  }

  /**
   * 방별 이미지·동영상 첨부 수 — 한 GROUP BY 쿼리. 레일/카드의 배지와 Evidence 탭 카운트가
   * 여기서 나온다. 미션 상세는 30초마다 다시 그려지므로 방마다 세는 대신 한 번에 센다.
   */
  private async loadEvidenceCounts(roomIds: Array<string | null | undefined>): Promise<Map<string, number>> {
    const ids = Array.from(new Set(roomIds.filter((r): r is string => !!r)));
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    try {
      const rows: Array<{ room_id: string; n: string | number }> = await this.dataSource
        .getRepository(TicketAttachment)
        .createQueryBuilder('a')
        .select('a.room_id', 'room_id')
        .addSelect('COUNT(*)', 'n')
        .where('a.room_id IN (:...ids)', { ids })
        .andWhere("a.owner_type = 'chat_message'")
        .andWhere(
          new Brackets((qb) => {
            qb.where("a.file_mimetype LIKE 'image/%'").orWhere("a.file_mimetype LIKE 'video/%'");
          }),
        )
        .groupBy('a.room_id')
        .getRawMany();
      for (const r of rows) out.set(String(r.room_id), Number(r.n) || 0);
    } catch (err: any) {
      // 장식용 카운트가 미션 화면을 깨뜨리면 안 된다 — 활동 신호와 같은 best-effort 규칙.
      this.logService.warn('Orchestration', `evidence count lookup failed: ${err?.message ?? err}`);
    }
    return out;
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
    // utils/agent-name.ts and docs/runbooks/agent-display-name.md.
    let actorName = input.actor_name || '';
    if (input.actor_type === 'agent' && input.actor_id) {
      actorName = (await resolveAgentDisplayName(this.agentRepo, input.actor_id)) || actorName;
    }
    const row = {
      mission_id: mission.id,
      workspace_id: mission.workspace_id,
      step_id: input.step_id ?? null,
      type: input.type,
      actor_type: input.actor_type || 'system',
      actor_id: input.actor_id || '',
      actor_name: actorName,
      message: (input.message || '').slice(0, 4000),
      data: input.data ?? null,
    };
    try {
      // seq 유도(읽기)와 INSERT(쓰기)는 **한 트랜잭션** 안에서, 미션 row 를 잠근 뒤에만
      // 일어나야 한다(티켓 50031353). 예전에는 둘 사이에 잠금도 트랜잭션도 없어서, 이
      // 메서드를 동시에 호출하는 경로들(runner / reaper 타이머 / confirm-notify / REST)이
      // 같은 최댓값을 읽고 **같은 write_seq 로 두 행**을 쓸 수 있었다. `(created_at,
      // write_seq)` 가 전순서라는 커서의 전제가 거기서 깨진다.
      await this.dataSource.transaction(async (em) => {
        await lockMissionEventWrites(em, mission.id);
        const repo = em.getRepository(OrchestrationEvent);
        const key = await this.nextEventOrderingKey(mission.id, em);
        await repo.save(
          repo.create({
            ...row,
            // created_at 도 잠금 안에서 정한다 — DB 기본값에 맡기면 안 된다. 아래
            // nextEventOrderingKey 주석 참고(티켓 50031353).
            ...(key.at ? { created_at: key.at } : {}),
            write_seq: key.seq,
          }),
        );
      });
    } catch (e: any) {
      // 직렬화 경로가 실패해도 타임라인 행 자체는 남긴다 — `write_seq: 0` 은 "순서 미상"
      // 이고, 그 미션 안에서 이 값이 여러 번 나올 수 있다는 뜻이다. 이 폴백이 필요한
      // 이유는 Postgres 에서 트랜잭션 안의 쿼리가 하나라도 실패하면 그 트랜잭션이 통째로
      // abort 되어 뒤따르는 INSERT 까지 못 나가기 때문이다. 그대로 두면 seq 유도 실패가
      // 기록 자체를 막아, 잠금을 도입하면서 "타임라인 한 줄 때문에 dispatch 를 죽이지
      // 않는다" 는 기존 계약을 오히려 좁히게 된다.
      //
      // 여기서 유일값을 다시 채번하려 들지 않는다(티켓 7b679009). 방금 DB 왕복이 실패한
      // 경로에서 또 읽어봐야 그 읽기도 실패할 수 있어 "유일" 이 보장이 아니라 확률이 되고,
      // 이미 쌓인 레거시 동률 행은 어차피 못 고친다. 대신 소비자인 `listMissionEvents` 가
      // 안정 키(`id`)를 커서의 마지막 단으로 써서, 동률의 **원인과 무관하게** 전순서를
      // 만든다 — 그래서 여기 0 이 두 번 나와도 페이지 경계에서 행이 사라지지 않는다.
      this.logService.warn(
        'Orchestration',
        `serialized event write failed for mission ${mission.id}, retrying unordered: ${e?.message || e}`,
      );
      try {
        await this.eventRepo.save(this.eventRepo.create({ ...row, write_seq: 0 }));
      } catch (e2: any) {
        // A timeline write must never take down a dispatch — losing one audit row
        // is strictly better than stranding a step because the log table hiccuped.
        this.logService.error('Orchestration', `failed to record event for mission ${mission.id}: ${e2?.message || e2}`);
      }
    }
    this.emitUpdate(mission, { type: input.type, message: input.message, step_key: input.step_key || '' });
  }

  /**
   * 미션 타임라인의 **커서 페이지네이션**(티켓 4d065f82, 리뷰 라운드1 P1-3).
   *
   * `getMissionDetail` 은 최신 N건만 실어주는 bounded window 라, 긴 미션의 이전 이력은
   * 어떤 API 로도 가져올 수 없었다. 이 메서드가 그 창을 뒤로 밀 수 있게 한다.
   *
   * 커서는 `(created_at, write_seq, id)` **3단** 복합 keyset 이다. 앞의 두 개만으로는
   * 안 된다:
   *
   * - `created_at` 단독 — fan-out 한 번이면 수십 건이 같은 타임스탬프를 갖고, 그러면
   *   `created_at < cursor` 는 그 그룹을 통째로 건너뛰고 `<=` 는 무한히 되돌린다.
   * - `(created_at, write_seq)` — `write_seq` 가 미션 안에서 유일할 때만 전순서다. 그
   *   전제가 깨지는 경로가 실제로 둘 있다(티켓 7b679009). (1) `recordEvent` 는 직렬화
   *   트랜잭션이 실패하면 `write_seq: 0`("순서 미상")으로 fail-open 하므로, 한 미션에서
   *   두 번 발동하면 0 이 두 행이 된다. (2) 백필(`1760000000086`)을 아직 돌리지 않은 DB
   *   에는 미션의 모든 행이 0 또는 1 인 레거시 구간이 그대로 남아 있다. 커서가 그런
   *   동률 군집 **안쪽**을 가리키면 tie-break 절이 `seq < seq` 로 항상 거짓이 되고, 첫
   *   분기는 같은 시각 그룹을 통째로 제외해 **나머지 행이 페이지 경계에서 조용히
   *   사라진다** — write_seq 컬럼이 존재하는 이유였던 바로 그 손실이다.
   *
   * 그래서 PK 인 `id` 를 마지막 키로 둔다. `id` 는 미션 안에서(사실 테이블 전체에서)
   * 유일하므로 세 키의 조합은 **원인과 무관하게** 항상 전순서다 — fail-open 이든 레거시
   * 행이든 미래의 생산자 회귀든, 동률이 생겨도 페이지 경계에서 행을 잃지 않는다.
   * 같은 선택을 archive 커서가 먼저 했다(`archive-tools.ts` 의 `buildArchiveCursor` 는
   * `(archived_at, id)` 를 합성 커서로 싣는다).
   *
   * `before_id` 는 optional 이다. 넘기지 않은 호출자는 예전 2단 술어로 degrade 하므로
   * 기존 동작이 그대로 유지된다 — 대신 위 손실도 그대로다. 서버가 돌려주는
   * `next_cursor` 는 항상 셋을 다 싣는다.
   *
   * 최신 → 과거 순(DESC)으로 돌려준다. 호출자가 화면에 붙일 때 뒤집는다.
   */
  async listMissionEvents(
    missionId: string,
    workspaceId: string,
    opts?: { limit?: number; before_at?: string; before_seq?: number; before_id?: string },
  ): Promise<{
    events: OrchestrationEvent[];
    has_more: boolean;
    next_cursor: { at: string; seq: number; id: string } | null;
  }> {
    const mission = await this.requireMission(missionId);
    if (workspaceId && mission.workspace_id !== workspaceId) {
      throw orchestrationError(404, 'mission not found in this workspace');
    }
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);

    const qb = this.eventRepo
      .createQueryBuilder('e')
      .where('e.mission_id = :missionId', { missionId })
      // 첫 키는 컬럼이 아니라 **커서 정밀도로 자른 시각**이다. 술어가 tied group 을 한
      // 덩어리로 보는데 정렬이 그 안을 µs 로 더 잘게 나누면, "커서 행보다 뒤" 를 술어로
      // 표현할 수 없어 Postgres 에서 행이 사라진다(tiedCreatedAtOrderExpr doc 참고).
      .orderBy(tiedCreatedAtOrderExpr(this.dataSource, 'e'), 'DESC')
      .addOrderBy('e.write_seq', 'DESC')
      // 정렬에도 같은 마지막 키가 있어야 한다. 술어만 3단이고 ORDER BY 가 2단이면 동률
      // 군집 안의 순서를 DB 가 자유롭게 정하므로, 커서가 가리킨 지점과 다음 페이지의
      // 시작점이 어긋나 행이 빠지거나 겹친다.
      .addOrderBy('e.id', 'DESC')
      // 한 건 더 읽어 has_more 를 별도 COUNT 없이 판정한다.
      .take(limit + 1);

    if (opts?.before_at) {
      const beforeSeq = Number.isFinite(Number(opts.before_seq)) ? Number(opts.before_seq) : 0;
      const beforeId = typeof opts.before_id === 'string' ? opts.before_id : '';
      const cursorAt = new Date(opts.before_at);
      // tie-break 절의 "같은 시각" 도 등호로 물으면 안 된다(티켓 85efcb69). 커서의 `at` 은
      // 아래에서 `new Date(...).toISOString()` 으로 만들어져 밀리초까지만 남는데 Postgres 의
      // created_at 은 마이크로초라, 등호는 커서 행 자신을 포함해 한 행도 집지 못한다. 그러면
      // 이 절이 영영 비어 커서와 같은 밀리초에 몰린 나머지 이벤트가 페이지 경계에서 통째로
      // 사라진다 — write_seq 컬럼이 존재하는 이유가 바로 그 손실을 막는 것이므로, 생산자쪽
      // seq 를 고쳐도 여기를 같이 고치지 않으면 결함이 그대로 남는다.
      // 두 분기는 서로소다: 첫 분기는 `< t`, tie-break 는 sqljs 가 `= t`(초 단위),
      // 그 외 드라이버가 `[t, t+1ms)` 라 같은 행이 두 번 반환되지 않는다.
      const tied = tiedCreatedAtWhere(this.dataSource, 'e', cursorAt);
      // seq 동률은 `id` 로 한 번 더 가른다(위 doc 참고). `id` 가 없는 호출자는 예전
      // 술어 그대로 — 동작이 나빠지지는 않되 동률 군집에서의 손실도 그대로다.
      const tieBreak = beforeId
        ? '(e.write_seq < :beforeSeq OR (e.write_seq = :beforeSeq AND e.id < :beforeId))'
        : 'e.write_seq < :beforeSeq';
      qb.andWhere(
        `(e.created_at < :beforeAt OR ((${tied.clause}) AND ${tieBreak}))`,
        {
          beforeAt: sinceBoundaryParam(this.dataSource, cursorAt),
          ...tied.params,
          beforeSeq,
          ...(beforeId ? { beforeId } : {}),
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
      next_cursor: last
        ? { at: new Date(last.created_at).toISOString(), seq: last.write_seq ?? 0, id: last.id }
        : null,
    };
  }

  /**
   * 다음 이벤트의 **정렬 키**(`write_seq` 와 `created_at`)를 DB 상태에서 유도한다
   * (티켓 4d065f82, 50031353).
   *
   * `recordEvent` 가 미션 row 를 잠근 트랜잭션 안에서만 부르므로, 읽기와 뒤이은 INSERT
   * 사이에 다른 기록이 끼어들 수 없다. 그래서 두 값 모두 정의상 옳다.
   *
   * **`write_seq` = 이 미션의 현재 최댓값 + 1.** `created_at` 을 보지 않는다 — 예전에는
   * "가장 최근 created_at 과 같은 시각인 row"(tied group)의 최댓값 + 1 을 썼는데, 잠금을
   * 도입하자 그 방식이 깨졌다. Postgres 의 `CURRENT_TIMESTAMP` 는 문장 시각이 아니라
   * **트랜잭션 시작 시각**이라, 동시 호출들이 잠금을 기다리기 **전에** 거의 같은 순간
   * BEGIN 하면서 서로 뒤섞인 `created_at` 을 갖는다. 그러면 "최대 created_at 주변 1ms"
   * 창이 방금 가장 큰 seq 를 받은 row 를 놓칠 수 있고, 다음 호출이 낡은 최댓값을 다시
   * 읽어 **같은 seq 를 반복한다**(CI 실측: 8건 동시 기록에서 `[1,2,4,6,3,6,5,6]`).
   * 미션 전체 MAX 는 타임스탬프 정밀도·단조성에 전혀 기대지 않아 그 실패 모드가 없다.
   *
   * **`created_at` 도 여기서 정한다.** 같은 이유로 DB 기본값에 맡기면 안 된다 — 트랜잭션
   * 시작 시각은 잠금 획득 순서(= `write_seq` 순서)와 어긋날 수 있다. `listMissionEvents`
   * 는 `created_at DESC, write_seq DESC` 로 정렬하면서 keyset 술어는 **밀리초 단위**로
   * tied group 을 묶으므로, 한 밀리초 안에서 `created_at`(µs) 순서와 `write_seq` 순서가
   * 서로 다르면 페이지 경계에서 이벤트가 빠진다(CI 실측: 커서 순회가 8건 중 6건만 덮음).
   * 잠금 안에서 시각을 찍으면 두 순서가 항상 일치한다. 이 트랜잭션 도입 전에는 INSERT 가
   * 자기 자신의 암묵 트랜잭션이라 문장 시각 = 삽입 순서였고, 그때는 저절로 성립하던
   * 불변식이다 — 잠금을 넣으면서 깨진 것을 여기서 되돌린다.
   *
   * **Postgres 에서만** 시각을 직접 찍는다. 이 역전은 `CURRENT_TIMESTAMP` 가 트랜잭션
   * 시작에 고정되는 Postgres 고유의 성질에서 온다 — sqljs 의 `datetime('now')` 도,
   * MySQL 의 `NOW()` 도 문장 시각이라 잠금 획득 뒤에 평가되므로 삽입 순서와 어긋나지
   * 않는다. 게다가 sqljs 는 `created_at` 을 초 단위 **문자열**로 저장해서, JS `Date` 를
   * 박으면 `sinceBoundaryParam()` 이 만드는 문자열과 형식이 어긋나 tied 등호가 통째로
   * 빗나간다(실측: sqljs 커서 순회가 42건 중 7건만 덮음). 필요 없는 곳은 건드리지 않는다.
   *
   * 이미 있는 최대 `created_at` 으로 하한을 둔다(clamp). 서버가 여러 프로세스로 뜨거나
   * 시계가 뒤로 튀어도 `created_at` 이 `write_seq` 순서를 거스르지 않게 하는 보호다.
   *
   * 읽기는 **반드시 호출자의 `EntityManager` 로** 한다. 주입된 저장소를 쓰면 이 조회가
   * `recordEvent` 의 트랜잭션 **밖**에서 일어나 미션 row 를 잠근 의미가 사라진다 — 잠금이
   * 지켜야 하는 것은 INSERT 하나가 아니라 "최댓값을 읽고 그 다음 값을 쓴다" 는 읽기-쓰기
   * 구간 전체다. 틀리게 쓸 수 있는 경로를 두지 않으려고 seam 을 인자로 강제한다.
   *
   * (소비자인 `listMissionEvents` 의 keyset 술어는 여전히 `tiedCreatedAtWhere` 가 필요하다 —
   * 거기서는 커서가 가리키는 "같은 시각" 을 드라이버 정밀도에 맞춰 물어야 한다. 티켓 85efcb69.)
   */
  private async nextEventOrderingKey(
    missionId: string,
    manager: EntityManager,
  ): Promise<{ seq: number; at: Date | null }> {
    try {
      const row = await manager
        .getRepository(OrchestrationEvent)
        .createQueryBuilder('e')
        .select('MAX(e.write_seq)', 'max_seq')
        .addSelect('MAX(e.created_at)', 'max_at')
        .where('e.mission_id = :missionId', { missionId })
        .getRawOne<{ max_seq: number | string | null; max_at: unknown }>();
      // 이벤트가 없으면 MAX 는 NULL 이고 첫 값은 1 이다.
      const seq = Number(row?.max_seq ?? 0) + 1;
      if (manager.connection.options.type !== 'postgres') return { seq, at: null };
      const maxAt = row?.max_at instanceof Date ? row.max_at.getTime() : 0;
      return { seq, at: new Date(Math.max(Date.now(), maxAt)) };
    } catch {
      // 정렬 키 유도 실패가 타임라인 기록 자체를 막으면 안 된다 — seq 0 은 "순서 미상"이고
      // 커서는 created_at 으로만 비교하게 되어 예전 동작으로 우아하게 후퇴한다. 시각은
      // null 을 돌려 DB 기본값에 맡긴다.
      return { seq: 0, at: null };
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
