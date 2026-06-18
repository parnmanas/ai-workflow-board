import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { QaScenario } from '../../entities/QaScenario';
import { QaRun, QaRunStatus, QaStepResult } from '../../entities/QaRun';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { Agent } from '../../entities/Agent';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { LogService } from '../../services/log.service';
import { findOrFail } from '../../common/find-or-fail';
import { renderQaRunPrompt } from './qa-prompt';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export interface StartQaRunArgs {
  scenarioId: string;
  triggeredByType: 'user' | 'system' | 'agent';
  triggeredById: string;
}

export interface StartQaRunResult {
  run: QaRun;
  room_id: string;
  prompt: string;
}

export interface RecordStepArgs {
  runId: string;
  workspaceId: string;
  idx: number;
  status: QaStepResult['status'];
  log?: string;
  artifactResourceIds?: string[];
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
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectRepository(ChatRoomParticipant) private readonly participantRepo: Repository<ChatRoomParticipant>,
    @InjectRepository(ChatRoomMessage) private readonly messageRepo: Repository<ChatRoomMessage>,
    @InjectRepository(TicketAttachment) private readonly attachmentRepo: Repository<TicketAttachment>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly messaging: RoomMessagingService,
    private readonly logService: LogService,
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

    try {
      await this.messaging.sendMessage(
        room.id,
        scenario.workspace_id,
        'user',
        'system',
        'QA',
        prompt,
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

  async attachArtifact(runId: string, workspaceId: string, resourceIds: string[]): Promise<QaRun> {
    const run = await this.getRun(runId, workspaceId);
    const add = (resourceIds || []).filter(Boolean);
    if (add.length) {
      const all = new Set([...(run.artifact_resource_ids || []), ...add]);
      run.artifact_resource_ids = Array.from(all);
    }
    return this.runRepo.save(run);
  }

  async completeRun(runId: string, workspaceId: string, status: QaRunStatus, summary?: string): Promise<QaRun> {
    const run = await this.getRun(runId, workspaceId);
    const valid: QaRunStatus[] = ['pending', 'running', 'passed', 'failed', 'error'];
    if (!valid.includes(status)) throw makeError(400, `status must be one of ${valid.join(', ')}`);
    run.status = status;
    if (summary !== undefined) run.summary = summary;
    run.finished_at = new Date();
    return this.runRepo.save(run);
  }

  /** Cascade helper for QaService.remove — tear down every run + its room. */
  async deleteRunsForScenario(scenarioId: string): Promise<void> {
    const runs = await this.runRepo.find({ where: { scenario_id: scenarioId } });
    for (const r of runs) {
      await this._deleteRunWithRoom(r);
    }
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
