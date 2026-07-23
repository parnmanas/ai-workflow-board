// QA flow: unpend wakes the ticket's current-column role holder
// (ticket a57517be — Ticket Blocking 개선, finding 2) — and, since ticket
// b2e88390, clearing the park is HUMAN ONLY.
//
// What this proves
// ────────────────
//
// Before the a57517be fix, clearing `pending_user_action` only flipped the
// column flag and wrote a `field_changed='pending_user_action'` ActivityLog.
// That row does NOT route through the column-routing dispatch in
// TriggerLoopService._handleActivity (it's a field update, but on a ticket
// the focus selector was previously dropping while pending; the focus gate
// only re-opens on the NEXT incidental event, which can be many minutes
// or never depending on board activity). The result: unparking a ticket
// from the User tab silently failed to wake the assignee — the human
// would think they handed off, then nothing happened. The fix: the REST
// PATCH that clears `pending_user_action` explicitly calls
// `TriggerLoopService.dispatchCurrentColumn(ticketId, 'unpend', actor)`
// after the flip.
//
// ticket b2e88390 found that the MCP `unpend_ticket` tool offered agents the
// SAME clearing power with no actor-type check — any agent could self-clear
// a park it (or a sibling agent, or the respawn-storm circuit breaker) had
// just tripped, defeating the "explicit human decision" the flag exists to
// require. MCP has no authenticated user session to prove a human made the
// call (unlike REST, which sits behind AuthGuard), so the fix is that
// `unpend_ticket` now ALWAYS rejects. This test boots the real NestJS app,
// parks a ticket on an assignee-routed column, and asserts (1) the MCP tool
// is rejected and wakes nobody, while (2) the REST PATCH path (the ticket
// panel's Resume button) still works exactly as before.
//
// Acceptance:
//
//   1. While pending, no trigger reaches the assignee.
//   2. The MCP `unpend_ticket` call is rejected (isError) and leaves
//      pending_user_action=true — no trigger reaches the assignee.
//   3. After a REST PATCH unpend, the assignee receives an `agent_trigger`
//      with `trigger_source='unpend'` — proves the REST surface (the human
//      path) still wires the dispatch (per finding 2 the UI handler at
//      TicketPanel.tsx:718 uses PATCH).

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

// Unique port slot — picked above existing QA flows
// (mcp-roundtrip 7810, backlog-promotion-pending 7834).
process.env.PORT = process.env.QA_UNPEND_TRIGGER_PORT || '7836';

test('Unpending a ticket: MCP unpend_ticket is rejected (human-only), REST PATCH still wakes the role holder', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;

  step('Seed workspace + assignee-routed kanban + ticket parked on In Progress');
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'unpend-trig',
    envRepo: true,
  });
  const ticketRepo = app.get(getDataSourceToken()).getRepository('Ticket');

  // Two agents: `assignee` is the role holder on the ticket (gets woken).
  // `driver` is a workspace-scoped agent whose API key we use as the MCP
  // caller for the `unpend_ticket` invocation, so the trigger we observe
  // on the assignee SSE stream cannot be attributed to the caller itself
  // being the assignee.
  const assignee = await createAgent(app, getDataSourceToken, ws.id, { name: 'assignee' });
  const assigneeKey = await createApiKey(app, getDataSourceToken, assignee.id, {
    workspaceId: ws.id, label: 'assignee',
  });
  const driver = await createAgent(app, getDataSourceToken, ws.id, { name: 'driver' });
  const driverKey = await createApiKey(app, getDataSourceToken, driver.id, {
    workspaceId: ws.id, label: 'driver',
  });
  // User for the REST PATCH leg below — bears a session token.
  const user = await createUser(app, getDataSourceToken, { name: 'unpend-user' });
  const userToken = app.get(AuthService).createSession(user.id);
  assert.ok(userToken, 'AuthService.createSession returned a token');

  // Ticket sits on the assignee-routed "In Progress" column.
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id,
    workspaceId: ws.id,
    title: 'Park then unpend',
    assigneeId: assignee.id,
  });

  step('Park the ticket — pending_user_action=true');
  await ticketRepo.update(ticket.id, {
    pending_user_action: true,
    pending_reason: 'awaiting human nudge',
    pending_set_at: new Date(),
    pending_set_by: 'qa-fixture',
  });

  step('Start assignee VirtualAgent (SSE listener) + driver MCP client');
  const assigneeVA = new VirtualAgent({
    name: 'assignee', agentId: assignee.id, apiKey: assigneeKey.raw_key, port,
  });
  const driverVA = new VirtualAgent({
    name: 'driver', agentId: driver.id, apiKey: driverKey.raw_key, port,
  });
  await Promise.all([assigneeVA.start(), driverVA.start()]);
  t.after(async () => {
    await Promise.all([assigneeVA.stop(), driverVA.stop()]);
  });
  // Give SSE handlers a beat to register before any trigger flows.
  await new Promise((r) => setTimeout(r, 300));

  // Sanity guard: while pending, the ticket must not have any trigger
  // already queued for the assignee. If something incidental fires (e.g.
  // setupKanbanScene side effects), we'd see it before this point.
  assert.equal(
    assigneeVA.triggersFor(ticket.id).length, 0,
    'assignee must not receive any trigger while the ticket is pending',
  );

  // ──────────────────────────────────────────────────────────────────
  // Case 1 (ticket b2e88390): MCP `unpend_ticket` is REJECTED — human only.
  // MCP has no authenticated user session to prove a human made the call,
  // so the tool must refuse instead of clearing the flag and waking anyone.
  // ──────────────────────────────────────────────────────────────────
  step('Call MCP unpend_ticket via the driver client — must be rejected');
  const unpendRes = await driverVA.mcp.callTool('unpend_ticket', { ticket_id: ticket.id });
  assert.ok(unpendRes && unpendRes.isError,
    `unpend_ticket MCP call must be rejected (human-only), got: ${JSON.stringify(unpendRes)}`);

  step('Ticket must still be pending — the rejected call made no change');
  const stillPending = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(stillPending.pending_user_action, true,
    'a rejected unpend_ticket call must not clear pending_user_action');

  step('No agent_trigger reaches the assignee from the rejected MCP call');
  // Give any (incorrect) dispatch a beat to arrive before asserting absence.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    assigneeVA.triggersFor(ticket.id).filter((tr) => tr.trigger_source === 'unpend').length,
    0,
    'a rejected unpend_ticket call must not wake the assignee',
  );

  // ──────────────────────────────────────────────────────────────────
  // Case 2: REST PATCH `pending_user_action=false` — the human path — still
  // wakes the assignee. This is the surface the UI's "Resume" button calls
  // (apps/client/src/components/TicketPanel.tsx:718), and the only surface
  // left that can perform this transition after ticket b2e88390.
  // ──────────────────────────────────────────────────────────────────
  step('PATCH /api/tickets/:id pending_user_action=false via authenticated user');
  const patchRes = await fetch(`http://localhost:${port}/api/tickets/${ticket.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`,
      'X-Workspace-Id': ws.id,
    },
    body: JSON.stringify({ pending_user_action: false }),
  });
  assert.equal(patchRes.status, 200,
    `REST PATCH unpend must return 200, got ${patchRes.status}: ${await patchRes.text().catch(() => '')}`);

  step('Wait for the agent_trigger with trigger_source=unpend on assignee SSE stream');
  const restTrig = await assigneeVA.waitForTrigger(
    (tr) => tr.ticket_id === ticket.id && tr.trigger_source === 'unpend',
    4000,
  );
  assert.equal(restTrig.role, 'assignee',
    'unpend trigger must carry role=assignee (the In Progress column routes to assignee)');

  // Exactly one unpend trigger for this ticket — dispatchCurrentColumn
  // dedupes per (role, holder) and the assignee is the only holder routed.
  const restUnpendTriggers = assigneeVA.triggersFor(ticket.id)
    .filter((tr) => tr.trigger_source === 'unpend');
  assert.equal(restUnpendTriggers.length, 1,
    `REST PATCH unpend must produce exactly one unpend trigger, got ${restUnpendTriggers.length}`);

  // Driver was not the role holder — must never have received a trigger.
  assert.equal(driverVA.triggersFor(ticket.id).length, 0,
    'driver (MCP caller, not a role holder) must not receive any agent_trigger');

  exitAfterTests(0);
});
