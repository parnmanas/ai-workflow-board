// Regression / feature proof: live pull import preflight (ticket 0f638509,
// 완료 기준 2 — "프리플라이트가 버전/스키마 불일치, 비어있지 않은 도착지를
// 거부한다").
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-migration-preflight-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'migration-preflight-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { MigrationRun } = await import('file://' + path.join(DIST, 'entities', 'MigrationRun.js'));
const { Workspace } = await import('file://' + path.join(DIST, 'entities', 'Workspace.js'));
const { MigrationRunService } = await import('file://' + path.join(DIST, 'modules', 'migration', 'migration-run.service.js'));
const { computeSchemaFingerprint } = await import('file://' + path.join(DIST, 'modules', 'migration', 'migration-crypto.js'));
const { MIGRATION_ENTITY_ORDER } = await import('file://' + path.join(DIST, 'modules', 'migration', 'migration-entity-registry.js'));
const { DataSource } = await import('typeorm');

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const quiesceStub = { setQuiesced: async () => {}, isQuiesced: async () => false, getReason: async () => '' };
const runRepo = ds.getRepository(MigrationRun);
const localFingerprint = computeSchemaFingerprint(ds);

/** Fake source meta reporting every entity this destination's code knows about, with a given fingerprint. */
function fakeMeta(overrides = {}) {
  return {
    app_version: '',
    commit_sha: '',
    schema_fingerprint: localFingerprint,
    tables: MIGRATION_ENTITY_ORDER.map((e) => ({ entity: e, table: e, row_count: 0 })),
    ...overrides,
  };
}

class TestableMigrationRunService extends MigrationRunService {
  constructor(...args) {
    super(...args);
    this.fakeMeta = fakeMeta();
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
  svc.fakeMeta = fakeMeta({ schema_fingerprint: 'deadbeef-not-the-real-fingerprint' });

  await assert.rejects(
    () => svc.startRun({ sourceUrl: 'https://source.invalid', sourceToken: 'tok', skipAttachments: true, allowMerge: false, createdBy: 'test' }),
    /schema_fingerprint mismatch/,
  );
  const count = await runRepo.count();
  assert.equal(count, 0, 'a failed preflight must not leave a MigrationRun row behind');
});

test('2. app_version mismatch is rejected when both sides report a non-empty, differing value', async () => {
  const svc = new TestableMigrationRunService(ds, runRepo, logStub, quiesceStub);
  svc.fakeMeta = fakeMeta({ app_version: '99.99.99' }); // local package.json is "1.0.0"

  await assert.rejects(
    () => svc.startRun({ sourceUrl: 'https://source.invalid', sourceToken: 'tok', skipAttachments: true, allowMerge: false, createdBy: 'test' }),
    /app_version mismatch/,
  );
});

test('3. entity missing on source is surfaced as a diagnostic reason alongside the fingerprint mismatch it causes', async () => {
  const svc = new TestableMigrationRunService(ds, runRepo, logStub, quiesceStub);
  const partialTables = MIGRATION_ENTITY_ORDER.filter((e) => e !== 'Credential').map((e) => ({ entity: e, table: e, row_count: 0 }));
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
        return {
          getMeta: async () => fakeMeta({ schema_fingerprint: fingerprint2 }),
          getTablePage: async () => ({ rows: [], has_more: false, next_cursor: null }),
        };
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
