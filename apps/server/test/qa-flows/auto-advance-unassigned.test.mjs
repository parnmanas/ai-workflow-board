// QA flow: auto-advance on missing role holder.
//
// When a ticket lands on a non-terminal column whose routed role(s) have no
// holder assigned on the ticket, TriggerLoopService must push the ticket
// forward to the next non-terminal column. The cascade continues column-by-
// column until a column has a holder (which then receives the trigger) or the
// ticket runs out of non-terminal columns.
//
// Board topology for this test:
//   Todo (intake) → Plan (active, routes to 'planner') → In Progress (active,
//   routes to 'assignee') → Done (terminal).
//
// The ticket holds assignee + reviewer but NOT planner. Landing on Plan must
// auto-advance to In Progress, where the assignee receives the trigger.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createBoard,
  createColumn,
  createAgentTrio,
  createTicket,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_AUTO_ADVANCE_PORT || '7811';

test('Unheld routed column auto-advances ticket to next non-terminal column', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  const ws = await createWorkspace(app, getDataSourceToken, 'auto-advance');
  const board = await createBoard(app, getDataSourceToken, ws.id, {
    name: 'auto-adv-board',
    // Legacy routing_config blob kept aligned with role_routing for parity,
    // but the v0.41 trigger-loop reads BoardColumn.role_routing directly.
    routingConfig: {
      todo: ['assignee'],
      plan: ['planner'],
      'in progress': ['assignee'],
      done: ['reporter'],
    },
  });
  // Bind a board environment repo: since ticket 8c3befa8 an assignee dispatched
  // onto an active column with no resolvable base repo is pended, so this board
  // (whose assignee is expected to receive a trigger) must declare a code repo.
  const envDs = app.get(getDataSourceToken());
  const envRepo = await envDs.getRepository('Resource').save(
    envDs.getRepository('Resource').create({
      workspace_id: ws.id, name: 'auto-adv repo', type: 'repository',
      url: 'https://github.com/parnmanas/ai-workflow-board.git', default_branch: 'main',
    }),
  );
  await envDs.getRepository('Board').update(board.id, {
    environment_config: JSON.stringify({ repositories: [{ resource_id: envRepo.id }] }),
  });
  const todo = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Todo', position: 0, workspaceId: ws.id, kind: 'intake',
    roleRouting: ['assignee'],
  });
  const plan = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Plan', position: 1, workspaceId: ws.id, kind: 'active',
    roleRouting: ['planner'],
  });
  const inProgress = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress', position: 2, workspaceId: ws.id, kind: 'active',
    roleRouting: ['assignee'],
  });
  const done = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Done', position: 3, workspaceId: ws.id, isTerminal: true, kind: 'terminal',
    roleRouting: ['reporter'],
  });

  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);

  // Ticket has assignee + reviewer but NOT planner — Plan column will resolve
  // zero holders and must auto-advance to In Progress.
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: plan.id,
    workspaceId: ws.id,
    title: 'Auto-advance on missing planner',
    assigneeId: trio.assignee.agent.id,
    reviewerId: trio.reviewer.agent.id,
    // reporterId left blank — irrelevant for this test
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

  step('Emit "moved" activity for ticket landing on Plan (no planner holder)');
  await app.get(ActivityService).logActivity({
    entity_type: 'ticket',
    entity_id: ticket.id,
    action: 'moved',
    field_changed: 'column',
    old_value: 'Todo',
    new_value: 'Plan',
    ticket_id: ticket.id,
    actor_id: 'test-user',
    actor_name: 'tester',
  });

  step('Wait for assignee trigger on In Progress (proves auto-advance reached it)');
  const trig = await assigneeAgent.waitForTrigger(
    (tr) => tr.ticket_id === ticket.id && tr.role === 'assignee',
    4000,
  );
  assert.equal(trig.role, 'assignee');

  step('Verify ticket actually moved to In Progress in DB');
  const ds = app.get(getDataSourceToken());
  const reloaded = await ds
    .getRepository('Ticket')
    .findOne({ where: { id: ticket.id } });
  assert.equal(
    reloaded.column_id,
    inProgress.id,
    `expected ticket to land on In Progress (${inProgress.id}), got ${reloaded.column_id}`,
  );

  step('Verify the auto-advance left an audit row with actor_id=auto-advance');
  const logs = await ds
    .getRepository('ActivityLog')
    .find({ where: { ticket_id: ticket.id, action: 'moved' } });
  const autoMove = logs.find((l) => l.actor_id === 'auto-advance');
  assert.ok(
    autoMove,
    `expected a 'moved' ActivityLog row with actor_id=auto-advance, got: ${JSON.stringify(logs.map((l) => l.actor_id))}`,
  );
  assert.equal(autoMove.trigger_source, 'auto_advance');
  assert.equal(autoMove.new_value, 'In Progress');

  exitAfterTests(0);
});
