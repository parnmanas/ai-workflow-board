// Server-side gate — pending_user_action drops a ticket from getAllocatedTickets
// (ticket 52eedadf).
//
// This is the SERVER half of the durable provisioning-block boundary. When the
// agent-manager pends a ticket after a durable provisioning failure (see
// apps/agent-manager/src/lib/event-dispatcher.ts + dispatch-preflight.ts, and
// its manager-side integration test provisioning-block-pend.test.mjs), the
// supervisor must stop re-triggering it. The KEY is that BOTH trigger kinds run
// off the SAME AllocationService.getAllocatedTickets set:
//   - the NORMAL wake-up (TriggerLoopService) only emits for allocated tickets
//     (and re-drops at emit time via its own pending gate), and
//   - the FORCED respawn (TicketSupervisorService) calls
//     getAllocatedTickets(agent.id, ws.id) before deciding any force_respawn, so
//     a ticket missing from that set is never force-respawned.
// So proving getAllocatedTickets EXCLUDES a pending ticket proves the manager's
// pend_ticket actually halts BOTH normal and forced triggers — closing the ~6h
// respawn loop of the source incident (c47194d9), where circuit-open retries and
// forced respawns kept firing after the provisioning failure.
//
// Acceptance:
//   1. An active, assigned, non-pending ticket IS allocated (baseline).
//   2. Flipping pending_user_action=true drops it → the supervisor's per-agent
//      loop has no row to force and the normal loop has nothing to wake.
//   3. Clearing the flag re-includes it (proving the pend flag is the cause, not
//      some unrelated exclusion).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from './helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createBoard,
  createColumn,
  createTicket,
} from './helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

// Port 7847 — unique slot (see the free-port scan in the sibling QA tests).
process.env.PORT = process.env.QA_PROV_PENDING_GATE_PORT || '7847';

test('pending_user_action drops a ticket from getAllocatedTickets — the server gate the supervisor consumes for BOTH normal and forced triggers', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const allocationServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'allocation.service.js')
  );
  const allocation = app.get(allocationServiceModule.AllocationService);

  step('Seed workspace + assignee agent + board with an active (In Progress) column');
  const ws = await createWorkspace(app, getDataSourceToken, 'prov-pending');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'rolf' });
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'code' });
  const inProgress = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  await createColumn(app, getDataSourceToken, board.id, {
    name: 'Done', position: 2, workspaceId: ws.id, isTerminal: true, kind: 'terminal', roleRouting: [],
  });

  // Assigned to the agent (createTicket writes the assignee TicketRoleAssignment)
  // in a non-terminal, assignee-routed column — the exact shape a durable
  // provisioning failure would keep re-triggering.
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: inProgress.id, workspaceId: ws.id, title: 'durable-blocked', assigneeId: agent.id,
  });
  const ticketRepo = ds.getRepository('Ticket');

  const allocatedIds = async () => {
    const rows = await allocation.getAllocatedTickets(agent.id, ws.id);
    assert.ok(Array.isArray(rows), `getAllocatedTickets returned an error: ${JSON.stringify(rows)}`);
    return rows.map((r) => r.ticket_id);
  };

  // 1. Baseline — the active, assigned, non-pending ticket IS allocated.
  step('Baseline — active assigned ticket IS allocated');
  const baseline = await allocatedIds();
  assert.ok(baseline.includes(ticket.id),
    `baseline: assigned active ticket must be allocated (got ${JSON.stringify(baseline)})`);

  // 2. Pend it (exactly what the manager's pend_ticket does) → excluded, so the
  //    supervisor stops forcing AND the normal loop stops waking it.
  step('Pended — getAllocatedTickets drops it (blocks BOTH normal and forced triggers)');
  await ticketRepo.update(ticket.id, {
    pending_user_action: true,
    pending_reason: 'durable provisioning block',
    pending_set_at: new Date(),
    pending_set_by: 'agent-manager',
  });
  const whilePended = await allocatedIds();
  assert.ok(!whilePended.includes(ticket.id),
    `pending ticket must be excluded from getAllocatedTickets (got ${JSON.stringify(whilePended)})`);

  // 3. Clear (operator unpend) → re-included, proving the pend flag is the cause.
  step('Unpended — clearing the flag re-includes it (proves the pend flag is the cause)');
  await ticketRepo.update(ticket.id, {
    pending_user_action: false, pending_reason: '', pending_set_at: null, pending_set_by: '',
  });
  const afterClear = await allocatedIds();
  assert.ok(afterClear.includes(ticket.id),
    `unpended ticket must be allocated again (got ${JSON.stringify(afterClear)})`);

  exitAfterTests(0);
});
