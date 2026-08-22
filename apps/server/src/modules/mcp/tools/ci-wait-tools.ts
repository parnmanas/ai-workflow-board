/**
 * CI-wait MCP tools (ticket 778b6dc7) — durable "await one external GitHub
 * Actions run" surface, so a long CI wait (typically the Merging workflow's
 * pre-landing `workflow_dispatch` check) does not depend on a live session
 * staying alive. A session blocked on sleep/poll/`ScheduleWakeup` for a
 * multi-minute CI matrix has repeatedly died mid-wait and left the ticket
 * needing manual recovery — this surface moves the wait into durable ticket
 * state instead.
 *
 * Tools:
 *   - await_ci_run   — register the wait (`pending_ci_wait=true` + an audit
 *                       context). Returns immediately; the caller should end
 *                       its turn right after. `CiWaitResumeService`'s sweep
 *                       polls the run server-side and re-dispatches this
 *                       ticket's current-column role holders once the run
 *                       resolves or the wait times out.
 *   - cancel_ci_wait — drop an active wait early (e.g. re-dispatching a
 *                       fresh run before the old one resolved).
 *
 * Distinct from `pend_ticket` (human-wait) and `add_ticket_prerequisites`
 * (blocked-by-another-ticket) — this is blocked-by-one-external-CI-run.
 *
 * Auto-registered by the `tools/index.ts` filename-convention loader.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { loadTicketFull } from '../shared/ticket-parsing';
import { getCallerAgent } from '../shared/session-auth';
import { CiWaitService } from '../../tickets/ci-wait.service';
import type { ToolContext } from './context';

export function registerCiWaitTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService } = ctx;
  // Reuse the DI singleton in the integrated server; construct a thin
  // instance in standalone mode (the service is stateless over
  // dataSource + activity) — same fallback shape as ticket-prerequisite-tools.ts.
  const svc = ctx.ciWaitService || new CiWaitService(dataSource as any, activityService);

  server.tool(
    'await_ci_run',
    'Register a durable wait on ONE external GitHub Actions run (typically the Merging workflow\'s pre-landing `workflow_dispatch` check). ' +
      'Sets `pending_ci_wait=true` with an audit trail (owner/repo/run_id/head_sha) and returns immediately. ' +
      'Do NOT poll, sleep, or call ScheduleWakeup after this — end your turn. `CiWaitResumeService` polls the run server-side and AUTO-RESUMES this ticket ' +
      '(re-dispatches its current-column role holders with a result comment already posted) the instant the run reaches a terminal conclusion, or after a bounded timeout (default 6h) if it never resolves. ' +
      'Any authenticated agent caller may register a wait on any non-archived ticket (same posture as add_ticket_prerequisites — no ticket-ownership check). ' +
      'Rejects if this ticket already has an active CI wait — call cancel_ci_wait first to replace it.',
    {
      ticket_id: z.string().describe('The ticket to park on this CI run'),
      owner: z.string().describe('GitHub repo owner (e.g. parsed from `git remote get-url origin`)'),
      repo: z.string().describe('GitHub repo name'),
      run_id: z.string().describe('The specific workflow run id to wait on. Resolve this by matching on head_sha first (e.g. `gh run list --json databaseId,headSha` filtered to your SHA) — never by picking the newest run on the branch, which can be a stale prior dispatch.'),
      head_sha: z.string().optional().describe('Commit SHA the run was dispatched against. Recorded for audit and cross-checked against the resolved run when the sweep completes.'),
      html_url: z.string().optional().describe('Run URL, if already known (saves a lookup when the wait resolves).'),
    },
    async ({ ticket_id, owner, repo, run_id, head_sha, html_url }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      try {
        await svc.registerWait(ticket_id, { owner, repo, run_id, head_sha, html_url }, {
          actorId: caller?.agentId,
          actorName: caller?.agentName,
        });
        const full = await loadTicketFull(dataSource, ticket_id);
        return ok({ registered: true, ticket: full });
      } catch (e: any) {
        return err(e?.message || 'Failed to register CI wait');
      }
    }
  );

  server.tool(
    'cancel_ci_wait',
    'Cancel an active CI wait registered by `await_ci_run` — clears `pending_ci_wait` immediately without waiting for the run to resolve. ' +
      'Use before registering a fresh wait (e.g. you pushed a fix and dispatched a new run) so the old wait\'s eventual resolution does not resume the ticket a second time. ' +
      'Idempotent — canceling when nothing is pending is a no-op (`cancelled: false`).',
    {
      ticket_id: z.string().describe('The ticket to unpark'),
    },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      try {
        const result = await svc.cancelWait(ticket_id, {
          actorId: caller?.agentId,
          actorName: caller?.agentName,
        });
        const full = await loadTicketFull(dataSource, ticket_id);
        return ok({ cancelled: result.cancelled, ticket: full });
      } catch (e: any) {
        return err(e?.message || 'Failed to cancel CI wait');
      }
    }
  );
}
