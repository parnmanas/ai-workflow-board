// QA: security-inspection feature (SecurityProfile/SecurityRun) end-to-end over MCP.
//
// Drives the closed loop the foundation ticket (cfd74638) specifies:
//   create_security_profile → start_security_run → record_security_finding →
//   complete_security_run, then verifies the incremental-scoping mechanism:
//     • first run = FULL (no baseline) — scope_used='full', baseline_commit=null
//     • PASS advances the profile's last_passed_commit to the scanned commit
//     • second run = INCREMENTAL — scope_used='incremental', baseline_commit=<sha1>,
//       and the dispatched prompt carries `git diff <sha1>..HEAD`
//   plus finding upsert-by-id and start creating a ChatRoom.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_SECURITY_PORT || '7836';

const SHA1 = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

test('security inspection: profile CRUD + run roundtrip + incremental baseline advance', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'security' });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'inspector' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'inspector' });

  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  await mcp.initialize();

  step('create_security_profile (incremental, code-review driver)');
  const profile = await mcp.callTool('create_security_profile', {
    workspace_id: ws.id,
    name: 'AWB self code-review',
    description: 'baseline inspection',
    target_agent_id: agent.id,
    scan_driver: 'code-review',
    scope_mode: 'incremental',
    checklist: [
      { id: 'authz', title: 'Broken access control', category: 'authz', severity_hint: 'high' },
      { id: 'sqli', title: 'SQL injection', category: 'injection', severity_hint: 'critical' },
    ],
  });
  assert.ok(!profile.isError, `create failed: ${JSON.stringify(profile)}`);
  assert.equal(profile.scope_mode, 'incremental');
  assert.equal(profile.last_passed_commit, null, 'fresh profile has no baseline');
  assert.equal(profile.checklist.length, 2);

  step('list_security_profiles scope rule (workspace-scope "" finds it)');
  const wsScoped = await mcp.callTool('list_security_profiles', { workspace_id: ws.id, board_id: '' });
  assert.ok(Array.isArray(wsScoped) && wsScoped.some((p) => p.id === profile.id), 'workspace-scoped list returns the profile');

  step('start_security_run #1 — first run must be FULL (no baseline)');
  const start1 = await mcp.callTool('start_security_run', { profile_id: profile.id });
  assert.ok(!start1.isError, `start#1 failed: ${JSON.stringify(start1)}`);
  assert.ok(start1.run_id && start1.room_id, 'run#1 has run_id + room_id (ChatRoom created)');
  assert.match(start1.prompt, /Planned scope: FULL/, 'run#1 prompt says FULL');

  const run1a = await mcp.callTool('get_security_run', { run_id: start1.run_id, workspace_id: ws.id });
  assert.equal(run1a.status, 'running');
  assert.equal(run1a.scope_used, 'full', 'run#1 scope_used=full');
  assert.equal(run1a.baseline_commit, null, 'run#1 has no baseline');

  step('record_security_finding (upsert-by-id: record then overwrite the same id)');
  await mcp.callTool('record_security_finding', {
    run_id: start1.run_id, workspace_id: ws.id,
    finding: { id: 'f1', severity: 'low', title: 'minor', category: 'authz', checklist_item_id: 'authz' },
  });
  const afterUpsert = await mcp.callTool('record_security_finding', {
    run_id: start1.run_id, workspace_id: ws.id,
    finding: { id: 'f1', severity: 'medium', title: 'minor (revised)', category: 'authz' },
  });
  assert.equal(afterUpsert.findings.length, 1, 'same finding id upserts, not duplicates');
  assert.equal(afterUpsert.findings[0].severity, 'medium', 'finding overwritten');

  step('complete_security_run(passed, scanned_commit) — advances the profile baseline');
  const done1 = await mcp.callTool('complete_security_run', {
    run_id: start1.run_id, workspace_id: ws.id,
    status: 'passed', scanned_commit: SHA1, scope_used: 'full',
    summary: '0 critical/high',
  });
  assert.equal(done1.status, 'passed');
  assert.equal(done1.scanned_commit, SHA1);
  assert.ok(done1.finished_at, 'finished_at stamped');

  const profileAfter = await mcp.callTool('get_security_profile', { profile_id: profile.id });
  assert.equal(profileAfter.last_passed_commit, SHA1, 'PASS advanced last_passed_commit to scanned_commit');

  step('start_security_run #2 — now INCREMENTAL against the new baseline');
  const start2 = await mcp.callTool('start_security_run', { profile_id: profile.id });
  assert.ok(!start2.isError, `start#2 failed: ${JSON.stringify(start2)}`);
  assert.match(start2.prompt, /Planned scope: INCREMENTAL/, 'run#2 prompt says INCREMENTAL');
  assert.match(start2.prompt, new RegExp(`git diff --stat ${SHA1}\\.\\.HEAD`), 'run#2 prompt diffs baseline..HEAD');

  const run2 = await mcp.callTool('get_security_run', { run_id: start2.run_id, workspace_id: ws.id });
  assert.equal(run2.scope_used, 'incremental', 'run#2 scope_used=incremental');
  assert.equal(run2.baseline_commit, SHA1, 'run#2 baseline = prior PASS scanned_commit');

  step('list_security_runs returns both runs newest-first');
  const runs = await mcp.callTool('list_security_runs', { profile_id: profile.id, workspace_id: ws.id });
  assert.equal(runs.length, 2, 'two runs retained');
  assert.equal(runs[0].id, start2.run_id, 'newest run first');

  await mcp.close();
  exitAfterTests(0);
});
