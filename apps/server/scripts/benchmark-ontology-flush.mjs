#!/usr/bin/env node
// Ontology Graph sql.js flush 벤치마크(ticket 6ca4894a, DESIGN.md 축 3 /
// REVIEW-NOTES.md S1+S3 — "MITIGATED, ADOPTED 아님"인 이유가 정확히
// 리뷰어 자신의 픽스가 이 설계 자체의 투영 row 수에서 실제 고정 sql.js
// 빌드로 실제 `db.export()` wall-clock 시간을 측정할 것을 요구했기
// 때문이다 — 설계 문서가 아니라 실제로 돌아가는 시스템만 낼 수 있는 값).
// db.ts의 `ONTOLOGY_SQLJS_ROW_CEILING` 기본값은 이 스크립트의 출력'으로부터'
// 정해지는 것이지 그 반대가 아니다.
//
// 격리된, 실행 후 버리는 온톨로지 전용 sql.js DataSource(AppOntologyDataSource,
// SQLJS_ONTOLOGY_DB_PATH 경유 — 공유 dev database/ontology.db는 절대 아님)를
// DESIGN.md 자체의 상한 10 MLOC 투영(`research-storage.md` §6.3: 집계 노드
// ~10만-15만, 엣지 ~24만-80만)으로 채우고 실제 `saveDatabase()`(드라이버의
// `db.export()` + fs write) 호출 시간을 잰다 — 실제 데이터가 존재하는
// 상태에서 독립 온톨로지 flush timer가 매 tick마다 실행하는 바로 그 연산.
//
// 대량 insert는 리터럴(파라미터 바인딩 아닌) 다중행 INSERT 문을 배치로,
// 단 하나의 dataSource.manager.transaction() 호출 안에서 쓴다 — 이 같은
// 티켓 범위가 온톨로지 대량 쓰기에 요구하는 "transaction() 호출 횟수
// 최소화"(REVIEW-NOTES.md S3). 값을 바인딩 파라미터가 아니라 인라인으로
// 넣는 이유는 순전히 sql.js/SQLite의 다중행 VALUES 목록에 대한 바운드
// 변수 개수 상한을 피하기 위해서다 — 여기 있는 모든 리터럴은 이 스크립트
// 자신이 생성한 것(자기가 만든 uuid/정수)이지 외부 입력이 아니므로 injection
// 표면이 없다.
//
// 사용법:
//   (cd apps/server && npm run build)
//   node apps/server/scripts/benchmark-ontology-flush.mjs [--nodes 150000] [--edges 800000] [--chunk 2000]

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

function parseArgs(argv) {
  const out = { nodes: 150_000, edges: 800_000, chunk: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = Number(argv[++i]);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

// db.js를 import하기 전에 격리된 임시 파일을 설정한다 — resolveSqljsLocation()과
// resolveOntologySqljsLocation() 둘 다 DataSource 생성 시점(모듈 로드)에 이
// env 변수들을 읽는다. 공유 dev database/*.db는 절대 건드리지 않는다.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-bench-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary-unused.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology-bench.db');
process.env.NODE_ENV = 'production'; // TypeORM `logging`을 꺼둔 상태로 유지

const { AppOntologyDataSource, flushOntologySqljs } = await import('file://' + path.join(DIST, 'db.js'));

if (!AppOntologyDataSource) {
  console.error('AppOntologyDataSource is null — this benchmark only runs against the sql.js (dev) backend.');
  process.exit(1);
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function insertChunkSql(table, columns, rows) {
  const values = rows
    .map((row) => `(${columns.map((c) => sqlLiteral(row[c])).join(',')})`)
    .join(',');
  return `INSERT INTO ${table} (${columns.join(',')}) VALUES ${values}`;
}

async function bulkInsert(dataSource, table, columns, totalRows, chunkSize, makeRow, label) {
  const startedAt = Date.now();
  await dataSource.manager.transaction(async (manager) => {
    for (let offset = 0; offset < totalRows; offset += chunkSize) {
      const n = Math.min(chunkSize, totalRows - offset);
      const rows = Array.from({ length: n }, (_, i) => makeRow(offset + i));
      await manager.query(insertChunkSql(table, columns, rows));
      if ((offset / chunkSize) % 20 === 0) {
        process.stdout.write(`\r  ${label}: ${Math.min(offset + n, totalRows)}/${totalRows}`);
      }
    }
  });
  process.stdout.write(`\r  ${label}: ${totalRows}/${totalRows} done (${((Date.now() - startedAt) / 1000).toFixed(1)}s)\n`);
}

async function main() {
  console.log(`Ontology sql.js flush benchmark — ${args.nodes} nodes, ${args.edges} edges, chunk=${args.chunk}`);
  console.log(`Temp DB: ${process.env.SQLJS_ONTOLOGY_DB_PATH}`);

  await AppOntologyDataSource.initialize();

  const graphId = 'bench-graph-1';
  const nodeIds = Array.from({ length: args.nodes }, () => randomUUID());

  const nodeColumns = [
    'id', 'workspace_id', 'resource_id', 'folder_path', 'graph_id', 'symbol_id', 'type', 'kind',
    'layer', 'name', 'qualified_name', 'path', 'start_line', 'end_line', 'content_hash', 'lang',
    'status', 'confidence', 'confidence_method', 'first_seen_commit', 'last_seen_commit',
    'valid_from_commit', 'valid_to_commit', 'extraction_run_id', 'profile_version', 'props',
    'embedding_id', 'degree', 'pagerank', 'created_at', 'updated_at',
  ];
  const now = new Date().toISOString();
  const makeNodeRow = (i) => ({
    id: nodeIds[i],
    workspace_id: 'bench-workspace',
    resource_id: 'bench-resource',
    folder_path: '',
    graph_id: graphId,
    symbol_id: `sym-${i}`,
    type: 'Callable',
    kind: 'function',
    layer: 'structural',
    name: `fn_${i}`,
    qualified_name: `bench.fn_${i}`,
    path: `src/bench/file_${i % 5000}.ts`,
    start_line: 1,
    end_line: 10,
    content_hash: `hash-${i}`,
    lang: 'typescript',
    status: 'active',
    confidence: 1.0,
    confidence_method: 'constant',
    first_seen_commit: 'abc123',
    last_seen_commit: 'abc123',
    valid_from_commit: 'abc123',
    valid_to_commit: null,
    extraction_run_id: 'bench-run-1',
    profile_version: 'core@1.0.0',
    props: '{}',
    embedding_id: null,
    degree: 0,
    pagerank: 0,
    created_at: now,
    updated_at: now,
  });

  const edgeColumns = [
    'id', 'workspace_id', 'graph_id', 'src_id', 'dst_id', 'type', 'layer', 'confidence',
    'confidence_method', 'support', 'resolution', 'call_count', 'evidence_kind', 'evidence_ref',
    'rank', 'completeness', 'extraction_run_id', 'model_id', 'prompt_version',
    'first_seen_commit', 'last_seen_commit', 'valid_from_commit', 'valid_to_commit', 'status',
    'props', 'created_at', 'updated_at',
  ];
  const makeEdgeRow = (i) => ({
    id: randomUUID(),
    workspace_id: 'bench-workspace',
    graph_id: graphId,
    src_id: nodeIds[i % nodeIds.length],
    dst_id: nodeIds[(i * 7 + 1) % nodeIds.length],
    type: 'CALLS',
    layer: 'structural',
    confidence: 1.0,
    confidence_method: 'constant',
    support: null,
    resolution: 'exact',
    call_count: 1,
    evidence_kind: 'parser',
    evidence_ref: '[]',
    rank: 'normal',
    completeness: 'complete',
    extraction_run_id: 'bench-run-1',
    model_id: null,
    prompt_version: null,
    first_seen_commit: 'abc123',
    last_seen_commit: 'abc123',
    valid_from_commit: 'abc123',
    valid_to_commit: null,
    status: 'active',
    props: '{}',
    created_at: now,
    updated_at: now,
  });

  console.log('\nPopulating (single transaction() call for the whole run, batched literal INSERTs):');
  await bulkInsert(AppOntologyDataSource, 'ontology_nodes', nodeColumns, args.nodes, args.chunk, makeNodeRow, 'nodes');
  await bulkInsert(AppOntologyDataSource, 'ontology_edges', edgeColumns, args.edges, args.chunk, makeEdgeRow, 'edges');

  console.log('\nFlushing (this is the number that matters — db.export() + fs.writeFileSync wall-clock):');
  const flushStart = Date.now();
  const saved = await flushOntologySqljs(AppOntologyDataSource, true);
  const flushMs = Date.now() - flushStart;

  const fileSize = fs.statSync(process.env.SQLJS_ONTOLOGY_DB_PATH).size;

  console.log(`\n=== RESULT ===`);
  console.log(`nodes=${args.nodes} edges=${args.edges}`);
  console.log(`flush saved=${saved} wall_clock_ms=${flushMs} (${(flushMs / 1000).toFixed(2)}s)`);
  console.log(`on-disk file size: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);

  // 곧바로 이어지는 두 번째 flush(dirty한 것 없음) — 거의 0이어야 하고,
  // 이 규모에서도 dirty-flag 게이트가 여전히 동작함을 확인한다.
  const idleStart = Date.now();
  const idleSaved = await flushOntologySqljs(AppOntologyDataSource);
  console.log(`idle re-flush: saved=${idleSaved} wall_clock_ms=${Date.now() - idleStart} (expect false / ~0ms)`);

  await AppOntologyDataSource.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
