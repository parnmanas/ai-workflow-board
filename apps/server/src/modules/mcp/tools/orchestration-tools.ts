/**
 * Orchestration mode MCP tools.
 *
 * Two audiences share this file because they share one state machine:
 *
 *   ORCHESTRATOR (the agent named on the team)
 *     get_orchestration_mission      — read the live plan, results and timeline
 *     submit_orchestration_plan      — author / revise the step DAG (템플릿으로도 만들 수 있다)
 *     patch_orchestration_graph      — 실행 중인 미션의 그래프를 부분 수정 (ticket 2fc8f99a)
 *     update_orchestration_step      — retry / reassign / amend / skip a step
 *     add_orchestration_note         — leave a reasoning note on the timeline
 *     complete_orchestration_mission — the ONLY clean way a mission ends
 *
 *   MEMBER (the agent a step is assigned to)
 *     get_orchestration_step          — re-read the work order + dependency results
 *     list_my_orchestration_steps     — recover assignments after a lost session
 *     report_orchestration_progress   — heartbeat; resets the step timeout clock
 *     report_orchestration_step       — terminal result; unblocks dependents
 *
 *   DISCOVERY (orchestrator or member — read-only)
 *     list_orchestration_teams        — teams you belong to (rosters stay human-authored in the AWB UI)
 *     list_orchestration_missions     — missions you're on; recovers a mission_id a lost session forgot
 *     list_orchestration_graph_templates — 내장 실행 그래프 템플릿 카탈로그 (읽기 전용)
 *
 *   SELF-SERVICE CREATION (ticket b7127aae)
 *     create_orchestration_mission    — start a mission for a team you already orchestrate
 *
 * Team rosters (who may orchestrate whom) stay human-authored in the AWB UI —
 * there is no MCP tool for that and there will not be one; "Team = a human
 * grants an agent authority over a roster, Mission = that agent exercising it"
 * is the boundary this file enforces. create_orchestration_mission only lets
 * the team's own orchestrator_agent_id start work for a team a human already
 * built; it takes no orchestrator_agent_id / members / team_name input.
 *
 * Authorization is per-mission, not per-scope: the runner checks the calling
 * agent id against `mission.orchestrator_agent_id` / `step.assignee_agent_id`
 * on every mutating call. That is stricter than an API-key scope check would
 * be — a full-scope key still cannot report on another agent's step — and it is
 * the property that makes the delegation model trustworthy. The three tools
 * added by ticket b7127aae are NOT in KNOWN_EXISTING_TOOLS (a frozen snapshot
 * of the tools that existed when tool-authz-gate.ts was written — not a home
 * for new registrations); they get an explicit 'caller' tier in
 * TOOL_AUTHZ_TABLE instead, which is the exact same floor for the exact same
 * reason: the real authorization is this file's own identity/ownership check,
 * so the central gate only needs to reject a sessionless/unresolvable caller.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { isInFlight } from '../../orchestration/orchestration.constants';
import {
  GRAPH_TEMPLATE_NAMES,
  listGraphTemplates,
} from '../../orchestration/orchestration-graph-templates';
import type { ToolContext } from './context';

const NO_RUNTIME =
  'Orchestration is only available on the AWB server runtime (the dispatch engine posts work orders into ' +
  'chat rooms and wakes agents over SSE). This MCP session is running in standalone mode where neither exists.';

// Ceilings for the agent-created mission path (create_orchestration_mission,
// ticket b7127aae) — deliberately tighter than the human/REST path's
// MAX_STEPS_CEILING=200 / MAX_PARALLEL_CEILING=12 (orchestration.constants.ts),
// which stay human-path-only. An explicit arg from the caller is clamped down
// to these, not just defaulted — a self-service creation path should not be
// able to ask for the same fan-out a human operator can.
const AGENT_MAX_STEPS_CEILING = 20;
const AGENT_MAX_PARALLEL_STEPS_CEILING = 4;

function callerAgentId(extra: { sessionId?: string }): string {
  return getCallerAgent(extra)?.agentId || '';
}

function toolError(e: any, fallback: string) {
  return err(e?.message || fallback, e?.status ? { status: e.status } : undefined);
}

/** Mirrors orchestration-mission.service.ts's private clampInt — kept local rather than exported cross-file for one small utility. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.min(max, Math.max(min, fallback));
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function registerOrchestrationTools(server: McpServer, ctx: ToolContext): void {
  const runner = () => ctx.orchestrationRunnerService;
  const missions = () => ctx.orchestrationMissionService;
  const teams = () => ctx.orchestrationTeamService;

  // ── Orchestrator ──────────────────────────────────────────────────────────

  server.tool(
    'get_orchestration_mission',
    'Read the live state of an orchestration mission you orchestrate: objective, current plan with every ' +
      'step and its dependencies, each finished step\'s result, which steps can be dispatched right now, and ' +
      'the recent timeline. Call this FIRST when briefed and again on every wake-up before deciding anything.',
    {
      mission_id: z.string().describe('Mission id from your brief'),
    },
    async ({ mission_id }, extra) => {
      const svc = missions();
      if (!svc) return err(NO_RUNTIME);
      const agentId = callerAgentId(extra);
      try {
        const mission = await svc.requireMission(mission_id);
        // A member may also read the mission it is working inside — it needs the
        // objective for context — but only the orchestrator gets the plan.
        if (mission.orchestrator_agent_id !== agentId) {
          const steps = await svc.listSteps(mission.id);
          if (!steps.some((s) => s.assignee_agent_id === agentId)) {
            return err('you are neither the orchestrator nor an assignee of this mission');
          }
          return ok({
            mission_id: mission.id,
            title: mission.title,
            status: mission.status,
            objective: mission.objective,
            context: mission.context,
            method: mission.method,
            acceptance_criteria: mission.acceptance_criteria,
            note: 'You are a member of this mission, not its orchestrator — the plan is not shown. Use ' +
              'get_orchestration_step for your own assignment.',
          });
        }
        return ok(await svc.getMissionForOrchestrator(mission_id));
      } catch (e: any) {
        return toolError(e, 'failed to read mission');
      }
    },
  );

  server.tool(
    'submit_orchestration_plan',
    'Submit (or revise) the plan for a mission you orchestrate. Each step names an assignee from your team ' +
      'and lists the step_keys it depends on; steps with no shared dependency run in PARALLEL. The server ' +
      'immediately dispatches every step whose dependencies are already satisfied — you do not dispatch them ' +
      'yourself. Revising is additive: a step_key that already exists is updated only if it has not started, ' +
      'and steps you omit are kept (use update_orchestration_step to drop one). On a graph-mode mission the ' +
      'execution graph is additive the same way — omitting "graph" KEEPS the graph already in force (branches, ' +
      'loops and applied graph patches included) and folds new steps in as isolated nodes; pass ' +
      '"reset_graph": true to deliberately go back to a plain depends_on graph.',
    {
      mission_id: z.string().describe('Mission id from your brief'),
      summary: z
        .string()
        .optional()
        .describe('One paragraph explaining the shape of the plan and why you split it this way'),
      steps: z
        .array(
          z.object({
            step_key: z
              .string()
              .describe('Short unique slug for this step, e.g. "api-schema" — lowercase, referenced by depends_on'),
            title: z.string().describe('Short human-readable title'),
            instructions: z
              .string()
              .describe(
                'The full work order for the assignee. They never see the mission brief, so include paths, ' +
                  'commands and constraints they need.',
              ),
            acceptance_criteria: z.string().optional().describe('How the assignee knows this step is done'),
            depends_on: z
              .array(z.string())
              .optional()
              .describe('step_keys that must finish before this one can start. Omit for steps that can start now.'),
            assignee_agent_id: z
              .string()
              .optional()
              .describe('agent_id of the team member who executes this step (from the roster in your brief)'),
          }),
        )
        .describe('The plan. Order does not matter — dependencies determine execution order.'),
      graph: z
        .object({
          nodes: z
            .array(
              z.object({
                key: z.string().describe('step_key this node controls'),
                kind: z
                  .enum(['task', 'evaluator', 'router'])
                  .optional()
                  .describe(
                    'task (default) = ordinary work. evaluator = judges upstream work and reports a verdict. ' +
                      'router = only picks a branch; every edge out of it must be conditional.',
                  ),
                join: z
                  .enum(['all', 'any'])
                  .optional()
                  .describe(
                    'How incoming edges combine. all (default) = every one must be satisfied (fan-in). ' +
                      'any = one is enough — use this where conditional branches merge, or the node waits forever.',
                  ),
                max_visits: z
                  .number()
                  .optional()
                  .describe('How many times this node may run (default 1). A loop_back target needs >= 2.'),
              }),
            )
            .optional()
            .describe('Per-node execution contract. Steps you omit default to task/all/1.'),
          edges: z
            .array(
              z.object({
                from: z.string(),
                to: z.string(),
                kind: z
                  .enum(['sequence', 'conditional', 'loop_back'])
                  .optional()
                  .describe(
                    'sequence (default) = plain dependency, same as depends_on. conditional = taken only when ' +
                      '"when" matches. loop_back = send work back upstream for another pass; the ONLY edge kind ' +
                      'allowed to close a cycle.',
                  ),
                when: z
                  .object({
                    status: z.array(z.string()).optional().describe('Take this edge when "from" ends in one of these statuses'),
                    verdict: z.array(z.string()).optional().describe('Take this edge when "from" reports one of these verdicts'),
                  })
                  .optional()
                  .describe('Required for conditional and loop_back edges. Both lists given = both must match.'),
                label: z.string().optional().describe('Human label shown on the edge, e.g. "needs revision"'),
              }),
            )
            .optional()
            .describe('Forward edges (from → to means "to" runs after "from"). Omit to derive them from depends_on.'),
          max_total_visits: z
            .number()
            .optional()
            .describe(
              'Hard cap on total node runs for the whole mission. REQUIRED when the graph has any loop_back edge — ' +
                'it is the budget that guarantees the mission terminates.',
            ),
        })
        .optional()
        .describe(
          'Optional execution graph: conditional branches, join policies and bounded loops. Only accepted on a ' +
            'mission with graph mode enabled. Omitting it on the FIRST plan runs a plain dependency DAG exactly ' +
            'as before; omitting it on a REPLAN keeps the graph already in force rather than flattening it.',
        ),
      graph_template: z
        .object({
          name: z
            .enum(GRAPH_TEMPLATE_NAMES as [string, ...string[]])
            .describe('Template name from list_orchestration_graph_templates'),
          params: z
            .record(z.string(), z.any())
            .optional()
            .describe('Template parameters — call list_orchestration_graph_templates for each template\'s shape'),
        })
        .optional()
        .describe(
          'Build the execution graph from a named shape (linear chain, bounded review loop, fan-out with an ' +
            'aggregator) instead of writing nodes and edges by hand. Expands into an ordinary graph validated ' +
            'by the same rules. Mutually exclusive with "graph".',
        ),
      reset_graph: z
        .boolean()
        .optional()
        .describe(
          'Throw away the current execution graph and re-derive a plain one from depends_on. Only needed to ' +
            'ABANDON branches/loops: by default a replan that omits "graph" KEEPS the graph already in force ' +
            'and folds any new steps in as isolated nodes, so your conditional edges, loops and applied graph ' +
            'patches survive. Mutually exclusive with "graph" and "graph_template".',
        ),
    },
    async ({ mission_id, summary, steps, graph, graph_template, reset_graph }, extra) => {
      const svc = runner();
      if (!svc) return err(NO_RUNTIME);
      try {
        const result = await svc.submitPlan(mission_id, callerAgentId(extra), {
          summary,
          steps,
          graph,
          graph_template,
          reset_graph,
        });
        return ok({
          mission_id,
          plan_version: result.mission.plan_version,
          status: result.mission.status,
          created_steps: result.created,
          updated_steps: result.updated,
          dispatched_now: result.dispatched,
          graph: result.graph
            ? {
                nodes: result.graph.nodes.length,
                edges: result.graph.edges.length,
                entry: result.graph.entry,
                terminal: result.graph.terminal,
                loops: result.graph.edges.filter((e) => e.kind === 'loop_back').length,
                max_total_visits: result.graph.max_total_visits,
              }
            : null,
          note:
            result.dispatched.length > 0
              ? 'Those steps are now in flight. You will be woken in this room when one fails or when the ' +
                'wave finishes — wait for that rather than polling.'
              : 'Nothing was dispatchable yet. If that is unexpected, check that every step has an ' +
                'assignee_agent_id and that its dependencies can actually be satisfied.',
        });
      } catch (e: any) {
        return toolError(e, 'failed to submit plan');
      }
    },
  );

  server.tool(
    'patch_orchestration_graph',
    'Change part of the execution graph of a running mission you orchestrate, without resubmitting the whole ' +
      'plan. Use this to open or close a branch, retarget a dependency, raise a loop\'s iteration cap, or stop ' +
      'a runaway loop by removing its loop_back edge. Only the agent named as that mission\'s orchestrator may ' +
      'call it, and only on a mission with graph mode enabled. A patch changes the GRAPH ONLY — it never adds, ' +
      'removes or rewrites steps (use submit_orchestration_plan for that), so it does not consume a plan ' +
      'version. The patched graph is re-validated in full, so every rule still applies (no accidental cycles, ' +
      'loops still need a termination condition and a finite cap). Two changes are refused because they would ' +
      'rewrite history: lowering a node\'s max_visits below the number of times it has ALREADY run, and ' +
      'lowering max_total_visits below the budget already spent — lower either to exactly the amount already ' +
      'used to stop further runs instead. Note that a step already marked blocked stays blocked: fixing the ' +
      'edge does not revive it, call update_orchestration_step action:"retry" for that.',
    {
      mission_id: z.string().describe('Mission id from get_orchestration_mission'),
      set_nodes: z
        .array(
          z.object({
            key: z.string().describe('step_key of an EXISTING graph node'),
            kind: z.enum(['task', 'evaluator', 'router']).optional(),
            join: z.enum(['all', 'any']).optional(),
            max_visits: z.number().optional().describe('New iteration cap. Cannot go below what the node already used.'),
          }),
        )
        .optional()
        .describe('Change attributes of nodes that already exist. Cannot create or delete nodes.'),
      add_edges: z
        .array(
          z.object({
            from: z.string(),
            to: z.string(),
            kind: z.enum(['sequence', 'conditional', 'loop_back']).optional(),
            when: z
              .object({
                status: z.array(z.string()).optional(),
                verdict: z.array(z.string()).optional(),
              })
              .optional()
              .describe('Required for conditional and loop_back edges'),
            label: z.string().optional(),
          }),
        )
        .optional()
        .describe('Edges to add. Same rules as in submit_orchestration_plan.'),
      remove_edges: z
        .array(
          z.object({
            from: z.string(),
            to: z.string(),
            kind: z
              .enum(['sequence', 'conditional', 'loop_back'])
              .optional()
              .describe('Omit to remove every edge between those two nodes'),
          }),
        )
        .optional()
        .describe('Edges to remove. Removing an edge that does not exist is an error, not a no-op.'),
      max_total_visits: z
        .number()
        .optional()
        .describe('New mission-wide execution budget. Cannot go below what has already been spent.'),
    },
    async ({ mission_id, ...patch }, extra) => {
      const svc = runner();
      if (!svc) return err(NO_RUNTIME);
      try {
        const result = await svc.patchGraph(mission_id, callerAgentId(extra), patch);
        const inert = result.changes.filter((c) => c.inert_reason);
        return ok({
          mission_id,
          graph_revision: result.mission.graph_revision,
          changes: result.changes,
          graph: {
            nodes: result.graph.nodes.length,
            edges: result.graph.edges.length,
            entry: result.graph.entry,
            terminal: result.graph.terminal,
            loops: result.graph.edges.filter((e) => e.kind === 'loop_back').length,
            max_total_visits: result.graph.max_total_visits,
          },
          dispatched_now: result.dispatched,
          note:
            inert.length > 0
              ? `Applied, but ${inert.length} change(s) do not affect the current pass — see inert_reason on ` +
                'each. They take effect only if those nodes are re-entered by a loop.'
              : 'Applied. Steps that were already blocked stay blocked — retry them explicitly if the patch ' +
                'was meant to revive them.',
        });
      } catch (e: any) {
        return toolError(e, 'failed to patch graph');
      }
    },
  );

  server.tool(
    'list_orchestration_graph_templates',
    'List the built-in execution-graph templates you can pass to submit_orchestration_plan as ' +
      '"graph_template", instead of hand-writing nodes and edges. Read-only and takes no arguments — it ' +
      'describes shapes, it does not touch any mission. Each entry gives the template name, when to reach for ' +
      'it, its parameters and a worked example. A template expands into an ordinary graph and is validated by ' +
      'exactly the same rules, so it is a shortcut for getting a correct shape (especially a review loop, ' +
      'where the loop_back edge, its termination verdict, the node iteration cap and the mission budget all ' +
      'have to line up), never an exemption from them.',
    {},
    async () => {
      try {
        return ok({
          templates: listGraphTemplates(),
          usage:
            'submit_orchestration_plan(mission_id, steps, graph_template: { name, params }). The template ' +
            'only wires up step_keys that already exist in your plan — submit the steps first. Give either ' +
            '"graph" or "graph_template", never both.',
        });
      } catch (e: any) {
        return toolError(e, 'failed to list graph templates');
      }
    },
  );

  server.tool(
    'update_orchestration_step',
    'Change one step of a mission you orchestrate. Use "retry" to run a failed step again (optionally with ' +
      'new instructions or a different assignee), "reassign" to move it to another member, "amend" to rewrite ' +
      'its instructions before it starts, "skip" to drop it from the plan (dependents proceed), or "cancel" ' +
      'to kill it (dependents become blocked). A step that is currently in flight cannot be changed — wait ' +
      'for its report.',
    {
      step_id: z.string().describe('Step id from get_orchestration_mission'),
      action: z.enum(['retry', 'reassign', 'amend', 'skip', 'cancel']),
      assignee_agent_id: z.string().optional().describe('Required for "reassign"; optional for "retry"'),
      instructions: z.string().optional().describe('Replacement work order for "amend" / "retry"'),
      acceptance_criteria: z.string().optional(),
      reason: z.string().optional().describe('Why — recorded on the mission timeline'),
    },
    async (args, extra) => {
      const svc = runner();
      if (!svc) return err(NO_RUNTIME);
      try {
        const { step, dispatched } = await svc.updateStep(args.step_id, callerAgentId(extra), args as any);
        return ok({
          step_id: step.id,
          step_key: step.step_key,
          status: step.status,
          attempt: step.attempt,
          max_attempts: step.max_attempts,
          dispatched_now: dispatched,
        });
      } catch (e: any) {
        return toolError(e, 'failed to update step');
      }
    },
  );

  server.tool(
    'add_orchestration_note',
    'Record a note on the mission timeline — your reasoning for a decision, a risk you are tracking, or ' +
      'context a human operator should see. Notes are visible in the AWB mission view and do not change ' +
      'mission state.',
    {
      mission_id: z.string(),
      message: z.string().describe('The note. Keep it to a few sentences.'),
    },
    async ({ mission_id, message }, extra) => {
      const svc = missions();
      if (!svc) return err(NO_RUNTIME);
      const agentId = callerAgentId(extra);
      try {
        const mission = await svc.requireMission(mission_id);
        if (mission.orchestrator_agent_id !== agentId) {
          const steps = await svc.listSteps(mission.id);
          if (!steps.some((s) => s.assignee_agent_id === agentId)) {
            return err('you are neither the orchestrator nor an assignee of this mission');
          }
        }
        await svc.recordEvent(mission, {
          type: 'note',
          message: String(message || '').slice(0, 2000),
          actor_type: 'agent',
          actor_id: agentId,
          actor_name: getCallerAgent(extra)?.agentName || '',
        });
        return ok({ mission_id, recorded: true });
      } catch (e: any) {
        return toolError(e, 'failed to add note');
      }
    },
  );

  server.tool(
    'update_orchestration_criteria',
    'Flip one or more structured completion criteria met/unmet for a mission you orchestrate (only present when ' +
      'the mission defines them — get_orchestration_mission shows the current list). ' +
      'complete_orchestration_mission(status:"completed") is REJECTED while any criterion is unmet, so mark one ' +
      'only after you have actually verified it — do not take a member\'s report at face value. Include a note ' +
      'explaining how you verified it; it is recorded on the mission timeline.',
    {
      mission_id: z.string(),
      updates: z
        .array(
          z.object({
            key: z.string().describe('Criterion key, from get_orchestration_mission'),
            met: z.boolean(),
            note: z.string().optional().describe('How you verified it (or why you are reverting it to unmet)'),
          }),
        )
        .min(1),
    },
    async ({ mission_id, updates }, extra) => {
      const svc = runner();
      if (!svc) return err(NO_RUNTIME);
      try {
        const mission = await svc.updateCriteria(mission_id, callerAgentId(extra), updates);
        return ok({
          mission_id: mission.id,
          completion_criteria: mission.completion_criteria ?? [],
        });
      } catch (e: any) {
        return toolError(e, 'failed to update completion criteria');
      }
    },
  );

  server.tool(
    'complete_orchestration_mission',
    'End a mission you orchestrate. Use status "completed" once the acceptance criteria are actually met ' +
      '(verify them — do not take a member\'s word for it), or "failed" when the objective cannot be ' +
      'delivered. THE MISSION NEVER ENDS ON ITS OWN: until you call this, it stays open and the board shows ' +
      'it as in progress. Completing requires no step to be in flight, and — when the mission defines ' +
      'structured completion criteria — every one of them marked met via update_orchestration_criteria first; ' +
      'a rejection names which keys are still unmet. Any post-completion Actions the mission defines are ' +
      'dispatched right after this call settles, regardless of which status you pass.',
    {
      mission_id: z.string(),
      status: z.enum(['completed', 'failed']),
      summary: z
        .string()
        .describe('What was delivered (or why it could not be). This is the mission\'s final report.'),
    },
    async ({ mission_id, status, summary }, extra) => {
      const svc = runner();
      if (!svc) return err(NO_RUNTIME);
      try {
        const mission = await svc.completeMission(mission_id, callerAgentId(extra), { status, summary });
        return ok({ mission_id: mission.id, status: mission.status, finished_at: mission.finished_at });
      } catch (e: any) {
        return toolError(e, 'failed to complete mission');
      }
    },
  );

  // ── Member ────────────────────────────────────────────────────────────────

  server.tool(
    'get_orchestration_step',
    'Re-read a step assigned to you: the work order, the mission objective it serves, and the reported ' +
      'results of every step yours depends on. Use it if you lost the original work order or need the ' +
      'upstream results again.',
    {
      step_id: z.string(),
    },
    async ({ step_id }, extra) => {
      const svc = missions();
      if (!svc) return err(NO_RUNTIME);
      const agentId = callerAgentId(extra);
      try {
        const step = await svc.requireStep(step_id);
        const mission = await svc.requireMission(step.mission_id);
        if (step.assignee_agent_id !== agentId && mission.orchestrator_agent_id !== agentId) {
          return err('this step is assigned to another agent');
        }
        const all = await svc.listSteps(mission.id);
        const depKeys = Array.isArray(step.depends_on) ? step.depends_on : [];
        return ok({
          step_id: step.id,
          step_key: step.step_key,
          title: step.title,
          status: step.status,
          instructions: step.instructions,
          acceptance_criteria: step.acceptance_criteria,
          attempt: step.attempt,
          max_attempts: step.max_attempts,
          mission: {
            mission_id: mission.id,
            title: mission.title,
            objective: mission.objective,
            context: mission.context,
            acceptance_criteria: mission.acceptance_criteria,
          },
          dependencies: all
            .filter((s) => depKeys.includes(s.step_key))
            .map((s) => ({
              step_key: s.step_key,
              title: s.title,
              status: s.status,
              result_summary: s.result_summary,
              artifacts: Array.isArray(s.artifacts) ? s.artifacts : [],
            })),
          reporting:
            'When finished, call report_orchestration_step with this step_id. Nothing downstream of you can ' +
            'start until you do.',
        });
      } catch (e: any) {
        return toolError(e, 'failed to read step');
      }
    },
  );

  server.tool(
    'list_my_orchestration_steps',
    'List orchestration steps currently assigned to you that have not been reported yet. Use this to recover ' +
      'after a lost session, or to confirm you have no outstanding delegated work.',
    {},
    async (_args, extra) => {
      const svc = missions();
      if (!svc) return err(NO_RUNTIME);
      const agentId = callerAgentId(extra);
      if (!agentId) return err('this tool requires an authenticated agent session');
      try {
        return ok({ open_steps: await svc.listOpenStepsForAgent(agentId) });
      } catch (e: any) {
        return toolError(e, 'failed to list steps');
      }
    },
  );

  server.tool(
    'report_orchestration_progress',
    'Heartbeat for a long-running step assigned to you. Records a progress line on the mission timeline and ' +
      'resets the step\'s inactivity timeout so it is not reaped as dead. Does NOT end the step.',
    {
      step_id: z.string(),
      message: z.string().describe('What you are doing right now, in one line'),
    },
    async ({ step_id, message }, extra) => {
      const svc = runner();
      if (!svc) return err(NO_RUNTIME);
      try {
        const step = await svc.reportProgress(step_id, callerAgentId(extra), message);
        return ok({ step_id: step.id, status: step.status });
      } catch (e: any) {
        return toolError(e, 'failed to report progress');
      }
    },
  );

  server.tool(
    'report_orchestration_step',
    'Report the FINAL result of a step assigned to you. This is what unblocks every step that depends on ' +
      'yours and what tells the orchestrator to act — a step with no report stalls the whole mission until a ' +
      'timeout reaps it. Report "done" only for work you actually verified; use "failed" if you tried and ' +
      'could not, and "blocked" if something outside your control stops you.',
    {
      step_id: z.string(),
      status: z.enum(['done', 'failed', 'blocked']),
      summary: z
        .string()
        .describe(
          'What you did and anything the next agent must know. Downstream steps receive this text verbatim ' +
            'as their context, so write it for them.',
        ),
      artifacts: z
        .array(
          z.object({
            kind: z.string().describe('e.g. "pr", "branch", "ticket", "file", "url"'),
            ref: z.string().describe('The url / id / path'),
            label: z.string().optional().describe('Short human label'),
          }),
        )
        .optional()
        .describe('Concrete outputs of this step, surfaced in the mission view and to dependent steps'),
      verdict: z
        .string()
        .optional()
        .describe(
          'Required only when your work order asked for one (evaluator / router steps). The mission branches on ' +
            'this value — it selects which downstream step runs, or sends the work back for another pass. Use ' +
            'exactly one of the values your work order listed.',
        ),
      visit: z
        .number()
        .optional()
        .describe(
          'REQUIRED whenever your work order stated one (every step of a graph mission does). Copy that number ' +
            'verbatim. It identifies which pass of this step you are reporting — omitting it, or sending a stale ' +
            'number, is refused rather than allowed to overwrite a newer pass. Only plain dependency missions, ' +
            'whose work orders carry no visit number, may leave it out.',
        ),
    },
    async ({ step_id, status, summary, artifacts, verdict, visit }, extra) => {
      const svc = runner();
      if (!svc) return err(NO_RUNTIME);
      try {
        const result = await svc.reportStep(step_id, callerAgentId(extra), {
          status,
          summary,
          artifacts: artifacts as any,
          verdict,
          visit,
        });
        return ok({
          step_id: result.step.id,
          step_key: result.step.step_key,
          status: result.reported_status,
          verdict: result.step.verdict || null,
          next_steps_dispatched: result.dispatched,
          orchestrator_notified: result.orchestrator_woken,
          loop_reentered: result.loop_reentered,
          note:
            result.loop_reentered.length > 0
              ? 'Recorded. Your verdict sent this branch back for another pass — the affected steps were reset ' +
                'and will be re-dispatched with fresh work orders. Do not act on that yourself.'
              : 'Your part is done. Do not keep working on this step — the orchestrator owns what happens next.',
        });
      } catch (e: any) {
        return toolError(e, 'failed to report step');
      }
    },
  );

  // ── Discovery ─────────────────────────────────────────────────────────────

  server.tool(
    'list_orchestration_teams',
    'Teams and their rosters are authored by humans in the AWB UI — this tool only reads them. List the ' +
      'orchestration teams you belong to, as orchestrator or member. Use it to find the team_id you need for ' +
      'create_orchestration_mission, or to see who your teammates are.',
    {},
    async (_args, extra) => {
      const svc = teams();
      if (!svc) return err(NO_RUNTIME);
      const agentId = callerAgentId(extra);
      if (!agentId) return err('this tool requires an authenticated agent session');
      try {
        return ok({ teams: await svc.listTeamsForAgent(agentId) });
      } catch (e: any) {
        return toolError(e, 'failed to list teams');
      }
    },
  );

  server.tool(
    'list_orchestration_missions',
    'Teams and their rosters are authored by humans in the AWB UI; this tool only reads missions. List ' +
      'orchestration missions where you are the orchestrator or a team member — the way to recover a ' +
      'mission_id if your session lost the brief (e.g. it is still "planning" with no steps yet for ' +
      'list_my_orchestration_steps to find). Returns non-terminal missions by default.',
    {
      include_finished: z
        .boolean()
        .optional()
        .describe('Include completed/failed/cancelled missions too (default: only active ones)'),
      limit: z.number().optional().describe('Max results, 1-500 (default 100)'),
    },
    async ({ include_finished, limit }, extra) => {
      const svc = missions();
      if (!svc) return err(NO_RUNTIME);
      const agentId = callerAgentId(extra);
      if (!agentId) return err('this tool requires an authenticated agent session');
      try {
        const list = await svc.listMissionsForAgent(agentId, {
          status: include_finished ? 'all' : 'active',
          limit,
        });
        return ok({ missions: list });
      } catch (e: any) {
        return toolError(e, 'failed to list missions');
      }
    },
  );

  // ── Self-service creation ────────────────────────────────────────────────

  server.tool(
    'create_orchestration_mission',
    'Teams and their rosters are authored by humans in the AWB UI — this tool cannot create or join a team. ' +
      'It creates a mission for a team you already orchestrate: only the agent named as that team\'s ' +
      'orchestrator may call this for its team_id (use list_orchestration_teams to find it). This is exercising ' +
      'authority a human already granted when they built the team, not a new autonomy surface — team/roster ' +
      'membership is still entirely human-controlled. Your team allows one open (non-terminal) mission per ' +
      'workspace at a time; a second attempt for the SAME workspace is rejected with a 409 naming the existing ' +
      'mission_id, its status and how many of its steps are still in flight — if that count is 0 while status ' +
      'is "running", every step already finished and you just need to call complete_orchestration_mission on ' +
      'it before retrying; if status is "draft" (pass start:false, or the initial briefing failed) it was ' +
      'never briefed, so close it with complete_orchestration_mission(status:"failed") instead — there is no ' +
      'tool to brief an existing draft. If your team is workspace-scoped, workspace_id may be omitted (it ' +
      'defaults to the team\'s own workspace — this is the common case and behaves exactly as before). If your ' +
      'team is GLOBAL (no workspace of its own), workspace_id is REQUIRED — it picks which workspace\'s ' +
      'run-budget and mission room this mission is billed to, out of the workspaces a human has already put on ' +
      'the team\'s allow-list; call list_workspaces to see what exists, but only a listed one will be accepted. ' +
      'On success the returned mission_id works immediately with submit_orchestration_plan.',
    {
      team_id: z.string().describe('Team id from list_orchestration_teams — you must be its orchestrator'),
      title: z.string().describe('Short mission title'),
      objective: z.string().describe('What the team must achieve. Becomes the core of your own brief.'),
      context: z.string().optional().describe('Background / links / prior art'),
      acceptance_criteria: z.string().optional().describe('Definition of done (free text)'),
      method: z
        .string()
        .optional()
        .describe('How the team should approach the objective — constraints, non-negotiables, preferred approach'),
      completion_criteria: z
        .array(
          z.object({
            key: z.string().describe('Short unique slug, e.g. "tests-pass"'),
            description: z.string(),
            met: z.boolean().optional().describe('Default false — flip later with update_orchestration_criteria'),
          }),
        )
        .optional()
        .describe(
          'Optional structured checklist ON TOP OF acceptance_criteria prose — when set, ' +
            'complete_orchestration_mission(status:"completed") is blocked until every entry is met:true.',
        ),
      post_actions: z
        .array(
          z.object({
            action_id: z.string().describe('Action id to dispatch once the mission ends'),
            order: z.number().optional().describe('Ascending dispatch order (default: array order)'),
            condition: z
              .enum(['always', 'on_success', 'on_failure'])
              .optional()
              .describe('always | on_success (completed only) | on_failure (failed only). Default "always".'),
          }),
        )
        .optional()
        .describe(
          'Actions to dispatch after the mission ends (fire-and-forget — failure to dispatch is recorded but ' +
            'never reopens or changes the mission).',
        ),
      workspace_folder: z
        .string()
        .optional()
        .describe('working_dir-relative root for every step\'s isolated working folder (default: `.awb/orch/<mission id8>`)'),
      repo_ref: z
        .object({
          resource_id: z.string().optional(),
          url: z.string().optional(),
          branch: z.string().optional(),
        })
        .optional()
        .describe('Repo every step checks out. Omit to reuse the board/workspace environment_config repo.'),
      checkout_mode: z
        .enum(['reuse', 'fresh'])
        .optional()
        .describe('How each step\'s folder is prepared (default "reuse"; "fresh" wipes + re-checks-out every dispatch)'),
      workspace_id: z
        .string()
        .optional()
        .describe(
          'Required for a GLOBAL team (must be on its allowed-workspaces list); omit for a workspace-scoped ' +
            'team, which always uses its own workspace regardless of this field.',
        ),
      max_steps: z
        .number()
        .optional()
        .describe(`Hard ceiling on total steps across all plan versions (default and max ${AGENT_MAX_STEPS_CEILING})`),
      max_parallel_steps: z
        .number()
        .optional()
        .describe('Ceiling on steps dispatched concurrently (default and max: min(team setting, 4))'),
      step_timeout_minutes: z
        .number()
        .optional()
        .describe('Minutes a step may run before the reaper fails it (default 90, 0 = no timeout)'),
      start: z
        .boolean()
        .optional()
        .describe('Brief yourself immediately after creating (default true — pass false to leave it a draft)'),
    },
    async (args, extra) => {
      const teamSvc = teams();
      const missionSvc = missions();
      const runnerSvc = runner();
      if (!teamSvc || !missionSvc || !runnerSvc) return err(NO_RUNTIME);
      const agentId = callerAgentId(extra);
      if (!agentId) return err('this tool requires an authenticated agent session');

      try {
        const team = await teamSvc.requireTeamById(args.team_id);
        if (!team.orchestrator_agent_id || team.orchestrator_agent_id !== agentId) {
          return err(
            'you are not the orchestrator of this team — only the agent named as team.orchestrator_agent_id ' +
              'may create a mission for it. Use list_orchestration_teams to see teams you actually belong to.',
            { status: 403 },
          );
        }
        if (team.enabled === 0) {
          return err(`team "${team.name}" is disabled`, { status: 409 });
        }

        // 이 미션이 어느 workspace에 과금될지 해석한다(티켓 1b62b437, 설계 결정 —
        // 티켓의 "설계 결정 필요" #3 참고). workspace 종속 팀은 항상 자기 workspace를
        // 쓴다: workspace_id는 no-op 확인용으로만 받아들여지고 어긋나면 거절된다 —
        // 그래야 호출자가 workspace 종속 팀의 미션을 한 번도 허가받은 적 없는 budget으로
        // 조용히 리디렉션할 수 없다. 글로벌 팀은 자기 workspace가 없으므로, 깔끔한
        // 에이전트향 메시지를 위해 여기서 workspace_id 필수 여부만 확인한다 — 허용목록
        // 검사 자체는 여기서 중복하지 않는다; missionSvc.createMission이 유일한 권위
        // 있는 강제 지점이다(human/REST 생성 경로도 함께 지킨다 — 그쪽엔 사전 검사할
        // 호출자 identity 개념이 없다), 그래서 비어있거나 허용되지 않은 workspace_id는
        // 아래 catch를 통해 드러난다.
        let resolvedWorkspaceId: string;
        if (team.workspace_id) {
          if (args.workspace_id && args.workspace_id !== team.workspace_id) {
            return err(
              `workspace_id "${args.workspace_id}" does not match this team's own workspace (${team.workspace_id}) ` +
                `— omit workspace_id to use the team's workspace, or use a global team to target a different one.`,
              { status: 400 },
            );
          }
          resolvedWorkspaceId = team.workspace_id;
        } else {
          const requested = (args.workspace_id || '').trim();
          if (!requested) {
            return err(
              `workspace_id is required to create a mission for global team "${team.name}" — call ` +
                `list_workspaces to see the workspaces available to you, then pass one explicitly.`,
              { status: 400 },
            );
          }
          resolvedWorkspaceId = requested;
        }

        // Guard: an agent already mid-step should not also spin up a new
        // mission — that is the actual self-recursion risk (briefing itself is
        // already structurally impossible: startMission posts the brief exactly
        // once and updateMission locks the brief once status leaves 'draft').
        const openSteps = await missionSvc.listOpenStepsForAgent(agentId);
        if (openSteps.length > 0) {
          return err(
            `you have ${openSteps.length} step(s) still in flight (e.g. "${openSteps[0].step_key}" on mission ` +
              `${openSteps[0].mission_id}) — report those with report_orchestration_step before starting a new mission.`,
          );
        }

        // Guard: one open mission per team on this path, substituting for a
        // budget gate this entity has no board_id/ticket to hang one off of.
        // `?? 1`, not `|| 1` — 0 is a valid operator-set "no agent-created
        // missions for this team" value and must not be silently promoted to 1.
        const cap = team.max_open_missions ?? 1;
        if (cap <= 0) {
          // Must short-circuit before ever listing/indexing openForTeam: at
          // cap 0 that list is legitimately empty, so openForTeam[length - 1]
          // below would read openForTeam[-1] (undefined) and throw a raw
          // TypeError instead of this 409.
          return err(
            `team "${team.name}" does not allow agent-created missions (max_open_missions = 0) — ` +
              `a human operator must raise the limit for this team before it can self-create missions.`,
            { status: 409 },
          );
        }

        // 팀 하나만이 아니라 (팀, workspace) 단위로 스코핑한다(티켓 1b62b437) —
        // workspace 종속 팀은 모든 미션이 이미 resolvedWorkspaceId를 공유하므로 이
        // 필터는 거기서 no-op이다(기존 동작 그대로). 글로벌 팀에서는 workspace A의
        // 열린 미션이 workspace B의 슬롯을 잡아먹는 걸 막아준다 — 팀이 허용된 각
        // workspace마다 독립된 `cap`을 가진다.
        const openMissions = await missionSvc.listMissionsForAgent(agentId, { status: 'active', limit: 500 });
        const openForTeam = openMissions.filter(
          (m) => m.team_id === team.id && m.workspace_id === resolvedWorkspaceId,
        );
        if (openForTeam.length >= cap) {
          // Oldest first (listMissionsForAgent orders created_at DESC) — the
          // oldest open mission is the one most likely stuck; at the default
          // cap of 1 there is only ever one candidate so this is a no-op.
          const existing = openForTeam[openForTeam.length - 1];
          const existingSteps = await missionSvc.listSteps(existing.id);
          const openStepCount = existingSteps.filter((s) => isInFlight(s.status)).length;
          // Two distinct "nothing left to wait for" shapes need distinct advice:
          // a never-started draft has no deliverable (only "failed" makes sense),
          // while a running mission with every step finished likely succeeded
          // (the orchestrator should look at the results and pick "completed" or
          // "failed" itself, not be told which).
          const isDraftWedge = existing.status === 'draft';
          const isRunningWedge = existing.status === 'running' && openStepCount === 0;
          return err(
            `team "${team.name}" already has ${openForTeam.length} open mission(s) (limit ${cap}). ` +
              (isDraftWedge
                ? `Mission ${existing.id} is "draft" and was never briefed — call ` +
                  `complete_orchestration_mission(status:"failed") on it to free the slot, then retry.`
                : isRunningWedge
                  ? `Mission ${existing.id} is "running" with no steps in flight — every step already finished. ` +
                    `Call complete_orchestration_mission on it, then retry.`
                  : `Wait for mission ${existing.id} (status "${existing.status}") to finish, or close it with ` +
                    `complete_orchestration_mission if it can no longer make progress.`),
            { status: 409, existing_mission_id: existing.id, existing_mission_status: existing.status, open_step_count: openStepCount },
          );
        }

        const maxSteps = clampInt(args.max_steps, AGENT_MAX_STEPS_CEILING, 1, AGENT_MAX_STEPS_CEILING);
        const parallelCeiling = Math.max(1, Math.min(team.max_parallel_steps || 1, AGENT_MAX_PARALLEL_STEPS_CEILING));
        const maxParallelSteps = clampInt(args.max_parallel_steps, parallelCeiling, 1, parallelCeiling);

        const mission = await missionSvc.createMission({
          workspace_id: resolvedWorkspaceId,
          team_id: team.id,
          title: args.title,
          objective: args.objective,
          context: args.context,
          acceptance_criteria: args.acceptance_criteria,
          method: args.method,
          completion_criteria: args.completion_criteria,
          post_actions: args.post_actions,
          workspace_folder: args.workspace_folder,
          repo_ref: args.repo_ref,
          checkout_mode: args.checkout_mode,
          max_steps: maxSteps,
          max_parallel_steps: maxParallelSteps,
          step_timeout_minutes: args.step_timeout_minutes,
          created_by_type: 'agent',
          created_by: agentId,
          // Stamp the orchestrator NOW, not only on a successful startMission —
          // already proven above to equal team.orchestrator_agent_id. Without
          // this a mission left `draft` (start:false, or startMission throwing
          // below) has orchestrator_agent_id=null forever and no caller can ever
          // pass requireOrchestrator on it again — not even to close it.
          orchestrator_agent_id: agentId,
        });

        let current = mission;
        let startError: string | undefined;
        if (args.start !== false) {
          try {
            current = await runnerSvc.startMission(mission.id, mission.workspace_id, {
              type: 'agent',
              id: agentId,
              name: getCallerAgent(extra)?.agentName || '',
            });
          } catch (e: any) {
            startError = e?.message || 'failed to start mission';
          }
        }

        return ok({
          mission_id: mission.id,
          status: current.status,
          start_error: startError,
          note: startError
            ? 'Mission was created but briefing failed (see start_error) — you own it (get_orchestration_mission ' +
              'to inspect it). There is no tool to retry starting an existing draft; once the cause is fixed ' +
              '(e.g. the team now has members), close this one with complete_orchestration_mission(status:' +
              '"failed") and call create_orchestration_mission again.'
            : args.start === false
              ? 'Mission created as a draft — you will not be briefed until a human starts it in the AWB UI. ' +
                'You can still get_orchestration_mission to inspect it or complete_orchestration_mission to ' +
                'close it and free your team\'s mission slot.'
              : 'You are now briefed in the mission room. Call submit_orchestration_plan next.',
        });
      } catch (e: any) {
        return toolError(e, 'failed to create mission');
      }
    },
  );
}
