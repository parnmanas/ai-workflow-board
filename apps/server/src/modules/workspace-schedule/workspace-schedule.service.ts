import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { WorkspaceSchedule } from '../../entities/WorkspaceSchedule';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { Agent } from '../../entities/Agent';
import { LogService } from '../../services/log.service';
import { findOrFail } from '../../common/find-or-fail';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { isValidCron, nextCronAfter } from '../qa/qa-cron';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

const DEFAULT_TICK_MS = 30_000;        // 30s — fine enough for short interval schedules
const MIN_TICK_MS = 5_000;             // 5s
const MAX_TICK_MS = 60 * 60_000;       // 1h
const MIN_INTERVAL_MS = 1_000;         // reject 0/negative; the tick caps real cadence anyway
const TICK_BATCH = 100;                // max schedules dispatched per tick

function clampEnv(name: string, def: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return def;
  return Math.min(max, Math.max(min, raw));
}

export interface CreateWorkspaceScheduleInput {
  workspaceId: string;
  boardId?: string | null;
  name: string;
  targetAgentId: string;
  taskPrompt: string;
  cron?: string | null;
  intervalMs?: number | null;
  enabled?: boolean;
  triggeredByType?: string;
  createdBy?: string;
}

export type UpdateWorkspaceScheduleInput = Partial<Omit<CreateWorkspaceScheduleInput, 'workspaceId' | 'createdBy'>>;

export interface DispatchResult {
  schedule_id: string;
  room_id: string;
  agent_id: string;
}

/**
 * WorkspaceScheduleService — general-purpose agent-task scheduler (ticket
 * 8845be79). Owns WorkspaceSchedule CRUD plus a background tick that, every
 * WORKSPACE_SCHEDULER_TICK_MS, finds due schedules and dispatches each one's
 * `task_prompt` to its `target_agent_id` by opening a FRESH chat room and
 * sending the prompt — the SAME create-room → seat-agent → sendMessage shape the
 * QA/Security RUN dispatch uses (qa-run.service.ts:198-245,
 * security-run.service.ts:234), which spawns the agent via the existing chat →
 * agent-manager route. (NB: the Security `checklist_refresh` scheduler, despite
 * the surface naming similarity, does NOT open a room — it calls
 * runService.refreshChecklistsForScope directly; the reused shape here is the RUN
 * dispatch, not checklist_refresh.) Scheduling is the "when"; the chat is the
 * "what" (reused, not forked).
 *
 * Background-loop shape mirrors QaScheduleService: OnModuleInit plants a plain
 * unref'd setInterval (no @Cron / scheduler dep), torn down on destroy, with an
 * env on/off switch and a clamped cadence.
 *
 * Idempotency / overlap policy:
 *   - Each due schedule's next_run_at is advanced to its NEXT firing and saved
 *     BEFORE the (async) dispatch — so a re-entrant/overlapping tick sees the
 *     cursor already moved past `now` and no-ops. next_run_at is computed from
 *     `now` (the firing instant), not the old next_run_at, so a server that was
 *     down does not backfill a storm of missed occurrences — it fires once and
 *     reschedules forward.
 *   - Unlike QA/Security batches, a dispatched task has NO run/batch lifecycle to
 *     poll, so there is no SKIP-if-running guard — a scheduled task is
 *     fire-and-forget. The pre-advance is the sole duplicate guard.
 *
 * Deployment timing (same footgun as QA #467dbc7a): a scheduled run hits the
 * RUNNING server. Keep the cadence coarser than your deploy lag.
 */
@Injectable()
export class WorkspaceScheduleService implements OnModuleInit, OnModuleDestroy {
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly tickMs = clampEnv('WORKSPACE_SCHEDULER_TICK_MS', DEFAULT_TICK_MS, MIN_TICK_MS, MAX_TICK_MS);
  private readonly enabled = (process.env.WORKSPACE_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';

  constructor(
    @InjectRepository(WorkspaceSchedule) private readonly scheduleRepo: Repository<WorkspaceSchedule>,
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectRepository(ChatRoomParticipant) private readonly participantRepo: Repository<ChatRoomParticipant>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly messaging: RoomMessagingService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logService.info('WorkspaceScheduler', 'disabled via WORKSPACE_SCHEDULER_ENABLED=false');
      return;
    }
    this.tickHandle = setInterval(() => {
      this.runOnce().catch((e: unknown) => {
        this.logService.error('WorkspaceScheduler', 'tick failed', { err: String(e) });
      });
    }, this.tickMs);
    // Don't keep the event loop alive on the timer alone (mirrors the QA scheduler).
    this.tickHandle.unref?.();
    this.logService.info('WorkspaceScheduler', 'Service initialized', { tick_ms: this.tickMs });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async list(workspaceId: string, boardId?: string): Promise<WorkspaceSchedule[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const qb = this.scheduleRepo.createQueryBuilder('s').where('s.workspace_id = :ws', { ws: workspaceId });
    // Scope rule mirrors list_qa_schedules: omit board_id → all; "" → workspace
    // (board_id IS NULL); <uuid> → that board.
    if (boardId !== undefined) {
      if (boardId) qb.andWhere('s.board_id = :bid', { bid: boardId });
      else qb.andWhere('s.board_id IS NULL');
    }
    return qb.orderBy('s.created_at', 'DESC').getMany();
  }

  async get(id: string, workspaceId: string): Promise<WorkspaceSchedule> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    return findOrFail(this.scheduleRepo, { where: { id, workspace_id: workspaceId } }, 'workspace schedule not found in workspace');
  }

  async create(input: CreateWorkspaceScheduleInput): Promise<WorkspaceSchedule> {
    if (!input.workspaceId) throw makeError(400, 'workspace_id is required');
    if (!input.name || !input.name.trim()) throw makeError(400, 'name is required');
    const targetAgentId = (input.targetAgentId || '').trim();
    if (!targetAgentId) throw makeError(400, 'target_agent_id is required');
    const taskPrompt = (input.taskPrompt || '').trim();
    if (!taskPrompt) throw makeError(400, 'task_prompt is required');

    const { cron, intervalMs } = this._validateCadence(input.cron, input.intervalMs);
    const enabled = input.enabled !== false;

    const draft = this.scheduleRepo.create({
      workspace_id: input.workspaceId,
      board_id: input.boardId ?? null,
      name: input.name.trim(),
      target_agent_id: targetAgentId,
      task_prompt: taskPrompt,
      cron,
      interval_ms: intervalMs,
      enabled,
      next_run_at: null,
      last_run_at: null,
      last_room_id: null,
      triggered_by_type: input.triggeredByType || 'user',
      created_by: input.createdBy || '',
    });
    draft.next_run_at = this.computeNextRun(draft, new Date());
    return this.scheduleRepo.save(draft);
  }

  async update(id: string, workspaceId: string, patch: UpdateWorkspaceScheduleInput): Promise<WorkspaceSchedule> {
    const schedule = await this.get(id, workspaceId);

    if (patch.name !== undefined) {
      if (!patch.name || !patch.name.trim()) throw makeError(400, 'name cannot be empty');
      schedule.name = patch.name.trim();
    }
    if (patch.boardId !== undefined) schedule.board_id = patch.boardId ?? null;
    if (patch.targetAgentId !== undefined) {
      const next = (patch.targetAgentId || '').trim();
      if (!next) throw makeError(400, 'target_agent_id cannot be empty');
      schedule.target_agent_id = next;
    }
    if (patch.taskPrompt !== undefined) {
      const next = (patch.taskPrompt || '').trim();
      if (!next) throw makeError(400, 'task_prompt cannot be empty');
      schedule.task_prompt = next;
    }
    if (patch.triggeredByType !== undefined) schedule.triggered_by_type = patch.triggeredByType || 'user';

    // Cadence — re-validate together; only touch when the caller sends either key.
    if (patch.cron !== undefined || patch.intervalMs !== undefined) {
      const nextCron = patch.cron !== undefined ? patch.cron : schedule.cron;
      const nextInterval = patch.intervalMs !== undefined ? patch.intervalMs : schedule.interval_ms;
      const validated = this._validateCadence(nextCron, nextInterval);
      schedule.cron = validated.cron;
      schedule.interval_ms = validated.intervalMs;
    }

    if (patch.enabled !== undefined) schedule.enabled = patch.enabled;

    // Recompute the next firing whenever enable-state or cadence could have moved
    // it. Disabled → null (the tick query skips it); enabled → compute from now.
    schedule.next_run_at = this.computeNextRun(schedule, new Date());
    return this.scheduleRepo.save(schedule);
  }

  async remove(id: string, workspaceId: string): Promise<void> {
    const schedule = await this.get(id, workspaceId);
    await this.scheduleRepo.delete({ id: schedule.id });
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  /**
   * Manual immediate trigger (REST/MCP run-now). Dispatches the schedule's task
   * right now regardless of `enabled` (explicit user intent) and stamps
   * last_run_at / last_room_id, but does NOT touch next_run_at — a manual run
   * must not disturb the automatic cadence.
   */
  async runNow(id: string, workspaceId: string, _triggeredById?: string): Promise<{ schedule: WorkspaceSchedule; dispatch: DispatchResult }> {
    const schedule = await this.get(id, workspaceId);
    const dispatch = await this._dispatch(schedule);
    schedule.last_run_at = new Date();
    schedule.last_room_id = dispatch.room_id;
    const saved = await this.scheduleRepo.save(schedule);
    this.logService.info('WorkspaceScheduler', 'run-now dispatched', { schedule_id: id, room_id: dispatch.room_id });
    return { schedule: saved, dispatch };
  }

  /**
   * One scheduler sweep. Public so a test / operator endpoint can drive it
   * deterministically (mirrors QaScheduleService.runOnce). Returns the schedule
   * ids it dispatched a task for this tick.
   */
  async runOnce(now: Date = new Date()): Promise<{ dispatched: string[] }> {
    const dispatched: string[] = [];

    // Self-heal: an enabled schedule with a null next_run_at (legacy row / cadence
    // edited while disabled) gets its cursor computed forward — without firing, so
    // enabling never causes a surprise immediate run.
    const orphans = await this.scheduleRepo.find({ where: { enabled: true, next_run_at: IsNull() } });
    for (const s of orphans) {
      s.next_run_at = this.computeNextRun(s, now);
      await this.scheduleRepo.save(s);
    }

    const due = await this.scheduleRepo.find({
      where: { enabled: true, next_run_at: LessThanOrEqual(now) },
      order: { next_run_at: 'ASC' },
      take: TICK_BATCH,
    });

    for (const schedule of due) {
      try {
        // Advance the cursor + persist BEFORE the (slow, async) dispatch so a
        // duplicate/overlapping tick sees next_run_at already moved and no-ops —
        // the same idempotency ordering QaScheduleService.runOnce uses.
        schedule.next_run_at = this.computeNextRun(schedule, now);
        await this.scheduleRepo.save(schedule);

        const dispatch = await this._dispatch(schedule);
        schedule.last_run_at = now;
        schedule.last_room_id = dispatch.room_id;
        await this.scheduleRepo.save(schedule);
        dispatched.push(schedule.id);
        this.logService.info('WorkspaceScheduler', 'dispatched task for schedule', {
          schedule_id: schedule.id, room_id: dispatch.room_id, agent_id: dispatch.agent_id,
          next_run_at: schedule.next_run_at,
        });
      } catch (e: any) {
        // A bad schedule (missing/disabled agent, etc.) must not stall the sweep.
        // next_run_at is already advanced, so it retries next occurrence.
        this.logService.warn('WorkspaceScheduler', 'schedule dispatch failed (continuing)', {
          schedule_id: schedule.id, err: e?.message || String(e),
        });
      }
    }

    if (dispatched.length) {
      this.logService.info('WorkspaceScheduler', 'sweep done', { dispatched: dispatched.length });
    }
    return { dispatched };
  }

  /** Compute the next firing instant for a schedule (null when disabled / no cadence). */
  computeNextRun(schedule: Pick<WorkspaceSchedule, 'enabled' | 'cron' | 'interval_ms'>, from: Date): Date | null {
    if (!schedule.enabled) return null;
    if (schedule.cron) return nextCronAfter(schedule.cron, from);
    if (schedule.interval_ms && schedule.interval_ms > 0) return new Date(from.getTime() + schedule.interval_ms);
    return null;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /**
   * Open a fresh chat room (new-room-per-run, per the confirmed decision), seat
   * the target agent + a synthetic 'system' user, and send `task_prompt` as the
   * opening message — the QA/Security RUN dispatch shape (qa-run.service.ts:198-245).
   * The sendMessage from a 'user' sender into an agent-occupied room is what
   * triggers the agent-manager spawn through the existing chat path.
   */
  private async _dispatch(schedule: WorkspaceSchedule): Promise<DispatchResult> {
    const agent = await this.agentRepo.findOne({ where: { id: schedule.target_agent_id } });
    if (!agent) throw makeError(400, 'target agent not found');
    // Workspace-scope safety: never dispatch into an agent outside this workspace.
    if (agent.workspace_id && agent.workspace_id !== schedule.workspace_id) {
      throw makeError(400, 'target agent belongs to a different workspace');
    }

    const room = await this.roomRepo.save(this.roomRepo.create({
      workspace_id: schedule.workspace_id,
      type: 'group',
      name: `Schedule: ${schedule.name}`,
      last_message_at: null,
    }));

    // Seat the target agent + a synthetic 'system' user (no real triggering user
    // in scope), exactly like QA/Security run dispatch.
    const joinedAt = new Date();
    await this.participantRepo.save([
      this.participantRepo.create({
        room_id: room.id,
        participant_type: 'agent',
        participant_id: agent.id,
        last_read_at: joinedAt,
        left_at: null,
      }),
      this.participantRepo.create({
        room_id: room.id,
        participant_type: 'user',
        participant_id: 'system',
        last_read_at: joinedAt,
        left_at: null,
      }),
    ]);

    try {
      await this.messaging.sendMessage(
        room.id,
        schedule.workspace_id,
        'user',
        'system',
        'Scheduler',
        schedule.task_prompt,
      );
    } catch (e: any) {
      this.logService.warn('WorkspaceScheduler', `sendMessage failed for schedule ${schedule.id}: ${e?.message || e}`);
    }

    this.logService.info('WorkspaceScheduler', `dispatched schedule ${schedule.id} → agent ${agent.id} room ${room.id}`);
    return { schedule_id: schedule.id, room_id: room.id, agent_id: agent.id };
  }

  private _validateCadence(cron: string | null | undefined, intervalMs: number | null | undefined): { cron: string | null; intervalMs: number | null } {
    const hasCron = typeof cron === 'string' && cron.trim() !== '';
    const hasInterval = typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0;
    if (hasCron && hasInterval) throw makeError(400, 'set exactly one of cron or interval_ms, not both');
    if (!hasCron && !hasInterval) throw makeError(400, 'one of cron or interval_ms is required');
    if (hasCron) {
      if (!isValidCron(cron!.trim())) throw makeError(400, `invalid cron expression: "${cron}" (5 UTC fields, e.g. "0 3 * * *")`);
      return { cron: cron!.trim(), intervalMs: null };
    }
    if (intervalMs! < MIN_INTERVAL_MS) throw makeError(400, `interval_ms must be >= ${MIN_INTERVAL_MS}`);
    return { cron: null, intervalMs: Math.floor(intervalMs!) };
  }
}
