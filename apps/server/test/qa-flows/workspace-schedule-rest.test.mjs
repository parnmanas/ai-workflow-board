// Workspace scheduler REST surface (ticket 1927ed4a — client UI backend) —
// exercises the create → get → run-now → update → list → delete round-trip over
// the HTTP controller that backs the Workspace Settings editor. The MCP tools
// ticket (769eb260) deferred this controller; this test guards the route/DI
// wiring + the snake_case body ↔ camelCase service mapping the QaSchedule REST
// controller pattern (qa-scenario.controller.ts) is mirrored from. The service
// itself is unit-covered by workspace-schedule-behavior.test.mjs; here we only
// assert the controller layer (auth gate, field mapping, scheduleToJson shape).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createUser } from '../helpers/fixtures.mjs';

process.env.PORT = process.env.WS_SCHED_REST_PORT || '7843';

function makeClient(port, token) {
  const base = `http://localhost:${port}/api/workspace-schedules`;
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  return {
    async req(method, path, body) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...auth },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, json };
    },
  };
}

test('Workspace schedule REST: create → get → run-now → update → list → delete', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'ws-sched-rest' });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'scheduled-worker' });
  const admin = await createUser(app, getDataSourceToken, { name: 'sched-admin', role: 'admin' });
  const token = app.get(AuthService).createSession(admin.id);

  const client = makeClient(port, token);

  step('auth gate: no token → 401 (route is mounted, not 404)');
  const noAuth = await makeClient(port, null).req('GET', `?workspace_id=${ws.id}`);
  assert.equal(noAuth.status, 401, 'unauthenticated list must be 401, proving the route exists + is guarded');

  step('POST create (interval cadence)');
  const created = await client.req('POST', '', {
    workspace_id: ws.id,
    name: 'nightly housekeeping',
    target_agent_id: agent.id,
    task_prompt: 'Run the nightly housekeeping checklist.',
    interval_ms: 3_600_000,
  });
  assert.equal(created.status, 201, `create should 201: ${JSON.stringify(created.json)}`);
  const sched = created.json;
  assert.ok(sched.id, 'created schedule has an id');
  assert.equal(sched.target_agent_id, agent.id, 'snake_case target_agent_id mapped through');
  assert.equal(sched.task_prompt, 'Run the nightly housekeeping checklist.');
  assert.equal(sched.interval_ms, 3_600_000);
  assert.equal(sched.cron, null);
  assert.equal(sched.enabled, true);
  assert.ok(sched.next_run_at, 'next_run_at precomputed on create');
  assert.equal(sched.last_room_id, null, 'no room until a run');
  const id = sched.id;
  const nextRunBefore = sched.next_run_at;

  step('cadence validation: both cron + interval → 400');
  const bothErr = await client.req('POST', '', {
    workspace_id: ws.id, name: 'bad', target_agent_id: agent.id, task_prompt: 'x',
    cron: '0 3 * * *', interval_ms: 5000,
  });
  assert.equal(bothErr.status, 400, 'both cadences must 400');
  assert.match(bothErr.json?.error || '', /exactly one of cron or interval_ms/);

  step('GET one echoes the row');
  const got = await client.req('GET', `/${id}?workspace_id=${ws.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.id, id);
  assert.equal(got.json.name, 'nightly housekeeping');

  step('POST run-now opens a room + stamps last_room_id, leaves cadence untouched');
  const ran = await client.req('POST', `/${id}/run-now`, { workspace_id: ws.id });
  assert.equal(ran.status, 201, `run-now should 201: ${JSON.stringify(ran.json)}`);
  assert.ok(ran.json.dispatch?.room_id, 'dispatch returns a room_id');
  assert.equal(ran.json.dispatch.agent_id, agent.id);
  assert.equal(ran.json.schedule.last_room_id, ran.json.dispatch.room_id, 'last_room_id stamped to the new room (UI deep-link target)');
  assert.ok(ran.json.schedule.last_run_at, 'last_run_at stamped');
  assert.equal(ran.json.schedule.next_run_at, nextRunBefore, 'manual run must NOT disturb next_run_at');

  step('PATCH update (rename + switch to cron + disable)');
  const patched = await client.req('PATCH', `/${id}`, {
    workspace_id: ws.id, name: 'renamed', cron: '0 4 * * *', interval_ms: null, enabled: false,
  });
  assert.equal(patched.status, 200, `patch should 200: ${JSON.stringify(patched.json)}`);
  assert.equal(patched.json.name, 'renamed');
  assert.equal(patched.json.cron, '0 4 * * *');
  assert.equal(patched.json.interval_ms, null, 'interval cleared on cadence-kind switch');
  assert.equal(patched.json.enabled, false);
  assert.equal(patched.json.next_run_at, null, 'disabled → next_run_at null');

  step('GET list includes the schedule');
  const list = await client.req('GET', `?workspace_id=${ws.id}`);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json), 'list returns an array');
  assert.ok(list.json.some((s) => s.id === id), 'created schedule is listed');

  step('DELETE removes it');
  const del = await client.req('DELETE', `/${id}?workspace_id=${ws.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.success, true);
  const after = await client.req('GET', `/${id}?workspace_id=${ws.id}`);
  assert.equal(after.status, 404, 'deleted schedule is gone (404)');
});

exitAfterTests();
