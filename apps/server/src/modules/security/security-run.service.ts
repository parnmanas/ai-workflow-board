import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { SecurityProfile } from '../../entities/SecurityProfile';
import { SecurityRun, SecurityRunStatus, SecurityFinding } from '../../entities/SecurityRun';
import { SecurityRunBatch } from '../../entities/SecurityRunBatch';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { Agent } from '../../entities/Agent';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { LogService } from '../../services/log.service';
import { findOrFail } from '../../common/find-or-fail';
import { renderSecurityRunPrompt, renderChecklistRefreshPrompt } from './security-prompt';
import { SecurityFailureTicketService } from './security-failure-ticket.service';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

const VALID_SEVERITIES: SecurityFinding['severity'][] = ['critical', 'high', 'medium', 'low', 'info'];

/** Normalize a loose finding input into a clean SecurityFinding. */
function normalizeFinding(f: any): SecurityFinding {
  const severity: SecurityFinding['severity'] = VALID_SEVERITIES.includes(f?.severity) ? f.severity : 'info';
  return {
    id: f?.id ? String(f.id) : randomUUID(),
    severity,
    title: String(f?.title ?? ''),
    category: f?.category != null ? String(f.category) : undefined,
    file: f?.file != null ? String(f.file) : undefined,
    line: typeof f?.line === 'number' ? f.line : undefined,
    evidence: f?.evidence != null ? String(f.evidence) : undefined,
    remediation: f?.remediation != null ? String(f.remediation) : undefined,
    checklist_item_id: f?.checklist_item_id != null ? String(f.checklist_item_id) : undefined,
  };
}

export interface StartSecurityRunArgs {
  profileId: string;
  triggeredByType: 'user' | 'system' | 'agent';
  triggeredById: string;
  // Sequential-batch wiring. When present, the dispatched SecurityRun is stamped
  // with its batch membership so completeRun()/the reaper can advance the batch
  // when this run finalizes. Standalone runs omit both.
  batchId?: string;
  batchIndex?: number;
}

export interface StartSecurityRunResult {
  run: SecurityRun;
  room_id: string;
  prompt: string;
}

export interface StartSecurityBatchArgs {
  workspaceId: string;
  boardId?: string | null;
  // Explicit ordered profile ids, OR `all: true` to expand to every enabled
  // profile in scope (workspace + optional board). Exactly one is used —
  // profileIds wins if both are given.
  profileIds?: string[];
  all?: boolean;
  stopOnFail?: boolean;
  triggeredByType: 'user' | 'system' | 'agent';
  triggeredById: string;
}

export interface RefreshChecklistArgs {
  profileId: string;
  triggeredByType: 'user' | 'system' | 'agent';
  triggeredById: string;
}

export interface RefreshChecklistResult {
  profile_id: string;
  room_id: string;
  prompt: string;
}

export interface CompleteSecurityRunArgs {
  summary?: string;
  /** The worktree HEAD SHA the agent inspected. On a PASS this becomes the profile's new baseline. */
  scannedCommit?: string;
  /** The scope the run actually used (the agent may promote incremental → full). */
  scopeUsed?: 'incremental' | 'full';
}

/**
 * Owns SecurityRun lifecycle: dispatch (startRun) + finding accumulation
 * (recordFindings / attachArtifact) + completion (completeRun) + history reads.
 *
 * startRun mirrors QaRunService.startQaRun 1:1 — it reuses the existing ChatRoom
 * + chat_room_message pipeline rather than inventing a new dispatcher:
 *   1. Decide the scope: incremental (baseline = profile.last_passed_commit) when
 *      scope_mode='incremental' and a baseline exists; else full (no baseline).
 *   2. Create a ChatRoom for the run.
 *   3. Persist the SecurityRun row (status=running) with the scope bookkeeping.
 *   4. Add the inspection agent (+ a synthetic 'system' sender) as participants.
 *   5. FIFO-prune older runs beyond profile.max_runs.
 *   6. Send the rendered inspection prompt as the first message.
 *
 * completeRun(status='passed') advances profile.last_passed_commit to the run's
 * scanned_commit, so the next incremental run diffs from there.
 */
@Injectable()
export class SecurityRunService {
  constructor(
    @InjectRepository(SecurityProfile) private readonly profileRepo: Repository<SecurityProfile>,
    @InjectRepository(SecurityRun) private readonly runRepo: Repository<SecurityRun>,
    @InjectRepository(SecurityRunBatch) private readonly batchRepo: Repository<SecurityRunBatch>,
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectRepository(ChatRoomParticipant) private readonly participantRepo: Repository<ChatRoomParticipant>,
    @InjectRepository(ChatRoomMessage) private readonly messageRepo: Repository<ChatRoomMessage>,
    @InjectRepository(TicketAttachment) private readonly attachmentRepo: Repository<TicketAttachment>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly messaging: RoomMessagingService,
    private readonly logService: LogService,
    private readonly failureTicketService: SecurityFailureTicketService,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  async listRuns(profileId: string, workspaceId: string, limit = 20): Promise<SecurityRun[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    await findOrFail(this.profileRepo, { where: { id: profileId, workspace_id: workspaceId } }, 'security profile not found in workspace');
    return this.runRepo.find({
      where: { profile_id: profileId, workspace_id: workspaceId },
      order: { created_at: 'DESC' },
      take: Math.min(limit, 100),
    });
  }

  async getRun(runId: string, workspaceId: string): Promise<SecurityRun> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    return findOrFail(this.runRepo, { where: { id: runId, workspace_id: workspaceId } }, 'security run not found in workspace');
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  async startRun(args: StartSecurityRunArgs): Promise<StartSecurityRunResult> {
    const profile = await findOrFail(this.profileRepo, { where: { id: args.profileId } }, 'security profile not found');
    if (!profile.target_agent_id) throw makeError(400, 'security profile has no target agent set');
    if (profile.enabled === false) throw makeError(400, 'security profile is disabled');

    const agent = await this.agentRepo.findOne({ where: { id: profile.target_agent_id } });
    if (!agent) throw makeError(400, 'target agent not found');

    // Scope decision: incremental needs both scope_mode='incremental' and a
    // baseline SHA. Without a baseline (first run, or scope_mode='full') the run
    // is a full inspection with no baseline.
    const useIncremental = profile.scope_mode !== 'full' && !!profile.last_passed_commit;
    const baselineCommit = useIncremental ? profile.last_passed_commit : null;
    const scopeUsed: 'incremental' | 'full' = useIncremental ? 'incremental' : 'full';

    // Pre-allocate the run id so the prompt can reference it and we write a
    // complete row in one INSERT (same rationale as QaRunService).
    const runId = randomUUID();

    const room = await this.roomRepo.save(this.roomRepo.create({
      workspace_id: profile.workspace_id,
      type: 'group',
      name: `Security: ${profile.name} · ${runId.slice(0, 8)}`,
      last_message_at: null,
    }));

    const now = new Date();
    const run = await this.runRepo.save(this.runRepo.create({
      id: runId,
      profile_id: profile.id,
      workspace_id: profile.workspace_id,
      board_id: profile.board_id ?? null,
      status: 'running',
      room_id: room.id,
      findings: [],
      scanned_commit: '',
      baseline_commit: baselineCommit,
      scope_used: scopeUsed,
      artifact_resource_ids: [],
      summary: '',
      triggered_by_type: args.triggeredByType,
      triggered_by_id: args.triggeredById || '',
      batch_id: args.batchId ?? null,
      batch_index: args.batchIndex ?? null,
      started_at: now,
      finished_at: null,
    }));

    const prompt = renderSecurityRunPrompt(profile, run);

    // Add the inspection agent as a participant. A synthetic 'system' user
    // carries the first message (no real triggering user in scope), like QA.
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

    await this._pruneOldRuns(profile.id, profile.max_runs);

    try {
      await this.messaging.sendMessage(
        room.id,
        profile.workspace_id,
        'user',
        'system',
        'Security',
        prompt,
      );
    } catch (e: any) {
      this.logService.warn('Security', `sendMessage failed for run ${runId}: ${e?.message || e}`);
    }

    this.logService.info('Security', `started security run ${runId} profile ${profile.id} scope=${scopeUsed} baseline=${baselineCommit ?? '(none)'} → agent ${agent.id} room ${room.id}`);
    return { run, room_id: room.id, prompt };
  }

  // ── Checklist refresh ───────────────────────────────────────────────────────

  /**
   * Dispatch a "refresh the checklist with the latest security info" task to the
   * profile's target agent. Deliberately NOT a SecurityRun: a refresh produces an
   * updated `checklist`, not `findings`, so stacking it as a run would pollute the
   * pass/fail run history (and confuse the incremental baseline). It reuses only
   * the ChatRoom dispatch half of startRun — create a room, add the agent (+ a
   * synthetic 'system' sender), post the refresh prompt. The agent then folds the
   * WebSearched guidance back in via the existing `update_security_profile` tool.
   */
  async startChecklistRefresh(args: RefreshChecklistArgs): Promise<RefreshChecklistResult> {
    const profile = await findOrFail(this.profileRepo, { where: { id: args.profileId } }, 'security profile not found');
    if (!profile.target_agent_id) throw makeError(400, 'security profile has no target agent set');
    if (profile.enabled === false) throw makeError(400, 'security profile is disabled');

    const agent = await this.agentRepo.findOne({ where: { id: profile.target_agent_id } });
    if (!agent) throw makeError(400, 'target agent not found');

    const room = await this.roomRepo.save(this.roomRepo.create({
      workspace_id: profile.workspace_id,
      type: 'group',
      name: `Security checklist refresh: ${profile.name}`,
      last_message_at: null,
    }));

    const prompt = renderChecklistRefreshPrompt(profile);

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
        profile.workspace_id,
        'user',
        'system',
        'Security',
        prompt,
      );
    } catch (e: any) {
      this.logService.warn('Security', `sendMessage failed for checklist refresh of profile ${profile.id}: ${e?.message || e}`);
    }

    this.logService.info('Security', `dispatched checklist refresh for profile ${profile.id} → agent ${agent.id} room ${room.id}`);
    return { profile_id: profile.id, room_id: room.id, prompt };
  }

  // ── Finding accumulation ────────────────────────────────────────────────────

  /** Record (upsert by finding id) one or more findings on a running run. */
  async recordFindings(runId: string, workspaceId: string, findings: any[]): Promise<SecurityRun> {
    const run = await this.getRun(runId, workspaceId);
    const current: SecurityFinding[] = Array.isArray(run.findings) ? [...run.findings] : [];
    for (const raw of findings || []) {
      const entry = normalizeFinding(raw);
      const pos = current.findIndex((f) => f.id === entry.id);
      if (pos >= 0) current[pos] = entry;
      else current.push(entry);
    }
    run.findings = current;
    return this.runRepo.save(run);
  }

  async attachArtifact(runId: string, workspaceId: string, resourceIds: string[]): Promise<SecurityRun> {
    const run = await this.getRun(runId, workspaceId);
    const add = (resourceIds || []).filter(Boolean);
    if (add.length) {
      const all = new Set([...(run.artifact_resource_ids || []), ...add]);
      run.artifact_resource_ids = Array.from(all);
    }
    return this.runRepo.save(run);
  }

  async completeRun(runId: string, workspaceId: string, status: SecurityRunStatus, args: CompleteSecurityRunArgs = {}): Promise<SecurityRun> {
    const run = await this.getRun(runId, workspaceId);
    const valid: SecurityRunStatus[] = ['pending', 'running', 'passed', 'failed', 'error'];
    if (!valid.includes(status)) throw makeError(400, `status must be one of ${valid.join(', ')}`);
    run.status = status;
    if (args.summary !== undefined) run.summary = args.summary;
    if (args.scannedCommit) run.scanned_commit = args.scannedCommit;
    if (args.scopeUsed === 'incremental' || args.scopeUsed === 'full') run.scope_used = args.scopeUsed;
    run.finished_at = new Date();
    const saved = await this.runRepo.save(run);

    // On a PASS, advance the profile's baseline so the next incremental run only
    // diffs from this run's scanned commit. Requires a reported scanned_commit;
    // skip silently if the agent didn't report one (can't advance to unknown).
    if (status === 'passed' && saved.scanned_commit) {
      await this.profileRepo.update(
        { id: saved.profile_id },
        { last_passed_commit: saved.scanned_commit },
      );
      this.logService.info('Security', `run ${runId} passed → profile ${saved.profile_id} last_passed_commit advanced to ${saved.scanned_commit}`);
    }

    // On-failure auto-ticket hook. completeRun is the single agent-driven
    // SecurityRun finalization choke point, so the side-effect is called here
    // directly (synchronous, deterministic) rather than via activity-event
    // indirection. The service is a no-op unless the profile opts in AND the run
    // failed/errored AND a finding meets the severity gate; it self-guards
    // against double-filing via run.auto_ticket_id and never throws, so a
    // side-effect failure can't abort the finalization above.
    if (saved.status === 'failed' || saved.status === 'error') {
      const profile = await this.profileRepo.findOne({ where: { id: saved.profile_id } });
      if (profile) {
        const ticketId = await this.failureTicketService.maybeCreateOnFailure(saved, profile);
        if (ticketId) saved.auto_ticket_id = ticketId;
      }
    }

    // Single terminal point for agent-driven completion → advance the sequential
    // batch (if any) from here. Never let a batch hiccup fail the complete call.
    await this.onRunFinalized(saved).catch((e) =>
      this.logService.warn('Security', `batch advance after completeRun ${runId} failed: ${e?.message || e}`),
    );
    return saved;
  }

  // ── Sequential batches (수동 전체 점검) ───────────────────────────────────────

  async getBatch(batchId: string, workspaceId: string): Promise<SecurityRunBatch> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    return findOrFail(this.batchRepo, { where: { id: batchId, workspace_id: workspaceId } }, 'security batch not found in workspace');
  }

  /**
   * Start a sequential batch: resolve the ordered profile list, persist the
   * batch row, and dispatch ONLY the first profile. Subsequent profiles are
   * dispatched one-at-a-time from onRunFinalized() as each run terminates — so
   * runs never overlap (the "동시 금지" constraint). A naive for-loop over startRun
   * would fire them all at once, since startRun returns before the run completes.
   */
  async startBatch(args: StartSecurityBatchArgs): Promise<SecurityRunBatch> {
    if (!args.workspaceId) throw makeError(400, 'workspace_id is required');
    const profileIds = await this._resolveBatchProfileIds(args);
    if (profileIds.length === 0) {
      throw makeError(400, 'no runnable profiles for this batch (none selected, or none enabled in scope)');
    }

    const batch = await this.batchRepo.save(this.batchRepo.create({
      workspace_id: args.workspaceId,
      board_id: args.boardId ?? null,
      profile_ids: profileIds,
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

    // Dispatch index 0. _dispatchBatchIndex walks forward past any profile whose
    // dispatch throws (deleted/disabled), so a bad first profile can't wedge the
    // whole batch.
    await this._dispatchBatchIndex(batch, 0);
    return this.getBatch(batch.id, args.workspaceId);
  }

  /**
   * Called when a run reaches a terminal status — from completeRun (agent-driven)
   * or the reaper (dead run). If the run belongs to a still-running batch AND is
   * the batch's current index, tally the result and dispatch the next profile (or
   * finalize the batch). The `batch_index === current_index` check is the
   * idempotency guard: a re-finalized or stale run whose index has already been
   * advanced past is a no-op, so the next profile is never double-dispatched.
   */
  async onRunFinalized(run: SecurityRun): Promise<void> {
    if (!run.batch_id || run.batch_index == null) return;
    const batch = await this.batchRepo.findOne({ where: { id: run.batch_id } });
    if (!batch || batch.status !== 'running') return;
    if (run.batch_index !== batch.current_index) return; // already advanced past — idempotent no-op

    // Tally this run into the rollup. Anything not 'passed'/'failed' (i.e.
    // 'error', or a non-terminal value slipping through) counts as errored.
    if (run.status === 'passed') batch.passed += 1;
    else if (run.status === 'failed') batch.failed += 1;
    else batch.errored += 1;

    const ids = Array.isArray(batch.profile_ids) ? batch.profile_ids : [];

    // stop-on-fail: halt on the first non-passed run.
    if (batch.stop_on_fail && run.status !== 'passed') {
      batch.status = 'aborted';
      batch.finished_at = new Date();
      await this.batchRepo.save(batch);
      this.logService.info('Security', `batch ${batch.id} aborted at index ${batch.current_index} (stop_on_fail, run ${run.status})`);
      return;
    }

    const nextIndex = batch.current_index + 1;
    if (nextIndex >= ids.length) {
      batch.status = 'done';
      batch.finished_at = new Date();
      await this.batchRepo.save(batch);
      this.logService.info('Security', `batch ${batch.id} done (${batch.passed}P/${batch.failed}F/${batch.errored}E of ${ids.length})`);
      return;
    }

    // Advance the cursor + persist BEFORE the (slow, async) dispatch so a
    // duplicate finalize of this same run sees current_index already moved and
    // no-ops — closing the idempotency window around startRun.
    batch.current_index = nextIndex;
    await this.batchRepo.save(batch);
    await this._dispatchBatchIndex(batch, nextIndex);
  }

  /** Resolve the ordered profile id list for a new batch (explicit list, else all-in-scope). */
  private async _resolveBatchProfileIds(args: StartSecurityBatchArgs): Promise<string[]> {
    // Explicit list wins. Preserve caller order; drop ids that aren't enabled
    // profiles in this workspace so a stale/foreign id can't wedge the batch.
    if (Array.isArray(args.profileIds) && args.profileIds.length > 0) {
      const found = await this.profileRepo.find({
        where: { id: In(args.profileIds), workspace_id: args.workspaceId },
      });
      const byId = new Map(found.map((p) => [p.id, p]));
      return args.profileIds.filter((id) => {
        const p = byId.get(id);
        return !!p && p.enabled !== false;
      });
    }
    if (args.all) {
      // Expand to every enabled profile in scope, mirroring SecurityProfileService.list:
      // boardId '' = workspace-scope only (board_id IS NULL), <uuid> = that board,
      // omit/null = all rows in the workspace. Resolved AT DISPATCH TIME so profile
      // add/remove is reflected automatically (the schedule keeps no id snapshot).
      const qb = this.profileRepo.createQueryBuilder('p')
        .where('p.workspace_id = :ws', { ws: args.workspaceId })
        .andWhere('p.enabled = :en', { en: true });
      if (args.boardId !== undefined && args.boardId !== null) {
        if (args.boardId) qb.andWhere('p.board_id = :bid', { bid: args.boardId });
        else qb.andWhere('p.board_id IS NULL');
      }
      const rows = await qb.orderBy('p.name', 'ASC').getMany();
      return rows.map((p) => p.id);
    }
    return [];
  }

  /**
   * Dispatch the profile at `index` for this batch, walking forward past any
   * index whose dispatch throws (profile deleted/disabled since the batch was
   * built) so one bad profile can't stall the rest. If every remaining index
   * fails, the batch is finalized as done.
   */
  private async _dispatchBatchIndex(batch: SecurityRunBatch, index: number): Promise<void> {
    const ids = Array.isArray(batch.profile_ids) ? batch.profile_ids : [];
    let i = index;
    while (i < ids.length) {
      batch.current_index = i;
      try {
        const result = await this.startRun({
          profileId: ids[i],
          triggeredByType: batch.triggered_by_type as StartSecurityRunArgs['triggeredByType'],
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
        // Profile gone/disabled at dispatch time — record the skip, count it as
        // errored, and try the next index.
        this.logService.warn('Security', `batch ${batch.id} dispatch index ${i} failed: ${e?.message || e}`);
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
    this.logService.info('Security', `batch ${batch.id} done — no further runnable profiles from index ${index}`);
  }

  /** Cascade helper for SecurityProfileService.remove — tear down every run + its room. */
  async deleteRunsForProfile(profileId: string): Promise<void> {
    const runs = await this.runRepo.find({ where: { profile_id: profileId } });
    for (const r of runs) {
      await this._deleteRunWithRoom(r);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async _pruneOldRuns(profileId: string, max: number): Promise<void> {
    const cap = Math.max(1, max || 20);
    const runs = await this.runRepo.find({
      where: { profile_id: profileId },
      order: { created_at: 'DESC' },
    });
    if (runs.length <= cap) return;
    for (const r of runs.slice(cap)) {
      await this._deleteRunWithRoom(r);
    }
  }

  private async _deleteRunWithRoom(run: SecurityRun): Promise<void> {
    if (run.room_id) {
      await this.attachmentRepo.delete({ room_id: run.room_id });
      await this.messageRepo.delete({ room_id: run.room_id });
      await this.participantRepo.delete({ room_id: run.room_id });
      await this.roomRepo.delete({ id: run.room_id });
    }
    await this.runRepo.delete({ id: run.id });
  }
}
