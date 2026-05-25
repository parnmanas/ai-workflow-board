// QA flow: BacklogPromotion pending-user-action exclusion (ticket a57517be).
//
// What this proves
// ────────────────
//
// `BacklogPromotionService.tryPromote` must filter out intake tickets
// with `pending_user_action=true` BEFORE candidate selection runs. A
// pending ticket is the human's to drive — if promotion picks it up
// `TriggerLoopService` drops every wake-up emit (the pending gate at
// trigger-loop.service.ts catches it), but the ticket has already
// moved into the active column. That leaves the workflow slot occupied
// with no driver and blocks the next non-pending backlog item from
// claiming focus, which is the exact "blocking" failure mode this
// ticket exists to fix.
//
// Acceptance:
//
//   1. Pending high-priority ticket is skipped; the next eligible
//      non-pending ticket is promoted in the same call.
//   2. When the only intake candidate is pending, tryPromote returns
//      null and writes no `backlog_promoted` audit row (so dashboards
//      don't report a phantom move).
//   3. Clearing the pending flag re-enables promotion on the next call.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createApiKey,
  createColumn,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

// Port 7834 — unique slot, doesn't collide with workflow-state-cap (7822),
// board-pause (7820) or backlog-promotion-chain (7821).
process.env.PORT = process.env.QA_BACKLOG_PENDING_PORT || '7834';

test('BacklogPromotion skips pending_user_action tickets and promotes the next eligible candidate', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;

  const backlogPromotionServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'backlog-promotion.service.js')
  );
  const backlogPromotion = app.get(backlogPromotionServiceModule.BacklogPromotionService);
  const ds = app.get(getDataSourceToken());

  step('Seed workspace + roles + driver user + assignee agent');
  const ws = await createWorkspace(app, getDataSourceToken, 'pending');
  await createUser(app, getDataSourceToken, { name: 'driver' });

  const roleRepo = ds.getRepository('WorkspaceRole');
  const assigneeRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'assignee' } });
  assert.ok(assigneeRole, 'createWorkspace should seed assignee role');

  const aliceAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
  await createApiKey(app, getDataSourceToken, aliceAgent.id, { workspaceId: ws.id, label: 'alice' });

  const boardRepo = ds.getRepository('Board');
  const colRepo = ds.getRepository('BoardColumn');
  const ticketRepo = ds.getRepository('Ticket');
  const activityLogRepo = ds.getRepository('ActivityLog');

  async function makeBoard(name) {
    const board = await boardRepo.save(boardRepo.create({
      name, description: '', workspace_id: ws.id,
      routing_config: JSON.stringify({}),
      max_concurrent_tickets_per_agent: 1,
    }));
    const backlog = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Backlog', position: 0, workspaceId: ws.id,
    });
    const todo = await createColumn(app, getDataSourceToken, board.id, {
      name: 'To Do', position: 1, workspaceId: ws.id,
    });
    const done = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Done', position: 2, workspaceId: ws.id, isTerminal: true,
    });
    await colRepo.update(backlog.id, { kind: 'intake', role_routing: JSON.stringify(['reporter']) });
    await colRepo.update(todo.id, { kind: 'active', role_routing: JSON.stringify(['assignee']) });
    await colRepo.update(done.id, { kind: 'terminal', role_routing: JSON.stringify([]) });
    return { board, backlog, todo, done };
  }

  async function readPromotionAuditFor(ticketId) {
    return activityLogRepo.find({ where: { ticket_id: ticketId, action: 'backlog_promoted' } });
  }

  // ────────────────────────────────────────────────────────────────────
  // Case 1: pending high-priority ticket is skipped, lower-priority
  // non-pending ticket is promoted in the same call.
  // ────────────────────────────────────────────────────────────────────
  step('Case 1 — pending critical ticket skipped, next non-pending ticket wins');
  const c1 = await makeBoard('pending-case1');

  // P — high priority but parked behind pending_user_action. Must NOT
  // be promoted even though it would normally be the highest-priority
  // candidate.
  const tP = await createTicket(app, getDataSourceToken, {
    columnId: c1.backlog.id, workspaceId: ws.id, title: 'P-pending-critical', priority: 'critical',
    assigneeId: aliceAgent.id,
  });
  await ticketRepo.update(tP.id, {
    pending_user_action: true,
    pending_reason: 'awaiting human decision',
    pending_set_at: new Date(),
    pending_set_by: 'qa-fixture',
  });

  // Create N AFTER P so created_at ordering can't accidentally favor it
  // — the only reason N wins must be the pending exclusion.
  await new Promise((r) => setTimeout(r, 10));
  const tN = await createTicket(app, getDataSourceToken, {
    columnId: c1.backlog.id, workspaceId: ws.id, title: 'N-nonpending-medium', priority: 'medium',
    assigneeId: aliceAgent.id,
  });

  step('  call tryPromote — expect N (non-pending medium) to win over P (pending critical)');
  const promoted1 = await backlogPromotion.tryPromote(c1.board.id);
  assert.equal(promoted1, tN.id,
    `expected non-pending N (${tN.id.slice(0, 8)}) to be promoted while pending P (${tP.id.slice(0, 8)}) is skipped, got ${promoted1?.slice(0, 8) || 'null'}`);

  step('  P stays in intake — pending exclusion prevented the slot grab');
  const tPAfter = await ticketRepo.findOne({ where: { id: tP.id } });
  assert.equal(tPAfter.column_id, c1.backlog.id,
    `pending ticket P must NOT have moved out of the intake column (column_id=${tPAfter.column_id}, expected ${c1.backlog.id})`);
  assert.equal(tPAfter.pending_user_action, true,
    'pending_user_action must remain true on the skipped ticket');

  step('  no backlog_promoted audit row exists for the pending ticket');
  const pendingAudit = await readPromotionAuditFor(tP.id);
  assert.equal(pendingAudit.length, 0,
    `pending ticket must not produce a backlog_promoted activity row (got ${pendingAudit.length})`);

  // ────────────────────────────────────────────────────────────────────
  // Case 2: only candidate is pending — tryPromote returns null, no
  // audit row, no phantom move.
  // ────────────────────────────────────────────────────────────────────
  step('Case 2 — only intake candidate is pending → tryPromote returns null');
  const c2 = await makeBoard('pending-case2');
  const tSolo = await createTicket(app, getDataSourceToken, {
    columnId: c2.backlog.id, workspaceId: ws.id, title: 'Solo-pending-high', priority: 'high',
    assigneeId: aliceAgent.id,
  });
  await ticketRepo.update(tSolo.id, {
    pending_user_action: true,
    pending_reason: 'blocked on user input',
    pending_set_at: new Date(),
    pending_set_by: 'qa-fixture',
  });

  const promoted2 = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(promoted2, null,
    `tryPromote must return null when every intake ticket is pending (got ${promoted2?.slice(0, 8) || 'null'})`);

  const tSoloAfter = await ticketRepo.findOne({ where: { id: tSolo.id } });
  assert.equal(tSoloAfter.column_id, c2.backlog.id,
    'pending solo ticket must still be in intake after the no-op promotion');
  const soloAudit = await readPromotionAuditFor(tSolo.id);
  assert.equal(soloAudit.length, 0,
    `no-op tryPromote must not write a backlog_promoted audit row (got ${soloAudit.length})`);

  // ────────────────────────────────────────────────────────────────────
  // Case 3: clearing the pending flag re-enables promotion.
  // ────────────────────────────────────────────────────────────────────
  step('Case 3 — clearing pending_user_action makes the same ticket promotable next cycle');
  await ticketRepo.update(tSolo.id, {
    pending_user_action: false,
    pending_reason: '',
    pending_set_at: null,
    pending_set_by: '',
  });

  const promoted3 = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(promoted3, tSolo.id,
    `after clearing pending_user_action the ticket must promote on the next call, got ${promoted3?.slice(0, 8) || 'null'}`);

  const tSoloAfterClear = await ticketRepo.findOne({ where: { id: tSolo.id } });
  assert.equal(tSoloAfterClear.column_id, c2.todo.id,
    'unparked ticket must have moved from backlog to first-active column');
  const clearedAudit = await readPromotionAuditFor(tSolo.id);
  assert.equal(clearedAudit.length, 1,
    `cleared ticket must produce exactly one backlog_promoted row (got ${clearedAudit.length})`);

  step('Audit-log evidence — backlog_promoted rows seen this run');
  const promotedRows = await activityLogRepo.find({ where: { action: 'backlog_promoted' } });
  for (const r of promotedRows) {
    console.log(`  ticket=${r.ticket_id.slice(0, 8)}  ${r.new_value || ''}`);
  }

  exitAfterTests(0);
});
