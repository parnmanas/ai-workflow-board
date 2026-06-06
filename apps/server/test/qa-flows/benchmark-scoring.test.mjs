// QA: benchmark scoring data-layer end-to-end (ticket 684c012b).
//
// Drives the benchmark MCP tool surface against a real booted app:
//   create_benchmark_run  → parent run ticket + N candidate children (one
//                            assignee each, evaluator:<id> labels on the run)
//   submit_benchmark_score → evaluator records per-dimension scores (upsert)
//   get_benchmark_leaderboard → run-scoped candidate table + agent aggregate
//
// Verifies the wiring the UI + evaluator dispatch loop depend on: fan-out
// topology, score upsert dedup, and both leaderboard aggregations. The SSE
// evaluator dispatch (TriggerLoopService) is covered separately; here the
// scores are submitted directly so the aggregation math is what's asserted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_BENCHMARK_PORT || '7824';

test('benchmark: create_benchmark_run → submit_benchmark_score → leaderboards', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;

  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'benchmark',
  });

  step('Flip the board into benchmark_mode');
  const ds = app.get(getDataSourceToken());
  await ds.getRepository('Board').update(board.id, { benchmark_mode: 'on' });

  // Caller that fans out the run, two candidate agents, one evaluator.
  const caller = await createAgent(app, getDataSourceToken, ws.id, { name: 'orchestrator' });
  const callerKey = await createApiKey(app, getDataSourceToken, caller.id, { workspaceId: ws.id, label: 'caller' });
  const candA = await createAgent(app, getDataSourceToken, ws.id, { name: 'cand-A' });
  const candB = await createAgent(app, getDataSourceToken, ws.id, { name: 'cand-B' });
  const evaluator = await createAgent(app, getDataSourceToken, ws.id, { name: 'judge' });
  const evalKey = await createApiKey(app, getDataSourceToken, evaluator.id, { workspaceId: ws.id, label: 'judge' });

  const callerMcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: callerKey.raw_key });
  await callerMcp.initialize();
  t.after(() => callerMcp.close());

  step('create_benchmark_run fans out a run + 2 candidate children');
  const run = await callerMcp.callTool('create_benchmark_run', {
    board_id: board.id,
    prompt: 'Implement the widget',
    title: 'Widget bench',
    rubric: 'correctness 0..10, quality 0..10',
    candidate_agent_ids: [candA.id, candB.id],
    evaluator_agent_ids: [evaluator.id],
  });
  assert.ok(run && !run.isError, `create_benchmark_run failed: ${JSON.stringify(run)}`);
  assert.ok(run.run_ticket_id, 'run_ticket_id returned');
  assert.equal(run.candidates.length, 2, 'two candidate children created');
  const candTicketA = run.candidates.find((c) => c.assignee_agent_id === candA.id).candidate_ticket_id;
  const candTicketB = run.candidates.find((c) => c.assignee_agent_id === candB.id).candidate_ticket_id;

  // Candidates are children of the run, on an active (dispatchable) column,
  // each assigned to a distinct agent. The run carries the evaluator label.
  const ticketRepo = ds.getRepository('Ticket');
  const childA = await ticketRepo.findOne({ where: { id: candTicketA } });
  assert.equal(childA.parent_id, run.run_ticket_id, 'candidate is a child of the run');
  assert.equal(childA.assignee_id, candA.id, 'candidate assigned to its agent');
  assert.notEqual(childA.column_id, columns.done.id, 'candidate not parked on terminal column');
  const runTicket = await ticketRepo.findOne({ where: { id: run.run_ticket_id } });
  assert.ok(JSON.parse(runTicket.labels).includes(`evaluator:${evaluator.id}`), 'run carries evaluator label');

  step('Evaluator submits scores for both candidates (A stronger than B)');
  const evalMcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: evalKey.raw_key });
  await evalMcp.initialize();
  t.after(() => evalMcp.close());

  const score = (candidate_ticket_id, dimension, s, rationale) =>
    evalMcp.callTool('submit_benchmark_score', { candidate_ticket_id, dimension, score: s, rationale });

  const s1 = await score(candTicketA, 'correctness', 9, 'all cases pass');
  assert.ok(s1 && !s1.isError, `submit failed: ${JSON.stringify(s1)}`);
  assert.equal(s1.run_ticket_id, run.run_ticket_id, 'run inferred from candidate parent');
  assert.equal(s1.evaluator_agent_id, evaluator.id, 'evaluator auto-filled from session');
  await score(candTicketA, 'quality', 8, 'clean');
  await score(candTicketB, 'correctness', 5, 'one bug');
  await score(candTicketB, 'quality', 6, 'ok');

  step('Re-scoring the same (candidate,dimension) upserts — no duplicate row');
  await score(candTicketA, 'correctness', 10, 'revised: perfect');
  const scoreRepo = ds.getRepository('BenchmarkScore');
  const aCorrect = await scoreRepo.find({
    where: { candidate_ticket_id: candTicketA, evaluator_agent_id: evaluator.id, dimension: 'correctness' },
  });
  assert.equal(aCorrect.length, 1, 'upsert kept a single row');
  assert.equal(Number(aCorrect[0].score), 10, 'upsert updated the score in place');

  step('Run leaderboard ranks A above B with per-dimension breakdown');
  const lb = await callerMcp.callTool('get_benchmark_leaderboard', { run_ticket_id: run.run_ticket_id });
  assert.equal(lb.candidates.length, 2, 'both candidates in run leaderboard');
  assert.equal(lb.candidates[0].assignee_agent_id, candA.id, 'A ranked first (higher avg)');
  assert.equal(lb.candidates[0].average, 9, 'A average = (10+8)/2');
  assert.equal(lb.candidates[1].average, 5.5, 'B average = (5+6)/2');
  const aCorrectDim = lb.candidates[0].per_dimension.find((d) => d.dimension === 'correctness');
  assert.equal(aCorrectDim.average, 10, 'A correctness reflects the upserted value');

  step('Agent leaderboard aggregates by the benchmarked agent (candidate assignee)');
  const agg = await callerMcp.callTool('get_benchmark_leaderboard', { workspace_id: ws.id });
  const aRow = agg.agents.find((a) => a.agent_id === candA.id);
  const bRow = agg.agents.find((a) => a.agent_id === candB.id);
  assert.ok(aRow && bRow, 'both benchmarked agents present in aggregate');
  assert.equal(aRow.average, 9, 'agent A aggregate average');
  assert.equal(bRow.average, 5.5, 'agent B aggregate average');
  assert.ok(aRow.average > bRow.average, 'A outranks B in the agent leaderboard');
  // The evaluator is NOT itself a benchmarked agent — it has no candidates.
  assert.ok(!agg.agents.some((a) => a.agent_id === evaluator.id), 'evaluator is not ranked as a candidate');

  exitAfterTests(0);
});
