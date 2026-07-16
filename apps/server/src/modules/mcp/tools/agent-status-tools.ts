/**
 * Agent runtime status tools.
 *
 * Tools:
 *   - set_current_task:   plugin signal — "I just spawned a subagent for this ticket"
 *   - clear_current_task: plugin signal — "the subagent for this ticket has exited"
 *
 * These are the authoritative inputs to AgentStatusService.current_task.
 * Trigger emit no longer auto-marks an agent as "processing" — only the
 * actual subagent spawn/exit lifecycle does, so the dashboard reflects
 * what's executing rather than what was queued.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { TicketArchivedError } from '../shared/archive-helpers';
import type { ToolContext } from './context';

export function registerAgentStatusTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, agentStatusService } = ctx;

  server.tool(
    'set_current_task',
    'Mark this agent as actively processing the given ticket. Call from the plugin ' +
    'when a ticket-session subagent is successfully spawned. Idempotent — repeating ' +
    'with the same ticket (and role) just refreshes the claimed_at timestamp. Pass a ' +
    'per-session task_token so the matching clear_current_task can prove it owns this ' +
    'generation of the seat (compare-and-swap release — see clear_current_task).',
    {
      agent_id: z.string().describe('Calling agent ID'),
      ticket_id: z.string().describe('Ticket the agent is now working on'),
      role: z.string().optional().describe('Role slug the subagent was spawned for (assignee/reporter/reviewer or a workspace-custom slug). Surfaced on the dashboard so a multi-role agent shows which hat it is wearing right now.'),
      task_token: z.string().optional().describe('Per-session generation nonce (ticket 1fcba693). Stamped on the active task so a later clear_current_task carrying the SAME token is the only one that releases this seat + its output-liveness badge. A respawn that re-sets the same (agent,ticket,role) seat overwrites the token, so a stale earlier session can never clear a live successor.'),
    },
    async ({ agent_id, ticket_id, role, task_token }) => {
      if (!agentStatusService) {
        return err('set_current_task is unavailable in standalone MCP server mode — use the NestJS-integrated server.');
      }
      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      // Refuse to bind an agent to an archived ticket — the trigger loop
      // wouldn't dispatch any work for it and the dashboard would render a
      // stuck "current_task" with no follow-up.
      const ticketForArchive = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (ticketForArchive?.archived_at) return err(new TicketArchivedError(ticketForArchive.id).message);

      await agentStatusService.setCurrentTask(agent_id, ticket_id, role, task_token);
      return ok({ agent_id, ticket_id, role: role || null, task_token: task_token || null, set_at: new Date().toISOString() });
    }
  );

  server.tool(
    'clear_current_task',
    'Clear this agent\'s current_task. Call from the plugin when the ticket-session ' +
    'subagent exits (idle TTL, normal completion, crash). Pass ticket_id to assert ' +
    'intent — if a newer task already replaced current_task, the clear is skipped so ' +
    'we never wipe an in-flight task by mistake. Omit ticket_id to force-clear. Pass the ' +
    'same task_token you set on set_current_task to make the release generation-safe: the ' +
    'output-liveness badge is dropped ONLY when the token matches the seat\'s current ' +
    'generation, so a respawn (session B) is never flagged absent by session A\'s late clear.',
    {
      agent_id: z.string().describe('Calling agent ID'),
      ticket_id: z.string().optional().describe('Expected current ticket_id; if mismatch, clear is skipped'),
      task_token: z.string().optional().describe('Per-session generation nonce from set_current_task (ticket 1fcba693). When present, the clear is a compare-and-swap: a different stored token means a newer session owns the seat → the clear is skipped entirely. When absent, only the current_task entry is dropped (legacy) and the badge is left for the supervisor TTL to reclaim.'),
    },
    async ({ agent_id, ticket_id, task_token }) => {
      if (!agentStatusService) {
        return err('clear_current_task is unavailable in standalone MCP server mode — use the NestJS-integrated server.');
      }
      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      agentStatusService.clearCurrentTask(agent_id, ticket_id, task_token);
      return ok({ agent_id, cleared_at: new Date().toISOString() });
    }
  );
}
