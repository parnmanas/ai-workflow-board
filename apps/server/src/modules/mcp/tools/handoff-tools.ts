/**
 * Cross-board handoff pipeline MCP tools (ticket ac21a745).
 *
 * The `handoff_spec` write surface lives on create_ticket / update_ticket
 * (ticket-crud-tools.ts) — a relay is DEFINED there. These tools cover the two
 * runtime verbs that aren't a plain field write:
 *
 *   - reject_handoff        — reverse rejection: a follow-up board found the
 *                             predecessor's deliverable defective; file a defect
 *                             ticket back on the source board and re-block the
 *                             follow-up on it (cross-board QA→fix generalization).
 *   - get_handoff_pipeline  — roll up the whole relay a ticket belongs to (every
 *                             stage, which board / column / status), for the
 *                             pipeline view.
 *
 * Both route through HandoffService (ctx.handoffService), present only in the
 * NestJS-integrated server — the standalone MCP entry point has no live activity
 * bus, so the tools degrade to an explicit error there (same posture as the
 * feature-tools). Auto-registered by the tools/index.ts filename-convention loader.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { loadTicketFull } from '../shared/ticket-parsing';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerHandoffTools(server: McpServer, ctx: ToolContext): void {
  const { handoffService, dataSource, logger } = ctx;

  server.tool(
    'reject_handoff',
    'Reverse rejection for a cross-board handoff relay (ticket ac21a745). Call this on a follow-up ticket ' +
      '(one AUTO-CREATED by a handoff — it carries `handoff_source_ticket_id`) when you determine the PREDECESSOR\'s ' +
      'deliverable (기획서/에셋 등 선행 산출물) is defective. It files a `[반려]` defect ticket back on the SOURCE ' +
      'ticket\'s board (assigned to whoever produced the deliverable) AND re-blocks this follow-up on that defect as a ' +
      'prerequisite — so the follow-up AUTO-RESUMES the instant the defect is fixed (lands on a terminal column). ' +
      'This is the cross-board generalization of the QA→fix loop. Errors if the ticket was not created by a handoff.',
    {
      followup_ticket_id: z.string().describe('The follow-up ticket rejecting its predecessor (must carry handoff_source_ticket_id)'),
      reason: z.string().describe('Why the predecessor deliverable is defective — embedded verbatim in the defect ticket body'),
      defect_title: z.string().optional().describe('Title for the defect ticket. Omit → "[반려] <source title>"'),
      defect_column_name: z.string().optional().describe('Column on the source board to file the defect into. Omit → first non-terminal column (auto-dispatches)'),
      defect_assignee_id: z.string().optional().describe('Agent to fix the defect. Omit → the source ticket\'s assignee (who produced the deliverable), then board defaults'),
    },
    async ({ followup_ticket_id, reason, defect_title, defect_column_name, defect_assignee_id }, extra: { sessionId?: string }) => {
      if (!handoffService) return err('reject_handoff is unavailable in standalone MCP mode (no live handoff engine)');
      const caller = getCallerAgent(extra);
      try {
        const result = await handoffService.rejectHandoff({
          followupTicketId: followup_ticket_id,
          reason,
          defectTitle: defect_title,
          defectColumnName: defect_column_name,
          defectAssigneeId: defect_assignee_id,
          actorId: caller?.agentId,
          actorName: caller?.agentName,
        });
        const followupFull = await loadTicketFull(dataSource, followup_ticket_id).catch(() => null);
        return ok({ ...result, followup: followupFull });
      } catch (e: any) {
        return err(e?.message || 'reject_handoff failed');
      }
    }
  );

  server.tool(
    'get_handoff_pipeline',
    'Roll up the entire cross-board handoff relay a ticket belongs to (ticket ac21a745). Given ANY ticket in a relay, ' +
      'walks up its lineage (handoff_source_ticket_id) to the root, then down through every follow-up, returning each ' +
      'stage in order: which board, which column, whether that column is terminal (= stage done), status, whether it is ' +
      'still blocked (pending_on_tickets), and how many handoff hops remain. Use this to see where a feature is across ' +
      'the 기획→그래픽→클라→QA relay without hopping boards manually.',
    {
      ticket_id: z.string().describe('Any ticket in the relay (root or any follow-up)'),
    },
    async ({ ticket_id }) => {
      if (!handoffService) return err('get_handoff_pipeline is unavailable in standalone MCP mode (no live handoff engine)');
      try {
        const pipeline = await handoffService.getPipeline(ticket_id);
        return ok(pipeline);
      } catch (e: any) {
        logger.warn('MCP', 'get_handoff_pipeline failed', { err: String(e), ticket_id });
        return err(e?.message || 'get_handoff_pipeline failed');
      }
    }
  );
}
