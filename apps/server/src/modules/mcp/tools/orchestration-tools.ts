/**
 * Orchestration mode MCP tools.
 *
 * Two audiences share this file because they share one state machine:
 *
 *   ORCHESTRATOR (the agent named on the team)
 *     get_orchestration_mission      — read the live plan, results and timeline
 *     submit_orchestration_plan      — author / revise the step DAG
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
 * Authorization is per-mission, not per-scope: the runner checks the calling
 * agent id against `mission.orchestrator_agent_id` / `step.assignee_agent_id`
 * on every mutating call. That is stricter than an API-key scope check would
 * be — a full-scope key still cannot report on another agent's step — and it is
 * the property that makes the delegation model trustworthy.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

const NO_RUNTIME =
  'Orchestration is only available on the AWB server runtime (the dispatch engine posts work orders into ' +
  'chat rooms and wakes agents over SSE). This MCP session is running in standalone mode where neither exists.';

function callerAgentId(extra: { sessionId?: string }): string {
  return getCallerAgent(extra)?.agentId || '';
}

function toolError(e: any, fallback: string) {
  return err(e?.message || fallback, e?.status ? { status: e.status } : undefined);
}

export function registerOrchestrationTools(server: McpServer, ctx: ToolContext): void {
  const runner = () => ctx.orchestrationRunnerService;
  const missions = () => ctx.orchestrationMissionService;

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
      'and steps you omit are kept (use update_orchestration_step to drop one).',
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
    },
    async ({ mission_id, summary, steps }, extra) => {
      const svc = runner();
      if (!svc) return err(NO_RUNTIME);
      try {
        const result = await svc.submitPlan(mission_id, callerAgentId(extra), { summary, steps });
        return ok({
          mission_id,
          plan_version: result.mission.plan_version,
          status: result.mission.status,
          created_steps: result.created,
          updated_steps: result.updated,
          dispatched_now: result.dispatched,
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
    'complete_orchestration_mission',
    'End a mission you orchestrate. Use status "completed" once the acceptance criteria are actually met ' +
      '(verify them — do not take a member\'s word for it), or "failed" when the objective cannot be ' +
      'delivered. THE MISSION NEVER ENDS ON ITS OWN: until you call this, it stays open and the board shows ' +
      'it as in progress. Completing requires no step to be in flight.',
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
    },
    async ({ step_id, status, summary, artifacts }, extra) => {
      const svc = runner();
      if (!svc) return err(NO_RUNTIME);
      try {
        const result = await svc.reportStep(step_id, callerAgentId(extra), {
          status,
          summary,
          artifacts: artifacts as any,
        });
        return ok({
          step_id: result.step.id,
          step_key: result.step.step_key,
          status: result.step.status,
          next_steps_dispatched: result.dispatched,
          orchestrator_notified: result.orchestrator_woken,
          note: 'Your part is done. Do not keep working on this step — the orchestrator owns what happens next.',
        });
      } catch (e: any) {
        return toolError(e, 'failed to report step');
      }
    },
  );
}
