// Regression test — ticket d5a8594a
// "sql.js autoSave 전체-DB 재직렬화 write amplification"
//
// Proves the dev sql.js write-amplification fix end-to-end:
//
//   1. STATIC GUARD — buildDataSourceOptions() for the sqlite/sqljs backend
//      ships `autoSave: false` and registers SqljsWriteSubscriber. If someone
//      flips autoSave back on, the whole batching scheme silently regresses to
//      per-write full-DB serialization — so this is asserted explicitly.
//
//   2. WRITE AMPLIFICATION — N writes between flushes trigger exactly ONE
//      saveDatabase() (one full-DB export), not N. That is the entire point:
//      the per-write Uint8Array allocation churn is gone.
//
//   3. IDLE = ZERO WORK — with no pending writes, flushSqljs() performs no save
//      (the dirty flag gates it).
//
//   4. DATA INTEGRITY / "재부팅 후 손실 범위" — after a flush, a freshly-opened
//      DataSource (a simulated reboot) reads the persisted rows. Writes made
//      AFTER the last flush are NOT on disk — that bounded window is exactly the
//      documented crash-loss trade-off.
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the test
// script). Uses an isolated SQLJS_DB_PATH temp file so it never touches the
// shared dev database/data.db.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

// Isolated db file BEFORE importing db.js (resolveSqljsLocation reads the env).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-sqljs-flush-'));
const DB_FILE = path.join(tmpDir, 'flush-test.db');
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const dbUrl = 'file://' + path.join(DIST_ROOT, 'db.js');
const wsUrl = 'file://' + path.join(DIST_ROOT, 'entities', 'Workspace.js');

const {
  buildDataSourceOptions,
  AppDataSource,
  flushSqljs,
  isSqljsDirty,
  isSqljsBackend,
  SqljsWriteSubscriber,
} = await import(dbUrl);
const { Workspace } = await import(wsUrl);
const { DataSource } = await import('typeorm');

/** Count rows by opening a *fresh* DataSource on the same file — a "reboot". */
async function countAfterReboot() {
  const ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();
  try {
    return await ds.getRepository(Workspace).count();
  } finally {
    await ds.destroy();
  }
}

describe('sql.js batched flush (ticket d5a8594a)', () => {
  let saveSpy = 0;

  before(async () => {
    await AppDataSource.initialize();
    // Spy on the real saveDatabase so we can count full-DB exports. sqljsManager
    // returns the stable EntityManager instance, so an own-property override
    // shadows the prototype method for every flushSqljs() call.
    const mgr = AppDataSource.sqljsManager;
    const orig = mgr.saveDatabase.bind(mgr);
    mgr.saveDatabase = async (...args) => {
      saveSpy += 1;
      return orig(...args);
    };
    // Persist the schema produced by initialize()/synchronize() and reset the
    // counter so the per-test assertions start from a known baseline.
    await flushSqljs(AppDataSource, true);
    saveSpy = 0;
  });

  after(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('static guard: sqljs options have autoSave:false + SqljsWriteSubscriber', () => {
    assert.equal(isSqljsBackend(), true, 'sqlite DB_TYPE should map to the sqljs backend');
    const opts = buildDataSourceOptions();
    assert.equal(opts.type, 'sqljs');
    assert.equal(opts.autoSave, false, 'autoSave MUST stay false — on=per-write full-DB re-serialization');
    assert.ok(
      Array.isArray(opts.subscribers) && opts.subscribers.includes(SqljsWriteSubscriber),
      'SqljsWriteSubscriber must be registered so writes mark the dirty flag',
    );
  });

  it('write amplification: N writes → exactly ONE saveDatabase per flush', async () => {
    const repo = AppDataSource.getRepository(Workspace);

    // Five writes, no flush in between.
    saveSpy = 0;
    for (let i = 0; i < 5; i++) {
      await repo.save(repo.create({ name: `wa-${i}`, description: 'write-amp' }));
    }
    assert.equal(saveSpy, 0, 'writes must NOT hit disk individually (autoSave off)');
    assert.equal(isSqljsDirty(), true, 'pending writes should mark the DB dirty');

    const saved = await flushSqljs(AppDataSource);
    assert.equal(saved, true, 'flush with pending writes should persist');
    assert.equal(saveSpy, 1, 'one flush = one full-DB export for all 5 writes');
    assert.equal(isSqljsDirty(), false, 'a successful flush clears the dirty flag');
  });

  it('idle = zero work: flush with no pending writes performs no save', async () => {
    saveSpy = 0;
    const saved = await flushSqljs(AppDataSource);
    assert.equal(saved, false, 'nothing dirty → no save');
    assert.equal(saveSpy, 0, 'idle server must allocate/serialize nothing');
  });

  it('data integrity: flushed rows survive a reboot; unflushed rows are the loss window', async () => {
    const repo = AppDataSource.getRepository(Workspace);

    // Baseline: everything written so far is flushed.
    await flushSqljs(AppDataSource, true);
    const beforeCount = await countAfterReboot();

    // Write one row and flush → must survive a reboot.
    await repo.save(repo.create({ name: 'persisted', description: 'flushed' }));
    await flushSqljs(AppDataSource);
    assert.equal(
      await countAfterReboot(),
      beforeCount + 1,
      'a flushed write must be visible after reopening the file',
    );

    // Write another row WITHOUT flushing → simulates a hard crash before the
    // next tick. The reboot must NOT see it (bounded, documented loss window).
    await repo.save(repo.create({ name: 'lost', description: 'never flushed' }));
    assert.equal(isSqljsDirty(), true, 'the unflushed write leaves the DB dirty');
    assert.equal(
      await countAfterReboot(),
      beforeCount + 1,
      'an unflushed write must NOT be on disk — this is the crash-loss window',
    );

    // A final flush persists it (graceful-shutdown behavior).
    await flushSqljs(AppDataSource, true);
    assert.equal(
      await countAfterReboot(),
      beforeCount + 2,
      'the forced shutdown-style flush persists the previously-unflushed write',
    );
  });
});

// Mirror the leak-test pattern: TypeORM/sql.js leave handles that keep the
// event loop alive, so force exit once tests complete.
process.on('beforeExit', () => process.exit(0));
