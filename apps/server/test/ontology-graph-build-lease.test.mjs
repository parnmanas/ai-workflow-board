// 회귀 테스트 — ticket 461d210a "온톨로지 그래프가 building 에 영구히 갇힌다(Postgres · 멈춘 워커)".
//
// OntologyGraph.status='building' 은 빌드 중 표시이자 동시 빌드 방지 잠금이다. claim 은 빌드
// 트랜잭션 전에 커밋되므로, 빌드를 돌리던 서버가 사라지면(재기동 · 크래시) building 만 남는다.
// sql.js 는 부팅 때 일괄로 풀지만(failInterruptedBuilds), 여러 서버가 한 DB 를 쓸 수 있는
// Postgres 는 부팅만으로 "끊긴 빌드" 와 "다른 서버가 돌리는 빌드" 를 가려낼 수 없다. 그래서
// 빌드는 claim 마다 새 build_id 와 lease(epoch ms)를 받는다.
//   - 다른 서버의 빌드: heartbeat 가 lease 를 미루고, lease 가 지나면 읽기가 error 로 풀고
//     Refresh 가 다시 claim 한다.
//   - 이 서버의 빌드: lease 와 상관없이 liveBuilds 가 지킨다 — 큐 · 이벤트 루프가 잠깐 멈춰
//     lease 가 지나 보여도 스스로 풀어 결과를 버리지 않는다. BUILD_MAX_MS 를 넘기면 놓는다.
//   - lease 는 쓰기가 실제로 도는 때에 잰다 — 큐 · 풀에서 기다린 연장이 지난 lease 를 쓰지 않게.
//   - 주인 자리를 잃은 빌드는 끝내는 쓰기를 하지 않는다 — 새 빌드의 결과 · 상태를 덮지 않는다.
//
// "서버" 하나는 OntologyLifecycleService 인스턴스 하나다(liveBuilds 는 서버마다 따로다). 실제
// 앱을 부팅해(bootApp) 그 온톨로지 DataSource 로 돈다 — CI 의 Postgres 매트릭스(test-qa-pg)
// 에서도 같은 파일이 돈다. 같은 파일의 테스트는 한 스키마를 쓰므로 그래프마다 resource_id 를
// 따로 쓰고, 테이블 전체 수는 단언하지 않는다. 컴파일된 dist/ 대상.

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

// 서버 하나. timing 은 __setBuildLeaseForTests 로 그대로 넘긴다.
function server({ extraction = {}, resolver = noEdges, logs = [], timing } = {}) {
  const logger = {
    info() {},
    warn: (category, message, meta) => { logs.push({ level: 'warn', message, meta }); },
    error: (category, message, meta) => { logs.push({ level: 'error', message, meta }); },
  };
  const svc = new OntologyLifecycleService(ds, extraction, resolver, logger);
  if (timing) svc.__setBuildLeaseForTests(timing);
  return svc;
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

function expireLease(graph) {
  return graphRepo.update({ id: graph.id }, { build_lease_until_ms: Date.now() - MINUTE });
}

// 다른 서버가 돌리다 사라진 빌드 — 마지막 연장이 오래전이다.
function abandonedBuild() {
  return { status: 'building', build_id: `gone-${randomUUID()}`, build_lease_until_ms: Date.now() - MINUTE };
}

// 다른 서버가 실제로 돌리는 빌드 — heartbeat 가 lease 를 앞에 두고 있다.
function liveBuild() {
  return { status: 'building', build_id: `live-${randomUUID()}`, build_lease_until_ms: Date.now() + 10 * MINUTE };
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

// promise 가 ms 안에 끝나면(성공이든 실패든) true. 타이머는 남기지 않는다.
async function settlesWithin(promise, ms) {
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true, () => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 추출 단계에서 멈춰 서는 빌드를 서버 svc 에서 띄운다. Refresh(forceRebuild 의 claim)로 시작하고,
// 그 뒤의 claim 은 띄우지 않고 적어만 둔다.
async function startGatedBuild(svc, graph) {
  const extracting = gate();
  const extracted = gate();
  let failExtraction = null;
  svc.extractionService.extractRepo = async () => {
    extracting.open();
    await extracted.opened;
    if (failExtraction) throw failExtraction;
    return extractionOf(graph, 'gated-commit');
  };
  svc.extractionService.persistExtraction ??= async () => persistSummaryOf(0);
  let build = null;
  const laterClaims = [];
  svc.kickOffInitialBuild = (claimed) => {
    if (build) laterClaims.push(claimed);
    else build = svc.runInitialBuild(claimed);
  };
  assert.equal((await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID })).started, true);
  await reached(extracting.opened, build, '추출');
  return {
    build,
    laterClaims,
    buildId: (await readGraph(graph)).build_id,
    release: () => extracted.open(),
    fail: (error) => { failExtraction = error; extracted.open(); },
  };
}

describe('읽기 — 다른 서버의 lease 가 지난 building 을 error 로 푼다', () => {
  it('직전 스냅샷 · commit 은 남고 끊긴 빌드라고 알린다 — 그 뒤 Refresh 가 새 빌드를 띄운다', async () => {
    const graph = await seedGraph('lease-abandoned', { ...abandonedBuild(), commit: 'snapshot-commit', indexed_at: new Date() });
    await seedSnapshotNode(graph);
    const logs = [];
    const svc = server({ logs });
    const kicked = [];
    svc.kickOffInitialBuild = (claimed) => { kicked.push(claimed); };

    const released = await svc.resolveOrProvision({ accountId: ACCOUNT_ID, graphId: graph.id });
    assert.equal(released.status, 'error');
    assert.match(released.error, /abandoned/);
    assert.equal(released.commit, 'snapshot-commit');
    const stored = await readGraph(graph);
    assert.equal(stored.status, 'error');
    assert.equal(stored.build_id, '');
    assert.equal(stored.build_lease_until_ms, null);
    assert.deepEqual(await snapshotSymbols(graph), ['sym:snapshot'], '마지막 ready 스냅샷은 그대로 읽힌다');
    assert.ok(logs.some((entry) => entry.level === 'warn' && /abandoned graph build released/.test(entry.message)));

    const refreshed = await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID });
    assert.equal(refreshed.started, true, '풀린 그래프는 Refresh 가 다시 빌드를 띄운다');
    assert.deepEqual(kicked.map((claimed) => claimed.id), [graph.id]);
  });

  it('(resource_id, folder_path) 로 들어온 읽기(graph_status · 그래프 툴)도 같은 그래프를 풀고 새 행을 만들지 않는다', async () => {
    const graph = await seedGraph('lease-abandoned-by-resource', abandonedBuild());
    const svc = server();
    svc.kickOffInitialBuild = () => { throw new Error('이미 있는 그래프는 최초 빌드를 띄우지 않는다'); };

    const released = await svc.resolveOrProvision({ accountId: ACCOUNT_ID, resourceId: 'lease-abandoned-by-resource', folderPath: '' });
    assert.equal(released.id, graph.id);
    assert.equal(released.status, 'error');
    assert.equal(await graphRepo.count({ where: { account_id: ACCOUNT_ID, resource_id: 'lease-abandoned-by-resource' } }), 1);
  });

  it('lease 컬럼이 생기기 전에 남은 building(build_id · lease 없음)도 끊긴 빌드로 푼다', async () => {
    const graph = await seedGraph('lease-legacy-building', { status: 'building' });
    const released = await server().resolveOrProvision({ accountId: ACCOUNT_ID, graphId: graph.id });
    assert.equal(released.status, 'error');
    assert.match(released.error, /abandoned/);
  });

  it('lease 가 살아 있는 building 은 그대로다 — 읽기는 building, Refresh 는 두 번째 빌드를 띄우지 않는다', async () => {
    const live = liveBuild();
    const graph = await seedGraph('lease-live', live);
    const svc = server();
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
  it('읽기를 거치지 않은 Refresh(REST /refresh)도 새 build_id 와 lease 로 빌드를 띄운다 — 띄운 빌드가 그 build_id 의 주인이다', async () => {
    const abandoned = abandonedBuild();
    const graph = await seedGraph('lease-reclaim', abandoned);
    const svc = server();
    const kicked = [];
    svc.kickOffInitialBuild = (claimed) => { kicked.push(claimed); };

    const before = Date.now();
    const refreshed = await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID });
    assert.equal(refreshed.started, true);
    const stored = await readGraph(graph);
    assert.equal(stored.status, 'building');
    assert.ok(stored.build_id && stored.build_id !== abandoned.build_id, '새 claim 은 새 build_id 를 쓴다');
    assert.ok(stored.build_lease_until_ms > before, '새 claim 은 앞으로의 lease 를 쓴다');
    assert.equal(kicked.length, 1);
    assert.equal(kicked[0].build_id, stored.build_id);
  });

  it('build_id 없이는 빌드를 돌리지 않는다 — 빈 토큰은 빌드가 없는 행에도 맞아 fence 가 되지 않는다', async () => {
    const graph = await seedGraph('lease-unclaimed', { status: 'ready', commit: 'kept' });
    const svc = server({ extraction: { extractRepo: async () => { throw new Error('호출되면 안 됨'); } } });
    await assert.rejects(svc.runInitialBuild(graph), /needs a claim/);
    const stored = await readGraph(graph);
    assert.equal(stored.status, 'ready');
    assert.equal(stored.commit, 'kept');
  });
});

describe('이 서버가 돌리는 빌드 — lease 가 지나 보여도 스스로 풀지 않는다', () => {
  it('읽기는 building 을 곧바로 돌려주고 Refresh 는 다시 claim 하지 않는다 — 빌드는 끝까지 간다', { timeout: 30_000 }, async () => {
    const graph = await seedGraph('lease-local-live', { status: 'ready', commit: 'old-commit' });
    const svc = server({ timing: { renewPeriodically: false } });
    const run = await startGatedBuild(svc, graph);
    try {
      await expireLease(graph); // 큐 · 이벤트 루프가 멈춰 연장이 늦은 것과 같다
      const read = svc.resolveOrProvision({ accountId: ACCOUNT_ID, graphId: graph.id });
      assert.equal(await settlesWithin(read, 2_000), true);
      assert.equal((await read).status, 'building');
      assert.equal((await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID })).started, false);
      assert.deepEqual(run.laterClaims, []);
      assert.equal((await readGraph(graph)).build_id, run.buildId);
    } finally {
      run.release();
      await run.build.catch(() => {});
    }
    await run.build;
    const built = await readGraph(graph);
    assert.equal(built.status, 'ready');
    assert.equal(built.commit, 'gated-commit');
  });

  it('BUILD_MAX_MS 를 넘긴 빌드는 더 지키지 않는다 — 연장을 멈추고, 읽기가 풀고, 늦게 끝난 결과는 버린다', { timeout: 30_000 }, async () => {
    const graph = await seedGraph('lease-max-age', { status: 'ready', commit: 'old-commit' });
    const logs = [];
    const svc = server({ logs, timing: { renewPeriodically: true, heartbeatMs: 50, leaseMs: 300, maxBuildMs: 500 } });
    const run = await startGatedBuild(svc, graph);
    try {
      await sleep(1_200); // 최대 시간(500ms) + lease(300ms) 를 넘긴다
      const read = await svc.resolveOrProvision({ accountId: ACCOUNT_ID, graphId: graph.id });
      assert.equal(read.status, 'error');
      assert.match(read.error, /abandoned/);
      assert.ok(logs.some((entry) => /ran past its maximum duration/.test(entry.message)), '최대 시간을 넘기면 연장을 멈춘다');
    } finally {
      run.release();
      await run.build.catch(() => {});
    }
    await assert.doesNotReject(run.build);
    const stored = await readGraph(graph);
    assert.equal(stored.status, 'error', '풀린 뒤 늦게 끝난 빌드는 결과를 쓰지 않는다');
    assert.equal(stored.commit, 'old-commit');
    assert.ok(logs.some((entry) => /lost its claim before it finished/.test(entry.message)));
  });

  it('교체 트랜잭션이 lease 보다 오래 걸려도 읽기를 붙잡지 않고, 실패하면 진짜 원인을 남긴다', { timeout: 30_000 }, async () => {
    const graph = await seedGraph('lease-long-replace', { status: 'ready', commit: 'old-commit' });
    const persisting = gate();
    const persisted = gate();
    const svc = server({
      timing: { renewPeriodically: false, leaseMs: 300 },
      extraction: {
        extractRepo: async () => extractionOf(graph, 'long-commit'),
        persistExtraction: async () => {
          persisting.open();
          await persisted.opened;
          throw new Error('교체 트랜잭션의 진짜 실패');
        },
      },
    });
    let build = null;
    svc.kickOffInitialBuild = (claimed) => { build = svc.runInitialBuild(claimed); };
    assert.equal((await svc.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID })).started, true);
    try {
      await reached(persisting.opened, build, '저장');
      await sleep(800); // lease(300ms) 가 트랜잭션 도중에 지난다
      // sql.js 에서 해제 UPDATE 를 걸면 그 UPDATE 는 이 트랜잭션 뒤에 줄 서서 읽기가 트랜잭션 끝까지 멈춘다.
      const read = svc.resolveOrProvision({ accountId: ACCOUNT_ID, graphId: graph.id });
      assert.equal(await settlesWithin(read, 1_000), true, '읽기가 교체 트랜잭션 뒤에서 기다렸다');
      assert.equal((await read).status, 'building');
    } finally {
      persisted.open();
      await build?.catch(() => {});
    }
    await assert.rejects(build, /교체 트랜잭션의 진짜 실패/);
    const stored = await readGraph(graph);
    assert.equal(stored.status, 'error');
    assert.match(stored.error, /교체 트랜잭션의 진짜 실패/, '끊긴 빌드로 덮이지 않고 실패 원인이 남는다');
    assert.equal(stored.commit, 'old-commit');
  });
});

describe('heartbeat — 다른 서버가 보기에도 살아 있다', () => {
  it('lease 보다 오래 걸리는 빌드도 다른 서버의 읽기가 풀지 않고, 끝나면 build_id · lease 를 비운다', { timeout: 30_000 }, async () => {
    const graph = await seedGraph('lease-heartbeat', { status: 'ready', commit: 'old-commit' });
    const logs = [];
    const builder = server({ logs, timing: { renewPeriodically: true, leaseMs: 2_000, heartbeatMs: 100 } });
    const other = server();
    const run = await startGatedBuild(builder, graph);
    try {
      await sleep(4_500); // lease 의 두 배 넘게 — heartbeat 가 없으면 lease 가 지난다
      const read = await other.resolveOrProvision({ accountId: ACCOUNT_ID, graphId: graph.id });
      assert.equal(read.status, 'building', '살아 있는 빌드는 다른 서버의 읽기가 풀지 않는다');
      assert.ok(read.build_lease_until_ms > Date.now(), 'heartbeat 가 lease 를 앞에 둔다');
    } finally {
      run.release();
      await run.build.catch(() => {});
    }
    await run.build;
    const built = await readGraph(graph);
    assert.equal(built.status, 'ready');
    assert.equal(built.build_id, '');
    assert.equal(built.build_lease_until_ms, null);
    assert.deepEqual(logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message), [], '끝난 빌드의 연장이 "주인을 잃었다" 로 보이지 않는다');
  });

  it(`주기 연장은 Postgres 에서만 한다 — sql.js 에서는 ontology.db 를 flush 마다 dirty 로 만들어 전체 export 만 부른다 (지금 ${IS_POSTGRES ? 'Postgres' : 'sql.js'})`, { timeout: 30_000 }, async () => {
    const graph = await seedGraph('lease-renew-dialect', { status: 'ready' });
    const builder = server({ timing: { heartbeatMs: 50 } }); // renewPeriodically 는 기본값 그대로
    const run = await startGatedBuild(builder, graph);
    try {
      const first = (await readGraph(graph)).build_lease_until_ms;
      await sleep(400);
      const later = (await readGraph(graph)).build_lease_until_ms;
      if (IS_POSTGRES) assert.ok(later > first, 'Postgres 에서는 다른 서버가 보도록 lease 를 미룬다');
      else assert.equal(later, first, 'sql.js 에서는 lease 를 미루지 않는다(liveBuilds · 부팅 정리가 맡는다)');
    } finally {
      run.release();
      await run.build.catch(() => {});
    }
    await run.build;
  });

  // sql.js 의 쓰기는 큐에서, Postgres 의 쓰기는 커넥션 풀에서 기다린다. 기다리기 전에 lease 를 재 두면
  // 오래 기다린 연장이 이미 지난 lease 를 쓰고, 그 뒤에 줄 선 해제 UPDATE 에 걸린다(리뷰 지적).
  // 여기서는 sql.js 큐를 붙잡아 재현한다 — Postgres 에서는 트랜잭션이 다른 쓰기를 붙잡지 않아 그대로 통과한다.
  it('큐에서 오래 기다린 연장도 쓰는 때의 lease 를 쓴다 — 그 뒤의 해제 UPDATE 에 걸리지 않는다', { timeout: 30_000 }, async () => {
    const graph = await seedGraph('lease-queued-renewal', { status: 'ready', commit: 'old-commit' });
    const builder = server({ timing: { renewPeriodically: true, leaseMs: 1_000, heartbeatMs: 100 } });
    const other = server();
    const run = await startGatedBuild(builder, graph);
    const holding = gate();
    const held = gate();
    const stall = ds.transaction(async () => { holding.open(); await held.opened; });
    let otherRead = null;
    try {
      await holding.opened;
      await sleep(1_500); // 연장 하나가 큐에서 기다리는 동안 lease(1s) 가 지난다
      otherRead = other.resolveOrProvision({ accountId: ACCOUNT_ID, graphId: graph.id });
      await sleep(300); // 다른 서버의 해제 UPDATE 가 그 연장 뒤에 줄 선다
    } finally {
      held.open();
      await stall.catch(() => {});
    }
    try {
      const read = await otherRead;
      assert.notEqual(read?.status, 'error', '큐에서 기다린 연장이 이미 지난 lease 를 써서 살아 있는 빌드가 풀렸다');
    } finally {
      run.release();
      await run.build.catch(() => {});
    }
    await run.build;
    assert.equal((await readGraph(graph)).status, 'ready');
  });
});

describe('fencing — 주인 자리를 잃은 빌드는 끝내는 쓰기를 하지 않는다', () => {
  // 서버 A 의 빌드를 추출 단계에 세워 두고, A 가 사라진 것처럼 lease 를 지나게 한 뒤 서버 B 가
  // Refresh 로 다시 claim 한다(B 의 빌드는 띄우지 않는다).
  async function supersede(resourceId) {
    const graph = await seedGraph(resourceId, { status: 'ready', commit: 'snapshot-commit' });
    await seedSnapshotNode(graph);
    const logs = [];
    let persistCalls = 0;
    const serverA = server({
      logs,
      timing: { renewPeriodically: false },
      extraction: { persistExtraction: async () => { persistCalls += 1; return persistSummaryOf(0); } },
    });
    const run = await startGatedBuild(serverA, graph);
    await expireLease(graph);
    const serverB = server();
    const claimsB = [];
    serverB.kickOffInitialBuild = (claimed) => { claimsB.push(claimed); };
    assert.equal((await serverB.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID })).started, true, 'lease 가 지난 빌드는 다른 서버의 Refresh 가 다시 claim 한다');
    const claimB = await readGraph(graph);
    assert.notEqual(claimB.build_id, run.buildId);
    assert.deepEqual(claimsB.map((claimed) => claimed.build_id), [claimB.build_id]);
    return { graph, logs, run, claimB, persistCalls: () => persistCalls };
  }

  function assertClaimBKept(stored, claimB) {
    assert.equal(stored.status, 'building', '새 claim 이 그대로 남는다');
    assert.equal(stored.build_id, claimB.build_id);
    assert.equal(stored.build_lease_until_ms, claimB.build_lease_until_ms);
    assert.equal(stored.commit, 'snapshot-commit');
  }

  it('추출 중에 다시 claim 되면 옛 빌드는 교체를 시작하지 않고 끝난다 — 새 claim 과 직전 스냅샷이 그대로다', { timeout: 30_000 }, async () => {
    const { graph, logs, run, claimB, persistCalls } = await supersede('lease-fence-before-replace');
    run.release();
    await assert.doesNotReject(run.build, '자리를 잃은 빌드는 실패가 아니라 조용히 끝난다');

    assertClaimBKept(await readGraph(graph), claimB);
    assert.equal(persistCalls(), 0, '교체 트랜잭션을 열지 않는다');
    assert.deepEqual(await snapshotSymbols(graph), ['sym:snapshot']);
    assert.ok(logs.some((entry) => entry.level === 'warn' && /lost its claim before it finished/.test(entry.message)));
  });

  it('옛 빌드가 실패해도 새 claim 을 error 로 덮지 않는다', { timeout: 30_000 }, async () => {
    const { graph, logs, run, claimB } = await supersede('lease-fence-failure');
    run.fail(new Error('옛 빌드의 추출 실패'));
    await assert.rejects(run.build, /옛 빌드의 추출 실패/);

    assertClaimBKept(await readGraph(graph), claimB);
    assert.ok(logs.some((entry) => entry.level === 'warn' && /failed after losing its claim/.test(entry.message)));
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
    const serverA = server({
      logs,
      timing: { renewPeriodically: false },
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
    });
    let buildA = null;
    serverA.kickOffInitialBuild = (claimed) => { buildA = serverA.runInitialBuild(claimed); };
    const serverB = server();
    serverB.kickOffInitialBuild = () => {};

    assert.equal((await serverA.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID })).started, true);
    let claimB;
    try {
      await reached(persisting.opened, buildA, '저장');
      await expireLease(graph);
      assert.equal((await serverB.forceRebuild({ graphId: graph.id, accountId: ACCOUNT_ID })).started, true);
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

// 읽기는 행을 읽은 뒤 해제 UPDATE 를 건다. 그 사이 행이 바뀌었으면(주인이 연장했거나, 빌드가 끝났거나,
// 다른 빌드가 다시 claim 했으면) UPDATE 의 조건이 막아야 한다 — 읽은 값만으로 판정하면 안 된다.
// 공개 경로는 그때그때 새로 읽으므로, 낡은 스냅샷을 해제 단계에 직접 넘긴다.
describe('해제 CAS — 읽은 행이 낡았어도 UPDATE 가 판정한다', () => {
  it('읽은 뒤 주인이 lease 를 연장했으면 풀지 않는다', async () => {
    const graph = await seedGraph('lease-cas-renewed', abandonedBuild());
    const stale = await readGraph(graph);
    await graphRepo.update({ id: graph.id }, { build_lease_until_ms: Date.now() + 10 * MINUTE });

    await server().releaseAbandonedBuild(stale);
    assert.equal((await readGraph(graph)).status, 'building');
  });

  it('읽은 뒤 빌드가 끝났으면 풀지 않는다', async () => {
    const graph = await seedGraph('lease-cas-finished', { status: 'building' }); // build_id · lease 없음(옛 행)
    const stale = await readGraph(graph);
    await graphRepo.update({ id: graph.id }, { status: 'ready', commit: 'finished-commit' });

    await server().releaseAbandonedBuild(stale);
    const stored = await readGraph(graph);
    assert.equal(stored.status, 'ready');
    assert.equal(stored.error, '');
  });

  it('읽은 뒤 이 서버의 빌드가 다시 claim 했으면, 그 빌드의 lease 가 지나 보여도 풀지 않는다', { timeout: 30_000 }, async () => {
    const graph = await seedGraph('lease-cas-reclaimed', { status: 'ready' });
    const svc = server({ timing: { renewPeriodically: false } });
    const run = await startGatedBuild(svc, graph);
    try {
      await expireLease(graph);
      // 그 전에 이 그래프를 맡았다 사라진 다른 빌드의 스냅샷
      const stale = { ...(await readGraph(graph)), build_id: `gone-${randomUUID()}` };
      await svc.releaseAbandonedBuild(stale);
      const stored = await readGraph(graph);
      assert.equal(stored.status, 'building');
      assert.equal(stored.build_id, run.buildId);
    } finally {
      run.release();
      await run.build.catch(() => {});
    }
    await run.build;
    assert.equal((await readGraph(graph)).status, 'ready');
  });
});
