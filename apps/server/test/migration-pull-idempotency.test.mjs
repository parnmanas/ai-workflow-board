// Regression / feature proof: live pull import — idempotent resume +
// self-referential FK backfill (ticket 0f638509, 완료 기준 3).
//
// Claim under test: "중단 후 재실행이 멱등하다(같은 행이 중복 생성되지
// 않고, 남은 곳부터 재개된다)". This drives MigrationRunService's private
// pull methods directly against a REAL sqljs DataSource (synchronize()
// creates the actual tables + the one real FK constraint — Ticket.parent_id
// — exactly like a real destination), with a hand-rolled fake source client
// (no network, no SSRF-guard interaction — see migration-client.ts's own
// docstring for why: guardedFetch unconditionally blocks loopback, so a
// real two-local-server test can't reach the export endpoints at all).
//
// Runs against compiled dist/ (requires `npm run build`). Uses an isolated
// SQLJS_DB_PATH temp file so it never touches the shared dev database/data.db.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-migration-idem-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'migration-idem-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { MigrationRun } = await import('file://' + path.join(DIST, 'entities', 'MigrationRun.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { MigrationRunService } = await import('file://' + path.join(DIST, 'modules', 'migration', 'migration-run.service.js'));
const { DataSource, In } = await import('typeorm');

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize(); // synchronize() — creates the real Ticket.parent_id FK constraint too

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const runRepo = ds.getRepository(MigrationRun);
const svc = new MigrationRunService(ds, runRepo, logStub, /* instanceQuiesce, unused by the private pull methods */ {});

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function newRun() {
  return runRepo.save(runRepo.create({
    source_url: 'https://fake-source.invalid',
    source_token_encrypted: '',
    status: 'running',
    phase: 'core',
    entity_order: [],
    progress: {},
  }));
}

/** Minimal fake page — mirrors migration-export.controller.ts's response shape. */
function page(rows, hasMore = false, nextCursor = null) {
  return { rows, has_more: hasMore, next_cursor: nextCursor };
}

test('1. calling _pullEntity twice with the same page never duplicates rows (orIgnore idempotency)', async () => {
  const run = await newRun();
  const rows = [
    { id: 'ws-idem-1', name: 'Workspace A', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 'ws-idem-2', name: 'Workspace B', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ];
  const client = { getTablePage: async () => page(rows) };
  const progress = {};

  await svc._pullEntity(run.id, client, 'Workspace', null, progress);
  const afterFirst = await ds.getRepository('Workspace').count();
  assert.equal(afterFirst, 2, 'first pull inserts both rows');
  assert.equal(progress.Workspace.pulled, 2);
  assert.equal(progress.Workspace.done, true);

  // Simulate a crash-and-resume: re-run the exact same page (as a resumed
  // loop re-fetching from the same cursor would).
  await svc._pullEntity(run.id, client, 'Workspace', null, progress);
  const afterSecond = await ds.getRepository('Workspace').count();
  assert.equal(afterSecond, 2, 'second identical pull must NOT duplicate rows');

  const reloaded = await runRepo.findOne({ where: { id: run.id } });
  assert.equal(reloaded.current_entity, 'Workspace');
  assert.equal(reloaded.cursor, null, 'single-page pull with has_more=false clears the cursor');
});

test('2. resuming mid-page (a non-null cursor) only requests the remaining page — proves checkpoint-based resume, not re-scan', async () => {
  const run = await newRun();
  const calls = [];
  // Two pages: first has_more=true with next_cursor, second has_more=false.
  const client = {
    getTablePage: async (entity, after) => {
      calls.push(after);
      if (after === null) {
        return page([{ id: 'u-1', name: 'u1', email: 'u1@x.test' }], true, 'u-1');
      }
      assert.equal(after, 'u-1', 'the resumed call must ask for exactly the persisted cursor, not restart from null');
      return page([{ id: 'u-2', name: 'u2', email: 'u2@x.test' }], false, null);
    },
  };
  const progress = {};
  await svc._pullEntity(run.id, client, 'User', null, progress);

  assert.deepEqual(calls, [null, 'u-1']);
  const count = await ds.getRepository('User').count({ where: { id: In(['u-1', 'u-2']) } });
  assert.equal(count, 2);
});

test('3. Ticket.parent_id self-FK: inserted NULLed-out first (so the real FK constraint never trips), then backfilled by a second scan', async () => {
  const run = await newRun();
  const now = new Date().toISOString();
  const parent = { id: 'tk-parent', title: 'parent', column_id: null, parent_id: null, created_at: now, updated_at: now };
  // Child references a parent whose row does NOT exist yet at insert time —
  // this is the exact scenario a random-UUID keyset scan produces whenever a
  // child's id happens to sort before its parent's.
  const child = { id: 'tk-child', title: 'child', column_id: null, parent_id: 'tk-parent', created_at: now, updated_at: now };

  const client = { getTablePage: async () => page([child, parent]) }; // child BEFORE parent, deliberately
  const progress = {};

  // Would throw a FK violation on a real Postgres-style enforced constraint
  // if parent_id were inserted as-is — proving the null-then-backfill step is
  // load-bearing, not cosmetic.
  await assert.doesNotReject(() => svc._pullEntity(run.id, client, 'Ticket', null, progress));

  const childRowMidway = await ds.getRepository(Ticket).findOne({ where: { id: 'tk-child' } });
  assert.equal(childRowMidway.parent_id, null, 'parent_id must be NULLed out during the main pull, before the backfill pass');

  await svc._backfillSelfFk(run.id, client, 'Ticket', 'parent_id', 'Ticket.parent_id_backfill', null, progress);

  const childRowFinal = await ds.getRepository(Ticket).findOne({ where: { id: 'tk-child' } });
  assert.equal(childRowFinal.parent_id, 'tk-parent', 'the backfill pass must restore the original parent_id');

  // Idempotent: running the backfill again must not error or change anything.
  await assert.doesNotReject(() => svc._backfillSelfFk(run.id, client, 'Ticket', 'parent_id', 'Ticket.parent_id_backfill', null, progress));
  const childRowRerun = await ds.getRepository(Ticket).findOne({ where: { id: 'tk-child' } });
  assert.equal(childRowRerun.parent_id, 'tk-parent');
});
