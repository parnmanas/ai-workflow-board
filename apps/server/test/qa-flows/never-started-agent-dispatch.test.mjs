// QA flow (ticket bfdd80b7): a ticket dispatched to a NEVER-STARTED agent must
// NOT silently drop. Boots the real NestJS app and drives a dispatch through the
// full TriggerLoopService._emitTrigger chokepoint, then asserts every user-facing
// signal the ticket requires:
//   (2) an explicit `dispatch_deferred` ticket ACTIVITY (rides the live SSE), and
//       a board-visible "dispatch 보류" system COMMENT projected from it;
//   (3) an AUTO-START (spawn_agent) command issued to the agent's live manager,
//       with the agent marked "starting" so the UI reflects it.
//
// Real app, real wire (the ActivityLog row + agent_manager_command event are the
// same artifacts the board / agent-manager see) — the automated stand-in for the
// "activity 로그 증거" the ticket's completion condition asks for.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createTicket, addRoleHolder } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

const BASE_PORT = parseInt(process.env.QA_NEVER_STARTED_PORT || '7913', 10);
process.env.PORT = String(BASE_PORT);

test('never-started agent ticket dispatch → activity + comment + spawn_agent auto-start', async (t) => {
  const { app, modules } = await bootApp({ port: BASE_PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());

  const triggerLoopMod = await import('file://' + path.join(DIST_ROOT, 'modules', 'agents', 'trigger-loop.service.js'));
  const instanceRegMod = await import('file://' + path.join(DIST_ROOT, 'modules', 'agent-manager', 'instance-registry.service.js'));
  const agentStatusMod = await import('file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-status.service.js'));
  const triggerLoop = app.get(triggerLoopMod.TriggerLoopService);
  const registry = app.get(instanceRegMod.InstanceRegistryService);
  const agentStatus = app.get(agentStatusMod.AgentStatusService);

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'never-started' });

  // A live manager + a NEVER-STARTED managed agent it supervises (is_online=0,
  // connected_at=null, but a working_dir + a heartbeating manager → auto-start
  // is feasible).
  const manager = await createAgent(app, getDataSourceToken, ws.id, { name: 'boss', type: 'manager' });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker', type: 'claude' });
  await ds.getRepository('Agent').update(worker.id, {
    manager_agent_id: manager.id, working_dir: '/work/worker', is_online: 0, connected_at: null,
  });

  // Register a live manager instance so resolveLiveManagerInstance() finds it.
  registry.upsert({
    instance_id: 'inst-e2e', agent_id: manager.id, workspace_id: ws.id, mode: 'manager',
    hostname: 'host', plugin_version: 'test', cli: 'claude', cli_adapters: [], pid: 1,
    started_at: new Date().toISOString(), agent_ids: [],
  });

  // Ticket assigned to the never-started worker, sitting in In Progress.
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'never-started dispatch', assigneeId: worker.id,
  });
  await addRoleHolder(app, getDataSourceToken, { ticketId: ticket.id, workspaceId: ws.id, agentId: worker.id, slug: 'assignee' });

  // Capture spawn_agent command emissions on the shared bus.
  const commands = [];
  const cmdListener = (e) => commands.push(e);
  activityEvents.on('agent_manager_command', cmdListener);

  // Drive a real dispatch through the full chokepoint (bypassFocus so the focus
  // window doesn't independently drop it — we're exercising the reachability
  // feedback, not the focus gate).
  await triggerLoop.emitAgentTrigger(ticket, worker.id, 'assignee', 'column_move', 'system', { bypassFocus: true });

  // SystemCommentService projects the activity → comment asynchronously off the bus.
  await new Promise((r) => setTimeout(r, 150));
  activityEvents.removeListener('agent_manager_command', cmdListener);

  // (req 2) explicit ticket activity — the live-SSE `dispatch_deferred` row.
  const activityRows = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: ticket.id, action: 'dispatch_deferred' },
  });
  assert.ok(activityRows.length >= 1, 'a dispatch_deferred activity was logged for the ticket');
  assert.match(activityRows[0].new_value, /자동 시작/, 'activity message states an auto-start was requested');

  // (req 2) board-visible system comment projected from that activity.
  const comments = await ds.getRepository('Comment').find({
    where: { ticket_id: ticket.id, author_type: 'system' },
  });
  const deferComment = comments.find((c) => /dispatch 보류/.test(c.content));
  assert.ok(deferComment, 'a "dispatch 보류" system comment is visible on the ticket');

  // (req 3) auto-start attempted via spawn_agent to the live manager.
  const spawn = commands.find((c) => c.command === 'spawn_agent' && c.args?.agent_id === worker.id);
  assert.ok(spawn, 'spawn_agent auto-start was issued to the manager');
  assert.equal(spawn.instance_id, 'inst-e2e', 'targeted the worker\'s live manager instance');
  assert.equal(spawn.args.working_dir, '/work/worker', 'hydrated the worker working_dir server-side');

  // (req 3/4) worker marked "starting" so the agent-list badge reflects it.
  assert.equal(agentStatus.isStarting(worker.id), true, 'worker marked starting for the UI');

  // ── ticket 1f750878 #1: the manager reports the spawn FAILED (pool_exhausted /
  // working_dir / apiKey …). Before this the server only knew the command was
  // dispatched, so the badge silently reverted 시작 중→미시작 when the 3-min marker
  // expired. Now the /command/ack error is routed to markStartError on the SPAWN
  // TARGET, surfacing lifecycle_state=error + the concrete reason. Drive the REAL
  // controller ack (same code path the manager's REST ack hits).
  const amcMod = await import('file://' + path.join(DIST_ROOT, 'modules', 'agent-manager', 'agent-manager.controller.js'));
  const controller = app.get(amcMod.AgentManagerController);

  // Capture the agent_status the failure will broadcast for the worker's badge.
  const statuses = [];
  const stListener = (e) => { if (e && e.agent_id === worker.id) statuses.push(e); };
  activityEvents.on('agent_status', stListener);

  const FAIL_DETAIL = 'spawn_agent: pool_exhausted (E2E)';
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await controller.commandAck(
    { command_id: spawn.command_id, status: 'error', detail: FAIL_DETAIL },
    // Ack signed by the supervising manager (the ledger's agent_id) so the
    // ownership check passes — this is exactly what AgentAuthGuard resolves.
    { currentAgentId: manager.id },
    res,
  );
  await new Promise((r) => setTimeout(r, 60)); // _emitAgentById is async off the bus
  activityEvents.removeListener('agent_status', stListener);

  assert.equal(res.statusCode, 200, 'the ack was accepted');
  assert.equal(agentStatus.isStarting(worker.id), false, 'starting marker cleared — no silent 시작 중→미시작 revert');
  assert.equal(agentStatus.getStartError(worker.id), FAIL_DETAIL, 'server recorded the manager-side spawn-failure reason via markStartError');
  const errStatus = statuses.find((s) => s.lifecycle_state === 'error');
  assert.ok(errStatus, 'an agent_status with lifecycle_state=error was broadcast for the badge');
  assert.equal(errStatus.lifecycle_detail, FAIL_DETAIL, 'the concrete failure reason ships as lifecycle_detail (구체 사유 표면화)');

  exitAfterTests();
});
