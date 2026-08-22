// 회귀 테스트 — ticket 6ca4894a (리뷰 지적, Review round 1)
//
// OntologyEdge.resolution은 TypeScript union(OntologyEdgeResolution)만
// 있고 실제 컬럼은 DB 레벨 제약 없는 순수 `varchar`였다 — TypeScript
// 타입은 런타임에 지워지고 어느 DB도 검사하지 않으므로 Postgres와 sql.js
// 둘 다 임의 문자열을 조용히 저장할 수 있었다. DESIGN.md 축 2는
// `resolution`을 (워크스페이스 확장 가능하도록 의도적으로 열어둔
// type/kind/layer와 달리) 진짜 CLOSED 어휘로 못박는다 — 티켓 원문도
// 그대로 `resolution ENUM('exact','name_match','dynamic','unresolved')`로
// 쓰고 있다.
//
// TypeORM의 `simple-enum` 컬럼 타입을 수정안으로 검토했으나 기각했다:
// typeorm@0.3.31 소스(AbstractSqliteDriver.js의 normalizeType():
// `simple-enum` → 그냥 "varchar", check 제약 없음; DateUtils.
// simpleEnumToString()은 단순 문자열화만 하는 no-op)를 직접 확인 — sql.js/
// SQLite 백엔드에서는 강제력이 전혀 없고, Postgres(simple-enum이 실제
// 네이티브 enum 타입으로 매핑되는 곳)만 실제로 보호된다. `@Check()` 제약은
// 두 dialect 모두 네이티브로 지원하는 이식성 있는 SQL이고, 실증적으로도
// 확인했다(실제 sql.js DataSource에 대한 일회성 프로브로 실제
// `CONSTRAINT ... CHECK` 절이 생성되고 잘못된 값이 `CHECK constraint
// failed`로 거부됨을 확인).
//
// 이 스위트는 실제로 배포되는 OntologyEdge 엔티티가 TypeScript 타입뿐
// 아니라 저장 계층에서도 닫힌 어휘를 강제함을 증명한다.
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요). 격리된
// SQLJS_ONTOLOGY_DB_PATH 임시 파일을 써서 공유 dev database/ontology.db는
// 절대 건드리지 않는다.

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
    // raw INSERT는 오타, 미래 서비스의 버그, 또는 TypeScript를 거치지 않는
    // 호출자(다른 프로세스, 수동 fixup 쿼리)가 정확히 만들어낼 수 있는
    // 형태다 — TypeScript union 혼자서는 절대 못 잡고, 리뷰어가 저장 계층에서
    // 강제해 달라고 요청한 바로 그 지점이다.
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
