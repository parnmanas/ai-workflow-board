/**
 * Ticket CRUD MCP tools.
 *
 * Tools: get_ticket, create_ticket, update_ticket, delete_ticket, get_my_tickets
 *
 * Split out of the legacy monolithic `ticket-tools.ts` (565 lines · 11 tools).
 * Siblings: ticket-child-tools.ts (hierarchy), ticket-workflow-tools.ts
 * (state transitions). The auto-discovery loader in `tools/index.ts` picks
 * each sibling up by filename convention — no index edit needed.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Resource } from '../../../entities/Resource';
import { Ticket } from '../../../entities/Ticket';
import { WorkspaceRole } from '../../../entities/WorkspaceRole';
import { ok, err, safeJsonParse, sanitizeHarnessMarkers } from '../shared/helpers';
import { loadTicketFull } from '../shared/ticket-parsing';
import {
  findColumnByName,
  maxTicketPosition,
  refreshTicketWorkspaceId,
  resolveAgentId,
  resolveAgentIdAndName,
  shiftTicketPositions,
  deleteCommentAttachmentsForTicket,
  validateNextTicketId,
} from '../shared/ticket-helpers';
import { getCallerAgent } from '../shared/session-auth';
import { isTerminalColumn, TicketArchivedError } from '../shared/archive-helpers';
import type { ToolContext } from './context';

/**
 * Schema for the per-ticket `role_assignments[]` payload accepted by
 * create/update tools. Each entry pins a workspace-scoped role (by slug —
 * planner, assignee, reviewer, or any custom role the workspace defines)
 * onto the ticket. Pass `agent_id`/`user_id` to set, both empty/null to
 * clear the slot. Mutually exclusive — the helper rejects rows that supply
 * both. Unknown slug returns an explicit error so silent typos don't hide.
 */
const RoleAssignmentInputSchema = z.object({
  role_slug: z.string().describe('Workspace role slug (e.g. "assignee", "reporter", "reviewer", "planner", or any custom slug)'),
  agent_id: z.string().optional().describe('Agent ID holding the role (mutually exclusive with user_id)'),
  user_id: z.string().optional().describe('User ID holding the role (mutually exclusive with agent_id)'),
});

/**
 * Apply a `role_assignments[]` array onto a ticket. Resolves each slug
 * against the ticket's workspace WorkspaceRole row and writes the holder
 * via TicketRoleAssignmentService. Empty `role_slug` is silently skipped;
 * unknown slug throws so callers can fix typos. Mutual exclusion of
 * agent_id / user_id is enforced by `setHolder`.
 *
 * Returns the list of (slug, role_id, holder) entries actually applied so
 * the caller can include them in activity logs / debug output.
 */
async function applyRoleAssignments(
  ctx: ToolContext,
  ticketId: string,
  workspaceId: string,
  assignments: Array<z.infer<typeof RoleAssignmentInputSchema>> | undefined,
): Promise<Array<{ slug: string; role_id: string; agent_id: string | null; user_id: string | null }>> {
  if (!assignments || assignments.length === 0) return [];
  if (!ctx.ticketRoleAssignmentService) {
    throw new Error('role_assignments require the integrated server (TicketRoleAssignmentService not wired)');
  }
  if (!workspaceId) {
    throw new Error('Cannot apply role_assignments — ticket has no workspace_id (column → board lookup failed)');
  }
  const applied: Array<{ slug: string; role_id: string; agent_id: string | null; user_id: string | null }> = [];
  const roleRepo = ctx.dataSource.getRepository(WorkspaceRole);
  for (const a of assignments) {
    const slug = (a.role_slug || '').trim();
    if (!slug) continue;
    const role = await roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
    if (!role) {
      throw new Error(`Unknown role slug "${slug}" in workspace ${workspaceId}`);
    }
    const agent_id = a.agent_id || null;
    const user_id = a.user_id || null;
    await ctx.ticketRoleAssignmentService.setHolder(ticketId, role.id, { agent_id, user_id });
    applied.push({ slug, role_id: role.id, agent_id, user_id });
  }
  return applied;
}

export function registerTicketCrudTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService, logger, ticketRoleAssignmentService, triggerLoopService, ticketPrerequisitesService } = ctx;

  server.tool(
    'get_ticket',
    'Get a single ticket with its children and comments',
    { ticket_id: z.string().describe('Ticket ID') },
    async ({ ticket_id }) => {
      const ticket = await loadTicketFull(dataSource, ticket_id);
      if (!ticket) return err('Ticket not found');
      return ok(ticket);
    }
  );

  server.tool(
    'create_ticket',
    'Create a new ticket. You can specify either column_id (numeric) or column_name + board_id to find the column by name.\n\n' +
    'Role assignment: prefer the generalized `role_assignments` array (`[{role_slug, agent_id?, user_id?}]`) — it can pin any workspace role including `planner` and custom roles. The legacy `assignee_id` / `reporter_id` / `reviewer_id` fields still work and continue to populate the matching builtin slugs. Name fields (`assignee`, `reporter`) are deprecated; ID-based identification is required because workspaces commonly host multiple agents with the same display name.',
    {
      title: z.string().describe('Ticket title'),
      description: z.string().optional().default('').describe('Ticket description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium').describe('Priority level'),
      assignee: z.string().optional().default('').describe('DEPRECATED — pass assignee_id instead. Name lookup throws when 2+ agents share the name (manager + subagent collision is common).'),
      reporter: z.string().optional().default('').describe('DEPRECATED — pass reporter_id instead. Same multi-match risk as `assignee`.'),
      assignee_id: z.string().optional().default('').describe('Assignee agent ID (preferred over `assignee` name)'),
      reporter_id: z.string().optional().default('').describe('Reporter agent ID (preferred over `reporter` name)'),
      reviewer_id: z.string().optional().default('').describe('Reviewer agent ID'),
      role_assignments: z.array(RoleAssignmentInputSchema).optional().describe('Per-role assignments (slug → agent/user). Use this to set planner or any workspace custom role. Builtin slugs (assignee/reporter/reviewer) here override the legacy fields above when both are supplied for the same slug.'),
      labels: z.array(z.string()).optional().default([]).describe('Labels'),
      channel_ids: z.array(z.string()).optional().default([]).describe('Notification channel IDs'),
      column_id: z.string().optional().describe('Column ID (use this OR column_name)'),
      column_name: z.string().optional().describe('Column name (case-insensitive, requires board_id)'),
      board_id: z.string().optional().describe('Board ID (used with column_name)'),
      subtasks: z.array(z.string()).optional().default([]).describe('List of subtask titles to create inline'),
      next_ticket_id: z.string().optional().describe('Optional pointer to the ticket TriggerLoopService should auto-trigger once this one lands on a terminal column. Must live in the same workspace; cleared when omitted or empty.'),
      effort_preset: z.string().optional().describe('Abstract effort preset id (NOT a CLI flag) referencing one of the board\'s effort_presets[].id. Empty/omitted = board default preset. Resolved against the board catalog at dispatch; agent-manager maps the matched preset onto per-CLI options.'),
      created_by: z.string().optional().default('').describe('Creator name (user or agent)'),
      created_by_type: z.enum(['user', 'agent']).optional().default('agent').describe('Creator type'),
      created_by_id: z.string().optional().default('').describe('Creator ID'),
    },
    async ({ title, description, priority, assignee, reporter, assignee_id, reporter_id, reviewer_id, role_assignments, labels, channel_ids, column_id, column_name, board_id, subtasks, next_ticket_id, effort_preset, created_by, created_by_type, created_by_id }, extra: { sessionId?: string }) => {
      const __createSanitizeCaller = getCallerAgent(extra);
      description = sanitizeHarnessMarkers(description, { logger, toolName: 'create_ticket', fieldName: 'description', agentId: __createSanitizeCaller?.agentId });
      let resolvedColumnId = column_id;
      if (!resolvedColumnId && column_name) {
        if (!board_id) return err('board_id is required when using column_name');
        const col = await findColumnByName(dataSource, board_id, column_name);
        if (!col) return err(`Column "${column_name}" not found in board ${board_id}`);
        resolvedColumnId = col.id;
      }
      if (!resolvedColumnId) return err('Either column_id or column_name is required');

      const col = await dataSource.getRepository(BoardColumn).findOne({ where: { id: resolvedColumnId } });
      if (!col) return err('Column not found');

      // Resolve the destination column's workspace upfront — needed by the
      // next_ticket_id workspace-guard which has to run before save (the
      // freshly-created Ticket row's workspace_id is set by
      // refreshTicketWorkspaceId AFTER save).
      let prospectiveWorkspaceId = '';
      try {
        const board = await dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
        prospectiveWorkspaceId = board?.workspace_id || '';
      } catch { /* validateNextTicketId will skip the workspace guard if empty */ }

      let resolvedNextTicketId: string | null = null;
      if (next_ticket_id !== undefined) {
        try {
          // currentTicketId=null on create — see validateNextTicketId notes.
          resolvedNextTicketId = await validateNextTicketId(dataSource, next_ticket_id, null, prospectiveWorkspaceId);
        } catch (e: any) {
          return err(e?.message || 'next_ticket_id rejected');
        }
      }

      // Auto-fill creator from authenticated agent if not provided
      const caller = getCallerAgent(extra);
      const creatorName = created_by || (caller?.agentName) || reporter || assignee || '';
      const creatorType = created_by ? created_by_type : (caller?.agentId ? 'agent' : (reporter ? 'agent' : ''));
      const creatorId = created_by_id || (caller?.agentId) || (reporter ? await resolveAgentId(dataSource, '', reporter, logger) : '');

      const ticket = await dataSource.transaction(async (manager) => {
        const tRepo = manager.getRepository(Ticket);

        // Backfill name↔id from the Agent table whichever side the caller
        // omitted, and re-format the name as `Manager/Agent` so TicketCard,
        // activity log, and system comments all show the same string. The
        // helper logs a deprecation warn on name-only lookup and throws on
        // multi-match — see `resolveAgentIdAndName` (B3 in role-assignment fix).
        const assigneeResolved = await resolveAgentIdAndName(dataSource, assignee_id, assignee, logger);
        const reporterResolved = await resolveAgentIdAndName(dataSource, reporter_id, reporter, logger);
        let resolvedAssigneeId = assigneeResolved.id;
        let resolvedAssignee = assigneeResolved.name;
        let resolvedReporterId = reporterResolved.id;
        let resolvedReporter = reporterResolved.name;
        // Default Reporter to the ticket's creator when none was supplied —
        // mirrors the REST controller so an agent that calls create_ticket
        // ends up listed as Reporter automatically.
        if (!resolvedReporter && !resolvedReporterId && creatorId) {
          resolvedReporter = creatorName;
          resolvedReporterId = creatorId;
        }
        const position = await maxTicketPosition(dataSource, resolvedColumnId!);
        // Stamp terminal_entered_at when the destination column is already
        // terminal (e.g. an agent files a ticket directly into Done). Without
        // this stamp the archiver's `terminal_entered_at IS NOT NULL` guard
        // would silently skip the row forever. `col` is the already-loaded
        // destination column from line 141.
        const terminalEnteredAt = isTerminalColumn(col) ? new Date() : null;
        const t = await tRepo.save(tRepo.create({
          column_id: resolvedColumnId!, title, description, priority,
          assignee: resolvedAssignee, reporter: resolvedReporter,
          assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId, reviewer_id,
          labels: JSON.stringify(labels), channel_ids: JSON.stringify(channel_ids), position,
          next_ticket_id: resolvedNextTicketId,
          // Abstract effort preset id (trim → empty becomes null). Resolved
          // against the board catalog at dispatch; null = board default.
          effort_preset: typeof effort_preset === 'string' && effort_preset.trim() ? effort_preset.trim() : null,
          terminal_entered_at: terminalEnteredAt,
          created_by: creatorName, created_by_type: creatorType, created_by_id: creatorId,
        }));

        if (subtasks.length > 0) {
          const stEntities = subtasks.map((stTitle, idx) =>
            tRepo.create({
              parent_id: t.id, depth: 1, column_id: null as any, title: stTitle, position: idx, status: 'todo',
              created_by: creatorName, created_by_type: creatorType, created_by_id: creatorId,
            })
          );
          await tRepo.save(stEntities);
        }

        return t;
      });

      // B1: backfill workspace_id from column → board so the v0.34
      // assignment-table sync below actually fires. The Ticket row's
      // `workspace_id` defaults to '' and the MCP create path doesn't pass
      // it; without this step the next guard (`ticket.workspace_id`) is
      // falsy, the sync silently skips, and the trigger loop / mention
      // resolution never see the new ticket. Mirrors REST controller's
      // pre-existing `_refreshWorkspaceId` step.
      await refreshTicketWorkspaceId(dataSource, ticket);

      // v0.34: mirror builtin trio onto TicketRoleAssignment so the trigger
      // loop / mention resolution / allocation see the new ticket.
      if (ticketRoleAssignmentService && ticket.workspace_id) {
        await ticketRoleAssignmentService.syncBuiltinTrio(ticket.id, ticket.workspace_id, {
          assignee_id: ticket.assignee_id || '',
          reporter_id: ticket.reporter_id || '',
          reviewer_id: ticket.reviewer_id || '',
        });
      }

      // B2: apply generalized `role_assignments[]` (planner / arbitrary
      // workspace custom roles). Runs AFTER syncBuiltinTrio so a payload
      // that supplies both `assignee_id` (legacy) and a `role_assignments`
      // entry for slug=`assignee` lands on the role-assignment value as the
      // final write — explicit slug wins over the legacy mirror.
      await applyRoleAssignments(ctx, ticket.id, ticket.workspace_id, role_assignments);

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'created',
        ticket_id: ticket.id, actor_name: creatorName || reporter || assignee,
      });

      const full = await loadTicketFull(dataSource, ticket.id);
      return ok(full);
    }
  );

  server.tool(
    'update_ticket',
    'Update a root ticket\'s fields (title, description, priority, assignee, reporter, reviewer_id, labels, channel_ids, base_repo_resource_id, base_branch, next_ticket_id, role_assignments).\n\n' +
    'NOTE: this tool does NOT change `status` and is intended for ROOT tickets. ' +
    'Status on a root ticket is driven by which column it sits in — use move_ticket to advance it. ' +
    'For SUBTASKS (depth > 0), use update_child_ticket — that\'s also where you mark a finished subtask ' +
    'with status="done".\n\n' +
    'Role assignment: prefer `role_assignments` (`[{role_slug, agent_id?, user_id?}]`) — handles `planner` and any workspace custom role. Legacy `assignee_id` / `reporter_id` / `reviewer_id` still apply for those three slugs. Pass `agent_id: ""` (empty string) inside `role_assignments` to clear a slot.\n\n' +
    'Base repo & branch: pass `base_repo_resource_id` (a workspace/board Resource of type="repository") together with ' +
    '`base_branch` to pin the branch the ticket\'s feature branch should be cut from. Empty strings clear the binding.',
    {
      ticket_id: z.string().describe('Ticket ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('New priority'),
      assignee: z.string().optional().describe('DEPRECATED — pass assignee_id instead.'),
      reporter: z.string().optional().describe('DEPRECATED — pass reporter_id instead.'),
      assignee_id: z.string().optional().describe('New assignee agent ID'),
      reporter_id: z.string().optional().describe('New reporter agent ID'),
      reviewer_id: z.string().optional().describe('Reviewer agent ID'),
      role_assignments: z.array(RoleAssignmentInputSchema).optional().describe('Per-role assignments (slug → agent/user). Use to set planner or any workspace custom role. Builtin slugs (assignee/reporter/reviewer) here override the legacy fields above when both are supplied.'),
      labels: z.array(z.string()).optional().describe('New labels array'),
      channel_ids: z.array(z.string()).optional().describe('New notification channel IDs'),
      base_repo_resource_id: z.string().optional().describe('Resource ID (type=repository) the ticket builds against. Empty string clears.'),
      base_branch: z.string().optional().describe('Branch the agent should treat as the base when starting work. Empty string clears.'),
      next_ticket_id: z.string().optional().describe('Optional pointer to the ticket TriggerLoopService should auto-trigger once this one lands on a terminal column. Must live in the same workspace and cannot self-link. Empty string clears.'),
      on_done_action_ids: z.array(z.string()).optional().describe('Action ids to dispatch once when this ticket lands on a terminal column (on-ticket-done hook, method "a"). The finished ticket is exposed to each Action prompt as {{ticket.*}}. enabled=false actions are skipped. Empty array clears the per-ticket binding.'),
      effort_preset: z.string().optional().describe('Abstract effort preset id (NOT a CLI flag) referencing one of the board\'s effort_presets[].id. Empty string clears (board default preset applies). Resolved against the board catalog at dispatch; agent-manager maps the matched preset onto per-CLI options.'),
      pending_user_action: z.boolean().optional().describe('Park the ticket for user intervention. While true, TriggerLoopService drops every agent_trigger for this ticket, AgentWorkloadService.getFocusTicket skips it, and BacklogPromotionService refuses to promote into its column slot. Pair with `pending_reason` so the user can see why. Use this when a decision genuinely needs a human and would otherwise loop the ticket between System and Agent columns. Prefer the dedicated `pend_ticket` / `unpend_ticket` tools when the call is single-purpose.'),
      pending_reason: z.string().optional().describe('Free-text explanation rendered verbatim on the ticket detail panel\'s "User" tab. Cleared automatically when pending_user_action transitions to false.'),
    },
    async ({ ticket_id, title, description, priority, assignee, reporter, assignee_id, reporter_id, reviewer_id, role_assignments, labels, channel_ids, base_repo_resource_id, base_branch, next_ticket_id, on_done_action_ids, effort_preset, pending_user_action, pending_reason }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);

      const caller = getCallerAgent(extra);

      // Track old values before updating
      const oldAssignee = ticket.assignee;
      const oldReporter = ticket.reporter;
      const oldBaseRepoId = ticket.base_repo_resource_id;
      const oldBaseBranch = ticket.base_branch;
      const oldNextTicketId = ticket.next_ticket_id;

      const changes: string[] = [];
      if (title !== undefined) { ticket.title = title; changes.push('title'); }
      if (description !== undefined) {
        ticket.description = sanitizeHarnessMarkers(description, { logger, toolName: 'update_ticket', fieldName: 'description', agentId: caller?.agentId });
        changes.push('description');
      }
      if (priority !== undefined) { ticket.priority = priority; changes.push('priority'); }
      // When the caller updates either side of the (id, name) pair, backfill
      // the other from the Agent table. Without this, an agent that calls
      // update_ticket with only `assignee_id` clears nothing but also leaves
      // the legacy `assignee` text column at its previous (stale) value, and
      // a caller that only swaps `assignee` keeps the old `assignee_id`
      // pointing at the previous holder.
      //
      // Pass empty strings for the omitted side so `resolveAgentIdAndName`
      // actually does a DB lookup — pre-filling from `ticket.assignee` /
      // `ticket.assignee_id` makes both helper args truthy and the helper's
      // `if (id && name) return { id, name }` short-circuit fires, which
      // skips the lookup and silently re-saves the previous holder's name.
      // The existing row only kicks in as a last-resort fallback when the
      // lookup misses (id points at a User row or stale agent).
      if (assignee !== undefined || assignee_id !== undefined) {
        const resolved = await resolveAgentIdAndName(
          dataSource,
          assignee_id !== undefined ? assignee_id : '',
          assignee !== undefined ? assignee : '',
          logger,
        );
        ticket.assignee_id = assignee_id !== undefined ? assignee_id : (resolved.id || ticket.assignee_id);
        // Canonical Manager/Agent display wins over any bare leaf name the
        // caller might pass alongside the id — keeps TicketCard consistent
        // with the role_assignments view.
        if (resolved.id) {
          ticket.assignee = resolved.name;
        } else if (assignee !== undefined) {
          ticket.assignee = assignee;
        }
        if (ticket.assignee !== oldAssignee) changes.push('assignee');
      }
      if (reporter !== undefined || reporter_id !== undefined) {
        const resolved = await resolveAgentIdAndName(
          dataSource,
          reporter_id !== undefined ? reporter_id : '',
          reporter !== undefined ? reporter : '',
          logger,
        );
        ticket.reporter_id = reporter_id !== undefined ? reporter_id : (resolved.id || ticket.reporter_id);
        if (resolved.id) {
          ticket.reporter = resolved.name;
        } else if (reporter !== undefined) {
          ticket.reporter = reporter;
        }
        if (ticket.reporter !== oldReporter) changes.push('reporter');
      }
      if (reviewer_id !== undefined) { ticket.reviewer_id = reviewer_id; changes.push('reviewer'); }
      if (labels !== undefined) { ticket.labels = JSON.stringify(labels); changes.push('labels'); }
      if (channel_ids !== undefined) { ticket.channel_ids = JSON.stringify(channel_ids); changes.push('channel_ids'); }
      if (base_repo_resource_id !== undefined) {
        const next = base_repo_resource_id || '';
        if (next && ticket.workspace_id) {
          // Mirror the REST guard: pin only repos that live in the ticket's
          // workspace so a guessed cross-workspace id can't bleed url/name
          // into the SSE prompt.
          const repoExists = await dataSource.getRepository(Resource).findOne({
            where: { id: next, workspace_id: ticket.workspace_id },
          });
          if (!repoExists) return err('base_repo_resource_id not found in this workspace');
        }
        ticket.base_repo_resource_id = next;
        // Skip the activity-feed entry on idempotent writes — matches REST
        // semantics so a no-op `update_ticket` doesn't spam the log.
        if (next !== (oldBaseRepoId || '')) changes.push('base_repo');
      }
      if (base_branch !== undefined) {
        const next = base_branch || '';
        ticket.base_branch = next;
        if (next !== (oldBaseBranch || '')) changes.push('base_branch');
      }
      if (next_ticket_id !== undefined) {
        try {
          ticket.next_ticket_id = await validateNextTicketId(
            dataSource,
            next_ticket_id,
            ticket.id,
            ticket.workspace_id || '',
          );
        } catch (e: any) {
          return err(e?.message || 'next_ticket_id rejected');
        }
        if ((ticket.next_ticket_id || '') !== (oldNextTicketId || '')) changes.push('next_ticket');
      }
      if (on_done_action_ids !== undefined) {
        // On-ticket-done hook binding (method "a"). Stored as a JSON string like
        // labels / channel_ids. Dedupe + drop blanks so the array stays clean.
        const cleaned = Array.from(new Set(on_done_action_ids.filter((s) => typeof s === 'string' && s)));
        ticket.on_done_action_ids = JSON.stringify(cleaned);
        changes.push('on_done_action_ids');
      }
      if (effort_preset !== undefined) {
        // Abstract effort preset id — stored as-is (trim; empty → null).
        // Resolved against the board catalog at dispatch; null = board default.
        const next = typeof effort_preset === 'string' && effort_preset.trim() ? effort_preset.trim() : null;
        if ((ticket.effort_preset || '') !== (next || '')) {
          ticket.effort_preset = next;
          changes.push('effort_preset');
        }
      }

      // Pending-user-action toggle (ticket a57517be). Tracked separately so
      // the activity log says "pending" instead of being lumped into a
      // generic `updated`. The reason / set_at / set_by trio always moves
      // together with the boolean — flipping false clears them; flipping
      // true stamps them from the caller / now / caller name.
      const oldPending = !!ticket.pending_user_action;
      if (pending_user_action !== undefined) {
        const next = !!pending_user_action;
        if (next !== oldPending) {
          ticket.pending_user_action = next;
          if (next) {
            ticket.pending_set_at = new Date();
            ticket.pending_set_by = caller?.agentName || '';
            if (pending_reason !== undefined) {
              ticket.pending_reason = pending_reason || '';
            }
          } else {
            ticket.pending_set_at = null;
            ticket.pending_set_by = '';
            ticket.pending_reason = '';
          }
          changes.push('pending_user_action');
        } else if (next && pending_reason !== undefined && pending_reason !== ticket.pending_reason) {
          // Updating reason without toggling the flag: keep stamps, refresh
          // the text. Still log so the audit trail shows the new wording.
          ticket.pending_reason = pending_reason || '';
          changes.push('pending_reason');
        }
      } else if (pending_reason !== undefined && oldPending && pending_reason !== ticket.pending_reason) {
        ticket.pending_reason = pending_reason || '';
        changes.push('pending_reason');
      }

      await ticketRepo.save(ticket);

      // B1: backfill workspace_id if the row was created via the legacy
      // (pre-fix) MCP path that left the column empty. Without this an
      // update_ticket call on such a ticket can't reach the assignment
      // table either, so the trigger loop stays blind even after the bug
      // moves to the maintenance phase.
      await refreshTicketWorkspaceId(dataSource, ticket);

      // v0.34: assignment-table sync. Only synced fields the caller actually
      // included; undefined slots preserve their existing assignment.
      if (ticketRoleAssignmentService && ticket.workspace_id) {
        const trio: { assignee_id?: string; reporter_id?: string; reviewer_id?: string } = {};
        if (assignee !== undefined || assignee_id !== undefined) trio.assignee_id = ticket.assignee_id || '';
        if (reporter !== undefined || reporter_id !== undefined) trio.reporter_id = ticket.reporter_id || '';
        if (reviewer_id !== undefined) trio.reviewer_id = ticket.reviewer_id || '';
        if (Object.keys(trio).length > 0) {
          await ticketRoleAssignmentService.syncBuiltinTrio(ticket.id, ticket.workspace_id, trio);
        }
      }

      // B2: apply role_assignments[] (planner / arbitrary custom roles).
      // Same explicit-slug-wins policy as create_ticket — `role_assignments`
      // for a builtin slug overrides the legacy `*_id` mirror above.
      const appliedRoles = await applyRoleAssignments(ctx, ticket.id, ticket.workspace_id, role_assignments);
      if (appliedRoles.length > 0) changes.push('role_assignments');

      // Log assignee/reporter changes separately for system comment generation.
      // Trigger off the post-save name (which now reflects backfilled lookups)
      // so a caller passing only `assignee_id` still produces a legible
      // activity entry instead of an empty `→` arrow.
      if ((assignee !== undefined || assignee_id !== undefined) && ticket.assignee !== oldAssignee) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: 'assignee', old_value: oldAssignee || '', new_value: ticket.assignee || '',
          ticket_id: ticket.id, actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }
      if ((reporter !== undefined || reporter_id !== undefined) && ticket.reporter !== oldReporter) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: 'reporter', old_value: oldReporter || '', new_value: ticket.reporter || '',
          ticket_id: ticket.id, actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }

      // Log other field changes (excluding assignee/reporter which are logged separately above)
      const otherChanges = changes.filter(c => c !== 'assignee' && c !== 'reporter');
      if (otherChanges.length > 0) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: otherChanges.join(', '), ticket_id: ticket.id,
          actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }

      // Ticket a57517be finding 2: an update_ticket call that flips
      // `pending_user_action` true → false must explicitly wake the
      // current column's role-holders. Mirrors the dedicated
      // `unpend_ticket` tool and the REST PATCH path — the activity row
      // alone does not route through column-based dispatch.
      if (
        triggerLoopService &&
        changes.includes('pending_user_action') &&
        oldPending &&
        !ticket.pending_user_action
      ) {
        try {
          await triggerLoopService.dispatchCurrentColumn(
            ticket.id, 'unpend', caller?.agentId || '',
          );
        } catch (e) {
          logger.warn('MCP', 'update_ticket unpend dispatch failed (continuing)', {
            err: String(e), ticket_id: ticket.id,
          });
        }
      }

      const updated = await loadTicketFull(dataSource, ticket.id);
      return ok(updated);
    }
  );

  server.tool(
    'pend_ticket',
    'Use ONLY when human input is required. For waiting on another ticket, use `add_ticket_prerequisites` instead (it auto-resumes when the blocker finishes — no human needed). ' +
    'Parks a ticket for user intervention: sets `pending_user_action=true` plus a `reason` rendered on the ticket detail panel\'s "User" tab. While pending, the trigger loop drops every agent_trigger for this ticket, the focus selector skips it (so the agent\'s focus moves to another ticket), and BacklogPromotionService refuses to promote into this column slot. Use when a decision genuinely needs a human — typically because the ticket would otherwise loop between System and Agent columns, or because the work has to be split into a follow-up ticket. Pair with `create_ticket` when the right move is to spin up a separate ticket for a scoped follow-up.',
    {
      ticket_id: z.string().describe('Ticket ID to park'),
      reason: z.string().describe('Why human intervention is needed. Surfaced verbatim on the User tab so the user can act without reading the comment log. Keep it specific (e.g. "credentials needed for prod DB migration" beats "stuck").'),
    },
    async ({ ticket_id, reason }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);
      const caller = getCallerAgent(extra);
      const wasPending = !!ticket.pending_user_action;
      ticket.pending_user_action = true;
      ticket.pending_reason = reason || '';
      if (!wasPending) {
        ticket.pending_set_at = new Date();
        ticket.pending_set_by = caller?.agentName || '';
      }
      await ticketRepo.save(ticket);
      await activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'pending_user_action',
        old_value: wasPending ? 'true' : 'false', new_value: 'true',
        ticket_id: ticket.id,
        actor_id: caller?.agentId, actor_name: caller?.agentName,
      });
      const updated = await loadTicketFull(dataSource, ticket.id);
      return ok(updated);
    }
  );

  server.tool(
    'unpend_ticket',
    'Clear a ticket\'s `pending_user_action` flag. Wakes the dispatch path back up — the focus selector reconsiders the ticket and the next column move (or supervisor re-push) triggers the relevant role holders. Use after the human decision is recorded or after a follow-up ticket has been filed and the original ticket can proceed.',
    {
      ticket_id: z.string().describe('Ticket ID to unpark'),
    },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);
      const caller = getCallerAgent(extra);
      const wasPending = !!ticket.pending_user_action;
      ticket.pending_user_action = false;
      ticket.pending_reason = '';
      ticket.pending_set_at = null;
      ticket.pending_set_by = '';
      await ticketRepo.save(ticket);
      if (wasPending) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: 'pending_user_action',
          old_value: 'true', new_value: 'false',
          ticket_id: ticket.id,
          actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
        // Ticket a57517be finding 2: clearing the flag must explicitly wake
        // the current column's role-holders. The `pending_user_action` field
        // activity above does NOT route through column-based dispatch (and
        // even if it did, `_handleActivity`'s focus-selector gate would still
        // need the flag flipped first — which it now is). Goes through the
        // focus selector inside `_emitTrigger` so if the agent is already
        // focused on another ticket, this stays silent and the focus model
        // decides when this ticket comes back into rotation.
        if (triggerLoopService) {
          try {
            await triggerLoopService.dispatchCurrentColumn(
              ticket.id, 'unpend', caller?.agentId || '',
            );
          } catch (e) {
            logger.warn('MCP', 'unpend_ticket dispatch failed (continuing)', {
              err: String(e), ticket_id: ticket.id,
            });
          }
        }
      }
      const updated = await loadTicketFull(dataSource, ticket.id);
      return ok(updated);
    }
  );

  server.tool(
    'delete_ticket',
    'Delete a ticket and all its children and comments',
    { ticket_id: z.string().describe('Ticket ID') },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({
        where: { id: ticket_id },
        relations: ['children', 'comments'],
      });
      if (!ticket) return err('Ticket not found');

      const caller = getCallerAgent(extra);
      const columnId = ticket.column_id;
      const position = ticket.position;

      // Prereq cascade (ticket 48d14fff): drop every link pointing AT this
      // ticket and re-evaluate the dependents BEFORE the row is removed — once
      // remove() runs the FK ON DELETE CASCADE wipes the link rows and we'd
      // have nothing left to read. `onPrerequisiteRemoved` returns the
      // dependents that just lost their last open prereq so we can wake them.
      let unblockedDependents: string[] = [];
      if (ticketPrerequisitesService) {
        try {
          unblockedDependents = await ticketPrerequisitesService.onPrerequisiteRemoved(ticket.id);
        } catch (e) {
          logger.warn('MCP', 'delete_ticket prereq cascade failed (continuing)', {
            err: String(e), ticket_id: ticket.id,
          });
        }
      }

      await deleteCommentAttachmentsForTicket(dataSource, ticket.id);
      await ticketRepo.remove(ticket);

      await shiftTicketPositions(ticketRepo, { column_id: columnId }, position, -1);

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'deleted',
        ticket_id: ticket.id, actor_id: caller?.agentId, actor_name: caller?.agentName,
      });

      // Wake the now-unblocked dependents on their current column.
      if (triggerLoopService) {
        for (const depId of unblockedDependents) {
          try {
            await triggerLoopService.dispatchCurrentColumn(depId, 'prerequisite_resolved', caller?.agentId || '');
          } catch (e) {
            logger.warn('MCP', 'delete_ticket unblock dispatch failed (continuing)', {
              err: String(e), ticket_id: depId,
            });
          }
        }
      }

      return ok({ success: true, deleted_ticket_id: ticket_id, unblocked_dependents: unblockedDependents });
    }
  );

  // ─── Child ticket tools ─────────────────────────────────────

  server.tool(
    'get_my_tickets',
    'Get tickets where this agent is assignee, reporter, or reviewer within the workspace. Each row includes `my_roles` — the role slug(s) the agent holds on that ticket — so an agent juggling multiple roles can see at a glance which hat to wear per ticket.',
    {
      agent_id: z.string().describe('Calling agent ID'),
      workspace_id: z.string().describe('Workspace to scope results'),
      status: z.string().optional().describe('Filter by ticket status (optional, e.g. "todo", "in_progress", "done")'),
    },
    async ({ agent_id, workspace_id, status }) => {
      const agentRepo = dataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      if (agent.workspace_id && agent.workspace_id !== workspace_id) {
        return err('Agent does not belong to the requested workspace');
      }

      const ticketRepo = dataSource.getRepository(Ticket);
      let qb = ticketRepo.createQueryBuilder('t')
        .innerJoin('columns', 'col', 'col.id = t.column_id')
        .innerJoin('boards', 'b', 'b.id = col.board_id')
        .where('b.workspace_id = :workspaceId', { workspaceId: workspace_id })
        .andWhere('(t.assignee_id = :agentId OR t.reporter_id = :agentId OR t.reviewer_id = :agentId)', { agentId: agent_id })
        // Archived tickets drop out of the agent's active list by default —
        // they're not actionable workflow items, just history. The Archive
        // UI / list_archived_tickets tool covers explicit lookup.
        .andWhere('t.archived_at IS NULL');

      if (status) {
        qb = qb.andWhere('t.status = :status', { status });
      }

      const tickets = await qb.orderBy('t.created_at', 'DESC').getMany();

      // Resolve role slugs the agent holds per ticket. Prefer
      // TicketRoleAssignment (handles workspace-custom roles); fall back to
      // the legacy assignee_id / reporter_id / reviewer_id columns when the
      // assignment service is unavailable (standalone MCP server mode) or
      // returns nothing for a row.
      const rolesByTicket = new Map<string, string[]>();
      if (ticketRoleAssignmentService) {
        for (const t of tickets) {
          try {
            const resolved = await ticketRoleAssignmentService.resolveForTicket(t.id);
            const slugs = resolved
              .filter(r => r.holder?.type === 'agent' && r.holder.id === agent_id)
              .map(r => r.role.slug);
            if (slugs.length > 0) rolesByTicket.set(t.id, slugs);
          } catch { /* fall through to legacy lookup */ }
        }
      }

      return ok(tickets.map(t => {
        let myRoles = rolesByTicket.get(t.id);
        if (!myRoles || myRoles.length === 0) {
          const legacy: string[] = [];
          if (t.assignee_id === agent_id) legacy.push('assignee');
          if (t.reporter_id === agent_id) legacy.push('reporter');
          if (t.reviewer_id === agent_id) legacy.push('reviewer');
          myRoles = legacy;
        }
        return {
          ...t,
          labels: safeJsonParse(t.labels, []),
          channel_ids: safeJsonParse(t.channel_ids, []),
          my_roles: myRoles,
        };
      }));
    }
  );

  // ─── Ticket locking ─────────────────────────────────────

}
