/**
 * Marketing MCP 툴 — 캠페인 에이전트가 루프를 도는 표면(docs/marketing.md).
 *
 * 전부 authz tier `caller` 다. 게이트는 "세션 없는 호출이 아님" 만 보고, 진짜 인가는 여기서 한다:
 *   1. DB-backed caller(API 키 세션)여야 한다 — env/dev 키는 누가 했는지 남길 수 없다.
 *   2. 캠페인의 **소유 계정**에 접근할 수 있어야 한다(callerCanAccessAccount, 요청 인자의 account_id 를 믿지 않는다).
 *   3. 캠페인 상태 · capability · 일일 상한은 MarketingAgentService 가 적용한다.
 *
 * 승인 · 거부 · 결제 기록 툴은 의도적으로 **없다** — 돈과 외부 발신은 사람이 화면에서 정한다.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MarketingCampaign } from '../../../entities/MarketingCampaign';
import type { MarketingActor } from '../../../common/marketing/marketing-constants';
import { callerCanAccessAccount, resolveCallerAccountId } from '../shared/authz';
import { getCallerAgent } from '../shared/session-auth';
import { ok, err } from '../shared/helpers';
import type { ToolContext } from './context';

const CALLER_ERROR = 'Unauthorized: marketing tools require a DB-backed MCP key (an agent session)';
const ACCESS_ERROR = 'Unauthorized: caller cannot access this campaign\'s account';

export function registerMarketingTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, marketingAgentService } = ctx;

  function dbCaller(extra: { sessionId?: string }) {
    const caller = getCallerAgent(extra);
    if (!caller || caller.source !== 'db' || !caller.agentId) return null;
    return caller;
  }

  function actorOf(caller: NonNullable<ReturnType<typeof dbCaller>>): MarketingActor {
    const id = caller.runtimeKey || caller.agentId || '';
    return { type: 'agent', id, name: caller.agentName || id };
  }

  /** 캠페인을 읽고 호출자가 그 소유 계정에 접근할 수 있는지 본다. */
  async function campaignFor(extra: { sessionId?: string }, campaignId: string): Promise<
    { campaign: MarketingCampaign; actor: MarketingActor } | { error: string }
  > {
    if (!marketingAgentService) return { error: 'Marketing service unavailable in this MCP context' };
    const caller = dbCaller(extra);
    if (!caller) return { error: CALLER_ERROR };
    const campaign = await marketingAgentService.findCampaign(campaignId);
    // 접근할 수 없는 캠페인은 "없음" 과 같은 답을 준다 — 다른 계정의 id 존재 여부를 흘리지 않는다.
    if (!campaign || !(await callerCanAccessAccount(dataSource, caller, campaign.account_id))) {
      return { error: campaign ? ACCESS_ERROR : 'campaign not found' };
    }
    return { campaign, actor: actorOf(caller) };
  }

  server.tool(
    'list_marketing_campaigns',
    'List marketing campaigns the caller can work on (docs/marketing.md). Each campaign is a product-marketing loop run by an agent: enabled capabilities, cadence, budget limits. Callers: a DB-backed agent session; results are limited to the caller\'s own account.',
    {
      account_id: z.string().optional().describe('Restrict to one accessible account (default: the caller\'s account)'),
      status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
    },
    async ({ account_id, status }, extra) => {
      if (!marketingAgentService) return err('Marketing service unavailable in this MCP context');
      const caller = dbCaller(extra);
      if (!caller) return err(CALLER_ERROR);
      try {
        let scope: string[] | 'all';
        if (account_id) {
          if (!(await callerCanAccessAccount(dataSource, caller, account_id))) return err(ACCESS_ERROR);
          scope = [account_id];
        } else {
          const own = await resolveCallerAccountId(dataSource, caller);
          // 계정에 묶이지 않은 전역 Host 키만 모든 계정을 본다(callerCanAccessAccount 와 같은 규칙).
          scope = own ? [own] : (await callerCanAccessAccount(dataSource, caller, null)) ? 'all' : [];
        }
        let rows = await marketingAgentService.listCampaigns(scope);
        if (status) rows = rows.filter((r) => r.status === status);
        return ok(rows.map((c) => ({
          id: c.id,
          account_id: c.account_id,
          name: c.name,
          status: c.status,
          capabilities: c.capabilities,
          project_id: c.project_id,
          next_cycle_at: c.next_cycle_at,
          last_cycle_at: c.last_cycle_at,
        })));
      } catch (e: any) {
        return err(e?.message || 'Failed to list campaigns');
      }
    },
  );

  server.tool(
    'get_marketing_campaign',
    'Get one marketing campaign: product brief, goal, audience, enabled capabilities, budget limits, payees, allowed link domains, daily limits, and the rules the server enforces on agents. Read this before acting on a campaign.',
    {
      campaign_id: z.string().describe('Campaign id'),
    },
    async ({ campaign_id }, extra) => {
      const found = await campaignFor(extra, campaign_id);
      if ('error' in found) return err(found.error);
      try {
        return ok(await marketingAgentService!.overview(found.campaign));
      } catch (e: any) {
        return err(e?.message || 'Failed to read campaign');
      }
    },
  );

  server.tool(
    'propose_marketing_channel',
    'Propose a channel (community, forum, newsletter, social account, mailing list …) where the campaign\'s product should be talked about. A human approves it before anything can be posted there. Needs capability channel_discovery. Base the proposal on pages you actually opened: list them in evidence_urls, quote the community\'s self-promotion rules (rules_summary + rules_url), and say why the audience fits. Re-proposing the same platform+target returns the existing channel (duplicate: true).',
    {
      campaign_id: z.string(),
      platform: z.enum(['reddit', 'github', 'hacker_news', 'product_hunt', 'x', 'linkedin', 'discord', 'slack', 'forum', 'blog', 'newsletter', 'youtube', 'email', 'other']),
      target: z.string().describe('reddit: subreddit name; github: owner/repo; others: the URL or list name'),
      name: z.string().optional().describe('Short display name'),
      rationale: z.string().describe('Why this channel fits the product and goal'),
      audience_fit: z.string().optional(),
      audience_size: z.number().int().nonnegative().optional().describe('Members/followers/subscribers you observed'),
      audience_observed_at: z.string().optional().describe('ISO date you observed audience_size'),
      evidence_urls: z.array(z.string()).min(1).max(10).describe('Pages you actually opened while researching'),
      rules_summary: z.string().optional().describe('The community\'s self-promotion / posting rules, quoted or summarized'),
      rules_url: z.string().optional(),
      guidelines: z.string().optional().describe('Proposed tone, posting frequency, do and don\'t for this channel'),
    },
    async ({ campaign_id, ...body }, extra) => {
      const found = await campaignFor(extra, campaign_id);
      if ('error' in found) return err(found.error);
      try {
        return ok(await marketingAgentService!.proposeChannel(found.campaign, body, found.actor));
      } catch (e: any) {
        return err(e?.message || 'Failed to propose channel');
      }
    },
  );

  server.tool(
    'draft_marketing_post',
    'Draft a message for an approved channel: a community post, a reply to a thread, or (on an email channel) a campaign email. A person approves (and may edit) it before anything is sent; the campaign disclosure line is appended automatically to community posts and the legal footer + unsubscribe link to emails. Needs capability community_post (or email for email channels). Write for the channel: follow its guidelines and self-promotion rules, be useful first, never pretend to be an unaffiliated user. Use dedupe_key to make retries safe.',
    {
      campaign_id: z.string(),
      channel_id: z.string(),
      title: z.string().optional().describe('Post title (required for new reddit/github posts) or the email subject'),
      body: z.string().describe('Markdown body (plain text for email)'),
      reply_to: z.string().optional().describe('Reply instead of a new post: reddit fullname (t3_…/t1_…) or github issue:{owner}/{repo}#{n}'),
      rationale: z.string().describe('Why this message, for this channel, now'),
      dedupe_key: z.string().optional(),
      cycle_id: z.string().optional(),
    },
    async ({ campaign_id, cycle_id, ...body }, extra) => {
      const found = await campaignFor(extra, campaign_id);
      if ('error' in found) return err(found.error);
      try {
        return ok(await marketingAgentService!.draftPost(found.campaign, body, found.actor, cycle_id || null));
      } catch (e: any) {
        return err(e?.message || 'Failed to draft post');
      }
    },
  );

  server.tool(
    'propose_marketing_budget_allocation',
    'Propose how the campaign budget is split across approved channels for one budget period (the campaign\'s budget_period; whole campaign when "none"). A person with marketing.approve_spend approves it; spend on a channel needs its approved allocation. Base it on results (get_marketing_report) and cite them in rationale. Needs capability paid_spend. Amounts are integers in minor units of the campaign currency (KRW 50000 = ₩50,000; USD 1250 = $12.50). A new proposal for a channel replaces its undecided earlier proposal.',
    {
      campaign_id: z.string(),
      allocations: z.array(z.object({
        channel_id: z.string(),
        amount_minor: z.number().int().nonnegative(),
      })).min(1).max(20),
      rationale: z.string().describe('Why this split — cite the channel results it is based on'),
    },
    async ({ campaign_id, ...body }, extra) => {
      const found = await campaignFor(extra, campaign_id);
      if ('error' in found) return err(found.error);
      try {
        return ok(await marketingAgentService!.proposeAllocation(found.campaign, body, found.actor));
      } catch (e: any) {
        return err(e?.message || 'Failed to propose allocation');
      }
    },
  );

  server.tool(
    'request_marketing_spend',
    'Ask a person to approve a payment (ad spend, sponsorship, tool fee …) for an approved channel. Nothing is paid until a person with marketing.approve_spend approves it; the payment method is set by people on the campaign, not by you. Refused immediately when it would exceed the per-transaction cap, the remaining campaign/period budget, or the channel\'s approved allocation, or when payee is not on the campaign payee allowlist. Amounts are integers in minor units. Use dedupe_key to make retries safe. Needs capability paid_spend.',
    {
      campaign_id: z.string(),
      channel_id: z.string(),
      amount_minor: z.number().int().positive(),
      currency: z.string().describe('ISO 4217; must equal the campaign currency'),
      payee: z.string().describe('Exact name from the campaign payees allowlist'),
      purpose: z.string().describe('What the money buys'),
      expected_outcome: z.string().describe('What it should achieve and how you will measure it'),
      payload: z.record(z.string(), z.any()).optional().describe('Execution details the payment endpoint needs (ad set, dates, targeting …). Max 8 KB. Never put secrets here.'),
      dedupe_key: z.string().optional(),
      cycle_id: z.string().optional().describe('The marketing cycle this belongs to, if any'),
    },
    async ({ campaign_id, cycle_id, ...body }, extra) => {
      const found = await campaignFor(extra, campaign_id);
      if ('error' in found) return err(found.error);
      try {
        return ok(await marketingAgentService!.requestSpend(found.campaign, body, found.actor, cycle_id || null));
      } catch (e: any) {
        return err(e?.message || 'Failed to request spend');
      }
    },
  );

  server.tool(
    'get_marketing_spend_request',
    'Read one spend request: status (pending, approved, executing, paid, failed, unknown, denied, expired, cancelled), approvals, payment result and error.',
    {
      spend_request_id: z.string(),
    },
    async ({ spend_request_id }, extra) => {
      if (!marketingAgentService) return err('Marketing service unavailable in this MCP context');
      const campaignId = await marketingAgentService.campaignOfSpendRequest(spend_request_id);
      if (!campaignId) return err('spend request not found');
      const found = await campaignFor(extra, campaignId);
      if ('error' in found) return err(found.error === ACCESS_ERROR ? 'spend request not found' : found.error);
      try {
        return ok(await marketingAgentService.getSpendRequest(found.campaign, spend_request_id));
      } catch (e: any) {
        return err(e?.message || 'Failed to read spend request');
      }
    },
  );
}
