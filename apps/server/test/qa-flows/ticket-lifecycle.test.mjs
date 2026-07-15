// QA flow: full ticket lifecycle with three virtual agents (reporter /
// assignee / reviewer). Proves the core AWB promise end-to-end:
//
//   (user moves Todo → In Progress)
//     → TriggerLoopService routes via Board.routing_config
//       → agent_trigger SSE fires ONLY at the assignee agent
//   (user moves In Progress → Review)
//     → agent_trigger SSE fires ONLY at the reviewer agent
//   (user moves Review → Done)   [Done is is_terminal=true]
//     → NO trigger (terminal columns suppress routing)
//
// Each agent is a VirtualAgent with its own API-key-scoped SSE stream and
// MCP HTTP client. Cross-agent isolation is asserted at every step.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgentTrio,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_LIFECYCLE_PORT || '7801';

test('Ticket lifecycle: Todo → In Progress → Review → Done routes triggers by role', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  step('Seed kanban scene (workspace + board + 5 columns + routing_config)');
  const { ws, board: _board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'lifecycle',
    envRepo: true,
  });
  step('Create assignee/reporter/reviewer agent trio with API keys');
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const user = await createUser(app, getDataSourceToken, { name: 'driver' });

  step('Create lifecycle test ticket in Todo column');
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'Lifecycle test ticket',
    promptText: 'Please progress me through the board.',
    assigneeId: trio.assignee.agent.id,
    reporterId: trio.reporter.agent.id,
    reviewerId: trio.reviewer.agent.id,
  });

  // Each agent exposes an onTrigger that pulls ticket detail via the
  // get_ticket MCP tool — proving the MCP round-trip works for real agents
  // reacting to SSE events.
  const agentFactory = (role, trioEntry) =>
    new VirtualAgent({
      name: role,
      agentId: trioEntry.agent.id,
      apiKey: trioEntry.key.raw_key,
      port,
      onTrigger: async ({ mcp, trigger }) => {
        const resp = await mcp.callTool('get_ticket', { ticket_id: trigger.ticket_id });
        trigger._fetched_title = resp?.title || resp?.error || null;
      },
    });
  step('Start three virtual agents (SSE + MCP initialize)');
  const assigneeAgent = agentFactory('assignee', trio.assignee);
  const reporterAgent = agentFactory('reporter', trio.reporter);
  const reviewerAgent = agentFactory('reviewer', trio.reviewer);
  await Promise.all([assigneeAgent.start(), reporterAgent.start(), reviewerAgent.start()]);
  t.after(async () => {
    await Promise.all([assigneeAgent.stop(), reporterAgent.stop(), reviewerAgent.stop()]);
  });
  await new Promise((r) => setTimeout(r, 200));

  const activityService = app.get(modules.ActivityService);
  const ticketRepo = app.get(getDataSourceToken()).getRepository('Ticket');

  step('STEP 1: Move ticket Todo → In Progress');
  await ticketRepo.update(ticket.id, { column_id: columns.inProgress.id });
  await activityService.logActivity({
    entity_type: 'ticket',
    entity_id: ticket.id,
    action: 'moved',
    field_changed: 'column',
    old_value: 'Todo',
    new_value: 'In Progress',
    ticket_id: ticket.id,
    actor_id: user.id,
    actor_name: user.name,
  });

  step('Wait for agent_trigger on assignee SSE stream');
  const trig1 = await assigneeAgent.waitForTrigger(
    (t) => t.ticket_id === ticket.id && t.role === 'assignee',
    4000,
  );
  assert.equal(trig1.agent_id, trio.assignee.agent.id, 'assignee trigger agent_id');
  assert.equal(trig1.trigger_source, 'column_move');
  assert.ok(trig1.ticket_prompt?.includes('progress me'), 'ticket_prompt carries fresh prompt_text');
  assert.ok(typeof trig1.role_prompt === 'string', 'role_prompt present');

  // Let onTrigger's MCP round-trip complete.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(trig1._fetched_title, ticket.title, 'assignee fetched ticket via MCP get_ticket');

  assert.equal(reporterAgent.triggersFor(ticket.id).length, 0, 'reporter leak');
  assert.equal(reviewerAgent.triggersFor(ticket.id).length, 0, 'reviewer leak');
  step('STEP 1 OK: assignee received trigger, reporter+reviewer quiet');

  step('STEP 2: Move ticket In Progress → Review');
  await ticketRepo.update(ticket.id, { column_id: columns.review.id });
  await activityService.logActivity({
    entity_type: 'ticket',
    entity_id: ticket.id,
    action: 'moved',
    field_changed: 'column',
    old_value: 'In Progress',
    new_value: 'Review',
    ticket_id: ticket.id,
    actor_id: user.id,
    actor_name: user.name,
  });

  const trig2 = await reviewerAgent.waitForTrigger(
    (tr) => tr.ticket_id === ticket.id && tr.role === 'reviewer',
    4000,
  );
  assert.equal(trig2.agent_id, trio.reviewer.agent.id);
  assert.equal(assigneeAgent.triggersFor(ticket.id).length, 1, 'assignee stays at 1');
  assert.equal(reporterAgent.triggersFor(ticket.id).length, 0);
  step('STEP 2 OK: reviewer received trigger');

  step('STEP 3: Move ticket Review → Done (terminal — expect NO trigger)');
  await ticketRepo.update(ticket.id, { column_id: columns.done.id });
  await activityService.logActivity({
    entity_type: 'ticket',
    entity_id: ticket.id,
    action: 'moved',
    field_changed: 'column',
    old_value: 'Review',
    new_value: 'Done',
    ticket_id: ticket.id,
    actor_id: user.id,
    actor_name: user.name,
  });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(
    assigneeAgent.triggersFor(ticket.id).length +
      reporterAgent.triggersFor(ticket.id).length +
      reviewerAgent.triggersFor(ticket.id).length,
    2,
    'Terminal Done must not emit a third trigger',
  );
  assert.equal(assigneeAgent.triggers.length, 1);
  assert.equal(reviewerAgent.triggers.length, 1);
  step('STEP 3 OK: terminal column suppressed routing; final counts 1/0/1');

  exitAfterTests(0);
});
