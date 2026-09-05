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
import { Agent } from '../../../entities/Agent';
import { resolveAgentDisplayNamesByIds } from '../../../utils/agent-name';
import { actionTargetAgentIds } from '../../../common/action-targets';
import { ok, err, withArtifactRef } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { repoRefSchema, checkoutModeSchema } from '../../../common/workspace-folder-options';
import type { ToolContext } from './context';

function actionToJson(a: Action) {
  return withArtifactRef('action', {
    id: a.id,
    workspace_id: a.workspace_id,
    board_id: a.board_id,
    name: a.name,
    description: a.description,
    prompt: a.prompt,
    // 대표 대상(레거시 미러) + 실제 대상 전체 (티켓 fc3906c5). 기존 키를 그대로
    // 두어 target_agent_id 만 읽던 소비자를 깨지 않는다.
    target_agent_id: a.target_agent_id,
    target_agent_ids: actionTargetAgentIds(a),
    schedule_cron: a.schedule_cron,
    trigger: a.trigger,
    trigger_label: a.trigger_label,
    enabled: a.enabled,
    high_impact: a.high_impact,
    max_runs: a.max_runs,
    last_run_at: a.last_run_at,
    // 작업 폴더 옵션(티켓 9fd27487) — common/workspace-folder-options.ts 참고.
    workspace_folder: a.workspace_folder ?? '',
    repo_ref: a.repo_ref ?? null,
    checkout_mode: a.checkout_mode,
    created_at: a.created_at,
    updated_at: a.updated_at,
  }, a.name);
}

export function registerActionTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, actionsService, triggerLoopService, logger } = ctx;

  server.tool(
    'list_actions',
    'List reusable Actions in a workspace.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
    },
    async ({ workspace_id }) => {
      const repo = dataSource.getRepository(Action);
      const qb = repo.createQueryBuilder('a')
        .where('a.workspace_id = :ws', { ws: workspace_id })
        .andWhere('a.board_id IS NULL');
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
    'terminal column (Done), scoped within the workspace and optionally narrowed by trigger_label ' +
    '(empty = any label). The finished ticket is exposed to the prompt as {{ticket.id}}/{{ticket.title}}/{{ticket.board_id}} etc. ' +
    'enabled=false skips the hook too (manual run_action only). ' +
    'Prompt supports `{{var.path}}` interpolation against {action,run,workspace,board,user,agent,ticket,date,time,datetime}.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      id: z.string().optional().describe('Action ID — omit to create, provide to update'),
      name: z.string().describe('Action name'),
      description: z.string().optional().describe('Short description'),
      prompt: z.string().optional().describe('Prompt template with {{var}} interpolation'),
      target_agent_id: z.string().optional().describe('Single target agent ID. Legacy/compat form — prefer `target_agent_ids`. Required when creating unless `target_agent_ids` is given.'),
      target_agent_ids: z.array(z.string()).optional().describe('Target agent IDs. One trigger fans out to an INDEPENDENT run per agent, each in its own room. Takes precedence over `target_agent_id` when both are given; the first entry is mirrored back into `target_agent_id`. Every id must be an agent in this workspace (or a global agent) — one bad id rejects the whole save.'),
      schedule_cron: z.string().optional().describe('5-field cron (e.g. "0 9 * * 1" for Mon 9am); empty = manual'),
      trigger: z.string().optional().describe("Lifecycle trigger: '' (cron/manual, default) or 'on_ticket_done' (run when a ticket reaches a terminal column)"),
      trigger_label: z.string().optional().describe("For trigger='on_ticket_done': only fire when the finished ticket carries this label. Empty = any label."),
      enabled: z.boolean().optional().describe('When false, scheduler/hook skips this action (manual run still works)'),
      high_impact: z.boolean().optional().describe('Mark deploy/publish/release Actions whose failure may mean a partial external effect. High-impact ticket-driven runs are NOT auto-retried on failure — the failure surfaces to the source ticket for a human decision (bounded retry is not operation idempotency).'),
      max_runs: z.number().optional().describe('FIFO prune budget (default 10)'),
      workspace_folder: z.string().optional().describe('agent-home-relative Run folder under `.awb/act/`. Omit/"" → deterministic default act/<action_id8>. Every Run of this action reuses the same folder (action-keyed, not run-keyed).'),
      repo_ref: repoRefSchema.nullable().optional().describe('Repo to check out into the Run folder. Omit/null → no clone, the provisioner just ensures the folder exists.'),
      checkout_mode: checkoutModeSchema.optional(),
    },
    async ({ workspace_id, id, name, description, prompt, target_agent_id, target_agent_ids, schedule_cron, trigger, trigger_label, enabled, high_impact, max_runs, workspace_folder, repo_ref, checkout_mode }) => {
      if (!actionsService) return err('Actions service unavailable in this MCP context');
      try {
        if (id) {
          const updated = await actionsService.update(id, workspace_id, {
            name,
            description,
            prompt,
            target_agent_id,
            target_agent_ids,
            board_id: null,
            schedule_cron,
            trigger,
            trigger_label,
            enabled,
            high_impact,
            max_runs,
            workspace_folder,
            repo_ref,
            checkout_mode,
          } as any);
          return ok(actionToJson(updated));
        }
        // 둘 중 하나만 있어도 생성된다 — 서비스가 배열을 정본으로 삼고 단일
        // 필드를 그 첫 원소로 흡수한다 (티켓 fc3906c5).
        if (!target_agent_id && !(target_agent_ids && target_agent_ids.length > 0)) {
          return err('target_agent_id (or target_agent_ids) is required when creating an action');
        }
        const created = await actionsService.create({
          workspace_id,
          board_id: null,
          name,
          description: description ?? '',
          prompt: prompt ?? '',
          target_agent_id,
          target_agent_ids,
          schedule_cron: schedule_cron ?? '',
          trigger: trigger ?? '',
          trigger_label: trigger_label ?? '',
          enabled: enabled !== false,
          high_impact: high_impact === true,
          max_runs: typeof max_runs === 'number' ? max_runs : 10,
          workspace_folder,
          repo_ref,
          checkout_mode,
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
    'FAN-OUT: an Action may target SEVERAL agents. One call then creates one INDEPENDENT run ' +
    'per target agent, each in its own room, and they execute in parallel. `run_id`/`room_id` ' +
    'stay pointed at the first run for backward compatibility — read `runs[]` for the per-agent ' +
    'list, `batch_id` for the group, and `failures[]` for targets that could not be dispatched ' +
    '(one agent failing never blocks the others). When a `source_ticket_id` is linked, the ticket ' +
    'is resumed ONCE after EVERY run in the batch has settled, with a per-agent outcome summary. ' +
    'Pass `source_ticket_id` when you run an Action to clear a blocker on a ticket ' +
    'you are working: the run is linked back to that ticket, the target agent is told ' +
    'to report its outcome via `complete_action_run`, and on success the ticket ' +
    'AUTO-RESUMES in place (no Pending, no manual re-dispatch). Omit it for ' +
    'cron/manual/standalone runs that have no ticket to resume. ' +
    'HIGH-IMPACT Actions (deploy/publish/release, or any Action saved high_impact=true) ' +
    'CANNOT be auto-run by an agent for a ticket: the call is rejected and the ticket is ' +
    'parked pending_user_action until a workspace ADMIN approves this exact (action, ticket) ' +
    'pair through the human approval endpoint (POST /api/actions/{id}/approvals) or the Actions UI. ' +
    'You cannot approve your own run — there is no approver parameter here; the server consumes a ' +
    'human-created approval grant. After an admin approves, the ticket auto-resumes and re-running ' +
    'this tool for the same ticket executes the run once.',
    {
      action_id: z.string().describe('Action ID'),
      source_ticket_id: z.string().optional().describe('Ticket that this run should resume on completion. When set, the run carries the linkage and `complete_action_run` re-dispatches this ticket. Omit for runs with no originating ticket.'),
    },
    async ({ action_id, source_ticket_id }, extra: { sessionId?: string }) => {
      if (!actionsService) return err('Actions service unavailable in this MCP context');
      // Triggering identity: an authenticated agent caller (MCP session bound
      // to an agentId) is attributed as 'agent' with that agent's id. Without
      // an authenticated agent the run is attributed to 'system' so the chat
      // history still shows where it came from. NOTE: there is deliberately no
      // approver parameter — high-impact approval is a human-only grant the
      // server consumes (ticket 524bb434, scope 5); an agent cannot assert it.
      const caller = getCallerAgent(extra);
      try {
        const result = await actionsService.dispatch({
          actionId: action_id,
          triggeredByType: caller?.agentId ? 'agent' : 'system',
          triggeredById: caller?.agentId ?? '',
          sourceTicketId: source_ticket_id,
        });
        // 하위 호환 키(run_id/room_id/prompt)는 첫 run 을 계속 가리킨다.
        return ok({
          run_id: result.run.id,
          room_id: result.room_id,
          prompt: result.prompt,
          source_ticket_id: result.run.source_ticket_id || '',
          batch_id: result.batch_id,
          runs: result.runs.map((r) => ({
            run_id: r.run.id,
            agent_id: r.agent_id,
            room_id: r.room_id,
          })),
          failures: result.failures,
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
    'List runs for an action (most recent first), capped at limit. ' +
    'Each row carries `agent_id` + `agent_name` (the `<Manager>/<Agent>` display name) so a ' +
    'fan-out Action\'s runs can be told apart by which host executed them, and `batch_id` ' +
    'grouping the runs that came from one trigger — group by it to see per-batch ' +
    'all-succeeded / partial / all-failed. Runs dispatched before multi-agent support carry ' +
    'an empty agent_id/batch_id (not backfilled: the Action\'s target may have been edited ' +
    'since, so any value would be invented rather than recorded).',
    {
      workspace_id: z.string().describe('Workspace ID (scope boundary)'),
      action_id: z.string().describe('Action ID'),
      limit: z.number().optional().default(20).describe('Max runs to return (default 20, cap 100)'),
    },
    async ({ workspace_id, action_id, limit }) => {
      if (!actionsService) return err('Actions service unavailable in this MCP context');
      try {
        const runs = await actionsService.listRuns(action_id, workspace_id, limit ?? 20);
        // `<Manager>/<Agent>` 표시명은 배치로 한 번에 해석한다
        // (.claude/skills/awb-agent-display-name — bare name 은 계약 위반이다:
        // 같은 leaf 이름이 여러 매니저 아래 존재할 수 있어서, 접두사가 없으면
        // 어느 호스트가 실행했는지 구분할 수 없다).
        const agentNames = await resolveAgentDisplayNamesByIds(
          dataSource.getRepository(Agent),
          runs.map((r: ActionRun) => r.agent_id),
        );
        return ok(runs.map((r: ActionRun) => ({
          id: r.id,
          action_id: r.action_id,
          workspace_id: r.workspace_id,
          agent_id: r.agent_id || '',
          agent_name: agentNames.get(r.agent_id || '') || '',
          batch_id: r.batch_id || '',
          room_id: r.room_id,
          triggered_by_type: r.triggered_by_type,
          triggered_by_id: r.triggered_by_id,
          prompt_rendered: r.prompt_rendered,
          source_ticket_id: r.source_ticket_id || '',
          idempotency_key: r.idempotency_key || '',
          approved_by: r.approved_by || '',
          approved_at: r.approved_at ?? null,
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
      limit: z.number().optional().default(20),
    },
    async ({ workspace_id, query, limit }) => {
      const repo = dataSource.getRepository(Action);
      const qb = repo.createQueryBuilder('a')
        .where('a.workspace_id = :ws', { ws: workspace_id })
        .andWhere('a.board_id IS NULL');
      const pattern = `%${query.toLowerCase()}%`;
      qb.andWhere('(LOWER(a.name) LIKE :q OR LOWER(a.description) LIKE :q OR LOWER(a.prompt) LIKE :q)', { q: pattern });
      qb.orderBy('a.name', 'ASC').limit(Math.min(limit ?? 20, 100));
      const rows = await qb.getMany();
      return ok(rows.map(actionToJson));
    },
  );
}
