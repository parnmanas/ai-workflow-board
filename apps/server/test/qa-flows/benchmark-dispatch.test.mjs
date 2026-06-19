// QA: benchmark dispatch loops end-to-end (ticket 684c012b).
//
// Covers the two trigger paths the data-layer test (benchmark-scoring.test.mjs)
// deliberately skips — the live SSE dispatch that wakes real agents:
//
//   Part A — create_benchmark_run actually DISPATCHES its candidates.
//     The headline DoD is "각 후보가 독립 worktree 에서 작업". Creating the
//     candidate child rows is not enough — the trigger loop only routes on
//     'moved'/comment/'updated' activities and backlog promotion only touches
//     intake-kind columns, so a candidate placed on an active column would sit
//     idle forever. create_benchmark_run now calls dispatchCurrentColumn per
//     candidate; this asserts each candidate's assignee receives an
//     agent_trigger (trigger_source='benchmark_candidate', role='assignee').
//
//   Part B — a candidate landing on a review-kind column wakes the evaluators.
//     TriggerLoopService._dispatchBenchmarkEvaluators fires when a
//     benchmark-candidate child moves onto a review column on a benchmark_mode
//     board, emitting one benchmark_review trigger per evaluator:<id> label on
//     the run. This drives that path through the real activity loop and asserts
//     the evaluator (NOT a reviewer role assignment) is the one woken.
//
// Acceptance:
//   1. create_benchmark_run returns dispatched>=1 for every candidate.
//   2. Each candidate's assignee VirtualAgent receives exactly one
//      benchmark_candidate agent_trigger for its own candidate ticket.
//   3. Before any move, the evaluator receives nothing.
//   4. Moving candidate A onto the Review column emits exactly one
//      benchmark_review trigger to the evaluator, scoped to candidate A.
//   5. The candidate's own assignee is NOT re-woken on the review landing
//      (benchmark branch returns before normal reviewer routing).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

// Unique port slot — benchmark-scoring uses 7824, unpend-trigger 7836.
process.env.PORT = process.env.QA_BENCHMARK_DISPATCH_PORT || '7825';

test('benchmark dispatch: create_benchmark_run wakes candidates; review landing wakes evaluators', async (t) => {
  step('Boot NestJS app + benchmark_mode kanban');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'bench-dispatch',
  });
  const ds = app.get(getDataSourceToken());
  await ds.getRepository('Board').update(board.id, { benchmark_mode: 'on' });

  // Caller fans out the run; two candidate agents do the work; one evaluator
  // scores. The candidate agents are the assignees we expect to be woken.
  const caller = await createAgent(app, getDataSourceToken, ws.id, { name: 'orchestrator' });
  const callerKey = await createApiKey(app, getDataSourceToken, caller.id, { workspaceId: ws.id, label: 'caller' });
  const candA = await createAgent(app, getDataSourceToken, ws.id, { name: 'cand-A' });
  const candAKey = await createApiKey(app, getDataSourceToken, candA.id, { workspaceId: ws.id, label: 'cand-A' });
  const candB = await createAgent(app, getDataSourceToken, ws.id, { name: 'cand-B' });
  const candBKey = await createApiKey(app, getDataSourceToken, candB.id, { workspaceId: ws.id, label: 'cand-B' });
  const evaluator = await createAgent(app, getDataSourceToken, ws.id, { name: 'judge' });
  const evalKey = await createApiKey(app, getDataSourceToken, evaluator.id, { workspaceId: ws.id, label: 'judge' });

  step('Start SSE listeners for both candidates + the evaluator, MCP driver for caller');
  const callerVA = new VirtualAgent({ name: 'orchestrator', agentId: caller.id, apiKey: callerKey.raw_key, port });
  const candAVA = new VirtualAgent({ name: 'cand-A', agentId: candA.id, apiKey: candAKey.raw_key, port });
  const candBVA = new VirtualAgent({ name: 'cand-B', agentId: candB.id, apiKey: candBKey.raw_key, port });
  const evalVA = new VirtualAgent({ name: 'judge', agentId: evaluator.id, apiKey: evalKey.raw_key, port });
  await Promise.all([callerVA.start(), candAVA.start(), candBVA.start(), evalVA.start()]);
  t.after(async () => {
    await Promise.all([callerVA.stop(), candAVA.stop(), candBVA.stop(), evalVA.stop()]);
  });
  // Let SSE handlers register before any trigger flows.
  await new Promise((r) => setTimeout(r, 300));

  // ──────────────────────────────────────────────────────────────────
  // Part A: create_benchmark_run dispatches candidates.
  // ──────────────────────────────────────────────────────────────────
  step('create_benchmark_run fans out + dispatches 2 candidates onto In Progress');
  const run = await callerVA.mcp.callTool('create_benchmark_run', {
    board_id: board.id,
    prompt: 'Implement the widget',
    title: 'Widget bench',
    rubric: 'correctness 0..10',
    candidate_agent_ids: [candA.id, candB.id],
    evaluator_agent_ids: [evaluator.id],
    candidate_column_name: 'In Progress',
  });
  assert.ok(run && !run.isError, `create_benchmark_run failed: ${JSON.stringify(run)}`);
  assert.equal(run.candidate_column_id, columns.inProgress.id, 'candidates placed on the active In Progress column');
  assert.equal(run.candidates.length, 2, 'two candidate children');
  const candTicketA = run.candidates.find((c) => c.assignee_agent_id === candA.id).candidate_ticket_id;
  const candTicketB = run.candidates.find((c) => c.assignee_agent_id === candB.id).candidate_ticket_id;

  // The fix: every candidate reports at least one emitted trigger. This is the
  // direct signal that dispatchCurrentColumn ran and resolved the assignee.
  for (const c of run.candidates) {
    assert.ok(c.dispatched >= 1, `candidate ${c.assignee_agent_id} must report dispatched>=1, got ${c.dispatched}`);
  }

  step('Each candidate assignee receives a benchmark_candidate agent_trigger over SSE');
  const trigA = await candAVA.waitForTrigger(
    (tr) => tr.ticket_id === candTicketA && tr.trigger_source === 'benchmark_candidate', 4000,
  );
  assert.equal(trigA.role, 'assignee', 'candidate A trigger carries role=assignee');
  assert.equal(trigA.agent_id, candA.id, 'candidate A trigger targets candidate A');
  const trigB = await candBVA.waitForTrigger(
    (tr) => tr.ticket_id === candTicketB && tr.trigger_source === 'benchmark_candidate', 4000,
  );
  assert.equal(trigB.role, 'assignee', 'candidate B trigger carries role=assignee');

  // Exactly one dispatch per candidate — no cross-talk between candidates.
  assert.equal(
    candAVA.triggersFor(candTicketA).filter((tr) => tr.trigger_source === 'benchmark_candidate').length, 1,
    'candidate A woken exactly once',
  );
  assert.equal(candBVA.triggersFor(candTicketA).length, 0, 'candidate B must not receive candidate A triggers');

  step('No evaluator trigger yet — candidates have not reached Review');
  assert.equal(evalVA.triggersFor(candTicketA).length, 0, 'evaluator silent before any review landing');

  // ──────────────────────────────────────────────────────────────────
  // Part B: a candidate landing on a review column wakes the evaluators.
  // We drive the real activity loop: flip the candidate's column to Review,
  // then emit a 'moved' activity whose actor is the candidate's own assignee
  // (a real UUID — a system/empty actor would be dropped by _handleActivity).
  // ──────────────────────────────────────────────────────────────────
  step('Move candidate A onto the Review (review-kind) column');
  const ticketRepo = ds.getRepository('Ticket');
  await ticketRepo.update(candTicketA, { column_id: columns.review.id });
  await app.get(ActivityService).logActivity({
    entity_type: 'ticket',
    entity_id: candTicketA,
    action: 'moved',
    new_value: 'Review',
    ticket_id: candTicketA,
    actor_id: candA.id, // the candidate's assignee moved their work — NOT the evaluator
    actor_name: 'cand-A',
  });

  step('Evaluator receives exactly one benchmark_review trigger scoped to candidate A');
  const evalTrig = await evalVA.waitForTrigger(
    (tr) => tr.ticket_id === candTicketA && tr.trigger_source === 'benchmark_review', 4000,
  );
  assert.equal(evalTrig.role, 'evaluator', 'evaluator trigger carries role=evaluator (not reviewer)');
  assert.equal(evalTrig.agent_id, evaluator.id, 'evaluator trigger targets the run evaluator');
  assert.equal(
    evalVA.triggersFor(candTicketA).filter((tr) => tr.trigger_source === 'benchmark_review').length, 1,
    'exactly one evaluator dispatch for the single evaluator label',
  );

  // The benchmark branch returns before normal reviewer routing, so the
  // candidate's own assignee is not re-woken on the review landing.
  const aReviewTriggers = candAVA.triggersFor(candTicketA)
    .filter((tr) => tr.trigger_source === 'benchmark_review');
  assert.equal(aReviewTriggers.length, 0, 'candidate assignee is not re-triggered on the review landing');

  exitAfterTests(0);
});
