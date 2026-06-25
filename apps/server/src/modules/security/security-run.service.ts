import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { SecurityProfile } from '../../entities/SecurityProfile';
import { SecurityRun, SecurityRunStatus, SecurityFinding } from '../../entities/SecurityRun';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { Agent } from '../../entities/Agent';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { LogService } from '../../services/log.service';
import { findOrFail } from '../../common/find-or-fail';
import { renderSecurityRunPrompt } from './security-prompt';

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
}

export interface StartSecurityRunResult {
  run: SecurityRun;
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
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectRepository(ChatRoomParticipant) private readonly participantRepo: Repository<ChatRoomParticipant>,
    @InjectRepository(ChatRoomMessage) private readonly messageRepo: Repository<ChatRoomMessage>,
    @InjectRepository(TicketAttachment) private readonly attachmentRepo: Repository<TicketAttachment>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly messaging: RoomMessagingService,
    private readonly logService: LogService,
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
    return saved;
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
