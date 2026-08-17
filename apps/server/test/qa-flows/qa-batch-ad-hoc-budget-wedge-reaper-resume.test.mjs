// Ad-hoc QA batch × schedule-agnostic wedge reaper — ticket 5a0593ae.
//
// a51ec6d9 round 2 fixed QaRunService.resumeWedgedBatch, but it only ever
// fires from QaScheduleService.runOnce's SKIP-if-running branch — i.e. ONLY
// for a batch some QaSchedule tracks via last_batch_id. A batch dispatched
// directly via start_qa_batch (no QaSchedule involved at all — the common
// "run this batch right now" path) that hits a transient run-budget rejection
// mid-batch had NO recovery path whatsoever: nothing ever re-drove the retry,
// so it stayed `running` forever with no visibility or recovery (the ticket's
// original gap).
//
// This test reproduces that exact gap end-to-end WITHOUT ever creating a
// QaSchedule, and proves QaRunBatchReaperService closes it — mirroring
// qa-batch-run-budget-resume.test.mjs's structure (same budget-trip
// technique) but driving the schedule-agnostic reaper instead of a schedule
// tick:
//   1. start_qa_batch (ad-hoc, no schedule) dispatches scenario 0, consuming
//      the workspace's only run-budget slot.
//   2. completing run 0 tries to advance to scenario 1, which the guard
//      rejects → batch parks `running` at index 1 with no run recorded (the
//      wedge) — and nothing is tracking this batch via last_batch_id.
//   3. a reaper sweep BEFORE the window clears attempts the resume and hits
//      the SAME rejection — batch stays wedged, no phantom run.
//   4. once the ceiling is raised (the window clears), the NEXT sweep's
//      resume actually dispatches the remaining index.
//   5. completing that run finalizes the batch `done` with zero indices
//      burned as `errored`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');

// Silence both background auto-ticks — only the explicit runOnce() calls
// below should drive the sweep, so the multi-sweep sequence stays
// deterministic (mirrors qa-batch-run-budget-resume.test.mjs). The scheduler
// is disabled too even though this test never creates a QaSchedule — belt and
// suspenders against any future fixture accidentally seeding one.
process.env.QA_SCHEDULER_ENABLED = 'false';
process.env.QA_BATCH_REAPER_ENABLED = 'false';
process.env.PORT = process.env.QA_BATCH_AD_HOC_REAPER_PORT || '7935';

function scenarioPayload(wsId, agentId, name) {
  return {
    workspace_id: wsId,
    target_agent_id: agentId,
    name,
    qa_driver: 'http-api',
    steps: [{ idx: 0, action: `noop for ${name}`, expect: 'ok' }],
  };
}

test('QaRunBatchReaperService resumes an ad-hoc (schedule-less) batch wedged on a transient run-budget rejection', async (t) => {
  step('Boot app + MCP');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const { QaRunBatchReaperService } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'qa', 'qa-run-batch-reaper.service.js')
  );
  const batchReaper = app.get(QaRunBatchReaperService);

  const { ws, board } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'qa-batch-ad-hoc-reaper' });
  // Tight run-creation-rate ceiling — scenario 0's own run consumes the
  // window's only slot, so dispatching scenario 1 trips the guard.
  await ds.getRepository('Workspace').update(ws.id, {
    hard_budget_config: JSON.stringify({ max_runs_per_window: 1, window_minutes: 60, notify: false }),
  });

  const qaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'qa-batch-ad-hoc-reaper-runner' });
  const qaKey = await createApiKey(app, getDataSourceToken, qaAgent.id, { workspaceId: ws.id, label: 'qa' });
  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: qaKey.raw_key });
  t.after(() => { void mcp.close().catch(() => {}); });

  step('Create 2 QA scenarios');
  const s0 = await mcp.callTool('create_qa_scenario', scenarioPayload(ws.id, qaAgent.id, 'ad-hoc-s0'));
  const s1 = await mcp.callTool('create_qa_scenario', scenarioPayload(ws.id, qaAgent.id, 'ad-hoc-s1'));
  assert.ok(!s0?.isError && s0.id, `create s0 failed: ${JSON.stringify(s0)}`);
  assert.ok(!s1?.isError && s1.id, `create s1 failed: ${JSON.stringify(s1)}`);

  step('start_qa_batch directly — ad-hoc, no QaSchedule ever created for it');
  const batch0 = await mcp.callTool('start_qa_batch', {
    workspace_id: ws.id,
    board_id: board.id,
    scenario_ids: [s0.id, s1.id],
  });
  assert.ok(!batch0?.isError && batch0.id, `start_qa_batch failed: ${JSON.stringify(batch0)}`);
  assert.equal(batch0.run_ids.length, 1, 'only scenario 0 dispatched so far');
  const batchId = batch0.id;

  const schedulesBefore = await ds.getRepository('QaSchedule').count({ where: { workspace_id: ws.id } });
  assert.equal(schedulesBefore, 0, 'sanity: no schedule exists — this batch is genuinely ad-hoc');

  step('Complete run 0 → advancing to scenario 1 trips the run-budget guard, parking the batch (the wedge)');
  const run0 = batch0.run_ids[0];
  const c0 = await mcp.callTool('complete_qa_run', { run_id: run0, workspace_id: ws.id, status: 'passed', summary: 's0 ok' });
  assert.ok(!c0?.isError, `complete run0: ${JSON.stringify(c0)}`);

  const wedged = await mcp.callTool('get_qa_batch', { batch_id: batchId, workspace_id: ws.id });
  assert.equal(wedged.status, 'running', 'batch parked running, not finalized off the transient rejection');
  assert.equal(wedged.current_index, 1, 'cursor parked at the budget-rejected index');
  assert.equal(wedged.run_ids.length, 1, 'no run recorded for the rejected index — the wedge signature');

  step('Sweep 1 (still within the budget window): the reaper attempts the resume and hits the SAME rejection — batch stays wedged, no phantom run');
  const sweep1 = await batchReaper.runOnce();
  assert.deepEqual(sweep1.resumed, [batchId], 'the reaper identified this batch as wedged and attempted to resume it');

  const stillWedged = await mcp.callTool('get_qa_batch', { batch_id: batchId, workspace_id: ws.id });
  assert.equal(stillWedged.status, 'running', 'still wedged — the run-budget window has not cleared yet');
  assert.equal(stillWedged.run_ids.length, 1, 'resume retried and hit the same rejection again — no phantom run created');

  step('Raise the workspace run-budget ceiling (the window clears) and sweep again — the resume actually dispatches the remaining index');
  await ds.getRepository('Workspace').update(ws.id, {
    hard_budget_config: JSON.stringify({ max_runs_per_window: 10, window_minutes: 60, notify: false }),
  });
  const sweep2 = await batchReaper.runOnce();
  assert.deepEqual(sweep2.resumed, [batchId], 'the same batch is resumed again once the window clears');

  const resumed = await mcp.callTool('get_qa_batch', { batch_id: batchId, workspace_id: ws.id });
  assert.equal(resumed.run_ids.length, 2, 'the remaining index actually dispatched once the window cleared');
  const run1 = resumed.run_ids[1];
  assert.ok(run1, 'scenario 1 now has a real run');

  step('Complete run 1 → the batch reaches a terminal status with nothing burned as errored');
  const c1 = await mcp.callTool('complete_qa_run', { run_id: run1, workspace_id: ws.id, status: 'passed', summary: 's1 ok' });
  assert.ok(!c1?.isError, `complete run1: ${JSON.stringify(c1)}`);
  const done = await mcp.callTool('get_qa_batch', { batch_id: batchId, workspace_id: ws.id });
  assert.equal(done.status, 'done', 'batch fully resumed to completion with no schedule ever involved');
  assert.equal(done.errored, 0, 'no index was ever burned as errored across the wedge/resume cycle');
  assert.equal(done.passed, 2, 'both scenarios actually ran and passed');

  step('A further sweep is a no-op — the batch is terminal, not a candidate anymore');
  const sweep3 = await batchReaper.runOnce();
  assert.deepEqual(sweep3.resumed, [], 'a done batch is never swept again');

  exitAfterTests(0);
});
