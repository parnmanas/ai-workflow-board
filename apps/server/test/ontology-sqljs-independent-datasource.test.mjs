// 회귀 테스트 — ticket 6ca4894a
// "Ontology Graph 1/7 스키마 — OntologyNode/OntologyEdge 엔티티 + sql.js 전용
// DataSource 분리"
//
// DESIGN.md 축 3 / REVIEW-NOTES.md S1(critical)+S3(major): OntologyNode/
// OntologyEdge가 PRIMARY sql.js DataSource(dirty flag, flush timer,
// serializeSqljsTransactions() 큐)를 공유한다면, 온톨로지 테이블 증가가
// 공유 파일의 이후 모든 flush를 부풀려서 — 온톨로지 사용자뿐 아니라 모든
// 사용자의 인스턴스 전체 요청 처리(티켓 이동, 코멘트, dispatch)를
// 블로킹하게 된다. 그 픽스는 온톨로지 테이블 전용, 완전히 독립된 두
// 번째 sql.js DataSource(AppOntologyDataSource, db.ts)다.
//
// 이 스위트는 두 번째 DataSource가 "존재한다"는 것만이 아니라 독립성을
// 끝까지 증명한다:
//   1. 정적 가드 — primary DataSource의 sqljs entities 배열은 Ontology*를
//      제외하고, 온톨로지 DataSource의 옵션은 다른 디스크 파일을 가리키며
//      자기만의 subscriber 클래스를 갖는다.
//   2. DIRTY-FLAG 독립성 — 한쪽 DataSource에 쓰는 것이 절대 다른 쪽을
//      dirty로 표시하지 않는다.
//   3. FLUSH 독립성 — 한쪽 DataSource를 flush하는 것이 절대 다른 쪽의
//      saveDatabase()를 호출하지 않고, 다른 쪽의 dirty flag도 지우지 않는다.
//   4. 큐 독립성 — serializeSqljsTransactions()는 DataSource별로 적용된다
//      (db.ts 모듈 로드 시점), 그래서 서로 다른 두 DataSource에 대한 동시
//      transaction() 호출은 진짜로 병렬 실행된다 — 같은 DataSource에 걸린
//      두 개의 겹치는 호출이 maxActive=1로 직렬화됨을 이미 증명한
//      sqljs-transaction-serialize-queue.test.mjs와 대조적이다.
//   5. 동일 경로 충돌 가드(리뷰 지적, 6ca4894a Review round 1) —
//      buildOntologyDataSourceOptions()는 정규화된 위치가 primary
//      DataSource와 같은 DataSource를 만드는 것을 거부한다 — 두 독립
//      sql.js 인스턴스가 조용히 같은 디스크 파일을 export하게 두는 대신.
//   6. 완료조건 3, 리뷰 round 1에서 두 번 교정됨(전체 경위는 아래 KNOWN V1
//      LIMITATION 테스트 바로 위의 긴 코멘트 참고 — 첫 번째 픽스는 실제
//      saveDatabase() 호출 전에 gate를 mock해서 아무것도 증명하지 못했고,
//      두 번째 픽스의 "청크 단위 대량 population" 테스트는 실제(존재하지
//      않는, 범위 밖) population 경로가 재현한다는 보장이 없는 실제 동작을
//      test-only setTimeout으로 몰래 끼워 넣었다). 이 티켓이 실제로 보장하고
//      테스트하는 것: 큐 독립성(위 4번)이 필요한 구조적 전제조건이고;
//      flush 자신의 동기식 db.export()는 실제로 그 시간 동안 이벤트 루프를
//      독점한다 — 버그가 아니라 실재하는, DESIGN.md가 인정한 v1 한계이며,
//      아래에서 결정론적으로 증명한다. 실제 대량 population 워크로드에
//      대한 완전한 비블로킹 동작은 여기서 명시적으로 확립하지 않으며,
//      그 워크로드를 구현하는 티켓의 필수 의무다(여기 문서화만이 아니라
//      ticket e14ef1c9에 직접 플래그해둠).
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요, test 스크립트가
// 보장). 격리된 SQLJS_DB_PATH / SQLJS_ONTOLOGY_DB_PATH 임시 파일을 써서
// 공유 dev database/*.db는 절대 건드리지 않는다.

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
    // 각 백엔드 자신의 synchronize()가 만든 스키마를 영속화하고 두 dirty
    // flag를 모두 리셋해서, 모든 테스트가 알려진 깨끗한 기준선에서 시작하게
    // 한다.
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
    const primaryLocation = resolveSqljsLocation().location; // 이 테스트 파일에서는 절대경로 tmp 경로
    const prevOntologyPath = process.env.SQLJS_ONTOLOGY_DB_PATH;

    try {
      // primary와 정확히 같은 절대경로.
      process.env.SQLJS_ONTOLOGY_DB_PATH = primaryLocation;
      assert.throws(
        () => buildOntologyDataSourceOptions(),
        /same file as the primary sql\.js DB/,
        'an exact-same-path override must throw at construction time, not silently build a colliding DataSource',
      );

      // 철자는 다르지만 정규화 결과는 같은 경로(중복된 ../ 세그먼트) —
      // 가드가 단순 문자열 동등성이 아니라 path.resolve()로 정규화 비교함을
      // 증명한다, 리뷰어의 명시적 요청과 일치.
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

    // 실제 격리된 테스트 설정(이 파일 자신의 env 설정)은 절대 가드에
    // 걸리면 안 된다 — 기본값/격리된 경로는 설계상 항상 다르다.
    assert.doesNotThrow(() => buildOntologyDataSourceOptions(), 'the actual isolated test paths must never collide');
  });

  it('dirty-flag independence: writing ontology rows never marks the primary DataSource dirty, and vice versa', async () => {
    // 기준선: 둘 다 깨끗함.
    await flushSqljs(AppDataSource, true);
    await flushOntologySqljs(AppOntologyDataSource, true);
    assert.equal(isSqljsDirty(), false);
    assert.equal(isOntologySqljsDirty(), false);

    const nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
    await nodeRepo.save(nodeRepo.create(makeNode('dirty-1')));
    assert.equal(isOntologySqljsDirty(), true, 'an ontology write must mark the ontology dirty flag');
    assert.equal(isSqljsDirty(), false, 'an ontology write must NOT mark the primary dirty flag');

    // 온톨로지를 flush하면 온톨로지 flag만 지워진다.
    await flushOntologySqljs(AppOntologyDataSource);
    assert.equal(isOntologySqljsDirty(), false);
    assert.equal(isSqljsDirty(), false);

    // 이제 반대 방향.
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
    // sqljs-transaction-serialize-queue.test.mjs와 대조된다 — 그 파일은
    // 같은 DataSource에 걸린 두 개의 겹치는 호출에 대해 maxActive가
    // 1로 유지됨을 증명한다. 여기서는 DataSource마다 하나씩, 동시에
    // 호출한다 — 만약 큐를 공유한다면(이 티켓이 막으려는 바로 그 버그)
    // maxActive는 단일 DataSource 케이스와 똑같이 1로 제한될 것이다.
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

  // 완료조건 3, 두 번 교정됨(리뷰 지적, 6ca4894a Review round 1 — 리뷰어는
  // 이 스위트를 로컬에서 재실행한 뒤 위 1+2번 픽스를 승인했지만, round 1
  // 자신의 3a 첫 시도 자체가 여전히 틀렸고 더 예리한 두 번째 지적을 받았다):
  //
  // Round-1-a: 이 테스트의 첫 번째 버전은 MOCK한 saveDatabase()를 실제
  // origOntoSave() 호출 앞에서 Promise로 멈춰 세웠다 — 즉 실제 동기식
  // WASM db.export() 호출(950k행 DB에서 676ms로 측정,
  // scripts/benchmark-ontology-flush.mjs)이 "동시" primary 쓰기가 실행되는
  // 동안 실제로는 단 한 번도 실행되지 않았다는 뜻이다. 아래 KNOWN V1
  // LIMITATION 테스트(실제, mock 없는 flush)로 교체해서 고쳤다 — 픽스
  // 세부사항은 그 자신의 코멘트 참고.
  //
  // Round-1-b(이번 픽스): 두 번째 버전 — "COMPLETION CRITERION 3a" —는
  // 실제 청크 단위 온톨로지 트랜잭션을 청크 사이 test-only `setTimeout(5)`로
  // 감싸서 interleaving assertion을 결정론적으로 만들었고, 이게 "실제 대량
  // population 트랜잭션이 동시 primary 쓰기를 블로킹하지 않는다"를
  // 증명한다고 주장했다. 리뷰어가 이를 정확히 반려했다: 이 티켓의 범위는
  // 스키마 + DataSource 분리뿐이다 — 이 코드베이스 어디에도 실제 대량
  // population/writer 서비스가 아직 없으므로(그건 추출 워커인 ticket
  // e14ef1c9의 몫), 그 주장이 가리키는 "실제 경로"는 테스트할 대상 자체가
  // 없었다. setTimeout(5)는 테스트 안에서 실제로 뭔가를 하고
  // 있었다(이벤트 루프 양보 지점을 만듦) — 그런데 처음부터 구현될
  // population은 이걸 재현한다는 보장이 없다 — `await repo.insert()`
  // 하나만으로는 microtask 큐를 통해 이어질 뿐, 명시적 매크로태스크
  // (setImmediate/setTimeout)처럼 timer/I/O phase로의 공정한 양보를
  // 보장하지 않으므로, 그 주장은 "실제 청크 단위 population 루프 전반"이
  // 아니라 "우연히 청크 사이에 매크로태스크로 양보하는 루프"에만 적용됐다.
  //
  // 정정: 완료조건 3의 문자 그대로의 표현("온톨로지 대량 쓰기 중 기존
  // AWB 쓰기가 블로킹되지 않음을 테스트로 검증")은 실제 wall-clock
  // 관점에서 검증할 실제 population 워크로드를 요구한다 — 이 티켓은
  // 범위 밖의 population 구현을 새로 만들지 않고서는 그걸 정직하게
  // 주장할 수 없다. 이 티켓이 실제로 검증하고 보장하는 것은 구조적,
  // 필요조건이다: 위 'queue independence' 테스트가 이미 온톨로지
  // DataSource의 transaction()과 primary DataSource의 transaction()이
  // 동시에 실행됨(maxActive=2)을 증명한다 — 즉 `serializeSqljsTransactions()`의
  // FIFO 큐를 공유하지 않으므로, 이 티켓 자신의 코드 안에는 population
  // 쓰기가 primary 쓰기 뒤로 직렬화되도록(혹은 그 반대로) 강제하는 것이
  // 없다. 이건 필요하지만 그 자체로 충분하지는 않다: 실제 대량 population
  // 루프를 구현하는 티켓(e14ef1c9, 추출 워커, 또는 이후의 fan-out
  // writer 어떤 것이든)은 추가로 (a) 명시적 매크로태스크(예:
  // `setImmediate`)로 배치 사이에 이벤트 루프를 양보해야 하고 —
  // microtask로 이어지는 `await`만으로는 안 됨 — (b) 자기 자신의 실제
  // 쓰기 경로에 대해 비블로킹 동작을 직접 테스트해야 한다 — 그 의무는 이
  // 티켓의 그 무엇으로도 충족되지 않고, 이 티켓으로부터 물려받는다고
  // 가정해서도 안 된다(여기 문서화만이 아니라 ticket e14ef1c9 자체에도
  // 코멘트로 명시적으로 플래그해둠).

  it('KNOWN V1 LIMITATION, documented not claimed fixed: the ontology flush\'s synchronous db.export() call monopolizes the event loop for its duration', async () => {
    // DESIGN.md 축 3은 "sql.js flush를 메인 스레드 밖으로 이동"을 v1
    // 메커니즘으로 명시적으로 REJECT한다(sql.js의 WASM 상주 Database
    // 객체는 flush 소유권 재설계 없이는 worker_threads 경계를 안전하게
    // 넘을 수 없고, 이 설계 문서는 그 재설계 크기를 산정하지 않는다) —
    // 이건 실재하는, 이름 붙은 후속 과제(§10a)지 v1 커밋이 아니다. 이
    // 테스트는 이 한계가 구조적으로 존재함을(결정론적으로 — wall-clock
    // 레이스가 아니라 순서로) 증명한다, 사실이 아닌데 비블로킹이라고
    // 조용히 주장하는 대신.
    // 3000행짜리 .insert() 호출 한 번이 아니라 청크 단위 insert — TypeORM의
    // 대량 insert 빌더는 이 엔티티의 컬럼 수를 감안하면 3000행보다 훨씬
    // 전에 sql.js/SQLite의 expression-tree 깊이 상한(~1000)을 넘어버린다.
    // 이건 여기서 테스트하려는 지점(flush가 실제 export를 하도록, 조기
    // 반환이 아니라, 어느 정도 실제 데이터가 존재해야 함)과는 별개다 —
    // 청크 대 단일 호출의 구분은 에러 없이 빠르게 채우는 데 중요한 것이지,
    // 테스트 대상인 블로킹 동작과는 무관하다.
    const repo = AppOntologyDataSource.getRepository(OntologyNode);
    for (let offset = 0; offset < 3000; offset += 500) {
      await repo.insert(Array.from({ length: 500 }, (_, i) => makeNode(`export-block-${offset + i}`)));
    }
    assert.equal(isOntologySqljsDirty(), true, 'sanity: there must be pending writes for the flush below to actually export, not early-return');

    let microtaskRan = false;
    Promise.resolve().then(() => { microtaskRan = true; });

    // await 없는 순수 호출 — async 함수의 본문(그 안 깊숙이 있는 실제
    // 동기식 db.export() 포함)이 이 줄 안에서 완료까지 실행되고, 그 후에야
    // 제어가 여기로 돌아온다.
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

// TypeORM/sql.js는 이벤트 루프를 붙잡아두는 핸들을 남긴다. 이 스위트는
// `--test-force-exit`로 실행돼 그런 핸들을 정리하고 node:test가 계산한
// 실제 종료 코드로 exit한다 — 수동 process.exit()은 그 코드를 덮어써
// 실패한 assertion을 가릴 수 있으므로 쓰지 않는다.
