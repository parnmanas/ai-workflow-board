/**
 * Review-drift MCP tool (ticket 59efbde9).
 *
 * Tools: check_review_drift
 *
 * Lets `review_workflow`'s reviewer branch replace its old manual
 * `gh api .../git/refs/heads/<default>` + `gh pr view --json mergeStateStatus`
 * base-freshness check with a server-computed, path-overlap-aware
 * classification — see `shared/review-drift.ts` for the classifier and
 * episode-state orchestrator this tool wraps.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { checkReviewDrift } from '../shared/review-drift';
import type { ToolContext } from './context';

export function registerReviewDriftTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, logger } = ctx;

  server.tool(
    'check_review_drift',
    'Classify origin/main drift since this Review episode began, by PATH OVERLAP with the ticket\'s own ' +
    'feature branch rather than raw commit count. Replaces a manual `gh api .../git/refs/heads/<default>` + ' +
    '`gh pr view --json mergeStateStatus` base-freshness check in review_workflow.\n\n' +
    'Returns {drifted, classification, recommendation, overlapping_paths, reverification_count, max_reverifications}. ' +
    'recommendation is one of:\n' +
    '  - "proceed" — no drift, or main only moved in paths unrelated to this branch. Continue the review.\n' +
    '  - "rebase_required" — main moved in a path this branch also touches (or a repo-global file like package.json), ' +
    'and this Review episode has not yet spent its one reverification bounce. Ask the assignee to rebase and bounce ' +
    'to In Progress.\n' +
    '  - "proceed_no_action" — either this episode already bounced once for overlapping drift (budget exhausted), or ' +
    'the check itself was unresolvable (no repo configured, git unavailable, feature/base branch not found). Either ' +
    'way, proceed rather than bounce again — Merging\'s own rebase-before-land step is the remaining re-verification ' +
    'point, not another Review round-trip.\n\n' +
    'Availability-first: any repo/branch/git resolution failure degrades to proceed_no_action — this tool never ' +
    'itself blocks a ticket a human would have to clear. Call once per reviewer turn in Review; state is tracked ' +
    'server-side per ticket and survives a Review→In Progress bounce (only the reverification counter persists — ' +
    'it is what prevents the same drift reason from bouncing the ticket twice).',
    {
      ticket_id: z.string().describe('Ticket ID (must be sitting in Review with a base repo + branch configured)'),
    },
    async ({ ticket_id }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      const result = await checkReviewDrift(dataSource, ticket, { logger });
      return ok(result);
    }
  );
}
