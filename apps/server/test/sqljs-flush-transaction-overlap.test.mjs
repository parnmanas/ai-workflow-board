// 회귀 테스트 — ticket d1ce6aad
// "sql.js 주기 flush 가 진행 중인 트랜잭션을 끊을 수 있음 (doSqljsExport 직렬화)"
//
// 배경: sql.js 의 Database.export() 는 연결을 닫았다가 다시 연다. 그 순간 열려 있던 트랜잭션은 SQLite 가
// 롤백하고, 그 트랜잭션의 남은 쓰기는 다시 열린 연결에서 autocommit 되며, COMMIT 은 "cannot commit - no
// transaction is active" 로 실패하고, TypeORM 의 공유 runner 는 isTransactionActive=true 로 굳는다. 주기
// flush(SqljsFlushService)와 종료 flush 가 이 export 를 트랜잭션과 무관하게 불렀다.
//
// 이 스위트가 증명하는 것:
//   1. 전제 — flush 를 거치지 않은 직접 export 는 지금도 트랜잭션을 끊는다(위 증상 넷). saveDatabase() 는
//      부른 그 동기 구간에서 export 한다(확인과 export 사이에 아무것도 끼지 않는 근거). typeorm/sql.js 가
//      바뀌어 이 전제들이 사라지면 이 스위트가 먼저 알려 준다. repo.save() 의 암묵 트랜잭션은 이제 큐를 탄다
//      (ticket 13f5b0f6) — 큐 차례만으로도 export 가 save 안에 끼지 않는다.
//   2. 주기 flush 는 열린 트랜잭션이 끝난 뒤에 쓴다 — 커밋되면 두 쓰기 모두, 롤백되면 하나도 남지 않는다.
//   3. 종료(강제) flush 도 마찬가지이고, 부르기 전에 큐에 선 트랜잭션까지 담는다.
//   4. repo.save() 의 암묵 트랜잭션도 끊지 않는다 — microtask 오프셋 전수와, 매크로태스크를 넘겨 열려 있는
//      트랜잭션(느린 subscriber) 둘 다. save 는 이제 큐 차례를 쥐므로 flush 는 그 차례를 기다린다. 큐 밖에서 열린
//      트랜잭션(raw BEGIN)은 SQLite 에 물어 닫힐 때까지 기다린다.
//   5. TypeORM runner 플래그가 끊긴 트랜잭션 때문에 true 로 굳어 있어도 flush 는 계속 쓴다(SQLite 에 묻는다).
//   6. 재진입 — 트랜잭션 안의 afterSqljsTransactions(), 그 work 안의 transaction() 은 데드락 없이 돈다.
//      트랜잭션 안에서 기다린 flush 는 자기 호출자를 끊지 않고 제한 시간 뒤 실패하며, 다음 flush 가 쓴다.
//      그 트랜잭션 뒤에 주기 flush 가 줄 서 있어도 마찬가지다 — 강제 flush 가 그것을 기다리면 서로를
//      기다려 큐 전체가 멈춘다.
//   7. export 는 파일 쓰기 전에 차례를 넘긴다 — 쓰기 · 트랜잭션이 디스크 I/O 를 기다리지 않는다. 파일 쓰기는 한
//      번에 하나다(겹친 fs.writeFile 은 파일을 섞는다) — 한 차례 안에서 함께 시작한 강제 flush 둘도 마찬가지다.
//   8. 온톨로지 DataSource 의 flush 도 같은 경로를 탄다.
//
// 컴파일된 dist/ 를 대상으로 실행한다(`npm run build` 필요, test 스크립트가 보장). 공유 dev database/ 의
// 파일을 건드리지 않도록 모든 sql.js 파일을 임시 디렉터리에 둔다.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-sqljs-flush-overlap-'));
const PRIMARY_FILE = path.join(tmpDir, 'primary.db');
const ONTOLOGY_FILE = path.join(tmpDir, 'ontology.db');
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = PRIMARY_FILE;
process.env.SQLJS_ONTOLOGY_DB_PATH = ONTOLOGY_FILE;
process.env.NODE_ENV = 'test';

const {
  buildDataSourceOptions,
  serializeSqljsTransactions,
  afterSqljsTransactions,
  flushSqljs,
  isSqljsDirty,
  SQLJS_EXPORT_TXN_WAIT_MS,
  AppOntologyDataSource,
  flushOntologySqljs,
  isOntologySqljsDirty,
} = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { Account } = await import('file://' + path.join(DIST_ROOT, 'entities', 'Account.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities', 'OntologyNode.js'));
const { DataSource } = await import('typeorm');
const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs();

const CUT_COMMIT = /cannot commit - no transaction is active/;

/** NestJS DatabaseModule 과 같은 모양 — 초기화한 뒤 트랜잭션 큐를 건다. */
async function openDataSource(location, { serialize = true } = {}) {
  const ds = new DataSource({ ...buildDataSourceOptions(), location });
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

/** 디스크에 실제로 무엇이 있는가 — TypeORM 을 거치지 않고 파일을 sql.js 로 직접 연다. */
function namesOnDisk(file, table, prefix) {
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    const res = db.exec(`SELECT name FROM ${table} WHERE name LIKE '${prefix}%' ORDER BY name`);
    return res.length ? res[0].values.map(([name]) => name) : [];
  } finally {
    db.close();
  }
}

async function namesInMemory(ds, prefix) {
  return (await ds.getRepository(Account).find()).map((a) => a.name).filter((n) => n.startsWith(prefix)).sort();
}

/** 쓰고 → 열린 채로 멈추고(gate) → 또 쓰는 트랜잭션 콜백. 멈춘 사이에 export 가 끼어들 자리다. */
function writeTwiceAcrossGate(tag, { inside, release, fail = false }) {
  return async (manager) => {
    const repo = manager.getRepository(Account);
    await repo.save(repo.create({ name: `${tag}-a`, description: 'flush-overlap' }));
    inside.open();
    await release.wait;
    await repo.save(repo.create({ name: `${tag}-b`, description: 'flush-overlap' }));
    if (fail) throw new Error(`${tag}: rolled back on purpose`);
  };
}

/** 이름이 `name` 인 행의 INSERT 직전(암묵 트랜잭션의 BEGIN 뒤)에서 멈추는 subscriber 를 단다. */
function holdInsertOf(ds, target, name) {
  const inside = gate();
  const release = gate();
  const subscriber = {
    listenTo: () => target,
    async beforeInsert(event) {
      if (event.entity?.name !== name) return;
      inside.open();
      await release.wait;
    },
  };
  ds.subscribers.push(subscriber);
  return {
    inside,
    release,
    remove: () => ds.subscribers.splice(ds.subscribers.indexOf(subscriber), 1),
  };
}

function sqliteTransactionOpen(ds) {
  const conn = ds.driver.databaseConnection;
  try {
    conn.exec('BEGIN');
  } catch (e) {
    if (/cannot start a transaction within a transaction/.test(e.message)) return true;
    throw e;
  }
  conn.exec('ROLLBACK');
  return false;
}

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
 * 트랜잭션이 열린 사이 주기 flush 를 걸고(그 export 는 트랜잭션 뒤에 줄 선다) 트랜잭션 안에서 강제 flush 를
 * 기다린다. 강제 flush 가 줄 선 flush 를 기다리면 셋이 서로를 기다린다 — 'deadlock' 이 그 신호다.
 */
async function forcedFlushInsideTxnWithPeriodicQueued({ ds, flush, isDirty, saveRow }) {
  const inside = gate();
  const release = gate();
  const txn = ds.transaction(async (manager) => {
    await saveRow(manager);
    inside.open();
    await release.wait;
    return withinDeadlockTimeout(flush(ds, true)).then(() => 'exported', (e) => e.message);
  });
  await inside.wait;
  assert.equal(isDirty(), true, 'sanity: the DB is dirty, so the periodic flush starts an export instead of returning early');
  const periodic = flush(ds);
  release.open();
  return { outcome: await withinDeadlockTimeout(txn), periodic: await withinDeadlockTimeout(periodic) };
}

// 제한 시간은 각 테스트가 물려받는다. 회귀하면 끝나지 않는 트랜잭션이 큐를 영영 쥐어 뒤 테스트가 멈추므로
// (main 의 재진입 데드락이 그랬다) 매달리지 않고 실패하게 한다.
describe('sql.js flush vs open transactions (ticket d1ce6aad)', { timeout: 60_000 }, () => {
  let live; // 서버와 같은 구성 — 큐가 걸린 primary DataSource, 파일은 PRIMARY_FILE

  before(async () => {
    live = await openDataSource(PRIMARY_FILE);
    await flushSqljs(live, true);
  });

  after(async () => {
    if (live?.isInitialized) await live.destroy();
    if (AppOntologyDataSource?.isInitialized) await AppOntologyDataSource.destroy();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('premise: a direct export in the middle of a transaction rolls back its first write, autocommits the second, fails COMMIT and wedges the runner', async () => {
    const raw = await openDataSource(path.join(tmpDir, 'premise-direct.db'), { serialize: false });
    try {
      const inside = gate();
      const release = gate();
      const txn = raw.transaction(writeTwiceAcrossGate('premise', { inside, release })).then(() => null, (e) => e);
      await inside.wait;
      await raw.sqljsManager.saveDatabase();
      release.open();
      const error = await txn;
      assert.match(
        error?.message || '',
        CUT_COMMIT,
        'if the export no longer ends an open transaction, re-evaluate exportSqljsWhenIdle() in db.ts',
      );
      assert.deepEqual(
        await namesInMemory(raw, 'premise-'),
        ['premise-b'],
        'the cut transaction must have lost its first write and kept its second — atomicity broken',
      );
      assert.equal(raw.driver.queryRunner.isTransactionActive, true, 'TypeORM still believes the transaction is open');
      assert.equal(sqliteTransactionOpen(raw), false, '…while SQLite has none — the flag is stale from here on');
    } finally {
      await raw.destroy();
    }
  });

  it('queue order alone now covers repo.save(): an export in the queue never lands inside its implicit transaction (ticket 13f5b0f6)', async () => {
    const queued = await openDataSource(path.join(tmpDir, 'queue-covers-save.db'));
    try {
      const repo = queued.getRepository(Account);
      const failures = [];
      const OFFSETS = 150; // 한 save 가 끝나기까지의 microtask 수보다 넉넉히 — 열린 구간 전체를 지나간다
      for (let offset = 0; offset < OFFSETS; offset++) {
        const save = repo.save(repo.create({ name: `queue-only-${offset}`, description: 'flush-overlap' })).then(() => null, (e) => e);
        for (let i = 0; i < offset; i++) await Promise.resolve();
        await afterSqljsTransactions(queued, () => queued.sqljsManager.saveDatabase());
        const error = await save;
        if (error) failures.push(`offset ${offset}: ${error.message}`);
      }
      assert.deepEqual(
        failures,
        [],
        'the save takes a turn in the same queue, so an export behind afterSqljsTransactions() cannot land inside it — ' +
          'before ticket 13f5b0f6 one of these offsets failed with "cannot commit - no transaction is active"',
      );
      assert.equal((await namesInMemory(queued, 'queue-only-')).length, OFFSETS);
    } finally {
      await queued.destroy();
    }
  });

  it('premise: saveDatabase() exports in the same synchronous step it is called in', async () => {
    const conn = live.driver.databaseConnection;
    let exported = false;
    conn.export = function exportSpy(...args) {
      exported = true;
      return Object.getPrototypeOf(this).export.apply(this, args);
    };
    try {
      const saving = live.sqljsManager.saveDatabase();
      assert.equal(
        exported,
        true,
        'exportSqljsWhenIdle() checks for an open transaction and exports in one synchronous step — if TypeORM ' +
          'now awaits before export(), a transaction can open in between and be cut',
      );
      await saving;
    } finally {
      delete conn.export;
    }
  });

  it('periodic flush during an open transaction waits for its COMMIT and writes both rows', async () => {
    const inside = gate();
    const release = gate();
    const txn = live.transaction(writeTwiceAcrossGate('periodic', { inside, release }));
    await inside.wait;
    assert.equal(isSqljsDirty(), true, 'sanity: the DB is dirty, so the periodic flush exports rather than returning early');

    const flush = flushSqljs(live);
    const flushState = track(flush);
    await sleep(30);
    assert.equal(flushState.settled, false, 'the flush must not export while the transaction is open');

    release.open();
    await txn; // a cut transaction rejects here with "cannot commit - no transaction is active"
    assert.equal(await flush, true, 'the flush exports once the transaction is done');
    assert.deepEqual(namesOnDisk(PRIMARY_FILE, 'accounts', 'periodic-'), ['periodic-a', 'periodic-b']);
    assert.equal(live.driver.queryRunner.isTransactionActive, false, 'the shared runner is not left wedged');
  });

  it('periodic flush during a transaction that rolls back writes neither of its rows', async () => {
    const repo = live.getRepository(Account);
    await repo.save(repo.create({ name: 'rollback-before', description: 'flush-overlap' }));

    const inside = gate();
    const release = gate();
    const txn = live.transaction(writeTwiceAcrossGate('rollback', { inside, release, fail: true }));
    await inside.wait;
    const flush = flushSqljs(live);
    await sleep(30);
    release.open();

    await assert.rejects(txn, /rolled back on purpose/, 'the caller sees its own error, not a failed COMMIT');
    assert.equal(await flush, true);
    assert.deepEqual(
      await namesInMemory(live, 'rollback-'),
      ['rollback-before'],
      'the rolled-back transaction leaves nothing behind — a cut one would have autocommitted rollback-b',
    );
    await flushSqljs(live, true);
    assert.deepEqual(namesOnDisk(PRIMARY_FILE, 'accounts', 'rollback-'), ['rollback-before']);
  });

  it('forced (shutdown) flush waits for the open transaction and for those queued before it was called', async () => {
    const inside = gate();
    const release = gate();
    const first = live.transaction(writeTwiceAcrossGate('shutdown-1', { inside, release }));
    await inside.wait;
    const second = live.transaction(async (manager) => {
      const repo = manager.getRepository(Account);
      await repo.save(repo.create({ name: 'shutdown-2', description: 'flush-overlap' }));
    });

    const forced = flushSqljs(live, true);
    const forcedState = track(forced);
    await sleep(30);
    assert.equal(forcedState.settled, false);

    release.open();
    await Promise.all([first, second]);
    assert.equal(await forced, true);
    assert.deepEqual(
      namesOnDisk(PRIMARY_FILE, 'accounts', 'shutdown-'),
      ['shutdown-1-a', 'shutdown-1-b', 'shutdown-2'],
      'the final flush must include every transaction that was already queued when shutdown began',
    );
  });

  it('flush never cuts the implicit transaction of a concurrent repo.save(), at any microtask offset', async () => {
    const repo = live.getRepository(Account);
    const failures = [];
    const OFFSETS = 150; // 한 save 가 끝나기까지의 microtask 수보다 넉넉히 — 열린 구간 전체를 지나간다
    for (let offset = 0; offset < OFFSETS; offset++) {
      const save = repo.save(repo.create({ name: `sweep-${offset}`, description: 'flush-overlap' })).then(() => null, (e) => e);
      for (let i = 0; i < offset; i++) await Promise.resolve();
      const [error] = await Promise.all([save, flushSqljs(live, true)]);
      if (error) failures.push(`offset ${offset}: ${error.message}`);
    }
    assert.deepEqual(failures, [], 'no save may fail because a flush ended its transaction');
    assert.equal(live.driver.queryRunner.isTransactionActive, false);

    await flushSqljs(live, true);
    assert.equal(namesOnDisk(PRIMARY_FILE, 'accounts', 'sweep-').length, OFFSETS, 'every saved row reaches the file');
  });

  it('flush waits for an implicit save transaction that stays open across macrotasks', async () => {
    const held = holdInsertOf(live, Account, 'held-save');
    try {
      const repo = live.getRepository(Account);
      const save = repo.save(repo.create({ name: 'held-save', description: 'flush-overlap' }));
      await held.inside.wait;
      assert.equal(sqliteTransactionOpen(live), true, 'sanity: the save has BEGUN and is paused before its INSERT');

      const flush = flushSqljs(live, true);
      const flushState = track(flush);
      await sleep(30);
      assert.equal(flushState.settled, false, 'the flush waits for the save\'s queue turn instead of exporting into the open save');

      held.release.open();
      await save;
      assert.equal(await flush, true);
      assert.deepEqual(namesOnDisk(PRIMARY_FILE, 'accounts', 'held-save'), ['held-save']);
    } finally {
      held.remove();
    }
  });

  it('a transaction opened outside the queue (raw BEGIN) is waited out by asking SQLite, not cut', async () => {
    const conn = live.driver.databaseConnection;
    conn.exec('BEGIN');
    conn.exec("INSERT INTO accounts (id, name, description) VALUES ('raw-begin-id', 'raw-begin', 'flush-overlap')");
    const flush = flushSqljs(live, true);
    const flushState = track(flush);
    await sleep(30);
    assert.equal(flushState.settled, false, 'the export polls while SQLite reports an open transaction the queue does not know');
    conn.exec('COMMIT');
    assert.equal(await flush, true);
    assert.deepEqual(namesOnDisk(PRIMARY_FILE, 'accounts', 'raw-begin'), ['raw-begin']);
  });

  it('a runner flag left stuck by a cut transaction does not block later flushes', async () => {
    const stale = await openDataSource(path.join(tmpDir, 'stale-flag.db'));
    try {
      // 이 버그가 남기던 상태를 그대로 만든다: 직접 export 로 트랜잭션을 끊어 플래그를 굳힌다.
      const inside = gate();
      const release = gate();
      const txn = stale.transaction(writeTwiceAcrossGate('stale', { inside, release })).then(() => null, (e) => e);
      await inside.wait;
      await stale.sqljsManager.saveDatabase();
      release.open();
      assert.match((await txn)?.message || '', CUT_COMMIT);
      assert.equal(stale.driver.queryRunner.isTransactionActive, true, 'sanity: the flag is stuck');

      const repo = stale.getRepository(Account);
      await repo.save(repo.create({ name: 'stale-after', description: 'flush-overlap' }));
      const started = Date.now();
      assert.equal(await flushSqljs(stale, true), true);
      assert.ok(
        Date.now() - started < SQLJS_EXPORT_TXN_WAIT_MS,
        'SQLite has no transaction open, so the export must not wait out the deadline on the stale flag',
      );
      assert.deepEqual(namesOnDisk(path.join(tmpDir, 'stale-flag.db'), 'accounts', 'stale-'), ['stale-after', 'stale-b']);
    } finally {
      await stale.destroy();
    }
  });

  it('reentrancy: afterSqljsTransactions() inside a transaction, and transaction() inside its work, run in the turn already held', async () => {
    const order = [];
    const fromTxn = await withinDeadlockTimeout(live.transaction(async () => {
      order.push('txn');
      await afterSqljsTransactions(live, async () => { order.push('work inside txn'); });
      return 'txn done';
    }));
    const fromWork = await withinDeadlockTimeout(afterSqljsTransactions(live, async () => {
      order.push('work');
      await live.transaction(async (manager) => {
        order.push('txn inside work');
        const repo = manager.getRepository(Account);
        await repo.save(repo.create({ name: 'reentry-txn-in-work', description: 'flush-overlap' }));
      });
      return 'work done';
    }));
    assert.deepEqual([fromTxn, fromWork], ['txn done', 'work done']);
    assert.deepEqual(order, ['txn', 'work inside txn', 'work', 'txn inside work']);
    assert.deepEqual(await namesInMemory(live, 'reentry-'), ['reentry-txn-in-work']);
  });

  it('a flush awaited inside a transaction fails after the deadline without cutting its caller; the next flush writes', async () => {
    const outcome = await live.transaction(async (manager) => {
      const repo = manager.getRepository(Account);
      await repo.save(repo.create({ name: 'self-flush', description: 'flush-overlap' }));
      return flushSqljs(live, true).then(() => 'exported', (e) => e.message);
    });
    assert.match(outcome, /sql\.js export skipped: a transaction has been open/);
    assert.equal(isSqljsDirty(), true, 'the skipped export leaves the DB dirty for the next flush');
    assert.deepEqual(await namesInMemory(live, 'self-flush'), ['self-flush'], 'the calling transaction committed');

    assert.equal(await flushSqljs(live), true);
    assert.deepEqual(namesOnDisk(PRIMARY_FILE, 'accounts', 'self-flush'), ['self-flush']);
  });

  it('a forced flush inside a transaction does not wait for the periodic flush queued behind that transaction', async () => {
    const { outcome, periodic } = await forcedFlushInsideTxnWithPeriodicQueued({
      ds: live,
      flush: flushSqljs,
      isDirty: isSqljsDirty,
      saveRow: (manager) => manager.getRepository(Account).save(
        manager.getRepository(Account).create({ name: 'queued-behind', description: 'flush-overlap' }),
      ),
    });
    assert.match(
      outcome,
      /sql\.js export skipped: a transaction has been open/,
      'the forced flush fails after its deadline — "deadlock" means it waited for the flush queued behind its caller',
    );
    assert.equal(periodic, true, 'the queued periodic flush writes once the transaction is done');
    assert.deepEqual(namesOnDisk(PRIMARY_FILE, 'accounts', 'queued-behind'), ['queued-behind']);
  });

  it('the turn is handed on before the file write: a save completes while the export is still writing', async () => {
    const mgr = live.sqljsManager;
    const realSave = mgr.saveDatabase;
    const writing = gate();
    let exported = false;
    mgr.saveDatabase = async function heldWrite(...args) {
      const out = await realSave.apply(this, args); // export (same synchronous step) + the real file write
      exported = true;
      await writing.wait; // the file write is still going on
      return out;
    };
    try {
      const repo = live.getRepository(Account);
      await repo.save(repo.create({ name: 'handoff-before', description: 'flush-overlap' }));
      const flush = flushSqljs(live, true);
      while (!exported) await new Promise((resolve) => setImmediate(resolve));
      const saved = await withinDeadlockTimeout(repo.save(repo.create({ name: 'handoff-during', description: 'flush-overlap' })));
      assert.ok(saved.id, 'a save must not wait for the file write — the export no longer needs the connection');
      writing.open();
      assert.equal(await flush, true);
      assert.equal(isSqljsDirty(), true, 'the save that landed during the write is left for the next flush');
    } finally {
      delete mgr.saveDatabase;
    }
    await flushSqljs(live, true);
    assert.deepEqual(namesOnDisk(PRIMARY_FILE, 'accounts', 'handoff-'), ['handoff-before', 'handoff-during']);
  });

  it('exports write one at a time: an export behind a file write still in progress waits for it', async () => {
    const mgr = live.sqljsManager;
    const realSave = mgr.saveDatabase;
    const firstWrite = gate();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    mgr.saveDatabase = async function countedWrite(...args) {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const out = await realSave.apply(this, args);
        if (calls === 1) await firstWrite.wait;
        return out;
      } finally {
        active -= 1;
      }
    };
    try {
      const repo = live.getRepository(Account);
      await repo.save(repo.create({ name: 'one-write-a', description: 'flush-overlap' }));
      const periodic = flushSqljs(live);
      while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
      await repo.save(repo.create({ name: 'one-write-b', description: 'flush-overlap' }));
      // 차례를 쥔 강제 flush 는 진행 중인 flush 를 기다리지 않는다(자기 호출자 뒤에 줄 서 있을 수 있어서) — 두 파일
      // 쓰기를 떼어 놓는 것은 파일 쓰기 사슬뿐이다.
      const forced = afterSqljsTransactions(live, () => flushSqljs(live, true));
      await sleep(30);
      assert.equal(calls, 1, 'the second export waits until the first file write is done');
      firstWrite.open();
      assert.equal(await periodic, true);
      assert.equal(await forced, true);
      assert.equal(maxActive, 1, 'two fs.writeFile calls on one file must never overlap');
    } finally {
      delete mgr.saveDatabase;
    }
    assert.deepEqual(namesOnDisk(PRIMARY_FILE, 'accounts', 'one-write-'), ['one-write-a', 'one-write-b']);
  });

  it('two forced flushes started together inside one turn still write the file one at a time', async () => {
    const mgr = live.sqljsManager;
    const realSave = mgr.saveDatabase;
    const firstWrite = gate();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    mgr.saveDatabase = async function countedWrite(...args) {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const out = await realSave.apply(this, args);
        if (calls === 1) await firstWrite.wait;
        return out;
      } finally {
        active -= 1;
      }
    };
    try {
      const repo = live.getRepository(Account);
      await repo.save(repo.create({ name: 'pair-flush', description: 'flush-overlap' }));
      // 같은 차례 안의 강제 flush 는 서로의 in-flight 를 기다리지 않는다 — 파일 쓰기 사슬만 둘을 떼어 놓는다.
      const both = afterSqljsTransactions(live, () => Promise.all([flushSqljs(live, true), flushSqljs(live, true)]));
      await sleep(30);
      assert.equal(calls, 1, 'the second export waits until the first file write is done');
      firstWrite.open();
      assert.deepEqual(await both, [true, true]);
      assert.equal(maxActive, 1, 'two fs.writeFile calls on one file must never overlap');
    } finally {
      delete mgr.saveDatabase;
    }
  });

  it('ontology flush takes the same path: it waits for an open implicit save transaction', async () => {
    await AppOntologyDataSource.initialize();
    await flushOntologySqljs(AppOntologyDataSource, true);
    const held = holdInsertOf(AppOntologyDataSource, OntologyNode, 'fn_held');
    try {
      const repo = AppOntologyDataSource.getRepository(OntologyNode);
      const save = repo.save(repo.create({
        account_id: 'flush-overlap',
        graph_id: 'flush-overlap',
        symbol_id: 'sym-held',
        type: 'Callable',
        layer: 'structural',
        name: 'fn_held',
        confidence: 1.0,
      }));
      await held.inside.wait;

      const flush = flushOntologySqljs(AppOntologyDataSource, true);
      const flushState = track(flush);
      await sleep(30);
      assert.equal(flushState.settled, false, 'the ontology flush must not export into the open save');

      held.release.open();
      await save;
      assert.equal(await flush, true);
      assert.deepEqual(namesOnDisk(ONTOLOGY_FILE, 'ontology_nodes', 'fn_held'), ['fn_held']);
    } finally {
      held.remove();
    }
  });

  it('ontology: a forced flush inside a transaction does not wait for the periodic flush queued behind it either', async () => {
    if (!AppOntologyDataSource.isInitialized) await AppOntologyDataSource.initialize();
    const { outcome, periodic } = await forcedFlushInsideTxnWithPeriodicQueued({
      ds: AppOntologyDataSource,
      flush: flushOntologySqljs,
      isDirty: isOntologySqljsDirty,
      saveRow: (manager) => manager.getRepository(OntologyNode).save(manager.getRepository(OntologyNode).create({
        account_id: 'flush-overlap',
        graph_id: 'flush-overlap',
        symbol_id: 'sym-queued',
        type: 'Callable',
        layer: 'structural',
        name: 'fn_queued',
        confidence: 1.0,
      })),
    });
    assert.match(outcome, /sql\.js export skipped: a transaction has been open/);
    assert.equal(periodic, true);
    assert.deepEqual(namesOnDisk(ONTOLOGY_FILE, 'ontology_nodes', 'fn_queued'), ['fn_queued']);
  });
});

// TypeORM/sql.js 는 이벤트 루프를 붙잡아 두는 핸들을 남긴다. 이 스위트는 `--test-force-exit` 로 실행돼
// 그런 핸들을 정리하고 node:test 가 계산한 실제 종료 코드로 끝난다 — 수동 process.exit() 은 그 코드를 덮어써
// 실패한 assertion 을 가릴 수 있으므로 쓰지 않는다.
