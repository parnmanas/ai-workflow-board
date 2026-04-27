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
import { ok, err } from '../shared/helpers';
import type { ToolContext } from './context';

export function registerAgentStatusTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, agentStatusService } = ctx;

  server.tool(
    'set_current_task',
    'Mark this agent as actively processing the given ticket. Call from the plugin ' +
    'when a ticket-session subagent is successfully spawned. Idempotent — repeating ' +
    'with the same ticket (and role) just refreshes the claimed_at timestamp.',
    {
      agent_id: z.string().describe('Calling agent ID'),
      ticket_id: z.string().describe('Ticket the agent is now working on'),
      role: z.string().optional().describe('Role slug the subagent was spawned for (assignee/reporter/reviewer or a workspace-custom slug). Surfaced on the dashboard so a multi-role agent shows which hat it is wearing right now.'),
    },
    async ({ agent_id, ticket_id, role }) => {
      if (!agentStatusService) {
        return err('set_current_task is unavailable in standalone MCP server mode — use the NestJS-integrated server.');
      }
      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      await agentStatusService.setCurrentTask(agent_id, ticket_id, role);
      return ok({ agent_id, ticket_id, role: role || null, set_at: new Date().toISOString() });
    }
  );

  server.tool(
    'clear_current_task',
    'Clear this agent\'s current_task. Call from the plugin when the ticket-session ' +
    'subagent exits (idle TTL, normal completion, crash). Pass ticket_id to assert ' +
    'intent — if a newer task already replaced current_task, the clear is skipped so ' +
    'we never wipe an in-flight task by mistake. Omit ticket_id to force-clear.',
    {
      agent_id: z.string().describe('Calling agent ID'),
      ticket_id: z.string().optional().describe('Expected current ticket_id; if mismatch, clear is skipped'),
    },
    async ({ agent_id, ticket_id }) => {
      if (!agentStatusService) {
        return err('clear_current_task is unavailable in standalone MCP server mode — use the NestJS-integrated server.');
      }
      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      agentStatusService.clearCurrentTask(agent_id, ticket_id);
      return ok({ agent_id, cleared_at: new Date().toISOString() });
    }
  );
}
