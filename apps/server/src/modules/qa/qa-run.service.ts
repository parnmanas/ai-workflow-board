import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { QaScenario } from '../../entities/QaScenario';
import { QaRun, QaRunStatus, QaStepResult, QaPhaseHistoryEntry } from '../../entities/QaRun';
import { QaRunBatch } from '../../entities/QaRunBatch';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { Resource } from '../../entities/Resource';
import { Agent } from '../../entities/Agent';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { LogService } from '../../services/log.service';
import { findOrFail } from '../../common/find-or-fail';
import { renderQaRunPrompt } from './qa-prompt';
import { QaFailureTicketService } from './qa-failure-ticket.service';
import { buildRunProvision } from '../../common/run-workspace-resolver';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Drivers whose "PASSED" must be backed by visual evidence. A browser /
 * game-client run that an agent self-reports as passed but produced zero
 * image/video artifacts is treated as unproven — completeRun downgrades it to
 * `failed`. MCP/http drivers have no screen to capture, so they're exempt.
 */
const VISUAL_DRIVERS = new Set(['browser', 'game-client']);

/** True when a Resource's mimetype is an image or video (evidence of a screen). */
function isVisualEvidence(mimetype: string | null | undefined): boolean {
  const m = (mimetype || '').toLowerCase();
  return m.startsWith('image/') || m.startsWith('video/');
}

export interface StartQaRunArgs {
  scenarioId: string;
  triggeredByType: 'user' | 'system' | 'agent';
  triggeredById: string;
  // Rerun generation to stamp on the new QaRun (ticket 467dbc7a). Defaults to 0
  // (a first-time / manual / seeded run). QaRerunOnFixService passes the fix
  // ticket's generation + 1 so a re-failure files the next-generation fix ticket
  // and the QA↔fix loop can converge at max_rerun_attempts.
  rerunGeneration?: number;
  // Sequential-batch wiring. When present, the dispatched QaRun is stamped with
  // its batch membership so completeRun()/the reaper can advance the batch when
  // this run finalizes. Standalone runs omit both.
  batchId?: string;
  batchIndex?: number;
  // Optional opening phase (multi-phase QA, ticket 90cc22f7). When set, the new
  // run is stamped current_phase/current_phase_at + a first phase_history entry
  // at dispatch, so the phase_timeouts reaper measures the opening phase from run
  // start (rather than waiting for the first set_qa_phase). Omit = legacy null.
  initialPhase?: string;
}

export interface StartQaRunResult {
  run: QaRun;
  room_id: string;
  prompt: string;
}

export interface StartBatchArgs {
  workspaceId: string;
  boardId?: string | null;
  // Explicit ordered scenario ids, OR `all: true` to expand to every enabled
  // scenario in scope (workspace + optional board). Exactly one is used —
  // scenarioIds wins if both are given.
  scenarioIds?: string[];
  all?: boolean;
  stopOnFail?: boolean;
  triggeredByType: 'user' | 'system' | 'agent';
  triggeredById: string;
}

export interface RecordStepArgs {
  runId: string;
  workspaceId: string;
  idx: number;
  status: QaStepResult['status'];
  log?: string;
  artifactResourceIds?: string[];
}

export interface RecordHeartbeatArgs {
  runId: string;
  workspaceId: string;
  /** Monotonic progress token; only a STRICT increase resets the liveness deadline. */
  progressToken: number;
  note?: string;
}

/**
 * Owns QaRun lifecycle: dispatch (startQaRun) + result accumulation
 * (recordStep / attachArtifact / completeRun) + history reads.
 *
 * startQaRun mirrors ActionsService.dispatch() 1:1 — it reuses the existing
 * ChatRoom + chat_room_message pipeline instead of inventing a new dispatcher:
 *   1. Create a ChatRoom stamped (by name) as a QA run room.
 *   2. Persist the QaRun row (status=running) with the room id.
 *   3. Add the target QA agent (+ a synthetic 'system' sender) as participants.
 *   4. FIFO-prune older runs beyond scenario.max_runs.
 *   5. Send the rendered step prompt as the first message — the agent-manager
 *      routes chat_room_message to the target agent's session.
 * Re-running a scenario is just calling startQaRun again → a fresh QaRun row,
 * so history is preserved.
 */
@Injectable()
export class QaRunService {
  constructor(
    @InjectRepository(QaScenario) private readonly scenarioRepo: Repository<QaScenario>,
    @InjectRepository(QaRun) private readonly runRepo: Repository<QaRun>,
    @InjectRepository(QaRunBatch) private readonly batchRepo: Repository<QaRunBatch>,
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectRepository(ChatRoomParticipant) private readonly participantRepo: Repository<ChatRoomParticipant>,
    @InjectRepository(ChatRoomMessage) private readonly messageRepo: Repository<ChatRoomMessage>,
    @InjectRepository(TicketAttachment) private readonly attachmentRepo: Repository<TicketAttachment>,
    @InjectRepository(Resource) private readonly resourceRepo: Repository<Resource>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly messaging: RoomMessagingService,
    private readonly logService: LogService,
    private readonly failureTicketService: QaFailureTicketService,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  async listRuns(scenarioId: string, workspaceId: string, limit = 20): Promise<QaRun[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    await findOrFail(this.scenarioRepo, { where: { id: scenarioId, workspace_id: workspaceId } }, 'QA scenario not found in workspace');
    return this.runRepo.find({
      where: { scenario_id: scenarioId, workspace_id: workspaceId },
      order: { created_at: 'DESC' },
      take: Math.min(limit, 100),
    });
  }

  async getRun(runId: string, workspaceId: string): Promise<QaRun> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    return findOrFail(this.runRepo, { where: { id: runId, workspace_id: workspaceId } }, 'QA run not found in workspace');
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  async startQaRun(args: StartQaRunArgs): Promise<StartQaRunResult> {
    const scenario = await findOrFail(this.scenarioRepo, { where: { id: args.scenarioId } }, 'QA scenario not found');
    if (!scenario.target_agent_id) throw makeError(400, 'QA scenario has no target agent set');
    if (scenario.enabled === false) throw makeError(400, 'QA scenario is disabled');

    const agent = await this.agentRepo.findOne({ where: { id: scenario.target_agent_id } });
    if (!agent) throw makeError(400, 'target agent not found');

    // Pre-allocate the run id so the prompt can reference {{run.id}} and we can
    // write a complete row in one INSERT (same rationale as ActionsService).
    const runId = randomUUID();
    const prompt = renderQaRunPrompt(scenario, runId);

    const room = await this.roomRepo.save(this.roomRepo.create({
      workspace_id: scenario.workspace_id,
      type: 'group',
      name: `QA: ${scenario.name} · ${runId.slice(0, 8)}`,
      last_message_at: null,
    }));

    const now = new Date();
    // Optional opening phase (multi-phase QA). Seed current_phase + the deadline
    // baseline + the first (still-open) phase_history entry so the phase_timeouts
    // reaper measures from run start. Empty/whitespace → treated as unset (null).
    const initialPhase = (args.initialPhase || '').trim();
    const run = await this.runRepo.save(this.runRepo.create({
      id: runId,
      scenario_id: scenario.id,
      workspace_id: scenario.workspace_id,
      board_id: scenario.board_id ?? null,
      status: 'running',
      room_id: room.id,
      step_results: [],
      artifact_resource_ids: [],
      summary: '',
      triggered_by_type: args.triggeredByType,
      triggered_by_id: args.triggeredById || '',
      rerun_generation: args.rerunGeneration && args.rerunGeneration > 0 ? Math.floor(args.rerunGeneration) : 0,
      batch_id: args.batchId ?? null,
      batch_index: args.batchIndex ?? null,
      current_phase: initialPhase || null,
      current_phase_at: initialPhase ? now : null,
      phase_history: initialPhase ? [{ phase: initialPhase, entered_at: now.toISOString(), left_at: null }] : null,
      started_at: now,
      finished_at: null,
    }));

    // Add the QA agent as a participant. A synthetic 'system' user carries the
    // first message (no real triggering user in scope), exactly like Actions.
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

    await this._pruneOldRuns(scenario.id, scenario.max_runs);

    // Run-workspace provisioning hint (ticket 25db3cc6 4/5). Resolve the
    // scenario's workspace_folder + repo_ref + checkout_mode into a concrete
    // RunProvision and ship it on the dispatch message so the agent-manager
    // prepares the working folder (clone / fetch+ff-pull, reuse vs fresh) BEFORE
    // the run subagent spawns. Never throws (degrades repo→null on a bad ref).
    const runProvision = await buildRunProvision(this.dataSource, {
      kind: 'qa',
      id: scenario.id,
      runId,
      workspaceId: scenario.workspace_id,
      boardId: scenario.board_id ?? null,
      workspaceFolder: scenario.workspace_folder,
      repoRef: scenario.repo_ref,
      checkoutMode: scenario.checkout_mode,
    });

    try {
      await this.messaging.sendMessage(
        room.id,
        scenario.workspace_id,
        'user',
        'system',
        'QA',
        prompt,
        undefined,
        undefined,
        'message',
        { runProvision },
      );
    } catch (e: any) {
      this.logService.warn('QA', `sendMessage failed for run ${runId}: ${e?.message || e}`);
    }

    this.logService.info('QA', `started qa run ${runId} scenario ${scenario.id} → agent ${agent.id} room ${room.id}`);
    return { run, room_id: room.id, prompt };
  }

  // ── Result accumulation ────────────────────────────────────────────────────

  async recordStep(args: RecordStepArgs): Promise<QaRun> {
    const run = await this.getRun(args.runId, args.workspaceId);
    const results: QaStepResult[] = Array.isArray(run.step_results) ? [...run.step_results] : [];
    const artifacts = (args.artifactResourceIds || []).filter(Boolean);

    const entry: QaStepResult = {
      idx: args.idx,
      status: args.status,
      log: args.log ?? '',
      artifact_resource_ids: artifacts,
    };
    // Upsert by idx so a re-recorded step overwrites rather than duplicates.
    const existingPos = results.findIndex((r) => r.idx === args.idx);
    if (existingPos >= 0) results[existingPos] = entry;
    else results.push(entry);
    results.sort((a, b) => a.idx - b.idx);
    run.step_results = results;

    // Fold the step's artifacts into the flat run-level accumulation.
    if (artifacts.length) {
      const all = new Set([...(run.artifact_resource_ids || []), ...artifacts]);
      run.artifact_resource_ids = Array.from(all);
    }
    return this.runRepo.save(run);
  }

  /**
   * Ingest a liveness heartbeat (ticket 40010b25) — SEPARATE from recordStep so
   * "alive" is decoupled from "recorded a graded step". Records the monotonic
   * progress token as a high-water mark and stamps `liveness_token_at` ONLY on a
   * STRICT increase:
   *   - strict increase  → advance token + reset the deadline clock (the live run
   *                         keeps resetting even with empty step_results — the
   *                         false-reap guard).
   *   - same/lower token → still accepted (a no-progress heartbeat) but does NOT
   *                         touch liveness_token_at, so a dead drive replaying the
   *                         same token cannot keep the run immortal (the
   *                         false-immortal guard).
   * Rejected once the run is terminal — there is nothing left to keep alive.
   */
  async recordHeartbeat(args: RecordHeartbeatArgs): Promise<QaRun> {
    const run = await this.getRun(args.runId, args.workspaceId);
    const terminal: QaRunStatus[] = ['passed', 'failed', 'error'];
    if (terminal.includes(run.status)) {
      throw makeError(409, `QA run is already '${run.status}'; heartbeats are only accepted while running/pending`);
    }
    const token = Number(args.progressToken);
    if (!Number.isFinite(token)) throw makeError(400, 'progress_token must be a finite number');

    const prev = run.liveness_token;
    if (prev == null || token > prev) {
      run.liveness_token = token;
      run.liveness_token_at = new Date();
    }
    // else: a repeat/stale token — keep the high-water mark and its advance time
    // untouched so the deadline is NOT extended.
    return this.runRepo.save(run);
  }

  /**
   * Transition a run to a new phase (multi-phase QA, ticket 90cc22f7). Stamps
   * `current_phase` + `current_phase_at` (the deadline baseline the
   * `phase_timeouts` detector measures from — so entering a phase RESETS its
   * timeout clock) and appends a phase_history entry, closing the previous
   * entry's `left_at`. Rejected once the run is terminal (no phase to enter on a
   * finished run). The phase id is stored verbatim — it need not exist in the
   * resolved qa_phases model; an unmatched phase simply falls back in the reaper.
   *
   * workspaceId is required (scopes the read, like recordStep/completeRun). The
   * MCP/REST surface that exposes this is a follow-up ticket; this is the service
   * entry point so callers (and tests) can drive transitions now.
   */
  async setPhase(runId: string, workspaceId: string, phase: string): Promise<QaRun> {
    const phaseId = (phase || '').trim();
    if (!phaseId) throw makeError(400, 'phase is required');
    const run = await this.getRun(runId, workspaceId);
    const terminal: QaRunStatus[] = ['passed', 'failed', 'error'];
    if (terminal.includes(run.status)) {
      throw makeError(409, `QA run is already '${run.status}'; phase transitions are only accepted while running/pending`);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const history: QaPhaseHistoryEntry[] = Array.isArray(run.phase_history) ? [...run.phase_history] : [];
    // Close the currently-open phase (if any) before opening the new one.
    const last = history[history.length - 1];
    if (last && last.left_at == null) last.left_at = nowIso;
    history.push({ phase: phaseId, entered_at: nowIso, left_at: null });

    run.current_phase = phaseId;
    run.current_phase_at = now;
    run.phase_history = history;
    return this.runRepo.save(run);
  }

  async attachArtifact(runId: string, workspaceId: string, resourceIds: string[]): Promise<QaRun> {
    const run = await this.getRun(runId, workspaceId);
    const add = (resourceIds || []).filter(Boolean);
    if (add.length) {
      const all = new Set([...(run.artifact_resource_ids || []), ...add]);
      run.artifact_resource_ids = Array.from(all);
    }
    return this.runRepo.save(run);
  }

  async completeRun(runId: string, workspaceId: string, status: QaRunStatus, summary?: string, builtCommit?: string): Promise<QaRun> {
    const run = await this.getRun(runId, workspaceId);
    const valid: QaRunStatus[] = ['pending', 'running', 'passed', 'failed', 'error'];
    if (!valid.includes(status)) throw makeError(400, `status must be one of ${valid.join(', ')}`);

    let finalStatus = status;
    let finalSummary = summary;

    // PASSED gates — a self-reported `passed` is never trusted on the agent's
    // word alone. Two independent checks run; either failing downgrades the run
    // to `failed` and appends its reason to the summary.
    //   1) Step gate — the run can't be `passed` if any recorded step is
    //      `failed`, or if any step is still `pending` (incomplete). This stops
    //      the "run=passed 인데 step 은 failed" mismatch the UI surfaced as <100%.
    //   2) Evidence gate — a visual-driver run needs at least one image/video
    //      artifact ("증거 없는 PASSED" guard).
    if (status === 'passed') {
      const reasons: string[] = [];

      const stepGate = this._stepGate(run);
      if (!stepGate.ok) {
        reasons.push(stepGate.reason);
        this.logService.warn(
          'QA',
          `run ${run.id} self-reported passed but ${stepGate.reason} — downgraded to failed`,
        );
      }

      const evidenceGate = await this._evidenceGate(run);
      if (!evidenceGate.ok) {
        reasons.push(evidenceGate.reason);
        this.logService.warn(
          'QA',
          `run ${run.id} self-reported passed but ${evidenceGate.reason} — downgraded to failed`,
        );
      }

      if (reasons.length) {
        finalStatus = 'failed';
        finalSummary = [...reasons, summary].filter(Boolean).join('\n\n');
      }
    }

    run.status = finalStatus;
    if (finalSummary !== undefined) run.summary = finalSummary;
    if (builtCommit) run.built_commit = builtCommit;
    run.finished_at = new Date();
    const saved = await this.runRepo.save(run);

    // Warm-build advance (ticket be2f998a) — the QA mirror of the security
    // last_passed_commit advance (security-run.service.ts). On a genuine PASS with
    // a reported built commit, stamp the scenario's last_built_commit/built_at so
    // decideRunFreshness flips the NEXT run of this scenario cold → warm
    // (cold_then_warm). Without this stamp the "이후 warm" branch never turns on and
    // every run cold-rebuilds (~35min) — the exact bug this ticket fixes.
    //
    // CRITICAL QA-specific difference from the security mirror: gate on
    // `saved.status` (the POST-gate status), NOT the raw `status` arg. A
    // self-reported `passed` that the step/evidence gates above downgraded to
    // `failed` must NOT advance the warm commit — otherwise an unproven run would
    // poison the next run into skipping a needed cold rebuild. Skip silently when
    // no commit was reported (can't warm to an unknown SHA; staying cold is safe).
    if (saved.status === 'passed' && saved.built_commit) {
      await this.scenarioRepo.update(
        { id: saved.scenario_id },
        { last_built_commit: saved.built_commit, built_at: saved.finished_at ?? new Date() },
      );
      this.logService.info(
        'QA',
        `run ${runId} passed → scenario ${saved.scenario_id} last_built_commit advanced to ${saved.built_commit} (next run warm)`,
      );
    }

    // On-failure auto-ticket hook. completeRun is the single QaRun finalization
    // choke point, so the side-effect is called here directly (synchronous,
    // deterministic) rather than via the activity-event indirection. The
    // service is a no-op unless the scenario opts in AND the run failed/errored,
    // and it self-guards against double-filing via run.auto_ticket_id. It never
    // throws, so a side-effect failure can't abort the finalization above.
    if (saved.status === 'failed' || saved.status === 'error') {
      const scenario = await this.scenarioRepo.findOne({ where: { id: saved.scenario_id } });
      if (scenario) {
        const ticketId = await this.failureTicketService.maybeCreateOnFailure(saved, scenario);
        if (ticketId) saved.auto_ticket_id = ticketId;
      }
    }

    // Single terminal point for agent-driven completion → advance the batch
    // (if any) from here. Never let a batch hiccup fail the complete call.
    await this.onRunFinalized(saved).catch((e) =>
      this.logService.warn('QA', `batch advance after completeRun ${runId} failed: ${e?.message || e}`),
    );
    return saved;
  }

  /**
   * Decide whether the recorded step results justify a `passed`. A run is only
   * allowed to pass when every step it recorded resolved cleanly:
   *   - `failed`  → reject (a failed step can never live under a passed run)
   *   - `pending` → reject (incomplete — the step never reached a verdict)
   *   - `skipped` → allowed (intentionally not run, treated as a pass)
   *   - `passed`  → allowed
   * A run with no recorded steps passes the gate (nothing to contradict the
   * agent's verdict — the evidence gate still applies for visual drivers).
   */
  private _stepGate(run: QaRun): { ok: true } | { ok: false; reason: string } {
    const steps = run.step_results || [];
    const failed = steps.filter((s) => s.status === 'failed');
    const pending = steps.filter((s) => s.status === 'pending');
    if (!failed.length && !pending.length) return { ok: true };

    const parts: string[] = [];
    if (failed.length) parts.push(`failed step ${failed.length}개`);
    if (pending.length) parts.push(`미완료(pending) step ${pending.length}개`);
    const idxList = (arr: typeof steps) =>
      arr.map((s) => `#${s.idx}`).join(', ');
    const detail: string[] = [];
    if (failed.length) detail.push(`failed: ${idxList(failed)}`);
    if (pending.length) detail.push(`pending: ${idxList(pending)}`);

    return {
      ok: false,
      reason:
        `⚠️ step 불일치 (step gate): run 은 passed 로 보고됐으나 ${parts.join(', ')}가 ` +
        `남아 있어 PASSED 를 거부하고 failed 로 강등함 (${detail.join(' / ')}). ` +
        `모든 step 이 passed/skipped 여야 passed 가 허용됩니다.`,
    };
  }

  /**
   * Decide whether a run earned its `passed`. Visual drivers (browser /
   * game-client) require at least one image/video artifact among the run's
   * accumulated resources; non-visual drivers always pass the gate (nothing to
   * capture). Returns a downgrade reason when the gate fails.
   */
  private async _evidenceGate(run: QaRun): Promise<{ ok: true } | { ok: false; reason: string }> {
    const scenario = await this.scenarioRepo.findOne({ where: { id: run.scenario_id } });
    const driver = (scenario?.qa_driver || '').toLowerCase();
    if (!VISUAL_DRIVERS.has(driver)) return { ok: true };

    const ids = (run.artifact_resource_ids || []).filter(Boolean);
    if (ids.length) {
      const resources = await this.resourceRepo.find({ where: { id: In(ids) } });
      if (resources.some((r) => isVisualEvidence(r.file_mimetype))) return { ok: true };
    }

    return {
      ok: false,
      reason:
        `⚠️ 증거 누락 (evidence gate): \`${driver}\` visual driver QA run 인데 ` +
        `image/video 아티팩트가 0개라 PASSED 를 거부하고 failed 로 강등함. ` +
        `각 step 의 스크린샷/비디오를 Resource 로 업로드한 뒤 record_qa_step 의 ` +
        `artifact_resource_ids 로 첨부하세요.`,
    };
  }

  /** Cascade helper for QaService.remove — tear down every run + its room. */
  async deleteRunsForScenario(scenarioId: string): Promise<void> {
    const runs = await this.runRepo.find({ where: { scenario_id: scenarioId } });
    for (const r of runs) {
      await this._deleteRunWithRoom(r);
    }
  }

  // ── Sequential batches ──────────────────────────────────────────────────────

  async getBatch(batchId: string, workspaceId: string): Promise<QaRunBatch> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    return findOrFail(this.batchRepo, { where: { id: batchId, workspace_id: workspaceId } }, 'QA batch not found in workspace');
  }

  /**
   * Start a sequential batch: resolve the ordered scenario list, persist the
   * batch row, and dispatch ONLY the first scenario. Subsequent scenarios are
   * dispatched one-at-a-time from onRunFinalized() as each run terminates — so
   * runs never overlap. (A naive for-loop over startQaRun would fire them all
   * at once, since startQaRun returns before the run completes.)
   */
  async startBatch(args: StartBatchArgs): Promise<QaRunBatch> {
    if (!args.workspaceId) throw makeError(400, 'workspace_id is required');
    const scenarioIds = await this._resolveBatchScenarioIds(args);
    if (scenarioIds.length === 0) {
      throw makeError(400, 'no runnable scenarios for this batch (none selected, or none enabled in scope)');
    }

    const batch = await this.batchRepo.save(this.batchRepo.create({
      workspace_id: args.workspaceId,
      board_id: args.boardId ?? null,
      scenario_ids: scenarioIds,
      run_ids: [],
      current_index: 0,
      status: 'running',
      stop_on_fail: !!args.stopOnFail,
      passed: 0,
      failed: 0,
      errored: 0,
      triggered_by_type: args.triggeredByType,
      triggered_by_id: args.triggeredById || '',
      finished_at: null,
    }));

    // Dispatch index 0. _dispatchBatchIndex walks forward past any scenario
    // whose dispatch throws (deleted/disabled), so a bad first scenario can't
    // wedge the whole batch.
    await this._dispatchBatchIndex(batch, 0);
    return this.getBatch(batch.id, args.workspaceId);
  }

  /**
   * Called when a run reaches a terminal status — from completeRun (agent-
   * driven) or the reaper (dead run). If the run belongs to a still-running
   * batch AND is the batch's current index, tally the result and dispatch the
   * next scenario (or finalize the batch). The `batch_index === current_index`
   * check is the idempotency guard: a re-finalized or stale run whose index has
   * already been advanced past is a no-op, so the next scenario is never
   * double-dispatched.
   */
  async onRunFinalized(run: QaRun): Promise<void> {
    if (!run.batch_id || run.batch_index == null) return;
    const batch = await this.batchRepo.findOne({ where: { id: run.batch_id } });
    if (!batch || batch.status !== 'running') return;
    if (run.batch_index !== batch.current_index) return; // already advanced past — idempotent no-op

    // Tally this run into the rollup. Anything not 'passed'/'failed' (i.e.
    // 'error', or a non-terminal value slipping through) counts as errored.
    if (run.status === 'passed') batch.passed += 1;
    else if (run.status === 'failed') batch.failed += 1;
    else batch.errored += 1;

    const ids = Array.isArray(batch.scenario_ids) ? batch.scenario_ids : [];

    // stop-on-fail: halt on the first non-passed run.
    if (batch.stop_on_fail && run.status !== 'passed') {
      batch.status = 'aborted';
      batch.finished_at = new Date();
      await this.batchRepo.save(batch);
      this.logService.info('QA', `batch ${batch.id} aborted at index ${batch.current_index} (stop_on_fail, run ${run.status})`);
      return;
    }

    const nextIndex = batch.current_index + 1;
    if (nextIndex >= ids.length) {
      batch.status = 'done';
      batch.finished_at = new Date();
      await this.batchRepo.save(batch);
      this.logService.info('QA', `batch ${batch.id} done (${batch.passed}P/${batch.failed}F/${batch.errored}E of ${ids.length})`);
      return;
    }

    // Advance the cursor + persist BEFORE the (slow, async) dispatch so a
    // duplicate finalize of this same run sees current_index already moved and
    // no-ops — closing the idempotency window around startQaRun.
    batch.current_index = nextIndex;
    await this.batchRepo.save(batch);
    await this._dispatchBatchIndex(batch, nextIndex);
  }

  /** Resolve the ordered scenario id list for a new batch (explicit list, else all-in-scope). */
  private async _resolveBatchScenarioIds(args: StartBatchArgs): Promise<string[]> {
    // Explicit list wins. Preserve caller order; drop ids that aren't enabled
    // scenarios in this workspace so a stale/foreign id can't wedge the batch.
    if (Array.isArray(args.scenarioIds) && args.scenarioIds.length > 0) {
      const found = await this.scenarioRepo.find({
        where: { id: In(args.scenarioIds), workspace_id: args.workspaceId },
      });
      const byId = new Map(found.map((s) => [s.id, s]));
      return args.scenarioIds.filter((id) => {
        const s = byId.get(id);
        return !!s && s.enabled !== false;
      });
    }
    if (args.all) {
      // Expand to every enabled scenario in scope, mirroring QaService.list:
      // boardId '' = workspace-scope only (board_id IS NULL), <uuid> = that
      // board, omit/null = all rows in the workspace.
      const qb = this.scenarioRepo.createQueryBuilder('s')
        .where('s.workspace_id = :ws', { ws: args.workspaceId })
        .andWhere('s.enabled = :en', { en: true });
      if (args.boardId !== undefined && args.boardId !== null) {
        if (args.boardId) qb.andWhere('s.board_id = :bid', { bid: args.boardId });
        else qb.andWhere('s.board_id IS NULL');
      }
      const rows = await qb.orderBy('s.name', 'ASC').getMany();
      return rows.map((s) => s.id);
    }
    return [];
  }

  /**
   * Dispatch the scenario at `index` for this batch, walking forward past any
   * index whose dispatch throws (scenario deleted/disabled since the batch was
   * built) so one bad scenario can't stall the rest. If every remaining index
   * fails, the batch is finalized as done.
   */
  private async _dispatchBatchIndex(batch: QaRunBatch, index: number): Promise<void> {
    const ids = Array.isArray(batch.scenario_ids) ? batch.scenario_ids : [];
    let i = index;
    while (i < ids.length) {
      batch.current_index = i;
      try {
        const result = await this.startQaRun({
          scenarioId: ids[i],
          triggeredByType: batch.triggered_by_type as StartQaRunArgs['triggeredByType'],
          triggeredById: batch.triggered_by_id,
          batchId: batch.id,
          batchIndex: i,
        });
        const runIds = Array.isArray(batch.run_ids) ? [...batch.run_ids] : [];
        runIds[i] = result.run.id;
        batch.run_ids = runIds;
        await this.batchRepo.save(batch);
        return;
      } catch (e: any) {
        // Scenario gone/disabled at dispatch time — record the skip, count it as
        // errored, and try the next index.
        this.logService.warn('QA', `batch ${batch.id} dispatch index ${i} failed: ${e?.message || e}`);
        const runIds = Array.isArray(batch.run_ids) ? [...batch.run_ids] : [];
        runIds[i] = '';
        batch.run_ids = runIds;
        batch.errored += 1;
        i += 1;
      }
    }
    // Walked off the end — every remaining index failed to dispatch.
    batch.current_index = Math.max(0, ids.length - 1);
    batch.status = 'done';
    batch.finished_at = new Date();
    await this.batchRepo.save(batch);
    this.logService.info('QA', `batch ${batch.id} done — no further runnable scenarios from index ${index}`);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async _pruneOldRuns(scenarioId: string, max: number): Promise<void> {
    const cap = Math.max(1, max || 20);
    const runs = await this.runRepo.find({
      where: { scenario_id: scenarioId },
      order: { created_at: 'DESC' },
    });
    if (runs.length <= cap) return;
    for (const r of runs.slice(cap)) {
      await this._deleteRunWithRoom(r);
    }
  }

  private async _deleteRunWithRoom(run: QaRun): Promise<void> {
    if (run.room_id) {
      await this.attachmentRepo.delete({ room_id: run.room_id });
      await this.messageRepo.delete({ room_id: run.room_id });
      await this.participantRepo.delete({ room_id: run.room_id });
      await this.roomRepo.delete({ id: run.room_id });
    }
    await this.runRepo.delete({ id: run.id });
  }
}
