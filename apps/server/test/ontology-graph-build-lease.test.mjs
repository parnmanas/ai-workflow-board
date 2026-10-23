// 회귀 테스트 — ticket 461d210a "온톨로지 그래프가 building 에 영구히 갇힌다(Postgres · 멈춘 워커)".
//
// OntologyGraph.status='building' 은 빌드 중 표시이자 동시 빌드 방지 잠금이다. claim 은 빌드
// 트랜잭션 전에 커밋되므로, 빌드를 돌리던 서버가 사라지면(재기동 · 크래시) building 만 남는다.
// sql.js 는 부팅 때 일괄로 풀지만(failInterruptedBuilds), 여러 서버가 한 DB 를 쓸 수 있는
// Postgres 는 부팅만으로 "끊긴 빌드" 와 "다른 서버가 돌리는 빌드" 를 가려낼 수 없다. 그래서
// 빌드는 claim 마다 새 build_id 와 lease 를 받고, 도는 동안 heartbeat 로 lease 를 미룬다.
//   - lease 가 지난 building 은 읽기(resolveOrProvision)가 error 로 풀고, Refresh 가 다시 claim 한다.
//   - lease 가 살아 있으면(다른 서버가 실제로 빌드 중) 건드리지 않는다.
//   - 주인 자리를 잃은 빌드는 끝내는 쓰기를 하지 않는다 — 새 빌드의 결과 · 상태를 덮지 않는다.
//
// 실제 앱을 부팅해(bootApp) 그 온톨로지 DataSource 로 돈다. CI 의 Postgres 매트릭스
// (test-qa-pg)에서도 같은 파일이 돈다 — 같은 파일의 테스트는 한 스키마를 쓰므로 그래프마다
// resource_id 를 따로 쓰고, 테이블 전체 수는 단언하지 않는다. 컴파일된 dist/ 대상.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootApp, closeTestApp, exitAfterTests } from './helpers/boot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');
const IS_POSTGRES = process.env.DB_TYPE === 'postgres';

const ACCOUNT_ID = 'build-lease-account';
const MINUTE = 60_000;

let app;
let ds;
let graphRepo;
let nodeRepo;
let OntologyLifecycleService;

before(async () => {
  const booted = await bootApp({ port: 0 });
  app = booted.app;
  const { AppOntologyDataSource } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
  ({ OntologyLifecycleService } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/ontology-lifecycle.service.js')));
  const { OntologyGraph } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyGraph.js'));
  const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyNode.js'));
  // sql.js 는 온톨로지 테이블이 독립 DataSource 에, Postgres 는 앱의 단일 DataSource 에 있다.
  ds = AppOntologyDataSource ?? app.get(booted.modules.getDataSourceToken());
  graphRepo = ds.getRepository(OntologyGraph);
  nodeRepo = ds.getRepository(OntologyNode);
});

after(async () => {
  await closeTestApp(app);
  exitAfterTests();
});

function lifecycle({ extraction = {}, resolver = {}, logs = [] } = {}) {
  const logger = {
    info() {},
    warn: (category, message, meta) => { logs.push({ level: 'warn', message, meta }); },
    error: (category, message, meta) => { logs.push({ level: 'error', message, meta }); },
  };
  return new OntologyLifecycleService(ds, extraction, resolver, logger);
}

function seedGraph(resourceId, fields = {}) {
  return graphRepo.save(graphRepo.create({ account_id: ACCOUNT_ID, resource_id: resourceId, folder_path: '', ...fields }));
}

function seedSnapshotNode(graph) {
  return nodeRepo.insert({
    id: randomUUID(), account_id: ACCOUNT_ID, graph_id: graph.id, symbol_id: 'sym:snapshot',
    type: 'Callable', layer: 'structural', name: 'snapshot', confidence: 1, status: 'active',
  });
}

async function snapshotSymbols(graph) {
  return (await nodeRepo.find({ where: { graph_id: graph.id } })).map((row) => row.symbol_id).sort();
}

function readGraph(graph) {
  return graphRepo.findOne({ where: { id: graph.id } });
}

// 다른 서버가 돌리다 사라진 빌드 — 마지막 연장이 오래전이다.
function abandonedBuild() {
  return { status: 'building', build_id: `gone-${randomUUID()}`, build_lease_until: new Date(Date.now() - MINUTE) };
}

// 다른 서버가 실제로 돌리는 빌드 — heartbeat 가 lease 를 앞에 두고 있다.
function liveBuild() {
  return { status: 'building', build_id: `live-${randomUUID()}`, build_lease_until: new Date(Date.now() + 10 * MINUTE) };
}

function extractionOf(graph, commit) {
  return {
    accountId: graph.account_id, resourceId: graph.resource_id, folderPath: graph.folder_path, commit,
    bundles: [], decoratorFactsByPath: new Map(),
    filesDiscovered: 1, filesSkippedByExtension: 0, filesSkippedTooLargeOrBinary: 0, filesFailedExtraction: 0,
    extractionFailures: [], treeWalkMs: 1, fetchMs: 1, extractMs: 1, totalLines: 1, endToEndLinesPerSecond: 1,
  };
}

function persistSummaryOf(nodesInserted) {
  return {
    filesProcessed: nodesInserted, nodesInserted, edgesInserted: 0, containsEdges: 0, declaresEdges: 0,
    decoratesEdges: 0, decoratesUnresolved: 0, parseErrorFiles: 0, skippedFiles: 0, durationMs: 1,
  };
}

const noEdges = { resolveGraph: async () => ({ edgesInserted: 0 }) };

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

// 빌드가 그 단계에 닿기 전에 끝나면(실패 포함) 신호를 영영 못 받는다 — 매달리지 않고 실패한다.
async function reached(signal, build, step) {
  await Promise.race([signal, build.then(() => { throw new Error(`빌드가 ${step} 단계에 닿기 전에 끝났다`); })]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('읽기 — lease 가 지난 building 을 error 로 푼다', () => {
  it('직전 스냅샷 · commit 은 남고 끊긴 빌드라고 알린다 — 그 뒤 Refresh 가 새 빌드를 띄운다', async () => {
    const graph = await seedGraph('lease-abandoned', { ...abandonedBuild(), commit: 'snapshot-commit', indexed_at: new Date() });
    await seedSnapshotNode(graph);
    const logs = [];
    const svc = lifecycle({ logs });
    const kicked = [];
    svc.kickOffInitialBuild = (claimed) => { kicked.push(claimed); };

    const released = await svc.resolveOrProvision({ accountId: ACCOUNT_ID, graphId: graph.id });
    assert.equal(released.status, 'error');
    assert.match(released.error, /abandoned/);
    assert.equal(released.commit, 'snapshot-commit');
    const stored = await readGraph(graph);
    assert.equal(stored.status, 'error');
    assert.equal(stored.build_id, '');
    assert.equal(stored.build_lease_until, null);
    assert.deepEqual(await snapshotSymbols(graph), ['sym:snapshot'], '마지막 ready 스냅샷은 그대로 읽힌다');
    assert.ok(logs.some((entry) => entry.level === 'warn' && /abandoned graph build released/.test(entry.message)));

    const refreshed = await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID });
    assert.equal(refreshed.started, true, '풀린 그래프는 Refresh 가 다시 빌드를 띄운다');
    assert.deepEqual(kicked.map((claimed) => claimed.id), [graph.id]);
  });

  it('(resource_id, folder_path) 로 들어온 읽기(graph_status · 그래프 툴)도 같은 그래프를 풀고 새 행을 만들지 않는다', async () => {
    const graph = await seedGraph('lease-abandoned-by-resource', abandonedBuild());
    const svc = lifecycle();
    svc.kickOffInitialBuild = () => { throw new Error('이미 있는 그래프는 최초 빌드를 띄우지 않는다'); };

    const released = await svc.resolveOrProvision({ accountId: ACCOUNT_ID, resourceId: 'lease-abandoned-by-resource', folderPath: '' });
    assert.equal(released.id, graph.id);
    assert.equal(released.status, 'error');
    assert.equal(await graphRepo.count({ where: { account_id: ACCOUNT_ID, resource_id: 'lease-abandoned-by-resource' } }), 1);
  });

  it('lease 컬럼이 생기기 전에 남은 building(build_id · lease 없음)도 끊긴 빌드로 푼다', async () => {
    const graph = await seedGraph('lease-legacy-building', { status: 'building' });
    const released = await lifecycle().resolveOrProvision({ accountId: ACCOUNT_ID, graphId: graph.id });
    assert.equal(released.status, 'error');
    assert.match(released.error, /abandoned/);
  });

  it('lease 가 살아 있는 building 은 그대로다 — 읽기는 building, Refresh 는 두 번째 빌드를 띄우지 않는다', async () => {
    const live = liveBuild();
    const graph = await seedGraph('lease-live', live);
    const svc = lifecycle();
    const kicked = [];
    svc.kickOffInitialBuild = (claimed) => { kicked.push(claimed.id); };

    const read = await svc.resolveOrProvision({ accountId: ACCOUNT_ID, graphId: graph.id });
    assert.equal(read.status, 'building');
    assert.equal(read.build_id, live.build_id);
    const refreshed = await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID });
    assert.equal(refreshed.started, false);
    assert.deepEqual(kicked, []);
    assert.equal((await readGraph(graph)).build_id, live.build_id, '살아 있는 빌드의 주인 자리를 빼앗지 않는다');
  });
});

describe('Refresh — lease 가 지난 building 을 바로 다시 claim 한다', () => {
  it('읽기를 거치지 않은 Refresh(REST /refresh)도 새 build_id 와 lease 로 빌드를 띄운다', async () => {
    const abandoned = abandonedBuild();
    const graph = await seedGraph('lease-reclaim', abandoned);
    const svc = lifecycle();
    const kicked = [];
    svc.kickOffInitialBuild = (claimed) => { kicked.push(claimed); };

    const before = Date.now();
    const refreshed = await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID });
    assert.equal(refreshed.started, true);
    const stored = await readGraph(graph);
    assert.equal(stored.status, 'building');
    assert.ok(stored.build_id && stored.build_id !== abandoned.build_id, '새 claim 은 새 build_id 를 쓴다');
    assert.ok(new Date(stored.build_lease_until).getTime() > before, '새 claim 은 앞으로의 lease 를 쓴다');
    assert.equal(kicked.length, 1);
    assert.equal(kicked[0].build_id, stored.build_id, '띄운 빌드가 그 build_id 의 주인이다');
  });
});

describe('heartbeat — 빌드가 도는 동안 lease 를 미룬다', () => {
  it('lease 보다 오래 걸리는 빌드도 읽기가 풀지 않고, 끝나면 build_id · lease 를 비운다', { timeout: 30_000 }, async () => {
    const graph = await seedGraph('lease-heartbeat', { status: 'ready', commit: 'old-commit' });
    const extracting = gate();
    const extracted = gate();
    const svc = lifecycle({
      extraction: {
        extractRepo: async () => {
          extracting.open();
          await extracted.opened; // 오래 걸리는 git fetch · 워커 파싱
          return extractionOf(graph, 'heartbeat-commit');
        },
        persistExtraction: async () => persistSummaryOf(0),
      },
      resolver: noEdges,
    });
    svc.__setBuildLeaseForTests({ leaseMs: 1_000, heartbeatMs: 100 });
    let build = null;
    svc.kickOffInitialBuild = (claimed) => { build = svc.runInitialBuild(claimed); };

    assert.equal((await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID })).started, true);
    try {
      await reached(extracting.opened, build, '추출');
      await sleep(2_500); // lease 의 두 배 넘게 — heartbeat 가 없으면 lease 가 지난다
      const read = await svc.resolveOrProvision({ accountId: ACCOUNT_ID, graphId: graph.id });
      assert.equal(read.status, 'building', '살아 있는 빌드는 읽기가 풀지 않는다');
      assert.ok(new Date(read.build_lease_until).getTime() > Date.now(), 'heartbeat 가 lease 를 앞에 둔다');
    } finally {
      extracted.open();
      await build?.catch(() => {});
    }
    await build;
    const built = await readGraph(graph);
    assert.equal(built.status, 'ready');
    assert.equal(built.commit, 'heartbeat-commit');
    assert.equal(built.build_id, '');
    assert.equal(built.build_lease_until, null);
  });
});

describe('fencing — 주인 자리를 잃은 빌드는 끝내는 쓰기를 하지 않는다', () => {
  // 빌드 A 를 추출 단계에 세워 두고, 그 사이 A 의 서버가 사라진 것처럼 lease 를 지나게 한 뒤
  // Refresh 로 빌드 B 가 다시 claim 한다(B 자체는 띄우지 않는다).
  async function startAndSupersede(resourceId, extractRepoAfterGate) {
    const graph = await seedGraph(resourceId, { status: 'ready', commit: 'snapshot-commit' });
    await seedSnapshotNode(graph);
    const logs = [];
    const extracting = gate();
    const extracted = gate();
    let persistCalls = 0;
    const svc = lifecycle({
      logs,
      extraction: {
        extractRepo: async () => {
          extracting.open();
          await extracted.opened;
          return extractRepoAfterGate(graph);
        },
        persistExtraction: async () => { persistCalls += 1; return persistSummaryOf(0); },
      },
      resolver: noEdges,
    });
    let buildA = null;
    const laterClaims = [];
    svc.kickOffInitialBuild = (claimed) => {
      if (buildA) laterClaims.push(claimed);
      else buildA = svc.runInitialBuild(claimed);
    };

    assert.equal((await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID })).started, true);
    const buildIdA = (await readGraph(graph)).build_id;
    await reached(extracting.opened, buildA, '추출');
    await graphRepo.update({ id: graph.id }, { build_lease_until: new Date(Date.now() - 1_000) });
    const reclaimed = await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID });
    assert.equal(reclaimed.started, true, 'lease 가 지난 빌드는 Refresh 가 다시 claim 한다');
    const claimB = await readGraph(graph);
    assert.notEqual(claimB.build_id, buildIdA);
    assert.deepEqual(laterClaims.map((claimed) => claimed.build_id), [claimB.build_id]);
    return { graph, logs, buildA, claimB, release: () => extracted.open(), persistCalls: () => persistCalls };
  }

  function assertClaimBKept(stored, claimB) {
    assert.equal(stored.status, 'building', '새 claim 이 그대로 남는다');
    assert.equal(stored.build_id, claimB.build_id);
    assert.equal(new Date(stored.build_lease_until).getTime(), new Date(claimB.build_lease_until).getTime());
    assert.equal(stored.commit, 'snapshot-commit');
  }

  it('추출 중에 다시 claim 되면 옛 빌드는 교체를 시작하지 않고 끝난다 — 새 claim 과 직전 스냅샷이 그대로다', { timeout: 30_000 }, async () => {
    const run = await startAndSupersede('lease-fence-before-replace', (graph) => extractionOf(graph, 'stale-commit'));
    run.release();
    await assert.doesNotReject(run.buildA, '자리를 잃은 빌드는 실패가 아니라 조용히 끝난다');

    assertClaimBKept(await readGraph(run.graph), run.claimB);
    assert.equal(run.persistCalls(), 0, '교체 트랜잭션을 열지 않는다');
    assert.deepEqual(await snapshotSymbols(run.graph), ['sym:snapshot']);
    assert.ok(run.logs.some((entry) => entry.level === 'warn' && /lost its claim before it finished/.test(entry.message)));
  });

  it('옛 빌드가 실패해도 새 claim 을 error 로 덮지 않는다', { timeout: 30_000 }, async () => {
    const run = await startAndSupersede('lease-fence-failure', () => { throw new Error('옛 빌드의 추출 실패'); });
    run.release();
    await assert.rejects(run.buildA, /옛 빌드의 추출 실패/);

    assertClaimBKept(await readGraph(run.graph), run.claimB);
    assert.ok(run.logs.some((entry) => entry.level === 'warn' && /failed after losing its claim/.test(entry.message)));
  });

  // 서버 둘이 한 Postgres 를 쓰는 경우 — 교체 트랜잭션이 도는 동안 다른 연결이 다시 claim 한다.
  // sql.js 는 연결이 하나라 트랜잭션 도중의 다른 쓰기가 트랜잭션 뒤에 줄 서므로 이 순서가 없다.
  it('교체 트랜잭션 도중에 다시 claim 되면 끝에서 확인하고 지우고 쓴 것까지 되돌린다', {
    timeout: 30_000,
    skip: IS_POSTGRES ? false : 'sql.js 는 교체 트랜잭션 도중에 다른 연결의 쓰기가 끼어들 수 없다',
  }, async () => {
    const graph = await seedGraph('lease-fence-in-transaction', { status: 'ready', commit: 'snapshot-commit' });
    await seedSnapshotNode(graph);
    const logs = [];
    const persisting = gate();
    const persisted = gate();
    const svc = lifecycle({
      logs,
      extraction: {
        extractRepo: async () => extractionOf(graph, 'stale-commit'),
        persistExtraction: async (_extraction, graphId, manager) => {
          await manager.getRepository('OntologyNode').insert({
            id: randomUUID(), account_id: ACCOUNT_ID, graph_id: graphId, symbol_id: 'sym:stale-build',
            type: 'Callable', layer: 'structural', name: 'stale', confidence: 1, status: 'active',
          });
          persisting.open();
          await persisted.opened;
          return persistSummaryOf(1);
        },
      },
      resolver: noEdges,
    });
    let buildA = null;
    svc.kickOffInitialBuild = (claimed) => { if (!buildA) buildA = svc.runInitialBuild(claimed); };

    assert.equal((await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID })).started, true);
    let claimB;
    try {
      await reached(persisting.opened, buildA, '저장');
      await graphRepo.update({ id: graph.id }, { build_lease_until: new Date(Date.now() - 1_000) });
      assert.equal((await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID })).started, true);
      claimB = await readGraph(graph);
    } finally {
      persisted.open();
      await buildA?.catch(() => {});
    }
    await assert.doesNotReject(buildA);

    assertClaimBKept(await readGraph(graph), claimB);
    assert.deepEqual(await snapshotSymbols(graph), ['sym:snapshot'], '옛 빌드가 지우고 쓴 행은 롤백된다');
    assert.ok(logs.some((entry) => entry.level === 'warn' && /lost its claim before it finished/.test(entry.message)));
  });
});
