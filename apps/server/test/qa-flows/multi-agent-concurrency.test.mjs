// QA load/concurrency: many agents + many tickets + rapid column moves.
//
// Scale: 5 assignees, 20 tickets (one per assignee × 4), ~40 column moves
// fired in parallel.
//
// SINGLE-FOCUS DISPATCH MODEL (ticket 4a6cdfd7): the trigger loop delivers at
// most ONE trigger per (agent, board, role) — the agent's current focus ticket.
// Non-focus triggers are silently dropped so a board with N parked tickets
// doesn't thrash the agent. So firing 4 moves per agent yields exactly 1
// delivered trigger per agent (its focus), not 4. The earlier "every parked
// ticket triggers" expectation predated the focus model (quarantined → 5e5959ef).
//
// Invariants asserted here (the ones that still matter under the focus model):
//   1. Liveness: every assignee is woken — each receives exactly one focus trigger.
//   2. Scope isolation: no assignee receives an agent_trigger for a ticket they
//      don't own (cross-agent leak check) — the security-critical guarantee.
//   3. Envelope integrity: trigger_source, role, agent_id, ticket_id match what
//      the emitting activity described (no field corruption under load).
//
// Scope isolation breaking is always a bug — it means the whole "agents operate
// autonomously without blocking the user" model leaks across tenants.

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
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  // Each assignee owns TICKETS_PER_ASSIGNEE tickets and we fire all of them
  // in parallel. The production-default per-board cap is 1 (migration
  // 1760000000012), which would queue all but the first trigger per agent
  // and fail the completeness assertion below. The test is about delivery /
  // isolation, not cap enforcement, so we bump the cap above the per-agent
  // ticket count.
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'concurrency',
    maxConcurrent: TICKETS_PER_ASSIGNEE,
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

  // Give the bus time to drain. Under the single-focus model each agent gets
  // exactly one delivered trigger, so the completion target is NUM_ASSIGNEES,
  // not tickets.length. Wait a beat past first delivery so any (buggy) extra /
  // leaked trigger would also have landed and be caught below.
  const overallDeadline = Date.now() + Math.max(3000, tickets.length * 40);
  while (Date.now() < overallDeadline) {
    const woken = pool.filter((p) => p.va.triggers.length >= 1).length;
    if (woken >= NUM_ASSIGNEES) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  // Small settle window so a stray non-focus / cross-agent trigger (the bug this
  // test guards against) has time to arrive and fail the assertions.
  await new Promise((r) => setTimeout(r, 300));

  // Liveness + scope isolation + envelope integrity under the focus model.
  for (const p of pool) {
    const ownerTicketIds = new Set(
      tickets.filter((t) => t.owner === p).map((t) => t.ticket.id),
    );
    const received = p.va.triggers;
    // Liveness: exactly one focus trigger per agent — not 0 (agent never woken)
    // and not >1 (non-focus triggers must be dropped, not thrash the agent).
    assert.equal(
      received.length,
      1,
      `${p.agent.name}: expected exactly 1 focus trigger, got ${received.length}`,
    );
    // The delivered trigger must be one of this agent's own tickets, and every
    // field must be intact — no cross-agent leak, no envelope corruption.
    for (const tr of received) {
      assert.ok(ownerTicketIds.has(tr.ticket_id), `${p.agent.name} leak: ${tr.ticket_id}`);
      assert.equal(tr.role, 'assignee');
      assert.equal(tr.agent_id, p.agent.id);
      assert.equal(tr.trigger_source, 'column_move');
    }
  }

  exitAfterTests(0);
});
