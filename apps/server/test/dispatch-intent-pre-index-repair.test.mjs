// Regression: rollout-safe pre-index repair for the durable dispatch outbox
// (ticket 3c3b17a3, reviewer production-rollout blocker #1).
//
// THE BLOCKER: the partial UNIQUE index this ticket adds —
//   uniq_dispatch_intent_open_ticket_role (ticket_id, role) WHERE status != 'resolved'
// is built by TypeORM `synchronize` on the first boot after upgrade. But the very
// defect being fixed (non-atomic find-then-insert) means an already-running prod
// DB may ALREADY hold two OPEN rows for the same (ticket_id, role). CREATE UNIQUE
// INDEX against that duplicate FAILS, and because synchronize runs inside
// DataSource.initialize() (before any data migration), the server boot aborts.
//
// THE REPAIR (dispatch-intent-dedup.ts, run from preSyncSqljsOpenIntents /
// preSyncPostgres BEFORE synchronize): deterministically resolve the duplicate
// open rows, keeping the _findOpen-canonical survivor (oldest by created_at, id).
//
// This proves, against a REAL sql.js DataSource driven through the app's own
// buildDataSourceOptions() (so the actual synchronize DDL runs — the SQLite half
// of the dual-DB check):
//   A. with pre-existing duplicate open rows, synchronize FAILS (boot aborts) —
//      the blocker is real, not hypothetical.
//   B. the repair collapses every (ticket, role) group to exactly ONE open row,
//      keeping the deterministic survivor and RESOLVING the extras (audit kept).
//   C. after the repair, synchronize SUCCEEDS and the unique index is enforced —
//      the upgrade completes with exactly one open row per group.
//   D. non-duplicate groups (single open; open+resolved) are left untouched, and
//      the repair is idempotent (a second run modifies nothing).
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the test
// script). Isolated SQLJS_DB_PATH temp file — never touches the dev database.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-dispatch-intent-preidx-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'preidx-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DispatchIntent } = await import('file://' + path.join(DIST, 'entities', 'DispatchIntent.js'));
const { DISPATCH_INTENT_STATUS } = await import(
  'file://' + path.join(DIST, 'modules', 'agents', 'dispatch-intent.service.js')
);
const { DEDUP_OPEN_DISPATCH_INTENTS_SQL, DEDUP_RESOLVE_REASON } = await import(
  'file://' + path.join(DIST, 'database', 'dispatch-intent-dedup.js')
);
const { DataSource } = await import('typeorm');

const OPEN = [DISPATCH_INTENT_STATUS.PENDING, DISPATCH_INTENT_STATUS.IN_FLIGHT];
const UNIQUE_INDEX = 'uniq_dispatch_intent_open_ticket_role';

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize(); // creates dispatch_intents + the partial unique index
const repo = ds.getRepository(DispatchIntent);

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function rowsFor(ticketId, role) {
  const all = await repo.find({ where: { ticket_id: ticketId, role } });
  const open = all.filter((r) => OPEN.includes(r.status));
  const resolved = all.filter((r) => r.status === DISPATCH_INTENT_STATUS.RESOLVED);
  return { all, open, resolved };
}

// Raw insert bypassing the ORM's open-intent guard — simulates the pre-fix
// non-atomic double insert (and a second server instance). Explicit id +
// created_at make the deterministic survivor unambiguous.
async function rawInsert({ id, ticketId, role, status, createdAt, triggerId }) {
  await ds.query(
    `INSERT INTO ${'dispatch_intents'}
       (id, workspace_id, board_id, ticket_id, role, agent_id, trigger_source,
        status, attempts, next_attempt_at, dispatch_generation, last_trigger_id,
        lease_owner, last_ack_kind, last_reason, created_at, updated_at)
     VALUES (?, 'ws1', 'b1', ?, ?, 'agentX', 'column_move',
             ?, 0, ?, 0, ?, '', '', '', ?, ?)`,
    [id, ticketId, role, status, createdAt, triggerId ?? '', createdAt, createdAt],
  );
}

test('pre-index repair: dup open rows block synchronize, get deterministically resolved, then synchronize succeeds', async () => {
  // ── Simulate the PRE-UPGRADE schema: an old DB whose dispatch_intents table
  //    predates the unique index. Drop the index so duplicate open rows can be
  //    inserted the way the pre-fix code path would have.
  await ds.query(`DROP INDEX IF EXISTS ${UNIQUE_INDEX}`);

  // Group A — duplicate open (the exact bug): two open rows, same (ticket, role).
  //   survivor = older created_at AND smaller id → id 'a...' wins over 'b...'.
  await rawInsert({ id: 'aaaa1111-0000-0000-0000-000000000001', ticketId: 't-dup', role: 'assignee',
    status: DISPATCH_INTENT_STATUS.IN_FLIGHT, createdAt: '2026-01-01 00:00:01.000', triggerId: 'keep' });
  await rawInsert({ id: 'bbbb2222-0000-0000-0000-000000000002', ticketId: 't-dup', role: 'assignee',
    status: DISPATCH_INTENT_STATUS.PENDING, createdAt: '2026-01-01 00:00:05.000', triggerId: 'drop' });

  // Group B — control: a single open row must be left completely untouched.
  await rawInsert({ id: 'cccc3333-0000-0000-0000-000000000003', ticketId: 't-single', role: 'reviewer',
    status: DISPATCH_INTENT_STATUS.PENDING, createdAt: '2026-01-01 00:00:02.000', triggerId: 'solo' });

  // Group C — control: already-resolved + one open ⇒ only one open, nothing to do.
  await rawInsert({ id: 'dddd4444-0000-0000-0000-000000000004', ticketId: 't-mixed', role: 'assignee',
    status: DISPATCH_INTENT_STATUS.RESOLVED, createdAt: '2026-01-01 00:00:03.000', triggerId: 'old' });
  await rawInsert({ id: 'eeee5555-0000-0000-0000-000000000005', ticketId: 't-mixed', role: 'assignee',
    status: DISPATCH_INTENT_STATUS.IN_FLIGHT, createdAt: '2026-01-01 00:00:04.000', triggerId: 'live' });

  // Group D — triple duplicate: collapse 3 open → 1 open + 2 resolved.
  await rawInsert({ id: 'ffff6666-0000-0000-0000-000000000006', ticketId: 't-triple', role: 'planner',
    status: DISPATCH_INTENT_STATUS.PENDING, createdAt: '2026-01-01 00:00:10.000', triggerId: 't1' });
  await rawInsert({ id: 'ffff6666-0000-0000-0000-000000000007', ticketId: 't-triple', role: 'planner',
    status: DISPATCH_INTENT_STATUS.IN_FLIGHT, createdAt: '2026-01-01 00:00:11.000', triggerId: 't2' });
  await rawInsert({ id: 'ffff6666-0000-0000-0000-000000000008', ticketId: 't-triple', role: 'planner',
    status: DISPATCH_INTENT_STATUS.PENDING, createdAt: '2026-01-01 00:00:12.000', triggerId: 't3' });

  // ── A. With the duplicates present, an upgrade boot (synchronize re-creating the
  //    entity-declared unique index) FAILS — this is the production boot abort.
  await assert.rejects(
    () => ds.synchronize(false),
    /unique|constraint/i,
    'synchronize must fail while duplicate open rows exist (the blocker)',
  );
  // Defensive: ensure the index did not partially land before we run the repair.
  await ds.query(`DROP INDEX IF EXISTS ${UNIQUE_INDEX}`);

  // ── B. Run the rollout-safe repair (the exact SQL preSync* runs before sync).
  await ds.query(DEDUP_OPEN_DISPATCH_INTENTS_SQL);

  // Group A collapsed to exactly one open — the deterministic survivor.
  {
    const { open, resolved } = await rowsFor('t-dup', 'assignee');
    assert.equal(open.length, 1, 'A: exactly one open row survives');
    assert.equal(open[0].id, 'aaaa1111-0000-0000-0000-000000000001', 'A: survivor is oldest by (created_at,id)');
    assert.equal(open[0].last_trigger_id, 'keep', 'A: the kept row is the canonical (oldest) one');
    assert.equal(resolved.length, 1, 'A: the later duplicate is resolved');
    assert.equal(resolved[0].last_reason, DEDUP_RESOLVE_REASON, 'A: resolved with the repair reason (audit)');
  }
  // Group B untouched.
  {
    const { open, resolved } = await rowsFor('t-single', 'reviewer');
    assert.equal(open.length, 1, 'B: single open row untouched');
    assert.equal(resolved.length, 0, 'B: nothing resolved');
    assert.equal(open[0].last_reason, '', 'B: the untouched row keeps its original reason');
  }
  // Group C untouched (already one open; the pre-existing resolved row is not re-stamped).
  {
    const { open, resolved } = await rowsFor('t-mixed', 'assignee');
    assert.equal(open.length, 1, 'C: the one open row survives');
    assert.equal(open[0].id, 'eeee5555-0000-0000-0000-000000000005', 'C: the live open row is untouched');
    assert.equal(resolved.length, 1, 'C: the pre-existing resolved row stays resolved');
    assert.notEqual(resolved[0].last_reason, DEDUP_RESOLVE_REASON, 'C: the pre-existing resolved row is NOT re-stamped by the repair');
  }
  // Group D collapsed 3 → 1 open + 2 resolved, survivor = oldest.
  {
    const { open, resolved } = await rowsFor('t-triple', 'planner');
    assert.equal(open.length, 1, 'D: exactly one open row survives the triple');
    assert.equal(open[0].last_trigger_id, 't1', 'D: survivor is the oldest of three');
    assert.equal(resolved.length, 2, 'D: the two later duplicates are resolved');
  }

  // ── C. After the repair, the real upgrade path (synchronize) SUCCEEDS and the
  //    partial unique index is created + enforced.
  await assert.doesNotReject(() => ds.synchronize(false), 'synchronize succeeds once duplicates are resolved');
  const idx = await ds.query(
    `SELECT name, sql FROM sqlite_master WHERE type='index' AND name='${UNIQUE_INDEX}'`,
  );
  assert.equal(idx.length, 1, 'partial unique index exists after the upgrade');
  assert.match(String(idx[0].sql), /UNIQUE/i, 'the created index is UNIQUE');
  assert.match(String(idx[0].sql), /where\s+status\s*!=\s*'resolved'/i, 'the created index is PARTIAL on open rows');

  // The index now enforces at-most-one-open: a second raw open insert is rejected.
  await assert.rejects(
    () => repo.insert({ ticket_id: 't-dup', role: 'assignee', status: DISPATCH_INTENT_STATUS.PENDING, next_attempt_at: new Date() }),
    'post-upgrade, a second open row for a deduped (ticket, role) is rejected',
  );

  // ── D. Idempotent: re-running the repair on the now-clean DB modifies nothing.
  const beforeOpen = (await repo.count());
  await ds.query(DEDUP_OPEN_DISPATCH_INTENTS_SQL);
  const afterOpen = (await repo.count());
  assert.equal(afterOpen, beforeOpen, 'repair is idempotent — a second run resolves nothing new');
  for (const [t, r, n] of [['t-dup', 'assignee', 1], ['t-single', 'reviewer', 1], ['t-mixed', 'assignee', 1], ['t-triple', 'planner', 1]]) {
    const { open } = await rowsFor(t, r);
    assert.equal(open.length, n, `idempotent: ${t}/${r} still has exactly ${n} open row`);
  }
});
