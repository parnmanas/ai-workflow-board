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
//   6. COMPLETION CRITERION 3, corrected TWICE across reviewer round 1 (see
//      the long comment directly above the KNOWN V1 LIMITATION test below
//      for the full history — the first fix mocked the gate before the real
//      saveDatabase() call and proved nothing; the second fix's own
//      "chunked bulk-population" test smuggled in a test-only setTimeout
//      that did real work the actual (nonexistent, out-of-scope) population
//      path isn't guaranteed to reproduce). What THIS ticket actually
//      guarantees and tests: queue independence (item 4 above) is the
//      necessary structural precondition; the flush's own synchronous
//      db.export() DOES monopolize the event loop for its duration — a
//      real, DESIGN.md-acknowledged v1 limitation, not a bug, demonstrated
//      deterministically below. Full non-blocking behavior for a REAL bulk
//      population workload is explicitly NOT established here and is a
//      required obligation of whichever ticket implements that workload
//      (flagged on ticket e14ef1c9 directly, not just documented here).
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

  // COMPLETION CRITERION 3, corrected TWICE (reviewer findings, 6ca4894a
  // Review round 1 — the reviewer approved fixes 1+2 above after re-running
  // this suite locally, but round-1's own first pass at 3a was itself still
  // wrong and got a second, sharper finding):
  //
  // Round-1-a: the FIRST version of this test gated the MOCKED
  // saveDatabase() behind a Promise BEFORE calling the real
  // origOntoSave() — meaning the real, synchronous WASM db.export() call
  // (measured at 676ms for a 950k-row DB, scripts/benchmark-ontology-flush.mjs)
  // never actually ran while the "concurrent" primary write executed. Fixed
  // by replacing the mock with the KNOWN V1 LIMITATION test below (real,
  // unmocked flush; see its own comment for the fix detail).
  //
  // Round-1-b (this fix): the SECOND version — "COMPLETION CRITERION 3a" —
  // wrapped a real multi-chunk ontology transaction with a test-only
  // `setTimeout(5)` between chunks to make the interleaving assertion
  // deterministic, and claimed this proved "a real bulk-population
  // transaction does not block a concurrent primary write." The reviewer
  // correctly rejected this: this ticket's scope is schema + DataSource
  // split ONLY — there is no actual bulk-population/writer service anywhere
  // in this codebase yet (that is ticket e14ef1c9's job, the extraction
  // worker), so "the real path" that claim referred to does not exist to be
  // tested. The setTimeout(5) was doing real work in the test (creating an
  // event-loop yield point) that a from-scratch population implementation
  // is not guaranteed to reproduce — `await repo.insert()` alone resolves
  // via the microtask queue, which does not guarantee a fair yield to the
  // timer/I/O phase the way an explicit macrotask (setImmediate/setTimeout)
  // does, so the claim did not transfer to "any real chunked population
  // loop," only to "a loop that happens to yield via a macrotask between
  // chunks."
  //
  // Correction: completion criterion 3's literal wording ("온톨로지 대량
  // 쓰기 중 기존 AWB 쓰기가 블로킹되지 않음을 테스트로 검증") requires an
  // actual population workload to verify in real wall-clock terms — this
  // ticket cannot honestly claim that without inventing an out-of-scope
  // population implementation. What THIS ticket verifies and guarantees is
  // the STRUCTURAL, necessary precondition: the 'queue independence' test
  // above already proves a transaction() on the ontology DataSource and a
  // transaction() on the primary DataSource run concurrently (maxActive=2)
  // — i.e. they do NOT share `serializeSqljsTransactions()`'s FIFO queue,
  // so nothing in THIS ticket's own code forces population writes to
  // serialize behind primary writes or vice versa. That is necessary but
  // NOT sufficient on its own: whichever ticket implements the actual bulk
  // population loop (e14ef1c9, the extraction worker, or any later
  // fan-out writer) MUST additionally (a) yield the event loop between
  // batches via an explicit macrotask (e.g. `setImmediate`), not rely on
  // microtask-chained `await`s alone, and (b) test ITS OWN real write path
  // for non-blocking behavior directly — that obligation is NOT satisfied
  // by anything in this ticket and must not be assumed inherited from it.
  // (Flagged explicitly as a comment on ticket e14ef1c9 itself, not just
  // buried here.)

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
