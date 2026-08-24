// Regression / feature proof: live pull import preflight (ticket 0f638509,
// 완료 기준 2 — "프리플라이트가 버전/스키마 불일치, 비어있지 않은 도착지를
// 거부한다").
//
// Review round 1 P1 (blocking): the FIRST version of this test built its fake
// source `tables` list from `MIGRATION_ENTITY_ORDER` directly, which
// conveniently sidestepped a real bug — `MigrationExportController.meta()`
// reported EVERY `dataSource.entityMetadatas` entry (including `MigrationRun`
// itself, the control table), while `MIGRATION_ENTITY_ORDER` never includes
// it, so `entities_unknown_to_dest=[MigrationRun]` made comparePreflight()
// return `ok=false` on EVERY real call — even between two identical builds.
// Test 6 below drives the REAL `MigrationExportController.meta()` handler
// (not a hand-rolled table list) specifically to catch this class of bug.
//
// Drives MigrationRunService.startRun() against a REAL sqljs destination
// DataSource with a fake source client injected via the protected
// createClient() seam (see migration-run.service.ts — extracted specifically
// so tests don't need a live HTTP server, which guardedFetch would refuse
// anyway for a loopback source_url).
//
// Runs against compiled dist/ (requires `npm run build`). Isolated
// SQLJS_DB_PATH temp file — never touches the shared dev database/data.db.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const modPath = (...p) => 'file://' + path.join(DIST, ...p);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-migration-preflight-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'migration-preflight-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import(modPath('db.js'));
const { MigrationRun } = await import(modPath('entities', 'MigrationRun.js'));
const { Workspace } = await import(modPath('entities', 'Workspace.js'));
const { MigrationRunService } = await import(modPath('modules', 'migration', 'migration-run.service.js'));
const { MigrationExportController } = await import(modPath('modules', 'migration', 'migration-export.controller.js'));
const { computeSchemaFingerprint } = await import(modPath('modules', 'migration', 'migration-crypto.js'));
const { listMigratableEntityMetadata } = await import(modPath('modules', 'migration', 'migration-entity-registry.js'));
const { DataSource } = await import('typeorm');

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const quiesceStub = { setQuiesced: async () => {}, isQuiesced: async () => false, getReason: async () => '' };
const noDeployment = { getLatest: async () => null };
const runRepo = ds.getRepository(MigrationRun);
const localFingerprint = computeSchemaFingerprint(ds);

/**
 * Calls the REAL MigrationExportController.meta() handler against `dataSource`
 * — not a hand-rolled table list — so a regression in what it reports (like
 * the MigrationRun self-reference bug) is caught here, not just in the
 * shared-filter unit. `deployments` defaults to a stub reporting no self-deploy
 * (commit_sha=''), which comparePreflight already treats as "skip that check".
 */
async function realExportMeta(dataSource, deployments = noDeployment) {
  const controller = new MigrationExportController(dataSource, deployments, { logActivity: async () => {} });
  let captured = null;
  const fakeReq = { apiKey: { id: 'test-key', name: 'test-key' } };
  await controller.meta(fakeReq, { json: (body) => { captured = body; } });
  return captured;
}

/** Fake source meta built from the REAL per-entity candidate list (review round 1 P1 fix), with overridable fields. */
function fakeMetaFrom(dataSource, overrides = {}) {
  return {
    app_version: '',
    commit_sha: '',
    schema_fingerprint: computeSchemaFingerprint(dataSource),
    tables: listMigratableEntityMetadata(dataSource).map((t) => ({ ...t, row_count: 0 })),
    ...overrides,
  };
}

class TestableMigrationRunService extends MigrationRunService {
  constructor(...args) {
    super(...args);
    this.fakeMeta = fakeMetaFrom(ds);
  }
  createClient() {
    const meta = this.fakeMeta;
    return {
      getMeta: async () => meta,
      getTablePage: async () => ({ rows: [], has_more: false, next_cursor: null }),
    };
  }
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('1. schema_fingerprint mismatch is rejected — no MigrationRun row is even created', async () => {
  const svc = new TestableMigrationRunService(ds, runRepo, logStub, quiesceStub);
  svc.fakeMeta = fakeMetaFrom(ds, { schema_fingerprint: 'deadbeef-not-the-real-fingerprint' });

  await assert.rejects(
    () => svc.startRun({ sourceUrl: 'https://source.invalid', sourceToken: 'tok', skipAttachments: true, allowMerge: false, createdBy: 'test' }),
    /schema_fingerprint mismatch/,
  );
  const count = await runRepo.count();
  assert.equal(count, 0, 'a failed preflight must not leave a MigrationRun row behind');
});

test('2. app_version mismatch is rejected when both sides report a non-empty, differing value', async () => {
  const svc = new TestableMigrationRunService(ds, runRepo, logStub, quiesceStub);
  svc.fakeMeta = fakeMetaFrom(ds, { app_version: '99.99.99' }); // local package.json is "1.0.0"

  await assert.rejects(
    () => svc.startRun({ sourceUrl: 'https://source.invalid', sourceToken: 'tok', skipAttachments: true, allowMerge: false, createdBy: 'test' }),
    /app_version mismatch/,
  );
});

test('3. entity missing on source is surfaced as a diagnostic reason alongside the fingerprint mismatch it causes', async () => {
  const svc = new TestableMigrationRunService(ds, runRepo, logStub, quiesceStub);
  const partialTables = listMigratableEntityMetadata(ds).filter((t) => t.entity !== 'Credential').map((t) => ({ ...t, row_count: 0 }));
  // Dropping a table changes nothing about the schema fingerprint itself (the
  // fingerprint is computed locally, not from the reported table list), so
  // this only fails via the explicit entity-set comparison — proving that
  // check pulls its own weight independently of the fingerprint gate.
  svc.fakeMeta = { app_version: '', commit_sha: '', schema_fingerprint: localFingerprint, tables: partialTables };

  await assert.rejects(
    () => svc.startRun({ sourceUrl: 'https://source.invalid', sourceToken: 'tok', skipAttachments: true, allowMerge: false, createdBy: 'test' }),
    /entities this destination expects but the source does not report: Credential/,
  );
});

test('4. a non-empty destination is rejected without allow_merge, and accepted with it', async () => {
  const wsRepo = ds.getRepository(Workspace);
  await wsRepo.save(wsRepo.create({ name: 'pre-existing workspace' }));

  const svc = new TestableMigrationRunService(ds, runRepo, logStub, quiesceStub);

  await assert.rejects(
    () => svc.startRun({ sourceUrl: 'https://source.invalid', sourceToken: 'tok', skipAttachments: true, allowMerge: false, createdBy: 'test' }),
    /Destination is not empty/,
  );

  const run = await svc.startRun({ sourceUrl: 'https://source.invalid', sourceToken: 'tok', skipAttachments: true, allowMerge: true, createdBy: 'test' });
  assert.ok(run.id, 'allow_merge=true must let startRun proceed past the non-empty-destination gate');
  assert.equal(run.status, 'running');
});

test('5. a clean preflight (matching fingerprint, empty destination) creates a running MigrationRun', async () => {
  // Runs in its own fresh sqljs DataSource so "empty destination" is actually true —
  // test 4 above deliberately left rows behind.
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-migration-preflight-clean-'));
  const prevPath = process.env.SQLJS_DB_PATH;
  process.env.SQLJS_DB_PATH = path.join(tmpDir2, 'clean.db');
  const ds2 = new DataSource(buildDataSourceOptions());
  await ds2.initialize();
  process.env.SQLJS_DB_PATH = prevPath;

  try {
    const runRepo2 = ds2.getRepository(MigrationRun);
    const fingerprint2 = computeSchemaFingerprint(ds2);
    assert.equal(fingerprint2, localFingerprint, 'two freshly-synchronized DataSources on the same code must fingerprint identically');

    class Testable2 extends MigrationRunService {
      createClient() {
        return { getMeta: async () => fakeMetaFrom(ds2), getTablePage: async () => ({ rows: [], has_more: false, next_cursor: null }) };
      }
    }
    const svc2 = new Testable2(ds2, runRepo2, logStub, quiesceStub);
    const run = await svc2.startRun({ sourceUrl: 'https://source.invalid', sourceToken: 'tok', skipAttachments: true, allowMerge: false, createdBy: 'test' });
    assert.equal(run.status, 'running');
    assert.equal(run.phase, 'core');
  } finally {
    await ds2.destroy();
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  }
});

test('6. [review round 1 P1] the REAL MigrationExportController.meta() output for a same-build source passes this destination\'s own preflight — MigrationRun itself must not appear as an unknown-to-dest entity', async () => {
  const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-migration-preflight-realmeta-'));
  const prevPath = process.env.SQLJS_DB_PATH;
  process.env.SQLJS_DB_PATH = path.join(tmpDir3, 'realmeta-source.db');
  const sourceDs = new DataSource(buildDataSourceOptions());
  await sourceDs.initialize();
  process.env.SQLJS_DB_PATH = prevPath;

  try {
    // The exact payload a real source server would return — built entirely by
    // the real controller class, no test-authored shortcuts.
    const realMeta = await realExportMeta(sourceDs);

    assert.ok(
      !realMeta.tables.some((t) => t.entity === 'MigrationRun'),
      'MigrationExportController.meta() must not report its own control table (migration_runs) as a migration candidate',
    );
    assert.equal(realMeta.schema_fingerprint, localFingerprint, 'two independently-synchronized same-code DataSources must fingerprint identically');

    class TestableRealMeta extends MigrationRunService {
      createClient() {
        return { getMeta: async () => realMeta, getTablePage: async () => ({ rows: [], has_more: false, next_cursor: null }) };
      }
    }
    const svc = new TestableRealMeta(ds, runRepo, logStub, quiesceStub);
    // Reuses the `ds` destination, which already carries rows from earlier
    // tests in this file — allow_merge=true is the correct real-world flag
    // for "resume/second run", not a workaround for this test's ordering.
    const run = await svc.startRun({ sourceUrl: 'https://source.invalid', sourceToken: 'tok', skipAttachments: true, allowMerge: true, createdBy: 'test' });
    assert.equal(run.status, 'running', 'a same-build source/destination pair must pass preflight using the REAL export payload shape');
  } finally {
    await sourceDs.destroy();
    fs.rmSync(tmpDir3, { recursive: true, force: true });
  }
});
