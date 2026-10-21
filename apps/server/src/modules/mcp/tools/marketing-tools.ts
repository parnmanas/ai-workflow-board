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
}
