// QA load/concurrency: many agents + many tickets + rapid column moves.
//
// Scale: 5 assignees, 20 tickets (one per assignee × 4), ~40 column moves
// fired in parallel.
//
// TOP-N FOCUS WINDOW MODEL (ticket 4a6cdfd7 → generalized top-N in 701e5e36):
// the trigger loop delivers up to N triggers per agent per board, where
// N = `max_concurrent_tickets_per_agent` ("Agent concurrency"). The agent's
// focus WINDOW is its top-N ranked tickets; anything ranked below N is silently
// dropped so a board with many parked tickets doesn't thrash the agent. Here
// the board cap is bumped to TICKETS_PER_ASSIGNEE and each agent owns exactly
// that many tickets (all in In Progress), so every one of an agent's tickets
// sits inside its window — firing 4 moves per agent yields 4 delivered triggers
// (one per owned ticket), directly exercising the N>1 concurrency path.
//
// Invariants asserted here:
//   1. Liveness + concurrency: every assignee is woken and receives exactly N
//      triggers — one per owned ticket, all inside its top-N window. (Under the
//      old single-focus model this was capped at 1; ticket 701e5e36 lifted it.)
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

test('5 assignees × 4 tickets each, cap=4: all N triggers land at the owning agent, no leakage', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  // Each assignee owns TICKETS_PER_ASSIGNEE tickets and we fire all of them
  // in parallel. The production-default per-board cap is 1 (migration
  // 1760000000012), which would admit only the top-1 window ticket per agent.
  // We set the cap EQUAL to the per-agent ticket count so every owned ticket
  // fits inside the agent's top-N window — exercising the N>1 concurrency path
  // and asserting all N triggers land (not just one).
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

  // Give the bus time to drain. Under the top-N window model each agent gets
  // one delivered trigger per owned ticket (all inside its cap=N window), so
  // the completion target is the full tickets.length. Wait a beat past the
  // last delivery so any (buggy) extra / leaked / over-cap trigger would also
  // have landed and be caught below.
  const expectedTotal = NUM_ASSIGNEES * TICKETS_PER_ASSIGNEE;
  const overallDeadline = Date.now() + Math.max(3000, tickets.length * 40);
  while (Date.now() < overallDeadline) {
    const total = pool.reduce((n, p) => n + p.va.triggers.length, 0);
    if (total >= expectedTotal) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  // Small settle window so a stray over-cap / cross-agent trigger (the bugs this
  // test guards against) has time to arrive and fail the assertions.
  await new Promise((r) => setTimeout(r, 300));

  // Liveness + concurrency + scope isolation + envelope integrity under the
  // top-N window model.
  for (const p of pool) {
    const ownerTicketIds = new Set(
      tickets.filter((t) => t.owner === p).map((t) => t.ticket.id),
    );
    const received = p.va.triggers;
    // Concurrency: exactly N triggers per agent (N = TICKETS_PER_ASSIGNEE = the
    // board cap) — one per owned ticket. Not 0 (agent never woken) and not >N
    // (the window must cap admission, not thrash the agent with over-cap emits).
    assert.equal(
      received.length,
      TICKETS_PER_ASSIGNEE,
      `${p.agent.name}: expected ${TICKETS_PER_ASSIGNEE} window triggers (cap=N), got ${received.length}`,
    );
    // Every delivered trigger must be a DISTINCT ticket this agent owns, with
    // every field intact — no cross-agent leak, no duplicate, no envelope
    // corruption.
    const seenTicketIds = new Set();
    for (const tr of received) {
      assert.ok(ownerTicketIds.has(tr.ticket_id), `${p.agent.name} leak: ${tr.ticket_id}`);
      assert.ok(!seenTicketIds.has(tr.ticket_id), `${p.agent.name} duplicate trigger for ${tr.ticket_id}`);
      seenTicketIds.add(tr.ticket_id);
      assert.equal(tr.role, 'assignee');
      assert.equal(tr.agent_id, p.agent.id);
      assert.equal(tr.trigger_source, 'column_move');
    }
  }

  exitAfterTests(0);
});

// OVER-CAP DROP (storm-prevention, ticket 701e5e36 요구 2):
// The test above runs cap == owned-ticket-count, so every owned ticket fits the
// window and all N are admitted — it never exercises the admission BOUNDARY.
// Here the agent owns MORE tickets than the cap (4 > 2), so the top-N window
// must admit exactly `cap` triggers and SILENTLY DROP the surplus. This is the
// invariant that stops a To Do backlog from re-triggering the agent every
// supervisor tick (the GameClient 2026-05-12 storm). We assert on the COUNT and
// scope only — not which specific tickets win the rank tie-break — so the test
// stays coupled to the admission cap, not to internal ordering details.
const OVER_CAP = 2;
const OWNED_OVER_CAP = 4;

test(`over-cap: 1 assignee owns ${OWNED_OVER_CAP} tickets, cap=${OVER_CAP} → exactly ${OVER_CAP} admitted, surplus dropped`, async (t) => {
  const port = parseInt(process.env.QA_CONCURRENCY_OVERCAP_PORT || '7805', 10);
  const { app, port: boundPort, modules } = await bootApp({ port });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'concurrency-overcap',
    maxConcurrent: OVER_CAP,
  });
  const user = await createUser(app, getDataSourceToken, { name: 'driver-overcap' });

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'oc0' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, {
    workspaceId: ws.id,
    label: 'oc0',
  });
  const va = new VirtualAgent({ name: 'oc0', agentId: agent.id, apiKey: key.raw_key, port: boundPort });
  await va.start();
  t.after(async () => { await va.stop(); });
  await new Promise((r) => setTimeout(r, 400));

  // All OWNED_OVER_CAP tickets sit in In Progress so each move-emit triggers the
  // owner — but only the top-OVER_CAP ranked fit the window.
  const owned = [];
  for (let j = 0; j < OWNED_OVER_CAP; j++) {
    const t2 = await createTicket(app, getDataSourceToken, {
      columnId: columns.inProgress.id,
      workspaceId: ws.id,
      title: `oc-t-${j}`,
      assigneeId: agent.id,
      position: j,
    });
    owned.push(t2);
  }

  step(`Fire ${OWNED_OVER_CAP} "moved" activities for one agent whose cap is ${OVER_CAP}`);
  const activityService = app.get(ActivityService);
  await Promise.all(owned.map((ticket) =>
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
  ));

  // Wait long enough that any (buggy) over-cap trigger would also have landed.
  // We deliberately wait past the point where OVER_CAP triggers arrive, then a
  // settle window, so a surplus emit shows up and fails the equality below.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (va.triggers.length >= OVER_CAP) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 500));

  const ownedIds = new Set(owned.map((o) => o.id));
  // Admission cap: exactly OVER_CAP delivered — the window admits the top-N and
  // drops the surplus (no storm).
  assert.equal(
    va.triggers.length,
    OVER_CAP,
    `over-cap admission: expected exactly ${OVER_CAP} window triggers, got ${va.triggers.length}`,
  );
  // Every admitted trigger is a distinct owned ticket (no leak, no duplicate).
  const seen = new Set();
  for (const tr of va.triggers) {
    assert.ok(ownedIds.has(tr.ticket_id), `leak: ${tr.ticket_id}`);
    assert.ok(!seen.has(tr.ticket_id), `duplicate trigger for ${tr.ticket_id}`);
    seen.add(tr.ticket_id);
    assert.equal(tr.role, 'assignee');
    assert.equal(tr.agent_id, agent.id);
    assert.equal(tr.trigger_source, 'column_move');
  }

  exitAfterTests(0);
});
