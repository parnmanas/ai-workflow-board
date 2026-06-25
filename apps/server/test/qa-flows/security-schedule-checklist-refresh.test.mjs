// QA e2e: security SCHEDULE of kind='checklist_refresh' (ticket e07ea821).
//
// The scan scheduler (7c07c19d) only periodically runs inspection batches. This
// ticket adds a `kind` to SecuritySchedule so a schedule can periodically (or via
// run-now) REFRESH each in-scope profile's checklist instead — the
// refresh_security_checklist path, which creates NO SecurityRun row. Covers the
// ticket's 검증 section against the real services + DB (not stubs):
//
//   • A due kind='checklist_refresh' schedule, fired by the real scheduler tick
//     (SecurityScheduleService.runOnce), dispatches a refresh per in-scope ENABLED
//     profile and creates ZERO SecurityRun rows (scan history untouched).
//   • scope='all' resolves enabled profiles at dispatch time (the disabled profile
//     is skipped); scope='selected' refreshes exactly the listed ids.
//   • run_security_schedule_now on a checklist_refresh schedule returns
//     kind='checklist_refresh', batch=null, and a per-profile refreshes[] list.
//   • Regression: a kind='scan' schedule run-now still kicks a batch (kind='scan',
//     batch set, refreshes null).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_SECURITY_SCHED_REFRESH_PORT || '7838';

test('security schedule kind=checklist_refresh: tick refreshes profiles, creates no run row; run-now is kind-discriminated', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'sec-sched-refresh' });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'inspector' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'inspector' });

  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  await mcp.initialize();

  // Grab the real scheduler service so we can drive ONE deterministic sweep with a
  // controlled `now` (the same seam the behavior unit test + the REST tick hook use).
  const { SecurityScheduleService } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'security', 'security-schedule.service.js')
  );
  const scheduler = app.get(SecurityScheduleService);

  step('two enabled profiles + one disabled — scope=all must skip the disabled one');
  const mkProfile = async (name, enabled) => {
    const p = await mcp.callTool('create_security_profile', {
      workspace_id: ws.id,
      name,
      target_agent_id: agent.id,
      scan_driver: 'code-review',
      enabled,
      checklist: [{ id: 'sqli', title: 'SQL injection', severity_hint: 'critical' }],
    });
    assert.ok(!p.isError, `create profile failed: ${JSON.stringify(p)}`);
    return p;
  };
  const pA = await mkProfile('profile-A', true);
  const pB = await mkProfile('profile-B', true);
  const pDisabled = await mkProfile('profile-disabled', false);

  step('create a kind=checklist_refresh schedule, scope=all');
  const sched = await mcp.callTool('create_security_schedule', {
    workspace_id: ws.id,
    name: 'weekly-checklist-refresh',
    kind: 'checklist_refresh',
    scope: 'all',
    interval_ms: 3_600_000, // 1h — far in the future, we force-fire with a future `now`
    enabled: true,
  });
  assert.ok(!sched.isError, `create schedule failed: ${JSON.stringify(sched)}`);
  assert.equal(sched.kind, 'checklist_refresh', 'kind round-trips through the MCP surface');
  assert.ok(sched.next_run_at, 'next_run_at computed on create');

  step('force one scheduler sweep with a future `now` so the schedule is due');
  const future = new Date(Date.now() + 2 * 3_600_000); // +2h, well past next_run_at
  const sweep = await scheduler.runOnce(future);
  assert.deepEqual(sweep.dispatched, [sched.id], 'the due checklist_refresh schedule is dispatched');
  assert.deepEqual(sweep.skipped, [], 'nothing skipped');

  step('refresh creates NO SecurityRun rows for any profile (scan history untouched)');
  for (const p of [pA, pB, pDisabled]) {
    const runs = await mcp.callTool('list_security_runs', { profile_id: p.id, workspace_id: ws.id });
    assert.ok(Array.isArray(runs) && runs.length === 0, `profile ${p.name} must have zero runs after a refresh`);
  }

  step('scope=all resolved enabled profiles only — a refresh room per enabled profile, none for the disabled one');
  // Each refresh dispatch creates a ChatRoom named "Security checklist refresh: <name>".
  // bootApp forces DB_TYPE=sqlite, so use sqlite (?) placeholders.
  const ds = app.get(getDataSourceToken());
  const rooms = await ds.query(
    `SELECT name FROM chat_rooms WHERE workspace_id = ? AND name LIKE 'Security checklist refresh:%'`,
    [ws.id],
  );
  const roomNames = rooms.map((r) => r.name).sort();
  assert.deepEqual(
    roomNames,
    ['Security checklist refresh: profile-A', 'Security checklist refresh: profile-B'],
    'exactly the two enabled profiles got a refresh room (disabled skipped)',
  );

  step('idempotency: a second sweep at the same `now` re-dispatches nothing (cursor already advanced)');
  const sweep2 = await scheduler.runOnce(future);
  assert.deepEqual(sweep2.dispatched, [], 'next_run_at advanced past `now` → no re-dispatch');

  step("scope='selected' run-now: kind-discriminated result, batch=null, refreshes lists the selected profile");
  const selSched = await mcp.callTool('create_security_schedule', {
    workspace_id: ws.id,
    name: 'selected-refresh',
    kind: 'checklist_refresh',
    scope: 'selected',
    profile_ids: [pA.id],
    interval_ms: 3_600_000,
    enabled: false, // run-now ignores enabled
  });
  assert.ok(!selSched.isError, `create selected schedule failed: ${JSON.stringify(selSched)}`);
  const selRun = await mcp.callTool('run_security_schedule_now', { schedule_id: selSched.id, workspace_id: ws.id });
  assert.ok(!selRun.isError, `run-now failed: ${JSON.stringify(selRun)}`);
  assert.equal(selRun.kind, 'checklist_refresh');
  assert.equal(selRun.batch, null, 'no batch for a checklist_refresh run-now');
  assert.ok(Array.isArray(selRun.refreshes) && selRun.refreshes.length === 1, 'one profile refreshed');
  assert.equal(selRun.refreshes[0].profile_id, pA.id, 'exactly the selected profile');
  // still no runs
  const runsA = await mcp.callTool('list_security_runs', { profile_id: pA.id, workspace_id: ws.id });
  assert.equal(runsA.length, 0, 'selected refresh still creates no run row');

  step('regression: a kind=scan schedule run-now still kicks a batch (kind=scan, batch set, refreshes null)');
  const scanSched = await mcp.callTool('create_security_schedule', {
    workspace_id: ws.id,
    name: 'scan-sched',
    kind: 'scan',
    scope: 'selected',
    profile_ids: [pA.id],
    interval_ms: 3_600_000,
    enabled: false,
  });
  assert.ok(!scanSched.isError, `create scan schedule failed: ${JSON.stringify(scanSched)}`);
  assert.equal(scanSched.kind, 'scan', 'default/explicit scan kind');
  const scanRun = await mcp.callTool('run_security_schedule_now', { schedule_id: scanSched.id, workspace_id: ws.id });
  assert.ok(!scanRun.isError, `scan run-now failed: ${JSON.stringify(scanRun)}`);
  assert.equal(scanRun.kind, 'scan');
  assert.equal(scanRun.refreshes, null, 'scan run-now has no refreshes');
  assert.ok(scanRun.batch && scanRun.batch.id, 'scan run-now kicks a batch');
  // the scan batch DID stack a run for pA (the regression: scan path still works)
  const runsAfterScan = await mcp.callTool('list_security_runs', { profile_id: pA.id, workspace_id: ws.id });
  assert.ok(runsAfterScan.length >= 1, 'scan batch stacked a SecurityRun (scan path intact)');

  await mcp.close();
  exitAfterTests(0);
});
