import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Action } from '../../entities/Action';
import { ActionRun } from '../../entities/ActionRun';
import { ActionApproval } from '../../entities/ActionApproval';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { Workspace } from '../../entities/Workspace';
import { User } from '../../entities/User';
import { Comment } from '../../entities/Comment';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { RoomMembershipService } from '../chat-rooms/room-membership.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { LogService } from '../../services/log.service';
import { findOrFail } from '../../common/find-or-fail';
import { agentIsVisibleInWorkspace } from '../../common/agent-workspace-scope';
import { prependBoardLanguageInstruction } from '../../common/harness-config';
import { evaluateTerminalPendGate, loadTicketColumnForPendGate } from '../mcp/shared/terminal-pend-gate';
import { renderActionPrompt, buildRenderContext, ActionTicketContext } from './action-prompt';
import { parseCron } from './cron';
import { enforceRunBudget } from '../../common/run-budget-guard';
import { normalizeWorkspaceFolder, normalizeCheckoutMode, normalizeRepoRef } from '../../common/workspace-folder-options';
import { buildRunProvision } from '../../common/run-workspace-resolver';
import {
  actionTargetAgentIds,
  agentScopedWorkspaceFolder,
  normalizeTargetAgentIds,
  primaryTargetAgentId,
  serializeTargetAgentIds,
} from '../../common/action-targets';
import { resolveAgentDisplayNamesByIds } from '../../utils/agent-name';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// Names/descriptions that clearly denote an irreversible external operation.
// Used as a SAFE-DEFAULT escalator (ticket 524bb434, reviewer req 3): even an
// Action a caller saved with high_impact=false is treated as high-impact when
// its name/description names a deploy/publish/release/… so a missing or wrong
// classification fails CLOSED (still gated) rather than open. Escalate-only —
// it never downgrades an Action explicitly flagged high_impact.
const HIGH_IMPACT_NAME_RE =
  /\b(deploy|deployment|publish|release|rollout|roll-out|ship\s+to\s+prod|promote|production|\bprod\b|payment|charge|refund|invoice|terraform\s+apply|helm\s+(?:install|upgrade)|kubectl\s+(?:apply|delete)|drop\s+(?:database|table)|migrate\s+prod)\b/i;

/**
 * Effective high-impact classification for an Action (ticket 524bb434, scope 5).
 * True when the Action is explicitly flagged high_impact OR its name/description
 * matches the high-impact heuristic. Both the pre-execution approval gate
 * (`dispatch`) and the no-auto-retry rule (`completeRun`) key on this so a
 * misclassified deploy/publish cannot slip past either safeguard.
 */
export function isHighImpactAction(
  action: { high_impact?: boolean; name?: string; description?: string } | null | undefined,
): boolean {
  if (!action) return false;
  if (action.high_impact) return true;
  return HIGH_IMPACT_NAME_RE.test(`${action.name || ''} ${action.description || ''}`);
}

/**
 * Completion contract appended to a ticket-driven run's prompt (ticket
 * 524bb434). Tells the target agent how to close the loop so the source ticket
 * resumes automatically — the "Action 등록 → 실행 → 결과 반영 → 티켓 재개"
 * chain. Server-injected so it holds regardless of what the Action author wrote.
 */
function renderCompletionContract(
  runId: string,
  workspaceId: string,
  sourceTicketId: string,
  idempotencyKey: string,
  highImpact: boolean,
): string {
  const idempotencyBlock = idempotencyKey
    ? `\n\n**Idempotency key:** \`${idempotencyKey}\` — pass this to the external system (deploy/publish/release) as the operation's dedupe key. ` +
      `A retry of this run carries the SAME key, so a redelivered operation under this key must be a no-op on the target side. ` +
      `Do NOT re-run the external effect if that key was already applied.`
    : '';
  const failureLine = highImpact
    ? `- **failed** → this is a HIGH-IMPACT action, so the server does NOT auto-retry (a blind re-run could double the external effect). ` +
      `The failure is surfaced to the ticket for a human decision. Report **failed** only if the external operation did NOT take effect; ` +
      `if you are unsure whether it partially landed, say so in \`summary\`.`
    : `- **failed** → the run is retried automatically (bounded, same idempotency key); after the retry cap the failure is surfaced back to the ticket.`;
  return (
    `\n\n---\n` +
    `## Report your result (required — a ticket is waiting on this run)\n\n` +
    `Ticket \`${sourceTicketId}\` dispatched this run and is paused until you report back. ` +
    `When you finish, call:\n\n` +
    '```\n' +
    `mcp__awb__complete_action_run(\n` +
    `  run_id="${runId}",\n` +
    `  workspace_id="${workspaceId}",\n` +
    `  status="succeeded" | "failed",\n` +
    `  summary="<what you did and the outcome, or why it failed>"\n` +
    `)\n` +
    '```\n\n' +
    `- **succeeded** → the source ticket auto-resumes in place and your summary is posted to its audit trail.\n` +
    `${failureLine}\n` +
    `- Do this exactly once. A second call on the same run is ignored (the outcome is already recorded).` +
    idempotencyBlock
  );
}

/**
 * source_ticket_id 없는 run(사람 UI 트리거 / cron / on-ticket-done)에 붙는 완료
 * 계약 (티켓 b273d603). `dispatch()`가 `sourceTicketId`일 때만 `renderCompletionContract`를
 * 붙이던 기존 동작 때문에, 대상 에이전트가 `run_id`조차 전달받지 못해
 * `complete_action_run`을 호출할 방법이 없었다 — 그래서 이런 run의 `status`가
 * 실제 완료 여부와 무관하게 영구히 `running`으로 남았다. 재개할 티켓도
 * `completeRun`의 자동 재시도도 없으므로(해당 분기는 `!sourceTicketId`일 때
 * 조기 반환한다) 재개/재시도 문구는 넣지 않는다.
 */
function renderStandaloneCompletionContract(runId: string, workspaceId: string): string {
  return (
    `\n\n---\n` +
    `## Report your result (required — this keeps the run's status accurate)\n\n` +
    `This run has no ticket to resume, but its status is tracked and shown in the Actions UI. ` +
    `When you finish, call:\n\n` +
    '```\n' +
    `mcp__awb__complete_action_run(\n` +
    `  run_id="${runId}",\n` +
    `  workspace_id="${workspaceId}",\n` +
    `  status="succeeded" | "failed",\n` +
    `  summary="<what you did and the outcome, or why it failed>"\n` +
    `)\n` +
    '```\n\n' +
    `- Nothing auto-retries and nothing else is waiting on this run — the call only records the outcome so \`status\` stops showing \`running\` once you're done.\n` +
    `- Do this exactly once. A second call on the same run is ignored (the outcome is already recorded).`
  );
}

export interface DispatchActionArgs {
  actionId: string;
  // 'user' = web UI clicked Run; 'system' = scheduler; 'agent' = MCP-authenticated
  // agent dispatched the run. The triggering user (when type='user') is added as
  // a participant so they can read and reply to the agent. For 'system' / 'agent'
  // a synthetic participant carries the message — see dispatch() for the rationale.
  triggeredByType: 'user' | 'system' | 'agent';
  triggeredById: string;
  // On-ticket-done hook (ticket 16a6339c): the finished ticket exposed to the
  // prompt as `{{ticket.*}}`. Only OnTicketDoneActionService sets this; cron /
  // manual / UI runs leave it undefined so those tokens render empty.
  ticketContext?: ActionTicketContext;
  // Auto-resume linkage (ticket 524bb434): the ticket that dispatched this run
  // because it hit an Action-resolvable blocker instead of parking. Persisted
  // on the ActionRun so `completeRun` can re-dispatch it once the run finishes.
  // Undefined for cron / manual / on-ticket-done runs that have nothing to
  // resume. A completion contract is appended to the rendered prompt either
  // way (ticket b273d603) so `status` can never get stuck at 'running': the
  // resume/retry variant when set, a standalone variant (no resume/retry
  // language) when unset — see `renderCompletionContract` /
  // `renderStandaloneCompletionContract`.
  sourceTicketId?: string;
  // 1-based attempt number. `completeRun`'s retry path re-dispatches with
  // attempt+1; the default 1 covers the first, agent-initiated dispatch.
  attempt?: number;
  // Run-level idempotency key (ticket 524bb434, scope 5). `completeRun`'s retry
  // path passes the FAILED run's key so the whole retry chain shares one key —
  // the target operation can dedupe. Undefined on a first ticket-driven
  // dispatch, where `dispatch` mints a fresh key.
  idempotencyKey?: string;
  // fan-out 대상 좁히기 (티켓 fc3906c5). 비우면 Action에 설정된 대상 **전체**로
  // fan-out한다(정상 트리거). `completeRun`의 재시도만 이 필드를 채워 실패한
  // 그 에이전트 하나로 좁힌다 — 재시도가 배치를 통째로 다시 돌리면 이미 성공한
  // 에이전트에서 외부 작업이 두 번 실행된다. 여기 넣은 id 중 Action의 실제
  // 대상이 아닌 것은 무시되고, 교집합이 비면 디스패치가 거부된다(있지도 않은
  // 대상을 실행 시점에 주입하는 경로가 되지 않도록 — 대상은 여전히 Action
  // 정의에 선언적으로 고정된다).
  onlyAgentIds?: string[];
  // fan-out 재시도가 원래 배치를 승계하기 위한 키 (티켓 fc3906c5). 비우면 새
  // 배치를 발급한다. 재시도 run이 새 배치로 떨어지면 원래 배치가 "전원 종료"로
  // 보여 티켓이 조기 재개된다.
  batchId?: string;
  // NOTE: there is deliberately NO `approvedByUserId` here. High-impact approval
  // is NOT something a dispatch caller (an agent) may assert (ticket 524bb434,
  // scope 5, reviewer req). `dispatch` instead atomically consumes a human-made
  // ActionApproval grant bound to (actionId, sourceTicketId). The only way to
  // create that grant is the human-authenticated `createApproval` path, so an
  // agent cannot forge approval by naming an admin's id.
}

// Human approval GRANT creation (ticket 524bb434, scope 5). Called ONLY from the
// session-authenticated REST path (ActionsController), where `approverUserId` /
// `approverRole` come from the authenticated User (req.currentUser) — never from
// agent/request input. An agent has no session, so it cannot reach this path.
export interface CreateApprovalArgs {
  actionId: string;
  workspaceId: string;
  // The ticket the grant authorises the Action to run for (the binding).
  sourceTicketId: string;
  // Identity of the authenticated approver, taken from the session.
  approverUserId: string;
  approverName: string;
  approverRole: string;
  // Standing-approval validity window. Defaults to APPROVAL_TTL_MINUTES.
  ttlMinutes?: number;
}

/** fan-out 배치 안에서 성공적으로 만들어진 run 하나 (티켓 fc3906c5). */
export interface DispatchedRun {
  run: ActionRun;
  agent_id: string;
  room_id: string;
  prompt: string;
}

/** 배치 안에서 디스패치에 실패한 대상 하나 — 나머지는 그대로 진행됐다. */
export interface DispatchFailure {
  agent_id: string;
  error: string;
}

export interface DispatchActionResult {
  // ── 하위 호환 (fan-out 이전 형태, 티켓 fc3906c5) ─────────────────────────
  // 첫 번째 **성공한** run. 대상이 하나뿐인 Action에서는 fan-out 도입 전과
  // 완전히 같은 값이라, 이 세 키만 읽던 호출부는 손대지 않아도 그대로 맞다.
  // 대상이 여럿이면 `runs`/`batch_id`를 볼 것.
  run: ActionRun;
  room_id: string;
  prompt: string;
  // ── fan-out ────────────────────────────────────────────────────────────
  /** 이 트리거가 만든 배치 키. run이 하나뿐이어도 항상 발급된다. */
  batch_id: string;
  /** 성공한 run들 (대상 순서 유지). 최소 1개 — 전원 실패면 dispatch가 던진다. */
  runs: DispatchedRun[];
  /** 실패한 대상들. 비어 있으면 전원 성공. */
  failures: DispatchFailure[];
}

export interface CompleteRunArgs {
  status: 'succeeded' | 'failed';
  // The completing agent's outcome text — a success summary or a failure
  // reason. Mirrored into the source ticket's audit comment.
  summary?: string;
  // Attribution for the audit comment / activity + the retry re-dispatch.
  actorType?: 'user' | 'system' | 'agent';
  actorId?: string;
  actorName?: string;
}

export interface CompleteRunResult {
  run: ActionRun;
  // The ticket to resume (echoed from the run) — '' when the run had no source.
  sourceTicketId: string;
  status: 'succeeded' | 'failed' | 'running';
  // true when the run was ALREADY terminal on entry — the call was a no-op
  // (idempotency guard). The caller must NOT resume the source ticket again.
  previouslyCompleted: boolean;
  // A failed run under the retry cap re-dispatched a fresh run — its id here.
  // The source ticket is NOT resumed yet; the retry run owns the next outcome.
  retried: boolean;
  retryRunId: string;
  // A failed run that exhausted the retry cap. The source ticket IS resumed so
  // the assignee can decide (fix + retry, or pend with a genuine reason).
  exhausted: boolean;
  // Whether the caller should resume the source ticket now (succeeded, or a
  // failure that exhausted retries). False on a retry (wait for the retry run).
  shouldResume: boolean;
}

/**
 * Owns Action lifecycle: CRUD plus the Run dispatch flow.
 *
 * Run dispatch is the interesting bit. We deliberately reuse the existing
 * chat-room infrastructure rather than minting a new SSE event type:
 *
 *   1. Create a fresh ChatRoom stamped with `action_id` so the regular chat
 *      list can filter these out.
 *   2. Add the target agent + (optionally) the triggering user as
 *      participants. Both join via RoomMembershipService so the 50-cap
 *      transaction and `last_read_at = NOW()` baseline both hold.
 *   3. FIFO-prune older Run rooms beyond Action.max_runs. Pruning happens
 *      inline so the budget is enforced at the moment of dispatch.
 *   4. Send the rendered prompt as the user's first message via
 *      RoomMessagingService.sendMessage() — that path already emits
 *      chat_room_message, which the agent-manager already routes to the
 *      target agent's chat session. No new dispatcher code required.
 *
 * Variable substitution happens in `action-prompt.ts` so MCP `run_action` and
 * the REST endpoint produce byte-identical output for the same inputs.
 */
@Injectable()
export class ActionsService {
  // Retry cap for a failed run whose source ticket dispatched it (ticket
  // 524bb434). A failure under this cap re-dispatches with attempt+1; at the
  // cap the run is surfaced back to the source ticket instead. Bounds the loop
  // so a persistently-failing high-impact Action (deploy, publish) cannot retry
  // forever — a scope-5 safety lever alongside the idempotent terminal
  // transition in `completeRun`.
  static readonly MAX_RUN_ATTEMPTS = 3;

  // Default validity window for a human approval grant (ticket 524bb434, scope
  // 5). A standing approval past this age is treated as absent by the gate so a
  // stale grant can't authorise a much-later, unrelated deploy. Callers may
  // override per-grant via `ttlMinutes`.
  static readonly APPROVAL_TTL_MINUTES = 60;

  constructor(
    @InjectRepository(Action) private readonly actionRepo: Repository<Action>,
    @InjectRepository(ActionRun) private readonly runRepo: Repository<ActionRun>,
    @InjectRepository(ActionApproval) private readonly approvalRepo: Repository<ActionApproval>,
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectRepository(ChatRoomParticipant) private readonly participantRepo: Repository<ChatRoomParticipant>,
    @InjectRepository(ChatRoomMessage) private readonly messageRepo: Repository<ChatRoomMessage>,
    @InjectRepository(TicketAttachment) private readonly attachmentRepo: Repository<TicketAttachment>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectRepository(ActivityLog) private readonly activityRepo: Repository<ActivityLog>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(BoardColumn) private readonly columnRepo: Repository<BoardColumn>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly membership: RoomMembershipService,
    private readonly messaging: RoomMessagingService,
    private readonly logService: LogService,
  ) {}

  // ── CRUD ────────────────────────────────────────────────────────────────

  async list(workspaceId: string): Promise<Action[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const qb = this.actionRepo.createQueryBuilder('a')
      .where('a.workspace_id = :ws', { ws: workspaceId })
      .andWhere('a.board_id IS NULL');
    return qb.orderBy('a.name', 'ASC').getMany();
  }

  async get(id: string): Promise<Action> {
    return findOrFail(this.actionRepo, { where: { id } }, 'Action not found');
  }

  async create(input: Partial<Action> & { workspace_id: string; name: string; target_agent_id?: string }): Promise<Action> {
    if (!input.workspace_id) throw makeError(400, 'workspace_id is required');
    if (!input.name || !input.name.trim()) throw makeError(400, 'name is required');

    // 대상은 배열이 정본이고 레거시 단일 필드는 그 첫 원소로 흡수된다
    // (티켓 fc3906c5). 둘 중 어느 쪽으로 들어와도 같은 목록으로 수렴한다.
    const targetIds = actionTargetAgentIds(input);
    if (targetIds.length === 0) throw makeError(400, 'target_agent_id is required');

    // Scope check: the target agent must live in this workspace (or be global —
    // workspace_id null/empty means global). Cross-workspace dispatch would
    // bypass our SSE recipient filter and silently never deliver.
    // fan-out이면 **모든** 대상을 검사한다 — 하나라도 타 워크스페이스면 저장
    // 자체를 거부해서, 절대 전달되지 않을 대상이 설정에 남지 않게 한다.
    await this._assertTargetAgentsVisible(targetIds, input.workspace_id);

    if (input.board_id) {
      throw makeError(400, 'Board-scoped Actions are no longer supported; create the Action in its Workspace');
    }

    if (input.schedule_cron && input.schedule_cron.trim()) {
      if (!parseCron(input.schedule_cron)) {
        throw makeError(400, 'schedule_cron is invalid — expected 5 fields with `*` or integers');
      }
    }

    if (input.trigger !== undefined && !this._isValidTrigger(input.trigger)) {
      throw makeError(400, "trigger must be '' (cron/manual) or 'on_ticket_done'");
    }

    const created = this.actionRepo.create({
      workspace_id: input.workspace_id,
      board_id: null,
      name: input.name.trim(),
      description: input.description ?? '',
      prompt: input.prompt ?? '',
      // 두 컬럼은 항상 함께 쓴다 — 배열이 정본, 단일은 첫 원소 미러.
      target_agent_id: targetIds[0],
      target_agent_ids: serializeTargetAgentIds(targetIds),
      schedule_cron: input.schedule_cron ?? '',
      enabled: input.enabled !== false,
      high_impact: input.high_impact === true,
      max_runs: typeof input.max_runs === 'number' && input.max_runs > 0 ? input.max_runs : 10,
      trigger: input.trigger ?? '',
      trigger_label: input.trigger_label ?? '',
      workspace_folder: normalizeWorkspaceFolder(input.workspace_folder),
      repo_ref: normalizeRepoRef(input.repo_ref),
      checkout_mode: normalizeCheckoutMode(input.checkout_mode),
    });
    return this.actionRepo.save(created);
  }

  async update(id: string, workspaceId: string, patch: Partial<Action>): Promise<Action> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const existing = await findOrFail(this.actionRepo, { where: { id, workspace_id: workspaceId } }, 'Action not found in workspace');

    if (patch.name !== undefined) {
      if (!patch.name || !patch.name.trim()) throw makeError(400, 'name cannot be empty');
      existing.name = patch.name.trim();
    }
    if (patch.description !== undefined) existing.description = patch.description;
    if (patch.prompt !== undefined) existing.prompt = patch.prompt;
    // 대상 갱신 (티켓 fc3906c5). 배열이 오면 배열이 이기고, 레거시 단일 필드만
    // 오면 그것이 단일 대상 배열로 해석된다. 어느 쪽이든 두 컬럼을 같이 쓴다 —
    // 배열만 갱신하고 단일 미러를 방치하면 레거시 컬럼만 읽는 코드가 지워진
    // 대상을 계속 보게 된다.
    if (patch.target_agent_ids !== undefined || patch.target_agent_id !== undefined) {
      const nextIds = patch.target_agent_ids !== undefined
        ? normalizeTargetAgentIds(patch.target_agent_ids)
        : normalizeTargetAgentIds([patch.target_agent_id]);
      if (nextIds.length === 0) throw makeError(400, 'at least one target agent is required');
      await this._assertTargetAgentsVisible(nextIds, workspaceId);
      existing.target_agent_id = nextIds[0];
      existing.target_agent_ids = serializeTargetAgentIds(nextIds);
    }
    if (patch.board_id !== undefined) {
      if ((patch.board_id || null) !== existing.board_id) {
        throw makeError(400, 'scope cannot be changed after creation');
      }
    }
    if (patch.schedule_cron !== undefined) {
      const next = patch.schedule_cron || '';
      if (next.trim() && !parseCron(next)) {
        throw makeError(400, 'schedule_cron is invalid — expected 5 fields with `*` or integers');
      }
      existing.schedule_cron = next;
    }
    if (patch.enabled !== undefined) existing.enabled = !!patch.enabled;
    if (patch.high_impact !== undefined) existing.high_impact = !!patch.high_impact;
    if (patch.max_runs !== undefined) {
      const n = Number(patch.max_runs);
      if (Number.isFinite(n) && n > 0) existing.max_runs = Math.floor(n);
    }
    if (patch.trigger !== undefined) {
      if (!this._isValidTrigger(patch.trigger)) {
        throw makeError(400, "trigger must be '' (cron/manual) or 'on_ticket_done'");
      }
      existing.trigger = patch.trigger;
    }
    if (patch.trigger_label !== undefined) existing.trigger_label = patch.trigger_label ?? '';
    if (patch.workspace_folder !== undefined) existing.workspace_folder = normalizeWorkspaceFolder(patch.workspace_folder);
    if (patch.repo_ref !== undefined) existing.repo_ref = normalizeRepoRef(patch.repo_ref);
    if (patch.checkout_mode !== undefined) existing.checkout_mode = normalizeCheckoutMode(patch.checkout_mode);
    return this.actionRepo.save(existing);
  }

  // Allowed `Action.trigger` values. Empty = legacy cron/manual; 'on_ticket_done'
  // opts into the lifecycle hook (OnTicketDoneActionService).
  private _isValidTrigger(trigger: string): boolean {
    return trigger === '' || trigger === 'on_ticket_done';
  }

  /**
   * 대상 에이전트 목록 전체가 이 워크스페이스에서 보이는지 검사한다
   * (티켓 fc3906c5 — 단일 대상 시절의 검사를 배열로 확장).
   *
   * 하나라도 없거나 타 워크스페이스면 **저장을 통째로 거부**한다. 부분 저장을
   * 허용하면 사용자가 고른 대상 중 일부가 조용히 빠진 Action이 남고, 이후 모든
   * 실행이 사용자 의도와 다른 범위로 돌게 된다. 어느 id가 문제인지 메시지에
   * 담아 UI에서 바로 고칠 수 있게 한다.
   */
  private async _assertTargetAgentsVisible(agentIds: string[], workspaceId: string): Promise<void> {
    for (const agentId of agentIds) {
      const agent = await this.agentRepo.findOne({ where: { id: agentId } });
      if (!agent) throw makeError(400, `target agent not found: ${agentId}`);
      if (!agentIsVisibleInWorkspace(agent.workspace_id, workspaceId)) {
        throw makeError(400, `target agent belongs to a different workspace: ${agentId}`);
      }
    }
  }

  async remove(id: string, workspaceId: string): Promise<void> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const existing = await this.actionRepo.findOne({ where: { id, workspace_id: workspaceId } });
    if (!existing) throw makeError(404, 'Action not found in workspace');
    // Cascade: delete every Run (and the room each Run created) before the
    // action row goes. Otherwise the chat list ends up with orphan rooms
    // pointing at a non-existent action_id.
    await this._deleteRunsForAction(id);
    await this.actionRepo.delete({ id, workspace_id: workspaceId });
  }

  // ── Runs ───────────────────────────────────────────────────────────────

  async listRuns(actionId: string, workspaceId: string, limit = 20): Promise<ActionRun[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    await findOrFail(this.actionRepo, { where: { id: actionId, workspace_id: workspaceId } }, 'Action not found in workspace');
    return this.runRepo.find({
      where: { action_id: actionId, workspace_id: workspaceId },
      order: { created_at: 'DESC' },
      take: Math.min(limit, 100),
    });
  }

  async getRun(runId: string, workspaceId: string): Promise<ActionRun> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    return findOrFail(this.runRepo, { where: { id: runId, workspace_id: workspaceId } }, 'Run not found in workspace');
  }

  /**
   * Close out a Run and drive the source ticket's auto-resume (ticket 524bb434).
   *
   * The target agent calls this from the run's chat room once the dispatched
   * work (a deploy, a publish, …) is done. This is the server-side half of the
   * "run finished → resume the original ticket" contract — the missing piece
   * the reviewer flagged: prior to this the run was fire-and-forget with no
   * link back to the ticket that needed it.
   *
   * Guarantees:
   *   - **Idempotent terminal transition.** A run already in a terminal state
   *     is a no-op (`previouslyCompleted`) — a re-invoked / duplicated agent
   *     turn cannot resume the ticket twice or double-count a retry. This is a
   *     scope-5 safety lever for high-impact Actions.
   *   - **Result reflected on the ticket.** Success and failure both post an
   *     audit comment + an `action_run_completed` ActivityLog row on the source
   *     ticket, so the outcome is reconstructable from the ticket alone.
   *   - **Bounded retry.** A failure under `MAX_RUN_ATTEMPTS` re-dispatches a
   *     fresh run (attempt+1, same source ticket) and does NOT resume yet — the
   *     retry run owns the next outcome. At the cap the failure is surfaced and
   *     the ticket IS resumed so the assignee decides.
   *
   * The actual re-dispatch of the source ticket's role holders
   * (`dispatchCurrentColumn`) lives in the MCP `complete_action_run` tool,
   * which already holds `TriggerLoopService` — keeping this service free of a
   * cross-module trigger dependency. This method returns `shouldResume` telling
   * the caller whether to fire that resume.
   */
  async completeRun(runId: string, workspaceId: string, args: CompleteRunArgs): Promise<CompleteRunResult> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    if (args.status !== 'succeeded' && args.status !== 'failed') {
      throw makeError(400, "status must be 'succeeded' or 'failed'");
    }
    const run = await findOrFail(
      this.runRepo,
      { where: { id: runId, workspace_id: workspaceId } },
      'Run not found in workspace',
    );

    const summary = (args.summary || '').trim();

    // ── Atomic idempotent terminal transition (reviewer req 2) ────────────
    // The transition is a single UPDATE guarded on `status = 'running'`, so
    // exactly one caller flips running → terminal. Two concurrent
    // `complete_action_run` calls that both read 'running' can no longer both
    // proceed: the DB serialises the guarded UPDATE and only the winner's
    // affected-row count is > 0. The loser (and any later sequential dup)
    // takes the no-op branch below — no double audit row, no double
    // resume/retry, no double retry-count. This is the scope-5 idempotency
    // lever for high-impact Actions where a duplicated re-dispatch is unsafe.
    const completedAt = new Date();
    // 재시도 예정 여부를 **전이 전에** 확정한다 (티켓 fc3906c5, 리뷰 P1-1).
    // 예전에는 action 을 전이 뒤에 읽어서, "실패 확정 ~ 재시도 행 삽입" 창 동안
    // 배치가 완료된 것처럼 보였다. 이제 같은 UPDATE 로 `retry_pending` 을 함께
    // 세워 그 창을 원자적으로 닫는다.
    const action = await this.actionRepo.findOne({ where: { id: run.action_id } });
    const highImpact = isHighImpactAction(action);
    const preSourceTicketId = (run.source_ticket_id || '').trim();
    const willRetry = args.status === 'failed'
      && !!preSourceTicketId
      && !highImpact
      && (run.attempt ?? 1) < ActionsService.MAX_RUN_ATTEMPTS;
    const claim = await this.runRepo
      .createQueryBuilder()
      .update(ActionRun)
      .set({ status: args.status, result_summary: summary, completed_at: completedAt, retry_pending: willRetry })
      .where('id = :id', { id: run.id })
      .andWhere('workspace_id = :ws', { ws: workspaceId })
      .andWhere("status = 'running'")
      .execute();
    // Fail-closed single-winner (reviewer non-blocker note): only a positive
    // affected-row count proves we won the guarded UPDATE. Postgres + sql.js
    // both populate `affected`; if a future driver ever leaves it undefined we
    // treat the call as LOST rather than guessing from our stale pre-read
    // `run.status` — the earlier fallback let two racing callers who both read
    // 'running' both become winners, breaking the single-winner guarantee. The
    // worst case here is a stalled resume (recoverable), never a double external
    // effect (the scope-5 hazard this guard exists to prevent).
    const won = (claim.affected ?? 0) > 0;

    if (!won) {
      // Lost the race (or a sequential duplicate on an already-terminal run).
      // Report the recorded state without any side effect. Re-read so the
      // status reflects the winner's outcome, not our stale 'running' snapshot.
      const current = await this.runRepo.findOne({ where: { id: run.id, workspace_id: workspaceId } });
      const settled = current || run;
      this.logService.info('Actions', `completeRun no-op — run ${run.id} already ${settled.status}`);
      return {
        run: settled,
        sourceTicketId: settled.source_ticket_id || '',
        status: (settled.status || 'running') as CompleteRunResult['status'],
        previouslyCompleted: true,
        retried: false,
        retryRunId: '',
        exhausted: false,
        shouldResume: false,
      };
    }

    // We own the transition — reflect it on the in-memory row for the rest of
    // this method (audit comment, activity, retry/resume decision).
    run.status = args.status;
    run.result_summary = summary;
    run.completed_at = completedAt;

    run.retry_pending = willRetry;
    const actionName = action?.name || run.action_id;
    const sourceTicketId = preSourceTicketId;

    // No source ticket → this was a cron / manual / on-ticket-done run. Record
    // the terminal state and stop; there is nothing to resume or annotate.
    if (!sourceTicketId) {
      return {
        run,
        sourceTicketId: '',
        status: args.status,
        previouslyCompleted: false,
        retried: false,
        retryRunId: '',
        exhausted: false,
        shouldResume: false,
      };
    }

    const actor = {
      type: args.actorType || 'agent',
      id: args.actorId || '',
      name: args.actorName || 'Action Runner',
    };

    if (args.status === 'succeeded') {
      await this._logRunActivity(sourceTicketId, run, actor, 'succeeded', summary);
      // fan-out 배치는 **모든 run이 종료된 뒤** 한 번만 재개한다 (티켓 fc3906c5).
      // 아직 형제 run이 돌고 있으면 진행 상황만 남기고 재개하지 않는다.
      const gate = await this._resolveBatchResume(run, actionName, actor, sourceTicketId);
      if (!gate.shouldResume) {
        return {
          run, sourceTicketId, status: 'succeeded',
          previouslyCompleted: false, retried: false, retryRunId: '', exhausted: false,
          shouldResume: false,
        };
      }
      await this._postRunComment(sourceTicketId, run.workspace_id, actor, gate.comment);
      return {
        run, sourceTicketId, status: 'succeeded',
        previouslyCompleted: false, retried: false, retryRunId: '', exhausted: false,
        shouldResume: true,
      };
    }

    // ── Failure ──────────────────────────────────────────────────────────
    await this._logRunActivity(sourceTicketId, run, actor, 'failed', summary);
    // High-impact Actions (deploy/publish/release) are NOT auto-retried
    // (reviewer req 4 / scope 5). A failure here may mean the external
    // operation partially landed; a blind bounded re-run could double the
    // effect. bounded retry ≠ operation idempotency. Surface it to the ticket
    // for a human decision instead. Non-high-impact Actions keep the bounded
    // auto-retry, carrying the run's idempotency key so the target can dedupe.
    // Uses the same effective classification as the approval gate (explicit flag
    // OR name heuristic) so a misclassified deploy/publish is not auto-retried.
    // `highImpact` / `willRetry` 는 전이 이전에 이미 계산돼 있다(위 참고).
    if (willRetry) {
      const nextAttempt = run.attempt + 1;
      let retryRunId = '';
      try {
        // 재시도는 **실패한 그 에이전트 하나만** 다시 돌린다 (티켓 fc3906c5).
        // 배치 전체를 다시 fan-out 하면 이미 성공한 에이전트에서 외부 작업이
        // 두 번 실행된다. 그리고 원래 batch_id를 승계해야 재시도가 떠 있는 동안
        // 배치가 "전원 종료"로 보이지 않는다.
        //
        // agent_id가 빈 레거시 run은 Action의 대표 대상으로 되돌린다 — fan-out
        // 이전의 dispatch가 정확히 `action.target_agent_id` 하나를 쓰던 것과
        // 같은 동작이라, 옛 run의 재시도가 갑자기 여러 대상으로 번지지 않는다.
        const retryAgentId = run.agent_id || primaryTargetAgentId(action);
        const retry = await this.dispatch({
          actionId: run.action_id,
          triggeredByType: actor.type,
          triggeredById: actor.id,
          sourceTicketId,
          attempt: nextAttempt,
          // Carry the same idempotency key across the retry chain so the
          // target operation can dedupe a redelivered external effect.
          idempotencyKey: run.idempotency_key || undefined,
          onlyAgentIds: retryAgentId ? [retryAgentId] : undefined,
          batchId: run.batch_id || undefined,
        });
        retryRunId = retry.run.id;
      } catch (e: any) {
        // Re-dispatch failed (e.g. the Action was deleted mid-flight). Treat it
        // as exhaustion so the ticket is still surfaced rather than silently
        // stuck waiting on a retry that never launched.
        this.logService.warn('Actions', `retry re-dispatch failed for run ${run.id}: ${e?.message || e}`);
      }
      // 예약 해제 (티켓 fc3906c5, 리뷰 P1-1). 재시도 행이 생겼으면 그 running
      // run 이 이제 배치를 붙들므로 해제해도 창이 열리지 않는다. 재시도가 아예
      // 못 떴으면 붙들 것이 없으니 반드시 풀어야 배치가 영영 미완으로 남지
      // 않는다(그 경우 아래에서 exhausted 로 이어진다).
      await this.runRepo.update({ id: run.id }, { retry_pending: false });
      run.retry_pending = false;
      if (retryRunId) {
        await this._postRunComment(
          sourceTicketId, run.workspace_id, actor,
          `⚠️ Action **${actionName}** run \`${run.id.slice(0, 8)}\` failed` +
          `${summary ? ` — ${summary}` : ''}. Retrying (attempt ${nextAttempt}/${ActionsService.MAX_RUN_ATTEMPTS}, run \`${retryRunId.slice(0, 8)}\`).`,
        );
        return {
          run, sourceTicketId, status: 'failed',
          previouslyCompleted: false, retried: true, retryRunId, exhausted: false,
          shouldResume: false,
        };
      }
    }

    // High-impact failure (no auto-retry) or the retry cap reached (or a
    // re-dispatch that could not launch): surface + resume so a human decides.
    //
    // fan-out 배치라면 이 에이전트가 최종 실패했다는 사실만으로 티켓을 재개하지
    // 않는다 (티켓 fc3906c5) — 아직 도는 형제 run이 있으면 그쪽 결과까지 모아
    // 마지막 run이 요약과 함께 한 번만 재개한다. 실패는 그 요약에 명시된다.
    const surface = highImpact
      ? `❌ HIGH-IMPACT Action **${actionName}** run \`${run.id.slice(0, 8)}\` failed` +
        `${summary ? ` — ${summary}` : ''}. NOT auto-retried (a blind re-run could double a deploy/publish effect). ` +
        `Resuming this ticket: verify whether the external operation actually landed, then re-run **${actionName}** ` +
        `(idempotency key \`${run.idempotency_key || 'n/a'}\`) or \`pend_ticket\` with a specific \`no_action_reason\` if it needs a human.`
      : `❌ Action **${actionName}** run \`${run.id.slice(0, 8)}\` failed after ${run.attempt} attempt(s)` +
        `${summary ? ` — ${summary}` : ''}. Resuming this ticket so the assignee can fix the inputs and retry, ` +
        `or \`pend_ticket\` with a specific \`no_action_reason\` if it genuinely needs a human.`;
    const gate = await this._resolveBatchResume(run, actionName, actor, sourceTicketId, surface);
    if (!gate.shouldResume) {
      return {
        run, sourceTicketId, status: 'failed',
        previouslyCompleted: false, retried: false, retryRunId: '', exhausted: true,
        shouldResume: false,
      };
    }
    await this._postRunComment(sourceTicketId, run.workspace_id, actor, gate.comment);
    return {
      run, sourceTicketId, status: 'failed',
      previouslyCompleted: false, retried: false, retryRunId: '', exhausted: true,
      shouldResume: true,
    };
  }

  /**
   * 배치 재개 게이트 (티켓 fc3906c5) — "지금 이 run의 종료로 소스 티켓을 재개해도
   * 되는가", 그리고 그때 티켓에 남길 코멘트를 결정한다.
   *
   * 세 갈래:
   *   1. `batch_id`가 없는 레거시 run, 또는 배치 크기가 1(단일 대상) — fan-out
   *      이전과 **완전히 동일**하게 즉시 재개하고, 코멘트도 호출자가 만든
   *      단일 run 문구를 그대로 쓴다.
   *   2. 배치에 아직 `running`인 run이 남아 있음 — 재개하지 않는다. 대신 이
   *      에이전트의 결과만 진행 상황 코멘트로 남겨 운영자가 중간 상태를 볼 수
   *      있게 한다.
   *   3. 이 run이 배치의 마지막 — 1회성 클레임을 따낸 쪽만 재개하고, 에이전트별
   *      최종 결과를 모은 요약 코멘트를 돌려준다(부분 실패 포함).
   *
   * `singleComment`는 (1)에서 쓸 기존 문구다. 성공 경로는 넘기지 않고 여기서
   * 만든다(예전 문구와 동일하게 재구성).
   */
  private async _resolveBatchResume(
    run: ActionRun,
    actionName: string,
    actor: { type: string; id: string; name: string },
    sourceTicketId: string,
    singleComment?: string,
  ): Promise<{ shouldResume: boolean; comment: string }> {
    const succeededComment =
      `✅ Action **${actionName}** run \`${run.id.slice(0, 8)}\` succeeded` +
      `${run.result_summary ? ` — ${run.result_summary}` : ''}. Resuming this ticket.`;
    const soloComment = singleComment ?? succeededComment;

    const batchId = (run.batch_id || '').trim();
    if (!batchId) return { shouldResume: true, comment: soloComment };

    const siblings = await this.runRepo.find({
      where: { batch_id: batchId, workspace_id: run.workspace_id },
    });
    // 배치를 못 찾거나 나 혼자면 단일 run과 동일하게 처리한다.
    const agentIds = new Set(siblings.map((r) => r.agent_id || ''));
    if (siblings.length <= 1 || agentIds.size <= 1) {
      return { shouldResume: true, comment: soloComment };
    }

    // 아직 안 끝난 것 = 실행 중인 run + **재시도가 예약된 run** (리뷰 P1-1).
    // 후자를 빼면 실패 확정과 재시도 행 삽입 사이의 창에서 배치가 완료된 것처럼
    // 보여 조기 재개가 난다.
    const stillRunning = siblings.filter(
      (r) => (r.status || 'running') === 'running' || r.retry_pending === true,
    );
    if (stillRunning.length > 0) {
      // 아직 미완 — 이 에이전트 결과만 진행 상황으로 남긴다.
      const who = await this._agentLabel(run.agent_id);
      const icon = run.status === 'succeeded' ? '✅' : '❌';
      await this._postRunComment(
        sourceTicketId, run.workspace_id, actor,
        `${icon} Action **${actionName}** — ${who} ${run.status === 'succeeded' ? '성공' : '실패'}` +
        `${run.result_summary ? ` — ${run.result_summary}` : ''}. ` +
        `배치의 남은 ${stillRunning.length}건이 끝나면 결과를 모아 이 티켓을 재개합니다.`,
      );
      return { shouldResume: false, comment: '' };
    }

    // 마지막 run — 재개 권한을 1회성으로 확보한다. affected > 0 인 쪽만 이긴다.
    const claim = await this.runRepo
      .createQueryBuilder()
      .update(ActionRun)
      .set({ batch_resume_claimed: true })
      .where('batch_id = :b', { b: batchId })
      .andWhere('workspace_id = :ws', { ws: run.workspace_id })
      .andWhere('batch_resume_claimed = :claimed', { claimed: false })
      .execute();
    if ((claim.affected ?? 0) <= 0) {
      // 다른 형제가 이미 재개를 가져갔다(또는 드라이버가 affected를 안 채웠다).
      // 종료 전이와 같은 fail-closed 자세 — 재개를 중복시키느니 건너뛴다.
      return { shouldResume: false, comment: '' };
    }

    return { shouldResume: true, comment: await this._renderBatchSummary(actionName, siblings) };
  }

  /**
   * 에이전트별 **최종** 결과를 모은 배치 요약. 전체 성공 / 부분 실패 / 전체
   * 실패를 구분해 첫 줄에 적는다.
   *
   * 같은 에이전트에 run이 여럿이면(재시도 체인) `attempt`가 가장 큰 것이 그
   * 에이전트의 최종 결과다. `created_at`이 아니라 `attempt`로 고르는 이유는
   * 재시도가 항상 attempt+1로 생성돼 배치·에이전트 안에서 유일하고 단조라,
   * 같은 타임스탬프가 몰려도 판정이 흔들리지 않기 때문이다.
   */
  private async _renderBatchSummary(actionName: string, siblings: ActionRun[]): Promise<string> {
    const latestByAgent = new Map<string, ActionRun>();
    for (const r of siblings) {
      const key = r.agent_id || '';
      const prev = latestByAgent.get(key);
      if (!prev || (r.attempt ?? 1) > (prev.attempt ?? 1)) latestByAgent.set(key, r);
    }
    const finals = [...latestByAgent.entries()];
    const labels = await this._agentLabelMap(finals.map(([agentId]) => agentId));

    const okCount = finals.filter(([, r]) => r.status === 'succeeded').length;
    const total = finals.length;
    const headline = okCount === total
      ? `✅ Action **${actionName}** — 대상 ${total}개 에이전트 전체 성공`
      : okCount === 0
        ? `❌ Action **${actionName}** — 대상 ${total}개 에이전트 전체 실패`
        : `⚠️ Action **${actionName}** — 부분 실패 (${okCount}/${total} 성공)`;

    const lines = finals.map(([agentId, r]) => {
      const icon = r.status === 'succeeded' ? '✅' : '❌';
      const who = labels.get(agentId) || '(에이전트 기록 없음)';
      const attemptNote = (r.attempt ?? 1) > 1 ? ` (${r.attempt}회 시도)` : '';
      return `- ${icon} ${who}${attemptNote} — \`${r.id.slice(0, 8)}\`${r.result_summary ? `: ${r.result_summary}` : ''}`;
    });

    return `${headline}\n\n${lines.join('\n')}\n\n이 티켓을 재개합니다.`;
  }

  /** 단일 에이전트의 `<Manager>/<Agent>` 표시명 (없으면 정직하게 표기). */
  private async _agentLabel(agentId: string): Promise<string> {
    const labels = await this._agentLabelMap([agentId]);
    return labels.get(agentId || '') || '(에이전트 기록 없음)';
  }

  /**
   * agent id → `<Manager>/<Agent>` 표시명 배치 조회.
   * `.claude/skills/awb-agent-display-name` 계약대로 bare name을 쓰지 않는다 —
   * 같은 leaf 이름이 여러 매니저 아래 정당하게 존재하므로 접두사가 없으면
   * 어느 호스트가 실행했는지 구분할 수 없고, 그게 이 티켓의 핵심 요구사항이다.
   */
  private async _agentLabelMap(agentIds: string[]): Promise<Map<string, string>> {
    const ids = agentIds.filter(Boolean);
    if (ids.length === 0) return new Map();
    try {
      return await resolveAgentDisplayNamesByIds(this.agentRepo, ids);
    } catch {
      return new Map();
    }
  }

  /** Post a `note` comment on the source ticket recording a run outcome. */
  private async _postRunComment(
    ticketId: string,
    workspaceId: string,
    actor: { type: string; id: string; name: string },
    content: string,
  ): Promise<void> {
    try {
      await this.commentRepo.save(this.commentRepo.create({
        workspace_id: workspaceId,
        ticket_id: ticketId,
        author_type: actor.type === 'user' ? 'user' : 'agent',
        author_id: actor.id || '',
        author: actor.name || 'Action Runner',
        content,
        type: 'note',
        metadata: JSON.stringify({ source: 'action_run' }),
      }));
    } catch (e: any) {
      // Best-effort audit surface — a missed comment must not block the resume.
      this.logService.warn('Actions', `run-outcome comment failed for ticket ${ticketId}: ${e?.message || e}`);
    }
  }

  /**
   * Audit row for a run completion. Written directly (not via ActivityService)
   * with a bespoke `action` string so it does NOT re-enter the trigger loop as
   * a comment/update event — the explicit `dispatchCurrentColumn` resume is the
   * single, deliberate wake, and this row is audit-only.
   */
  private async _logRunActivity(
    ticketId: string,
    run: ActionRun,
    actor: { id: string; name: string },
    status: string,
    summary: string,
  ): Promise<void> {
    try {
      await this.activityRepo.save(this.activityRepo.create({
        // Source workspace (reviewer req 3) — the run's workspace is the source
        // ticket's workspace (enforced at dispatch), so the audit row is visible
        // in the workspace activity feed instead of defaulting to '' (which hid
        // it from every workspace-scoped query).
        workspace_id: run.workspace_id,
        entity_type: 'ticket',
        entity_id: ticketId,
        ticket_id: ticketId,
        actor_id: actor.id || 'system',
        actor_name: actor.name || 'Action Runner',
        action: 'action_run_completed',
        field_changed: 'action_run',
        old_value: run.action_id,
        new_value: `${status}:${run.id}:attempt=${run.attempt}${summary ? `:${summary.slice(0, 200)}` : ''}`,
        trigger_source: 'action_run',
      }));
    } catch (e: any) {
      this.logService.warn('Actions', `run-completion audit write failed for ticket ${ticketId}: ${e?.message || e}`);
    }
  }

  /**
   * Park the source ticket for human approval (ticket 524bb434, scope 5) when an
   * agent tried to auto-run a high-impact Action without an approver. Sets
   * `pending_user_action` with a concrete reason and writes an audit row so the
   * pend is attributable to the approval gate (not a generic agent pend). This
   * is the "승인이 반드시 필요한 경우만 Pending" path — the ticket parks precisely
   * because a human decision (approval) is required. Best-effort: a failed park
   * must still surface the rejection error to the caller.
   */
  private async _parkForApproval(ticketId: string, action: Action, byAgentId: string): Promise<void> {
    // Terminal-aware gate (ticket ec498050): a ticket already Done never gets
    // a human looking at its User tab again, so pending it here would strand
    // it — the run rejection above (thrown to the caller) already blocks the
    // unapproved execution regardless of whether we park the ticket too.
    // Must actually LOAD the ticket first — the loader resolves column_id off
    // whatever ticket-shaped object it's given, and this method only starts
    // with a bare id string.
    try {
      const ticketForGate = await this.ticketRepo.findOne({ where: { id: ticketId } });
      const col = ticketForGate ? await loadTicketColumnForPendGate(this.ticketRepo, this.columnRepo, ticketForGate) : null;
      if (!evaluateTerminalPendGate(col).allowed) {
        this.logService.info('Actions', 'park-for-approval skipped, ticket already terminal', { ticket_id: ticketId });
        return;
      }
    } catch (e: any) {
      this.logService.warn('Actions', `terminal-pend-gate column resolution failed (failing open) for ticket ${ticketId}: ${e?.message || e}`);
    }

    const reason =
      `High-impact Action "${action.name}" requires human approval before it can run. ` +
      `A workspace admin must approve it via POST /api/actions/${action.id}/approvals (or the Actions UI), ` +
      `or perform the operation manually — the server will not let an agent auto-execute a deploy/publish/release.`;
    try {
      await this.ticketRepo.update(
        { id: ticketId },
        {
          pending_user_action: true,
          pending_reason: reason,
          pending_set_at: new Date(),
          pending_set_by: 'action_approval_gate',
        },
      );
      await this.activityRepo.save(this.activityRepo.create({
        workspace_id: action.workspace_id,
        entity_type: 'ticket',
        entity_id: ticketId,
        ticket_id: ticketId,
        actor_id: byAgentId || 'system',
        actor_name: 'Action Approval Gate',
        action: 'action_run_pending_approval',
        field_changed: 'pending_user_action',
        old_value: action.id,
        new_value: `high_impact:${action.name}`,
        trigger_source: 'action_approval_gate',
      }));
    } catch (e: any) {
      this.logService.warn('Actions', `park-for-approval failed for ticket ${ticketId}: ${e?.message || e}`);
    }
  }

  /** Audit row recording who approved a high-impact run and when (scope 5). */
  private async _logApprovalActivity(
    ticketId: string,
    action: Action,
    run: ActionRun,
    approval: { userId: string; userName: string; at: Date },
  ): Promise<void> {
    try {
      await this.activityRepo.save(this.activityRepo.create({
        workspace_id: action.workspace_id,
        entity_type: 'ticket',
        entity_id: ticketId,
        ticket_id: ticketId,
        actor_id: approval.userId,
        actor_name: approval.userName || 'Approver',
        action: 'action_run_approved',
        field_changed: 'action_run',
        old_value: action.id,
        new_value: `approved:${run.id}:by=${approval.userId}`,
        trigger_source: 'action_approval_gate',
      }));
    } catch (e: any) {
      this.logService.warn('Actions', `approval audit write failed for ticket ${ticketId}: ${e?.message || e}`);
    }
  }

  // ── Approval grants (ticket 524bb434, scope 5) ───────────────────────────

  /**
   * Create a human approval GRANT for a high-impact Action run.
   *
   * This is the ONLY way an approval comes into existence, and it is reachable
   * only from the session-authenticated REST endpoint. The approver identity is
   * supplied by the CALLER from the authenticated session (`req.currentUser`),
   * NOT read from any request body — the controller passes `approverUserId` /
   * `approverRole` straight off the session. An agent authenticates with an MCP
   * API key and never has a session, so it cannot reach this method: that is the
   * trust boundary the reviewer required (caller-claims-approver ≠ real
   * approval evidence).
   *
   * The grant is bound to a single (action, source ticket) pair and is one-time
   * — `dispatch` atomically consumes it. Creating a grant also clears any
   * pending_user_action park the gate placed on the ticket, so the standing loop
   * can resume and re-run the Action (which now finds & consumes this grant).
   */
  async createApproval(args: CreateApprovalArgs): Promise<ActionApproval> {
    if (!args.workspaceId) throw makeError(400, 'workspace_id is required');
    if (!args.sourceTicketId) throw makeError(400, 'source_ticket_id is required');
    // Defence in depth: the REST guard already requires an admin session, but we
    // re-assert here so no future caller of the service can mint a grant as a
    // non-admin. Approval authority = admin role (workspace-scoped membership /
    // per-Action RBAC is an explicit follow-up, per the reviewer).
    if (!args.approverUserId) throw makeError(401, 'an authenticated approver is required');
    if (args.approverRole !== 'admin') {
      throw makeError(403, 'only an admin may approve a high-impact action run');
    }

    const action = await findOrFail(
      this.actionRepo,
      { where: { id: args.actionId, workspace_id: args.workspaceId } },
      'Action not found in workspace',
    );
    // Only high-impact Actions are gated, so only they need a grant. Rejecting an
    // approval for a benign Action keeps the surface honest (no dangling grants
    // that would never be consumed) and matches the same effective classification
    // the gate uses (explicit flag OR name heuristic).
    if (!isHighImpactAction(action)) {
      throw makeError(400, 'this action is not high-impact and does not require approval to run');
    }

    // Bind to a real ticket in the same workspace (mirrors the dispatch boundary).
    const ticket = await this.ticketRepo.findOne({ where: { id: args.sourceTicketId } });
    if (!ticket) throw makeError(404, 'source ticket not found');
    if (ticket.workspace_id !== action.workspace_id) {
      throw makeError(400, 'source ticket belongs to a different workspace than the action');
    }

    const ttl = typeof args.ttlMinutes === 'number' && args.ttlMinutes > 0
      ? Math.floor(args.ttlMinutes)
      : ActionsService.APPROVAL_TTL_MINUTES;
    const now = new Date();
    const grant = await this.approvalRepo.save(this.approvalRepo.create({
      workspace_id: action.workspace_id,
      action_id: action.id,
      source_ticket_id: args.sourceTicketId,
      approved_by: args.approverUserId,
      approved_by_name: args.approverName || '',
      status: 'pending',
      consumed_by_run_id: '',
      consumed_at: null,
      expires_at: new Date(now.getTime() + ttl * 60_000),
    }));

    // Audit the grant creation on the source ticket, attributed to the real human
    // approver, so "an admin approved X for ticket Y at T" is reconstructable.
    try {
      await this.activityRepo.save(this.activityRepo.create({
        workspace_id: action.workspace_id,
        entity_type: 'ticket',
        entity_id: args.sourceTicketId,
        ticket_id: args.sourceTicketId,
        actor_id: args.approverUserId,
        actor_name: args.approverName || 'Approver',
        action: 'action_run_approval_granted',
        field_changed: 'action_approval',
        old_value: action.id,
        new_value: `grant:${grant.id}:by=${args.approverUserId}`,
        trigger_source: 'action_approval_gate',
      }));
    } catch (e: any) {
      this.logService.warn('Actions', `approval-grant audit write failed for ticket ${args.sourceTicketId}: ${e?.message || e}`);
    }

    // Release the approval park (if the gate placed one) so the ticket's standing
    // loop resumes and the assignee re-runs the Action — which now finds and
    // consumes this grant. Only clear a park the approval gate itself set, so we
    // don't stomp an unrelated human pend.
    try {
      if (ticket.pending_user_action && ticket.pending_set_by === 'action_approval_gate') {
        await this.ticketRepo.update(
          { id: args.sourceTicketId },
          { pending_user_action: false, pending_reason: '', pending_set_at: null, pending_set_by: '' },
        );
      }
    } catch (e: any) {
      this.logService.warn('Actions', `approval unpend failed for ticket ${args.sourceTicketId}: ${e?.message || e}`);
    }

    this.logService.info('Actions', `approval grant ${grant.id} created for action ${action.id} ticket ${args.sourceTicketId} by ${args.approverUserId}`);
    return grant;
  }

  /** List approval grants for an action (most recent first) — audit visibility. */
  async listApprovals(actionId: string, workspaceId: string, limit = 20): Promise<ActionApproval[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    await findOrFail(this.actionRepo, { where: { id: actionId, workspace_id: workspaceId } }, 'Action not found in workspace');
    return this.approvalRepo.find({
      where: { action_id: actionId, workspace_id: workspaceId },
      order: { created_at: 'DESC' },
      take: Math.min(limit, 100),
    });
  }

  /**
   * Atomically consume a pending, unexpired approval grant bound to
   * (actionId, sourceTicketId), stamping the run that consumed it. Returns the
   * approver attribution to copy onto the run, or null when no usable grant
   * exists (→ the gate rejects + parks).
   *
   * Consume is a find-candidate-then-guarded-UPDATE-by-id: two racing dispatches
   * for the same grant both target the same id, but the `WHERE status='pending'`
   * guard lets exactly one win (affected=1); the loser sees affected=0 and is
   * treated as unapproved — the one-time-use guarantee under concurrency.
   */
  private async _consumeApproval(
    actionId: string,
    workspaceId: string,
    sourceTicketId: string,
    runId: string,
  ): Promise<{ userId: string; userName: string; at: Date } | null> {
    const now = new Date();
    // Walk pending grants oldest-first, but an expired grant must NOT shadow a
    // newer still-valid one (reviewer blocker, ticket 524bb434). The previous
    // code fetched only the single OLDEST pending grant and, if it was expired,
    // retired it and gave up — so `expired A + valid B` on the same
    // (action, ticket) rejected a legitimately-approved run and re-parked the
    // ticket (the admin issuing B had already un-parked it, only for it to bounce
    // straight back). Instead we retire each expired candidate and keep scanning
    // in the SAME call until we consume a valid grant or run out. Every iteration
    // strictly shrinks the pending set — a candidate is retired, consumed, or a
    // racing dispatch already moved it off 'pending' — so the bounded loop always
    // terminates.
    const MAX_GRANT_SCAN = 100; // safety bound; a real (action,ticket) pair has very few grants
    for (let i = 0; i < MAX_GRANT_SCAN; i++) {
      const candidate = await this.approvalRepo.findOne({
        where: { action_id: actionId, workspace_id: workspaceId, source_ticket_id: sourceTicketId, status: 'pending' },
        order: { created_at: 'ASC' },
      });
      if (!candidate) return null; // no pending grant left → unapproved
      if (candidate.expires_at && candidate.expires_at.getTime() <= now.getTime()) {
        // Expired: retire it (guarded) so it stops being a candidate, then keep
        // scanning for a newer, still-valid grant rather than giving up here.
        await this.approvalRepo.update(
          { id: candidate.id, status: 'pending' },
          { status: 'expired' },
        );
        continue;
      }
      const claim = await this.approvalRepo
        .createQueryBuilder()
        .update(ActionApproval)
        .set({ status: 'consumed', consumed_at: now, consumed_by_run_id: runId })
        .where('id = :id', { id: candidate.id })
        .andWhere("status = 'pending'")
        .execute();
      if ((claim.affected ?? 0) <= 0) continue; // lost the race → this grant is no longer pending; try the next
      // Attribution comes FROM the grant record (the real human), not the caller:
      // the audit/time can never be forged by whoever triggered the dispatch.
      return { userId: candidate.approved_by, userName: candidate.approved_by_name, at: candidate.created_at };
    }
    return null; // scan bound exhausted → fail-closed (treat as unapproved)
  }

  /**
   * Dispatch a Run: create the room, add participants, FIFO-prune, render the
   * prompt, send it as the triggering user's first message. The agent reply
   * arrives later via the existing chat_room_message → agent-manager pipeline.
   */
  async dispatch(args: DispatchActionArgs): Promise<DispatchActionResult> {
    const action = await findOrFail(this.actionRepo, { where: { id: args.actionId } }, 'Action not found');
    // Run-creation-rate ceiling (ticket a51ec6d9) — head of the chokepoint,
    // before any side effect below. Workspace-scoped; throws 429 on breach.
    // Placed INSIDE dispatch() (not around the retry call site in
    // completeRun) so a retry that trips this guard is naturally caught by
    // completeRun's existing try/catch and treated as exhaustion — no
    // separate retry-bypass flag needed (ticket a51ec6d9 plan "정정 2").
    //
    // fan-out(티켓 fc3906c5) 이후에도 이 호출은 여기 남는다. run 한 건당 실제
    // 계수는 `_dispatchOne`이 하지만(대상 N개 = run N개 = 예산 N 소모), 이
    // 헤드 체크는 **승인 grant를 소모하기 전에** fail-fast 하는 역할이 따로
    // 있다: 이미 상한을 넘긴 상태에서 아래 승인 게이트를 통과시키면
    // 일회용 grant만 태우고 run은 한 건도 못 만든 채 끝나, 사람이 승인을 다시
    // 발급해야 하는 상태로 빠진다.
    await enforceRunBudget(
      { dataSource: this.dataSource, roomMessagingService: this.messaging, logger: this.logService },
      'action',
      action.workspace_id,
    );

    // ── 대상 해석 (티켓 fc3906c5) ────────────────────────────────────────
    // 대상은 Action 정의에 선언적으로 고정돼 있고, 그 수가 1이 아니라 N일 수
    // 있다. `onlyAgentIds`는 completeRun의 재시도가 **실패한 그 에이전트만**
    // 다시 돌리기 위해 쓰는 필터다 — 재시도가 배치 전체를 다시 fan-out 하면
    // 이미 성공한 에이전트에서 외부 작업이 두 번 실행된다.
    const allTargets = actionTargetAgentIds(action);
    if (allTargets.length === 0) throw makeError(400, 'Action has no target agent set');
    const onlyFilter = normalizeTargetAgentIds(args.onlyAgentIds);
    const targets = onlyFilter.length > 0
      ? allTargets.filter((id) => onlyFilter.includes(id))
      : allTargets;
    if (targets.length === 0) {
      throw makeError(400, 'none of the requested agents is a target of this action');
    }

    // 대상 에이전트 행을 미리 다 읽는다. 없어진 대상은 **그 대상만** 실패로
    // 격리한다 (티켓 fc3906c5, 리뷰 P1-2). 예전에는 하나라도 없으면 전체를
    // throw 했는데, 그러면 운영자가 대상 5개 중 1개를 지운 순간 나머지 4개까지
    // 영영 안 돌아 "한 에이전트가 실패해도 나머지는 정상 완료" 기준을 깬다.
    // 다만 **하나도 남지 않으면** 던진다 — 할 일이 없고, 승인 grant 도 아직
    // 태우지 않은 상태라 fail-fast 가 안전하다.
    const agents: Agent[] = [];
    const missingTargets: string[] = [];
    for (const agentId of targets) {
      const found = await this.agentRepo.findOne({ where: { id: agentId } });
      if (found) agents.push(found);
      else missingTargets.push(agentId);
    }
    if (agents.length === 0) {
      throw makeError(400, `no target agent of this action exists any more: ${missingTargets.join(', ')}`);
    }

    // Source-ticket workspace boundary (ticket 524bb434, reviewer req 1). When
    // a ticket dispatches this run, the ticket MUST exist and live in the same
    // workspace as the Action. Without this a caller could link an Action run
    // to a ticket in another workspace and, via `complete_action_run`, drive
    // cross-workspace comments / re-dispatch. Validated here at dispatch so the
    // persisted `source_ticket_id` is always trustworthy — `completeRun` reads
    // it back off the run row and never re-derives it from caller input.
    const sourceTicketId = (args.sourceTicketId || '').trim();
    if (sourceTicketId) {
      const sourceTicket = await this.ticketRepo.findOne({ where: { id: sourceTicketId } });
      if (!sourceTicket) throw makeError(404, 'source ticket not found');
      if (sourceTicket.workspace_id !== action.workspace_id) {
        throw makeError(400, 'source ticket belongs to a different workspace than the action');
      }
    }

    // Pre-allocate the run's UUID up front (ticket 524bb434): the approval gate
    // below stamps it onto the consumed grant, {{run.id}} resolves before any DB
    // write, and we save the ActionRun row exactly once with every field
    // populated. The previous flow saved a half-empty scaffold first (room_id:
    // '', prompt_rendered: '') to grab tempRun.id, then patched those two columns
    // in a second save. That broke on production.private after commit d971fa1
    // widened action_runs.room_id from varchar to uuid — Postgres rejects '' with
    // `invalid input syntax for type uuid: ""`. Generating the id here lets us
    // write a complete row up front and avoid the empty-string sentinel entirely.
    //
    // fan-out이면 대상마다 하나씩 미리 발급한다. 승인 grant에 찍는 값은 여전히
    // **첫 run의 id**다(아래) — 단일 대상일 때 fan-out 이전과 완전히 같은 값이
    // 남고, fan-out이어도 그 run의 batch_id로 나머지를 다 찾을 수 있다.
    const runIds = agents.map(() => randomUUID());
    // 같은 트리거에서 나온 run들을 묶는 배치 키. 대상이 하나뿐이어도 크기 1짜리
    // 배치를 발급해 경로를 하나로 유지한다. 재시도는 원래 배치를 승계한다.
    const batchId = (args.batchId || '').trim() || randomUUID();

    // ── High-impact pre-execution approval gate (ticket 524bb434, scope 5) ──
    // A high-impact Action (explicit flag OR name heuristic) has irreversible
    // external effects, so an AGENT clearing a ticket blocker may NOT auto-run
    // it — a real workspace admin must have approved it. Only the ticket-driven
    // agent/system path is gated: a human-clicked UI run (type='user') is itself
    // the approval, and standing scheduler/hook runs carry no source ticket.
    //
    // Crucially the dispatch caller does NOT get to assert who approved. The
    // server atomically CONSUMES a human-created ActionApproval grant bound to
    // this exact (action, source ticket) pair — a grant that only exists via the
    // session-authenticated `createApproval` path an agent can never reach. No
    // usable grant ⇒ the run is rejected BEFORE any external side effect and the
    // source ticket is parked (pending_user_action) so approval — not silent
    // auto-execution — is what unblocks it (completion criterion: "승인이 반드시
    // 필요한 경우만 Pending"). On consume, the run's approver/time are copied FROM
    // the grant (the real human), so the audit attribution can't be forged.
    //
    // 승인 범위 = **트리거 1회 = 승인 1회**(티켓 fc3906c5). grant는 이미
    // `(action, source_ticket)` 단위라 배치 경계와 자연히 일치하므로, 여기서
    // 한 번 소모한 결과를 배치의 모든 run이 공유한다. 에이전트별로 grant를
    // 요구하면 운영자가 같은 배포를 호스트 수만큼 승인해야 하고, 그 사이
    // 일부만 승인된 어중간한 상태가 생긴다.
    const highImpact = isHighImpactAction(action);
    let approval: { userId: string; userName: string; at: Date } | null = null;
    if (sourceTicketId && highImpact && args.triggeredByType !== 'user') {
      approval = await this._consumeApproval(action.id, action.workspace_id, sourceTicketId, runIds[0]);
      if (!approval) {
        await this._parkForApproval(sourceTicketId, action, args.triggeredById);
        throw makeError(
          403,
          `Action "${action.name}" is high-impact and requires explicit human approval before it can run. ` +
          `The source ticket has been set to pending_user_action — a workspace admin must approve it via ` +
          `POST /api/actions/${action.id}/approvals (or the Actions UI) or handle the operation manually. ` +
          `An agent cannot approve its own high-impact deploy/publish/release.`,
        );
      }
    }

    // Recovery semantics for a post-consume dispatch failure (reviewer non-blocker
    // observation, ticket 524bb434): the grant is consumed ABOVE, before the room /
    // ActionRun / first-message side effects below. This ordering is deliberate and
    // fail-CLOSED — for an irreversible high-impact operation we never want to risk
    // double-consuming a grant or silently re-running the op, so consume happens
    // first and stays committed. If any step below throws, the grant remains
    // `consumed` (not auto-reverted) and the run never starts: the next attempt
    // finds no pending grant and re-parks the ticket, so a human must issue a FRESH
    // approval to retry. That "burned grant ⇒ re-approval required" recovery is the
    // same path CASE 12 pins (a consumed grant cannot be reused → rejected + re-park).

    // Build a render context the user can interpolate against. Resolve the
    // optional pieces best-effort — missing fields render as empty string in
    // the template, which is friendlier than failing the whole Run.
    // 배치 공통 조각이라 루프 밖에서 한 번만 읽는다(대상 N개여도 쿼리는 1회씩).
    const workspace = await this.workspaceRepo.findOne({ where: { id: action.workspace_id } });
    const board = args.ticketContext?.board_id
      ? await this.boardRepo.findOne({ where: { id: args.ticketContext.board_id } })
      : null;
    const user = args.triggeredByType === 'user' && args.triggeredById
      ? await this.userRepo.findOne({ where: { id: args.triggeredById } })
      : null;

    // ── fan-out 루프 ────────────────────────────────────────────────────
    // 대상마다 독립적으로 디스패치하고, **한 대상의 실패가 나머지를 막지 않게**
    // per-agent try/catch로 감싼다(선례: on-ticket-done-action.service.ts의
    // per-action 루프). 오프라인/삭제된 에이전트, 방 생성 실패, 예산 초과가
    // 모두 여기로 떨어져 그 에이전트만 failures[]에 남는다.
    const runs: DispatchedRun[] = [];
    const failures: DispatchFailure[] = [];
    const fanOut = allTargets.length > 1;

    // 조회 단계에서 사라진 대상도 배치의 terminal 기록으로 남긴다 — 그래야
    // 실행 이력이 이 배치를 "부분 실패"로 집계한다 (리뷰 P1-2).
    for (const agentId of missingTargets) {
      const message = `target agent not found: ${agentId}`;
      failures.push({ agent_id: agentId, error: message });
      await this._recordFailedTarget({
        action, agentId, batchId, sourceTicketId, args, error: message,
      });
    }

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      try {
        runs.push(await this._dispatchOne({
          action, agent, args, workspace, board, user,
          runId: runIds[i],
          batchId,
          sourceTicketId,
          approval,
          highImpact,
          fanOut,
        }));
      } catch (e: any) {
        const message = String(e?.message || e);
        failures.push({ agent_id: agent.id, error: message });
        this.logService.warn('Actions', 'fan-out dispatch failed for one agent (continuing)', {
          action_id: action.id, agent_id: agent.id, batch_id: batchId, err: message,
        });
        // 디스패치에 실패한 대상도 terminal run 으로 남긴다 (리뷰 P1-2).
        // 남기지 않으면 실행 이력은 저장된 성공 run 만 집계해 실제 부분 실패를
        // "전체 성공" 으로 표시하고, "대상 각각에 독립 ActionRun 생성" 기준도
        // 충족하지 못한다.
        await this._recordFailedTarget({
          action, agentId: agent.id, batchId, sourceTicketId, args, error: message,
        });
      }
    }

    // 전원 실패면 던진다 — 호출부(스케줄러, 재시도, MCP)는 예전부터 "디스패치
    // 실패는 throw"를 전제로 try/catch 하고 있고, 성공한 run이 하나도 없는데
    // 성공처럼 반환하면 그 계약이 조용히 깨진다. 첫 실패 사유를 그대로 올려
    // 단일 대상 Action에서는 메시지가 fan-out 이전과 같게 유지된다.
    if (runs.length === 0) {
      const detail = failures.map((f) => `${f.agent_id}: ${f.error}`).join('; ');
      throw makeError(502, failures.length === 1 ? failures[0].error : `all ${failures.length} targets failed to dispatch — ${detail}`);
    }

    // Update Action.last_run_at so the scheduler doesn't double-fire on the
    // same minute boundary. 배치당 한 번(run마다가 아니라).
    await this.actionRepo.update(action.id, { last_run_at: new Date() });

    // FIFO prune: drop rooms beyond max_runs, oldest first. Run AFTER we
    // saved the new rooms so we never accidentally delete one we just created.
    await this._pruneOldRuns(action.id, action.max_runs);

    if (fanOut) {
      this.logService.info('Actions', `fan-out dispatched action ${action.id} batch ${batchId} — ${runs.length} ok, ${failures.length} failed`);
    }

    const first = runs[0];
    return {
      // 하위 호환 키: 첫 성공 run. 단일 대상 Action에서는 fan-out 이전과 동일.
      run: first.run,
      room_id: first.room_id,
      prompt: first.prompt,
      batch_id: batchId,
      runs,
      failures,
    };
  }

  /**
   * 디스패치에 실패한 대상을 배치의 **terminal ActionRun 행**으로 남긴다
   * (티켓 fc3906c5, 리뷰 P1-2).
   *
   * 이 행이 없으면 실행 이력이 성공 run 만 보고 배치를 "전체 성공" 으로
   * 집계한다 — 실제로는 그 호스트에서 아무것도 실행되지 않았는데도. 배치 재개
   * 판정도 이 행을 세므로, 실패 대상이 기록돼야 요약의 x/N 분모가 맞는다.
   *
   * `room_id` 는 null 이다: 예산 초과나 삭제된 에이전트처럼 방을 만들기 **전에**
   * 끝난 실패라 붙일 방이 없다. Postgres 에서 이 컬럼은 uuid 라 '' 를 쓸 수 없어
   * 컬럼을 nullable 로 열었다.
   *
   * 기록 자체가 실패해도 삼킨다 — 감사 행 하나 때문에 나머지 대상의 디스패치를
   * 막는 것은 본말전도다(다른 best-effort 감사 경로와 같은 자세).
   */
  private async _recordFailedTarget(input: {
    action: Action;
    agentId: string;
    batchId: string;
    sourceTicketId: string;
    args: DispatchActionArgs;
    error: string;
  }): Promise<void> {
    const { action, agentId, batchId, sourceTicketId, args, error } = input;
    try {
      await this.runRepo.save(this.runRepo.create({
        id: randomUUID(),
        action_id: action.id,
        workspace_id: action.workspace_id,
        agent_id: agentId,
        batch_id: batchId,
        room_id: null,
        triggered_by_type: args.triggeredByType,
        triggered_by_id: args.triggeredById || '',
        prompt_rendered: '',
        source_ticket_id: sourceTicketId,
        idempotency_key: '',
        // 프롬프트가 전달된 적이 없으므로 완료 계약도 주입되지 않았다. false 라
        // ActionRunReaperService 후보에도 들지 않는다(애초에 terminal 이라 무관).
        completion_contract_injected: false,
        approved_by: '',
        approved_at: null,
        status: 'failed',
        result_summary: `dispatch failed: ${error}`.slice(0, 2000),
        attempt: typeof args.attempt === 'number' && args.attempt > 0 ? Math.floor(args.attempt) : 1,
        completed_at: new Date(),
      }));
    } catch (e: any) {
      this.logService.warn('Actions', 'failed-target audit row could not be written (continuing)', {
        action_id: action.id, agent_id: agentId, batch_id: batchId, err: String(e?.message || e),
      });
    }
  }

  /**
   * 대상 에이전트 **한 명**에 대한 실제 디스패치 (티켓 fc3906c5에서 `dispatch()`
   * 로부터 분해). 방 생성 → run 행 저장 → 참여자 등록 → 첫 메시지 전송까지가
   * 여기 있고, 배치 공통 판단(승인 소모, 대상 해석, 프루닝)은 호출자인
   * `dispatch()`에 남는다.
   *
   * 던지면 그 에이전트 하나만 실패로 기록되고 배치의 나머지는 계속 진행된다.
   */
  private async _dispatchOne(input: {
    action: Action;
    agent: Agent;
    args: DispatchActionArgs;
    workspace: Workspace | null;
    board: Board | null;
    user: User | null;
    runId: string;
    batchId: string;
    sourceTicketId: string;
    approval: { userId: string; userName: string; at: Date } | null;
    highImpact: boolean;
    /** 이 Action의 대상이 2개 이상인가 — 작업폴더를 에이전트별로 가를지 판단. */
    fanOut: boolean;
  }): Promise<DispatchedRun> {
    const { action, agent, args, workspace, board, user, runId, batchId, sourceTicketId, approval, highImpact, fanOut } = input;

    // run 단위 예산 계수 (티켓 fc3906c5). `dispatch()` 헤드 체크는 승인 소모
    // 전 fail-fast 용이고, 실제 계수는 여기서 run 하나당 한 번 일어난다 —
    // fan-out은 트리거 1회에 run N건이라 자원도 N배 쓰기 때문이다(방 N개,
    // 에이전트 spawn N회). 트리거 단위로 세면 fan-out이 폭주 위험을 가장 키우는
    // 지점에서 가드가 무력해진다. 배치 도중 상한을 넘으면 그 에이전트만 실패로
    // 남고 이미 만들어진 run은 정상 진행된다.
    await enforceRunBudget(
      { dataSource: this.dataSource, roomMessagingService: this.messaging, logger: this.logService },
      'action',
      action.workspace_id,
    );

    const ctx = buildRenderContext({
      workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
      board: board ? { id: board.id, name: board.name } : null,
      user: user ? { id: user.id, name: user.name, email: user.email } : null,
      agent: { id: agent.id, name: agent.name },
      action: { id: action.id, name: action.name },
      runId,
      ticket: args.ticketContext ?? null,
    });
    // 런-워크스페이스 프로비저닝 힌트 (티켓 9fd27487 — 비-티켓 실행 경로에는
    // 폴더 규칙이 아예 없었다). Action의 workspace_folder + repo_ref +
    // checkout_mode를 QA/security와 똑같은 방식으로(buildRunProvision) 구체적인
    // RunProvision으로 해석해서, agent-manager가 run subagent를 스폰하기 전에
    // `.awb/act/<leaf>`를 미리 준비하도록 한다 — working_dir 루트에서 그냥
    // 실행되던 것 대신. Action 자체는 고유한 board_id가 없지만(레거시로 항상
    // null — Action 엔티티 참고), 티켓 완료 훅(ticket-done-hook) 디스패치는
    // 위에서 여전히 `board`를 해석해두므로, 그 id를 넘기면 repo_ref가 비어있을
    // 때 그 board의 environment_config repo를 티켓 트리거와 동일하게 상속받을
    // 수 있다.
    //
    // fan-out 작업폴더 분리 (티켓 fc3906c5): 기본 폴더는 `.awb/act/<action8>`로
    // **action 단위**라, 같은 매니저 아래 두 에이전트가 fan-out되면 둘이 같은
    // 체크아웃을 공유해 서로의 작업 트리를 밟는다. 대상이 2개 이상일 때만 leaf에
    // 에이전트 접미사를 붙여 가른다 — 단일 대상 Action의 폴더는 글자 하나
    // 안 바뀌므로 기존 warm checkout이 그대로 유지된다.
    const workspaceFolder = fanOut
      ? agentScopedWorkspaceFolder(action.workspace_folder, action.id, agent.id)
      : action.workspace_folder;
    const runProvision = await buildRunProvision(this.dataSource, {
      kind: 'action',
      id: action.id,
      runId,
      workspaceId: action.workspace_id,
      boardId: board?.id ?? null,
      workspaceFolder,
      repoRef: action.repo_ref,
      checkoutMode: action.checkout_mode,
    });

    const renderedPrompt = renderActionPrompt(action.prompt || '', ctx);
    const withLanguage = prependBoardLanguageInstruction(renderedPrompt, board?.language);
    // Every run gets a completion contract appended so the target agent reports
    // its outcome via `complete_action_run` — without this, `status` never
    // leaves 'running' no matter how the run actually ended (ticket b273d603).
    // A ticket-driven run gets the resume/retry variant (that call is what
    // re-dispatches the source ticket); a run with no source ticket (human UI
    // trigger / cron / on-ticket-done) gets the standalone variant instead —
    // it has nothing to resume or retry, but its status still needs to settle.
    // Mint a run-level idempotency key on the first dispatch; retries pass the
    // failed run's key so the whole chain shares one (scope 5). Only ticket-
    // driven runs get a key — cron/manual runs never retry, so there is
    // nothing to dedupe against.
    //
    // 키는 **에이전트마다 따로** 발급한다 (티켓 fc3906c5). fan-out의 각 run은
    // 서로 다른 호스트에서 도는 서로 다른 작업이므로, 배치가 키를 공유하면
    // 대상 쪽 dedupe가 에이전트 B의 실행을 A의 재전송으로 오인해 건너뛸 수
    // 있다. 호출자가 넘긴 키는 대상이 정확히 하나로 좁혀졌을 때(= 재시도)만
    // 존중한다 — 그래야 그 에이전트의 재시도 체인이 하나의 키를 공유한다.
    const inheritedKey = normalizeTargetAgentIds(args.onlyAgentIds).length === 1
      ? (args.idempotencyKey || '').trim()
      : '';
    const idempotencyKey = sourceTicketId ? inheritedKey || randomUUID() : '';
    const rendered = sourceTicketId
      ? `${withLanguage}${renderCompletionContract(runId, action.workspace_id, sourceTicketId, idempotencyKey, highImpact)}`
      : `${withLanguage}${renderStandaloneCompletionContract(runId, action.workspace_id)}`;

    // Create the room. We use 'group' as the underlying type so the chat
    // controller's existing rules (rename, multi-participant, etc.) apply.
    // The action_id stamp is what differentiates Action runs from regular
    // chat groups in the list view. Created BEFORE the run row so we have
    // a real room.id to stamp on it.
    const room = await this.roomRepo.save(this.roomRepo.create({
      workspace_id: action.workspace_id,
      type: 'group',
      name: `Action: ${action.name} · ${runId.slice(0, 8)}`,
      action_id: action.id,
      last_message_at: null,
    }));

    // Now persist the run with every column filled in — one INSERT, no
    // placeholder columns, no second UPDATE.
    const tempRun = await this.runRepo.save(this.runRepo.create({
      id: runId,
      action_id: action.id,
      workspace_id: action.workspace_id,
      // 에이전트별 감사 + 배치 묶음 (티켓 fc3906c5). 재시도 run은 호출자가
      // 같은 batchId를 넘겨주므로 원래 배치를 승계한다.
      agent_id: agent.id,
      batch_id: batchId,
      room_id: room.id,
      triggered_by_type: args.triggeredByType,
      triggered_by_id: args.triggeredById || '',
      prompt_rendered: rendered,
      source_ticket_id: sourceTicketId,
      idempotency_key: idempotencyKey,
      // 위 `rendered`는 항상 완료 계약을 덧붙이므로(티켓 b273d603)
      // sourceTicketId가 있을 때만이 아니라 무조건 true로 세팅한다.
      // ActionRunReaperService의 후보 쿼리(티켓 2fa5312b)가 이 값을 읽어
      // source_ticket_id 없는 run도 스윕 범위에 들인다.
      completion_contract_injected: true,
      // Approval evidence for a high-impact run (scope 5). Empty/null unless the
      // approval gate above authorized it via a real admin approver.
      approved_by: approval?.userId || '',
      approved_at: approval?.at || null,
      status: 'running',
      attempt: typeof args.attempt === 'number' && args.attempt > 0 ? Math.floor(args.attempt) : 1,
    }));

    // Audit the approval on the source ticket so who/when is reconstructable
    // (reviewer req: approval status/approver/time auditable).
    if (approval) {
      await this._logApprovalActivity(sourceTicketId, action, tempRun, approval);
    }

    // Add participants directly (bypassing addParticipants' "caller must be a
    // member" check, which doesn't apply for system-initiated rooms).
    const joinedAt = new Date();
    const rows: ChatRoomParticipant[] = [];
    rows.push(this.participantRepo.create({
      room_id: room.id,
      participant_type: 'agent',
      participant_id: agent.id,
      last_read_at: joinedAt,
      left_at: null,
    }));
    if (user) {
      rows.push(this.participantRepo.create({
        room_id: room.id,
        participant_type: 'user',
        participant_id: user.id,
        last_read_at: joinedAt,
        left_at: null,
      }));
    }
    await this.participantRepo.save(rows);

    // `last_run_at` 갱신과 FIFO 프루닝은 배치당 한 번이므로 호출자(`dispatch()`)가
    // 루프를 마친 뒤 수행한다 — run마다 프루닝하면 같은 배치의 형제 run을
    // 방금 만들자마자 잘라낼 수 있다.

    // Send the rendered prompt as the user's first message — chat_room_message
    // is what the agent-manager listens on to route the prompt into the target
    // agent's chat session, no extra dispatcher needed.
    //
    // For non-user triggers (scheduler / agent caller) there is no real user to
    // send as. We synthesize a `participant_type='user'` row with id `'system'`
    // and name `'Scheduler'` so RoomMessagingService.requireActiveParticipant
    // passes — the chat infra only compares ids in the participant table, so
    // a non-UUID literal works.
    let senderType: 'user' | 'agent' = 'user';
    let senderId = args.triggeredById;
    let senderName = user?.name || user?.email || 'User';
    if (!user) {
      await this.participantRepo.save(this.participantRepo.create({
        room_id: room.id,
        participant_type: 'user',
        participant_id: 'system',
        last_read_at: joinedAt,
        left_at: null,
      }));
      senderType = 'user';
      senderId = 'system';
      senderName = 'Scheduler';
    }

    try {
      await this.messaging.sendMessage(
        room.id,
        action.workspace_id,
        senderType,
        senderId,
        senderName,
        rendered || `Run action "${action.name}".`,
        undefined,
        undefined,
        'message',
        { runProvision },
      );
    } catch (e: any) {
      // Best-effort: even if SSE delivery fails, the run row + room exist so
      // the user can read the rendered prompt in the UI and re-trigger.
      this.logService.warn('Actions', `sendMessage failed for run ${tempRun.id}: ${e?.message || e}`);
    }

    this.logService.info('Actions', `dispatched action ${action.id} run ${tempRun.id} → agent ${agent.id} room ${room.id}`);

    return { run: tempRun, agent_id: agent.id, room_id: room.id, prompt: rendered };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * FIFO 프루닝 — `max_runs` 를 **에이전트별로** 적용한다 (티켓 fc3906c5).
   *
   * 예전엔 `action_id` 하나로 셌다. 대상이 N개가 되면 트리거 1회에 run이 N건
   * 생기므로, action 단위로 세면 보존 기간이 N배 빨리 잘려 `max_runs=10`
   * 짜리 Action이 fan-out 5개 기준 트리거 2회치 이력만 남긴다. 에이전트별로
   * 세면 "각 호스트의 최근 10회"라는 원래 의미가 대상 수와 무관하게 유지된다.
   * 대상이 하나뿐인 Action에서는 그룹이 하나라 예전과 완전히 같은 결과다.
   *
   * `agent_id`가 빈 레거시 run은 하나의 그룹으로 묶여 예전과 같은 상한을
   * 적용받는다.
   *
   * 아직 `running`인 run은 **자르지 않는다**. 프루닝은 순수히 최신순이라
   * 진행 중인 배치의 형제 run을 지울 수 있고, 그러면 그 배치는 영영 "전원
   * 종료"에 도달하지 못하거나(재개 유실) 남은 run만으로 조기에 종료된 것처럼
   * 보인다 — 배치 재개 판정이 run 행을 세기 때문이다. 스턱 run은
   * ActionRunReaperService가 TTL로 종결시키고, 그 뒤엔 정상적으로 프루닝
   * 대상이 된다.
   */
  private async _pruneOldRuns(actionId: string, max: number): Promise<void> {
    const cap = Math.max(1, max || 10);
    const runs = await this.runRepo.find({
      where: { action_id: actionId },
      order: { created_at: 'DESC' },
    });
    const perAgent = new Map<string, ActionRun[]>();
    for (const r of runs) {
      const key = r.agent_id || '';
      const bucket = perAgent.get(key);
      if (bucket) bucket.push(r);
      else perAgent.set(key, [r]);
    }
    for (const bucket of perAgent.values()) {
      if (bucket.length <= cap) continue;
      for (const r of bucket.slice(cap)) {
        if ((r.status || 'running') === 'running') continue;
        await this._deleteRunWithRoom(r);
      }
    }
  }

  private async _deleteRunsForAction(actionId: string): Promise<void> {
    const runs = await this.runRepo.find({ where: { action_id: actionId } });
    for (const r of runs) {
      await this._deleteRunWithRoom(r);
    }
  }

  private async _deleteRunWithRoom(run: ActionRun): Promise<void> {
    if (run.room_id) {
      // Tear down room + messages + participants. We do raw deletes rather
      // than going through RoomCrudService because there is no leave-room /
      // archive abstraction for groups, and we want this to be a hard delete.
      // Attachments live in ticket_attachments with no FK back to room_id /
      // chat_room_messages (only ticket_id has a CASCADE), so we sweep them
      // explicitly using the denormalized room_id before nuking the room.
      await this.attachmentRepo.delete({ room_id: run.room_id });
      await this.messageRepo.delete({ room_id: run.room_id });
      await this.participantRepo.delete({ room_id: run.room_id });
      await this.roomRepo.delete({ id: run.room_id });
    }
    await this.runRepo.delete({ id: run.id });
  }
}
