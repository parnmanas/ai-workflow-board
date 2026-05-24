/**
 * Self-improvement MCP tools.
 *
 * Currently a single tool: `create_remote_improvement_ticket`. Files a
 * follow-up improvement ticket against the REMOTE AWB instance configured by
 * the admin in SystemSetting (`self_improvement.remote_awb_*`). The remote
 * API key never reaches the subagent — it is read and decrypted server-side
 * here, then attached to the MCP transport headers on the outbound call.
 *
 * The companion local-board path uses the existing `create_ticket` tool — no
 * new tool needed for that case (the reviewer subagent calls create_ticket
 * with `labels: ['self-improvement']` and the board's Backlog column).
 *
 * Gating:
 *   - All four SystemSetting keys must be populated (URL, workspace_id,
 *     board_id, column_id) AND the API key must decrypt cleanly. Missing /
 *     blank keys → return an explicit error so the reviewer subagent knows
 *     the admin hasn't set up the remote target.
 *   - The board the reviewer is currently working on must have its
 *     `self_improvement_mode` set to `remote_awb` or `both` — enforced here
 *     using the ticket id the reviewer passes in for source attribution.
 *
 * Transport choice: outbound calls go over the remote AWB's `/mcp` endpoint
 * via the MCP SDK Client, NOT the REST tickets controller. The latter is
 * gated by user-session AuthGuard and would 401 a bearer API key. See
 * `../shared/remote-mcp-client.ts` for the helper.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SystemSetting } from '../../../entities/SystemSetting';
import { Ticket } from '../../../entities/Ticket';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Board } from '../../../entities/Board';
import { decrypt } from '../../../services/encryption.service';
import { ok, err } from '../shared/helpers';
import { callRemoteMcpTool } from '../shared/remote-mcp-client';
import type { ToolContext } from './context';

export function registerSelfImprovementTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, logger } = ctx;

  server.tool(
    'create_remote_improvement_ticket',
    `Create a follow-up improvement ticket on the REMOTE AWB instance configured by the admin.

Use this ONLY when you are running a self-improvement retrospective triggered by
\`trigger_source: 'ticket_done_review'\` AND the improvement is about AWB itself
(workflow, agent behavior, MCP tools) rather than the current project.

The admin has pre-configured the remote URL, workspace, board, column, and an API
key in System Settings — none of which are exposed to you here. You only supply
the ticket payload (title, description, priority, optional labels).

The source ticket id is used to:
  - validate that the source board has self_improvement_mode='remote_awb' or 'both'
  - attach a "Source:" link in the remote ticket description so the trail is
    reconstructable later`,
    {
      source_ticket_id: z.string().describe('The id of the just-completed local ticket that this improvement was derived from. Used for board policy check and Source attribution.'),
      title: z.string().describe('Improvement ticket title (short, outcome-shaped — see SELF_IMPROVEMENT_PROMPT guidance)'),
      description: z.string().describe('Improvement ticket description. A "Source:" link to the source ticket is appended automatically.'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('low').describe('Improvement priority on the remote board (default low — these are not blocking the team).'),
      labels: z.array(z.string()).optional().default([]).describe('Extra labels for the remote ticket. The `self-improvement` label is added automatically; do not re-add it.'),
    },
    async ({ source_ticket_id, title, description, priority, labels }) => {
      // 1. Resolve source ticket + board to verify the source board opts into
      //    remote filing. A reviewer running a retrospective on a board that
      //    only allows same_board improvements should NOT be able to bypass
      //    by calling this tool directly.
      const sourceTicket = await dataSource.getRepository(Ticket).findOne({ where: { id: source_ticket_id } });
      if (!sourceTicket) return err(`Source ticket not found: ${source_ticket_id}`);

      let sourceBoardId = '';
      let sourceMode = 'off';
      if (sourceTicket.column_id) {
        const col = await dataSource.getRepository(BoardColumn).findOne({ where: { id: sourceTicket.column_id } });
        if (col) {
          sourceBoardId = col.board_id;
          const board = await dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
          sourceMode = ((board as any)?.self_improvement_mode as string) || 'off';
        }
      }
      if (sourceMode !== 'remote_awb' && sourceMode !== 'both') {
        return err(
          `Source ticket's board does not permit remote improvement filing ` +
          `(self_improvement_mode='${sourceMode}'). Use create_ticket to file on the same board instead.`,
        );
      }

      // 2. Load + validate the remote target SystemSetting bundle.
      const settingRepo = dataSource.getRepository(SystemSetting);
      const settings = await settingRepo.find({
        where: [
          { key: 'self_improvement.remote_awb_url' },
          { key: 'self_improvement.remote_awb_workspace_id' },
          { key: 'self_improvement.remote_awb_board_id' },
          { key: 'self_improvement.remote_awb_column_id' },
          { key: 'self_improvement.remote_awb_api_key' },
        ],
      });
      const byKey = new Map(settings.map(s => [s.key, s.value]));
      const remoteUrl = (byKey.get('self_improvement.remote_awb_url') || '').trim().replace(/\/$/, '');
      const remoteWorkspaceId = (byKey.get('self_improvement.remote_awb_workspace_id') || '').trim();
      const remoteBoardId = (byKey.get('self_improvement.remote_awb_board_id') || '').trim();
      const remoteColumnId = (byKey.get('self_improvement.remote_awb_column_id') || '').trim();
      const rawKey = byKey.get('self_improvement.remote_awb_api_key') || '';

      if (!remoteUrl || !remoteWorkspaceId || !remoteBoardId || !remoteColumnId || !rawKey) {
        return err(
          'Remote AWB target is not fully configured. Ask the admin to populate ' +
          '`self_improvement.remote_awb_url`, `_workspace_id`, `_board_id`, `_column_id`, ' +
          'and `_api_key` in System Settings.',
        );
      }
      const apiKey = decrypt(rawKey);
      if (!apiKey) return err('Remote AWB API key failed to decrypt. Ask the admin to re-save the key.');

      // 3. Verify the configured destination BEFORE creating anything. The
      //    remote `create_ticket` tool takes only column_id — a stale or
      //    typo'd column id pointing at a DIFFERENT board (or a board in a
      //    different workspace) would otherwise silently file the
      //    improvement ticket in the wrong place while our local logs claim
      //    the configured target. Resolve the board, then assert
      //    workspace match + column membership; bail with a precise error if
      //    either fails so the admin can fix Settings.
      const boardCheck = await callRemoteMcpTool(remoteUrl, apiKey, 'get_board', { board_id: remoteBoardId });
      if (!boardCheck.ok) {
        logger.error('SelfImprovement', 'remote get_board (preflight) failed', {
          kind: boardCheck.kind, message: boardCheck.message,
          remote_url: remoteUrl, remote_board_id: remoteBoardId, source_ticket_id,
        });
        return err(`Remote AWB preflight failed (${boardCheck.kind}): ${boardCheck.message}`);
      }
      const remoteBoard: any = boardCheck.data || {};
      const actualWorkspaceId = String(remoteBoard?.workspace_id || '');
      if (actualWorkspaceId !== remoteWorkspaceId) {
        return err(
          `Remote target misconfigured: board "${remoteBoard?.name || remoteBoardId}" lives in ` +
          `workspace ${actualWorkspaceId || '(unknown)'}, but Settings configures ` +
          `workspace ${remoteWorkspaceId}. Refusing to file improvement ticket. ` +
          `Ask the admin to reconcile self_improvement.remote_awb_workspace_id and _board_id.`,
        );
      }
      const remoteColumns: any[] = Array.isArray(remoteBoard?.columns) ? remoteBoard.columns : [];
      const targetColumn = remoteColumns.find((c: any) => String(c?.id) === remoteColumnId);
      if (!targetColumn) {
        return err(
          `Remote target misconfigured: column ${remoteColumnId} is not a column of board ` +
          `"${remoteBoard?.name || remoteBoardId}". Refusing to file improvement ticket. ` +
          `Ask the admin to update self_improvement.remote_awb_column_id to a column that ` +
          `belongs to the configured board.`,
        );
      }

      // 4. Compose the outbound payload. The `self-improvement` label is
      //    enforced here regardless of what the caller passed so the remote
      //    side can apply its own recursion guard. Source link goes in the
      //    description so it survives even if labels are stripped.
      const dedupedLabels = Array.from(new Set([...(labels || []), 'self-improvement']));
      const sourceLink =
        `\n\n---\n_Source: ticket ${source_ticket_id} on board ${sourceBoardId} ` +
        `(self_improvement_mode=${sourceMode})_\n`;

      // 5. Fire the MCP `create_ticket` call against the remote.
      //    `created_by` is omitted — the remote will stamp the agent identity
      //    from the API key (via getCallerAgent + caller.agentName) so
      //    attribution reflects the WHO of the X-API-Key, not a hardcoded
      //    string. workspace_id is implicit in the API key's workspace scope.
      const result = await callRemoteMcpTool(remoteUrl, apiKey, 'create_ticket', {
        column_id: remoteColumnId,
        title,
        description: (description || '') + sourceLink,
        priority,
        labels: dedupedLabels,
      });

      if (!result.ok) {
        logger.error('SelfImprovement', 'remote create_ticket MCP call failed', {
          kind: result.kind, message: result.message,
          remote_url: remoteUrl, source_ticket_id,
        });
        return err(`Remote AWB rejected the request (${result.kind}): ${result.message}`);
      }

      const createdId = result.data?.id || '';
      logger.info('SelfImprovement', 'remote improvement ticket created', {
        source_ticket_id,
        remote_ticket_id: createdId,
        remote_workspace_id: remoteWorkspaceId,
        remote_board_id: remoteBoardId,
      });

      return ok({
        success: true,
        remote_ticket_id: createdId,
        remote_url: remoteUrl,
        remote_workspace_id: remoteWorkspaceId,
        remote_board_id: remoteBoardId,
        remote_column_id: remoteColumnId,
        source_ticket_id,
      });
    },
  );
}
