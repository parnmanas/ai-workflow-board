// 회귀 테스트 — ticket e14ef1c9
// "[Ontology Graph 2/7] 추출 워커 — tree-sitter WASM Tier 1 + NestJS
// 리플렉션 룰셋" — 리뷰 라운드 1 지적 사항 #1/#3에 대한 직접 회귀.
//
// ontology-extraction-decorator-dogfood.test.mjs는 AWB 자신의 실제 소스로
// guard family(AuthGuard/AdminGuard)만 끝까지 검증한다. 이 스위트는 AWB
// 자신의 코드베이스에 실제 사용례가 없는 나머지 3 family(interceptor/
// pipe/cron/event_pattern — `grep -rl "@UseInterceptors\|@UsePipes\|@Cron(
// \|@EventPattern(" apps/server/src`로 직접 확인, 결과 없음)를 합성
// fixture로 persist 레벨까지 검증한다 — "dogfood"라고 주장하지 않는다
// (합성 데이터이므로).
//
// 지적 #1: @Cron()/@EventPattern()이 DECORATES 엣지를 전혀 만들지
// 않았다(인자가 식별자가 아니라 문자열 리터럴이라 기존 "이름으로 클래스
// 찾기" 경로가 적용되지 않아 항상 unresolved로 빠짐) — persist.ts가 이제
// axis 2의 기존 Endpoint 타입으로 이 두 family의 데코레이터 occurrence
// 전용 노드를 만들어 실제 엣지를 남긴다.
//
// 지적 #3: refs[]/imports[]/exports[]/heritage[]가 repo extraction 경로
// 어디에도 저장되지 않아 3/7 리졸버가 소비할 방법이 없었다 — File
// 노드의 props JSON에 담아 durable하게 남기는 것을 라운드트립으로 확인.
//
// 두 관심사를 별도 describe/before/after로 나누지 않는다 — db.ts의
// AppOntologyDataSource는 모듈 레벨 싱글턴이라, 별도 describe가 각자
// destroy()/tmpDir 삭제를 하면 두 번째 describe가 이미 죽은 DataSource를
// 다시 initOntologyDb()하려다 깨진다(node:test는 파일 안 describe를
// 선언 순서대로 순차 실행 — 첫 블록의 after()가 두 번째 블록의 before()보다
// 먼저 끝난다). 하나의 top-level before/after로 묶고, 두 관심사는
// describe/it으로만 나눈다.
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요) — 1/7과 같은 관례.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-persist-coverage-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { extractFile } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/extract-file.js'));
const { extractDecoratorFacts } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/decorator-rules.js'));
const { persistFactBundles } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/persist.js'));
const { AppOntologyDataSource, initOntologyDb, flushOntologySqljs } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyNode.js'));
const { OntologyEdge } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyEdge.js'));

const DECORATOR_COVERAGE_PATH = 'synthetic/decorators.ts';
const DECORATOR_COVERAGE_SRC = `
export class LoggingInterceptor {}
export class ValidationPipe {}

export class SyntheticService {
  @UseInterceptors(LoggingInterceptor)
  method1() {}

  @UsePipes(ValidationPipe)
  method2(x) {}

  @Cron('0 0 * * *')
  scheduledJob() {}

  @EventPattern('user.created')
  handleUserCreated(data) {}
}
`;

const RAW_FACTS_PATH = 'synthetic/raw-facts.ts';
const RAW_FACTS_SRC = `
import { Foo } from './foo';
export { Bar } from './bar';

export class Impl extends Base implements IThing {
  method() {
    Foo.doSomething();
  }
}
`;

let nodeRepo, edgeRepo, decoratorSummary, rawFactsBundle;

before(async () => {
  await initOntologyDb();
  nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
  edgeRepo = AppOntologyDataSource.getRepository(OntologyEdge);

  const decoratorBundle = await extractFile(DECORATOR_COVERAGE_PATH, DECORATOR_COVERAGE_SRC, 'typescript');
  decoratorBundle.fileHash = 'decorator-coverage-hash';
  assert.equal(decoratorBundle.hasParseError, false, '합성 fixture가 파싱 에러 없이 파싱돼야 한다');
  const decoratorFacts = extractDecoratorFacts(DECORATOR_COVERAGE_PATH, DECORATOR_COVERAGE_SRC, 'typescript');

  rawFactsBundle = await extractFile(RAW_FACTS_PATH, RAW_FACTS_SRC, 'typescript');
  rawFactsBundle.fileHash = 'raw-facts-hash';
  assert.ok(
    rawFactsBundle.refs.length > 0 && rawFactsBundle.imports.length > 0 && rawFactsBundle.exports.length > 0 && rawFactsBundle.heritage.length > 0,
    '이 fixture 자체가 refs/imports/exports/heritage를 전부 갖고 있어야 라운드트립을 의미있게 검증한다',
  );

  decoratorSummary = await persistFactBundles(AppOntologyDataSource, {
    graphId: 'persist-coverage-graph',
    workspaceId: 'persist-coverage-ws',
    resourceId: 'persist-coverage-resource',
    folderPath: '',
    commit: 'persist-coverage-commit',
    extractionRunId: 'persist-coverage-run-1',
    bundles: [decoratorBundle, rawFactsBundle],
    decoratorFactsByPath: new Map([[DECORATOR_COVERAGE_PATH, decoratorFacts]]),
  });
});

after(async () => {
  if (AppOntologyDataSource?.isInitialized) {
    await flushOntologySqljs(AppOntologyDataSource, true);
    await AppOntologyDataSource.destroy();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DECORATES persist coverage — interceptor/pipe/cron/event_pattern (ticket e14ef1c9, 리뷰 지적 #1)', () => {
  it('interceptor family: creates a DECORATES edge from the decorated method to the real LoggingInterceptor class node', async () => {
    const src = await nodeRepo.findOne({ where: { qualified_name: 'SyntheticService.method1' } });
    const dst = await nodeRepo.findOne({ where: { qualified_name: 'LoggingInterceptor', type: 'Type' } });
    assert.ok(src, 'method1 노드가 있어야 한다');
    assert.ok(dst, 'LoggingInterceptor 노드가 있어야 한다');
    const edge = await edgeRepo.findOne({ where: { type: 'DECORATES', src_id: src.id, dst_id: dst.id } });
    assert.ok(edge, 'method1 --DECORATES--> LoggingInterceptor 엣지가 있어야 한다');
    assert.equal(edge.confidence, 0.6);
    assert.equal(edge.resolution, 'dynamic');
    assert.deepEqual(JSON.parse(edge.props), { family: 'interceptor' });
  });

  it('pipe family: creates a DECORATES edge from the decorated method to the real ValidationPipe class node', async () => {
    const src = await nodeRepo.findOne({ where: { qualified_name: 'SyntheticService.method2' } });
    const dst = await nodeRepo.findOne({ where: { qualified_name: 'ValidationPipe', type: 'Type' } });
    assert.ok(src);
    assert.ok(dst);
    const edge = await edgeRepo.findOne({ where: { type: 'DECORATES', src_id: src.id, dst_id: dst.id } });
    assert.ok(edge, 'method2 --DECORATES--> ValidationPipe 엣지가 있어야 한다');
    assert.deepEqual(JSON.parse(edge.props), { family: 'pipe' });
  });

  it('cron family: creates an Endpoint node named after the cron expression, with a DECORATES edge from the decorated method', async () => {
    const src = await nodeRepo.findOne({ where: { qualified_name: 'SyntheticService.scheduledJob' } });
    assert.ok(src, 'scheduledJob 노드가 있어야 한다');
    const endpoint = await nodeRepo.findOne({ where: { type: 'Endpoint', kind: 'cron', name: '0 0 * * *' } });
    assert.ok(endpoint, "cron 표현식을 이름으로 갖는 Endpoint 노드가 있어야 한다 (완료조건: @Cron()도 그래프에서 쿼리 가능해야 함)");
    const edge = await edgeRepo.findOne({ where: { type: 'DECORATES', src_id: src.id, dst_id: endpoint.id } });
    assert.ok(edge, 'scheduledJob --DECORATES--> cron Endpoint 엣지가 있어야 한다');
    assert.equal(edge.confidence, 0.6);
    assert.equal(edge.resolution, 'dynamic');
  });

  it('event_pattern family: creates an Endpoint node named after the event pattern, with a DECORATES edge from the decorated method', async () => {
    const src = await nodeRepo.findOne({ where: { qualified_name: 'SyntheticService.handleUserCreated' } });
    assert.ok(src, 'handleUserCreated 노드가 있어야 한다');
    const endpoint = await nodeRepo.findOne({ where: { type: 'Endpoint', kind: 'event_pattern', name: 'user.created' } });
    assert.ok(endpoint, "이벤트 패턴명을 이름으로 갖는 Endpoint 노드가 있어야 한다");
    const edge = await edgeRepo.findOne({ where: { type: 'DECORATES', src_id: src.id, dst_id: endpoint.id } });
    assert.ok(edge, 'handleUserCreated --DECORATES--> event_pattern Endpoint 엣지가 있어야 한다');
  });

  it('summary counts all 4 families as resolved DECORATES edges, none left unresolved', () => {
    assert.equal(decoratorSummary.decoratesEdges, 4, `interceptor+pipe+cron+event_pattern = 4개 엣지를 기대했다 (got ${decoratorSummary.decoratesEdges})`);
    assert.equal(decoratorSummary.decoratesUnresolved, 0);
  });

  it('has zero dangling edges across the whole synthetic graph', async () => {
    const allNodeIds = new Set((await nodeRepo.find({ select: ['id'] })).map((n) => n.id));
    const allEdges = await edgeRepo.find();
    const dangling = allEdges.filter((e) => !allNodeIds.has(e.src_id) || !allNodeIds.has(e.dst_id));
    assert.deepEqual(dangling, []);
  });
});

describe('canonical natural key 중복 제거', () => {
  it('같은 파일 bundle과 decorator fact가 중복돼도 노드·엣지를 한 번만 만들고 재실행 ID가 안정적이다', async () => {
    const graphId = 'persist-dedupe-graph';
    const bundle = await extractFile(DECORATOR_COVERAGE_PATH, DECORATOR_COVERAGE_SRC, 'typescript');
    bundle.fileHash = 'dedupe-hash';
    const facts = extractDecoratorFacts(DECORATOR_COVERAGE_PATH, DECORATOR_COVERAGE_SRC, 'typescript');
    const input = {
      graphId,
      workspaceId: 'persist-coverage-ws',
      resourceId: 'persist-coverage-resource',
      folderPath: '',
      commit: 'persist-coverage-commit',
      extractionRunId: 'persist-dedupe-run',
      bundles: [bundle, bundle],
      decoratorFactsByPath: new Map([[DECORATOR_COVERAGE_PATH, [...facts, ...facts]]]),
    };

    const summary = await persistFactBundles(AppOntologyDataSource, input);
    const firstNodes = await nodeRepo.find({ where: { graph_id: graphId }, order: { symbol_id: 'ASC' } });
    const firstEdges = await edgeRepo.find({ where: { graph_id: graphId }, order: { id: 'ASC' } });
    assert.equal(summary.nodesInserted, firstNodes.length);
    assert.equal(summary.edgesInserted, firstEdges.length);
    assert.equal(new Set(firstNodes.map((row) => row.symbol_id)).size, firstNodes.length, '노드 natural key가 유일해야 한다');

    const nodeIds = firstNodes.map((row) => row.id);
    const edgeIds = firstEdges.map((row) => row.id);
    await persistFactBundles(AppOntologyDataSource, { ...input, extractionRunId: 'persist-dedupe-run-2' });

    const secondNodes = await nodeRepo.find({ where: { graph_id: graphId }, order: { symbol_id: 'ASC' } });
    const secondEdges = await edgeRepo.find({ where: { graph_id: graphId }, order: { id: 'ASC' } });
    assert.equal(secondNodes.length, firstNodes.length, '재시도는 노드 수를 늘리지 않아야 한다');
    assert.equal(secondEdges.length, firstEdges.length, '재시도는 엣지 수를 늘리지 않아야 한다');
    assert.deepEqual(secondNodes.map((row) => row.id), nodeIds, '같은 노드 natural key는 재실행에서도 같은 ID여야 한다');
    assert.deepEqual(secondEdges.map((row) => row.id), edgeIds, '같은 엣지 natural key는 재실행에서도 같은 ID여야 한다');
  });
});

describe('raw unresolved facts survive extraction -> persist (ticket e14ef1c9, 리뷰 지적 #3)', () => {
  it('the File node props carries the exact refs/imports/exports/heritage the extractor produced — a 3/7 resolver can read them back without re-parsing', async () => {
    const fileNode = await nodeRepo.findOne({ where: { type: 'File', path: RAW_FACTS_PATH, graph_id: 'persist-coverage-graph' } });
    assert.ok(fileNode, 'File 노드가 있어야 한다');
    const props = JSON.parse(fileNode.props);
    assert.deepEqual(props.refs, rawFactsBundle.refs);
    assert.deepEqual(props.imports, rawFactsBundle.imports);
    assert.deepEqual(props.exports, rawFactsBundle.exports);
    assert.deepEqual(props.heritage, rawFactsBundle.heritage);
    assert.equal(props.has_parse_error, false);
  });
});

// TypeORM/sql.js는 이벤트 루프를 붙잡아두는 핸들을 남긴다 — `--test-force-exit`로
// 실행해야 한다(package.json test 스크립트가 보장).
