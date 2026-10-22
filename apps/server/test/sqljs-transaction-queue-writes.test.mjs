// 회귀 테스트 — ticket 13f5b0f6
// "sql.js: 열린 트랜잭션과 겹친 무관한 repo.save() 가 그 트랜잭션에 합류해 함께 롤백된다"
//
// 배경: sql.js 에는 연결도 query runner 도 하나뿐이라(SqljsDriver.createQueryRunner() 가 메모이즈) 트랜잭션은
// 연결 전체의 상태다. serializeSqljsTransactions() 큐가 manager.transaction() 만 줄 세우던 동안, 큐를 탄
// 트랜잭션이 열려 있는 사이에 무관한 호출 체인이 보낸 쓰기가 그 트랜잭션 안에서 실행됐다 — repo.save() 는
// EntityPersistExecutor 가 열린 트랜잭션에 합류하고, insert/update/delete · QueryBuilder execute() · raw
// query() 는 문장 그대로 그 안에서 돈다. 그 트랜잭션이 롤백되면 이미 id 와 함께 성공으로 끝난 쓰기가 사라졌다.
//
// 이 스위트가 증명하는 것:
//   1. 전제 — 큐가 없는 sql.js DataSource 에서는 무관한 save 가 열린 트랜잭션에 합류해 그 롤백과 함께 사라진다.
//      typeorm/sql.js 가 바뀌어 이 전제가 사라지면 이 스위트가 먼저 알려 준다.
//   2. 큐가 걸린 DataSource 에서는 모든 쓰기 형태가 열린 트랜잭션이 끝나기를 기다린다 — 그 롤백에 휩쓸리지 않고,
//      커밋에 묶이지도 않는다(COMMIT 뒤에 실행된다). 트랜잭션 사이에 선 쓰기는 FIFO 순서를 지킨다.
//   3. 읽기(SELECT, 쓰기 없는 WITH)는 기다리지 않는다. 쓰기 키워드가 든 WITH 는 기다린다 — 분류가 틀리면 쓰기 쪽으로
//      틀려서 기다릴 뿐이다(키워드를 담은 읽기, 주석으로 시작하는 읽기).
//   4. 같은 체인 — 트랜잭션 콜백 안의 루트 repository 쓰기 · raw 쓰기 · 중첩 트랜잭션은 데드락 없이 그 트랜잭션의
//      일부로 돈다. 콜백이 await 없이 던진 save 가 커밋 뒤까지 이어져도 다음 트랜잭션에 섞이지 않는다.
//   5. 큐 밖에서 여는 트랜잭션(queryRunner.startTransaction(), QueryBuilder.useTransaction())은 거부된다.
//      initialize()/synchronize() 의 스키마 트랜잭션은 큐 안에서 열린다.
//   6. 온톨로지 DataSource 도 같다. sqljs 가 아닌 DataSource 는 손대지 않고, 두 번 걸어도 한 번 건 것과 같다.
//
// 컴파일된 dist/ 를 대상으로 실행한다(`npm run build` 필요, test 스크립트가 보장). 공유 dev database/ 의
// 파일을 건드리지 않도록 모든 sql.js 파일을 임시 디렉터리에 둔다.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-sqljs-queue-writes-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions, serializeSqljsTransactions, AppOntologyDataSource } = await import(
  'file://' + path.join(DIST_ROOT, 'db.js')
);
const { Account } = await import('file://' + path.join(DIST_ROOT, 'entities', 'Account.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities', 'OntologyNode.js'));
const { DataSource, EntitySchema } = await import('typeorm');

// soft delete 와 raw SQL 을 쓸 수 있는 테스트 전용 테이블 — 앱 엔티티에는 delete-date 컬럼이 없다.
const SoftNote = new EntitySchema({
  name: 'SoftNote',
  tableName: 'soft_notes',
  columns: {
    id: { type: 'varchar', primary: true, generated: 'uuid' },
    name: { type: 'varchar' },
    deleted_at: { type: 'datetime', nullable: true, deleteDate: true },
  },
});

let fileSeq = 0;
const opened = [];

function dataSourceOptions() {
  const base = buildDataSourceOptions();
  return { ...base, location: path.join(tmpDir, `ds-${++fileSeq}.db`), entities: [...base.entities, SoftNote] };
}

/** NestJS DatabaseModule 과 같은 모양 — 초기화한 뒤 큐를 건다. */
async function openDataSource({ serialize = true } = {}) {
  const ds = new DataSource(dataSourceOptions());
  opened.push(ds);
  await ds.initialize();
  if (serialize) serializeSqljsTransactions(ds);
  return ds;
}

function gate() {
  let open;
  const wait = new Promise((resolve) => { open = resolve; });
  return { wait, open };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function track(promise) {
  const state = { settled: false };
  promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return state;
}

async function withinDeadlockTimeout(promise) {
  let timer;
  const deadlock = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadlock')), 5000); });
  try {
    return await Promise.race([promise, deadlock]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 행 하나를 쓰고 gate 에서 멈추는 트랜잭션을 연다. `release()` 하면 `fail` 에 따라 롤백(throw)하거나 커밋한다.
 * 멈춘 동안 `during(manager)` 를 콜백 안에서 부를 수 있다 — 무관한 쓰기가 그 트랜잭션 안에 섞였는지 보는 자리다.
 */
async function openHeldTransaction(ds, tag, { fail = true, during } = {}) {
  const inside = gate();
  const release = gate();
  const seen = {};
  const done = ds.transaction(async (manager) => {
    const repo = manager.getRepository(Account);
    await repo.save(repo.create({ name: `${tag}-txn`, description: 'queue-writes' }));
    inside.open();
    await release.wait;
    if (during) Object.assign(seen, await during(manager));
    if (fail) throw new Error(`${tag}: rolled back on purpose`);
    return 'committed';
  }).then((v) => v, (e) => e);
  await inside.wait;
  return { release: () => release.open(), done, seen };
}

async function accountNames(ds, prefix) {
  return (await ds.getRepository(Account).find()).map((a) => a.name).filter((n) => n.startsWith(prefix)).sort();
}

describe('sql.js: writes outside a transaction take the transaction queue (ticket 13f5b0f6)', { timeout: 60_000 }, () => {
  after(async () => {
    for (const ds of opened) if (ds.isInitialized) await ds.destroy();
    if (AppOntologyDataSource?.isInitialized) await AppOntologyDataSource.destroy();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('premise: without the queue an unrelated repo.save() joins the open transaction and is lost with its rollback', async () => {
    const raw = await openDataSource({ serialize: false });
    const held = await openHeldTransaction(raw, 'premise');
    const repo = raw.getRepository(Account);
    const saved = await repo.save(repo.create({ name: 'premise-unrelated', description: 'queue-writes' }));
    assert.ok(saved.id, 'the unrelated save resolves with an id while the transaction is still open');
    held.release();
    assert.match((await held.done)?.message || '', /rolled back on purpose/);
    assert.deepEqual(
      await accountNames(raw, 'premise-'),
      [],
      'the unrelated row went down with a rollback it had nothing to do with — if it survives now, typeorm/sql.js ' +
        'changed and serializeSqljsTransactions() in db.ts should be re-evaluated',
    );
  });

  it('an unrelated repo.save() waits for the open transaction and survives its rollback', async () => {
    const ds = await openDataSource();
    const held = await openHeldTransaction(ds, 'rollback');
    const repo = ds.getRepository(Account);
    const save = repo.save(repo.create({ name: 'rollback-unrelated', description: 'queue-writes' }));
    const state = track(save);
    await sleep(30);
    assert.equal(state.settled, false, 'the save must not run inside the transaction that is open');

    held.release();
    assert.match((await held.done)?.message || '', /rolled back on purpose/);
    assert.ok((await save).id);
    assert.deepEqual(await accountNames(ds, 'rollback-'), ['rollback-unrelated'], 'only the transaction\'s own row is rolled back');
  });

  it('an unrelated write is not bound to a transaction that commits: it runs after the COMMIT', async () => {
    const ds = await openDataSource();
    const log = [];
    ds.subscribers.push({ afterQuery: (event) => log.push({ query: event.query, parameters: event.parameters ?? [] }) });

    const held = await openHeldTransaction(ds, 'commit', {
      fail: false,
      during: async (manager) => ({ visibleInside: await manager.getRepository(Account).countBy({ name: 'commit-unrelated' }) }),
    });
    const repo = ds.getRepository(Account);
    const save = repo.save(repo.create({ name: 'commit-unrelated', description: 'queue-writes' }));
    await sleep(10);
    held.release();
    assert.equal(await held.done, 'committed');
    await save;

    assert.equal(held.seen.visibleInside, 0, 'the unrelated row was not written inside the transaction');
    const commitAt = log.findIndex((e) => /^COMMIT/i.test(e.query));
    const insertAt = log.findIndex((e) => /^INSERT INTO "accounts"/i.test(e.query) && e.parameters.includes('commit-unrelated'));
    assert.ok(commitAt >= 0 && insertAt > commitAt, `the unrelated INSERT runs after the COMMIT (commit #${commitAt}, insert #${insertAt})`);
    assert.deepEqual(await accountNames(ds, 'commit-'), ['commit-txn', 'commit-unrelated']);
  });

  it('every write shape waits for the open transaction and survives its rollback', async () => {
    const ds = await openDataSource();
    const accounts = ds.getRepository(Account);
    const notes = ds.getRepository(SoftNote);
    const seed = async (name) => accounts.save(accounts.create({ name, description: 'seed' }));
    await seed('shape-update');
    await seed('shape-delete');
    await seed('shape-increment');
    const toRemove = await seed('shape-remove');
    const toSoftRemove = await notes.save(notes.create({ name: 'shape-soft-remove' }));
    const toRecover = await notes.save(notes.create({ name: 'shape-recover' }));
    await notes.softRemove(toRecover);

    const held = await openHeldTransaction(ds, 'shape');
    const upsertId = randomUUID();
    const writes = {
      save: accounts.save(accounts.create({ name: 'shape-save', description: 'x' })),
      insert: accounts.insert({ name: 'shape-insert', description: 'x' }),
      update: accounts.update({ name: 'shape-update' }, { description: 'updated' }),
      delete: accounts.delete({ name: 'shape-delete' }),
      increment: accounts.increment({ name: 'shape-increment' }, 'max_concurrent_tickets_per_agent', 4),
      upsert: accounts.upsert({ id: upsertId, name: 'shape-upsert', description: 'x' }, ['id']),
      remove: accounts.remove(toRemove),
      softRemove: notes.softRemove(toSoftRemove),
      recover: notes.recover(toRecover),
      queryBuilder: ds.createQueryBuilder().insert().into(SoftNote).values({ id: randomUUID(), name: 'shape-qb' }).execute(),
      rawDataSource: ds.query('INSERT INTO soft_notes (id, name) VALUES (?, ?)', [randomUUID(), 'shape-raw-ds']),
      rawManager: ds.manager.query('INSERT INTO soft_notes (id, name) VALUES (?, ?)', [randomUUID(), 'shape-raw-manager']),
      withWrite: ds.query(
        "WITH src(name) AS (SELECT 'shape-with-insert') INSERT INTO soft_notes (id, name) SELECT ?, name FROM src",
        [randomUUID()],
      ),
    };
    const states = Object.fromEntries(Object.entries(writes).map(([k, p]) => [k, track(p)]));
    await sleep(30);
    const ranInside = Object.entries(states).filter(([, s]) => s.settled).map(([k]) => k);
    assert.deepEqual(ranInside, [], 'no write may run while the transaction is open');

    held.release();
    assert.match((await held.done)?.message || '', /rolled back on purpose/);
    await Promise.all(Object.values(writes));

    assert.deepEqual(await accountNames(ds, 'shape-'), ['shape-increment', 'shape-insert', 'shape-save', 'shape-update', 'shape-upsert']);
    const byName = async (name) => accounts.findOneByOrFail({ name });
    assert.equal((await byName('shape-update')).description, 'updated');
    assert.equal((await byName('shape-increment')).max_concurrent_tickets_per_agent, 5);
    const liveNotes = (await notes.find()).map((n) => n.name).sort();
    assert.deepEqual(liveNotes, ['shape-qb', 'shape-raw-ds', 'shape-raw-manager', 'shape-recover', 'shape-with-insert']);
    const softRemoved = await notes.findOne({ where: { name: 'shape-soft-remove' }, withDeleted: true });
    assert.ok(softRemoved?.deleted_at, 'the soft remove survived the rollback');
  });

  it('reads do not wait for the open transaction; a WITH that only reads does not either', async () => {
    const ds = await openDataSource();
    const held = await openHeldTransaction(ds, 'reads');
    try {
      const found = await withinDeadlockTimeout(ds.getRepository(Account).findBy({ name: 'reads-txn' }));
      assert.equal(found.length, 1, 'a read runs at once — it even sees the open transaction\'s uncommitted row (no isolation on sql.js)');
      const [{ n }] = await withinDeadlockTimeout(ds.query("WITH src AS (SELECT name FROM accounts WHERE name LIKE 'reads-%') SELECT count(*) AS n FROM src"));
      assert.equal(n, 1);
    } finally {
      held.release();
      await held.done;
    }
  });

  it('same chain: root-repository writes, raw writes and nested transactions inside a callback run at once as part of it', async () => {
    const ds = await openDataSource();
    const outcome = await withinDeadlockTimeout(ds.transaction(async () => {
      const accounts = ds.getRepository(Account);
      await accounts.save(accounts.create({ name: 'chain-root-save', description: 'x' }));
      await ds.query('INSERT INTO soft_notes (id, name) VALUES (?, ?)', [randomUUID(), 'chain-raw']);
      await ds.transaction(async (inner) => {
        await inner.getRepository(Account).save(inner.getRepository(Account).create({ name: 'chain-nested', description: 'x' }));
      });
      throw new Error('chain: rolled back on purpose');
    }).then(() => 'committed', (e) => e.message));
    assert.match(outcome, /chain: rolled back on purpose/);
    assert.deepEqual(await accountNames(ds, 'chain-'), [], 'writes made by the transaction\'s own chain roll back with it');
    assert.equal(await ds.getRepository(SoftNote).countBy({ name: 'chain-raw' }), 0);
  });

  // 루트 repository 와, 트랜잭션 콜백이 받은 manager(createQueryRunner() 가 만든 것) 둘 다.
  for (const via of ['root repository', 'transaction manager']) {
    it(`a save started inside a transaction but finishing after its COMMIT keeps the turn (${via}): the next transaction does not swallow it`, async () => {
      const ds = await openDataSource();
      const inside = gate();
      const release = gate();
      ds.subscribers.push({
        listenTo: () => Account,
        async beforeInsert(event) {
          if (event.entity?.name !== 'tail-fire-and-forget') return;
          inside.open();
          await release.wait;
        },
      });
      let tail;
      await ds.transaction(async (manager) => {
        await manager.getRepository(Account).save(manager.getRepository(Account).create({ name: 'tail-first', description: 'x' }));
        const accounts = via === 'root repository' ? ds.getRepository(Account) : manager.getRepository(Account);
        tail = accounts.save(accounts.create({ name: 'tail-fire-and-forget', description: 'x' })); // await 하지 않는다
      });
      await inside.wait;

      let secondStarted = false;
      const second = ds.transaction(async (manager) => {
        secondStarted = true;
        await manager.getRepository(Account).save(manager.getRepository(Account).create({ name: 'tail-second', description: 'x' }));
        throw new Error('tail: second rolled back on purpose');
      }).then(() => null, (e) => e);
      await sleep(30);
      assert.equal(secondStarted, false, 'the next transaction waits while a save started in the previous turn is still running');

      release.open();
      await tail;
      assert.match((await second)?.message || '', /second rolled back on purpose/);
      assert.deepEqual(await accountNames(ds, 'tail-'), ['tail-fire-and-forget', 'tail-first']);
    });
  }

  it('a write queued between two transactions runs after the first and before the second (FIFO)', async () => {
    const ds = await openDataSource();
    const log = [];
    ds.subscribers.push({ afterQuery: (event) => log.push(event.query) });
    const accounts = ds.getRepository(Account);
    await accounts.save(accounts.create({ name: 'fifo-row', description: 'before' }));
    const held = await openHeldTransaction(ds, 'fifo'); // 롤백한다 — 그 안에 섞인 쓰기라면 함께 사라진다
    const write = accounts.update({ name: 'fifo-row' }, { description: 'written-between' });
    // update() 는 문장을 만드는 사이 몇 번 await 한다 — 문장은 보낼 때 줄을 선다. 그 문장이 줄에 선 뒤에 다음 트랜잭션을 부른다.
    await sleep(10);
    const second = ds.transaction(async (manager) => (await manager.getRepository(Account).findOneByOrFail({ name: 'fifo-row' })).description);
    held.release();
    assert.match((await held.done)?.message || '', /rolled back on purpose/);
    await write;
    assert.equal(await second, 'written-between', 'the write ran after the first transaction rolled back, and before the second');
    const rollbackAt = log.findIndex((q) => /^ROLLBACK/i.test(q));
    const updateAt = log.findIndex((q, i) => i > rollbackAt && /^UPDATE "accounts"/i.test(q));
    const beginAt = log.findIndex((q, i) => i > rollbackAt && /^BEGIN/i.test(q));
    assert.ok(rollbackAt >= 0 && updateAt > rollbackAt && beginAt > updateAt, `order: rollback #${rollbackAt}, update #${updateAt}, next begin #${beginAt}`);
  });

  it('statement classification errs toward writes: a read naming a write keyword, or led by a comment, only waits', async () => {
    const ds = await openDataSource();
    const held = await openHeldTransaction(ds, 'classify', { fail: false });
    const keywordRead = ds.query("WITH src AS (SELECT 'update' AS w) SELECT w FROM src");
    const commentRead = ds.query('/* note */ SELECT 1 AS one');
    const states = [track(keywordRead), track(commentRead)];
    await sleep(30);
    assert.deepEqual(states.map((st) => st.settled), [false, false], 'classified as writes: they wait for the open transaction');
    held.release();
    assert.equal(await held.done, 'committed');
    assert.deepEqual(await keywordRead, [{ w: 'update' }]);
    assert.deepEqual(await commentRead, [{ one: 1 }]);
  });

  it('a transaction opened outside the queue is refused', async () => {
    const ds = await openDataSource();
    const refused = /dataSource\.transaction\(\)/;
    await assert.rejects(ds.createQueryRunner().startTransaction(), refused);
    await assert.rejects(
      ds.createQueryBuilder().insert().into(SoftNote).values({ id: randomUUID(), name: 'refused-qb' }).useTransaction(true).execute(),
      refused,
    );
    assert.equal(await ds.getRepository(SoftNote).countBy({ name: 'refused-qb' }), 0);
    // 거부가 큐를 막지 않는다.
    assert.equal(await withinDeadlockTimeout(ds.transaction(async () => 'still works')), 'still works');
  });

  it('schema work runs its transaction inside the queue: initialize() after serializing, synchronize() during a transaction', async () => {
    const ds = new DataSource(dataSourceOptions());
    opened.push(ds);
    serializeSqljsTransactions(ds); // AppDataSource 모양 — 큐를 먼저 걸고 initialize() 한다
    await withinDeadlockTimeout(ds.initialize());

    const held = await openHeldTransaction(ds, 'schema');
    const sync = ds.synchronize();
    const state = track(sync);
    await sleep(30);
    assert.equal(state.settled, false, 'synchronize() opens its own transaction, so it waits for the open one');
    held.release();
    await held.done;
    await withinDeadlockTimeout(sync);
  });

  it('the ontology DataSource takes the same path', async () => {
    await AppOntologyDataSource.initialize();
    const node = (name) => AppOntologyDataSource.getRepository(OntologyNode).create({
      account_id: 'queue-writes',
      graph_id: 'queue-writes',
      symbol_id: `sym-${name}`,
      type: 'Callable',
      layer: 'structural',
      name,
      confidence: 1.0,
    });
    const inside = gate();
    const release = gate();
    const txn = AppOntologyDataSource.transaction(async (manager) => {
      await manager.getRepository(OntologyNode).save(node('fn_txn'));
      inside.open();
      await release.wait;
      throw new Error('ontology: rolled back on purpose');
    }).then(() => null, (e) => e);
    await inside.wait;
    const save = AppOntologyDataSource.getRepository(OntologyNode).save(node('fn_unrelated'));
    const state = track(save);
    await sleep(30);
    assert.equal(state.settled, false);
    release.open();
    assert.match((await txn)?.message || '', /ontology: rolled back on purpose/);
    await save;
    const names = (await AppOntologyDataSource.getRepository(OntologyNode).findBy({ graph_id: 'queue-writes' })).map((n) => n.name);
    assert.deepEqual(names, ['fn_unrelated']);
  });

  it('static guard: a non-sqljs DataSource is left untouched, and serializing twice equals serializing once', async () => {
    const methods = {
      transaction: async () => 'unpatched',
      save: async () => 'unpatched',
    };
    const createEntityManager = () => ({});
    const synchronize = async () => 'unpatched';
    const createQueryRunner = () => ({});
    const fakePostgres = {
      options: { type: 'postgres' },
      manager: { ...methods },
      createEntityManager,
      synchronize,
      driver: { createQueryRunner },
    };
    serializeSqljsTransactions(fakePostgres);
    assert.equal(fakePostgres.manager.transaction, methods.transaction);
    assert.equal(fakePostgres.manager.save, methods.save);
    assert.equal(fakePostgres.createEntityManager, createEntityManager);
    assert.equal(fakePostgres.synchronize, synchronize);
    assert.equal(fakePostgres.driver.createQueryRunner, createQueryRunner);

    const ds = await openDataSource();
    const patched = {
      transaction: ds.manager.transaction,
      save: ds.manager.save,
      synchronize: ds.synchronize,
      createEntityManager: ds.createEntityManager,
      query: ds.createQueryRunner().query,
    };
    serializeSqljsTransactions(ds);
    assert.equal(ds.manager.transaction, patched.transaction);
    assert.equal(ds.manager.save, patched.save);
    assert.equal(ds.synchronize, patched.synchronize);
    assert.equal(ds.createEntityManager, patched.createEntityManager);
    assert.equal(ds.createQueryRunner().query, patched.query);
  });
});

// TypeORM/sql.js 는 이벤트 루프를 붙잡아 두는 핸들을 남긴다. 이 스위트는 `--test-force-exit` 로 실행돼
// 그런 핸들을 정리하고 node:test 가 계산한 실제 종료 코드로 끝난다 — 수동 process.exit() 은 그 코드를 덮어써
// 실패한 assertion 을 가릴 수 있으므로 쓰지 않는다.
