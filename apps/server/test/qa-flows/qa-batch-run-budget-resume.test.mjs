// QA schedule tick × wedged batch resume — review a51ec6d9 round 2 blocking #1.
//
// qa-batch-run-budget-pause.test.mjs pins that a transient RunBudgetExceededError
// mid-batch parks the batch `running` (not `done`/`errored`) at the rejected
// index — but it never drives anything AFTER that park. This test closes that
// gap: it drives the real QaScheduleService.runOnce() sweep (the same tick a
// schedule uses in production) across the full lifecycle —
//
//   1. schedule fires → batch dispatches scenario 0, consuming the only
//      run-budget slot in the window
//   2. completing run 0 tries to advance to scenario 1, which the guard rejects
//      → batch parks `running` at index 1 with no run recorded there (the wedge)
//   3. a schedule tick BEFORE the window clears resumes the wedge (retries the
//      SAME index) but hits the same rejection — batch stays parked, no phantom
//      run, and the schedule occurrence is recorded as skipped (not silently
//      dropped)
//   4. once the ceiling is raised (the window "clears"), the NEXT tick's resume
//      actually dispatches the remaining index
//   5. completing that run finalizes the batch `done` with zero indices burned
//      as `errored`
//   6. a LATER tick — now that last_batch_id points at a terminal batch —
//      dispatches a brand-new batch and the schedule reappears in `dispatched`,
//      proving it was never permanently wedged out of its own cadence
//
// Drives QaScheduleService.runOnce(now) directly (mirrors
// workspace-schedule-e2e.test.mjs) rather than through a REST/MCP surface,
// since no such surface exists for the automatic sweep (only run_now, which
// deliberately bypasses SKIP-if-running by design).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, closeTestApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');

// Silence the background auto-tick — only the explicit runOnce(now) calls below
// should drive the sweep, so the multi-tick sequence stays deterministic.
process.env.QA_SCHEDULER_ENABLED = 'false';
process.env.PORT = process.env.QA_BATCH_RUN_BUDGET_RESUME_PORT || '7916';

function scenarioPayload(wsId, agentId, name) {
  return {
    workspace_id: wsId,
    target_agent_id: agentId,
    name,
    qa_driver: 'http-api',
    steps: [{ idx: 0, action: `noop for ${name}`, expect: 'ok' }],
  };
}

test('QA schedule tick resumes a batch wedged on a transient run-budget rejection instead of skipping it forever', async (t) => {
  step('Boot app + MCP');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const { QaScheduleService } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'qa', 'qa-schedule.service.js')
  );
  const scheduleSvc = app.get(QaScheduleService);

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'qa-batch-budget-resume' });
  // Tight run-creation-rate ceiling — scenario 0's own run consumes the
  // window's only slot, so dispatching scenario 1 trips the guard.
  await ds.getRepository('Workspace').update(ws.id, {
    hard_budget_config: JSON.stringify({ max_runs_per_window: 1, window_minutes: 60, notify: false }),
  });

  const qaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'qa-batch-resume-runner' });
  const qaKey = await createApiKey(app, getDataSourceToken, qaAgent.id, { workspaceId: ws.id, label: 'qa' });
  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: qaKey.raw_key });
  t.after(() => { void mcp.close().catch(() => {}); });

  step('Create 2 QA scenarios for the schedule');
  const s0 = await mcp.callTool('create_qa_scenario', scenarioPayload(ws.id, qaAgent.id, 'resume-s0'));
  const s1 = await mcp.callTool('create_qa_scenario', scenarioPayload(ws.id, qaAgent.id, 'resume-s1'));
  assert.ok(!s0?.isError && s0.id, `create s0 failed: ${JSON.stringify(s0)}`);
  assert.ok(!s1?.isError && s1.id, `create s1 failed: ${JSON.stringify(s1)}`);

  step('Create a selected-scope schedule over [s0, s1]');
  const schedule = await scheduleSvc.create({
    workspaceId: ws.id,
    name: 'resume schedule',
    scope: 'selected',
    scenarioIds: [s0.id, s1.id],
    intervalMs: 10 * 60_000,
    createdBy: 'e2e',
  });
  assert.ok(schedule.next_run_at, 'next_run_at precomputed on create');

  step('Tick 1: schedule fires, scenario 0 dispatches and consumes the only run-budget slot');
  const fire1 = new Date(new Date(schedule.next_run_at).getTime() + 1_000);
  const tick1 = await scheduleSvc.runOnce(fire1);
  assert.deepEqual(tick1.dispatched, [schedule.id], 'schedule dispatched a fresh batch');

  const after1 = await scheduleSvc.get(schedule.id, ws.id);
  const batchId = after1.last_batch_id;
  assert.ok(batchId, 'last_batch_id stamped');

  step('Complete run 0 → advancing to scenario 1 trips the run-budget guard, parking the batch (the wedge)');
  const batch0 = await mcp.callTool('get_qa_batch', { batch_id: batchId, workspace_id: ws.id });
  assert.equal(batch0.run_ids.length, 1, 'only scenario 0 dispatched so far');
  const run0 = batch0.run_ids[0];
  const c0 = await mcp.callTool('complete_qa_run', { run_id: run0, workspace_id: ws.id, status: 'passed', summary: 's0 ok' });
  assert.ok(!c0?.isError, `complete run0: ${JSON.stringify(c0)}`);

  const wedged = await mcp.callTool('get_qa_batch', { batch_id: batchId, workspace_id: ws.id });
  assert.equal(wedged.status, 'running', 'batch parked running, not finalized off the transient rejection');
  assert.equal(wedged.current_index, 1, 'cursor parked at the budget-rejected index');
  assert.equal(wedged.run_ids.length, 1, 'no run recorded for the rejected index — this is the wedge signature resumeWedgedBatch checks for');

  step('Tick 2 (still within the budget window): the resume retries and hits the SAME rejection — batch stays wedged, no phantom run, schedule occurrence recorded as skipped');
  const fire2 = new Date(new Date(after1.next_run_at).getTime() + 1_000);
  const tick2 = await scheduleSvc.runOnce(fire2);
  assert.deepEqual(tick2.dispatched, [], 'no fresh batch dispatched this tick — the existing one is being resumed, not replaced');
  assert.deepEqual(tick2.skipped, [schedule.id], 'occurrence recorded as skipped, not silently dropped');

  const stillWedged = await mcp.callTool('get_qa_batch', { batch_id: batchId, workspace_id: ws.id });
  assert.equal(stillWedged.status, 'running', 'still wedged — the run-budget window has not cleared yet');
  assert.equal(stillWedged.run_ids.length, 1, 'resume retried and hit the same rejection again — no phantom run created');

  step('Raise the workspace run-budget ceiling (the window clears) and tick again — the resume actually dispatches the remaining index');
  await ds.getRepository('Workspace').update(ws.id, {
    hard_budget_config: JSON.stringify({ max_runs_per_window: 10, window_minutes: 60, notify: false }),
  });
  const after2 = await scheduleSvc.get(schedule.id, ws.id);
  const fire3 = new Date(new Date(after2.next_run_at).getTime() + 1_000);
  const tick3 = await scheduleSvc.runOnce(fire3);
  assert.deepEqual(tick3.dispatched, [], 'still resuming the existing batch, not starting a fresh one alongside it');

  const resumed = await mcp.callTool('get_qa_batch', { batch_id: batchId, workspace_id: ws.id });
  assert.equal(resumed.run_ids.length, 2, 'the remaining index actually dispatched once the window cleared');
  const run1 = resumed.run_ids[1];
  assert.ok(run1, 'scenario 1 now has a real run');

  step('Complete run 1 → the batch reaches a terminal status with nothing burned as errored');
  const c1 = await mcp.callTool('complete_qa_run', { run_id: run1, workspace_id: ws.id, status: 'passed', summary: 's1 ok' });
  assert.ok(!c1?.isError, `complete run1: ${JSON.stringify(c1)}`);
  const done = await mcp.callTool('get_qa_batch', { batch_id: batchId, workspace_id: ws.id });
  assert.equal(done.status, 'done', 'batch fully resumed to completion');
  assert.equal(done.errored, 0, 'no index was ever burned as errored across the wedge/resume cycle');
  assert.equal(done.passed, 2, 'both scenarios actually ran and passed');

  step('Tick 4: the schedule is NOT permanently skipped — it reappears in `dispatched` once last_batch_id is terminal');
  const after3 = await scheduleSvc.get(schedule.id, ws.id);
  const fire4 = new Date(new Date(after3.next_run_at).getTime() + 1_000);
  const tick4 = await scheduleSvc.runOnce(fire4);
  assert.deepEqual(tick4.dispatched, [schedule.id], 'schedule dispatches a brand-new batch — proof its cadence was never permanently wedged');
  assert.notEqual((await scheduleSvc.get(schedule.id, ws.id)).last_batch_id, batchId, 'last_batch_id now points at the new batch');

  exitAfterTests(0);
});
