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
import { Agent } from '../../../entities/Agent';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerBenchmarkTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, benchmarkService, ticketRoleAssignmentService, activityService, logger } = ctx;

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
      const caller = getCallerAgent(extra);

      const board = await dataSource.getRepository(Board).findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');
      const workspaceId = board.workspace_id || '';

      const cols = await dataSource.getRepository(BoardColumn).find({
        where: { board_id },
        order: { position: 'ASC' },
      });
      if (cols.length === 0) return err('Board has no columns');

      const isTerminal = (c: BoardColumn) => (c as any).is_terminal === true || (c as any).kind === 'terminal';
      // Run sits on the first column (intake) so it renders as a board card.
      const runColumn = cols[0];
      // Candidates land on the named column, else the first active-kind column,
      // else the first non-terminal column — so the normal assignee dispatch fires.
      const candidateColumn =
        (candidate_column_name
          ? cols.find((c) => c.name.toLowerCase() === candidate_column_name.toLowerCase())
          : undefined) ||
        cols.find((c) => (c as any).kind === 'active') ||
        cols.find((c) => !isTerminal(c)) ||
        runColumn;

      const agentRepo = dataSource.getRepository(Agent);
      const ticketRepo = dataSource.getRepository(Ticket);

      const descParts = [prompt];
      if (rubric) descParts.push('\n\n## Rubric\n' + rubric);
      if (base_repo) descParts.push('\n\n## Base repository\n' + base_repo);
      const runDescription = descParts.join('');

      const runLabels = ['benchmark', 'benchmark-run', ...evaluator_agent_ids.map((id) => `evaluator:${id}`)];

      const creatorName = caller?.agentName || '';
      const creatorId = caller?.agentId || '';

      // Run parent.
      const runPosition = await ticketRepo
        .createQueryBuilder('t')
        .where('t.column_id = :colId AND t.parent_id IS NULL', { colId: runColumn.id })
        .getCount();
      const run = await ticketRepo.save(ticketRepo.create({
        column_id: runColumn.id,
        parent_id: null as any,
        depth: 0,
        title: title || 'Benchmark run',
        description: runDescription,
        priority: 'high',
        workspace_id: workspaceId,
        labels: JSON.stringify(runLabels),
        position: runPosition,
        created_by: creatorName,
        created_by_type: creatorId ? 'agent' : '',
        created_by_id: creatorId,
      }));

      // Candidates — one child per agent, each with its own assignee + worktree.
      const candidates: Array<{ candidate_ticket_id: string; assignee_agent_id: string; title: string }> = [];
      let childPos = 0;
      for (const agentId of candidate_agent_ids) {
        const agent = await agentRepo.findOne({ where: { id: agentId } });
        const agentName = agent?.name || agentId;
        const child = await ticketRepo.save(ticketRepo.create({
          parent_id: run.id,
          depth: 1,
          column_id: candidateColumn.id,
          title: `Candidate: ${agentName}`,
          description: prompt,
          priority: 'medium',
          status: 'todo',
          workspace_id: workspaceId,
          assignee_id: agentId,
          assignee: agentName,
          labels: JSON.stringify(['benchmark', 'benchmark-candidate']),
          position: childPos++,
          created_by: creatorName,
          created_by_type: creatorId ? 'agent' : '',
          created_by_id: creatorId,
        }));
        // Sync the assignee role assignment so TriggerLoopService can resolve a
        // holder for the candidate's active column (assignee dispatch).
        if (ticketRoleAssignmentService && workspaceId) {
          try {
            await ticketRoleAssignmentService.syncBuiltinTrio(child.id, workspaceId, {
              assignee_id: agentId,
            });
          } catch (e) {
            logger.warn('MCP', `create_benchmark_run: failed to sync assignee role for candidate ${child.id}: ${String(e)}`);
          }
        }
        candidates.push({ candidate_ticket_id: child.id, assignee_agent_id: agentId, title: child.title });
      }

      await activityService.logActivity({
        entity_type: 'ticket',
        entity_id: run.id,
        action: 'created',
        new_value: run.title,
        ticket_id: run.id,
        actor_name: creatorName || 'benchmark',
      });

      return ok({
        run_ticket_id: run.id,
        run_column_id: runColumn.id,
        candidate_column_id: candidateColumn.id,
        evaluator_agent_ids,
        candidates,
      });
    },
  );
}
