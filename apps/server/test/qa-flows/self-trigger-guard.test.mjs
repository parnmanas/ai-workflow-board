// QA flow: self-trigger guard.
//
// When an agent is the *actor* on an activity that would otherwise route back
// to them (because they hold the role that the destination column delegates
// to), TriggerLoopService drops the emission. Without this guard, every
// agent action on one of its own tickets would echo back as a fresh trigger
// and the agent would spin.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgentTrio,
  createTicket,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_SELF_TRIGGER_PORT || '7807';

test('Agent acting on its own ticket does not receive a self-trigger', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'self' });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'Self-trigger guard',
    assigneeId: trio.assignee.agent.id,
  });

  const assigneeAgent = new VirtualAgent({
    name: 'assignee',
    agentId: trio.assignee.agent.id,
    apiKey: trio.assignee.key.raw_key,
    port,
  });
  await assigneeAgent.start();
  t.after(() => assigneeAgent.stop());
  await new Promise((r) => setTimeout(r, 200));

  step('Emit "moved" activity with actor_id === assignee.agent.id — guard MUST skip emission');
  // actor_id === target role-holder agent id → TriggerLoopService must skip.
  await app
    .get(getDataSourceToken())
    .getRepository('Ticket')
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

  await new Promise((r) => setTimeout(r, 700));
  step('Verify assignee.triggers.length === 0 (no self-trigger emitted)');
  assert.equal(
    assigneeAgent.triggersFor(ticket.id).length,
    0,
    'assignee must NOT trigger itself',
  );

  exitAfterTests(0);
});
