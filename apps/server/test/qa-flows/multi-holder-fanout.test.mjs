// QA flow: 다중담당자 T2 dispatch fan-out to ALL holders.
//
// A single routed role (e.g. assignee) may now be held by several agents at
// once (T1 relaxed the TicketRoleAssignment uniqueness to (ticket, role,
// holder)). TriggerLoopService must fan a dispatch out to EVERY agent holder
// of the routed slug — not just the first — while:
//   - deduping by agent_id (a 겸직 agent wakes at most once), and
//   - applying the self-trigger guard PER HOLDER (the actor holder is skipped,
//     but the OTHER holders of the same role still fan out).
//
// Regression cover for DoD #1 (fan-out + dedup) and #2 (per-holder self-guard)
// of ticket 13fe29ba.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgentTrio,
  createAgent,
  createApiKey,
  createTicket,
  addRoleHolder,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

// Each test boots its own app; use distinct ports so a not-yet-released
// listener from the prior test can't collide (EADDRINUSE).
const BASE_PORT = parseInt(process.env.QA_MULTI_HOLDER_FANOUT_PORT || '7841', 10);
process.env.PORT = String(BASE_PORT);

test('multi-holder fan-out: two assignee holders both get triggered', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'mh-fanout' });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);

  // Holder A = trio.assignee (seeded by createTicket). Holder B = a second
  // agent added to the same assignee role. Actor = trio.reporter (NOT an
  // assignee holder) so neither self-guard branch fires and BOTH holders
  // should fan out.
  const holderB = {
    agent: await createAgent(app, getDataSourceToken, ws.id, { name: 'assignee-b' }),
  };
  holderB.key = await createApiKey(app, getDataSourceToken, holderB.agent.id, {
    workspaceId: ws.id, label: 'assignee-b',
  });

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'Multi-holder fan-out',
    assigneeId: trio.assignee.agent.id,
    reporterId: trio.reporter.agent.id,
  });
  await addRoleHolder(app, getDataSourceToken, {
    ticketId: ticket.id, workspaceId: ws.id, agentId: holderB.agent.id,
  });

  const agentA = new VirtualAgent({
    name: 'assignee-a', agentId: trio.assignee.agent.id, apiKey: trio.assignee.key.raw_key, port,
  });
  const agentB = new VirtualAgent({
    name: 'assignee-b', agentId: holderB.agent.id, apiKey: holderB.key.raw_key, port,
  });
  await Promise.all([agentA.start(), agentB.start()]);
  t.after(() => { agentA.stop(); agentB.stop(); });
  await new Promise((r) => setTimeout(r, 200));

  step('Move Todo → In Progress with actor = reporter (non-holder); BOTH assignee holders must fan out');
  await app.get(getDataSourceToken()).getRepository('Ticket')
    .update(ticket.id, { column_id: columns.inProgress.id });
  await app.get(modules.ActivityService).logActivity({
    entity_type: 'ticket',
    entity_id: ticket.id,
    action: 'moved',
    ticket_id: ticket.id,
    new_value: 'In Progress',
    actor_id: trio.reporter.agent.id,
    actor_name: trio.reporter.agent.name,
  });

  await new Promise((r) => setTimeout(r, 800));
  step('Verify both holder A and holder B received exactly one trigger');
  assert.equal(agentA.triggersFor(ticket.id).length, 1, 'holder A must be triggered');
  assert.equal(agentB.triggersFor(ticket.id).length, 1, 'holder B must be triggered (fan-out)');
});

test('per-holder self-guard: actor holder is skipped, other holder still fans out', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT + 1 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'mh-selfguard' });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const holderB = {
    agent: await createAgent(app, getDataSourceToken, ws.id, { name: 'assignee-b' }),
  };
  holderB.key = await createApiKey(app, getDataSourceToken, holderB.agent.id, {
    workspaceId: ws.id, label: 'assignee-b',
  });

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'Per-holder self-guard',
    assigneeId: trio.assignee.agent.id,
  });
  await addRoleHolder(app, getDataSourceToken, {
    ticketId: ticket.id, workspaceId: ws.id, agentId: holderB.agent.id,
  });

  const agentA = new VirtualAgent({
    name: 'assignee-a', agentId: trio.assignee.agent.id, apiKey: trio.assignee.key.raw_key, port,
  });
  const agentB = new VirtualAgent({
    name: 'assignee-b', agentId: holderB.agent.id, apiKey: holderB.key.raw_key, port,
  });
  await Promise.all([agentA.start(), agentB.start()]);
  t.after(() => { agentA.stop(); agentB.stop(); });
  await new Promise((r) => setTimeout(r, 200));

  step('Move Todo → In Progress with actor = holder A; A is same-role self-action (skip), B still fans out');
  await app.get(getDataSourceToken()).getRepository('Ticket')
    .update(ticket.id, { column_id: columns.inProgress.id });
  await app.get(modules.ActivityService).logActivity({
    entity_type: 'ticket',
    entity_id: ticket.id,
    action: 'moved',
    ticket_id: ticket.id,
    new_value: 'In Progress',
    actor_id: trio.assignee.agent.id,
    actor_name: trio.assignee.agent.name,
  });

  await new Promise((r) => setTimeout(r, 800));
  step('Verify actor holder A skipped (0), other holder B triggered (1)');
  assert.equal(agentA.triggersFor(ticket.id).length, 0, 'actor holder A must NOT self-trigger');
  assert.equal(agentB.triggersFor(ticket.id).length, 1, 'non-actor holder B must still fan out');

  exitAfterTests(0);
});
