/**
 * Ticket CRUD MCP tools (docs/tickets.md).
 *
 * Tools: get_ticket, list_tickets, create_ticket, update_ticket,
 * decide_ticket_duplicate, correct_confirmed_ticket_duplicate, pend_ticket,
 * unpend_ticket, delete_ticket, get_my_tickets
 *
 * Every mutation goes through TicketService so MCP, REST and the automatic
 * ticket producers share one set of side effects (activity, terminal stamp,
 * dispatch). Siblings: ticket-child-tools.ts (hierarchy), ticket-workflow-tools.ts
 * (status moves).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DataSource } from 'typeorm';
import { Ticket } from '../../../entities/Ticket';
import { ok, err, sanitizeHarnessMarkers, withArtifactRef } from '../shared/helpers';
import { evaluatePendActionGate, type PendActionCandidate } from '../shared/pend-action-gate';
import { loadPendActionCandidates } from '../shared/pend-action-scope';
import { loadTicketFull } from '../shared/ticket-parsing';
import { shiftTicketPositions, deleteCommentAttachmentsForTicket, resolveCallerDisplayName } from '../shared/ticket-helpers';
import { getCallerAgent, HUMAN_ONLY_UNPEND_MESSAGE, type McpAgentContext } from '../shared/session-auth';
import { TicketArchivedError } from '../shared/archive-helpers';
import { TicketDuplicateService } from '../../tickets/ticket-duplicate.service';
import { TicketInputError, type TicketActor } from '../../tickets/ticket.service';
import { DONE_STATUS, parseTicketStatus, TICKET_STATUSES, type TicketStatus } from '../../../common/ticket-status';
import type { ToolContext } from './context';

/** The MCP caller as a ticket actor — runtime key first, it is what `assignee_key` holds. */
export function callerActor(caller: McpAgentContext | undefined): TicketActor {
  return {
    id: caller?.runtimeKey || caller?.agentId || '',
    name: caller?.agentName || 'agent',
    type: 'agent',
  };
}

/** callerActor with the Host display name — for names stored on the ticket itself (created_by, pending_set_by). */
async function namedCallerActor(dataSource: DataSource, caller: McpAgentContext | undefined): Promise<TicketActor> {
  const actor = callerActor(caller);
  return { ...actor, name: (await resolveCallerDisplayName(dataSource, caller)) || actor.name };
}

const RuntimeSpecInput = z.record(z.string(), z.any()).describe(
  'RuntimeSpec of the agent that does the ticket: { manager_agent_id (Runtime Host id), cli, model?, working_dir (absolute path on that host), folder_scope?, credential_id?, cli_runtime_profile?, runtime_config?, label?, role_prompt? }. ' +
  'Tip: a project\'s main clone folder on that host is the natural working_dir (get_project → host_folders).',
);

const STATUS_HELP = `One of ${TICKET_STATUSES.join(', ')}`;

function mapError(e: any) {
  if (e instanceof TicketInputError || e instanceof TicketArchivedError) return err(e.message);
  return err(e?.message || String(e));
}

export function registerTicketCrudTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService, logger, ticketService, ticketPrerequisitesService } = ctx;

  server.tool(
    'get_ticket',
    'Get a single ticket with its children, comments, project (incl. main clone folder per host), assignee and prerequisites. `status` is the ticket\'s workflow state (backlog / todo / in_progress / review / done).',
    { ticket_id: z.string().describe('Ticket ID') },
    async ({ ticket_id }) => {
      const ticket = await loadTicketFull(dataSource, ticket_id);
      if (!ticket) return err('Ticket not found');
      return ok(ticket);
    },
  );

  server.tool(
    'list_tickets',
    'List root tickets of a workspace, filtered by status / tags (AND) / project / assignee / text. Returns `{ tickets, tags }` where `tags` counts each tag across the filtered set. Use this to find related or duplicate work before starting.',
    {
      account_id: z.string().optional().describe('Account (defaults to the caller\'s workspace)'),
      status: z.array(z.string()).optional().describe(`Statuses to include (${TICKET_STATUSES.join(', ')}); omit for all`),
      tags: z.array(z.string()).optional().describe('Every listed tag must be present (case-insensitive)'),
      project_id: z.string().optional(),
      assignee_key: z.string().optional().describe('Runtime identity key of the assignee (rt-…)'),
      query: z.string().optional().describe('Case-insensitive substring of title or description'),
      include_archived: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
    async ({ account_id, status, tags, project_id, assignee_key, query, include_archived, limit }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const ws = account_id || caller?.accountId || '';
      if (!ws) return err('account_id is required');
      const statuses: TicketStatus[] = [];
      for (const raw of status || []) {
        const parsed = parseTicketStatus(raw);
        if (!parsed) return err(`Unknown status "${raw}" — ${STATUS_HELP}`);
        statuses.push(parsed);
      }
      const result = await ticketService.list(ws, {
        status: statuses, tags, project_id, assignee_key, q: query, include_archived, limit,
      });
      // Compact rows — the full thread is get_ticket's job.
      return ok({
        tickets: result.tickets.map((t: any) => withArtifactRef('ticket', {
          id: t.id, title: t.title, status: t.status, priority: t.priority, tags: t.tags,
          project: t.project ?? null, assignee_name: t.assignee_name, assignee_key: t.assignee_key,
          pending_user_action: t.pending_user_action, pending_on_tickets: t.pending_on_tickets,
          updated_at: t.updated_at, children: (t.children || []).length,
        }, t.title)),
        tags: result.tags,
      });
    },
  );

  server.tool(
    'create_ticket',
    'Create a ticket. A ticket is done end-to-end by ONE agent (`assignee`); classify it with free-form `tags` and, when it is about a repository, a `project_id`. ' +
    'Omitting `assignee` applies the project\'s default assignee (if any); pass `assignee: null` for an unassigned ticket. ' +
    'Status defaults to `todo`, which queues it for the assignee immediately — use `backlog` for work that is not ready. ' +
    'Follow-ups you discover while working: create them with status `backlog`, the same project/tags, and a description that links back to your ticket.',
    {
      account_id: z.string().optional().describe('Account (defaults to the caller\'s workspace)'),
      title: z.string().describe('Ticket title'),
      description: z.string().optional().default('').describe('Ticket description'),
      prompt_text: z.string().optional().describe('Extra instructions for the agent (shown in the work order)'),
      status: z.string().optional().describe(`Initial status (default todo). ${STATUS_HELP}`),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium'),
      tags: z.array(z.string()).optional().default([]).describe('Free-form classification tags'),
      project_id: z.string().optional().describe('Project (repository) the work is about'),
      base_branch: z.string().optional().describe('Branch to start from; empty = the project default branch'),
      assignee: RuntimeSpecInput.nullable().optional(),
      channel_ids: z.array(z.string()).optional().default([]).describe('Notification channel IDs'),
      subtasks: z.array(z.string()).optional().default([]).describe('Checklist items to create as child tickets'),
      next_ticket_id: z.string().optional().describe('Ticket to move from backlog to todo once this one is done (same workspace)'),
      source_kind: z.enum(['chat']).optional().describe('Durable source kind. Set for chat-originated reports.'),
      source_chat_room_id: z.string().optional().describe('Source chat room id for duplicate matching.'),
      related_ticket_id: z.string().optional().describe('Related/reproduced ticket id for duplicate matching.'),
    },
    async (args, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const ws = args.account_id || caller?.accountId || '';
      if (!ws) return err('account_id is required');
      const description = sanitizeHarnessMarkers(args.description, { logger, toolName: 'create_ticket', fieldName: 'description', agentId: caller?.agentId });
      try {
        const { ticket, duplicate_candidates } = await ticketService.create(ws, {
          ...args,
          description,
          ...(args.assignee === undefined ? {} : { assignee: args.assignee }),
        }, await namedCallerActor(dataSource, caller));
        // Inline checklist items.
        const repo = dataSource.getRepository(Ticket);
        for (let i = 0; i < (args.subtasks || []).length; i += 1) {
          const title = String(args.subtasks[i] || '').trim();
          if (!title) continue;
          await repo.save(repo.create({
            parent_id: ticket.id, depth: 1, title, status: 'todo', position: i,
            account_id: ticket.account_id, tags: '[]', channel_ids: '[]',
            created_by: caller?.agentName || '', created_by_type: 'agent', created_by_id: caller?.runtimeKey || caller?.agentId || '',
          }));
        }
        const full = await loadTicketFull(dataSource, ticket.id);
        if (full) ctx.pendingTicketRefs?.record({ action: 'create', ticket_id: ticket.id, title: full.title || ticket.title });
        return ok(full ? { ...full, duplicate_candidates } : full);
      } catch (e: any) {
        return mapError(e);
      }
    },
  );

  server.tool(
    'update_ticket',
    'Update a root ticket\'s fields: title, description, prompt_text, priority, tags, project_id, base_branch, assignee, channel_ids, next_ticket_id, on_done_action_ids. ' +
    'To change the status use move_ticket. Pass `assignee: null` to unassign. Changing the assignee of an in-progress ticket hands the running work to the new agent.',
    {
      ticket_id: z.string().describe('Ticket ID'),
      title: z.string().optional(),
      description: z.string().optional(),
      prompt_text: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      tags: z.array(z.string()).optional().describe('Replaces the tag set'),
      project_id: z.string().nullable().optional(),
      base_branch: z.string().optional(),
      assignee: RuntimeSpecInput.nullable().optional(),
      channel_ids: z.array(z.string()).optional(),
      next_ticket_id: z.string().nullable().optional(),
      on_done_action_ids: z.array(z.string()).optional().describe('Actions to run once when this ticket is done'),
      pending_user_action: z.boolean().optional().describe('true parks the ticket (same as pend_ticket); false is rejected — only a human can unpend'),
      pending_reason: z.string().optional(),
    },
    async (args, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const existing = await dataSource.getRepository(Ticket).findOne({ where: { id: args.ticket_id } });
      if (!existing) return err('Ticket not found');
      if (args.pending_user_action === false && existing.pending_user_action) return err(HUMAN_ONLY_UNPEND_MESSAGE);
      const body: any = { ...args };
      delete body.ticket_id;
      if (body.description !== undefined) {
        body.description = sanitizeHarnessMarkers(body.description, { logger, toolName: 'update_ticket', fieldName: 'description', agentId: caller?.agentId });
      }
      try {
        const actor = await namedCallerActor(dataSource, caller);
        if (args.pending_user_action === true) await ticketService.pend(existing.id, args.pending_reason ?? existing.pending_reason ?? '', actor);
        const before = JSON.stringify(await loadTicketFull(dataSource, existing.id));
        await ticketService.update(existing.id, body, actor);
        const updated = await loadTicketFull(dataSource, existing.id);
        if (updated && JSON.stringify(updated) !== before) {
          ctx.pendingTicketRefs?.record({ action: 'update', ticket_id: existing.id, title: updated.title || existing.title });
        }
        return ok(updated);
      } catch (e: any) {
        return mapError(e);
      }
    },
  );

  server.tool(
    'decide_ticket_duplicate',
    'Resolve an ambiguous chat-ticket match. Link it to a listed canonical candidate, or keep it independent so it is worked normally.',
    {
      ticket_id: z.string().describe('Ambiguous report ticket id'),
      action: z.enum(['link', 'keep_independent']),
      candidate_ticket_id: z.string().optional().describe('Required for action=link'),
    },
    async ({ ticket_id, action, candidate_ticket_id }, extra: { sessionId?: string }) => {
      if (action === 'link' && !candidate_ticket_id) return err('candidate_ticket_id is required for action=link');
      const caller = getCallerAgent(extra);
      try {
        const duplicateService = new TicketDuplicateService(dataSource);
        const ticket = await duplicateService.confirm(
          ticket_id,
          action === 'link' ? candidate_ticket_id! : null,
          caller?.agentName || '',
          caller?.agentId || '',
        );
        if (action === 'keep_independent') await ctx.ticketDispatchService?.resumeTicket(ticket.id, 'duplicate_rejected');
        return ok(await loadTicketFull(dataSource, ticket.id));
      } catch (e: any) {
        return err(e?.message || 'Duplicate decision rejected');
      }
    },
  );

  server.tool(
    'correct_confirmed_ticket_duplicate',
    'Correct a previously confirmed false-positive canonical link: clears the link (an audited data correction) and, when the ticket is queued or in progress, wakes its assignee. The canonical ticket is never modified.',
    { ticket_id: z.string().describe('Incorrectly linked report ticket id') },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      try {
        const duplicateService = new TicketDuplicateService(dataSource);
        const corrected = await duplicateService.correctConfirmedLink(ticket_id, caller?.agentName || '', caller?.agentId || '');
        const dispatch = ctx.ticketDispatchService
          ? await ctx.ticketDispatchService.resumeTicket(corrected.ticket.id, 'duplicate_correction')
          : { dispatched: false, reason: 'standalone' };
        return ok({
          ticket: await loadTicketFull(dataSource, corrected.ticket.id),
          previous_canonical_ticket_id: corrected.previousCanonicalId,
          dispatched: dispatch.dispatched,
          dispatch_skipped_reason: dispatch.dispatched ? '' : dispatch.reason || '',
        });
      } catch (e: any) {
        return err(e?.message || 'Confirmed duplicate correction rejected');
      }
    },
  );

  server.tool(
    'pend_ticket',
    'Use ONLY when human input is required AND no registered Action can resolve the blocker. ' +
    'Before parking for something an Action could do (deploy, publish, merge-to-production, run a scripted task), discover + run an Action instead (`list_actions` → `run_action`, or `save_action` → `run_action`) and resume the ticket in place. ' +
    'For waiting on another ticket, use `add_ticket_prerequisites` instead (it auto-resumes when the blocker is done — no human needed). ' +
    'Parks a ticket for user intervention: sets `pending_user_action=true` plus a `reason` rendered on the ticket panel. While pending the ticket is never dispatched and frees its agent\'s capacity slot; a human resumes it. ' +
    'ACTION GATE (ticket 524bb434): while runnable Actions exist in this ticket\'s workspace, the call is REJECTED unless `no_action_reason` is supplied — the error lists the candidate Actions so you run/register one instead of parking.',
    {
      ticket_id: z.string().describe('Ticket ID to park'),
      reason: z.string().describe('Why human intervention is needed. Keep it specific (e.g. "credentials needed for prod DB migration" beats "stuck").'),
      no_action_reason: z.string().optional().describe('Why no registered Action can resolve this blocker. REQUIRED when runnable Actions exist in the ticket\'s workspace.'),
    },
    async ({ ticket_id, reason, no_action_reason }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);
      const caller = getCallerAgent(extra);

      // ── Action gate (ticket 524bb434) — fails OPEN on scope errors ──
      let candidates: PendActionCandidate[] = [];
      try {
        candidates = await loadPendActionCandidates(dataSource, ticket);
      } catch (e) {
        logger.warn('MCP', 'pend_ticket action-gate scope resolution failed (failing open)', { err: String(e), ticket_id: ticket.id });
      }
      const gate = evaluatePendActionGate(candidates, no_action_reason);
      if (!gate.allowed) return err(gate.message!);

      // A done ticket is never revisited — parking it would strand the ask invisibly.
      if (ticket.status === DONE_STATUS) {
        return err(
          `pend_ticket blocked: ticket ${ticket.id} is already done. Pending only matters for a ticket that is still being worked — ` +
          'if a human genuinely needs to look at this closed ticket, say so in a comment and mention them instead.',
        );
      }
      try {
        const actor = await namedCallerActor(dataSource, caller);
        await ticketService.pend(ticket.id, reason, actor);
        const noActionReason = (no_action_reason ?? '').trim();
        if (gate.candidateCount > 0 && noActionReason) {
          await activityService.logActivity({
            entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
            field_changed: 'pend_no_action_reason', old_value: '', new_value: noActionReason,
            ticket_id: ticket.id, account_id: ticket.account_id,
            actor_id: caller?.agentId, actor_name: caller?.agentName,
          });
        }
      } catch (e: any) {
        return mapError(e);
      }
      return ok(await loadTicketFull(dataSource, ticket.id));
    },
  );

  server.tool(
    'unpend_ticket',
    'HUMAN ONLY — this call always rejects over MCP. Clearing a ticket\'s `pending_user_action` flag ' +
    'asserts "a human made the call"; MCP is an agent-only connection surface with no authenticated ' +
    'user session to prove that (ticket b2e88390). A human clears the park from the AWB web UI ' +
    '(ticket panel → Resume) or an authenticated REST call to PATCH /api/tickets/:id — never this tool. ' +
    'If a human already left their answer as a comment, do not call this: stop and wait, AWB wakes you once they unpend it.',
    { ticket_id: z.string().describe('Ticket ID (unused — this call always rejects; see tool description)') },
    async () => err(HUMAN_ONLY_UNPEND_MESSAGE),
  );

  server.tool(
    'delete_ticket',
    'Delete a ticket and all its children and comments',
    { ticket_id: z.string().describe('Ticket ID') },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id }, relations: ['children', 'comments'] });
      if (!ticket) return err('Ticket not found');
      const linkedDuplicates = await ticketRepo.count({ where: { canonical_ticket_id: ticket.id } });
      if (linkedDuplicates > 0) {
        return err(`canonical_has_duplicates: ${linkedDuplicates} linked report(s) must be relinked first`);
      }
      const caller = getCallerAgent(extra);
      const { position, parent_id: parentId, account_id: accountId } = ticket;
      // Prereq cascade (ticket 48d14fff): re-evaluate dependents BEFORE the row
      // is removed — the FK ON DELETE CASCADE would wipe the link rows first.
      let unblockedDependents: string[] = [];
      if (ticketPrerequisitesService) {
        try {
          unblockedDependents = await ticketPrerequisitesService.onPrerequisiteRemoved(ticket.id);
        } catch (e) {
          logger.warn('MCP', 'delete_ticket prereq cascade failed (continuing)', { err: String(e), ticket_id: ticket.id });
        }
      }
      await deleteCommentAttachmentsForTicket(dataSource, ticket.id);
      await ticketRepo.remove(ticket);
      if (parentId) await shiftTicketPositions(ticketRepo, { parent_id: parentId }, position, -1);
      await activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket_id, action: 'deleted',
        ticket_id, account_id: accountId, actor_id: caller?.agentId, actor_name: caller?.agentName,
      });
      for (const depId of unblockedDependents) {
        try {
          await ctx.ticketDispatchService?.resumeTicket(depId, 'prerequisite_resolved');
        } catch (e) {
          logger.warn('MCP', 'delete_ticket unblock dispatch failed (continuing)', { err: String(e), ticket_id: depId });
        }
      }
      return ok({ success: true, deleted_ticket_id: ticket_id, unblocked_dependents: unblockedDependents });
    },
  );

  server.tool(
    'get_my_tickets',
    'Tickets assigned to the calling agent (its runtime identity), newest first. Archived tickets are excluded.',
    {
      account_id: z.string().optional().describe('Account (defaults to the caller\'s workspace)'),
      status: z.string().optional().describe(`Filter by status. ${STATUS_HELP}`),
      assignee_key: z.string().optional().describe('Runtime identity key to look up instead of the caller (rt-…)'),
    },
    async ({ account_id, status, assignee_key }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const key = assignee_key || caller?.runtimeKey || '';
      if (!key) return err('This session has no runtime identity — pass assignee_key');
      const ws = account_id || caller?.accountId || '';
      let statuses: TicketStatus[] = [];
      if (status) {
        const parsed = parseTicketStatus(status);
        if (!parsed) return err(`Unknown status "${status}" — ${STATUS_HELP}`);
        statuses = [parsed];
      }
      const qb = dataSource.getRepository(Ticket).createQueryBuilder('t')
        .where('t.assignee_key = :key', { key })
        .andWhere('t.archived_at IS NULL')
        .andWhere('t.parent_id IS NULL');
      if (ws) qb.andWhere('t.account_id = :ws', { ws });
      if (statuses.length) qb.andWhere('t.status IN (:...statuses)', { statuses });
      const rows = await qb.orderBy('t.updated_at', 'DESC').take(200).getMany();
      return ok((await ticketService.cards(rows)).map((t: any) => withArtifactRef('ticket', {
        id: t.id, title: t.title, status: t.status, priority: t.priority, tags: t.tags,
        project: t.project ?? null, pending_user_action: t.pending_user_action,
        pending_on_tickets: t.pending_on_tickets, pending_ci_wait: t.pending_ci_wait,
        updated_at: t.updated_at,
      }, t.title)));
    },
  );
}
