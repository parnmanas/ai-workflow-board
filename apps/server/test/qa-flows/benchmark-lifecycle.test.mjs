// QA: benchmark run lifecycle — draft → edit → start → add → fairness lock
// (ticket 5eb459c4).
//
// The pre-lifecycle behaviour (create_benchmark_run fans out AND dispatches
// immediately) is covered by benchmark-dispatch.test.mjs. This flow exercises
// the NEW draft lifecycle on BenchmarkService directly (the REST controller is
// a thin status-mapping wrapper over these same methods):
//
//   1. createDraftRun → state='draft', candidates PARKED (pending) and NOT
//      dispatched: the candidate's assignee receives no agent_trigger.
//   2. updateRun on a draft freely edits prompt + evaluators.
//   3. startRun flips to 'started' and dispatches every parked candidate — the
//      assignee now receives a benchmark_candidate trigger.
//   4. addCandidates on a started run dispatches the new candidate immediately.
//   5. Option-A fairness lock: on a started run, changing prompt / evaluators /
//      removing a candidate is rejected with HTTP 422; title + candidate-add pass.
//   6. A recorded score surfaces on the run leaderboard.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey } from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');

// Unique port slot — dispatch uses 7825, scoring 7824.
process.env.PORT = process.env.QA_BENCHMARK_LIFECYCLE_PORT || '7826';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Assert a thrown lifecycle error carries the expected HTTP status. */
async function expectStatus(fn, status, label) {
  try {
    await fn();
    assert.fail(`${label}: expected rejection with status ${status} but it resolved`);
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    assert.equal(e?.status, status, `${label}: expected status ${status}, got ${e?.status} (${e?.message})`);
  }
}

test('benchmark lifecycle: draft parks candidates, start dispatches, started run is fairness-locked', async (t) => {
  step('Boot NestJS app + benchmark_mode kanban');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;

  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'bench-lifecycle',
  });
  const ds = app.get(getDataSourceToken());
  await ds.getRepository('Board').update(board.id, { benchmark_mode: 'on' });

  const { BenchmarkService } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'benchmarks', 'benchmark.service.js')
  );
  const svc = app.get(BenchmarkService);

  // Two draft candidates + one added later; one evaluator (+ a replacement to
  // attempt an illegal evaluator swap after start).
  const candA = await createAgent(app, getDataSourceToken, ws.id, { name: 'cand-A' });
  const candAKey = await createApiKey(app, getDataSourceToken, candA.id, { workspaceId: ws.id, label: 'cand-A' });
  const candB = await createAgent(app, getDataSourceToken, ws.id, { name: 'cand-B' });
  const candC = await createAgent(app, getDataSourceToken, ws.id, { name: 'cand-C' });
  const candCKey = await createApiKey(app, getDataSourceToken, candC.id, { workspaceId: ws.id, label: 'cand-C' });
  const evaluator = await createAgent(app, getDataSourceToken, ws.id, { name: 'judge' });
  const evaluator2 = await createAgent(app, getDataSourceToken, ws.id, { name: 'judge-2' });

  step('SSE listeners for candidate A (parked→dispatched) and candidate C (added post-start)');
  const candAVA = new VirtualAgent({ name: 'cand-A', agentId: candA.id, apiKey: candAKey.raw_key, port });
  const candCVA = new VirtualAgent({ name: 'cand-C', agentId: candC.id, apiKey: candCKey.raw_key, port });
  await Promise.all([candAVA.start(), candCVA.start()]);
  t.after(async () => { await Promise.all([candAVA.stop(), candCVA.stop()]); });
  await sleep(300);

  // ── 1. createDraftRun: parked, not dispatched ──────────────────────
  step('createDraftRun → draft state, candidates parked (pending, no dispatch)');
  const draft = await svc.createDraftRun({
    board_id: board.id,
    prompt: 'Implement the widget',
    title: 'Lifecycle bench',
    rubric: 'correctness 0..10',
    candidate_agent_ids: [candA.id, candB.id],
    evaluator_agent_ids: [evaluator.id],
    candidate_column_name: 'In Progress',
    actor: { id: '', name: 'qa', type: 'user' },
  });
  const runId = draft.run_ticket_id;
  assert.equal(draft.state, 'draft', 'run starts in draft');
  assert.equal(draft.candidate_column_id, columns.inProgress.id, 'candidates on the active column');
  assert.equal(draft.candidates.length, 2, 'two candidate children');
  assert.ok(draft.candidates.every((c) => c.pending === true), 'every candidate is parked (pending)');
  const candTicketA = draft.candidates.find((c) => c.assignee_agent_id === candA.id).candidate_ticket_id;

  step('Parked candidate A receives NO dispatch trigger');
  await sleep(800);
  assert.equal(
    candAVA.triggersFor(candTicketA).length, 0,
    'parked candidate must not be dispatched before Start',
  );

  // ── 2. updateRun (draft): free edit ────────────────────────────────
  // Mirror the real UI Edit-modal payload: the modal ALWAYS sends
  // candidate_agent_ids alongside prompt (and evaluators). A prompt edit on this
  // path must still propagate to every retained candidate child's description —
  // that's the regression the reviewer caught (propagation was gated on
  // candidate_agent_ids being absent, so the UI path silently skipped it).
  step('updateRun on draft (modal payload) freely edits prompt + evaluators');
  const edited = await svc.updateRun(runId, {
    prompt: 'Implement the widget v2',
    candidate_agent_ids: [candA.id, candB.id],
    evaluator_agent_ids: [evaluator.id, evaluator2.id],
  });
  assert.equal(edited.state, 'draft', 'still draft after edit');
  assert.equal(edited.prompt, 'Implement the widget v2', 'prompt updated');
  assert.equal(edited.evaluator_agent_ids.length, 2, 'evaluator set updated');
  assert.equal(edited.candidates.length, 2, 'candidate set unchanged (both retained)');

  step('draft prompt edit propagates to EVERY retained candidate child description');
  const ticketRepo = ds.getRepository('Ticket');
  const candChildren = await ticketRepo.find({ where: { parent_id: runId } });
  const candDescById = new Map(candChildren.map((c) => [c.assignee_id, c.description]));
  for (const id of [candA.id, candB.id]) {
    assert.equal(
      candDescById.get(id), 'Implement the widget v2',
      `retained candidate ${id} must carry the edited prompt, not a stale one`,
    );
  }

  // ── 3. startRun: dispatch parked candidates ────────────────────────
  step('startRun flips to started + dispatches parked candidate A');
  const started = await svc.startRun(runId, { id: '', name: 'qa', type: 'user' });
  assert.equal(started.state, 'started', 'run is started');
  assert.ok(typeof started.started_at === 'number' && started.started_at > 0, 'started_at recorded');
  assert.ok(started.candidates.every((c) => c.pending === false), 'candidates unparked');

  const trigA = await candAVA.waitForTrigger(
    (tr) => tr.ticket_id === candTicketA && tr.trigger_source === 'benchmark_start', 4000,
  );
  assert.equal(trigA.role, 'assignee', 'dispatched candidate trigger carries role=assignee');
  assert.equal(trigA.agent_id, candA.id, 'dispatch targets candidate A');

  // ── 4. addCandidates on a started run dispatches immediately ────────
  step('addCandidates on started run dispatches candidate C immediately');
  const withC = await svc.addCandidates(runId, [candC.id], { id: '', name: 'qa', type: 'user' });
  assert.equal(withC.candidates.length, 3, 'third candidate added');
  const candTicketC = withC.candidates.find((c) => c.assignee_agent_id === candC.id).candidate_ticket_id;
  assert.ok(withC.candidates.find((c) => c.assignee_agent_id === candC.id).pending === false, 'added candidate not parked');
  const trigC = await candCVA.waitForTrigger(
    (tr) => tr.ticket_id === candTicketC && tr.trigger_source === 'benchmark_candidate', 4000,
  );
  assert.equal(trigC.agent_id, candC.id, 'added candidate C dispatched');

  // ── 5. Option-A fairness lock on a started run ─────────────────────
  step('started run rejects prompt / evaluator / candidate-removal edits (422)');
  await expectStatus(() => svc.updateRun(runId, { prompt: 'sneaky change' }), 422, 'prompt change after start');
  await expectStatus(() => svc.updateRun(runId, { rubric: 'new rubric' }), 422, 'rubric change after start');
  await expectStatus(() => svc.updateRun(runId, { evaluator_agent_ids: [evaluator.id] }), 422, 'evaluator change after start');
  await expectStatus(
    () => svc.updateRun(runId, { candidate_agent_ids: [candA.id] }),
    422, 'candidate removal after start',
  );

  step('started run still accepts a title change + candidate addition');
  const renamed = await svc.updateRun(runId, { title: 'Lifecycle bench (renamed)' });
  assert.equal(renamed.title, 'Lifecycle bench (renamed)', 'title editable after start');
  // Adding an already-present candidate via updateRun is a no-op (no removal), must pass.
  const readd = await svc.updateRun(runId, { candidate_agent_ids: [candA.id, candB.id, candC.id] });
  assert.equal(readd.candidates.length, 3, 'no-op candidate set passes the started guard');

  // ── 6. leaderboard reflects a recorded score ───────────────────────
  step('recorded score surfaces on the run leaderboard');
  await svc.upsertScore({
    candidate_ticket_id: candTicketA,
    evaluator_agent_id: evaluator.id,
    dimension: 'correctness',
    score: 8,
    rationale: 'solid',
    run_ticket_id: runId,
  });
  const board0 = await svc.getRunLeaderboard(runId);
  const rowA = board0.candidates.find((c) => c.candidate_ticket_id === candTicketA);
  assert.ok(rowA, 'candidate A present on the leaderboard');
  assert.equal(rowA.average, 8, 'recorded score reflected');

  exitAfterTests(0);
});
