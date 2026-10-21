/**
 * REST 와 MCP 가 같은 모양을 내리도록 직렬화를 한곳에 둔다.
 */
import type { MarketingCampaign } from '../../entities/MarketingCampaign';
import type { MarketingAuditEvent } from '../../entities/MarketingAuditEvent';
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
