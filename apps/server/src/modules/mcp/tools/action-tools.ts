/**
 * Actions MCP tools.
 *
 * An Action is a saved prompt addressed to a target Agent. Each Run creates
 * a fresh ChatRoom and posts the rendered prompt as the user's first message;
 * the agent's reply lands in the room via the existing chat_room_message
 * pipeline. Per ticket-locked decision: Q1=a (target agent pinned at create
 * time), Q2=b (Run-per-room with FIFO prune at Action.max_runs).
 *
 * Tools:
 *   - list_actions
 *   - get_action
 *   - save_action     (create OR update)
 *   - delete_action
 *   - run_action      (dispatch a fresh Run)
 *   - list_action_runs
 *   - search_actions  (text search across name / description / prompt)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Action } from '../../../entities/Action';
import { ActionRun } from '../../../entities/ActionRun';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

function actionToJson(a: Action) {
  return {
    id: a.id,
    workspace_id: a.workspace_id,
    board_id: a.board_id,
    name: a.name,
    description: a.description,
    prompt: a.prompt,
    target_agent_id: a.target_agent_id,
    schedule_cron: a.schedule_cron,
    trigger: a.trigger,
    trigger_label: a.trigger_label,
    enabled: a.enabled,
    max_runs: a.max_runs,
    last_run_at: a.last_run_at,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

export function registerActionTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, actionsService, triggerLoopService, logger } = ctx;

  server.tool(
    'list_actions',
    'List actions in a workspace. Scope rule mirrors list_resources: omit board_id → ALL ' +
    '(workspace+board); pass board_id="" → workspace-scope only (board_id IS NULL); ' +
    'pass board_id=<uuid> → that board only.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('"" → workspace-scope, <uuid> → board-scope, omit → all'),
    },
    async ({ workspace_id, board_id }) => {
      const repo = dataSource.getRepository(Action);
      const qb = repo.createQueryBuilder('a').where('a.workspace_id = :ws', { ws: workspace_id });
      if (board_id !== undefined) {
        if (board_id) qb.andWhere('a.board_id = :bid', { bid: board_id });
        else qb.andWhere('a.board_id IS NULL');
      }
      const rows = await qb.orderBy('a.name', 'ASC').getMany();
      return ok(rows.map(actionToJson));
    },
  );

  server.tool(
    'get_action',
    'Get a single action by ID with the full prompt template.',
    { id: z.string().describe('Action ID') },
    async ({ id }) => {
      const a = await dataSource.getRepository(Action).findOne({ where: { id } });
      if (!a) return err('Action not found');
      return ok(actionToJson(a));
    },
  );

  server.tool(
    'save_action',
    'Create or update an action. Provide `id` to update an existing action; omit it to create. ' +
    'The `target_agent_id` must reference an agent in the same workspace (or a global agent). ' +
    '`schedule_cron` accepts a 5-field cron expression with `*` and integer values; leave empty for manual-only. ' +
    "`trigger='on_ticket_done'` opts the action into the lifecycle hook — it runs once when a ticket lands on a " +
    'terminal column (Done), scoped by board_id (omit/null = any board in the workspace) and trigger_label ' +
    '(empty = any label). The finished ticket is exposed to the prompt as {{ticket.id}}/{{ticket.title}}/{{ticket.board_id}} etc. ' +
    'enabled=false skips the hook too (manual run_action only). ' +
    'Prompt supports `{{var.path}}` interpolation against {action,run,workspace,board,user,agent,ticket,date,time,datetime}.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      id: z.string().optional().describe('Action ID — omit to create, provide to update'),
      board_id: z.string().optional().describe('Board ID for board-scoped actions. Omit or null for workspace-level.'),
      name: z.string().describe('Action name'),
      description: z.string().optional().describe('Short description'),
      prompt: z.string().optional().describe('Prompt template with {{var}} interpolation'),
      target_agent_id: z.string().optional().describe('Target agent ID (required when creating; optional when updating)'),
      schedule_cron: z.string().optional().describe('5-field cron (e.g. "0 9 * * 1" for Mon 9am); empty = manual'),
      trigger: z.string().optional().describe("Lifecycle trigger: '' (cron/manual, default) or 'on_ticket_done' (run when a ticket reaches a terminal column)"),
      trigger_label: z.string().optional().describe("For trigger='on_ticket_done': only fire when the finished ticket carries this label. Empty = any label."),
      enabled: z.boolean().optional().describe('When false, scheduler/hook skips this action (manual run still works)'),
      max_runs: z.number().optional().describe('FIFO prune budget (default 10)'),
    },
    async ({ workspace_id, id, board_id, name, description, prompt, target_agent_id, schedule_cron, trigger, trigger_label, enabled, max_runs }) => {
      if (!actionsService) return err('Actions service unavailable in this MCP context');
      try {
        if (id) {
          const updated = await actionsService.update(id, workspace_id, {
            name,
            description,
            prompt,
            target_agent_id,
            board_id: board_id || null,
            schedule_cron,
            trigger,
            trigger_label,
            enabled,
            max_runs,
          } as any);
          return ok(actionToJson(updated));
        }
        if (!target_agent_id) return err('target_agent_id is required when creating an action');
        const created = await actionsService.create({
          workspace_id,
          board_id: board_id || null,
          name,
          description: description ?? '',
          prompt: prompt ?? '',
          target_agent_id,
          schedule_cron: schedule_cron ?? '',
          trigger: trigger ?? '',
          trigger_label: trigger_label ?? '',
          enabled: enabled !== false,
          max_runs: typeof max_runs === 'number' ? max_runs : 10,
        } as any);
        return ok(actionToJson(created));
      } catch (e: any) {
        return err(e?.message || 'Failed to save action');
      }
    },
  );

  server.tool(
    'delete_action',
    'Delete an action and all its run history (rooms + messages + runs).',
    {
      workspace_id: z.string().describe('Workspace ID (scope boundary)'),
      id: z.string().describe('Action ID'),
    },
    async ({ workspace_id, id }) => {
      if (!actionsService) return err('Actions service unavailable in this MCP context');
      try {
        await actionsService.remove(id, workspace_id);
        return ok({ success: true, id });
      } catch (e: any) {
        return err(e?.message || 'Failed to delete action');
      }
    },
  );

  server.tool(
    'run_action',
    'Dispatch a Run for an action. Creates a new chat room with the target agent, ' +
    'sends the rendered prompt, and FIFO-prunes older rooms past Action.max_runs. ' +
    'Returns the run id + room id so the caller can monitor the conversation. ' +
    'Pass `source_ticket_id` when you run an Action to clear a blocker on a ticket ' +
    'you are working: the run is linked back to that ticket, the target agent is told ' +
    'to report its outcome via `complete_action_run`, and on success the ticket ' +
    'AUTO-RESUMES in place (no Pending, no manual re-dispatch). Omit it for ' +
    'cron/manual/standalone runs that have no ticket to resume.',
    {
      action_id: z.string().describe('Action ID'),
      source_ticket_id: z.string().optional().describe('Ticket that this run should resume on completion. When set, the run carries the linkage and `complete_action_run` re-dispatches this ticket. Omit for runs with no originating ticket.'),
    },
    async ({ action_id, source_ticket_id }, extra: { sessionId?: string }) => {
      if (!actionsService) return err('Actions service unavailable in this MCP context');
      // Triggering identity: an authenticated agent caller (MCP session bound
      // to an agentId) is attributed as 'agent' with that agent's id. Without
      // an authenticated agent the run is attributed to 'system' so the chat
      // history still shows where it came from.
      const caller = getCallerAgent(extra);
      try {
        const result = await actionsService.dispatch({
          actionId: action_id,
          triggeredByType: caller?.agentId ? 'agent' : 'system',
          triggeredById: caller?.agentId ?? '',
          sourceTicketId: source_ticket_id,
        });
        return ok({
          run_id: result.run.id,
          room_id: result.room_id,
          prompt: result.prompt,
          source_ticket_id: result.run.source_ticket_id || '',
        });
      } catch (e: any) {
        return err(e?.message || 'Failed to run action');
      }
    },
  );

  server.tool(
    'complete_action_run',
    'Report the outcome of an Action Run and close the loop back to the ticket that ' +
    'dispatched it. The target agent that performed the Run calls this ONCE when done. ' +
    'On `succeeded`, the run\'s `source_ticket_id` (if any) is AUTO-RESUMED — the ticket\'s ' +
    'current-column role holders are re-dispatched so work continues on the same ticket — ' +
    'and the summary is posted to the ticket\'s audit trail. On `failed`, the run is retried ' +
    'automatically up to a bounded cap (fresh run, same source ticket); once the cap is ' +
    'reached the failure is surfaced and the ticket is resumed so the assignee can decide. ' +
    'Idempotent: a second call on an already-completed run is a no-op (no double resume/retry).',
    {
      run_id: z.string().describe('Run ID (from run_action / list_action_runs)'),
      workspace_id: z.string().describe('Workspace ID (scope boundary)'),
      status: z.enum(['succeeded', 'failed']).describe("'succeeded' → resume the source ticket; 'failed' → retry (bounded), then surface + resume"),
      summary: z.string().optional().describe('What you did and the outcome, or why it failed. Mirrored into the source ticket audit comment.'),
    },
    async ({ run_id, workspace_id, status, summary }, extra: { sessionId?: string }) => {
      if (!actionsService) return err('Actions service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const result = await actionsService.completeRun(run_id, workspace_id, {
          status,
          summary,
          actorType: caller?.agentId ? 'agent' : 'system',
          actorId: caller?.agentId ?? '',
          actorName: caller?.agentName ?? '',
        });

        // Auto-resume: re-dispatch the source ticket's current-column role
        // holders so work continues in place. Only when the service says so
        // (success, or a failure that exhausted retries) — a retry defers the
        // resume to the retry run. Goes through the focus/pending/strand gates
        // in _emitTrigger, so it stays silent if the ticket isn't the holder's
        // current focus. Best-effort: a resume miss must not fail the call —
        // the outcome is already recorded on the run + ticket audit trail.
        let resumeEmitted = 0;
        if (result.shouldResume && result.sourceTicketId && triggerLoopService) {
          try {
            const dispatched = await triggerLoopService.dispatchCurrentColumn(
              result.sourceTicketId,
              status === 'succeeded' ? 'action_run_succeeded' : 'action_run_failed',
              caller?.agentId || '',
            );
            resumeEmitted = dispatched?.emitted ?? 0;
          } catch (e: any) {
            logger?.warn?.('MCP', 'complete_action_run resume dispatch failed (continuing)', {
              err: String(e), ticket_id: result.sourceTicketId, run_id,
            });
          }
        }

        return ok({
          run_id: result.run.id,
          status: result.status,
          source_ticket_id: result.sourceTicketId,
          previously_completed: result.previouslyCompleted,
          retried: result.retried,
          retry_run_id: result.retryRunId,
          exhausted: result.exhausted,
          resumed: result.shouldResume,
          resume_emitted: resumeEmitted,
        });
      } catch (e: any) {
        return err(e?.message || 'Failed to complete action run');
      }
    },
  );

  server.tool(
    'list_action_runs',
    'List runs for an action (most recent first), capped at limit.',
    {
      workspace_id: z.string().describe('Workspace ID (scope boundary)'),
      action_id: z.string().describe('Action ID'),
      limit: z.number().optional().default(20).describe('Max runs to return (default 20, cap 100)'),
    },
    async ({ workspace_id, action_id, limit }) => {
      if (!actionsService) return err('Actions service unavailable in this MCP context');
      try {
        const runs = await actionsService.listRuns(action_id, workspace_id, limit ?? 20);
        return ok(runs.map((r: ActionRun) => ({
          id: r.id,
          action_id: r.action_id,
          workspace_id: r.workspace_id,
          room_id: r.room_id,
          triggered_by_type: r.triggered_by_type,
          triggered_by_id: r.triggered_by_id,
          prompt_rendered: r.prompt_rendered,
          source_ticket_id: r.source_ticket_id || '',
          status: r.status || 'running',
          result_summary: r.result_summary || '',
          attempt: r.attempt ?? 1,
          completed_at: r.completed_at ?? null,
          created_at: r.created_at,
        })));
      } catch (e: any) {
        return err(e?.message || 'Failed to list runs');
      }
    },
  );

  server.tool(
    'search_actions',
    'Text search across action name, description, and prompt template within a workspace. ' +
    'Case-insensitive substring match. Returns up to `limit` results.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      query: z.string().min(1).describe('Search query'),
      board_id: z.string().optional().describe('Optional board scope ("", uuid, or omit)'),
      limit: z.number().optional().default(20),
    },
    async ({ workspace_id, query, board_id, limit }) => {
      const repo = dataSource.getRepository(Action);
      const qb = repo.createQueryBuilder('a').where('a.workspace_id = :ws', { ws: workspace_id });
      if (board_id !== undefined) {
        if (board_id) qb.andWhere('a.board_id = :bid', { bid: board_id });
        else qb.andWhere('a.board_id IS NULL');
      }
      const pattern = `%${query.toLowerCase()}%`;
      qb.andWhere('(LOWER(a.name) LIKE :q OR LOWER(a.description) LIKE :q OR LOWER(a.prompt) LIKE :q)', { q: pattern });
      qb.orderBy('a.name', 'ASC').limit(Math.min(limit ?? 20, 100));
      const rows = await qb.getMany();
      return ok(rows.map(actionToJson));
    },
  );
}
