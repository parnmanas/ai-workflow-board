// QA load/concurrency: many agents + many tickets + rapid column moves.
//
// Scale: 5 assignees, 20 tickets (one per assignee × 4), ~40 column moves
// fired in parallel. Asserts three invariants:
//
//   1. Delivery completeness: every expected (ticket, assignee) trigger is
//      received exactly once by its owning assignee within the deadline.
//   2. Scope isolation: no assignee receives an agent_trigger for a ticket
//      they don't own (cross-agent leak check).
//   3. Envelope integrity: trigger_source, role, agent_id, ticket_id match
//      what the emitting activity described (no field corruption under load).
//
// This is the hardest guarantee AWB makes — if it breaks, the whole
// "agents operate autonomously without blocking the user" model breaks —
// so a failure here is always a bug.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_CONCURRENCY_PORT || '7804';

const NUM_ASSIGNEES = 5;
const TICKETS_PER_ASSIGNEE = 4;

test('5 assignees × 4 tickets each: every trigger lands at the owning agent, no leakage', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken, ActivityService } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'concurrency',
  });
  const user = await createUser(app, getDataSourceToken, { name: 'driver' });

  // Materialize agents + virtual clients.
  const pool = [];
  for (let i = 0; i < NUM_ASSIGNEES; i++) {
    const agent = await createAgent(app, getDataSourceToken, ws.id, { name: `a${i}` });
    const key = await createApiKey(app, getDataSourceToken, agent.id, {
      workspaceId: ws.id,
      label: `a${i}`,
    });
    const va = new VirtualAgent({
      name: `a${i}`,
      agentId: agent.id,
      apiKey: key.raw_key,
      port,
    });
    pool.push({ agent, key, va });
  }
  await Promise.all(pool.map((p) => p.va.start()));
  t.after(async () => {
    await Promise.all(pool.map((p) => p.va.stop()));
  });
  await new Promise((r) => setTimeout(r, 400));

  // Materialize tickets: each assignee owns TICKETS_PER_ASSIGNEE tickets, all
  // sitting in the "In Progress" column so each move-emit triggers its owner.
  const tickets = [];
  for (const p of pool) {
    for (let j = 0; j < TICKETS_PER_ASSIGNEE; j++) {
      const t = await createTicket(app, getDataSourceToken, {
        columnId: columns.inProgress.id,
        workspaceId: ws.id,
        title: `t-${p.agent.name}-${j}`,
        assigneeId: p.agent.id,
        position: j,
      });
      tickets.push({ ticket: t, owner: p });
    }
  }

  step(`Fire ${NUM_ASSIGNEES * TICKETS_PER_ASSIGNEE} "moved" activities in parallel across ${NUM_ASSIGNEES} agents`);
  // Fire column_move activities for all tickets in parallel. A realistic
  // stress pattern: the moves are not queued through a single mutex, they
  // hit activityEvents simultaneously.
  const activityService = app.get(ActivityService);
  const moveAll = tickets.map(({ ticket }) =>
    activityService.logActivity({
      entity_type: 'ticket',
      entity_id: ticket.id,
      action: 'moved',
      ticket_id: ticket.id,
      new_value: 'In Progress',
      old_value: 'Todo',
      actor_id: user.id,
      actor_name: user.name,
    }),
  );
  await Promise.all(moveAll);

  // Give the bus time to drain. Budget ~40ms per trigger ceiling.
  const overallDeadline = Date.now() + Math.max(3000, tickets.length * 40);
  while (Date.now() < overallDeadline) {
    const total = pool.reduce((n, p) => n + p.va.triggers.length, 0);
    if (total >= tickets.length) break;
    await new Promise((r) => setTimeout(r, 80));
  }

  // Completeness + scope isolation checks.
  for (const p of pool) {
    const ownerTicketIds = new Set(
      tickets.filter((t) => t.owner === p).map((t) => t.ticket.id),
    );
    const received = p.va.triggers;
    assert.equal(
      received.length,
      TICKETS_PER_ASSIGNEE,
      `${p.agent.name}: expected ${TICKETS_PER_ASSIGNEE} triggers, got ${received.length}`,
    );
    const receivedSet = new Set(received.map((r) => r.ticket_id));
    for (const id of ownerTicketIds) {
      assert.ok(receivedSet.has(id), `${p.agent.name}: missing trigger for ${id}`);
    }
    // No leakage: every trigger must point at an owned ticket.
    for (const tr of received) {
      assert.ok(ownerTicketIds.has(tr.ticket_id), `${p.agent.name} leak: ${tr.ticket_id}`);
      assert.equal(tr.role, 'assignee');
      assert.equal(tr.agent_id, p.agent.id);
      assert.equal(tr.trigger_source, 'column_move');
    }
  }

  exitAfterTests(0);
});
