import { normalizeRuntimeSpec } from '../../common/runtime-spec';
import { RuntimeHost } from '../../entities/RuntimeHost';
/**
 * OutreachChannelService — CRUD + validation for OutreachChannel (ticket
 * 2500fea3 step 7). Mirrors QaScheduleService's CRUD shape: plain validated
 * create/update/remove, `next_poll_at` recomputed via
 * OutreachPollingService.computeNextPoll whenever cadence or enable-state
 * could have moved it (same "recompute on cadence/enable change" contract
 * QaScheduleService.update documents).
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { OutreachChannel, OutreachChannelKind, OutreachPublishPolicy, OutreachDeployPostMode } from '../../entities/OutreachChannel';
import { OutreachInboundItem } from '../../entities/OutreachInboundItem';
import { Credential } from '../../entities/Credential';
import { Project } from '../../entities/Project';
import { normalizeTags } from '../tickets/ticket.service';
import { resolveCallerIdentityRow } from '../mcp/shared/authz';
import { findOrFail } from '../../common/find-or-fail';
import { agentIsVisibleInWorkspace } from '../../common/agent-account-scope';
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
  accountId: string;
  kind: OutreachChannelKind;
  name: string;
  targets?: string[];
  credentialId?: string | null;
  enabled?: boolean;
  publishPolicy?: OutreachPublishPolicy;
  rateLimitPerHour?: number;
  /** Tags every ticket this channel files carries (on top of the provenance tags). */
  targetTags?: string[] | null;
  /** Project those tickets are about — its default assignee picks them up. */
  targetProjectId?: string | null;
  pollIntervalMs?: number;
  pollCron?: string | null;
  classifyThreshold?: number;
  classifierRuntime?: Record<string, any> | null;
  deployPostMode?: OutreachDeployPostMode;
  replyThreadRef?: string | null;
  autoReuseWindowDays?: number;
  targetEnvironment?: string | null;
  closeOnResolve?: boolean;
}

export type UpdateChannelInput = Partial<Omit<CreateChannelInput, 'accountId'>>;

export interface ChannelStatus {
  channel_id: string;
  last_poll_at: Date | null;
  next_poll_at: Date | null;
  counts: Record<string, number>;
  // Connector health (ticket d86d0c24 review fix #2) — see OutreachChannel's
  // docstring on these columns and outreach-channel-health.ts for the
  // update/clear policy.
  blocked_at: Date | null;
  blocked_reason: string;
  rate_limited_until: Date | null;
  last_error: string;
  last_error_at: Date | null;
}

@Injectable()
export class OutreachChannelService {
  constructor(
    @InjectRepository(OutreachChannel) private readonly channelRepo: Repository<OutreachChannel>,
    @InjectRepository(OutreachInboundItem) private readonly itemRepo: Repository<OutreachInboundItem>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pollingService: OutreachPollingService,
  ) {}

  async list(accountId: string): Promise<OutreachChannel[]> {
    if (!accountId) throw makeError(400, 'account_id is required');
    return this.channelRepo.find({ where: { account_id: accountId }, order: { created_at: 'DESC' } });
  }

  async get(id: string, accountId: string): Promise<OutreachChannel> {
    if (!accountId) throw makeError(400, 'account_id is required');
    return findOrFail(
      this.channelRepo,
      { where: { id, account_id: accountId } },
      'Outreach channel not found in workspace',
    );
  }

  async create(input: CreateChannelInput): Promise<OutreachChannel> {
    if (!input.accountId) throw makeError(400, 'account_id is required');
    if (!VALID_KINDS.includes(input.kind)) throw makeError(400, `kind must be one of: ${VALID_KINDS.join(', ')}`);
    if (!input.name || !input.name.trim()) throw makeError(400, 'name is required');
    await this._assertCredentialScope(input.credentialId ?? null, input.accountId);
    const targetProjectId = await this._assertProjectScope(input.targetProjectId ?? null, input.accountId);
    const classifierRuntime = await this._validateClassifierRuntime(input.classifierRuntime ?? null, input.accountId);
    const deployPostMode = this._validateDeployPostMode(input.deployPostMode);
    const replyThreadRef = this._sanitizeThreadRef(input.replyThreadRef);
    this._assertReplyThreadRefPresence(deployPostMode, replyThreadRef);

    const draft = this.channelRepo.create({
      account_id: input.accountId,
      kind: input.kind,
      name: input.name.trim(),
      targets: this._sanitizeTargets(input.targets),
      credential_id: input.credentialId || null,
      enabled: input.enabled !== false,
      publish_policy: this._validatePolicy(input.publishPolicy),
      rate_limit_per_hour: this._validateRateLimit(input.rateLimitPerHour),
      target_tags: normalizeTags(input.targetTags ?? []),
      target_project_id: targetProjectId,
      poll_interval_ms: this._validateInterval(input.pollIntervalMs),
      poll_cron: this._validateCron(input.pollCron ?? null),
      next_poll_at: null,
      last_poll_at: null,
      since_cursor: '',
      classify_threshold: this._validateThreshold(input.classifyThreshold),
      classifier_runtime: classifierRuntime,
      deploy_post_mode: deployPostMode,
      reply_thread_ref: replyThreadRef,
      auto_reuse_window_days: this._validateReuseWindowDays(input.autoReuseWindowDays),
      target_environment: (input.targetEnvironment ?? '').trim(),
      close_on_resolve: input.closeOnResolve === true,
    });
    draft.next_poll_at = this.pollingService.computeNextPoll(draft, new Date());
    return this.channelRepo.save(draft);
  }

  async update(id: string, accountId: string, patch: UpdateChannelInput): Promise<OutreachChannel> {
    const channel = await this.get(id, accountId);

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
      await this._assertCredentialScope(patch.credentialId || null, channel.account_id);
      channel.credential_id = patch.credentialId || null;
    }
    if (patch.targetTags !== undefined) channel.target_tags = normalizeTags(patch.targetTags ?? []);
    if (patch.targetProjectId !== undefined) {
      channel.target_project_id = await this._assertProjectScope(patch.targetProjectId || null, channel.account_id);
    }
    if (patch.publishPolicy !== undefined) channel.publish_policy = this._validatePolicy(patch.publishPolicy);
    if (patch.rateLimitPerHour !== undefined) channel.rate_limit_per_hour = this._validateRateLimit(patch.rateLimitPerHour);
    if (patch.classifyThreshold !== undefined) channel.classify_threshold = this._validateThreshold(patch.classifyThreshold);
    if (patch.classifierRuntime !== undefined) {
      channel.classifier_runtime = await this._validateClassifierRuntime(patch.classifierRuntime || null, channel.account_id);
    }
    if (patch.deployPostMode !== undefined) channel.deploy_post_mode = this._validateDeployPostMode(patch.deployPostMode);
    if (patch.replyThreadRef !== undefined) channel.reply_thread_ref = this._sanitizeThreadRef(patch.replyThreadRef);
    if (patch.autoReuseWindowDays !== undefined) channel.auto_reuse_window_days = this._validateReuseWindowDays(patch.autoReuseWindowDays);
    if (patch.targetEnvironment !== undefined) channel.target_environment = (patch.targetEnvironment ?? '').trim();
    if (patch.closeOnResolve !== undefined) channel.close_on_resolve = patch.closeOnResolve === true;
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

  async remove(id: string, accountId: string): Promise<void> {
    const channel = await this.get(id, accountId);
    await this.channelRepo.delete({ id: channel.id });
  }

  /** last/next poll timestamps + a per-status count rollup of this channel's
   *  OutreachInboundItem rows — the "채널 등록/상태 확인" REST surface the
   *  ticket's 범위 asks for. */
  async status(id: string, accountId: string): Promise<ChannelStatus> {
    const channel = await this.get(id, accountId);
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
      blocked_at: channel.blocked_at,
      blocked_reason: channel.blocked_reason,
      rate_limited_until: channel.rate_limited_until,
      last_error: channel.last_error,
      last_error_at: channel.last_error_at,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _sanitizeTargets(targets: string[] | undefined): string[] {
    return Array.isArray(targets) ? targets.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : [];
  }

  /** Mirrors ResourcesController.assertCredentialScope — a GLOBAL credential
   *  (account_id=null) or one scoped to the SAME workspace is available; a
   *  cross-workspace credential is rejected. */
  private async _assertCredentialScope(credentialId: string | null, accountId: string): Promise<void> {
    if (!credentialId) return;
    const credential = await this.credentialRepo.findOne({ where: { id: credentialId } });
    if (!credential) throw makeError(400, 'credential not found');
    const available = credential.account_id === null || credential.account_id === accountId;
    if (!available) throw makeError(400, 'credential is not available in this workspace scope');
  }

  /** A configured target_project_id must resolve inside the channel's own
   *  workspace — caught here at save time instead of every filed ticket
   *  failing project validation later. */
  private async _assertProjectScope(projectId: string | null, accountId: string): Promise<string | null> {
    if (!projectId) return null;
    const project = await this.dataSource.getRepository(Project).findOne({ where: { id: projectId, account_id: accountId } });
    if (!project) throw makeError(400, 'target_project_id must reference a project in this workspace');
    return project.id;
  }

  /** A configured classifier_runtime must be visible in the channel's own
   *  workspace — same "caught at save time, not silently ignored" contract
   *  as _assertProjectScope, reusing the same agent-workspace-visibility rule
   *  SecurityProfile.target_agent_id (and 15+ other call sites) already
   *  standardize on: a account-scoped agent must match, but a global
   *  agent (account_id null/'') is visible everywhere. */
  // P4c-4: Host/링크 해소 (Agent 행 없음).
  private async _validateClassifierRuntime(input: unknown, accountId: string): Promise<Record<string, any> | null> {
    if (input == null) return null;
    let spec;
    try { spec = normalizeRuntimeSpec(input, 'classifier_runtime'); }
    catch (error) { throw makeError(400, (error as Error).message); }
    if (!await this.dataSource.getRepository(RuntimeHost).existsBy({ id: spec.manager_agent_id })) throw makeError(400, 'Runtime Host not found');
    await this._assertCredentialScope(spec.credential_id, accountId);
    return { ...spec };
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
