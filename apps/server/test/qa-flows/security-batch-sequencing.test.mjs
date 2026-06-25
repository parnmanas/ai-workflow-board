// QA flow: sequential security batch (SecurityRunBatch) — ticket 7c07c19d.
//
// The whole point of "수동 전체 점검" is that profiles run ONE AT A TIME: a
// SecurityRun is dispatched async (start returns before the run completes), so
// the next profile must only dispatch after the current run reaches a terminal
// status. This test drives a 3-profile batch over MCP HTTP and asserts the
// acceptance points from the ticket's 검증 section:
//
//   1. Sequential dispatch — starting the batch dispatches ONLY profile 0;
//      profiles 1 and 2 have no run until their turn (동시 금지).
//   2. Failure does not break the chain — a failed run still advances the batch
//      to the next profile (default stop_on_fail=false).
//   3. Idempotency — re-finalizing an already-advanced run does NOT
//      double-dispatch the next profile or double-count the rollup.
//
// Plus the terminal rollup: passed/failed counts and status=done at the end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.SECURITY_BATCH_SEQ_PORT || '7864';

function profilePayload(wsId, agentId, name) {
  return {
    workspace_id: wsId,
    target_agent_id: agentId,
    name,
    scan_driver: 'code-review',
    scope_mode: 'full',
    checklist: [{ id: 'authz', title: 'Broken access control', category: 'authz', severity_hint: 'high' }],
  };
}

test('security batch: sequential dispatch, failure-continue, idempotent advance', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'security-batch' });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'security-batch-runner' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'sec' });

  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => { void mcp.close().catch(() => {}); });

  // ── Build 3 profiles ─────────────────────────────────────────────────────────
  step('Create 3 security profiles for the batch');
  const names = ['batch-p0', 'batch-p1', 'batch-p2'];
  const profiles = [];
  for (const n of names) {
    const p = await mcp.callTool('create_security_profile', profilePayload(ws.id, agent.id, n));
    assert.ok(!p?.isError && p.id, `create ${n} failed: ${JSON.stringify(p)}`);
    profiles.push(p);
  }
  const [p0, p1, p2] = profiles;

  const runCount = async (profileId) => {
    const runs = await mcp.callTool('list_security_runs', { profile_id: profileId, workspace_id: ws.id });
    return Array.isArray(runs) ? runs : [];
  };

  // ── 1. start_security_batch dispatches ONLY profile 0 ────────────────────────
  step('start_security_batch — only the first profile dispatches');
  const batch0 = await mcp.callTool('start_security_batch', {
    workspace_id: ws.id,
    profile_ids: [p0.id, p1.id, p2.id],
  });
  assert.ok(!batch0?.isError && batch0.id, `start_security_batch failed: ${JSON.stringify(batch0)}`);
  assert.equal(batch0.total, 3, 'batch tracks all 3 profiles');
  assert.equal(batch0.current_index, 0, 'cursor at index 0');
  assert.equal(batch0.status, 'running');
  assert.equal(batch0.run_ids.length, 1, 'exactly one run dispatched');
  assert.ok(batch0.run_ids[0], 'run 0 id present');

  assert.equal((await runCount(p0.id)).length, 1, 'profile 0 has a run');
  assert.equal((await runCount(p1.id)).length, 0, 'profile 1 NOT dispatched yet');
  assert.equal((await runCount(p2.id)).length, 0, 'profile 2 NOT dispatched yet');
  const run0 = batch0.run_ids[0];

  // ── 2. A failed run still advances to the next profile ───────────────────────
  step('complete run 0 as FAILED → batch advances to profile 1 (chain not broken)');
  const c0 = await mcp.callTool('complete_security_run', { run_id: run0, workspace_id: ws.id, status: 'failed', summary: 'p0 failed' });
  assert.ok(!c0?.isError, `complete run0: ${JSON.stringify(c0)}`);

  let batch = await mcp.callTool('get_security_batch', { batch_id: batch0.id, workspace_id: ws.id });
  assert.equal(batch.current_index, 1, 'cursor advanced to 1 despite the failure');
  assert.equal(batch.status, 'running');
  assert.equal(batch.failed, 1, 'failure tallied');
  assert.equal(batch.run_ids.length, 2, 'profile 1 now dispatched');
  assert.equal((await runCount(p1.id)).length, 1, 'profile 1 has a run');
  assert.equal((await runCount(p2.id)).length, 0, 'profile 2 STILL not dispatched — strictly sequential');
  const run1 = batch.run_ids[1];
  assert.ok(run1 && run1 !== run0, 'run 1 is a distinct run');

  // ── 3. Idempotency — re-finalizing run 0 must not double-dispatch ────────────
  step('re-complete run 0 → no double-dispatch, no double-count (idempotent guard)');
  const c0again = await mcp.callTool('complete_security_run', { run_id: run0, workspace_id: ws.id, status: 'failed', summary: 'p0 failed again' });
  assert.ok(!c0again?.isError, `re-complete run0: ${JSON.stringify(c0again)}`);
  batch = await mcp.callTool('get_security_batch', { batch_id: batch0.id, workspace_id: ws.id });
  assert.equal(batch.current_index, 1, 'cursor unchanged after re-finalize of an already-advanced run');
  assert.equal(batch.failed, 1, 'failure count NOT double-incremented');
  assert.equal(batch.run_ids.length, 2, 'no extra run dispatched');
  assert.equal(batch.run_ids[1], run1, 'profile 1 run id unchanged');
  assert.equal((await runCount(p2.id)).length, 0, 'profile 2 still not dispatched');

  // ── Advance through the rest ─────────────────────────────────────────────────
  step('complete run 1 as PASSED → profile 2 dispatches');
  await mcp.callTool('complete_security_run', { run_id: run1, workspace_id: ws.id, status: 'passed', scanned_commit: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', summary: 'p1 ok' });
  batch = await mcp.callTool('get_security_batch', { batch_id: batch0.id, workspace_id: ws.id });
  assert.equal(batch.current_index, 2, 'cursor at last index');
  assert.equal(batch.passed, 1);
  assert.equal(batch.run_ids.length, 3, 'profile 2 dispatched');
  assert.equal((await runCount(p2.id)).length, 1, 'profile 2 finally has a run');
  const run2 = batch.run_ids[2];

  step('complete run 2 as PASSED → batch is done with the right rollup');
  await mcp.callTool('complete_security_run', { run_id: run2, workspace_id: ws.id, status: 'passed', scanned_commit: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', summary: 'p2 ok' });
  batch = await mcp.callTool('get_security_batch', { batch_id: batch0.id, workspace_id: ws.id });
  assert.equal(batch.status, 'done', 'batch terminal after last profile');
  assert.equal(batch.passed, 2, 'two passed');
  assert.equal(batch.failed, 1, 'one failed');
  assert.equal(batch.errored, 0, 'none errored');
  assert.ok(batch.finished_at, 'finished_at stamped');

  // Re-finalize after done — must remain a no-op (status guard).
  step('re-complete a run after the batch is done → still done, rollup unchanged');
  await mcp.callTool('complete_security_run', { run_id: run2, workspace_id: ws.id, status: 'passed', summary: 'p2 again' });
  batch = await mcp.callTool('get_security_batch', { batch_id: batch0.id, workspace_id: ws.id });
  assert.equal(batch.status, 'done');
  assert.equal(batch.passed, 2, 'rollup frozen after done');
  assert.equal(batch.run_ids.length, 3, 'no extra dispatch after done');
});

exitAfterTests();
