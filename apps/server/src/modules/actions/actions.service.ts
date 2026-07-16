import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Action } from '../../entities/Action';
import { ActionRun } from '../../entities/ActionRun';
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
import { RoomMembershipService } from '../chat-rooms/room-membership.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { LogService } from '../../services/log.service';
import { findOrFail } from '../../common/find-or-fail';
import { prependBoardLanguageInstruction } from '../../common/harness-config';
import { renderActionPrompt, buildRenderContext, ActionTicketContext } from './action-prompt';
import { parseCron } from './cron';

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
  // resume. When set, a completion contract is appended to the rendered prompt
  // so the target agent reports its outcome via `complete_action_run`.
  sourceTicketId?: string;
  // 1-based attempt number. `completeRun`'s retry path re-dispatches with
  // attempt+1; the default 1 covers the first, agent-initiated dispatch.
  attempt?: number;
  // Run-level idempotency key (ticket 524bb434, scope 5). `completeRun`'s retry
  // path passes the FAILED run's key so the whole retry chain shares one key —
  // the target operation can dedupe. Undefined on a first ticket-driven
  // dispatch, where `dispatch` mints a fresh key.
  idempotencyKey?: string;
  // Human approval evidence for a high-impact Action (ticket 524bb434, scope 5,
  // reviewer req). A high-impact Action dispatched by an agent to clear a ticket
  // blocker may only run when a real workspace ADMIN approved it — this is that
  // approver's user id. Undefined otherwise; the gate in `dispatch` rejects an
  // unapproved high-impact ticket-driven run before any external side effect.
  approvedByUserId?: string;
}

export interface DispatchActionResult {
  run: ActionRun;
  room_id: string;
  prompt: string;
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

  constructor(
    @InjectRepository(Action) private readonly actionRepo: Repository<Action>,
    @InjectRepository(ActionRun) private readonly runRepo: Repository<ActionRun>,
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
    private readonly membership: RoomMembershipService,
    private readonly messaging: RoomMessagingService,
    private readonly logService: LogService,
  ) {}

  // ── CRUD ────────────────────────────────────────────────────────────────

  async list(workspaceId: string, boardId: string | undefined): Promise<Action[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const qb = this.actionRepo.createQueryBuilder('a').where('a.workspace_id = :ws', { ws: workspaceId });
    if (boardId !== undefined) {
      // Mirror Resources scoping: '' = workspace-scope only (board_id IS NULL),
      // <uuid> = that board only, omit = all rows in workspace.
      if (boardId) qb.andWhere('a.board_id = :bid', { bid: boardId });
      else qb.andWhere('a.board_id IS NULL');
    }
    return qb.orderBy('a.name', 'ASC').getMany();
  }

  async get(id: string): Promise<Action> {
    return findOrFail(this.actionRepo, { where: { id } }, 'Action not found');
  }

  async create(input: Partial<Action> & { workspace_id: string; name: string; target_agent_id: string }): Promise<Action> {
    if (!input.workspace_id) throw makeError(400, 'workspace_id is required');
    if (!input.name || !input.name.trim()) throw makeError(400, 'name is required');
    if (!input.target_agent_id) throw makeError(400, 'target_agent_id is required');

    // Scope check: the target agent must live in this workspace (or be global —
    // workspace_id null/empty means global). Cross-workspace dispatch would
    // bypass our SSE recipient filter and silently never deliver.
    const agent = await this.agentRepo.findOne({ where: { id: input.target_agent_id } });
    if (!agent) throw makeError(400, 'target agent not found');
    if (agent.workspace_id && agent.workspace_id !== input.workspace_id) {
      throw makeError(400, 'target agent belongs to a different workspace');
    }

    // Same scope rule for the optional board pin: the board must live in this
    // workspace, otherwise list/scoping queries silently miss the action.
    if (input.board_id) {
      const board = await this.boardRepo.findOne({ where: { id: input.board_id } });
      if (!board) throw makeError(400, 'board not found');
      if (board.workspace_id !== input.workspace_id) {
        throw makeError(400, 'board belongs to a different workspace');
      }
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
      board_id: input.board_id || null,
      name: input.name.trim(),
      description: input.description ?? '',
      prompt: input.prompt ?? '',
      target_agent_id: input.target_agent_id,
      schedule_cron: input.schedule_cron ?? '',
      enabled: input.enabled !== false,
      high_impact: input.high_impact === true,
      max_runs: typeof input.max_runs === 'number' && input.max_runs > 0 ? input.max_runs : 10,
      trigger: input.trigger ?? '',
      trigger_label: input.trigger_label ?? '',
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
    if (patch.target_agent_id !== undefined) {
      const agent = await this.agentRepo.findOne({ where: { id: patch.target_agent_id } });
      if (!agent) throw makeError(400, 'target agent not found');
      if (agent.workspace_id && agent.workspace_id !== workspaceId) {
        throw makeError(400, 'target agent belongs to a different workspace');
      }
      existing.target_agent_id = patch.target_agent_id;
    }
    if (patch.board_id !== undefined) {
      if (patch.board_id) {
        const board = await this.boardRepo.findOne({ where: { id: patch.board_id } });
        if (!board) throw makeError(400, 'board not found');
        if (board.workspace_id !== workspaceId) {
          throw makeError(400, 'board belongs to a different workspace');
        }
      }
      existing.board_id = patch.board_id || null;
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
    return this.actionRepo.save(existing);
  }

  // Allowed `Action.trigger` values. Empty = legacy cron/manual; 'on_ticket_done'
  // opts into the lifecycle hook (OnTicketDoneActionService).
  private _isValidTrigger(trigger: string): boolean {
    return trigger === '' || trigger === 'on_ticket_done';
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
    const claim = await this.runRepo
      .createQueryBuilder()
      .update(ActionRun)
      .set({ status: args.status, result_summary: summary, completed_at: completedAt })
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

    const action = await this.actionRepo.findOne({ where: { id: run.action_id } });
    const actionName = action?.name || run.action_id;
    const sourceTicketId = (run.source_ticket_id || '').trim();

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
      await this._postRunComment(
        sourceTicketId, run.workspace_id, actor,
        `✅ Action **${actionName}** run \`${run.id.slice(0, 8)}\` succeeded` +
        `${summary ? ` — ${summary}` : ''}. Resuming this ticket.`,
      );
      await this._logRunActivity(sourceTicketId, run, actor, 'succeeded', summary);
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
    const highImpact = isHighImpactAction(action);
    if (!highImpact && run.attempt < ActionsService.MAX_RUN_ATTEMPTS) {
      const nextAttempt = run.attempt + 1;
      let retryRunId = '';
      try {
        const retry = await this.dispatch({
          actionId: run.action_id,
          triggeredByType: actor.type,
          triggeredById: actor.id,
          sourceTicketId,
          attempt: nextAttempt,
          // Carry the same idempotency key across the retry chain so the
          // target operation can dedupe a redelivered external effect.
          idempotencyKey: run.idempotency_key || undefined,
        });
        retryRunId = retry.run.id;
      } catch (e: any) {
        // Re-dispatch failed (e.g. the Action was deleted mid-flight). Treat it
        // as exhaustion so the ticket is still surfaced rather than silently
        // stuck waiting on a retry that never launched.
        this.logService.warn('Actions', `retry re-dispatch failed for run ${run.id}: ${e?.message || e}`);
      }
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
    const surface = highImpact
      ? `❌ HIGH-IMPACT Action **${actionName}** run \`${run.id.slice(0, 8)}\` failed` +
        `${summary ? ` — ${summary}` : ''}. NOT auto-retried (a blind re-run could double a deploy/publish effect). ` +
        `Resuming this ticket: verify whether the external operation actually landed, then re-run **${actionName}** ` +
        `(idempotency key \`${run.idempotency_key || 'n/a'}\`) or \`pend_ticket\` with a specific \`no_action_reason\` if it needs a human.`
      : `❌ Action **${actionName}** run \`${run.id.slice(0, 8)}\` failed after ${run.attempt} attempt(s)` +
        `${summary ? ` — ${summary}` : ''}. Resuming this ticket so the assignee can fix the inputs and retry, ` +
        `or \`pend_ticket\` with a specific \`no_action_reason\` if it genuinely needs a human.`;
    await this._postRunComment(sourceTicketId, run.workspace_id, actor, surface);
    return {
      run, sourceTicketId, status: 'failed',
      previouslyCompleted: false, retried: false, retryRunId: '', exhausted: true,
      shouldResume: true,
    };
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
    const reason =
      `High-impact Action "${action.name}" requires human approval before it can run. ` +
      `A workspace admin must approve it (re-run the Action with approved_by_user_id) or perform the ` +
      `operation manually — the server will not let an agent auto-execute a deploy/publish/release.`;
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

  /**
   * Dispatch a Run: create the room, add participants, FIFO-prune, render the
   * prompt, send it as the triggering user's first message. The agent reply
   * arrives later via the existing chat_room_message → agent-manager pipeline.
   */
  async dispatch(args: DispatchActionArgs): Promise<DispatchActionResult> {
    const action = await findOrFail(this.actionRepo, { where: { id: args.actionId } }, 'Action not found');
    if (!action.target_agent_id) throw makeError(400, 'Action has no target agent set');

    const agent = await this.agentRepo.findOne({ where: { id: action.target_agent_id } });
    if (!agent) throw makeError(400, 'target agent not found');

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

    // ── High-impact pre-execution approval gate (ticket 524bb434, scope 5) ──
    // A high-impact Action (explicit flag OR name heuristic) has irreversible
    // external effects, so an AGENT clearing a ticket blocker may NOT auto-run
    // it — a real workspace admin must approve first. Only the ticket-driven
    // agent/system path is gated: a human-clicked UI run (type='user') is itself
    // the approval, and standing scheduler/hook runs carry no source ticket. An
    // unapproved high-impact ticket-driven run is rejected BEFORE any external
    // side effect and its source ticket is parked (pending_user_action) with a
    // concrete reason, so approval — not silent auto-execution — is what unblocks
    // it (completion criterion: "승인이 반드시 필요한 경우만 Pending").
    const highImpact = isHighImpactAction(action);
    let approval: { userId: string; userName: string; at: Date } | null = null;
    if (sourceTicketId && highImpact && args.triggeredByType !== 'user') {
      const approverId = (args.approvedByUserId || '').trim();
      if (!approverId) {
        await this._parkForApproval(sourceTicketId, action, args.triggeredById);
        throw makeError(
          403,
          `Action "${action.name}" is high-impact and requires explicit human approval before it can run. ` +
          `The source ticket has been set to pending_user_action — a workspace admin must approve it ` +
          `(re-run with approved_by_user_id set to their user id) or handle the operation manually. ` +
          `An agent cannot auto-execute a deploy/publish/release.`,
        );
      }
      // Approval authority: a real, active ADMIN user. An agent id / random uuid
      // is not a user (findOne → null) so an agent cannot self-approve; a
      // non-admin user is rejected as unauthorized. Approver/time are recorded on
      // the run + an audit row so the approval is reconstructable.
      const approver = await this.userRepo.findOne({ where: { id: approverId } });
      if (!approver || approver.status !== 'active') {
        throw makeError(403, 'high-impact approval must reference a real, active user (approved_by_user_id not found)');
      }
      if (approver.role !== 'admin') {
        throw makeError(403, `user "${approver.name}" is not authorized to approve high-impact actions (admin role required)`);
      }
      approval = { userId: approver.id, userName: approver.name, at: new Date() };
    }

    // Build a render context the user can interpolate against. Resolve the
    // optional pieces best-effort — missing fields render as empty string in
    // the template, which is friendlier than failing the whole Run.
    const workspace = await this.workspaceRepo.findOne({ where: { id: action.workspace_id } });
    const board = action.board_id
      ? await this.boardRepo.findOne({ where: { id: action.board_id } })
      : null;
    const user = args.triggeredByType === 'user' && args.triggeredById
      ? await this.userRepo.findOne({ where: { id: args.triggeredById } })
      : null;

    // Pre-allocate the run's UUID up front so {{run.id}} resolves before any
    // DB write, and so we can save the ActionRun row exactly once with every
    // field populated. The previous flow saved a half-empty scaffold first
    // (room_id: '', prompt_rendered: '') to grab tempRun.id, then patched
    // those two columns in a second save. That broke on production.private
    // after commit d971fa1 widened action_runs.room_id from varchar to uuid
    // — Postgres rejects '' with `invalid input syntax for type uuid: ""`.
    // Generating the id here lets us write a complete row up front and
    // avoid the empty-string sentinel entirely.
    const runId = randomUUID();

    const ctx = buildRenderContext({
      workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
      board: board ? { id: board.id, name: board.name } : null,
      user: user ? { id: user.id, name: user.name, email: user.email } : null,
      agent: { id: agent.id, name: agent.name },
      action: { id: action.id, name: action.name },
      runId,
      ticket: args.ticketContext ?? null,
    });
    const renderedPrompt = renderActionPrompt(action.prompt || '', ctx);
    const withLanguage = prependBoardLanguageInstruction(renderedPrompt, board?.language);
    // When a ticket dispatched this run, append the completion contract so the
    // target agent reports its outcome via `complete_action_run` — that call is
    // what re-dispatches (resumes) the source ticket. Server-injected (not left
    // to the Action author) so every ticket-driven run closes the loop reliably.
    // Mint a run-level idempotency key on the first dispatch; retries pass the
    // failed run's key so the whole chain shares one (scope 5). Only ticket-
    // driven runs get a key — cron/manual runs have nothing to resume or dedupe.
    const idempotencyKey = sourceTicketId
      ? (args.idempotencyKey || '').trim() || randomUUID()
      : '';
    const rendered = sourceTicketId
      ? `${withLanguage}${renderCompletionContract(runId, action.workspace_id, sourceTicketId, idempotencyKey, !!action.high_impact)}`
      : withLanguage;

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
      room_id: room.id,
      triggered_by_type: args.triggeredByType,
      triggered_by_id: args.triggeredById || '',
      prompt_rendered: rendered,
      source_ticket_id: sourceTicketId,
      idempotency_key: idempotencyKey,
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

    // Update Action.last_run_at so the scheduler doesn't double-fire on the
    // same minute boundary.
    await this.actionRepo.update(action.id, { last_run_at: new Date() });

    // FIFO prune: drop rooms beyond max_runs, oldest first. Run AFTER we
    // saved the new room so we never accidentally delete the one we just
    // created.
    await this._pruneOldRuns(action.id, action.max_runs);

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
      );
    } catch (e: any) {
      // Best-effort: even if SSE delivery fails, the run row + room exist so
      // the user can read the rendered prompt in the UI and re-trigger.
      this.logService.warn('Actions', `sendMessage failed for run ${tempRun.id}: ${e?.message || e}`);
    }

    this.logService.info('Actions', `dispatched action ${action.id} run ${tempRun.id} → agent ${agent.id} room ${room.id}`);

    return { run: tempRun, room_id: room.id, prompt: rendered };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async _pruneOldRuns(actionId: string, max: number): Promise<void> {
    const cap = Math.max(1, max || 10);
    const runs = await this.runRepo.find({
      where: { action_id: actionId },
      order: { created_at: 'DESC' },
    });
    if (runs.length <= cap) return;
    const toDelete = runs.slice(cap);
    for (const r of toDelete) {
      await this._deleteRunWithRoom(r);
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
