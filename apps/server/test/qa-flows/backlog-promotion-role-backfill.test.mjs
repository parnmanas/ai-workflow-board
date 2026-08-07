// QA flow: vacant-role auto-backfill from board default_role_assignments
// (ticket bb5b9aed).
//
// What this proves
// ─────────────────
//
// A role-unfilled intake candidate (`backlog_promotion_skipped_role_unfilled`)
// used to repeat identically forever — `levelSweep` retries every 5 min, but
// nothing ever fills the vacant role, so the ticket sat in intake until a
// human manually assigned it. `_maybeBackfillVacantRole` closes that gap: once
// the vacancy has persisted past `BACKLOG_PROMOTION_ROLE_BACKFILL_MS`, the
// vacant role is filled ONCE from the board's `default_role_assignments` —
// but ONLY when the board actually has a default for that slug. A board with
// no default is left alone (no auto-assignment guess, no infinite retry).
//
// Acceptance:
//
//   1. Board HAS a default for the vacant slug: the role stays vacant (no
//      backfill row) while the skip is still fresh, then gets backfilled
//      exactly once — with an audit row — once the skip has aged past the
//      threshold. The ticket promotes normally on the next pass.
//   2. Board has NO default for the vacant slug: the role is never touched,
//      no `backlog_promotion_role_backfilled` row is ever written no matter
//      how many passes run past the threshold, and the pre-existing skip-audit
//      dedup still applies (no duplicate skip rows either).

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

// Port 7924 — unique slot, verified unused across test/ at the time this
// file was added.
process.env.PORT = process.env.QA_BACKLOG_ROLE_BACKFILL_PORT || '7924';

test('BacklogPromotion vacant-role auto-backfill from board default_role_assignments', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const backlogPromotionModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'backlog-promotion.service.js')
  );
  const backlogPromotion = app.get(backlogPromotionModule.BacklogPromotionService);

  const ds = app.get(getDataSourceToken());
  const ticketRepo = ds.getRepository('Ticket');
  const boardRepo = ds.getRepository('Board');
  const activityLogRepo = ds.getRepository('ActivityLog');
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  const roleRepo = ds.getRepository('WorkspaceRole');

  step('Seed workspace + candidate holder agent');
  const ws = await createWorkspace(app, getDataSourceToken, 'role-backfill');
  await createUser(app, getDataSourceToken, { name: 'driver' });
  const bobAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'bob' });
  await createApiKey(app, getDataSourceToken, bobAgent.id, { workspaceId: ws.id, label: 'bob' });

  async function makeBoard(name) {
    const board = await createBoard(app, getDataSourceToken, ws.id, { name });
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

  async function skipRowsFor(ticketId) {
    return activityLogRepo.find({ where: { ticket_id: ticketId, action: 'backlog_promotion_skipped_role_unfilled' } });
  }
  async function backfillRowsFor(ticketId) {
    return activityLogRepo.find({ where: { ticket_id: ticketId, action: 'backlog_promotion_role_backfilled' } });
  }

  // Back-date a ticket's skip-audit row so it reads as older than the
  // (real, un-overridden) 30-min default threshold — mirrors the
  // back-dated-`created_at` technique used by the stuck-detector QA flows
  // (no real sleep, fully deterministic).
  async function ageSkipRow(ticketId, minutesAgo) {
    const rows = await skipRowsFor(ticketId);
    assert.equal(rows.length, 1, `expected exactly one skip row to age (got ${rows.length})`);
    await activityLogRepo.update(rows[0].id, { created_at: new Date(Date.now() - minutesAgo * 60_000) });
  }

  // ────────────────────────────────────────────────────────────────────
  // Case 1 — board HAS a default for the vacant slug.
  // ────────────────────────────────────────────────────────────────────
  step('Case 1 — board default configured: no backfill while fresh, backfill once aged, then promotes');
  const c1 = await makeBoard('role-backfill-case1');
  await boardRepo.update(c1.board.id, {
    default_role_assignments: JSON.stringify({ assignee: [{ agent_id: bobAgent.id }] }),
  });
  const t1 = await createTicket(app, getDataSourceToken, {
    columnId: c1.backlog.id, workspaceId: ws.id, title: 'has-default candidate', priority: 'high',
    // No assigneeId — the destination's only routed role ('assignee') is vacant.
  });

  step('  pass 1 — vacant + fresh skip row, no backfill yet');
  const c1Pass1 = await backlogPromotion.tryPromote(c1.board.id);
  assert.equal(c1Pass1, null, 'must not promote while the role is vacant');
  assert.equal((await skipRowsFor(t1.id)).length, 1, 'exactly one fresh skip row');
  assert.equal((await backfillRowsFor(t1.id)).length, 0,
    'must NOT backfill on the very first sighting — the vacancy has not persisted past the threshold yet');
  assert.equal((await assignRepo.find({ where: { ticket_id: t1.id } })).length, 0,
    'role must still be genuinely vacant before the threshold is crossed');

  step('  age the skip row past the (default) 30-min threshold, then pass 2 backfills');
  await ageSkipRow(t1.id, 40);
  const c1Pass2 = await backlogPromotion.tryPromote(c1.board.id);
  assert.equal(c1Pass2, null,
    'pass 2 still reports no promotion — eligibility was already evaluated false for this pass before the backfill ran');

  const backfillRows = await backfillRowsFor(t1.id);
  assert.equal(backfillRows.length, 1, `expected exactly one backfill audit row (got ${backfillRows.length})`);
  assert.match(backfillRows[0].new_value || '', /role=assignee/, 'backfill row must name the backfilled slug');
  assert.equal(backfillRows[0].role, 'assignee', 'backfill row must carry the slug on the role column too');

  const assignmentsAfterBackfill = await assignRepo.find({ where: { ticket_id: t1.id } });
  assert.equal(assignmentsAfterBackfill.length, 1, 'exactly one holder written by the backfill');
  assert.equal(assignmentsAfterBackfill[0].agent_id, bobAgent.id, 'backfilled holder must be the board default agent');

  step('  pass 3 — now genuinely eligible, promotes normally');
  const c1Pass3 = await backlogPromotion.tryPromote(c1.board.id);
  assert.equal(c1Pass3, t1.id, `ticket must promote once the backfilled role makes it eligible (got ${c1Pass3?.slice(0, 8) || 'null'})`);
  const t1After = await ticketRepo.findOne({ where: { id: t1.id } });
  assert.equal(t1After.column_id, c1.todo.id, 'ticket must have moved to the destination column');
  assert.equal((await backfillRowsFor(t1.id)).length, 1,
    'backfill audit row must still be exactly one after the ticket left intake — promotion must not retroactively add rows');

  // ────────────────────────────────────────────────────────────────────
  // Case 2 — board has NO default for the vacant slug.
  // ────────────────────────────────────────────────────────────────────
  step('Case 2 — no board default: never backfilled, never retried, no duplicate skip rows');
  const c2 = await makeBoard('role-backfill-case2');
  // Deliberately leave default_role_assignments unset (null) — no default for
  // ANY slug, so the vacant 'assignee' role has nothing to backfill from.
  const t2 = await createTicket(app, getDataSourceToken, {
    columnId: c2.backlog.id, workspaceId: ws.id, title: 'no-default candidate', priority: 'high',
  });

  const c2Pass1 = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(c2Pass1, null, 'must not promote — role vacant and no default to fall back on');
  assert.equal((await skipRowsFor(t2.id)).length, 1, 'exactly one skip row after pass 1');

  await ageSkipRow(t2.id, 40);
  const c2Pass2 = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(c2Pass2, null, 'still not promoted after aging past the threshold — no default exists');
  assert.equal((await backfillRowsFor(t2.id)).length, 0,
    'no board default for this slug — must NEVER write a backfill row, no matter how stale the vacancy is');
  assert.equal((await assignRepo.find({ where: { ticket_id: t2.id } })).length, 0,
    'role must remain genuinely vacant — no silent auto-assignment guess');
  assert.equal((await skipRowsFor(t2.id)).length, 1,
    'the pre-existing skip-audit dedup must still hold — aging + a no-op backfill attempt must not add a duplicate skip row');

  step('  pass 3 — repeated passes past the threshold still never backfill (no infinite-retry spam)');
  await ageSkipRow(t2.id, 90);
  const c2Pass3 = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(c2Pass3, null, 'still not promoted on a third pass');
  assert.equal((await backfillRowsFor(t2.id)).length, 0, 'still zero backfill rows after repeated passes');

  exitAfterTests(0);
});
