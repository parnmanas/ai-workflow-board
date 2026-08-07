// QA flow: BacklogPromotion level-triggered backstop + role-unfilled skip
// audit (ticket 9df6c348).
//
// What this proves
// ────────────────
//
// Item A — `tryPromote` was previously reachable ONLY via the `agent_idle`
// EDGE event. A board that drains to zero running agents stops emitting
// `agent_idle` entirely, so promotion freezes permanently even with a
// fully-eligible candidate queued. `BacklogPromotionService.levelSweep()`
// closes that gap with a timer-independent call path.
//
// Item B — a candidate with a vacant destination role used to fall through
// the eligibility loop with `skipReason` left null, so no audit row was
// ever written — operators couldn't tell "not its turn yet" from "will
// never promote". `backlog_promotion_skipped_role_unfilled` fixes that,
// sharing the same suppression helper as the pre-existing focus-held skip
// so a persistently-vacant role doesn't spam the activity feed once
// `levelSweep` starts calling `tryPromote` on a timer.
//
// Acceptance:
//
//   1. `levelSweep()` promotes a fully-eligible intake ticket WITHOUT ever
//      emitting `agent_idle`, and stamps `triggered_by=system:level_tick`
//      (never an agent id, never the `manual` default) on the
//      `backlog_promoted` row.
//   2. A role-unfilled candidate is not promoted and writes exactly one
//      `backlog_promotion_skipped_role_unfilled` row; a second identical
//      pass writes no duplicate. Filling the holder promotes it on the
//      next pass.
//   3. Suppression is scoped to the two skip actions only — repeated
//      genuine promotions each still write their own `backlog_promoted`
//      row.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createApiKey,
  createBoard,
  createColumn,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

// Port 7797 — unique slot, verified against every `process.env.PORT = ...`
// assignment under test/ at the time this file was added.
process.env.PORT = process.env.QA_BACKLOG_LEVEL_SWEEP_PORT || '7797';

test('BacklogPromotion level-triggered backstop + role-unfilled skip audit', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const backlogPromotionModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'backlog-promotion.service.js')
  );
  const backlogPromotion = app.get(backlogPromotionModule.BacklogPromotionService);
  const { LEVEL_TICK_TRIGGERED_BY } = backlogPromotionModule;
  assert.equal(typeof LEVEL_TICK_TRIGGERED_BY, 'string');
  assert.notEqual(LEVEL_TICK_TRIGGERED_BY, 'manual',
    'the level-tick marker must be distinguishable from the pre-existing manual default');

  const ds = app.get(getDataSourceToken());

  step('Seed workspace + driver user + assignee agent');
  const ws = await createWorkspace(app, getDataSourceToken, 'level-sweep');
  await createUser(app, getDataSourceToken, { name: 'driver' });
  const aliceAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
  await createApiKey(app, getDataSourceToken, aliceAgent.id, { workspaceId: ws.id, label: 'alice' });

  const ticketRepo = ds.getRepository('Ticket');
  const activityLogRepo = ds.getRepository('ActivityLog');
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  const roleRepo = ds.getRepository('WorkspaceRole');

  async function makeBoard(name, maxConcurrent = 1) {
    const board = await createBoard(app, getDataSourceToken, ws.id, { name, maxConcurrent });
    const backlog = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Backlog', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: [],
    });
    const todo = await createColumn(app, getDataSourceToken, board.id, {
      name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
    });
    const done = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Done', position: 2, workspaceId: ws.id, isTerminal: true, kind: 'terminal', roleRouting: [],
    });
    return { board, backlog, todo, done };
  }

  async function activityRowsFor(ticketId, action) {
    return activityLogRepo.find({ where: { ticket_id: ticketId, action } });
  }

  // ────────────────────────────────────────────────────────────────────
  // Case 1 (Item A): levelSweep promotes without ever emitting agent_idle,
  // and marks the promotion as level-tick-triggered.
  // ────────────────────────────────────────────────────────────────────
  step('Case 1 — levelSweep promotes a fully-eligible candidate, no agent_idle involved');
  const c1 = await makeBoard('level-sweep-case1');
  const t1 = await createTicket(app, getDataSourceToken, {
    columnId: c1.backlog.id, workspaceId: ws.id, title: 'idle-board candidate', priority: 'high',
    assigneeId: aliceAgent.id,
  });

  // Nothing in this test ever calls activityEvents.emit('agent_idle', ...)
  // or does anything that would cause AgentStatusService to emit it — the
  // ONLY promotion path exercised here is the timer-independent sweep.
  const sweepStats = await backlogPromotion.levelSweep();
  assert.equal(sweepStats.promoted >= 1, true,
    `levelSweep must report at least one promotion (got ${JSON.stringify(sweepStats)})`);

  const t1After = await ticketRepo.findOne({ where: { id: t1.id } });
  assert.equal(t1After.column_id, c1.todo.id,
    'eligible candidate must have been promoted to the destination column by the level tick alone');

  const promotedRows = await activityRowsFor(t1.id, 'backlog_promoted');
  assert.equal(promotedRows.length, 1, 'exactly one backlog_promoted row for the level-tick promotion');
  const promotedNewValue = promotedRows[0].new_value || '';
  assert.ok(
    promotedNewValue.includes(`triggered_by=${LEVEL_TICK_TRIGGERED_BY}`),
    `backlog_promoted new_value must include triggered_by=${LEVEL_TICK_TRIGGERED_BY} (got: ${promotedNewValue})`,
  );
  assert.equal(
    promotedNewValue.includes('triggered_by=manual'),
    false,
    'a level-tick promotion must not fall back to the indistinguishable manual default',
  );

  // ────────────────────────────────────────────────────────────────────
  // Case 2 (Item B): role-unfilled candidate is skipped with exactly one
  // audit row; a second identical pass does not duplicate it; filling the
  // holder promotes on the next pass.
  // ────────────────────────────────────────────────────────────────────
  step('Case 2 — role-unfilled candidate: skip audit + suppression + eventual promotion');
  const c2 = await makeBoard('level-sweep-case2');
  const t2 = await createTicket(app, getDataSourceToken, {
    columnId: c2.backlog.id, workspaceId: ws.id, title: 'vacant-role candidate', priority: 'high',
    // No assigneeId — the destination column's only routed role ('assignee')
    // has NO TicketRoleAssignment row at all.
  });

  step('  pass 1 — not promoted, exactly one skip audit row');
  const pass1 = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(pass1, null, `vacant-role candidate must not promote (got ${pass1?.slice(0, 8) || 'null'})`);
  const t2AfterPass1 = await ticketRepo.findOne({ where: { id: t2.id } });
  assert.equal(t2AfterPass1.column_id, c2.backlog.id, 'vacant-role ticket must remain in intake');

  let skipRows = await activityRowsFor(t2.id, 'backlog_promotion_skipped_role_unfilled');
  assert.equal(skipRows.length, 1, `expected exactly one skip audit row after pass 1 (got ${skipRows.length})`);
  assert.match(skipRows[0].new_value || '', /role=assignee/, 'skip row must name the vacant role slug');
  assert.ok(
    (skipRows[0].new_value || '').includes(`dest_column_id=${c2.todo.id}`),
    'skip row must name the destination column',
  );

  step('  pass 2 — identical vacancy, no duplicate row (suppression)');
  const pass2 = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(pass2, null, 'still not promoted on the second pass');
  skipRows = await activityRowsFor(t2.id, 'backlog_promotion_skipped_role_unfilled');
  assert.equal(skipRows.length, 1,
    `second identical pass must NOT write a duplicate skip row (got ${skipRows.length})`);

  step('  fill the holder — next pass promotes normally');
  const assigneeRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'assignee' } });
  assert.ok(assigneeRole, 'assignee WorkspaceRole must exist (seeded by createWorkspace)');
  await assignRepo.save(assignRepo.create({
    ticket_id: t2.id, role_id: assigneeRole.id, agent_id: aliceAgent.id, user_id: null,
  }));

  const pass3 = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(pass3, t2.id, `ticket must promote once the role is filled (got ${pass3?.slice(0, 8) || 'null'})`);
  const t2AfterPass3 = await ticketRepo.findOne({ where: { id: t2.id } });
  assert.equal(t2AfterPass3.column_id, c2.todo.id, 'ticket must have moved to the destination column');

  const finalSkipRows = await activityRowsFor(t2.id, 'backlog_promotion_skipped_role_unfilled');
  assert.equal(finalSkipRows.length, 1, 'promotion must not retroactively add or remove skip rows');
  const finalPromotedRows = await activityRowsFor(t2.id, 'backlog_promoted');
  assert.equal(finalPromotedRows.length, 1, 'exactly one backlog_promoted row once eligible');

  // ────────────────────────────────────────────────────────────────────
  // Case 3 (Item A boundary): suppression is scoped to the two skip
  // actions ONLY — repeated genuine promotions are never suppressed.
  // ────────────────────────────────────────────────────────────────────
  step('Case 3 — suppression never touches backlog_promoted success rows');
  const c3 = await makeBoard('level-sweep-case3', 2); // cap=2 so alice can hold both
  const t3a = await createTicket(app, getDataSourceToken, {
    columnId: c3.backlog.id, workspaceId: ws.id, title: 'boundary-a', priority: 'high',
    assigneeId: aliceAgent.id,
  });
  await new Promise((r) => setTimeout(r, 10));
  const t3b = await createTicket(app, getDataSourceToken, {
    columnId: c3.backlog.id, workspaceId: ws.id, title: 'boundary-b', priority: 'medium',
    assigneeId: aliceAgent.id,
  });

  const p3a = await backlogPromotion.tryPromote(c3.board.id);
  assert.equal(p3a, t3a.id, 'higher-priority candidate promotes first');
  const p3b = await backlogPromotion.tryPromote(c3.board.id);
  assert.equal(p3b, t3b.id,
    'second, independently-eligible candidate must ALSO promote — same action, same board, back to back');

  const rowsA = await activityRowsFor(t3a.id, 'backlog_promoted');
  const rowsB = await activityRowsFor(t3b.id, 'backlog_promoted');
  assert.equal(rowsA.length, 1, 'ticket A must have exactly one backlog_promoted row — success path is never suppressed');
  assert.equal(rowsB.length, 1,
    'ticket B must ALSO have exactly one backlog_promoted row — a second consecutive promotion must not be dropped ' +
    'by whatever suppression logic protects the skip-audit rows');

  exitAfterTests(0);
});
