/**
 * REST 와 MCP 가 같은 모양을 내리도록 직렬화를 한곳에 둔다.
 */
import type { MarketingCampaign } from '../../entities/MarketingCampaign';
import type { MarketingAuditEvent } from '../../entities/MarketingAuditEvent';
import type { MarketingChannel } from '../../entities/MarketingChannel';
import type { MarketingBudgetAllocation } from '../../entities/MarketingBudgetAllocation';
import type { MarketingSpendRequest } from '../../entities/MarketingSpendRequest';
import type { MarketingLedgerEntry } from '../../entities/MarketingLedgerEntry';
import type { MarketingPost } from '../../entities/MarketingPost';
import type { MarketingLink } from '../../entities/MarketingLink';
import type { MarketingMetric } from '../../entities/MarketingMetric';
import type { MarketingFeedback } from '../../entities/MarketingFeedback';
import { formatMinorAmount } from '../../common/marketing/money';
import { parseRuntimeSpec } from '../../common/runtime-spec';
import { resolveLimits } from './marketing-campaign.logic';

export function campaignToJson(c: MarketingCampaign) {
  const agent = parseRuntimeSpec(c.agent_runtime);
  const improvement = parseRuntimeSpec(c.improvement_assignee);
  return {
    id: c.id,
    account_id: c.account_id,
    project_id: c.project_id,
    name: c.name,
    slug: c.slug,
    status: c.status,
    product_brief: c.product_brief,
    goal: c.goal,
    target_audience: c.target_audience,
    capabilities: c.capabilities || [],
    agent_runtime: agent,
    agent_key: c.agent_key,
    cycle_cron: c.cycle_cron,
    cycle_interval_ms: c.cycle_interval_ms,
    next_cycle_at: c.next_cycle_at,
    last_cycle_at: c.last_cycle_at,
    cycle_count: c.cycle_count,
    currency: c.currency,
    budget_total_minor: c.budget_total_minor,
    budget_period: c.budget_period,
    budget_period_minor: c.budget_period_minor,
    max_transaction_minor: c.max_transaction_minor,
    dual_approval_threshold_minor: c.dual_approval_threshold_minor,
    payment_provider: c.payment_provider,
    payment_credential_id: c.payment_credential_id,
    payees: c.payees || [],
    allowed_domains: c.allowed_domains || [],
    disclosure: c.disclosure,
    limits: resolveLimits(c),
    limit_overrides: c.limits || {},
    feedback_ticket_status: c.feedback_ticket_status,
    improvement_assignee: improvement,
    created_by: c.created_by,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

export function auditToJson(e: MarketingAuditEvent) {
  return {
    id: e.id,
    campaign_id: e.campaign_id,
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    action: e.action,
    actor_type: e.actor_type,
    actor_id: e.actor_id,
    actor_name: e.actor_name,
    summary: e.summary,
    detail: e.detail || {},
    created_at: e.created_at,
  };
}

export function channelToJson(ch: MarketingChannel) {
  const config = ch.config || {};
  return {
    id: ch.id,
    account_id: ch.account_id,
    campaign_id: ch.campaign_id,
    platform: ch.platform,
    kind: ch.kind,
    name: ch.name,
    target: ch.target,
    status: ch.status,
    rationale: ch.rationale,
    audience_fit: ch.audience_fit,
    audience_size: ch.audience_size,
    audience_observed_at: ch.audience_observed_at,
    evidence_urls: ch.evidence_urls || [],
    rules_summary: ch.rules_summary,
    rules_url: ch.rules_url,
    guidelines: ch.guidelines,
    outreach_channel_id: ch.outreach_channel_id,
    // 메일 설정은 그대로 보여 준다(비밀 값은 credential 에만 있고 여기에는 id 만 있다).
    email: ch.kind === 'email' ? config : null,
    proposed_by_type: ch.proposed_by_type,
    proposed_by_id: ch.proposed_by_id,
    proposed_by_name: ch.proposed_by_name,
    decided_by: ch.decided_by,
    decided_by_name: ch.decided_by_name,
    decided_at: ch.decided_at,
    decision_note: ch.decision_note,
    created_at: ch.created_at,
    updated_at: ch.updated_at,
  };
}

export function allocationToJson(a: MarketingBudgetAllocation) {
  return {
    id: a.id,
    campaign_id: a.campaign_id,
    channel_id: a.channel_id,
    batch_id: a.batch_id,
    amount_minor: a.amount_minor,
    amount_text: formatMinorAmount(a.amount_minor, a.currency),
    currency: a.currency,
    status: a.status,
    rationale: a.rationale,
    proposed_by_type: a.proposed_by_type,
    proposed_by_id: a.proposed_by_id,
    proposed_by_name: a.proposed_by_name,
    decided_by: a.decided_by,
    decided_by_name: a.decided_by_name,
    decided_at: a.decided_at,
    decision_note: a.decision_note,
    supersedes_id: a.supersedes_id,
    created_at: a.created_at,
  };
}

export function spendToJson(r: MarketingSpendRequest) {
  return {
    id: r.id,
    account_id: r.account_id,
    campaign_id: r.campaign_id,
    channel_id: r.channel_id,
    amount_minor: r.amount_minor,
    amount_text: formatMinorAmount(r.amount_minor, r.currency),
    currency: r.currency,
    payee: r.payee,
    payee_ref: r.payee_ref,
    purpose: r.purpose,
    expected_outcome: r.expected_outcome,
    provider: r.provider,
    payload: r.payload || {},
    payload_sha256: r.payload_sha256,
    status: r.status,
    dedupe_key: r.dedupe_key,
    requested_by_type: r.requested_by_type,
    requested_by_id: r.requested_by_id,
    requested_by_name: r.requested_by_name,
    cycle_id: r.cycle_id,
    approvals: r.approvals || [],
    decided_by: r.decided_by,
    decided_by_name: r.decided_by_name,
    decided_at: r.decided_at,
    decision_note: r.decision_note,
    expires_at: r.expires_at,
    period_key: r.period_key,
    executing_at: r.executing_at,
    paid_at: r.paid_at,
    provider_ref: r.provider_ref,
    receipt_url: r.receipt_url,
    provider_response: r.provider_response || {},
    error: r.error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function ledgerToJson(e: MarketingLedgerEntry) {
  return {
    id: e.id,
    campaign_id: e.campaign_id,
    channel_id: e.channel_id,
    spend_request_id: e.spend_request_id,
    kind: e.kind,
    amount_minor: e.amount_minor,
    amount_text: formatMinorAmount(e.amount_minor, e.currency),
    currency: e.currency,
    period_key: e.period_key,
    actor_type: e.actor_type,
    actor_id: e.actor_id,
    actor_name: e.actor_name,
    note: e.note,
    created_at: e.created_at,
  };
}

/** `preview_body` 는 승인하면 실제로 나갈 본문(공개 문구 포함) — 승인 화면은 이것을 보여 준다. */
export function postToJson(p: MarketingPost, previewBody?: string) {
  return {
    id: p.id,
    account_id: p.account_id,
    campaign_id: p.campaign_id,
    channel_id: p.channel_id,
    kind: p.kind,
    title: p.title,
    body: p.body,
    preview_body: previewBody ?? (p.final_body || p.body),
    final_body: p.final_body,
    reply_to: p.reply_to,
    target: p.target,
    status: p.status,
    dedupe_key: p.dedupe_key,
    rationale: p.rationale,
    created_by_type: p.created_by_type,
    created_by_id: p.created_by_id,
    created_by_name: p.created_by_name,
    cycle_id: p.cycle_id,
    decided_by: p.decided_by,
    decided_by_name: p.decided_by_name,
    decided_at: p.decided_at,
    decision_note: p.decision_note,
    edited: p.edited,
    external_item_id: p.external_item_id,
    permalink: p.permalink,
    published_at: p.published_at,
    error: p.error,
    link_codes: p.link_codes || [],
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export function linkToJson(l: MarketingLink, url: string | null) {
  return {
    id: l.id,
    campaign_id: l.campaign_id,
    channel_id: l.channel_id,
    post_id: l.post_id,
    code: l.code,
    url,
    destination_url: l.destination_url,
    redirect_url: l.redirect_url,
    label: l.label,
    clicks: l.clicks,
    created_by_type: l.created_by_type,
    created_by_name: l.created_by_name,
    created_at: l.created_at,
  };
}

export function metricToJson(m: MarketingMetric) {
  return {
    id: m.id,
    campaign_id: m.campaign_id,
    channel_id: m.channel_id,
    post_id: m.post_id,
    link_id: m.link_id,
    metric: m.metric,
    value: m.value,
    source: m.source,
    observed_at: m.bucket_start,
    note: m.note,
    recorded_by_type: m.recorded_by_type,
    recorded_by_name: m.recorded_by_name,
    created_at: m.created_at,
  };
}

/**
 * 피드백 직렬화. 에이전트용(`forAgent`)은 외부인이 쓴 필드 이름에 `_untrusted` 를 붙여 데이터임을 이름으로도
 * 드러낸다 — MCP 응답을 읽는 모델이 그 안의 문장을 지시로 받지 않게.
 */
export function feedbackToJson(f: MarketingFeedback, forAgent = false) {
  const external = forAgent
    ? { author_untrusted: f.author, content_untrusted: f.content }
    : { author: f.author, content: f.content };
  return {
    id: f.id,
    campaign_id: f.campaign_id,
    channel_id: f.channel_id,
    post_id: f.post_id,
    source_url: f.source_url,
    ...external,
    summary: f.summary,
    category: f.category,
    sentiment: f.sentiment,
    status: f.status,
    ticket_id: f.ticket_id,
    recorded_by_type: f.recorded_by_type,
    recorded_by_name: f.recorded_by_name,
    cycle_id: f.cycle_id,
    created_at: f.created_at,
  };
}
