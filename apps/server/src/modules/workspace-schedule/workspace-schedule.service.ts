import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { WorkspaceSchedule } from '../../entities/WorkspaceSchedule';
import { Action } from '../../entities/Action';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { Agent } from '../../entities/Agent';
import { agentIsVisibleInWorkspace } from '../../common/agent-workspace-scope';
import { Board } from '../../entities/Board';
import { LogService } from '../../services/log.service';
import { InstanceQuiesceService } from '../../services/instance-quiesce.service';
import { findOrFail } from '../../common/find-or-fail';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { ActionsService } from '../actions/actions.service';
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
  /** 인라인 프롬프트 형태에서만. Action 형태에서는 Action 이 대상을 정한다. */
  targetAgentId?: string;
  /** 인라인 프롬프트 형태. `actionId` 와 정확히 택일. */
  taskPrompt?: string;
  /** Action 형태 — 등록된 Action 을 실행한다. `taskPrompt` 와 정확히 택일. */
  actionId?: string | null;
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
  /** Action 형태일 때 그 dispatch 가 만든 배치 키. 인라인 형태에서는 비어 있다. */
  batch_id?: string;
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
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    // ticket 0f638509 — instance-wide fleet quiesce. @Global() (see
    // shared-services.module.ts), cycle-free.
    private readonly instanceQuiesce: InstanceQuiesceService,
    @InjectRepository(Action) private readonly actionRepo: Repository<Action>,
    // Action 형태 스케줄의 발화 경로. ActionsModule → WorkspaceScheduleModule
    // 방향 import 가 없으므로 순환이 아니다.
    private readonly actions: ActionsService,
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

  async list(workspaceId: string): Promise<WorkspaceSchedule[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const qb = this.scheduleRepo.createQueryBuilder('s')
      .where('s.workspace_id = :ws', { ws: workspaceId })
      .andWhere('s.board_id IS NULL');
    return qb.orderBy('s.created_at', 'DESC').getMany();
  }

  async get(id: string, workspaceId: string): Promise<WorkspaceSchedule> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    return findOrFail(this.scheduleRepo, { where: { id, workspace_id: workspaceId } }, 'workspace schedule not found in workspace');
  }

  async create(input: CreateWorkspaceScheduleInput): Promise<WorkspaceSchedule> {
    if (!input.workspaceId) throw makeError(400, 'workspace_id is required');
    if (!input.name || !input.name.trim()) throw makeError(400, 'name is required');
    const target = await this._validateTarget(input.workspaceId, input.targetAgentId, input.taskPrompt, input.actionId);
    await this._assertBoardScope(input.workspaceId, input.boardId);

    const { cron, intervalMs } = this._validateCadence(input.cron, input.intervalMs);
    const enabled = input.enabled !== false;

    const draft = this.scheduleRepo.create({
      workspace_id: input.workspaceId,
      board_id: null,
      name: input.name.trim(),
      target_agent_id: target.targetAgentId,
      task_prompt: target.taskPrompt,
      action_id: target.actionId,
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
    if (patch.boardId !== undefined && (patch.boardId ?? null) !== schedule.board_id) {
      throw makeError(400, 'scope cannot be changed after creation');
    }
    // 대상(무엇을 할지)은 셋이 서로 배타적이라 한 덩어리로 다시 검증한다 — 하나만
    // 패치해서 "프롬프트도 있고 action_id 도 있는" 상태로 빠지는 경로를 막는다.
    if (patch.targetAgentId !== undefined || patch.taskPrompt !== undefined || patch.actionId !== undefined) {
      const target = await this._validateTarget(
        schedule.workspace_id,
        patch.targetAgentId !== undefined ? patch.targetAgentId : schedule.target_agent_id,
        patch.taskPrompt !== undefined ? patch.taskPrompt : schedule.task_prompt,
        patch.actionId !== undefined ? patch.actionId : schedule.action_id,
      );
      schedule.target_agent_id = target.targetAgentId;
      schedule.task_prompt = target.taskPrompt;
      schedule.action_id = target.actionId;
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
    // Instance-wide quiesce gate (ticket 0f638509 — live pull import). See
    // QaScheduleService.runOnce's identical gate for the full rationale —
    // shared by the setInterval tick AND the manual run_workspace_schedule_now
    // tool, both refused equally while quiesced.
    if (await this.instanceQuiesce.isQuiesced()) {
      this.logService.info('WorkspaceScheduler', 'runOnce skipped (instance quiesced)');
      return { dispatched: [] };
    }

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
  /**
   * Action 형태의 발화. 방을 이 서비스가 만들지 **않는다** — ActionsService.dispatch 가
   * 자기 파이프라인(ActionRun 기록 · batch · high_impact 승인 게이트 · fan-out)을
   * 그대로 태우고, 여기서는 "언제" 만 책임진다. 수동 Run 버튼과 완전히 같은 경로라
   * 예약 실행과 수동 실행의 결과가 갈리지 않는다.
   *
   * Action 이 삭제됐으면 스케줄을 **비활성화**한다. 매 틱 실패 로그를 쌓는 것보다,
   * 운영자가 목록에서 꺼진 줄을 보고 지우거나 다시 연결하는 편이 낫다 — 이 스케줄이
   * 영영 성공할 수 없다는 것은 이미 확정된 사실이라 재시도에 의미가 없다.
   */
  private async _dispatchAction(schedule: WorkspaceSchedule): Promise<DispatchResult> {
    const action = await this.actionRepo.findOne({ where: { id: schedule.action_id! } });
    if (!action) {
      schedule.enabled = false;
      schedule.next_run_at = null;
      await this.scheduleRepo.save(schedule);
      this.logService.warn('WorkspaceScheduler', 'action was deleted — schedule disabled', {
        schedule_id: schedule.id, action_id: schedule.action_id,
      });
      throw makeError(400, `action not found: ${schedule.action_id}`);
    }
    const result = await this.actions.dispatch({
      actionId: action.id,
      triggeredByType: 'system',
      triggeredById: '',
    });
    this.logService.info('WorkspaceScheduler', `dispatched schedule ${schedule.id} → action ${action.id}`, {
      batch_id: result.batch_id, runs: result.runs.length,
    });
    return {
      schedule_id: schedule.id,
      room_id: result.room_id,
      agent_id: result.run?.agent_id || '',
      batch_id: result.batch_id,
    };
  }

  private async _dispatch(schedule: WorkspaceSchedule): Promise<DispatchResult> {
    if (schedule.action_id) return this._dispatchAction(schedule);
    const agent = await this.agentRepo.findOne({ where: { id: schedule.target_agent_id } });
    if (!agent) throw makeError(400, 'target agent not found');
    // Workspace-scope safety: never dispatch into an agent outside this workspace.
    if (!agentIsVisibleInWorkspace(agent.workspace_id, schedule.workspace_id)) {
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

  private async _assertBoardScope(workspaceId: string, boardId: string | null | undefined): Promise<void> {
    if (boardId) {
      throw makeError(400, 'Board-scoped schedules are no longer supported; create the schedule in its Workspace');
    }
  }

  /**
   * "무엇을 할지" 를 정규화한다. 인라인 프롬프트(`task_prompt` + `target_agent_id`)와
   * Action 참조(`action_id`)는 **정확히 하나만** 설정된다.
   *
   * 둘 다 허용하면 "어느 쪽이 이기는가" 가 dispatch 구현 세부에 숨는다 — 스케줄을
   * 편집한 사람이 자기가 무엇을 예약했는지 화면만 보고 알 수 없게 된다. 그래서
   * 저장 시점에 거부한다.
   */
  private async _validateTarget(
    workspaceId: string,
    targetAgentId: string | undefined,
    taskPrompt: string | undefined,
    actionId: string | null | undefined,
  ): Promise<{ targetAgentId: string; taskPrompt: string; actionId: string | null }> {
    const agent = (targetAgentId || '').trim();
    const prompt = (taskPrompt || '').trim();
    const action = (actionId || '').trim();

    if (action) {
      if (prompt) throw makeError(400, 'set exactly one of task_prompt or action_id, not both');
      // 워크스페이스 밖의 Action 을 예약하지 못하게 한다 — 스케줄은 자기 워크스페이스
      // 안에서만 무언가를 일으킬 수 있다.
      const row = await this.actionRepo.findOne({ where: { id: action } });
      if (!row) throw makeError(400, `action not found: ${action}`);
      if (row.workspace_id !== workspaceId) throw makeError(400, 'action belongs to a different workspace');
      // 대상·프롬프트는 Action 이 정의하므로 이쪽은 비운다. 남겨 두면 화면에
      // 실행되지 않을 값이 계속 보인다.
      return { targetAgentId: '', taskPrompt: '', actionId: action };
    }

    if (!prompt) throw makeError(400, 'one of task_prompt or action_id is required');
    if (!agent) throw makeError(400, 'target_agent_id is required');
    return { targetAgentId: agent, taskPrompt: prompt, actionId: null };
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
