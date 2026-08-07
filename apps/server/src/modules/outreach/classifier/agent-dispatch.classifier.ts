/**
 * AgentDispatchClassifier — the real (LLM-backed) OutreachClassifier (ticket
 * 20fa0197, 2500fea3 D5's follow-up). When the channel names a
 * `classifier_agent_id`, classify() opens a ChatRoom (mirrors
 * SecurityRunService.startChecklistRefresh's minimal dispatch shape — room +
 * two participants + one prompt, no run-tracking row), asks that agent to
 * classify the item, and waits on ClassificationBridgeService for
 * `record_outreach_classification` to report back — bounded by
 * OUTREACH_CLASSIFIER_TIMEOUT_MS.
 *
 * RuleBasedClassifier is kept as the fallback (the ticket's own open
 * question — "keep as fallback, or replace outright?" — resolved as "keep,
 * both roles"): it's used directly when no agent is configured
 * (classifier_agent_id is the per-channel opt-in), and as the safety net
 * when dispatch fails or the agent doesn't report back in time. A channel
 * that never sets classifier_agent_id sees zero behavior change from before
 * this ticket.
 *
 * This is the one place in the outreach pipeline that genuinely blocks on an
 * agent (see ClassificationBridgeService's docstring for why that's a
 * deliberate, narrow exception rather than the norm) — OutreachPollingService
 * processes channels sequentially, so a slow/stuck classification delays
 * that channel's poll (and any channel queued after it in the same tick's
 * batch) by up to the timeout. That's an accepted, opt-in tradeoff: it only
 * happens for channels an operator explicitly pointed at a classifier agent.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../../entities/Agent';
import { ChatRoom } from '../../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../../entities/ChatRoomParticipant';
import { LogService } from '../../../services/log.service';
import { agentIsVisibleInWorkspace } from '../../../common/agent-workspace-scope';
import { RoomMessagingService } from '../../chat-rooms/room-messaging.service';
import { clampEnv } from '../outreach-polling.service';
import { InboundItem } from '../connectors/types';
import { ClassificationContext, ClassificationResult, OutreachClassifier } from './types';
import { RuleBasedClassifier } from './rule-based.classifier';
import { ClassificationBridgeService } from './classification-bridge.service';
import { renderOutreachClassificationPrompt } from './outreach-classification-prompt';

const DEFAULT_TIMEOUT_MS = 120_000;  // 2 minutes — a classification task is small; long enough for a real agent turn, short enough to bound a stalled poll tick.
// Exported so tests can drive the timeout path without waiting on an
// unrealistically long production floor.
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 10 * 60_000;

@Injectable()
export class AgentDispatchClassifier implements OutreachClassifier {
  private readonly fallback = new RuleBasedClassifier();
  // Read at construction (once, DI is a singleton) — same pattern
  // OutreachPollingService uses for its own env-driven tickMs/enabled fields.
  private readonly timeoutMs = clampEnv('OUTREACH_CLASSIFIER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

  constructor(
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectRepository(ChatRoomParticipant) private readonly participantRepo: Repository<ChatRoomParticipant>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly messaging: RoomMessagingService,
    private readonly bridge: ClassificationBridgeService,
    private readonly logService: LogService,
  ) {}

  async classify(item: InboundItem, context: ClassificationContext): Promise<ClassificationResult> {
    if (!context.classifierAgentId) return this.fallback.classify(item);

    const agent = await this.agentRepo.findOne({ where: { id: context.classifierAgentId } });
    if (!agent) {
      this.logService.warn('Outreach', `classifier_agent_id ${context.classifierAgentId} not found — falling back to rule-based`, {
        channel_id: context.channelId,
      });
      return this.fallback.classify(item);
    }
    // Re-check visibility at dispatch time, not just at channel-save time
    // (outreach-channel.service.ts's _assertAgentScope): if the agent's
    // workspace_id changed since classifier_agent_id was configured, a
    // stale channel must not hand inbound item content to an agent outside
    // its workspace.
    if (!agentIsVisibleInWorkspace(agent.workspace_id, context.workspaceId)) {
      this.logService.warn('Outreach', `classifier_agent_id ${agent.id} is no longer visible in workspace ${context.workspaceId} — falling back to rule-based`, {
        channel_id: context.channelId,
      });
      return this.fallback.classify(item);
    }

    const { runId, result } = this.bridge.register(agent.id, this.timeoutMs);
    try {
      await this._dispatch(context, agent, item, runId);
    } catch (e: any) {
      this.bridge.cancel(runId);
      this.logService.warn('Outreach', `classification dispatch failed — falling back to rule-based: ${e?.message || e}`, {
        channel_id: context.channelId, run_id: runId,
      });
      return this.fallback.classify(item);
    }

    const report = await result;
    if (!report) {
      this.logService.warn('Outreach', `classification timed out after ${this.timeoutMs}ms — falling back to rule-based`, {
        channel_id: context.channelId, run_id: runId, agent_id: agent.id,
      });
      return this.fallback.classify(item);
    }
    return report;
  }

  private async _dispatch(context: ClassificationContext, agent: Agent, item: InboundItem, runId: string): Promise<void> {
    const room = await this.roomRepo.save(this.roomRepo.create({
      workspace_id: context.workspaceId,
      type: 'group',
      name: `Outreach classification: ${(item.title || item.external_item_id || '').slice(0, 150)}`,
      last_message_at: null,
    }));

    const joinedAt = new Date();
    await this.participantRepo.save([
      this.participantRepo.create({
        room_id: room.id, participant_type: 'agent', participant_id: agent.id, last_read_at: joinedAt, left_at: null,
      }),
      this.participantRepo.create({
        room_id: room.id, participant_type: 'user', participant_id: 'system', last_read_at: joinedAt, left_at: null,
      }),
    ]);

    const prompt = renderOutreachClassificationPrompt(context, item, runId);
    await this.messaging.sendMessage(room.id, context.workspaceId, 'user', 'system', 'Outreach', prompt);
  }
}
