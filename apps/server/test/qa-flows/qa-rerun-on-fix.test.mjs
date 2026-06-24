// QA flow: QA → fix → QA closed loop (ticket 467dbc7a).
//
// When a scenario opts into on_failure_ticket.rerun_on_fix, the fix ticket auto-
// filed on failure re-runs the SAME scenario the moment it lands on a terminal
// (Done) column — server-side, deterministic, no agent prompt parsing. This test
// drives the loop end-to-end and asserts the Verify cases from the ticket:
//
//   1. failed run → fix ticket (gen 0); moving it to Done fires a rerun
//      (a new QaRun with rerun_generation = 1).
//   2. the rerun re-fails → a NEW fix ticket stamped `qa-rerun:1`; moving IT to
//      Done fires rerun gen 2 (generation counter increments through the chain).
//   3. convergence: when the generation reaching Done >= max_rerun_attempts the
//      loop HALTS — no new run, a "사람 개입 필요" comment instead.
//   4. idempotency: re-emitting the SAME terminal move (no terminal_entered_at
//      restamp) does NOT fire a second rerun.
//   5. negative: a scenario with rerun_on_fix OFF never fires a rerun on Done.
//
// Like on-ticket-done-hook.test.mjs we simulate the terminal landing directly
// (stamp terminal_entered_at + log a `moved` activity) so the service sees
// exactly what the production move path emits, and we can control restamping for
// the idempotency case.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_RERUN_ON_FIX_PORT || '7851';

// Simulate a real terminal landing (see on-ticket-done-hook.test.mjs).
async function moveToDone(ds, activityService, ticketId, doneColId, { restamp = true } = {}) {
  const tRepo = ds.getRepository('Ticket');
  if (restamp) {
    await tRepo.update(ticketId, { column_id: doneColId, terminal_entered_at: new Date() });
  }
  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticketId, action: 'moved',
    field_changed: 'column', new_value: 'Done', ticket_id: ticketId,
    actor_id: 'test-user', actor_name: 'Tester',
  });
}

async function runsForScenario(ds, scenarioId) {
  return ds.getRepository('QaRun').find({ where: { scenario_id: scenarioId }, order: { created_at: 'ASC' } });
}

// The rerun listener is fire-and-forget (.catch); poll until the run count lands.
async function waitForRunCount(ds, scenarioId, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let rows = await runsForScenario(ds, scenarioId);
  while (rows.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    rows = await runsForScenario(ds, scenarioId);
  }
  return rows;
}

test('QA rerun-on-fix: Done → rerun, generation chain, max-attempts halt, idempotency, opt-out', async (t) => {
  step('Boot NestJS app + scene');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const activityService = app.get(modules.ActivityService);

  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'qa-rerun' });
  const qaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'qa-runner' });
  const qaKey = await createApiKey(app, getDataSourceToken, qaAgent.id, { workspaceId: ws.id, label: 'qa' });

  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: qaKey.raw_key });
  t.after(() => { void mcp.close().catch(() => {}); });

  const steps = [{ idx: 0, action: 'open the page', expect: 'no error' }];

  // Complete the (already-running) latest run of a scenario as failed/passed so
  // the on-failure ticket + generation threading fire through completeRun.
  const completeLatest = async (scenarioId, status) => {
    const runs = await runsForScenario(ds, scenarioId);
    const latest = runs[runs.length - 1];
    await mcp.callTool('record_qa_step', {
      run_id: latest.id, workspace_id: ws.id, idx: 0,
      status: status === 'passed' ? 'passed' : 'failed', log: `step 0 ${status}`,
    });
    const done = await mcp.callTool('complete_qa_run', {
      run_id: latest.id, workspace_id: ws.id, status, summary: `run ${status}`,
    });
    assert.ok(!done?.isError, `complete_qa_run: ${JSON.stringify(done)}`);
    return done;
  };

  const ticketsForScenario = async (scenarioId) =>
    ds.query(`SELECT id, column_id, labels FROM tickets WHERE labels LIKE '%qa-scenario:${scenarioId}%' ORDER BY created_at ASC`);
  const labelsOf = (row) => JSON.parse(row.labels || '[]');

  // ── Setup: a scenario opted into the closed loop, max 2 reruns ───────────────
  step('Create scenario with rerun_on_fix, max_rerun_attempts=2');
  const sc = await mcp.callTool('create_qa_scenario', {
    workspace_id: ws.id, board_id: board.id, name: 'Closed loop QA', target_agent_id: qaAgent.id,
    qa_driver: 'browser', steps,
    on_failure_ticket: {
      enabled: true, column_name: 'Todo', dedupe: 'per_open_ticket',
      rerun_on_fix: true, max_rerun_attempts: 2, rerun_delay_seconds: 0,
    },
  });
  assert.ok(!sc?.isError && sc.id, `create scenario: ${JSON.stringify(sc)}`);
  assert.equal(sc.on_failure_ticket?.rerun_on_fix, true, 'rerun_on_fix round-trips');
  assert.equal(sc.on_failure_ticket?.max_rerun_attempts, 2, 'max_rerun_attempts round-trips');

  // ── CASE 1: first failure → fix ticket gen0 → Done fires rerun gen1 ──────────
  step('CASE 1: failed run files gen-0 fix ticket; Done fires rerun gen 1');
  const r0 = await mcp.callTool('start_qa_run', { scenario_id: sc.id });
  assert.ok(!r0?.isError && r0.run_id, `start run: ${JSON.stringify(r0)}`);
  const done0 = await completeLatest(sc.id, 'failed');
  assert.ok(done0.auto_ticket_id, 'gen-0 failure files a fix ticket');
  assert.equal(done0.rerun_generation, 0, 'original run is generation 0');
  const t0 = done0.auto_ticket_id;

  let allRuns = await runsForScenario(ds, sc.id);
  assert.equal(allRuns.length, 1, 'exactly one run so far');

  await moveToDone(ds, activityService, t0, columns.done.id);
  allRuns = await waitForRunCount(ds, sc.id, 2);
  assert.equal(allRuns.length, 2, 'moving the gen-0 fix ticket to Done fired a rerun');
  const rerun1 = allRuns[1];
  assert.equal(rerun1.rerun_generation, 1, 'rerun is generation 1');
  assert.equal(rerun1.triggered_by_id, 'qa-rerun-on-fix', 'rerun is server-triggered by the hook');

  // ── CASE 2: rerun re-fails → gen-1 ticket (qa-rerun:1) → Done fires gen 2 ────
  step('CASE 2: rerun re-fails → gen-1 ticket; Done fires rerun gen 2');
  const done1 = await completeLatest(sc.id, 'failed');
  assert.ok(done1.auto_ticket_id, 'rerun failure files a NEW fix ticket (prior is terminal)');
  assert.notEqual(done1.auto_ticket_id, t0, 'a fresh gen-1 ticket, not the Done gen-0 one');
  const t1 = done1.auto_ticket_id;
  const t1row = (await ticketsForScenario(sc.id)).find((r) => r.id === t1);
  assert.ok(labelsOf(t1row).includes('qa-rerun:1'), 'gen-1 ticket carries qa-rerun:1');
  assert.ok(labelsOf(t1row).includes('qa-failure') && labelsOf(t1row).includes('auto'), 'gen-1 ticket keeps the marker labels');

  await moveToDone(ds, activityService, t1, columns.done.id);
  allRuns = await waitForRunCount(ds, sc.id, 3);
  assert.equal(allRuns.length, 3, 'gen-1 ticket Done fired rerun gen 2');
  assert.equal(allRuns[2].rerun_generation, 2, 'rerun is generation 2');

  // ── CASE 3: gen-2 ticket Done → 2 >= max(2) → HALT (no rerun, halt comment) ──
  step('CASE 3: generation reaches max_rerun_attempts → halt with human-intervention comment');
  const done2 = await completeLatest(sc.id, 'failed');
  const t2 = done2.auto_ticket_id;
  const t2row = (await ticketsForScenario(sc.id)).find((r) => r.id === t2);
  assert.ok(labelsOf(t2row).includes('qa-rerun:2'), 'gen-2 ticket carries qa-rerun:2');

  await moveToDone(ds, activityService, t2, columns.done.id);
  // Give the listener time; assert it did NOT add a run.
  await new Promise((r) => setTimeout(r, 600));
  allRuns = await runsForScenario(ds, sc.id);
  assert.equal(allRuns.length, 3, 'no rerun once generation hits the cap');
  const haltComments = await ds.query(`SELECT content FROM comments WHERE ticket_id = '${t2}'`);
  assert.ok(
    haltComments.some((c) => c.content.includes('한계 도달') || c.content.includes('사람 개입')),
    'halt posts a human-intervention comment',
  );

  // ── CASE 4: idempotency — re-emit a prior Done move, no restamp → no rerun ───
  step('CASE 4: re-emitting the same terminal entry does not double-fire');
  await moveToDone(ds, activityService, t0, columns.done.id, { restamp: false });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await runsForScenario(ds, sc.id)).length, 3, 'same-entry re-emit fired no extra rerun');

  // ── CASE 5: negative — rerun_on_fix OFF never reruns on Done ─────────────────
  step('CASE 5: a scenario with rerun_on_fix OFF does not rerun on Done');
  const scOff = await mcp.callTool('create_qa_scenario', {
    workspace_id: ws.id, board_id: board.id, name: 'No-rerun QA', target_agent_id: qaAgent.id,
    qa_driver: 'browser', steps,
    on_failure_ticket: { enabled: true, column_name: 'Todo', dedupe: 'per_run', rerun_on_fix: false },
  });
  assert.ok(!scOff?.isError && scOff.id);
  await mcp.callTool('start_qa_run', { scenario_id: scOff.id });
  const doneOff = await completeLatest(scOff.id, 'failed');
  assert.ok(doneOff.auto_ticket_id, 'opt-out scenario still files a fix ticket');
  await moveToDone(ds, activityService, doneOff.auto_ticket_id, columns.done.id);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await runsForScenario(ds, scOff.id)).length, 1, 'rerun_on_fix=false → Done fires no rerun');
});

exitAfterTests();
