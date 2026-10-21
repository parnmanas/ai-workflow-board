import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Account } from '../../../entities/Account';
import { Project } from '../../../entities/Project';
import { RunSkillSnapshot } from '../../../entities/RunSkillSnapshot';
import { Ticket } from '../../../entities/Ticket';
import { knowledgeBlockFor, knowledgeRepos, projectMemoryFor, skillManifestFor, type ManifestEntry } from '../../skills/knowledge';
import { err, ok } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

/**
 * Knowledge 읽기 도구(docs/skills.md "Knowledge") — 공용 메모리 · 프로젝트 메모리 · 배정된 skill.
 *
 * 티켓·미션 지시문은 목차만 싣고, 본문은 여기서 꺼내 읽는다. Agent Session 처럼 AWB 가 지시문을 쓰지
 * 않는 실행도 같은 도구로 같은 지식을 얻는다. 읽기 전용이다 — 배정·편집은 화면(Knowledge)의 몫이다.
 *
 * 계정은 호출자에게서 정한다: 티켓(인자 또는 서브에이전트 티켓) → 프로젝트 → 키의 계정 → Agent Session 의
 * 실행 계정 → 계정에 묶이지 않은 Host 키만 `account_id` 인자. 키가 계정에 묶여 있으면 다른 계정의
 * 티켓·프로젝트는 거부한다.
 */

interface Scope {
  accountId: string;
  projectId: string | null;
  ticketId: string | null;
  runtimeKey: string | null;
}

async function resolveScope(
  ctx: ToolContext,
  extra: { sessionId?: string },
  args: { ticket_id?: string; project_id?: string; account_id?: string },
): Promise<Scope | { error: string }> {
  const caller = getCallerAgent(extra);
  if (!caller) return { error: 'This tool requires an authenticated AWB MCP session.' };
  const bound = caller.accountId || null;
  const ticketId = args.ticket_id || caller.subagentTicketId || null;
  let accountId: string | null = null;
  let projectId: string | null = args.project_id || null;
  if (ticketId) {
    const ticket = await ctx.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId }, select: ['id', 'account_id', 'project_id'] });
    if (!ticket) return { error: `Ticket ${ticketId} not found.` };
    accountId = ticket.account_id;
    projectId = projectId || ticket.project_id || null;
  }
  if (projectId) {
    const project = await ctx.dataSource.getRepository(Project).findOne({ where: { id: projectId }, select: ['id', 'account_id'] });
    if (!project) return { error: `Project ${projectId} not found.` };
    if (accountId && project.account_id !== accountId) return { error: 'The project belongs to a different account than the ticket.' };
    accountId = project.account_id;
  }
  if (!accountId) accountId = bound;
  if (!accountId && caller.agentSessionId && caller.agentId) {
    const execution = await ctx.dataSource.getRepository('AgentSessionExecution').findOne({
      where: { manager_id: caller.agentId, session_id: caller.agentSessionId },
      select: ['account_id'],
    }) as { account_id?: string } | null;
    accountId = execution?.account_id || null;
  }
  if (!accountId && args.account_id) {
    const exists = await ctx.dataSource.getRepository(Account).existsBy({ id: args.account_id });
    if (!exists) return { error: `Account ${args.account_id} not found.` };
    accountId = args.account_id;
  }
  if (!accountId) return { error: 'Cannot tell which account this is for — pass ticket_id, project_id or account_id.' };
  if (bound && accountId !== bound) return { error: 'This API key is bound to a different account.' };
  return { accountId, projectId, ticketId, runtimeKey: caller.runtimeKey || null };
}

/** 티켓이면 그 런에 고정된 manifest(핀된 버전), 아니면 지금 배정으로 푼 manifest. */
async function manifestFor(ctx: ToolContext, scope: Scope): Promise<{ manifest: ManifestEntry[]; pinned: boolean }> {
  if (scope.ticketId) {
    const snapshot = await ctx.dataSource.getRepository(RunSkillSnapshot).findOne({
      where: { account_id: scope.accountId, run_id: `ticket:${scope.ticketId}:assignee` },
    });
    if (snapshot) return { manifest: (snapshot.manifest as ManifestEntry[]) || [], pinned: true };
  }
  return {
    manifest: await skillManifestFor(knowledgeRepos(ctx.dataSource), {
      accountId: scope.accountId,
      runtimeKey: scope.runtimeKey,
      projectId: scope.projectId,
    }),
    pinned: false,
  };
}

const scopeArgs = {
  ticket_id: z.string().optional().describe('Ticket you are working on — serves the skill versions pinned for that run and its project.'),
  project_id: z.string().optional().describe('Project you are working in — adds that project\'s memory and skills.'),
  account_id: z.string().optional().describe('Only for Runtime Host keys not bound to an account and not inside a ticket/session.'),
};

export function registerKnowledgeTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'get_knowledge',
    'Read what AWB wants every agent here to know: the account\'s shared memory, the project memory (when a ticket or project is given) and the index of skills assigned to you (shared, project and your own runtime). Read-only. Load a skill\'s full text with get_skill.',
    scopeArgs,
    async (args, extra: { sessionId?: string }) => {
      const scope = await resolveScope(ctx, extra, args);
      if ('error' in scope) return err(scope.error);
      const [block, project, { manifest, pinned }] = await Promise.all([
        knowledgeBlockFor(ctx.dataSource, { accountId: scope.accountId, runtimeKey: scope.runtimeKey, projectId: scope.projectId }),
        projectMemoryFor(ctx.dataSource, scope.accountId, scope.projectId),
        manifestFor(ctx, scope),
      ]);
      return ok({
        account_id: scope.accountId,
        shared_memory: block.shared_memory,
        project: project ? { id: project.id, name: project.name, memory: project.instructions } : null,
        skills: manifest.map((entry) => ({
          slug: entry.slug,
          name: entry.name || entry.slug,
          description: entry.description || '',
          version: entry.version,
          scope: entry.scope ?? 'runtime',
        })),
        skills_pinned_for_ticket: pinned,
        next: manifest.length ? 'Call get_skill with a slug before using that skill.' : undefined,
      });
    },
  );

  server.tool(
    'get_skill',
    'Read one assigned skill\'s full text (and support files) by slug. Inside a ticket the version pinned for that run is served; otherwise the version currently assigned to you (runtime > project > shared). Read-only.',
    {
      slug: z.string().min(1).max(64).describe('Skill slug from get_knowledge or your work order.'),
      ...scopeArgs,
    },
    async (args, extra: { sessionId?: string }) => {
      const scope = await resolveScope(ctx, extra, args);
      if ('error' in scope) return err(scope.error);
      const { manifest, pinned } = await manifestFor(ctx, scope);
      const entry = manifest.find((m) => m.slug === args.slug);
      if (!entry) {
        return err(`Skill "${args.slug}" is not assigned to you here.`, {
          code: 'skill_not_assigned',
          available: manifest.map((m) => m.slug),
        });
      }
      return ok({
        slug: entry.slug,
        name: entry.name || entry.slug,
        description: entry.description || '',
        version: entry.version,
        scope: entry.scope ?? 'runtime',
        pinned_for_ticket: pinned,
        body: entry.body,
        support_files: entry.support_files || [],
      });
    },
  );
}
