// QA flow: sequential batch run (QaRunBatch) — ticket daf06262.
//
// The whole point of a batch is that scenarios run ONE AT A TIME: a QaRun is
// dispatched async (start returns before the run completes), so the next
// scenario must only dispatch after the current run reaches a terminal status.
// This test drives a 3-scenario batch over MCP HTTP and asserts the three
// acceptance points from the ticket's 검증 section:
//
//   1. Sequential dispatch — starting the batch dispatches ONLY scenario 0;
//      scenarios 1 and 2 have no run until their turn.
//   2. Failure does not break the chain — a failed run still advances the batch
//      to the next scenario (default stop_on_fail=false).
//   3. Idempotency — re-finalizing an already-advanced run does NOT
//      double-dispatch the next scenario or double-count the rollup.
//
// Plus the terminal rollup: passed/failed counts and status=done at the end.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_BATCH_SEQ_PORT || '7861';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function scenarioPayload(wsId, agentId, name) {
  return {
    workspace_id: wsId,
    target_agent_id: agentId,
    name,
    qa_driver: 'http-api',
    steps: [{ idx: 0, action: `noop for ${name}`, expect: 'ok' }],
  };
}

test('QA batch: sequential dispatch, failure-continue, idempotent advance', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'qa-batch' });
  const qaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'qa-batch-runner' });
  const qaKey = await createApiKey(app, getDataSourceToken, qaAgent.id, { workspaceId: ws.id, label: 'qa' });

  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: qaKey.raw_key });
  t.after(() => { void mcp.close().catch(() => {}); });

  // ── Build 3 scenarios ───────────────────────────────────────────────────────
  step('Create 3 QA scenarios for the batch');
  const names = ['batch-s0', 'batch-s1', 'batch-s2'];
  const scenarios = [];
  for (const n of names) {
    const sc = await mcp.callTool('create_qa_scenario', scenarioPayload(ws.id, qaAgent.id, n));
    assert.ok(!sc?.isError && sc.id, `create ${n} failed: ${JSON.stringify(sc)}`);
    scenarios.push(sc);
  }
  const [s0, s1, s2] = scenarios;

  const runCount = async (scenarioId) => {
    const runs = await mcp.callTool('list_qa_runs', { scenario_id: scenarioId, workspace_id: ws.id });
    return Array.isArray(runs) ? runs : [];
  };

  // ── 1. start_qa_batch dispatches ONLY scenario 0 ─────────────────────────────
  step('start_qa_batch — only the first scenario dispatches');
  const batch0 = await mcp.callTool('start_qa_batch', {
    workspace_id: ws.id,
    scenario_ids: [s0.id, s1.id, s2.id],
  });
  assert.ok(!batch0?.isError && batch0.id, `start_qa_batch failed: ${JSON.stringify(batch0)}`);
  assert.equal(batch0.total, 3, 'batch tracks all 3 scenarios');
  assert.equal(batch0.current_index, 0, 'cursor at index 0');
  assert.equal(batch0.status, 'running');
  assert.equal(batch0.run_ids.length, 1, 'exactly one run dispatched');
  assert.ok(batch0.run_ids[0], 'run 0 id present');

  assert.equal((await runCount(s0.id)).length, 1, 'scenario 0 has a run');
  assert.equal((await runCount(s1.id)).length, 0, 'scenario 1 NOT dispatched yet');
  assert.equal((await runCount(s2.id)).length, 0, 'scenario 2 NOT dispatched yet');
  const run0 = batch0.run_ids[0];

  // ── 2. A failed run still advances to the next scenario ──────────────────────
  step('complete run 0 as FAILED → batch advances to scenario 1 (chain not broken)');
  const c0 = await mcp.callTool('complete_qa_run', { run_id: run0, workspace_id: ws.id, status: 'failed', summary: 's0 failed' });
  assert.ok(!c0?.isError, `complete run0: ${JSON.stringify(c0)}`);

  let batch = await mcp.callTool('get_qa_batch', { batch_id: batch0.id, workspace_id: ws.id });
  assert.equal(batch.current_index, 1, 'cursor advanced to 1 despite the failure');
  assert.equal(batch.status, 'running');
  assert.equal(batch.failed, 1, 'failure tallied');
  assert.equal(batch.run_ids.length, 2, 'scenario 1 now dispatched');
  assert.equal((await runCount(s1.id)).length, 1, 'scenario 1 has a run');
  assert.equal((await runCount(s2.id)).length, 0, 'scenario 2 STILL not dispatched — strictly sequential');
  const run1 = batch.run_ids[1];
  assert.ok(run1 && run1 !== run0, 'run 1 is a distinct run');

  // ── 3. Idempotency — re-finalizing run 0 must not double-dispatch ────────────
  step('re-complete run 0 → no double-dispatch, no double-count (idempotent guard)');
  const c0again = await mcp.callTool('complete_qa_run', { run_id: run0, workspace_id: ws.id, status: 'failed', summary: 's0 failed again' });
  assert.ok(!c0again?.isError, `re-complete run0: ${JSON.stringify(c0again)}`);
  batch = await mcp.callTool('get_qa_batch', { batch_id: batch0.id, workspace_id: ws.id });
  assert.equal(batch.current_index, 1, 'cursor unchanged after re-finalize of an already-advanced run');
  assert.equal(batch.failed, 1, 'failure count NOT double-incremented');
  assert.equal(batch.run_ids.length, 2, 'no extra run dispatched');
  assert.equal(batch.run_ids[1], run1, 'scenario 1 run id unchanged');
  assert.equal((await runCount(s2.id)).length, 0, 'scenario 2 still not dispatched');

  // ── Advance through the rest ─────────────────────────────────────────────────
  step('complete run 1 as PASSED → scenario 2 dispatches');
  await mcp.callTool('complete_qa_run', { run_id: run1, workspace_id: ws.id, status: 'passed', summary: 's1 ok' });
  batch = await mcp.callTool('get_qa_batch', { batch_id: batch0.id, workspace_id: ws.id });
  assert.equal(batch.current_index, 2, 'cursor at last index');
  assert.equal(batch.passed, 1);
  assert.equal(batch.run_ids.length, 3, 'scenario 2 dispatched');
  assert.equal((await runCount(s2.id)).length, 1, 'scenario 2 finally has a run');
  const run2 = batch.run_ids[2];

  step('complete run 2 as PASSED → batch is done with the right rollup');
  await mcp.callTool('complete_qa_run', { run_id: run2, workspace_id: ws.id, status: 'passed', summary: 's2 ok' });
  batch = await mcp.callTool('get_qa_batch', { batch_id: batch0.id, workspace_id: ws.id });
  assert.equal(batch.status, 'done', 'batch terminal after last scenario');
  assert.equal(batch.passed, 2, 'two passed');
  assert.equal(batch.failed, 1, 'one failed');
  assert.equal(batch.errored, 0, 'none errored');
  assert.ok(batch.finished_at, 'finished_at stamped');

  // Re-finalize after done — must remain a no-op (status guard).
  step('re-complete a run after the batch is done → still done, rollup unchanged');
  await mcp.callTool('complete_qa_run', { run_id: run2, workspace_id: ws.id, status: 'passed', summary: 's2 again' });
  batch = await mcp.callTool('get_qa_batch', { batch_id: batch0.id, workspace_id: ws.id });
  assert.equal(batch.status, 'done');
  assert.equal(batch.passed, 2, 'rollup frozen after done');
  assert.equal(batch.run_ids.length, 3, 'no extra dispatch after done');
});

exitAfterTests();
