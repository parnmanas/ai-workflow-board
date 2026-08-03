import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { Skill } from '../../../entities/Skill';
import { SkillProposal } from '../../../entities/SkillProposal';
import { canonicalizeSkillContent } from '../../skills/skill-validation';
import { err, ok } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';
import { normalizeAgentWorkspaceId } from '../../../common/agent-workspace-scope';

export function registerSkillProposalTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'propose_skill_change',
    'Create a pending, human-reviewed AWB skill proposal. This never publishes, assigns, approves, or mutates a skill version.',
    {
      skill_id: z.string().optional().describe('Existing target skill id. Omit only when proposing a brand-new catalog entry.'),
      title: z.string().min(1).max(200),
      body: z.string().min(1),
      support_files: z.array(z.object({
        path: z.string(),
        content: z.string(),
      })).optional().default([]),
    },
    async ({ skill_id, title, body, support_files }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      if (
        !caller?.agentId
        || caller.clientType !== 'runtime-child'
        || !caller.runtimeRunId
      ) {
        return err(
          'propose_skill_change requires an authenticated Runtime Host child session with a bound run id.',
        );
      }
      const agent = await ctx.dataSource.getRepository(Agent).findOne({
        where: { id: caller.agentId },
      });
      if (!agent) return err('The runtime Agent identity was not found.');
      const workspaceId = caller.workspaceId || normalizeAgentWorkspaceId(agent.workspace_id);
      if (!workspaceId) return err('The runtime API key is not scoped to a workspace.');
      if (skill_id) {
        const target = await ctx.dataSource.getRepository(Skill).findOne({
          where: { id: skill_id, workspace_id: workspaceId },
        });
        if (!target) return err('Target skill does not exist in the runtime Agent workspace.');
      }
      try {
        const canonical = canonicalizeSkillContent(body, support_files);
        const repo = ctx.dataSource.getRepository(SkillProposal);
        const proposal = await repo.save(repo.create({
          workspace_id: workspaceId,
          skill_id: skill_id || '',
          title: title.trim().slice(0, 200),
          body: canonical.body,
          support_files: canonical.supportFiles,
          digest: canonical.digest,
          status: 'pending',
          source_agent_id: caller.agentId,
          source_run_id: caller.runtimeRunId,
        }));
        return ok({
          id: proposal.id,
          status: proposal.status,
          digest: proposal.digest,
          message: 'Proposal recorded. A human must review it before any version is published.',
        });
      } catch (error: any) {
        return err(error?.message || String(error), {
          code: error?.code || 'skill_proposal_invalid',
        });
      }
    },
  );
}
