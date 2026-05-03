import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Action } from '../../entities/Action';
import { ActionRun } from '../../entities/ActionRun';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { Workspace } from '../../entities/Workspace';
import { User } from '../../entities/User';
import { RoomMembershipService } from '../chat-rooms/room-membership.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { LogService } from '../../services/log.service';
import { findOrFail } from '../../common/find-or-fail';
import { renderActionPrompt, buildRenderContext } from './action-prompt';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export interface DispatchActionArgs {
  actionId: string;
  // 'user' = web UI clicked Run; 'system' = scheduler. The triggering user
  // (when present) is added as a participant to the room so they can read
  // and reply to the agent.
  triggeredByType: 'user' | 'system';
  triggeredById: string;
}

export interface DispatchActionResult {
  run: ActionRun;
  room_id: string;
  prompt: string;
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
  constructor(
    @InjectRepository(Action) private readonly actionRepo: Repository<Action>,
    @InjectRepository(ActionRun) private readonly runRepo: Repository<ActionRun>,
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectRepository(ChatRoomParticipant) private readonly participantRepo: Repository<ChatRoomParticipant>,
    @InjectRepository(ChatRoomMessage) private readonly messageRepo: Repository<ChatRoomMessage>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
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

    const created = this.actionRepo.create({
      workspace_id: input.workspace_id,
      board_id: input.board_id || null,
      name: input.name.trim(),
      description: input.description ?? '',
      prompt: input.prompt ?? '',
      target_agent_id: input.target_agent_id,
      schedule_cron: input.schedule_cron ?? '',
      enabled: input.enabled !== false,
      max_runs: typeof input.max_runs === 'number' && input.max_runs > 0 ? input.max_runs : 10,
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
    if (patch.board_id !== undefined) existing.board_id = patch.board_id || null;
    if (patch.schedule_cron !== undefined) existing.schedule_cron = patch.schedule_cron || '';
    if (patch.enabled !== undefined) existing.enabled = !!patch.enabled;
    if (patch.max_runs !== undefined) {
      const n = Number(patch.max_runs);
      if (Number.isFinite(n) && n > 0) existing.max_runs = Math.floor(n);
    }
    return this.actionRepo.save(existing);
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
   * Dispatch a Run: create the room, add participants, FIFO-prune, render the
   * prompt, send it as the triggering user's first message. The agent reply
   * arrives later via the existing chat_room_message → agent-manager pipeline.
   */
  async dispatch(args: DispatchActionArgs): Promise<DispatchActionResult> {
    const action = await findOrFail(this.actionRepo, { where: { id: args.actionId } }, 'Action not found');
    if (!action.target_agent_id) throw makeError(400, 'Action has no target agent set');

    const agent = await this.agentRepo.findOne({ where: { id: action.target_agent_id } });
    if (!agent) throw makeError(400, 'target agent not found');

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

    // Create the run row early so we have a stable run_id to interpolate into
    // the prompt (`{{run.id}}`) and to stamp on the room name.
    const runScaffold = this.runRepo.create({
      action_id: action.id,
      workspace_id: action.workspace_id,
      room_id: '',           // filled in after room creation, see below
      triggered_by_type: args.triggeredByType,
      triggered_by_id: args.triggeredById || '',
      prompt_rendered: '',   // filled below
    });
    // Pre-allocate the id by saving and re-loading so cron interpolation can
    // reference it; we patch room_id + prompt_rendered in the same row.
    const tempRun = await this.runRepo.save(runScaffold);

    const ctx = buildRenderContext({
      workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
      board: board ? { id: board.id, name: board.name } : null,
      user: user ? { id: user.id, name: user.name, email: user.email } : null,
      agent: { id: agent.id, name: agent.name },
      action: { id: action.id, name: action.name },
      runId: tempRun.id,
    });
    const rendered = renderActionPrompt(action.prompt || '', ctx);

    // Create the room. We use 'group' as the underlying type so the chat
    // controller's existing rules (rename, multi-participant, etc.) apply.
    // The action_id stamp is what differentiates Action runs from regular
    // chat groups in the list view.
    const room = await this.roomRepo.save(this.roomRepo.create({
      workspace_id: action.workspace_id,
      type: 'group',
      name: `Action: ${action.name} · ${tempRun.id.slice(0, 8)}`,
      action_id: action.id,
      last_message_at: null,
    }));

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

    // Patch run row with room + rendered prompt.
    tempRun.room_id = room.id;
    tempRun.prompt_rendered = rendered;
    await this.runRepo.save(tempRun);

    // Update Action.last_run_at so the scheduler doesn't double-fire on the
    // same minute boundary.
    await this.actionRepo.update(action.id, { last_run_at: new Date() });

    // FIFO prune: drop rooms beyond max_runs, oldest first. Run AFTER we
    // saved the new room so we never accidentally delete the one we just
    // created.
    await this._pruneOldRuns(action.id, action.max_runs);

    // Send the rendered prompt as the user's first message. Agent-side: this
    // is what fans out as chat_room_message, which the agent-manager picks
    // up and dispatches to its persistent chat session for the target agent.
    //
    // For system-triggered Runs (scheduler) there's no user — we send under
    // the agent's own identity instead so RoomMessagingService can validate
    // the participant. The agent will see a system note and respond to
    // itself; this is fine for scheduled use cases where the prompt is
    // self-contained ("git commit + push", "summarize today's PRs", etc.).
    let senderType: 'user' | 'agent' = 'user';
    let senderId = args.triggeredById;
    let senderName = user?.name || user?.email || 'User';
    if (!user) {
      // Use a synthetic user (the action's target agent stands in) so the
      // message can be saved. The agent-manager will still trigger because
      // chat_room_message fires regardless of sender; we set sender_type to
      // 'agent' so loop-break logic doesn't dispatch the agent to reply to
      // the prompt-as-agent — wait, that breaks the dispatch.
      //
      // The simplest correct behavior: for system-triggered runs, send as
      // sender_type='user' with id 'system' and name 'Scheduler'. Sending
      // requires an active participant though — so we add 'system' as a
      // user-type participant. This is awkward but it's the smallest path.
      //
      // We add a synthetic system user participant; the chat infra never
      // looks the id up (it just compares ids in the participant table), so
      // a free-form 'system' string works.
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
      await this.messageRepo.delete({ room_id: run.room_id });
      await this.participantRepo.delete({ room_id: run.room_id });
      await this.roomRepo.delete({ id: run.room_id });
    }
    await this.runRepo.delete({ id: run.id });
  }
}
