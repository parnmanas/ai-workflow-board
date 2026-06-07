/**
 * Benchmark MCP tools (ticket 684c012b).
 *
 * Tools:
 *   - submit_benchmark_score   — evaluator agent records a score for a candidate
 *   - get_benchmark_leaderboard — read run-scoped or agent-aggregate leaderboard
 *   - create_benchmark_run      — fan-out: parent run ticket + N candidate children
 *
 * The auto-discovery loader in `tools/index.ts` picks this file up by the
 * `*-tools.ts` filename convention and calls `registerBenchmarkTools`.
 *
 * Topology (kept consistent with TriggerLoopService._dispatchBenchmarkEvaluators):
 *   - A *run* is a root ticket holding the task definition (prompt + rubric),
 *     labeled `benchmark` + `benchmark-run`. Evaluator agents are recorded on
 *     the run as `evaluator:<agentId>` labels (NOT reviewer role assignments —
 *     TicketRoleAssignment is unique on (ticket, role), so the reviewer slot
 *     can hold only one agent; the score table + evaluator labels sidestep that).
 *   - Each *candidate* is a child of the run, labeled `benchmark-candidate`,
 *     with its own assignee agent and `column_id` set to the board's first
 *     active column so the normal assignee dispatch + worktree isolation apply.
 *     When a candidate lands on a `review`-kind column the dispatch loop wakes
 *     the run's evaluator agents to score it.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerBenchmarkTools(server: McpServer, ctx: ToolContext): void {
  const { benchmarkService } = ctx;

  server.tool(
    'submit_benchmark_score',
    'Record (or update) a benchmark score for one candidate on one dimension. Called by an evaluator agent after reviewing a candidate. Re-scoring the same (candidate, evaluator, dimension) updates the existing row — no duplicates. The run is inferred from the candidate ticket\'s parent unless run_ticket_id is given.',
    {
      candidate_ticket_id: z.string().describe('The candidate (child) ticket being scored'),
      dimension: z.string().describe('Scoring dimension, e.g. "correctness", "quality", "speed"'),
      score: z.number().describe('Numeric score (the run rubric defines the range, e.g. 0..10)'),
      rationale: z.string().optional().default('').describe('Justification for the score (surfaced in the leaderboard breakdown)'),
      evaluator_agent_id: z.string().optional().describe('Evaluator agent id. Auto-filled from the MCP session when omitted; required in standalone mode.'),
      run_ticket_id: z.string().optional().describe('Override the run ticket id (defaults to the candidate\'s parent)'),
    },
    async ({ candidate_ticket_id, dimension, score, rationale, evaluator_agent_id, run_ticket_id }, extra: { sessionId?: string }) => {
      if (!benchmarkService) return err('benchmark scoring requires the integrated server (BenchmarkService not wired)');
      const caller = getCallerAgent(extra);
      const evaluatorId = (evaluator_agent_id || caller?.agentId || '').trim();
      if (!evaluatorId) return err('evaluator_agent_id is required (no MCP session identity to infer it from)');
      try {
        const saved = await benchmarkService.upsertScore({
          candidate_ticket_id,
          evaluator_agent_id: evaluatorId,
          dimension,
          score,
          rationale,
          run_ticket_id,
        });
        return ok(saved);
      } catch (e: any) {
        return err(e?.message || 'Failed to record benchmark score');
      }
    },
  );

  server.tool(
    'get_benchmark_leaderboard',
    'Read the benchmark leaderboard. With run_ticket_id → per-candidate score table for that run (per-dimension + overall averages, evaluator breakdown). Without it → the agent-aggregate leaderboard across runs (optionally scoped to a workspace), ranking each agent by the average score its candidates received.',
    {
      run_ticket_id: z.string().optional().describe('Run ticket id for a run-scoped leaderboard'),
      workspace_id: z.string().optional().describe('Workspace id to scope the agent-aggregate leaderboard (ignored when run_ticket_id is given)'),
    },
    async ({ run_ticket_id, workspace_id }) => {
      if (!benchmarkService) return err('benchmark leaderboard requires the integrated server (BenchmarkService not wired)');
      if (run_ticket_id) {
        return ok(await benchmarkService.getRunLeaderboard(run_ticket_id));
      }
      return ok(await benchmarkService.getAgentLeaderboard(workspace_id));
    },
  );

  server.tool(
    'create_benchmark_run',
    'Fan-out helper: create a benchmark run (parent ticket holding the task) plus one candidate child ticket per agent in candidate_agent_ids, each assigned to a distinct agent so they work the same task in isolated worktrees. Evaluator agents are recorded on the run as labels for the scoring dispatch. Returns the run id + candidate ids.',
    {
      board_id: z.string().describe('Benchmark board to host the run (must have benchmark_mode on)'),
      prompt: z.string().describe('The task definition handed to every candidate'),
      candidate_agent_ids: z.array(z.string()).min(1).describe('One agent id per candidate; each gets its own child ticket + worktree'),
      title: z.string().optional().describe('Run title (defaults to "Benchmark run")'),
      rubric: z.string().optional().default('').describe('Evaluation rubric appended to the run description'),
      base_repo: z.string().optional().default('').describe('Optional base repo/branch note appended to the run description'),
      evaluator_agent_ids: z.array(z.string()).optional().default([]).describe('Agents that will score candidates (recorded as evaluator:<id> labels on the run)'),
      candidate_column_name: z.string().optional().describe('Column to place candidates on (defaults to the board\'s first active column)'),
    },
    async ({ board_id, prompt, candidate_agent_ids, title, rubric, base_repo, evaluator_agent_ids, candidate_column_name }, extra: { sessionId?: string }) => {
      if (!benchmarkService) return err('benchmark runs require the integrated server (BenchmarkService not wired)');
      const caller = getCallerAgent(extra);
      // create_benchmark_run keeps its historical create+start-now semantics by
      // delegating to BenchmarkService.createRunAndStart (createDraftRun +
      // immediate start). The lifecycle split (draft → start) lives behind the
      // REST/UI surface; this tool's signature + output are unchanged so the
      // plugin / agent-manager need no version bump.
      try {
        const result = await benchmarkService.createRunAndStart({
          board_id,
          prompt,
          candidate_agent_ids,
          title,
          rubric,
          base_repo,
          evaluator_agent_ids,
          candidate_column_name,
          actor: { id: caller?.agentId || '', name: caller?.agentName || '', type: 'agent' },
        });
        return ok(result);
      } catch (e: any) {
        return err(e?.message || 'Failed to create benchmark run');
      }
    },
  );
}
