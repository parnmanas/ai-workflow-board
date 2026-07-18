// Regression: durable dispatch outbox — idempotent open-intent creation
// (ticket 3c3b17a3, follow-up to e7c87517 reviewer Minor N2).
//
// BEFORE: recordDispatched / recordOwed / createSeed used a non-atomic
// find-then-insert. Two near-simultaneous emits for the same (ticket_id, role)
// could each see no open intent and both INSERT → two OPEN rows, and the
// reconciler would then dispatch both.
//
// AFTER: a PARTIAL UNIQUE index `(ticket_id, role) WHERE status != 'resolved'`
// is the DB-level arbiter, and the insert path uses ON CONFLICT DO NOTHING
// (.orIgnore()). This proves, against a REAL sql.js DataSource driven through
// the app's own `buildDataSourceOptions()` (so the actual `synchronize` DDL is
// exercised — the dual-DB migration check for the SQLite half):
//
//   1. synchronize emits the partial UNIQUE index (UNIQUE + WHERE predicate).
//   2. re-running synchronize on the existing schema is idempotent (no throw) —
//      the boot-time migration concern the ticket flagged.
//   3. a raw second OPEN insert for the same (ticket, role) is REJECTED by the
//      index — the cross-instance guarantee (two server instances can't both
//      land an open row), while a RESOLVED row does NOT block a fresh open row
//      (the partial predicate).
//   4. concurrent recordDispatched ×2 (Promise.all) → exactly ONE open row,
//      in_flight, attempts=2 (the losing insert's update still applied — faithful
//      to a serialized find-then-update).
//   5. concurrent recordOwed ×2 → exactly ONE open pending row.
//   6. a fresh emit AFTER the intent resolves opens a NEW row (the durable
//      re-owed behavior is preserved, not broken by the unique index).
//   7. concurrent createSeed ×2 → exactly ONE open row; a seed is a no-op when
//      an open intent already exists.
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the test
// script). Uses an isolated SQLJS_DB_PATH temp file so it never touches the
// shared dev database/data.db.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

// Isolated db file BEFORE importing db.js (resolveSqljsLocation reads the env).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-dispatch-intent-idem-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'idem-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DispatchIntent } = await import('file://' + path.join(DIST, 'entities', 'DispatchIntent.js'));
const { DispatchIntentService, DISPATCH_INTENT_STATUS } = await import(
  'file://' + path.join(DIST, 'modules', 'agents', 'dispatch-intent.service.js')
);
const { DataSource, In } = await import('typeorm');

const OPEN = [DISPATCH_INTENT_STATUS.PENDING, DISPATCH_INTENT_STATUS.IN_FLIGHT];

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize(); // runs synchronize → creates dispatch_intents + the partial unique index

// The service only touches `this.logService.warn(...)` on the failure path.
const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const svc = new DispatchIntentService(ds, logStub);
const repo = ds.getRepository(DispatchIntent);

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Rows for (ticket, role) partitioned into open vs all. */
async function rowsFor(ticketId, role) {
  const all = await repo.find({ where: { ticket_id: ticketId, role } });
  const open = all.filter((r) => OPEN.includes(r.status));
  return { all, open };
}

const dispatchArgs = (ticketId, role, triggerId) => ({
  workspaceId: 'ws1', boardId: 'b1', ticketId, role, agentId: 'agentX',
  triggerSource: 'column_move', triggerId,
});
const owedArgs = (ticketId, role, reason) => ({
  workspaceId: 'ws1', boardId: 'b1', ticketId, role, agentId: 'agentX',
  triggerSource: 'comment', reason,
});
const seedArgs = (ticketId, role) => ({
  workspaceId: 'ws1', boardId: 'b1', ticketId, role, agentId: 'agentX',
});

test('1. synchronize emits the partial UNIQUE index (ticket_id, role) WHERE status != resolved', async () => {
  const idx = await ds.query(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='dispatch_intents'",
  );
  const partial = idx.find((r) => r.name === 'uniq_dispatch_intent_open_ticket_role');
  assert.ok(partial, 'partial unique index must exist on dispatch_intents');
  const sql = String(partial.sql);
  assert.match(sql, /UNIQUE/i, 'index must be UNIQUE');
  assert.match(sql, /ticket_id/, 'index must cover ticket_id');
  assert.match(sql, /role/, 'index must cover role');
  assert.match(sql, /where\s+status\s*!=\s*'resolved'/i, 'index must be PARTIAL on open rows');
});

test('2. re-running synchronize on the existing schema is idempotent (no throw)', async () => {
  // The boot-time migration concern: every backend synchronizes on every boot
  // (db.ts D-01). A second synchronize against the already-created partial
  // unique index must not error, and uniqueness must still be enforced.
  await assert.doesNotReject(() => ds.synchronize(false));
  const idx = await ds.query(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dispatch_intents' AND name='uniq_dispatch_intent_open_ticket_role'",
  );
  assert.equal(idx.length, 1, 'partial unique index survives a re-synchronize');
});

test('3. raw 2nd OPEN insert rejected (cross-instance arbiter); resolved row allows a new open', async () => {
  const T = 't-raw';
  await repo.save(repo.create({
    ticket_id: T, role: 'assignee', status: DISPATCH_INTENT_STATUS.IN_FLIGHT,
    next_attempt_at: new Date(),
  }));
  // A second OPEN row for the same (ticket, role) — as a second server instance
  // bypassing app logic would attempt — must be rejected by the unique index.
  await assert.rejects(
    () => repo.insert({
      ticket_id: T, role: 'assignee', status: DISPATCH_INTENT_STATUS.PENDING,
      next_attempt_at: new Date(),
    }),
    'a 2nd open intent for the same (ticket, role) must violate the partial unique index',
  );

  // Resolve the open row → a fresh OPEN insert for the SAME (ticket, role) must
  // now succeed (uniqueness is scoped to non-resolved rows only).
  const [openRow] = (await rowsFor(T, 'assignee')).open;
  openRow.status = DISPATCH_INTENT_STATUS.RESOLVED;
  openRow.resolved_at = new Date();
  await repo.save(openRow);
  await assert.doesNotReject(
    () => repo.insert({
      ticket_id: T, role: 'assignee', status: DISPATCH_INTENT_STATUS.PENDING,
      next_attempt_at: new Date(),
    }),
    'a new open intent is allowed once the prior one is resolved (partial index)',
  );
  const { all, open } = await rowsFor(T, 'assignee');
  assert.equal(open.length, 1, 'exactly one open row');
  assert.equal(all.length, 2, 'one resolved + one open');
});

test('4. concurrent recordDispatched ×2 → exactly ONE open in_flight row (attempts=2)', async () => {
  const T = 't-dispatch-race';
  await Promise.all([
    svc.recordDispatched(dispatchArgs(T, 'assignee', 'trig-A')),
    svc.recordDispatched(dispatchArgs(T, 'assignee', 'trig-B')),
  ]);
  const { all, open } = await rowsFor(T, 'assignee');
  assert.equal(open.length, 1, 'concurrent double-emit must yield exactly ONE open intent');
  assert.equal(all.length, 1, 'no orphan resolved/duplicate rows');
  assert.equal(open[0].status, DISPATCH_INTENT_STATUS.IN_FLIGHT, 'surviving row is in_flight');
  assert.equal(open[0].attempts, 2, 'both dispatches recorded — the losing insert still applied its update');
});

test('5. concurrent recordOwed ×2 → exactly ONE open pending row', async () => {
  const T = 't-owed-race';
  await Promise.all([
    svc.recordOwed(owedArgs(T, 'reviewer', 'focus_window')),
    svc.recordOwed(owedArgs(T, 'reviewer', 'inflight_strand')),
  ]);
  const { all, open } = await rowsFor(T, 'reviewer');
  assert.equal(open.length, 1, 'concurrent double gate-drop must yield exactly ONE open intent');
  assert.equal(all.length, 1, 'no duplicate rows');
  assert.equal(open[0].status, DISPATCH_INTENT_STATUS.PENDING, 'surviving row is pending (a gate drop is not a dispatch)');
});

test('6. a fresh emit AFTER resolution opens a NEW row (durable re-owed preserved)', async () => {
  const T = 't-reopen';
  await svc.recordDispatched(dispatchArgs(T, 'assignee', 'trig-1'));
  let { open } = await rowsFor(T, 'assignee');
  assert.equal(open.length, 1, 'first emit → one open row');

  // Reconciler resolves it (e.g. progressed / terminal).
  await svc.resolve(open[0], 'progressed');
  ({ open } = await rowsFor(T, 'assignee'));
  assert.equal(open.length, 0, 'resolved → no open row');

  // A later re-trigger for the same (ticket, role) must open a brand-new intent
  // — the unique index must NOT swallow it (that would silently drop a real owed
  // dispatch and re-introduce the 24h-stall class this outbox exists to kill).
  await svc.recordDispatched(dispatchArgs(T, 'assignee', 'trig-2'));
  const after = await rowsFor(T, 'assignee');
  assert.equal(after.open.length, 1, 're-emit after resolution opens exactly one new row');
  assert.equal(after.all.length, 2, 'one resolved + one fresh open');
  assert.equal(after.open[0].last_trigger_id, 'trig-2', 'the new open row is the fresh dispatch');
});

test('7. concurrent createSeed ×2 → exactly ONE open row; seed is a no-op when open exists', async () => {
  const T = 't-seed-race';
  await Promise.all([
    svc.createSeed(seedArgs(T, 'assignee')),
    svc.createSeed(seedArgs(T, 'assignee')),
  ]);
  let { open } = await rowsFor(T, 'assignee');
  assert.equal(open.length, 1, 'concurrent seeds must yield exactly ONE open intent');

  // A further seed while an open intent exists is a no-op (fills only the gap).
  await svc.createSeed(seedArgs(T, 'assignee'));
  ({ open } = await rowsFor(T, 'assignee'));
  assert.equal(open.length, 1, 'seed does not duplicate an existing open intent');
});
