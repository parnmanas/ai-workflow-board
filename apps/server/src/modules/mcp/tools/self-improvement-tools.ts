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
 * Gating (all must pass; failure modes are distinct error strings so the
 * reviewer subagent can self-diagnose):
 *   - Caller binding (LOAD-BEARING auth): the MCP session must carry an
 *     agent identity AND that agent must be the holder of the `reviewer`
 *     WorkspaceRole for the `source_ticket_id` argument's ticket, resolved
 *     via TicketRoleAssignment. This is a DB-backed check — never trust the
 *     client-supplied X-AWB-Subagent-* headers as the security boundary,
 *     since they are written by the agent-manager but not server-signed and
 *     any agent API-key holder that can open /mcp could spoof them.
 *   - Trigger-source context gate (defense-in-depth, NOT sole auth proof):
 *     the session's pinned subagentTriggerSource must be `ticket_done_review`
 *     so the tool is confined to the post-Done retrospective path that the
 *     trigger loop dispatches, not arbitrary reviewer wake-ups. Spoofable in
 *     principle but irrelevant once the DB check above has passed — kept as
 *     a documented contextual filter, not the security guarantee.
 *   - All four SystemSetting keys must be populated (URL, workspace_id,
 *     board_id, column_id) AND the API key must decrypt cleanly. Missing /
 *     blank keys → return an explicit error so the reviewer subagent knows
 *     the admin hasn't set up the remote target.
 *   - The board the source ticket lives on must have its
 *     `self_improvement_mode` set to `remote_awb` or `both` — second gate
 *     after the caller-binding check above.
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
import { WorkspaceRole } from '../../../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../../../entities/TicketRoleAssignment';
import { decrypt } from '../../../services/encryption.service';
import { ok, err } from '../shared/helpers';
import { callRemoteMcpTool } from '../shared/remote-mcp-client';
import { getCallerAgent } from '../shared/session-auth';
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
    async ({ source_ticket_id, title, description, priority, labels }, extra: { sessionId?: string }) => {
      // 1. Authorize the caller. This tool decrypts a server-side API key and
      //    issues a writable remote MCP call, so it must be tightly scoped to
      //    the post-Done retrospective context the trigger loop dispatches.
      //
      //    SECURITY: the load-bearing check is a DB lookup — does the caller's
      //    agent_id match the holder of the `reviewer` WorkspaceRole on the
      //    source ticket (via TicketRoleAssignment)? The client-supplied
      //    X-AWB-Subagent-* headers (subagentRole / subagentTicketId) are
      //    written by the agent-manager when it spawns a reviewer subagent
      //    but they are NOT server-signed: any agent API-key holder that can
      //    open /mcp could set them freely. So we DO NOT trust them as the
      //    authorization boundary.
      //
      //    We require:
      //      - a known caller (rejects unauthenticated / dev-mode sessions
      //        that have no agent identity);
      //      - the source ticket exists, has a workspace, and that workspace
      //        has a `reviewer` WorkspaceRole row;
      //      - a TicketRoleAssignment binds the reviewer role on this ticket
      //        to an agent (i.e., the ticket has an assigned reviewer at all);
      //      - that assignment.agent_id === caller.agentId.
      //
      //    The subagentTriggerSource pin is kept as a defense-in-depth context
      //    gate only — see the comment below it.
      const caller = getCallerAgent(extra);
      if (!caller || !caller.agentId) {
        return err(
          'Unauthorized: create_remote_improvement_ticket requires an authenticated reviewer ' +
          'subagent session with a bound agent identity.',
        );
      }

      // Resolve source ticket up front so the DB-backed reviewer check can use it.
      const sourceTicket = await dataSource.getRepository(Ticket).findOne({ where: { id: source_ticket_id } });
      if (!sourceTicket) return err(`Source ticket not found: ${source_ticket_id}`);
      if (!sourceTicket.workspace_id) {
        return err(`Source ticket ${source_ticket_id} has no workspace; cannot resolve reviewer role.`);
      }

      const reviewerRole = await dataSource.getRepository(WorkspaceRole).findOne({
        where: { workspace_id: sourceTicket.workspace_id, slug: 'reviewer' },
      });
      if (!reviewerRole) {
        return err(
          `Source ticket's workspace has no 'reviewer' WorkspaceRole defined. ` +
          'create_remote_improvement_ticket can only be invoked from the reviewer role.',
        );
      }
      const reviewerAssignment = await dataSource.getRepository(TicketRoleAssignment).findOne({
        where: { ticket_id: source_ticket_id, role_id: reviewerRole.id },
      });
      if (!reviewerAssignment || !reviewerAssignment.agent_id) {
        return err(
          `Forbidden: source ticket ${source_ticket_id} has no assigned reviewer agent. ` +
          'Only the ticket\'s assigned reviewer may file remote improvement tickets derived from it.',
        );
      }
      if (reviewerAssignment.agent_id !== caller.agentId) {
        return err(
          'Forbidden: caller is not the assigned reviewer of the source ticket. ' +
          'Only the agent holding the reviewer role on this ticket may file remote improvement ' +
          'tickets derived from it.',
        );
      }

      // 2. Context gate (defense-in-depth, NOT sole auth proof): the session
      //    must have been opened by the post-Done retrospective path. The
      //    `X-AWB-Subagent-Trigger-Source` header is client-supplied and so
      //    cannot be the security boundary — the DB-backed check above is —
      //    but rejecting calls whose session was opened for a different
      //    context (a normal reviewer trigger, a chat session, the top-level
      //    proxy, ...) limits blast radius even if a legitimate reviewer's
      //    credentials are misused outside the retrospective path.
      if (caller.subagentTriggerSource !== 'ticket_done_review') {
        return err(
          'Forbidden: create_remote_improvement_ticket may only be called from the ' +
          `post-Done ticket_done_review retrospective. This session is pinned to ` +
          `trigger_source='${caller.subagentTriggerSource || '(none)'}'.`,
        );
      }

      // 3. Resolve source ticket's board to verify the source board opts into
      //    remote filing. A reviewer running a retrospective on a board that
      //    only allows same_board improvements should NOT be able to bypass
      //    by calling this tool directly.
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

      // 4. Load + validate the remote target SystemSetting bundle.
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

      // 5. Verify the configured destination BEFORE creating anything. The
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

      // 6. Compose the outbound payload. The `self-improvement` label is
      //    enforced here regardless of what the caller passed so the remote
      //    side can apply its own recursion guard. Source link goes in the
      //    description so it survives even if labels are stripped.
      const dedupedLabels = Array.from(new Set([...(labels || []), 'self-improvement']));
      const sourceLink =
        `\n\n---\n_Source: ticket ${source_ticket_id} on board ${sourceBoardId} ` +
        `(self_improvement_mode=${sourceMode})_\n`;

      // 7. Fire the MCP `create_ticket` call against the remote.
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
