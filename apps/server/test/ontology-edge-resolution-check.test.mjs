// Regression test — ticket 6ca4894a (reviewer finding, Review round 1)
//
// OntologyEdge.resolution was a TypeScript union (OntologyEdgeResolution)
// over a plain `varchar` column with no DB-level constraint — Postgres and
// sql.js could both silently store any string, since TypeScript types are
// erased at runtime and never checked by either database. DESIGN.md axis 2
// pins `resolution` as a genuinely CLOSED vocabulary (unlike type/kind/layer,
// which are deliberately open/workspace-extensible) — the ticket's own text
// literally writes it as `resolution ENUM('exact','name_match','dynamic',
// 'unresolved')`.
//
// TypeORM's `simple-enum` column type was considered and rejected as the
// fix: verified directly against typeorm@0.3.31's own source
// (AbstractSqliteDriver.js normalizeType(): `simple-enum` → plain "varchar"
// with NO check constraint; DateUtils.simpleEnumToString() is a no-op
// stringify) — on the sql.js/SQLite backend it provides ZERO enforcement,
// only Postgres (where simple-enum maps to a real native enum type) would
// actually be protected. A `@Check()` constraint is portable SQL both
// dialects support natively and was verified empirically (a throwaway probe
// against a real sql.js DataSource) to generate a real `CONSTRAINT ... CHECK`
// clause and reject invalid values with `CHECK constraint failed`.
//
// This suite proves the actual, shipped OntologyEdge entity enforces the
// closed vocabulary at the storage layer, not just via its TypeScript type.
//
// Runs against compiled dist/ (requires `npm run build`). Uses an isolated
// SQLJS_ONTOLOGY_DB_PATH temp file so it never touches the shared dev
// database/ontology.db.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-edge-check-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { AppOntologyDataSource } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { OntologyEdge, ONTOLOGY_EDGE_RESOLUTION_VALUES } = await import(
  'file://' + path.join(DIST_ROOT, 'entities', 'OntologyEdge.js')
);

function makeEdgeRow(overrides = {}) {
  return {
    workspace_id: 'ws-check-test',
    graph_id: 'graph-check-test',
    src_id: 'node-a',
    dst_id: 'node-b',
    type: 'CALLS',
    layer: 'structural',
    confidence: 1.0,
    ...overrides,
  };
}

describe('OntologyEdge.resolution — DB-level closed-vocabulary enforcement (ticket 6ca4894a)', () => {
  before(async () => {
    await AppOntologyDataSource.initialize();
  });

  after(async () => {
    if (AppOntologyDataSource.isInitialized) await AppOntologyDataSource.destroy();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('the generated DDL actually carries a CHECK constraint on resolution (not just a plain varchar)', async () => {
    const rows = await AppOntologyDataSource.query(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='ontology_edges'`,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].sql, /CHECK/, 'the ontology_edges DDL must contain a CHECK constraint');
    for (const value of ONTOLOGY_EDGE_RESOLUTION_VALUES) {
      assert.match(rows[0].sql, new RegExp(`'${value}'`), `the CHECK clause must name '${value}' as an allowed value`);
    }
  });

  it('accepts every documented resolution value via the ORM', async () => {
    const repo = AppOntologyDataSource.getRepository(OntologyEdge);
    for (const value of ONTOLOGY_EDGE_RESOLUTION_VALUES) {
      const saved = await repo.save(repo.create(makeEdgeRow({ resolution: value })));
      assert.equal(saved.resolution, value);
    }
  });

  it('accepts NULL — non-CALLS edges leave resolution unset', async () => {
    const repo = AppOntologyDataSource.getRepository(OntologyEdge);
    const saved = await repo.save(repo.create(makeEdgeRow({ resolution: null })));
    assert.equal(saved.resolution, null);
  });

  it('rejects an out-of-vocabulary value at the DB layer even via raw SQL (bypassing the TypeScript type entirely)', async () => {
    // A raw INSERT is exactly what a typo, a bug in a future service, or any
    // non-TypeScript caller (another process, a manual fixup query) could
    // produce — precisely what a TypeScript union alone can never catch,
    // and what the reviewer asked to be enforced at the storage layer.
    await assert.rejects(
      () =>
        AppOntologyDataSource.query(
          `INSERT INTO ontology_edges ` +
            `(id, workspace_id, graph_id, src_id, dst_id, type, layer, confidence, resolution) ` +
            `VALUES ('11111111-1111-1111-1111-111111111111', 'ws', 'g', 'a', 'b', 'CALLS', 'structural', 1.0, 'bogus_value')`,
        ),
      /CHECK constraint failed/,
      'an out-of-vocabulary resolution value must be rejected by the DB-level CHECK constraint',
    );
  });

  it('rejects an out-of-vocabulary value via the ORM save path too', async () => {
    const repo = AppOntologyDataSource.getRepository(OntologyEdge);
    await assert.rejects(
      () => repo.save(repo.create(makeEdgeRow({ resolution: 'not_a_real_value' }))),
      /CHECK constraint failed/,
      'repo.save() with an invalid resolution must surface the CHECK constraint failure, not silently persist it',
    );
  });
});
