// 회귀 테스트 — ticket 762fbe05
// "sql.js 드라이버/TypeORM 설정에 트랜잭션 직렬화 큐 도입 검토"
//
// 배경(ticket 02c85264): sql.js 백엔드는 커넥션이 단 하나뿐이다 —
// SqljsDriver.createQueryRunner()가 커넥션이 살아있는 동안 단일
// SqljsQueryRunner를 메모이즈해 재사용하고, 진짜 풀링은 없다. 그래서 겹치는
// (overlapping) 두 dataSource.transaction() 호출은 그 하나의 runner를
// 공유하게 된다. 진 쪽은 깔끔하게 실패하지 않는다 — 이미 하나가 활성 상태인데
// 또 날리는 raw "BEGIN TRANSACTION"이 도중에 throw하고, EntityManager.
// transaction()의 catch 블록이 그 SHARED runner에 raw ROLLBACK을 날리면서
// 실제로는 더 진행돼 있던 쪽의 트랜잭션까지 조용히 중단시켜 버린다. 이는 아래
// 첫 번째 테스트("raw workspace count")로 직접 증명된다: 겹치는 두 미적용
// (unpatched) 트랜잭션이 총 4개 행을 쓰려 시도했을 때 2개만 살아남는다.
//
// 이 스위트가 증명하는 것:
//   1. 회귀 재현 — 원래의 레이스가 미적용(UNPATCHED) sqljs DataSource에서는
//      여전히 재현된다는 것을 직접 확인한다(이 픽스가 겨냥하는 typeorm/sql.js
//      동작이 향후 업그레이드로 바뀌어도 이 스위트 자체가 조용히 무의미해지지
//      않도록 하는 안전장치).
//   2. 픽스 — serializeSqljsTransactions()가 겹치는 호출을 큐로 묶어 어느
//      순간에도 transaction() 콜백이 최대 1개만 활성화되게 하고, 이 코드베이스가
//      쓰는 두 호출 형태(dataSource.transaction() / repo.manager.transaction())
//      모두에서 쓰기가 하나도 유실되지 않음을 증명한다.
//   3. 데드락 없음 — 같은 호출 체인 안에서 transaction() 콜백 안에 중첩된
//      transaction() 호출(savepoint 중첩)은 자기 큐 차례를 기다리며 멈추지
//      않고 정상적으로 끝난다.
//   4. 재진입 플래그의 수명 — 트랜잭션 콜백 "안에서" 예약해 둔 fire-and-forget
//      비동기 자손(await 없이 던져둔 setTimeout)은, 그 바깥 트랜잭션이 이미
//      settle된 뒤에 뒤늦게 transaction()을 불러도 재진입으로 오인되어 큐를
//      건너뛰지 않는다 — AsyncLocalStorage의 store가 run() 콜백의 "논리적
//      범위"가 아니라 그 안에서 만들어진 모든 비동기 자손에 계속 전파된다는
//      점을 감안한 설계다.
//   5. 엄격한 FIFO — 서로 무관한 동시 호출자들도 "우연히 이번엔 안 겹쳤다"가
//      아니라 실제로 호출한 순서대로 게이팅된다.
//   6. 정적 가드 — sqljs가 아닌 DataSource는 전혀 손대지 않는다.
//
// 컴파일된 dist/ 를 대상으로 실행한다(`npm run build` 필요, test 스크립트가
// 보장). 공유 dev database/data.db를 절대 건드리지 않도록 격리된 SQLJS_DB_PATH
// 임시 파일을 사용한다.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-sqljs-txn-queue-'));
const DB_FILE = path.join(tmpDir, 'txn-queue-test.db');
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const dbUrl = 'file://' + path.join(DIST_ROOT, 'db.js');
const wsUrl = 'file://' + path.join(DIST_ROOT, 'entities', 'Workspace.js');

const { buildDataSourceOptions, serializeSqljsTransactions } = await import(dbUrl);
const { Workspace } = await import(wsUrl);
const { DataSource } = await import('typeorm');

async function openDataSource() {
  const ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();
  return ds;
}

const KNOWN_RACE_ERRORS =
  /cannot start a transaction within a transaction|Transaction is not started yet/;

// 두 번의 write 사이에 실제 await 간격을 둬서 동시 호출이 끼어들 여지를 만든다
// — ticket 02c85264의 원래 재현 스크립트와 같은 형태.
function makeOverlappingWrite(tag) {
  return async (manager) => {
    const repo = manager.getRepository(Workspace);
    await repo.save(repo.create({ name: `${tag}-a`, description: 'overlap' }));
    await new Promise((r) => setTimeout(r, 15));
    await repo.save(repo.create({ name: `${tag}-b`, description: 'overlap' }));
    return tag;
  };
}

describe('sql.js transaction serialization queue (ticket 762fbe05)', () => {
  let raw; // 미적용 — 원래의 레이스를 재현
  let patched; // serializeSqljsTransactions() 적용 — 픽스

  before(async () => {
    raw = await openDataSource();
    patched = await openDataSource();
    serializeSqljsTransactions(patched);
  });

  after(async () => {
    if (raw?.isInitialized) await raw.destroy();
    if (patched?.isInitialized) await patched.destroy();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('regression demonstration: an UNPATCHED sqljs DataSource still races and loses/errors on overlap', async () => {
    const results = await Promise.allSettled([
      raw.transaction(makeOverlappingWrite('raw-a')),
      raw.transaction(makeOverlappingWrite('raw-b')),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.ok(
      rejected.length >= 1,
      'at least one overlapping call must fail on an unpatched sqljs connection — if this now ' +
        'passes with 0 rejections, the underlying typeorm/sql.js behavior this fix targets may ' +
        'have changed and serializeSqljsTransactions() should be re-evaluated',
    );
    for (const r of rejected) {
      assert.match(
        r.reason?.message || '',
        KNOWN_RACE_ERRORS,
        `unexpected failure mode (not the known sql.js overlap race): ${r.reason?.message}`,
      );
    }
    // 진짜 위험은 에러가 던져진다는 것 자체가 아니라, 진 쪽의 실패 처리가
    // 공유 커넥션을 ROLLBACK시켜 이긴 쪽까지 조용히 날려버릴 수 있다는 것이다.
    // 4개 행(raw-a-a, raw-a-b, raw-b-a, raw-b-b)을 쓰려 했으니, 미적용
    // 커넥션은 4개를 온전히 다 갖고 있어서는 안 된다.
    const rawCount = await raw.getRepository(Workspace).count();
    assert.ok(
      rawCount < 4,
      `expected the unpatched race to lose at least one write (silent cross-transaction ` +
        `rollback), got all 4 rows intact (count=${rawCount})`,
    );
  });

  it('fix: overlapping dataSource.transaction() calls serialize instead of racing', async () => {
    const [a, b] = await Promise.all([
      patched.transaction(makeOverlappingWrite('fix-a')),
      patched.transaction(makeOverlappingWrite('fix-b')),
    ]);
    assert.deepEqual([a, b], ['fix-a', 'fix-b'], 'both overlapping calls must resolve, not reject');

    const names = (await patched.getRepository(Workspace).find()).map((w) => w.name).sort();
    for (const n of ['fix-a-a', 'fix-a-b', 'fix-b-a', 'fix-b-b']) {
      assert.ok(names.includes(n), `expected ${n} to survive — no write should be lost once serialized`);
    }
  });

  it('fix: repo.manager.transaction() call shape shares the same queue as dataSource.transaction()', async () => {
    // dataSource.transaction()은 dataSource.manager.transaction()으로의
    // 위임일 뿐이다(typeorm/data-source/DataSource.js). 이 코드베이스의 여러
    // 호출부는 repo.manager.transaction()을 직접 부른다 — 두 형태를 한
    // overlap에 섞어본다.
    const repo = patched.getRepository(Workspace);
    let active = 0;
    let maxActive = 0;
    const tracked = (tag) => async (manager) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await makeOverlappingWrite(tag)(manager);
      } finally {
        active -= 1;
      }
    };
    const results = await Promise.all([
      repo.manager.transaction(tracked('mgr-a')),
      patched.transaction(tracked('mgr-b')),
    ]);
    assert.deepEqual(results, ['mgr-a', 'mgr-b']);
    assert.equal(
      maxActive,
      1,
      'repo.manager.transaction() and dataSource.transaction() must never run concurrently — ' +
        'they share the same underlying manager instance and must share the same queue',
    );
  });

  it('fix: a transaction() call nested on the SAME chain does not deadlock behind its own outer call', async () => {
    const outcome = await Promise.race([
      patched.transaction(async (outerManager) => {
        const outerRepo = outerManager.getRepository(Workspace);
        await outerRepo.save(outerRepo.create({ name: 'nested-outer', description: 'nested' }));
        // 이미 큐를 통과해 실행 중인 트랜잭션 "안에서" 루트 dataSource에 거는
        // 재진입 호출 — sqlite의 "nested" transactionSupport가 같은 shared
        // runner 위 SAVEPOINT로 처리해 준다. 이건 즉시 실행돼야지, 자기가
        // 중첩된 바로 그 호출 뒤에 큐잉되면(=바깥은 안쪽이 끝나야 끝나는데
        // 안쪽은 바깥 차례를 기다림) 데드락이 난다.
        await patched.transaction(async (innerManager) => {
          const innerRepo = innerManager.getRepository(Workspace);
          await innerRepo.save(innerRepo.create({ name: 'nested-inner', description: 'nested' }));
        });
        return 'completed';
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock timeout')), 5000)),
    ]);
    assert.equal(outcome, 'completed', 'a same-chain nested transaction() call must resolve, not deadlock');

    const names = (await patched.getRepository(Workspace).find()).map((w) => w.name);
    assert.ok(names.includes('nested-outer'), 'outer nested write must be committed');
    assert.ok(names.includes('nested-inner'), 'inner nested write must be committed');
  });

  it('fix: a fire-and-forget descendant scheduled inside a transaction callback does not inherit a stale reentry flag after the outer transaction has settled', async () => {
    // 리뷰 지적(ticket 762fbe05): AsyncLocalStorage의 store는 run() 콜백이
    // settle된 뒤에도, 그 콜백 실행 중에 만들어진 비동기 자손(예: await 없이
    // 던져둔 setTimeout)에 계속 전파된다. 바깥 트랜잭션이 setTimeout으로
    // 지연 작업을 예약해 두고 곧장 끝나 버리면, 그 지연 작업이 뒤늦게
    // transaction()을 부를 때도 여전히 "재진입"으로 오인돼 큐를 건너뛸 수
    // 있다 — 그 시점에 이미 다른 트랜잭션이 큐를 통해 실행 중이면 이 큐가
    // 막으려는 shared-runner 중첩 레이스가 재발한다.
    let active = 0;
    let maxActive = 0;
    const trackedWithDelay = (tag, delayMs) => async (manager) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const repo = manager.getRepository(Workspace);
        await repo.save(repo.create({ name: `${tag}-a`, description: 'stale-reentry' }));
        await new Promise((r) => setTimeout(r, delayMs));
        await repo.save(repo.create({ name: `${tag}-b`, description: 'stale-reentry' }));
        return tag;
      } finally {
        active -= 1;
      }
    };

    let descendantPromise;
    let markFired;
    const fired = new Promise((resolve) => { markFired = resolve; });

    // 바깥 트랜잭션 콜백 "안에서" setTimeout으로 지연 자손 호출을 예약하되
    // await하지 않고 바로 반환한다 — 바깥 transaction()은 곧바로 settle되고,
    // 지연 자손은 그보다 한참 뒤, 아래 "다른 큐 작업"이 여전히 활성인 동안
    // fire된다.
    await patched.transaction(async (outerManager) => {
      const outerRepo = outerManager.getRepository(Workspace);
      await outerRepo.save(outerRepo.create({ name: 'stale-outer', description: 'stale-reentry' }));
      setTimeout(() => {
        descendantPromise = patched.transaction(trackedWithDelay('stale-descendant', 5));
        markFired();
      }, 10);
    });

    // 바깥 트랜잭션이 settle된 직후 무관한 트랜잭션을 큐에 올린다 — 내부에
    // 40ms 간격을 둬서, 지연 자손이 fire되는 10ms 시점에 이 트랜잭션이 확실히
    // 아직 활성 상태이도록 여유를 준다.
    const otherPromise = patched.transaction(trackedWithDelay('other-queued', 40));

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('fire-and-forget descendant never fired')), 5000),
    );
    await Promise.race([fired, timeout]);

    await Promise.all([otherPromise, descendantPromise]);

    assert.equal(
      maxActive,
      1,
      'a stale-reentry descendant must queue behind the transaction that is currently active, not run alongside it',
    );

    const names = (await patched.getRepository(Workspace).find()).map((w) => w.name);
    for (const n of ['stale-outer', 'other-queued-a', 'other-queued-b', 'stale-descendant-a', 'stale-descendant-b']) {
      assert.ok(names.includes(n), `expected ${n} to survive — no write should be lost`);
    }
  });

  it('fix: unrelated concurrent callers still queue in strict FIFO call order', async () => {
    const order = [];
    const mk = (tag) => async () => {
      order.push(`${tag}-start`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`${tag}-end`);
    };
    // 배열 리터럴의 평가 순서(x, y, z)가 곧 동기적 호출 순서다 — 각
    // transaction() 호출은 await 없이 동기적으로 공유 queue 변수를 읽고
    // 갱신하므로, 이건 우연이 아니라 결정론적 동작이다.
    await Promise.all([patched.transaction(mk('x')), patched.transaction(mk('y')), patched.transaction(mk('z'))]);
    assert.deepEqual(
      order,
      ['x-start', 'x-end', 'y-start', 'y-end', 'z-start', 'z-end'],
      'each call must fully finish before the next one starts, in the order they were called',
    );
  });

  it('static guard: a non-sqljs DataSource is left completely untouched (no-op)', () => {
    const originalFn = async () => 'unpatched';
    const fakePostgres = { options: { type: 'postgres' }, manager: { transaction: originalFn } };
    serializeSqljsTransactions(fakePostgres);
    assert.equal(
      fakePostgres.manager.transaction,
      originalFn,
      'a non-sqljs DataSource.manager.transaction reference must not be replaced — ' +
        'Postgres/MySQL keep native pool-based concurrent transactions',
    );
  });
});

// TypeORM/sql.js는 이벤트 루프를 붙잡아두는 핸들을 남긴다. 이 스위트는
// `--test-force-exit`로 실행돼 그런 핸들을 정리하고 node:test가 계산한 실제
// 종료 코드로 exit한다 — 수동 process.exit()은 그 코드를 덮어써 실패한
// assertion을 가릴 수 있으므로 쓰지 않는다.
