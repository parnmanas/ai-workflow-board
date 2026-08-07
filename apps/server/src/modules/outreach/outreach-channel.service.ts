/**
 * OutreachChannelService — CRUD + validation for OutreachChannel (ticket
 * 2500fea3 step 7). Mirrors QaScheduleService's CRUD shape: plain validated
 * create/update/remove, `next_poll_at` recomputed via
 * OutreachPollingService.computeNextPoll whenever cadence or enable-state
 * could have moved it (same "recompute on cadence/enable change" contract
 * QaScheduleService.update documents).
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OutreachChannel, OutreachChannelKind, OutreachPublishPolicy, OutreachDeployPostMode } from '../../entities/OutreachChannel';
import { OutreachInboundItem } from '../../entities/OutreachInboundItem';
import { Credential } from '../../entities/Credential';
import { Board } from '../../entities/Board';
import { Agent } from '../../entities/Agent';
import { findOrFail } from '../../common/find-or-fail';
import { agentIsVisibleInWorkspace } from '../../common/agent-workspace-scope';
import { isValidCron } from '../qa/qa-cron';
import { OutreachPollingService } from './outreach-polling.service';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

const VALID_KINDS: OutreachChannelKind[] = ['reddit', 'github'];
const VALID_POLICIES: OutreachPublishPolicy[] = ['auto', 'approval', 'off'];
const VALID_DEPLOY_MODES: OutreachDeployPostMode[] = ['new_post', 'reply_to_existing', 'auto', 'off'];
const DEFAULT_POLL_INTERVAL_MS = 3_600_000;
const MIN_POLL_INTERVAL_MS = 60_000; // 1 minute — a channel polling faster than this is almost certainly a misconfiguration

export interface CreateChannelInput {
  workspaceId: string;
  kind: OutreachChannelKind;
  name: string;
  targets?: string[];
  credentialId?: string | null;
  enabled?: boolean;
  publishPolicy?: OutreachPublishPolicy;
  rateLimitPerHour?: number;
  targetBoardId?: string | null;
  pollIntervalMs?: number;
  pollCron?: string | null;
  classifyThreshold?: number;
  classifierAgentId?: string | null;
  deployPostMode?: OutreachDeployPostMode;
  replyThreadRef?: string | null;
  autoReuseWindowDays?: number;
}

export type UpdateChannelInput = Partial<Omit<CreateChannelInput, 'workspaceId'>>;

export interface ChannelStatus {
  channel_id: string;
  last_poll_at: Date | null;
  next_poll_at: Date | null;
  counts: Record<string, number>;
}

@Injectable()
export class OutreachChannelService {
  constructor(
    @InjectRepository(OutreachChannel) private readonly channelRepo: Repository<OutreachChannel>,
    @InjectRepository(OutreachInboundItem) private readonly itemRepo: Repository<OutreachInboundItem>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly pollingService: OutreachPollingService,
  ) {}

  async list(workspaceId: string): Promise<OutreachChannel[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    return this.channelRepo.find({ where: { workspace_id: workspaceId }, order: { created_at: 'DESC' } });
  }

  async get(id: string, workspaceId: string): Promise<OutreachChannel> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    return findOrFail(
      this.channelRepo,
      { where: { id, workspace_id: workspaceId } },
      'Outreach channel not found in workspace',
    );
  }

  async create(input: CreateChannelInput): Promise<OutreachChannel> {
    if (!input.workspaceId) throw makeError(400, 'workspace_id is required');
    if (!VALID_KINDS.includes(input.kind)) throw makeError(400, `kind must be one of: ${VALID_KINDS.join(', ')}`);
    if (!input.name || !input.name.trim()) throw makeError(400, 'name is required');
    await this._assertCredentialScope(input.credentialId ?? null, input.workspaceId);
    const targetBoardId = await this._assertBoardScope(input.targetBoardId ?? null, input.workspaceId);
    const classifierAgentId = await this._assertAgentScope(input.classifierAgentId ?? null, input.workspaceId);
    const deployPostMode = this._validateDeployPostMode(input.deployPostMode);
    const replyThreadRef = this._sanitizeThreadRef(input.replyThreadRef);
    this._assertReplyThreadRefPresence(deployPostMode, replyThreadRef);

    const draft = this.channelRepo.create({
      workspace_id: input.workspaceId,
      kind: input.kind,
      name: input.name.trim(),
      targets: this._sanitizeTargets(input.targets),
      credential_id: input.credentialId || null,
      enabled: input.enabled !== false,
      publish_policy: this._validatePolicy(input.publishPolicy),
      rate_limit_per_hour: this._validateRateLimit(input.rateLimitPerHour),
      target_board_id: targetBoardId,
      poll_interval_ms: this._validateInterval(input.pollIntervalMs),
      poll_cron: this._validateCron(input.pollCron ?? null),
      next_poll_at: null,
      last_poll_at: null,
      since_cursor: '',
      classify_threshold: this._validateThreshold(input.classifyThreshold),
      classifier_agent_id: classifierAgentId,
      deploy_post_mode: deployPostMode,
      reply_thread_ref: replyThreadRef,
      auto_reuse_window_days: this._validateReuseWindowDays(input.autoReuseWindowDays),
    });
    draft.next_poll_at = this.pollingService.computeNextPoll(draft, new Date());
    return this.channelRepo.save(draft);
  }

  async update(id: string, workspaceId: string, patch: UpdateChannelInput): Promise<OutreachChannel> {
    const channel = await this.get(id, workspaceId);

    if (patch.kind !== undefined) {
      if (!VALID_KINDS.includes(patch.kind)) throw makeError(400, `kind must be one of: ${VALID_KINDS.join(', ')}`);
      channel.kind = patch.kind;
    }
    if (patch.name !== undefined) {
      if (!patch.name || !patch.name.trim()) throw makeError(400, 'name cannot be empty');
      channel.name = patch.name.trim();
    }
    if (patch.targets !== undefined) channel.targets = this._sanitizeTargets(patch.targets);
    if (patch.credentialId !== undefined) {
      await this._assertCredentialScope(patch.credentialId || null, channel.workspace_id);
      channel.credential_id = patch.credentialId || null;
    }
    if (patch.targetBoardId !== undefined) {
      channel.target_board_id = await this._assertBoardScope(patch.targetBoardId || null, channel.workspace_id);
    }
    if (patch.publishPolicy !== undefined) channel.publish_policy = this._validatePolicy(patch.publishPolicy);
    if (patch.rateLimitPerHour !== undefined) channel.rate_limit_per_hour = this._validateRateLimit(patch.rateLimitPerHour);
    if (patch.classifyThreshold !== undefined) channel.classify_threshold = this._validateThreshold(patch.classifyThreshold);
    if (patch.classifierAgentId !== undefined) {
      channel.classifier_agent_id = await this._assertAgentScope(patch.classifierAgentId || null, channel.workspace_id);
    }
    if (patch.deployPostMode !== undefined) channel.deploy_post_mode = this._validateDeployPostMode(patch.deployPostMode);
    if (patch.replyThreadRef !== undefined) channel.reply_thread_ref = this._sanitizeThreadRef(patch.replyThreadRef);
    if (patch.autoReuseWindowDays !== undefined) channel.auto_reuse_window_days = this._validateReuseWindowDays(patch.autoReuseWindowDays);
    this._assertReplyThreadRefPresence(channel.deploy_post_mode, channel.reply_thread_ref);

    // Cadence / enable-state — recompute next_poll_at whenever any of these
    // could have moved it, same contract QaScheduleService.update documents.
    let cadenceChanged = false;
    if (patch.pollCron !== undefined) {
      channel.poll_cron = this._validateCron(patch.pollCron);
      cadenceChanged = true;
    }
    if (patch.pollIntervalMs !== undefined) {
      channel.poll_interval_ms = this._validateInterval(patch.pollIntervalMs);
      cadenceChanged = true;
    }
    if (patch.enabled !== undefined) {
      channel.enabled = patch.enabled;
      cadenceChanged = true;
    }
    if (cadenceChanged) {
      channel.next_poll_at = this.pollingService.computeNextPoll(channel, new Date());
    }

    return this.channelRepo.save(channel);
  }

  async remove(id: string, workspaceId: string): Promise<void> {
    const channel = await this.get(id, workspaceId);
    await this.channelRepo.delete({ id: channel.id });
  }

  /** last/next poll timestamps + a per-status count rollup of this channel's
   *  OutreachInboundItem rows — the "채널 등록/상태 확인" REST surface the
   *  ticket's 범위 asks for. */
  async status(id: string, workspaceId: string): Promise<ChannelStatus> {
    const channel = await this.get(id, workspaceId);
    const rows = await this.itemRepo
      .createQueryBuilder('i')
      .select('i.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('i.channel_id = :id', { id: channel.id })
      .groupBy('i.status')
      .getRawMany();
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = Number(row.count);
    return {
      channel_id: channel.id,
      last_poll_at: channel.last_poll_at,
      next_poll_at: channel.next_poll_at,
      counts,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _sanitizeTargets(targets: string[] | undefined): string[] {
    return Array.isArray(targets) ? targets.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : [];
  }

  /** Mirrors ResourcesController.assertCredentialScope — a GLOBAL credential
   *  (workspace_id=null) or one scoped to the SAME workspace is available; a
   *  legacy Board-scoped or cross-workspace credential is rejected. */
  private async _assertCredentialScope(credentialId: string | null, workspaceId: string): Promise<void> {
    if (!credentialId) return;
    const credential = await this.credentialRepo.findOne({ where: { id: credentialId } });
    if (!credential) throw makeError(400, 'credential not found');
    const available = credential.workspace_id === null
      || (credential.workspace_id === workspaceId && credential.board_id === null);
    if (!available) throw makeError(400, 'credential is not available in this workspace scope');
  }

  /** A configured target_board_id must resolve inside the channel's own
   *  workspace — caught here at save time instead of failing silently into
   *  the "earliest board" fallback at ticket-creation time. */
  private async _assertBoardScope(boardId: string | null, workspaceId: string): Promise<string | null> {
    if (!boardId) return null;
    const board = await this.boardRepo.findOne({ where: { id: boardId, workspace_id: workspaceId } });
    if (!board) throw makeError(400, 'target_board_id must reference a board in this workspace');
    return board.id;
  }

  /** A configured classifier_agent_id must be visible in the channel's own
   *  workspace — same "caught at save time, not silently ignored" contract
   *  as _assertBoardScope, reusing the same agent-workspace-visibility rule
   *  SecurityProfile.target_agent_id (and 15+ other call sites) already
   *  standardize on: a workspace-scoped agent must match, but a global
   *  agent (workspace_id null/'') is visible everywhere. */
  private async _assertAgentScope(agentId: string | null, workspaceId: string): Promise<string | null> {
    if (!agentId) return null;
    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    if (!agent) throw makeError(400, 'classifier_agent_id not found');
    if (!agentIsVisibleInWorkspace(agent.workspace_id, workspaceId)) {
      throw makeError(400, 'classifier_agent_id must belong to this workspace');
    }
    return agent.id;
  }

  private _validateCron(cron: string | null | undefined): string | null {
    if (!cron) return null;
    if (!isValidCron(cron.trim())) {
      throw makeError(400, `invalid poll_cron expression: "${cron}" (5 UTC fields, e.g. "0 * * * *")`);
    }
    return cron.trim();
  }

  private _validateInterval(intervalMs: number | undefined): number {
    if (intervalMs === undefined) return DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_POLL_INTERVAL_MS) {
      throw makeError(400, `poll_interval_ms must be >= ${MIN_POLL_INTERVAL_MS}`);
    }
    return Math.floor(intervalMs);
  }

  private _validatePolicy(policy: OutreachPublishPolicy | undefined): OutreachPublishPolicy {
    if (policy === undefined) return 'approval';
    if (!VALID_POLICIES.includes(policy)) throw makeError(400, `publish_policy must be one of: ${VALID_POLICIES.join(', ')}`);
    return policy;
  }

  private _validateRateLimit(rate: number | undefined): number {
    if (rate === undefined) return 0;
    if (!Number.isFinite(rate) || rate < 0) throw makeError(400, 'rate_limit_per_hour must be >= 0');
    return Math.floor(rate);
  }

  private _validateThreshold(threshold: number | undefined): number {
    if (threshold === undefined) return 70;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw makeError(400, 'classify_threshold must be between 0 and 100');
    }
    return Math.floor(threshold);
  }

  private _validateDeployPostMode(mode: OutreachDeployPostMode | undefined): OutreachDeployPostMode {
    if (mode === undefined) return 'off';
    if (!VALID_DEPLOY_MODES.includes(mode)) {
      throw makeError(400, `deploy_post_mode must be one of: ${VALID_DEPLOY_MODES.join(', ')}`);
    }
    return mode;
  }

  private _sanitizeThreadRef(ref: string | null | undefined): string | null {
    if (!ref) return null;
    const trimmed = ref.trim();
    return trimmed || null;
  }

  /** deploy_post_mode='reply_to_existing' has nothing to reply to without a
   *  fixed thread ref — reject at save time rather than silently no-op'ing
   *  every deploy. */
  private _assertReplyThreadRefPresence(mode: OutreachDeployPostMode, replyThreadRef: string | null): void {
    if (mode === 'reply_to_existing' && !replyThreadRef) {
      throw makeError(400, "reply_thread_ref is required when deploy_post_mode='reply_to_existing'");
    }
  }

  private _validateReuseWindowDays(days: number | undefined): number {
    if (days === undefined) return 30;
    if (!Number.isFinite(days) || days <= 0) throw makeError(400, 'auto_reuse_window_days must be > 0');
    return Math.floor(days);
  }
}
