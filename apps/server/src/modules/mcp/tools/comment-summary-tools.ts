import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Comment } from '../../../entities/Comment';
import { CommentSummaryRun } from '../../../entities/CommentSummaryRun';
import { Ticket } from '../../../entities/Ticket';
import { getCallerAgent } from '../shared/session-auth';
import { ok, err } from '../shared/helpers';
import type { ToolContext } from './context';

export function registerCommentSummaryTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'complete_comment_summary',
    'Complete a pending ticket-comment summary. Success atomically replaces all existing comments with one summary; failure preserves every original comment.',
    {
      run_id: z.string().describe('Summary run ID from the dispatch prompt'),
      ticket_id: z.string().describe('Ticket ID from the dispatch prompt'),
      status: z.enum(['succeeded', 'failed']),
      summary: z.string().optional().describe('Required when status is succeeded'),
      error: z.string().optional().describe('Failure reason when status is failed'),
    },
    async ({ run_id, ticket_id, status, summary, error: failure }, extra) => {
      try {
        const caller = getCallerAgent(extra);
        if (!caller?.agentId) return err('Agent authentication required');
        const repo = ctx.dataSource.getRepository(CommentSummaryRun);
        const run = await repo.findOne({ where: { id: run_id, ticket_id } });
        if (!run) return err('Summary run not found');
        if (run.agent_id !== caller.agentId) return err('Only the dispatched agent can complete this summary');
        if (run.status !== 'pending') return ok({ idempotent: true, run });

        if (status === 'failed') {
          run.status = 'failed';
          run.error = failure || 'Agent could not summarize the comments';
          await repo.save(run);
          return ok(run);
        }
        const content = (summary || '').trim();
        if (!content) return err('summary is required when status is succeeded');

        const result = await ctx.dataSource.transaction(async manager => {
          const locked = await manager.getRepository(CommentSummaryRun).findOne({ where: { id: run_id, ticket_id } });
          if (!locked || locked.status !== 'pending') return { idempotent: true, run: locked };
          const ticket = await manager.getRepository(Ticket).findOne({ where: { id: ticket_id } });
          if (!ticket) throw new Error('Ticket not found');
          await manager.getRepository(Comment).delete({ ticket_id });
          const comment = await manager.getRepository(Comment).save(manager.getRepository(Comment).create({
            ticket_id,
            workspace_id: ticket.workspace_id,
            author_type: 'agent',
            author_id: caller.agentId,
            author: caller.agentName || 'Summary agent',
            content,
            attachment_resource_ids: '[]',
            type: 'note',
            status: null,
            parent_id: null,
            metadata: JSON.stringify({ comment_summary: true, summary_run_id: run_id }),
          }));
          locked.status = 'completed';
          locked.completed_at = new Date();
          locked.error = '';
          await manager.getRepository(CommentSummaryRun).save(locked);
          return { idempotent: false, run: locked, comment };
        });
        return ok(result);
      } catch (e: any) {
        return err(e?.message || 'Failed to complete comment summary');
      }
    },
  );
}
