// Regression test — ticket 6ca4894a
// "Ontology Graph 1/7 스키마 — OntologyNode/OntologyEdge 엔티티 + sql.js 전용
// DataSource 분리"
//
// DESIGN.md axis 3 / REVIEW-NOTES.md S1(critical)+S3(major): if OntologyNode/
// OntologyEdge shared the PRIMARY sql.js DataSource (dirty flag, flush timer,
// serializeSqljsTransactions() queue), ontology-table growth would inflate
// EVERY subsequent flush of the shared file — blocking the whole instance's
// request handling (ticket moves, comments, dispatch) for every user, not
// just ontology-graph users. The fix is a second, fully independent sql.js
// DataSource (AppOntologyDataSource, db.ts) for ontology tables only.
//
// This suite proves the independence end-to-end, not just that the second
// DataSource exists:
//   1. STATIC GUARD — the primary DataSource's sqljs entities array excludes
//      Ontology*; the ontology DataSource's options point at a different
//      on-disk file and carry their own subscriber class.
//   2. DIRTY-FLAG INDEPENDENCE — writing to one DataSource never marks the
//      other dirty.
//   3. FLUSH INDEPENDENCE — flushing one DataSource never calls the other's
//      saveDatabase(), and never clears the other's dirty flag.
//   4. QUEUE INDEPENDENCE — serializeSqljsTransactions() is applied per-
//      DataSource (db.ts module load), so concurrent transaction() calls on
//      the TWO DIFFERENT DataSources run genuinely in parallel — unlike two
//      overlapping calls on the SAME DataSource, which
//      sqljs-transaction-serialize-queue.test.mjs already proves stay
//      serialized to maxActive=1.
//   5. SAME-PATH COLLISION GUARD (reviewer finding, 6ca4894a Review round 1)
//      — buildOntologyDataSourceOptions() refuses to construct a DataSource
//      whose resolved location equals the primary DataSource's, instead of
//      silently letting two independent sql.js instances export the same
//      on-disk file.
//   6. COMPLETION CRITERION 3, split into what the dual-DataSource split
//      does and does not guarantee (reviewer finding, 6ca4894a Review round
//      1 — the original single test here mocked the gate BEFORE the real
//      saveDatabase() call, so the actual synchronous export never ran
//      concurrently with anything and the test proved nothing):
//        6a. a REAL, chunked ontology bulk-population transaction (many
//            awaited insert chunks, S3's own "batch, minimize transaction()
//            calls" shape) does not block a concurrent primary write —
//            TRUE, and now tested against a real multi-chunk transaction
//            instead of a mocked gate.
//        6b. the flush's own synchronous db.export() call (WASM, verified
//            against typeorm@0.3.31's own source) DOES monopolize the
//            event loop for its duration — a real, DESIGN.md-acknowledged
//            v1 limitation (moving the flush off the main thread is an
//            explicitly rejected v1 mechanism, a named future follow-up),
//            demonstrated here rather than glossed over.
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the
// test script). Uses isolated SQLJS_DB_PATH / SQLJS_ONTOLOGY_DB_PATH temp
// files so it never touches the shared dev database/*.db.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-independence-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const dbUrl = 'file://' + path.join(DIST_ROOT, 'db.js');
const wsUrl = 'file://' + path.join(DIST_ROOT, 'entities', 'Workspace.js');
const nodeUrl = 'file://' + path.join(DIST_ROOT, 'entities', 'OntologyNode.js');

const {
  buildDataSourceOptions,
  buildOntologyDataSourceOptions,
  resolveSqljsLocation,
  resolveOntologySqljsLocation,
  AppDataSource,
  AppOntologyDataSource,
  flushSqljs,
  flushOntologySqljs,
  isSqljsDirty,
  isOntologySqljsDirty,
  OntologySqljsWriteSubscriber,
} = await import(dbUrl);
const { Workspace } = await import(wsUrl);
const { OntologyNode } = await import(nodeUrl);

function makeNode(i) {
  return {
    workspace_id: 'ws-independence-test',
    graph_id: 'graph-independence-test',
    symbol_id: `sym-${i}`,
    type: 'Callable',
    layer: 'structural',
    name: `fn_${i}`,
    confidence: 1.0,
  };
}

describe('ontology sql.js DataSource independence (ticket 6ca4894a)', () => {
  before(async () => {
    await AppDataSource.initialize();
    await AppOntologyDataSource.initialize();
    // Persist each backend's own synchronize()-created schema and reset both
    // dirty flags so every test starts from a known, clean baseline.
    await flushSqljs(AppDataSource, true);
    await flushOntologySqljs(AppOntologyDataSource, true);
  });

  after(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    if (AppOntologyDataSource.isInitialized) await AppOntologyDataSource.destroy();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('static guard: ontology DataSource options are sql.js, own file, own subscriber, ONLY Ontology* entities', () => {
    const ontoOpts = buildOntologyDataSourceOptions();
    assert.equal(ontoOpts.type, 'sqljs');
    assert.ok(Array.isArray(ontoOpts.subscribers) && ontoOpts.subscribers.includes(OntologySqljsWriteSubscriber));

    const primaryLoc = resolveSqljsLocation().location;
    const ontoLoc = resolveOntologySqljsLocation().location;
    assert.notEqual(ontoLoc, primaryLoc, 'ontology DataSource must never point at the primary data.db file');

    const entityNames = ontoOpts.entities.map((e) => e.name).sort();
    assert.deepEqual(entityNames, ['OntologyEdge', 'OntologyNode']);
  });

  it('static guard: the PRIMARY sql.js DataSource excludes Ontology* entities (synchronize never DDLs them into data.db)', () => {
    const primaryOpts = buildDataSourceOptions();
    const entityNames = primaryOpts.entities.map((e) => e.name);
    assert.ok(!entityNames.includes('OntologyNode'), 'OntologyNode must not synchronize into the primary DataSource');
    assert.ok(!entityNames.includes('OntologyEdge'), 'OntologyEdge must not synchronize into the primary DataSource');
  });

  it('same-path collision guard: buildOntologyDataSourceOptions() refuses to construct a DataSource pointed at the primary DB file', () => {
    const primaryLocation = resolveSqljsLocation().location; // absolute tmp path in this test file
    const prevOntologyPath = process.env.SQLJS_ONTOLOGY_DB_PATH;

    try {
      // Exact same absolute path as the primary.
      process.env.SQLJS_ONTOLOGY_DB_PATH = primaryLocation;
      assert.throws(
        () => buildOntologyDataSourceOptions(),
        /same file as the primary sql\.js DB/,
        'an exact-same-path override must throw at construction time, not silently build a colliding DataSource',
      );

      // Differently-SPELLED but same-resolved path (redundant ../ segment) —
      // proves the guard normalizes via path.resolve(), not bare string
      // equality, matching the reviewer's explicit ask.
      const dir = path.dirname(primaryLocation);
      const base = path.basename(primaryLocation);
      process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(dir, '..', path.basename(dir), base);
      assert.throws(
        () => buildOntologyDataSourceOptions(),
        /same file as the primary sql\.js DB/,
        'a redundant-but-equivalent path (via ../) must also be rejected, not just an exact string match',
      );
    } finally {
      process.env.SQLJS_ONTOLOGY_DB_PATH = prevOntologyPath;
    }

    // The real, isolated test config (this file's own env setup) must never
    // trip the guard — default/isolated paths always differ by design.
    assert.doesNotThrow(() => buildOntologyDataSourceOptions(), 'the actual isolated test paths must never collide');
  });

  it('dirty-flag independence: writing ontology rows never marks the primary DataSource dirty, and vice versa', async () => {
    // Baseline: both clean.
    await flushSqljs(AppDataSource, true);
    await flushOntologySqljs(AppOntologyDataSource, true);
    assert.equal(isSqljsDirty(), false);
    assert.equal(isOntologySqljsDirty(), false);

    const nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
    await nodeRepo.save(nodeRepo.create(makeNode('dirty-1')));
    assert.equal(isOntologySqljsDirty(), true, 'an ontology write must mark the ontology dirty flag');
    assert.equal(isSqljsDirty(), false, 'an ontology write must NOT mark the primary dirty flag');

    // Flushing ontology clears only the ontology flag.
    await flushOntologySqljs(AppOntologyDataSource);
    assert.equal(isOntologySqljsDirty(), false);
    assert.equal(isSqljsDirty(), false);

    // Now the reverse direction.
    const wsRepo = AppDataSource.getRepository(Workspace);
    await wsRepo.save(wsRepo.create({ name: 'dirty-flag-check', description: 'primary write' }));
    assert.equal(isSqljsDirty(), true, 'a primary write must mark the primary dirty flag');
    assert.equal(isOntologySqljsDirty(), false, 'a primary write must NOT mark the ontology dirty flag');

    await flushSqljs(AppDataSource);
    assert.equal(isSqljsDirty(), false);
  });

  it('flush independence: flushing one DataSource never calls the other saveDatabase()', async () => {
    const primaryMgr = AppDataSource.sqljsManager;
    const ontoMgr = AppOntologyDataSource.sqljsManager;
    let primarySaves = 0;
    let ontoSaves = 0;
    const origPrimarySave = primaryMgr.saveDatabase.bind(primaryMgr);
    const origOntoSave = ontoMgr.saveDatabase.bind(ontoMgr);
    primaryMgr.saveDatabase = async (...a) => { primarySaves += 1; return origPrimarySave(...a); };
    ontoMgr.saveDatabase = async (...a) => { ontoSaves += 1; return origOntoSave(...a); };

    try {
      const nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
      await nodeRepo.save(nodeRepo.create(makeNode('flush-independence-1')));
      await flushOntologySqljs(AppOntologyDataSource);
      assert.equal(ontoSaves, 1, 'the ontology flush must export exactly once');
      assert.equal(primarySaves, 0, 'flushing ontology must NEVER touch the primary saveDatabase()');

      const wsRepo = AppDataSource.getRepository(Workspace);
      await wsRepo.save(wsRepo.create({ name: 'flush-independence', description: 'primary' }));
      await flushSqljs(AppDataSource);
      assert.equal(primarySaves, 1, 'the primary flush must export exactly once');
      assert.equal(ontoSaves, 1, 'flushing the primary must NEVER touch the ontology saveDatabase() (still 1 from above)');
    } finally {
      primaryMgr.saveDatabase = origPrimarySave;
      ontoMgr.saveDatabase = origOntoSave;
    }
  });

  it('queue independence: overlapping transaction() calls on the TWO DIFFERENT DataSources run concurrently, not serialized', async () => {
    // Contrast with sqljs-transaction-serialize-queue.test.mjs, which proves
    // maxActive stays at 1 for two overlapping calls on the SAME DataSource.
    // Here, one call per DataSource, at the same time — if they shared a
    // queue (the bug this ticket exists to prevent), maxActive would be
    // capped at 1 exactly like the single-DataSource case.
    let active = 0;
    let maxActive = 0;
    const hold = (manager, name) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const repo = manager.getRepository(name === 'onto' ? OntologyNode : Workspace);
      if (name === 'onto') {
        await repo.save(repo.create(makeNode(`queue-independence-${Date.now()}`)));
      } else {
        await repo.save(repo.create({ name: `queue-independence-${Date.now()}`, description: 'x' }));
      }
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
    };

    await Promise.all([
      AppDataSource.transaction(hold(AppDataSource.manager, 'primary')),
      AppOntologyDataSource.transaction(hold(AppOntologyDataSource.manager, 'onto')),
    ]);

    assert.equal(
      maxActive,
      2,
      'a transaction on the primary DataSource and a transaction on the ontology DataSource must be able to run ' +
        'at the same time — if maxActive stayed at 1, the two DataSources would be sharing a serialization queue, ' +
        'exactly the cross-contamination this ticket exists to prevent',
    );
  });

  // COMPLETION CRITERION 3, corrected (reviewer finding, 6ca4894a Review
  // round 1): the previous version of this test gated the MOCKED
  // saveDatabase() behind a Promise BEFORE calling the real
  // origOntoSave() — meaning the real, synchronous WASM db.export() call
  // (measured at 676ms for a 950k-row DB, scripts/benchmark-ontology-flush.mjs)
  // never actually ran while the "concurrent" primary write executed, so the
  // test proved nothing about the real export window. Verified directly
  // against typeorm@0.3.31's own source
  // (node_modules/typeorm/driver/sqljs/SqljsDriver.js `save()`): the
  // underlying `this.databaseConnection.export()` call is fully synchronous
  // — no internal await — and calling an async function runs its body
  // synchronously up to its first REAL await, so that export call (and
  // every transitive synchronous call above it: SqljsEntityManager.
  // saveDatabase() → SqljsDriver.save()) executes in the SAME tick as
  // `flushOntologySqljs(...)`'s call site, before that call even returns a
  // pending promise. Node.js is single-threaded — nothing else in the
  // process, on ANY DataSource, can run while that synchronous chain is
  // executing. The two tests below split completion criterion 3 into
  // exactly what the dual-DataSource split does and does not guarantee,
  // instead of one test overclaiming both:
  it('COMPLETION CRITERION 3a: a real, chunked ontology bulk-population transaction does not block a concurrent primary write (ticket-move/comment stand-in)', async () => {
    // Real multi-chunk transaction — S3's own "minimize transaction() call
    // count" guidance means ONE transaction() wrapping many batched inserts,
    // each `await`ed individually so the event loop gets a genuine yield
    // point between chunks (unlike the flush's single unyielding export
    // call). The 5ms pacing between chunks is test-only — it exists solely
    // to make the interleaving assertions below deterministic across
    // machines of different speed, not to change the real code path (which
    // has no such delay, see benchmark-ontology-flush.mjs).
    const CHUNK_SIZE = 100;
    const CHUNK_COUNT = 30;
    let chunksCompleted = 0;

    const population = AppOntologyDataSource.manager.transaction(async (manager) => {
      const repo = manager.getRepository(OntologyNode);
      for (let c = 0; c < CHUNK_COUNT; c++) {
        const rows = Array.from({ length: CHUNK_SIZE }, (_, i) =>
          repo.create(makeNode(`bulk-pop-${c}-${i}`)));
        await repo.insert(rows);
        await new Promise((r) => setTimeout(r, 5)); // test-only pacing, see comment above
        chunksCompleted++;
      }
    });

    // Wait until population has genuinely started (a few chunks landed).
    while (chunksCompleted < 2) await new Promise((r) => setImmediate(r));

    const wsRepo = AppDataSource.getRepository(Workspace);
    const start = Date.now();
    await AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Workspace);
      await repo.save(repo.create({ name: 'interleaved-during-bulk-population', description: 'ticket-move/comment stand-in' }));
    });
    const elapsedMs = Date.now() - start;

    assert.ok(
      chunksCompleted < CHUNK_COUNT,
      `population must still be incomplete (${chunksCompleted}/${CHUNK_COUNT} chunks done) right after the ` +
        `interleaved primary write finished — otherwise this proves sequential execution, not real overlap`,
    );
    assert.ok(
      elapsedMs < 300,
      `an interleaved primary write should complete quickly (took ${elapsedMs}ms) while a ${CHUNK_COUNT}-chunk ` +
        `ontology bulk population transaction is actively running`,
    );

    await population; // let it finish — don't leave a dangling in-flight transaction
    assert.equal(chunksCompleted, CHUNK_COUNT);

    const names = (await wsRepo.find()).map((w) => w.name);
    assert.ok(names.includes('interleaved-during-bulk-population'), 'the primary write must have actually committed, not just resolved fast');
  });

  it('KNOWN V1 LIMITATION, documented not claimed fixed: the ontology flush\'s synchronous db.export() call monopolizes the event loop for its duration', async () => {
    // DESIGN.md axis 3 explicitly REJECTS "moving the sql.js flush off the
    // main thread" as a v1 mechanism (sql.js's WASM-resident Database object
    // cannot safely cross a worker_threads boundary without a flush-
    // ownership redesign the design document does not size) — this is a
    // real, named follow-up (§10a), not a v1 commitment. This test proves
    // the limitation exists structurally (deterministic — ordering, not
    // wall-clock racing) rather than silently asserting non-blocking where
    // it isn't true.
    // Chunked inserts, not one 3000-row .insert() call — TypeORM's bulk
    // insert builder blows past sql.js/SQLite's expression-tree depth limit
    // (~1000) well before 3000 rows × this entity's column count. This is
    // orthogonal to the point being tested here (some real data must exist
    // so the flush below does a real export, not an early-return); the
    // chunk-vs-single-call distinction matters for populating quickly
    // without erroring, not for the blocking behavior under test.
    const repo = AppOntologyDataSource.getRepository(OntologyNode);
    for (let offset = 0; offset < 3000; offset += 500) {
      await repo.insert(Array.from({ length: 500 }, (_, i) => makeNode(`export-block-${offset + i}`)));
    }
    assert.equal(isOntologySqljsDirty(), true, 'sanity: there must be pending writes for the flush below to actually export, not early-return');

    let microtaskRan = false;
    Promise.resolve().then(() => { microtaskRan = true; });

    // A plain (non-awaited) call — the async function's body, including the
    // real synchronous db.export() deep inside it, runs to completion in
    // THIS line, before control ever returns here.
    const flushPromise = flushOntologySqljs(AppOntologyDataSource, true);

    assert.equal(
      microtaskRan,
      false,
      'a microtask scheduled strictly BEFORE calling flushOntologySqljs() must not have run yet immediately after ' +
        'that call returns a pending promise — a currently-executing synchronous call stack is never interrupted ' +
        'to run a microtask. If this assertion fails, either the driver stopped doing a synchronous export (re-verify ' +
        'this test/comment against the installed typeorm version) or something upstream changed the call chain.',
    );

    await flushPromise;
    assert.equal(microtaskRan, true, 'the microtask must have run by the time the flush promise settles');
  });
});

// TypeORM/sql.js leave handles that keep the event loop alive. The suite is
// launched with `--test-force-exit`, which tears those down and exits with the
// real code node:test computed — no manual process.exit, which would have
// overridden the exit code and masked a failed assertion.
