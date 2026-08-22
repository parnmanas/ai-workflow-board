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
//   5. THE COMPLETION-CRITERION TEST — a slow/held ontology flush (standing
//      in for a large bulk population/fan-out write) does NOT delay a
//      concurrent primary-DataSource write (standing in for an ordinary
//      ticket-move/comment write, same convention sqljs-batched-flush.test.mjs
//      already uses Workspace for).
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

  it('COMPLETION CRITERION: a slow/held ontology flush does not delay a concurrent primary write (ticket-move/comment stand-in)', async () => {
    const ontoMgr = AppOntologyDataSource.sqljsManager;
    const origOntoSave = ontoMgr.saveDatabase.bind(ontoMgr);

    let release;
    const gate = new Promise((res) => { release = res; });
    let flushStarted = false;
    ontoMgr.saveDatabase = async (...a) => {
      flushStarted = true;
      await gate; // simulate a large bulk-write flush (measured: 676ms @ 950k rows, scripts/benchmark-ontology-flush.mjs) taking a long time to export
      return origOntoSave(...a);
    };

    try {
      const nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
      await nodeRepo.save(nodeRepo.create(makeNode('completion-criterion-1')));

      // Kick off the (artificially slow) ontology flush but do not await it yet.
      const ontoFlush = flushOntologySqljs(AppOntologyDataSource, true);
      while (!flushStarted) await new Promise((r) => setImmediate(r));

      // While that flush is stuck behind the gate, do an ordinary primary-
      // DataSource write+transaction — the same shape a ticket move or
      // comment insert takes (Workspace standing in, same convention as
      // sqljs-batched-flush.test.mjs).
      const wsRepo = AppDataSource.getRepository(Workspace);
      const start = Date.now();
      await AppDataSource.transaction(async (manager) => {
        const repo = manager.getRepository(Workspace);
        await repo.save(repo.create({ name: 'existing-awb-write', description: 'ticket-move/comment stand-in' }));
      });
      const elapsedMs = Date.now() - start;

      assert.ok(
        elapsedMs < 500,
        `an existing AWB write must complete quickly even while a huge ontology flush is in flight — ` +
          `took ${elapsedMs}ms (would be stuck for the full gated duration if the two DataSources shared ` +
          `a dirty flag / flush timer / transaction queue)`,
      );

      release();
      const ontoSaved = await ontoFlush;
      assert.equal(ontoSaved, true, 'the held ontology flush itself must still complete successfully once released');

      const names = (await wsRepo.find()).map((w) => w.name);
      assert.ok(names.includes('existing-awb-write'), 'the primary write must have actually committed, not just resolved fast');
    } finally {
      ontoMgr.saveDatabase = origOntoSave;
    }
  });
});

// TypeORM/sql.js leave handles that keep the event loop alive. The suite is
// launched with `--test-force-exit`, which tears those down and exits with the
// real code node:test computed — no manual process.exit, which would have
// overridden the exit code and masked a failed assertion.
