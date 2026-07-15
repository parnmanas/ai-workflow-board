// QA flow: unpend wakes the ticket's current-column role holder
// (ticket a57517be — Ticket Blocking 개선, finding 2).
//
// What this proves
// ────────────────
//
// Before this fix, clearing `pending_user_action` only flipped the column
// flag and wrote a `field_changed='pending_user_action'` ActivityLog. That
// row does NOT route through the column-routing dispatch in
// TriggerLoopService._handleActivity (it's a field update, but on a ticket
// the focus selector was previously dropping while pending; the focus gate
// only re-opens on the NEXT incidental event, which can be many minutes
// or never depending on board activity). The result: unparking a ticket
// from the User tab silently failed to wake the assignee — the human
// would think they handed off, then nothing happened.
//
// The fix is that both `unpend_ticket` (MCP) and the REST PATCH that
// clears `pending_user_action` now explicitly call
// `TriggerLoopService.dispatchCurrentColumn(ticketId, 'unpend', actor)`
// after the flip. This test boots the real NestJS app, parks a ticket on
// an assignee-routed column, unparks it via the MCP tool, and asserts the
// virtual assignee receives an `agent_trigger` carrying `trigger_source:
// 'unpend'`.
//
// Acceptance:
//
//   1. While pending, no trigger reaches the assignee.
//   2. After the MCP `unpend_ticket` call, the assignee receives exactly
//      one `agent_trigger` for this ticket with `trigger_source='unpend'`.
//   3. After a second park + REST PATCH unpend, the assignee receives a
//      second `agent_trigger` with `trigger_source='unpend'` — proves the
//      REST surface also wires the dispatch (per finding 2 the UI handler
//      at TicketPanel.tsx:718 uses PATCH).

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

test('Unpending a ticket emits an agent_trigger to the current column role holder (MCP + REST)', async (t) => {
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
  // Case 1: MCP `unpend_ticket` wakes the assignee.
  // ──────────────────────────────────────────────────────────────────
  step('Call MCP unpend_ticket via the driver client');
  const unpendRes = await driverVA.mcp.callTool('unpend_ticket', { ticket_id: ticket.id });
  assert.ok(unpendRes && !unpendRes.isError,
    `unpend_ticket MCP call failed: ${JSON.stringify(unpendRes)}`);
  assert.equal(unpendRes.pending_user_action, false,
    'unpend_ticket response must report pending_user_action=false');

  step('Wait for agent_trigger with trigger_source=unpend on assignee SSE stream');
  const mcpTrig = await assigneeVA.waitForTrigger(
    (tr) => tr.ticket_id === ticket.id && tr.trigger_source === 'unpend',
    4000,
  );
  assert.equal(mcpTrig.role, 'assignee',
    'unpend trigger must carry role=assignee (the In Progress column routes to assignee)');

  // Exactly one unpend trigger for this ticket so far — dispatchCurrentColumn
  // dedupes per (role, holder) and the assignee is the only holder routed.
  const mcpUnpendTriggers = assigneeVA.triggersFor(ticket.id)
    .filter((tr) => tr.trigger_source === 'unpend');
  assert.equal(mcpUnpendTriggers.length, 1,
    `MCP unpend must produce exactly one unpend trigger, got ${mcpUnpendTriggers.length}`);

  // ──────────────────────────────────────────────────────────────────
  // Case 2: REST PATCH `pending_user_action=false` also wakes the assignee.
  // This is the surface the UI's "Resume" button calls
  // (apps/client/src/components/TicketPanel.tsx:718).
  // ──────────────────────────────────────────────────────────────────
  step('Re-park the ticket so we can prove the REST PATCH path also wakes');
  await ticketRepo.update(ticket.id, {
    pending_user_action: true,
    pending_reason: 'second park',
    pending_set_at: new Date(),
    pending_set_by: 'qa-fixture',
  });
  // Brief settle so any incidental activity from the re-park finishes
  // before we measure the REST PATCH effect.
  await new Promise((r) => setTimeout(r, 100));

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

  step('Wait for a SECOND agent_trigger with trigger_source=unpend');
  // Counts BEFORE the wait so we don't re-match the case-1 trigger.
  const priorUnpendCount = assigneeVA.triggersFor(ticket.id)
    .filter((tr) => tr.trigger_source === 'unpend').length;
  const deadline = Date.now() + 4000;
  let restUnpendCount = priorUnpendCount;
  while (Date.now() < deadline) {
    restUnpendCount = assigneeVA.triggersFor(ticket.id)
      .filter((tr) => tr.trigger_source === 'unpend').length;
    if (restUnpendCount > priorUnpendCount) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(restUnpendCount, priorUnpendCount + 1,
    `REST PATCH unpend must produce one additional unpend trigger (had ${priorUnpendCount}, now ${restUnpendCount})`);

  // Driver was not the role holder — must never have received a trigger.
  assert.equal(driverVA.triggersFor(ticket.id).length, 0,
    'driver (MCP caller, not a role holder) must not receive any agent_trigger');

  exitAfterTests(0);
});
