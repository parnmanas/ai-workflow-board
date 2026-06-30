// Workspace scheduler MCP tools (ticket 769eb260) — exercises the
// create → run_now → list round-trip over the live MCP surface, on top of the
// foundation WorkspaceScheduleService (ticket 8845be79). Verifies the 6 tools
// are wired end-to-end (DI → ToolContext → tool → service) and that run_now
// opens a chat room without disturbing the automatic cadence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.WS_SCHED_MCP_PORT || '7842';

test('Workspace schedule MCP: create → run_now → list round-trip', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'ws-sched-mcp' });
  // The schedule both dispatches to, and authenticates as, this agent.
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'scheduled-worker' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'sched' });

  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  await mcp.initialize();
  assert.ok(mcp.sessionId, 'mcp session established');

  step('create_workspace_schedule (interval cadence)');
  const created = await mcp.callTool('create_workspace_schedule', {
    workspace_id: ws.id,
    name: 'nightly housekeeping',
    target_agent_id: agent.id,
    task_prompt: 'Run the nightly housekeeping checklist.',
    interval_ms: 3_600_000,
  });
  assert.ok(!created?.isError, `create should succeed: ${JSON.stringify(created)}`);
  assert.ok(created.id, 'created schedule has an id');
  assert.equal(created.target_agent_id, agent.id);
  assert.equal(created.interval_ms, 3_600_000);
  assert.equal(created.cron, null);
  assert.equal(created.enabled, true);
  assert.ok(created.next_run_at, 'next_run_at precomputed on create');
  const scheduleId = created.id;
  const nextRunBefore = created.next_run_at;

  step('cadence validation: both cron + interval is rejected');
  const bothErr = await mcp.callTool('create_workspace_schedule', {
    workspace_id: ws.id,
    name: 'bad',
    target_agent_id: agent.id,
    task_prompt: 'x',
    cron: '0 3 * * *',
    interval_ms: 5000,
  });
  assert.ok(bothErr?.isError, 'both cron + interval must error');

  step('get_workspace_schedule echoes the row');
  const got = await mcp.callTool('get_workspace_schedule', { schedule_id: scheduleId, workspace_id: ws.id });
  assert.equal(got.id, scheduleId);
  assert.equal(got.name, 'nightly housekeeping');

  step('run_workspace_schedule_now opens a room, leaves cadence untouched');
  const ran = await mcp.callTool('run_workspace_schedule_now', { schedule_id: scheduleId, workspace_id: ws.id });
  assert.ok(!ran?.isError, `run_now should succeed: ${JSON.stringify(ran)}`);
  assert.ok(ran.dispatch?.room_id, 'dispatch returns a room_id');
  assert.equal(ran.dispatch.agent_id, agent.id);
  assert.equal(ran.schedule.last_room_id, ran.dispatch.room_id, 'last_room_id stamped to the new room');
  assert.ok(ran.schedule.last_run_at, 'last_run_at stamped');
  assert.equal(ran.schedule.next_run_at, nextRunBefore, 'manual run must NOT disturb next_run_at');

  step('update_workspace_schedule patches the prompt');
  const updated = await mcp.callTool('update_workspace_schedule', {
    schedule_id: scheduleId,
    workspace_id: ws.id,
    task_prompt: 'Updated housekeeping prompt.',
  });
  assert.equal(updated.task_prompt, 'Updated housekeeping prompt.');

  step('list_workspace_schedules returns the schedule (all-scope)');
  const listed = await mcp.callTool('list_workspace_schedules', { workspace_id: ws.id });
  assert.ok(Array.isArray(listed), 'list returns an array');
  assert.ok(listed.find((s) => s.id === scheduleId), 'created schedule present in list');

  step('delete_workspace_schedule removes it');
  const del = await mcp.callTool('delete_workspace_schedule', { schedule_id: scheduleId, workspace_id: ws.id });
  assert.ok(del?.success, 'delete reports success');
  const afterDelete = await mcp.callTool('list_workspace_schedules', { workspace_id: ws.id });
  assert.ok(!afterDelete.find((s) => s.id === scheduleId), 'schedule gone after delete');

  await mcp.close();
  exitAfterTests(0);
});
