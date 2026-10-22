import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { MarketingBrand } from '../../entities/MarketingBrand';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { Credential } from '../../entities/Credential';
import { OUTREACH_PLATFORMS, type ChannelKind, type ChannelPlatform, type MarketingActor } from '../../common/marketing/marketing-constants';
import { OutreachChannelService } from '../outreach/outreach-channel.service';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingCampaignHooks } from './marketing-campaign-hooks';
import { marketingError } from './marketing-errors';
import { defaultKindFor, normalizeChannelProposal, normalizeEmailChannelConfig } from './marketing-channel.logic';
import { assertCredentialInAccount, resolveMarketingSecret } from './marketing-credential';
import { EMAIL_PROVIDERS } from '../../common/marketing/marketing-constants';

export interface ChannelApproval {
  /** outreach | email | manual */
  mode: ChannelKind;
  /** mode=outreach: 이미 있는 OutreachChannel 에 연결. */
  outreach_channel_id?: string | null;
  /** mode=outreach: 새 OutreachChannel 을 만든다(credential 필수). */
  create_outreach?: {
    credential_id: string;
    rate_limit_per_hour?: number;
    /** 이 채널을 폴링해 피드백을 티켓으로 만든다 — 제품 전용 커뮤니티에서만 켤 것. 기본 끔. */
    collect_feedback?: boolean;
  } | null;
  /** mode=email */
  email?: Record<string, unknown> | null;
  note?: string;
}

/**
 * MarketingChannelService — 채널 제안 · 승인 · 연결(docs/marketing.md "채널 탐색").
 *
 * 에이전트는 propose 만 한다. 승인 · 연결 · 일시정지는 사람(REST)만이다. 새 OutreachChannel 은
 * OutreachChannelService.create 를 거쳐 그쪽 검증(credential 범위 · 대상 화이트리스트)을 그대로 탄다.
 * 그렇게 만든 OutreachChannel 은 기본으로 **폴링하지 않는다** — 일반 커뮤니티를 폴링하면 제품과 무관한
 * 글이 분류기를 지나 티켓이 된다. 제품 전용 커뮤니티일 때만 사람이 collect_feedback 을 켠다.
 */
@Injectable()
export class MarketingChannelService {
  constructor(
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(OutreachChannel) private readonly outreachRepo: Repository<OutreachChannel>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    private readonly outreachChannels: OutreachChannelService,
    private readonly audit: MarketingAuditService,
    hooks: MarketingCampaignHooks,
  ) {
    hooks.onDeleteChildren(async (campaign, manager) => {
      await manager.getRepository(MarketingChannel).delete({ campaign_id: campaign.id });
    });
  }

  async list(campaign: MarketingCampaign): Promise<MarketingChannel[]> {
    return this.channelRepo.find({ where: { campaign_id: campaign.id }, order: { created_at: 'ASC' } });
  }

  async get(id: string, accountId: string): Promise<MarketingChannel> {
    const row = id ? await this.channelRepo.findOne({ where: { id } }) : null;
    if (!row || (!accountId || row.account_id !== accountId)) throw marketingError(404, 'channel not found');
    return row;
  }

  /** 캠페인에 속한 채널(에이전트 툴용). 다른 캠페인의 채널 id 는 "없음" 이다. */
  async getInCampaign(campaign: MarketingCampaign, channelId: string): Promise<MarketingChannel> {
    const row = channelId ? await this.channelRepo.findOne({ where: { id: channelId, campaign_id: campaign.id } }) : null;
    if (!row) throw marketingError(404, 'channel not found in this campaign');
    return row;
  }

  async countProposedSince(campaignId: string, since: Date): Promise<number> {
    return this.channelRepo.count({ where: { campaign_id: campaignId, proposed_by_type: 'agent', created_at: MoreThan(since) } });
  }

  /**
   * 제안. 같은 (플랫폼, 대상)이 이미 있으면 새로 만들지 않고 그 행을 돌려준다(`duplicate: true`) —
   * 에이전트가 사이클마다 같은 채널을 다시 찾아도 사람에게 같은 요청이 쌓이지 않는다.
   */
  async propose(
    campaign: MarketingCampaign,
    body: Record<string, unknown>,
    actor: MarketingActor,
  ): Promise<{ channel: MarketingChannel; duplicate: boolean }> {
    const input = normalizeChannelProposal(body, { requireEvidence: actor.type === 'agent' });
    const existing = await this.channelRepo.findOne({
      where: { campaign_id: campaign.id, platform: input.platform, target_key: input.target_key },
    });
    if (existing) return { channel: existing, duplicate: true };
    let saved: MarketingChannel;
    try {
      saved = await this.channelRepo.save(this.channelRepo.create({
        account_id: campaign.account_id,
        campaign_id: campaign.id,
        ...input,
        kind: defaultKindFor(input.platform),
        status: 'proposed',
        outreach_channel_id: null,
        config: {},
        proposed_by_type: actor.type === 'agent' ? 'agent' : 'user',
        proposed_by_id: actor.id,
        proposed_by_name: actor.name,
      }));
    } catch (e) {
      // 동시 제안 경합 — 유일 인덱스가 이긴 쪽을 남긴다.
      const winner = await this.channelRepo.findOne({
        where: { campaign_id: campaign.id, platform: input.platform, target_key: input.target_key },
      });
      if (winner) return { channel: winner, duplicate: true };
      throw e;
    }
    await this.audit.record({
      accountId: campaign.account_id,
      campaignId: campaign.id,
      entityType: 'channel',
      entityId: saved.id,
      action: 'channel.proposed',
      actor,
      summary: `채널 제안: ${saved.platform} · ${saved.target}`,
      detail: { platform: saved.platform, target: saved.target, evidence_urls: saved.evidence_urls },
    });
    this.audit.notify(campaign.account_id, campaign.id, 'channel', saved.id, 'proposed');
    return { channel: saved, duplicate: false };
  }

  /** 사람이 채널 설명 · 가이드 · 규칙을 고친다. 대상(target)은 바꾸지 않는다 — 다른 채널이 된다. */
  async update(id: string, accountId: string, body: Record<string, unknown>, actor: MarketingActor): Promise<MarketingChannel> {
    const row = await this.get(id, accountId);
    const changed: string[] = [];
    const textField = (key: 'name' | 'guidelines' | 'rules_summary' | 'audience_fit' | 'rationale', max: number) => {
      if (body[key] === undefined) return;
      if (typeof body[key] !== 'string') throw marketingError(400, `${key} must be a string`);
      const value = (body[key] as string).trim();
      if (value.length > max) throw marketingError(400, `${key} must be at most ${max} characters`);
      if (key === 'name' && !value) throw marketingError(400, 'name cannot be empty');
      if (value !== row[key]) { row[key] = value; changed.push(key); }
    };
    textField('name', 120);
    textField('guidelines', 4000);
    textField('rules_summary', 4000);
    textField('audience_fit', 4000);
    textField('rationale', 4000);
    if (body.email !== undefined) {
      if (row.kind !== 'email') throw marketingError(400, 'email settings apply only to email channels');
      row.config = await this.normalizeEmail(body.email, row.account_id);
      changed.push('email');
    }
    if (!changed.length) return row;
    const saved = await this.channelRepo.save(row);
    await this.audit.record({
      accountId: row.account_id,
      campaignId: row.campaign_id,
      entityType: 'channel',
      entityId: row.id,
      action: 'channel.updated',
      actor,
      summary: `채널 수정(${row.target}): ${changed.join(', ')}`,
      detail: { changed },
    });
    this.audit.notify(row.account_id, row.campaign_id, 'channel', row.id, 'updated');
    return saved;
  }

  /**
   * 승인 — 사람이 방식을 정한다. outreach 인데 연결이 없으면 `awaiting_credential` 로 둔다(나중에 connect).
   * 승인된 채널만 게시 · 메일 · 지출 대상이 된다.
   */
  async approve(id: string, accountId: string, body: ChannelApproval, actor: MarketingActor, campaign: MarketingCampaign): Promise<MarketingChannel> {
    const row = await this.get(id, accountId);
    if (row.status !== 'proposed' && row.status !== 'rejected') {
      throw marketingError(409, `channel is already ${row.status}`);
    }
    await this.configure(row, body, campaign);
    row.decided_by = actor.id;
    row.decided_by_name = actor.name;
    row.decided_at = new Date();
    row.decision_note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
    const saved = await this.channelRepo.save(row);
    await this.audit.record({
      accountId: row.account_id,
      campaignId: row.campaign_id,
      entityType: 'channel',
      entityId: row.id,
      action: saved.status === 'active' ? 'channel.approved' : 'channel.awaiting_credential',
      actor,
      summary: `채널 승인(${saved.kind}): ${saved.platform} · ${saved.target}${saved.status === 'awaiting_credential' ? ' — credential 연결 대기' : ''}`,
      detail: { kind: saved.kind, status: saved.status, outreach_channel_id: saved.outreach_channel_id, note: saved.decision_note },
    });
    this.audit.notify(row.account_id, row.campaign_id, 'channel', row.id, 'approved');
    return saved;
  }

  /** awaiting_credential 채널을 OutreachChannel 에 잇는다. */
  async connect(id: string, accountId: string, body: ChannelApproval, actor: MarketingActor, campaign: MarketingCampaign): Promise<MarketingChannel> {
    const row = await this.get(id, accountId);
    if (row.status !== 'awaiting_credential') throw marketingError(409, `channel is ${row.status}, not awaiting_credential`);
    await this.configure(row, { ...body, mode: 'outreach' }, campaign);
    // configure() 가 row.status 를 바꾼다 — 좁혀진 타입을 다시 넓혀 읽는다.
    if ((row.status as string) !== 'active') throw marketingError(400, 'outreach_channel_id or create_outreach.credential_id is required');
    const saved = await this.channelRepo.save(row);
    await this.audit.record({
      accountId: row.account_id,
      campaignId: row.campaign_id,
      entityType: 'channel',
      entityId: row.id,
      action: 'channel.connected',
      actor,
      summary: `채널 연결: ${row.platform} · ${row.target}`,
      detail: { outreach_channel_id: row.outreach_channel_id },
    });
    this.audit.notify(row.account_id, row.campaign_id, 'channel', row.id, 'connected');
    return saved;
  }

  async reject(id: string, accountId: string, note: string, actor: MarketingActor): Promise<MarketingChannel> {
    const row = await this.get(id, accountId);
    if (row.status !== 'proposed') throw marketingError(409, `only proposed channels can be rejected (this one is ${row.status})`);
    row.status = 'rejected';
    row.decided_by = actor.id;
    row.decided_by_name = actor.name;
    row.decided_at = new Date();
    row.decision_note = (note || '').trim().slice(0, 1000);
    const saved = await this.channelRepo.save(row);
    await this.audit.record({
      accountId: row.account_id,
      campaignId: row.campaign_id,
      entityType: 'channel',
      entityId: row.id,
      action: 'channel.rejected',
      actor,
      summary: `채널 거부: ${row.platform} · ${row.target}`,
      detail: { note: row.decision_note },
    });
    this.audit.notify(row.account_id, row.campaign_id, 'channel', row.id, 'rejected');
    return saved;
  }

  async setPaused(id: string, accountId: string, paused: boolean, actor: MarketingActor): Promise<MarketingChannel> {
    const row = await this.get(id, accountId);
    const from = paused ? 'active' : 'paused';
    if (row.status !== from) throw marketingError(409, `channel is ${row.status}, expected ${from}`);
    row.status = paused ? 'paused' : 'active';
    const saved = await this.channelRepo.save(row);
    await this.audit.record({
      accountId: row.account_id,
      campaignId: row.campaign_id,
      entityType: 'channel',
      entityId: row.id,
      action: paused ? 'channel.paused' : 'channel.resumed',
      actor,
      summary: `채널 ${paused ? '일시정지' : '재개'}: ${row.platform} · ${row.target}`,
    });
    this.audit.notify(row.account_id, row.campaign_id, 'channel', row.id, paused ? 'paused' : 'resumed');
    return saved;
  }

  /** 다른 기능(게시 · 메일 · 지출)이 쓸 수 있는 채널인지 — 활성이어야 한다. */
  assertUsable(channel: MarketingChannel, kinds?: ChannelKind[]): void {
    if (channel.status !== 'active') throw marketingError(409, `channel "${channel.name}" is ${channel.status} — only active channels can be used`);
    if (kinds && !kinds.includes(channel.kind as ChannelKind)) {
      throw marketingError(400, `channel "${channel.name}" is a ${channel.kind} channel (expected ${kinds.join(' or ')})`);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async configure(row: MarketingChannel, body: ChannelApproval, campaign: MarketingCampaign): Promise<void> {
    const mode = body?.mode;
    if (mode === 'manual') {
      row.kind = 'manual';
      row.status = 'active';
      row.outreach_channel_id = null;
      return;
    }
    if (mode === 'email') {
      if (row.platform !== 'email' && row.platform !== 'newsletter') {
        throw marketingError(400, 'only email/newsletter channels can send email');
      }
      row.kind = 'email';
      row.config = await this.normalizeEmail(body.email, row.account_id);
      row.status = 'active';
      row.outreach_channel_id = null;
      return;
    }
    if (mode !== 'outreach') throw marketingError(400, 'mode must be one of: outreach, email, manual');
    const outreachKind = OUTREACH_PLATFORMS[row.platform as ChannelPlatform];
    if (!outreachKind) throw marketingError(400, `${row.platform} has no outreach connector — approve it as manual`);
    row.kind = 'outreach';

    if (body.outreach_channel_id) {
      const outreach = await this.outreachRepo.findOne({ where: { id: String(body.outreach_channel_id) } });
      if (!outreach || outreach.account_id !== row.account_id) throw marketingError(400, 'outreach channel not found in this account');
      if (outreach.kind !== outreachKind) throw marketingError(400, `outreach channel is ${outreach.kind}, this channel is ${outreachKind}`);
      const targets = (outreach.targets || []).map((t) => t.trim().toLowerCase());
      if (!targets.includes(row.target_key)) {
        throw marketingError(400, `outreach channel "${outreach.name}" does not whitelist ${row.target} — add it to its targets first`);
      }
      if (!outreach.credential_id) throw marketingError(400, `outreach channel "${outreach.name}" has no credential`);
      row.outreach_channel_id = outreach.id;
      row.status = 'active';
      return;
    }

    const create = body.create_outreach;
    if (create?.credential_id) {
      await assertCredentialInAccount(this.credentialRepo, String(create.credential_id), row.account_id);
      let created: OutreachChannel;
      try {
        created = await this.outreachChannels.create({
          accountId: row.account_id,
          kind: outreachKind,
          name: `${campaign.name} · ${row.name}`.slice(0, 120),
          targets: [row.target],
          credentialId: String(create.credential_id),
          enabled: create.collect_feedback === true,
          // 이 OutreachChannel 은 캠페인 게시용이다. 자체 배포 공지는 끈 채로 둔다.
          publishPolicy: 'approval',
          deployPostMode: 'off',
          // 읽기(답글 대상 확인)도 같은 시간당 상한을 쓴다 — 게시만 세는 값보다 넉넉히.
          rateLimitPerHour: Number.isInteger(create.rate_limit_per_hour) ? create.rate_limit_per_hour : 6,
          targetTags: ['marketing', `campaign:${campaign.slug}`],
          targetProjectId: campaign.project_id,
        });
      } catch (e: any) {
        throw marketingError(e?.status || 400, e?.message || 'failed to create outreach channel');
      }
      row.outreach_channel_id = created.id;
      row.status = 'active';
      return;
    }
    // 연결할 것이 아직 없다 — 승인은 하되 쓰지는 못한다.
    row.outreach_channel_id = null;
    row.status = 'awaiting_credential';
  }

  private async normalizeEmail(raw: unknown, accountId: string): Promise<Record<string, any>> {
    const config = normalizeEmailChannelConfig(raw);
    const brand = await this.channelRepo.manager.getRepository(MarketingBrand).findOneBy({ id: config.brand_id, account_id: accountId });
    if (!brand) throw marketingError(404, 'brand not found');
    const secret = await resolveMarketingSecret(this.credentialRepo, config.credential_id, accountId);
    const provider = (secret.provider || '').toLowerCase();
    if (!(EMAIL_PROVIDERS as readonly string[]).includes(provider)) {
      throw marketingError(400, `email credential needs a "provider" field (${EMAIL_PROVIDERS.join(' | ')})`);
    }
    if (!secret.api_key) throw marketingError(400, 'email credential needs an "api_key" field');
    return { ...config, provider };
  }
}
