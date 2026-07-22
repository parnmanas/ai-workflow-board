// Hard-budget ceiling — runtime guard (ticket a940d75b), against a REAL
// sql.js DataSource driven through the app's own buildDataSourceOptions()
// (so `synchronize` actually creates Board.hard_budget_config + every table
// the guard queries — the dual-DB migration-free config-column convention).
//
// Central regression this file exists to pin: the Planner's decision flagged
// a fatal flaw in a naive lifetime counter — once a breach auto-pends a
// ticket, a human unpend must ACTUALLY clear the count, or the very next
// agent comment/dispatch re-trips the same already-over-limit count and the
// ticket dies permanently. `lastHumanUnpendAt` anchors both ceilings to the
// latest `field_changed='pending_user_action', new_value='false'` activity
// row — the epoch test below is the one that would have caught the bug.
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the
// test script). Uses an isolated SQLJS_DB_PATH temp file so it never touches
// the shared dev database/data.db.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-hard-budget-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'hard-budget-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { Agent } = await import('file://' + path.join(DIST, 'entities', 'Agent.js'));
const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
const {
  lastHumanUnpendAt,
  countAutoResponses,
  countWindowDispatches,
  pendTicketForHardBudget,
  enforceAutoResponseBudget,
} = await import('file://' + path.join(DIST, 'common', 'hard-budget-guard.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds.getRepository(Agent), logStub);
const deps = { dataSource: ds, activityService, logger: logStub };

const boardRepo = ds.getRepository(Board);
const colRepo = ds.getRepository(BoardColumn);
const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);
const activityRepo = ds.getRepository(ActivityLog);

async function makeBoard(hardBudgetConfig) {
  return boardRepo.save(boardRepo.create({ name: 'B', hard_budget_config: hardBudgetConfig ?? null }));
}
async function makeColumn(board) {
  return colRepo.save(colRepo.create({ board_id: board.id, name: 'To Do', position: 1 }));
}
async function makeTicket(col, overrides = {}) {
  return ticketRepo.save(ticketRepo.create({
    title: 'T', column_id: col ? col.id : null, workspace_id: 'w1', pending_user_action: false, ...overrides,
  }));
}
async function addAgentComment(ticketId, opts = {}) {
  return commentRepo.save(commentRepo.create({
    ticket_id: ticketId, author_type: 'agent', author: 'A', content: 'x', type: 'note', ...opts,
  }));
}
/** Write the exact row REST PATCH /api/tickets/:id leaves on a human unpend. */
async function recordHumanUnpend(ticketId) {
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: ticketId, ticket_id: ticketId, action: 'updated',
    field_changed: 'pending_user_action', old_value: 'true', new_value: 'false',
    actor_id: 'human1', actor_name: 'Human',
  }));
}
async function recordTriggerEmitted(ticketId, triggerSource = 'comment') {
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: ticketId, ticket_id: ticketId, action: 'trigger_emitted',
    trigger_source: triggerSource, actor_id: 'system', actor_name: 'TriggerLoopService',
  }));
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('countAutoResponses counts only agent/non-system comments at/after `since`', async () => {
  const t = await makeTicket(null);
  const since = new Date(Date.now() - 1000);
  await addAgentComment(t.id, { author_type: 'user' });
  await addAgentComment(t.id, { type: 'system' });
  await addAgentComment(t.id);
  await addAgentComment(t.id);
  assert.equal(await countAutoResponses(ds, t.id, since), 2);
  assert.equal(await countAutoResponses(ds, t.id, new Date(Date.now() + 60_000)), 0, 'a future `since` sees nothing yet');
});

test('lastHumanUnpendAt: null when the ticket was never unpended; latest row otherwise', async () => {
  const t = await makeTicket(null);
  assert.equal(await lastHumanUnpendAt(ds, t.id), null);
  await recordHumanUnpend(t.id);
  const first = await lastHumanUnpendAt(ds, t.id);
  assert.ok(first instanceof Date);
  await new Promise(r => setTimeout(r, 5));
  await recordHumanUnpend(t.id);
  const second = await lastHumanUnpendAt(ds, t.id);
  assert.ok(second.getTime() >= first.getTime(), 'picks the LATEST unpend row');
});

test('countWindowDispatches excludes manual/comment_summary trigger sources', async () => {
  const t = await makeTicket(null);
  const since = new Date(Date.now() - 1000);
  await recordTriggerEmitted(t.id, 'comment');
  await recordTriggerEmitted(t.id, 'manual');
  await recordTriggerEmitted(t.id, 'comment_summary');
  await recordTriggerEmitted(t.id, 'column_move');
  assert.equal(await countWindowDispatches(ds, t.id, since), 2);
});

test('pendTicketForHardBudget: CAS is idempotent — concurrent breaches pend exactly once', async () => {
  const t = await makeTicket(null);
  const before = await activityRepo.count({ where: { ticket_id: t.id, field_changed: 'pending_user_action' } });
  const results = await Promise.all([
    pendTicketForHardBudget(ds, activityService, t, 'r1', 'test_guard'),
    pendTicketForHardBudget(ds, activityService, t, 'r2', 'test_guard'),
  ]);
  assert.deepEqual(results.sort(), [false, true], 'exactly one of the two racing calls wins the CAS');
  const after = await activityRepo.count({ where: { ticket_id: t.id, field_changed: 'pending_user_action' } });
  assert.equal(after - before, 1, 'exactly one audit row — no duplicate pend logging');
  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, true);
});

test('enforceAutoResponseBudget: under the cap does not block', async () => {
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 5 }));
  const col = await makeColumn(board);
  const t = await makeTicket(col);
  for (let i = 0; i < 4; i++) await addAgentComment(t.id);
  const result = await enforceAutoResponseBudget(deps, t);
  assert.equal(result.blocked, false);
  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, false);
});

test('enforceAutoResponseBudget: at/over the cap blocks and auto-pends (board override, not the 100 default)', async () => {
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 3, notify: false }));
  const col = await makeColumn(board);
  const t = await makeTicket(col);
  for (let i = 0; i < 3; i++) await addAgentComment(t.id);

  const result = await enforceAutoResponseBudget(deps, t);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'max_auto_responses_exceeded');

  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, true);
  assert.ok(reloaded.pending_reason.includes('하드 상한'));

  const pendRows = await activityRepo.count({
    where: { ticket_id: t.id, field_changed: 'pending_user_action', new_value: 'true' },
  });
  assert.equal(pendRows, 1);
});

test('enforceAutoResponseBudget: enabled=false never blocks regardless of count', async () => {
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 1, enabled: false }));
  const col = await makeColumn(board);
  const t = await makeTicket(col);
  for (let i = 0; i < 5; i++) await addAgentComment(t.id);
  const result = await enforceAutoResponseBudget(deps, t);
  assert.equal(result.blocked, false);
});

// ── THE regression: epoch reset on human unpend (Planner decision #4) ──────
test('enforceAutoResponseBudget: a human unpend actually clears the ceiling — no permanent-death loop', async () => {
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 2, notify: false }));
  const col = await makeColumn(board);
  const t = await makeTicket(col);
  await addAgentComment(t.id);
  await addAgentComment(t.id);

  // First breach: blocks + auto-pends.
  const first = await enforceAutoResponseBudget(deps, t);
  assert.equal(first.blocked, true);
  let reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, true);

  // A human clears it via the REST PATCH path — same activity row shape
  // tickets.controller.ts leaves (field_changed='pending_user_action', new_value='false').
  await ticketRepo.update({ id: t.id }, { pending_user_action: false, pending_reason: '', pending_set_at: null, pending_set_by: '' });
  await recordHumanUnpend(t.id);
  reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, false);

  // The SAME 2 old comments are still in the table (nothing deletes them) —
  // a naive lifetime COUNT would see 2 >= 2 and immediately re-pend. The
  // epoch anchor must exclude them (they predate the unpend) and let the
  // ticket breathe.
  const second = await enforceAutoResponseBudget(deps, reloaded);
  assert.equal(second.blocked, false, 'must NOT immediately re-trip — this is the permanent-death bug the Planner flagged');
  reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, false, 'stays cleared');

  // And the ceiling is still live going forward: two MORE agent comments
  // after the unpend epoch re-trips it.
  //
  // sql.js stores `created_at` without sub-second precision ('...:55', no
  // milliseconds) but binds a Date query parameter WITH milliseconds
  // ('...:55.000') — a same-second stored row is then a lexicographic PREFIX
  // of the bound parameter, so `created_at >= :since` treats it as "before".
  // This is a sql.js/dev-only artifact (Postgres — the actual production DB
  // — has no such mismatch) and its failure direction is safe (it can only
  // under-count right at the epoch boundary, never resurrect stale
  // pre-epoch comments), but it means a same-second comparison in THIS test
  // would be racing the artifact rather than testing the epoch logic. Cross
  // a full second boundary first so the assertion is deterministic.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await addAgentComment(t.id);
  await addAgentComment(t.id);
  const third = await enforceAutoResponseBudget(deps, reloaded);
  assert.equal(third.blocked, true, 'the ceiling still works AFTER the epoch reset — this is not a permanent bypass either');
});

test('enforceAutoResponseBudget: fails open (never blocks) when the ticket carries no resolvable board', async () => {
  // No column_id at all — resolveTicketBoardId returns null, config falls
  // back to the env baseline (max_auto_responses=100 by default), well
  // above this test's comment count.
  const t = await makeTicket(null);
  await addAgentComment(t.id);
  const result = await enforceAutoResponseBudget(deps, t);
  assert.equal(result.blocked, false);
});
