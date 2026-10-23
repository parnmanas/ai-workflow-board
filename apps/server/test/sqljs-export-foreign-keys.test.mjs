// 회귀 테스트 — ticket 7e8b1d0c
// "sql.js export 뒤 PRAGMA foreign_keys 가 꺼진다 — 첫 flush 이후 FK 검사가 사라짐"
//
// 배경: TypeORM sqljs 드라이버는 연결을 열 때 한 번만 `PRAGMA foreign_keys = ON` 을 건다
// (SqljsDriver.createDatabaseConnectionWithImport). sql.js 의 Database.export() 는 연결을 닫았다가 다시 열고, 다시 연
// 연결은 모든 PRAGMA 가 기본값이다 — foreign_keys 는 OFF 다. 그래서 첫 flush(기본 30초) 뒤로는 프로세스가 끝날 때까지
// FK 를 검사하지 않았다. FK 를 어기는 쓰기가 조용히 통과했고, ON DELETE CASCADE 도 돌지 않아 고아 행이 남았다.
// sql.js 에서 초록인 테스트가 Postgres 에서 실패할 수 있었고, 결과가 앞선 flush 가 있었는지에 따라 달라졌다.
//
// 이 스위트가 증명하는 것:
//   1. 전제 — flush 를 거치지 않은 직접 export 는 지금도 foreign_keys 를 끈다. sql.js/TypeORM 이 바뀌어 이 전제가
//      사라지면 이 스위트가 먼저 알려 준다. export 와 되돌리기가 같은 동기 구간이라는 전제는
//      sqljs-flush-transaction-overlap.test.mjs 가 고정한다(saveDatabase() 는 부른 그 구간에서 export 한다).
//   2. 강제 · 주기 flush 뒤에도 foreign_keys 는 1 이다 — 연달아 flush 해도. export 바로 뒤 차례의 쓰기부터 FK 를
//      검사한다(그 쓰기는 파일 쓰기를 기다리지 않는다). FK 를 어기는 INSERT 는 실패하고, 부모를 지우면 ON DELETE
//      CASCADE 가 자식을 지운다(Postgres 와 같다).
//   3. 온톨로지 DataSource 의 flush 도 같다.
//   4. 제 차례를 기다린 export 는 FK 를 다시 켠다 — afterMigration 전에 던진 마이그레이션이 꺼 둔 것도. 호출자가 이미
//      쥔 차례 안의 export 는 찾은 값을 되돌린다 — 그 차례가 foreign_keys = OFF 구간일 수 있다.
//   5. 마이그레이션의 foreign_keys = OFF 구간(beforeMigration … afterMigration)과 겹치지 않는다 — afterMigration 직전,
//      커밋이 끝나 열린 트랜잭션이 없는 순간에 건 flush 도 runMigrations 의 차례가 끝날 때까지 export 하지 않는다.
//      2 의 "바로 다음 차례" 테스트와 겹쳐 보여도 대신하지 않는다 — 그쪽은 차례를 넘기기 전에 FK 가 돌아오는지,
//      이쪽은 그 구간 안에서 export 하지 않는지를 고정한다(export 가 큐를 건너뛰면 이쪽만 실패한다).
//   6. 되돌리기가 실패하면 flush 는 실패로 끝나고 dirty 가 남으며, 다음 flush 가 FK 를 다시 켠다. export 자체가
//      실패했으면 그 오류를 먼저 낸다.
//
// 컴파일된 dist/ 를 대상으로 실행한다(`npm run build` 필요, test 스크립트가 보장). 공유 dev database/ 의 파일을
// 건드리지 않도록 모든 sql.js 파일을 임시 디렉터리에 둔다.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-sqljs-export-fk-'));
const PRIMARY_FILE = path.join(tmpDir, 'primary.db');
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = PRIMARY_FILE;
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const {
  buildDataSourceOptions,
  serializeSqljsTransactions,
  afterSqljsTransactions,
  flushSqljs,
  isSqljsDirty,
  AppOntologyDataSource,
  flushOntologySqljs,
} = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { Account } = await import('file://' + path.join(DIST_ROOT, 'entities', 'Account.js'));
const { Comment } = await import('file://' + path.join(DIST_ROOT, 'entities', 'Comment.js'));
const { Ticket } = await import('file://' + path.join(DIST_ROOT, 'entities', 'Ticket.js'));
const { DataSource } = await import('typeorm');
const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs();

const FK_FAILED = /FOREIGN KEY constraint failed/;

/** NestJS DatabaseModule 과 같은 모양 — 초기화한 뒤 트랜잭션 큐를 건다. */
async function openDataSource(location, extra = {}) {
  const ds = new DataSource({ ...buildDataSourceOptions(), location, ...extra });
  await ds.initialize();
  serializeSqljsTransactions(ds);
  return ds;
}

async function foreignKeys(ds) {
  return (await ds.query('PRAGMA foreign_keys'))[0].foreign_keys;
}

/** 큐를 거치지 않고 연결에 직접 묻는다 — 남이 큐 차례를 쥔 동안에도 읽을 수 있다. */
function foreignKeysNow(ds) {
  return ds.driver.databaseConnection.exec('PRAGMA foreign_keys')[0].values[0][0];
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

/** 없는 티켓을 가리키는 댓글 — comments.ticket_id → tickets.id FK 를 어긴다. */
function saveOrphanComment(ds, tag) {
  const repo = ds.getRepository(Comment);
  return repo.save(repo.create({ ticket_id: `no-such-ticket-${tag}`, author: 'export-fk', content: tag }));
}

/** 거부되면 그 오류, 통과하면 null — 단언은 정리를 마친 뒤에 한다. */
function outcomeOf(promise) {
  return promise.then(() => null, (e) => e);
}

function gate() {
  let open;
  const wait = new Promise((resolve) => { open = resolve; });
  return { wait, open };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 신호를 기다리되, 그 전에 작업이 끝나거나 매달리면 바로 실패한다(60초 제한까지 기다리지 않게). */
async function untilSignal(signal, work, what) {
  let timer;
  const stuck = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no signal in 10s`)), 10_000); });
  const ended = work.then(
    () => { throw new Error(`${what}: the work ended before the signal`); },
    (e) => { throw e; },
  );
  try {
    await Promise.race([signal, ended, stuck]);
  } finally {
    clearTimeout(timer);
  }
}

/** 디스크에 실제로 무엇이 있는가 — TypeORM 을 거치지 않고 파일을 sql.js 로 직접 연다. */
function accountNamesOnDisk(file, prefix) {
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    const res = db.exec(`SELECT name FROM accounts WHERE name LIKE '${prefix}%' ORDER BY name`);
    return res.length ? res[0].values.map(([name]) => name) : [];
  } finally {
    db.close();
  }
}

// 회귀하면 끝나지 않는 차례가 큐를 쥐어 뒤 테스트가 멈출 수 있으므로 매달리지 않고 실패하게 한다.
describe('sql.js export keeps foreign key checks (ticket 7e8b1d0c)', { timeout: 60_000 }, () => {
  let live; // 서버와 같은 구성 — 큐가 걸린 primary DataSource, 파일은 PRIMARY_FILE

  before(async () => {
    live = await openDataSource(PRIMARY_FILE);
  });

  after(async () => {
    if (live?.isInitialized) await live.destroy();
    if (AppOntologyDataSource?.isInitialized) await AppOntologyDataSource.destroy();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('premise: a direct export, not through a flush, still turns foreign key checks off', async () => {
    const raw = await openDataSource(path.join(tmpDir, 'premise.db'));
    try {
      assert.equal(await foreignKeys(raw), 1, 'TypeORM turns the checks on when it opens the connection');
      await raw.sqljsManager.saveDatabase();
      assert.equal(
        await foreignKeys(raw),
        0,
        'if Database.export() no longer resets PRAGMAs, re-evaluate the foreign_keys restore in exportSqljsWhenIdle() (db.ts)',
      );
      const orphan = await saveOrphanComment(raw, 'premise');
      assert.ok(orphan.id, '…and a write that breaks a foreign key goes through — the bug this suite guards against');
    } finally {
      await raw.destroy();
    }
  });

  it('forced flushes keep the checks on: a write that breaks a foreign key still fails, flush after flush', async () => {
    for (let round = 1; round <= 3; round++) {
      assert.equal(await flushSqljs(live, true), true);
      assert.equal(await foreignKeys(live), 1, `PRAGMA foreign_keys after flush ${round}`);
      await assert.rejects(saveOrphanComment(live, `forced-${round}`), FK_FAILED, `flush ${round}`);
    }
  });

  it('the checks are back before the turn is handed on: the write queued right behind the export already sees them', async () => {
    const mgr = live.sqljsManager;
    const realSave = mgr.saveDatabase;
    const writing = gate();
    mgr.saveDatabase = async function heldWrite(...args) {
      const out = await realSave.apply(this, args); // export (same synchronous step) + the real file write
      await writing.wait; // the file write is still going on
      return out;
    };
    try {
      const flush = flushSqljs(live, true);
      // 같은 tick 에 건다 — export 바로 다음 차례라, export 가 차례를 넘기는 즉시 돈다.
      const duringWrite = outcomeOf(saveOrphanComment(live, 'during-write'));
      await untilSignal(duringWrite, flush, 'the write queued behind the export');
      writing.open();
      assert.equal(await flush, true);
      assert.match(
        (await duringWrite)?.message ?? 'the write went through',
        FK_FAILED,
        'the export hands its turn on before the file write, so the checks must be back on by then',
      );
    } finally {
      writing.open(); // 실패해도 flush 를 매달아 두지 않는다 — 뒤 테스트의 flush 가 그것을 기다린다
      delete mgr.saveDatabase;
    }
  });

  it('a periodic flush keeps them on too, and deleting a parent cascades to its children as on Postgres', async () => {
    const tickets = live.getRepository(Ticket);
    const comments = live.getRepository(Comment);
    const ticket = await tickets.save(tickets.create({ title: 'export-fk parent' }));
    const child = await comments.save(comments.create({ ticket_id: ticket.id, author: 'export-fk', content: 'child' }));
    assert.equal(isSqljsDirty(), true, 'sanity: the DB is dirty, so the periodic flush exports rather than returning early');

    assert.equal(await flushSqljs(live), true);
    assert.equal(await foreignKeys(live), 1);
    await assert.rejects(saveOrphanComment(live, 'periodic'), FK_FAILED);

    await tickets.delete(ticket.id);
    assert.equal(
      await comments.findOneBy({ id: child.id }),
      null,
      'ON DELETE CASCADE removes the comment — with the checks off it stayed behind as an orphan',
    );
  });

  it('the ontology DataSource keeps the checks on after its flush', async () => {
    await AppOntologyDataSource.initialize();
    assert.equal(await foreignKeys(AppOntologyDataSource), 1, 'sanity: TypeORM turned them on');
    for (let round = 1; round <= 2; round++) {
      assert.equal(await flushOntologySqljs(AppOntologyDataSource, true), true);
      assert.equal(await foreignKeys(AppOntologyDataSource), 1, `PRAGMA foreign_keys after ontology flush ${round}`);
    }
  });

  it('an export inside a turn the caller holds puts back the value it found — that turn may be a foreign_keys = OFF window', async () => {
    const ds = await openDataSource(path.join(tmpDir, 'held-turn.db'));
    try {
      const inside = await afterSqljsTransactions(ds, async () => {
        await ds.query('PRAGMA foreign_keys = OFF');
        try {
          assert.equal(await flushSqljs(ds, true), true);
          return await foreignKeys(ds);
        } finally {
          await ds.query('PRAGMA foreign_keys = ON');
        }
      });
      assert.equal(inside, 0, 'the export must not turn the checks back on inside the window');
      assert.equal(await foreignKeys(ds), 1);
    } finally {
      await ds.destroy();
    }
  });

  it('an export that waited for its own turn turns the checks back on, e.g. after a migration that threw before afterMigration', async () => {
    // MigrationExecutor 는 클래스 이름 끝 13자리를 타임스탬프로 읽는다.
    class ThrowWithForeignKeysOff1760000099998 {
      async up() { throw new Error('migration failed on purpose'); }

      async down() {}
    }
    const ds = await openDataSource(path.join(tmpDir, 'failed-migration.db'), { migrations: [ThrowWithForeignKeysOff1760000099998] });
    try {
      await assert.rejects(ds.runMigrations({ transaction: 'each' }), /migration failed on purpose/);
      assert.equal(
        await foreignKeys(ds),
        0,
        'sanity: TypeORM skips afterMigration when up() throws — if it now restores the checks itself, this case is moot',
      );
      assert.equal(await flushSqljs(ds, true), true);
      assert.equal(await foreignKeys(ds), 1, 'the flush must not keep the value the failure left behind');
      await assert.rejects(saveOrphanComment(ds, 'after-failed-migration'), FK_FAILED);
    } finally {
      await ds.destroy();
    }
  });

  it("a flush called inside a migration's foreign_keys = OFF window waits for the migration's turn, then the checks are on", async () => {
    class InsertAccount1760000099999 {
      async up(queryRunner) {
        await queryRunner.query(
          "INSERT INTO accounts (id, name, description) VALUES ('export-fk-migration', 'export-fk-migration', 'export-fk')",
        );
      }

      async down() {}
    }
    const file = path.join(tmpDir, 'migration-window.db');
    const ds = await openDataSource(file, { migrations: [InsertAccount1760000099999] });
    const conn = ds.driver.databaseConnection;
    // afterMigration 의 `PRAGMA foreign_keys = ON` 직전에서 멈춘다. 커밋은 끝나 열린 트랜잭션이 없고 FK 는 꺼져 있다 —
    // 여기서 export 를 막는 것은 runMigrations 가 쥔 큐 차례뿐이다.
    const inside = gate();
    const release = gate();
    let paused = false;
    const pauseBeforeChecksOn = {
      async beforeQuery(event) {
        if (paused || event.query !== 'PRAGMA foreign_keys = ON') return;
        paused = true;
        inside.open();
        await release.wait;
      },
    };
    ds.subscribers.push(pauseBeforeChecksOn);
    let exports = 0;
    conn.export = function countedExport(...args) {
      exports += 1;
      return Object.getPrototypeOf(this).export.apply(this, args);
    };
    let migrating;
    try {
      migrating = ds.runMigrations({ transaction: 'each' }); // DatabaseModule.onModuleInit() 과 같은 모드
      await untilSignal(inside.wait, migrating, 'the migration reaching afterMigration');
      assert.equal(foreignKeysNow(ds), 0, 'sanity: beforeMigration turned the checks off');
      assert.equal(sqliteTransactionOpen(ds), false, 'sanity: the migration has committed — no transaction keeps the export out');

      const flush = flushSqljs(ds, true);
      await sleep(30);
      assert.equal(exports, 0, "no export may run inside the window — it waits for the migration's turn");
      assert.equal(foreignKeysNow(ds), 0, 'nothing turned the checks on inside the window either');

      release.open();
      assert.equal((await migrating).length, 1);
      assert.equal(await flush, true);
      assert.equal(exports, 1);
      assert.equal(await foreignKeys(ds), 1, 'afterMigration turned the checks back on, and the export behind it kept them');
      assert.deepEqual(accountNamesOnDisk(file, 'export-fk-migration'), ['export-fk-migration']);
      await assert.rejects(saveOrphanComment(ds, 'after-migration'), FK_FAILED);
    } finally {
      release.open(); // 실패해도 마이그레이션이 큐 차례를 쥔 채 남지 않게
      await migrating?.catch(() => undefined);
      ds.subscribers.splice(ds.subscribers.indexOf(pauseBeforeChecksOn), 1);
      delete conn.export;
      await ds.destroy();
    }
  });

  it('a failed restore fails the flush and leaves the batch dirty; the next flush turns the checks back on', async () => {
    const file = path.join(tmpDir, 'restore-fails.db');
    const ds = await openDataSource(file);
    const conn = ds.driver.databaseConnection;
    try {
      conn.exec = function failingRestore(sql, ...rest) {
        if (/^PRAGMA foreign_keys = /.test(sql)) throw new Error('restore failed on purpose');
        return Object.getPrototypeOf(this).exec.call(this, sql, ...rest);
      };
      const accounts = ds.getRepository(Account);
      await accounts.save(accounts.create({ name: 'export-fk-restore', description: 'export-fk' }));
      await assert.rejects(
        flushSqljs(ds, true),
        /restore failed on purpose/,
        'a flush that leaves the checks off must not report success',
      );
      assert.equal(isSqljsDirty(), true, 'the batch stays dirty so the next flush runs again');
      assert.deepEqual(accountNamesOnDisk(file, 'export-fk-restore'), ['export-fk-restore'], 'the file write itself went through');

      conn.export = function failingExport() { throw new Error('export failed on purpose'); };
      await assert.rejects(
        flushSqljs(ds, true),
        /export failed on purpose/,
        "when the export fails, its own error is reported rather than the restore's",
      );

      delete conn.exec;
      delete conn.export;
      assert.equal(await foreignKeys(ds), 0, 'sanity: the failed restore left the checks off');
      assert.equal(await flushSqljs(ds, true), true);
      assert.equal(await foreignKeys(ds), 1, 'the next flush must not keep the value the failure left behind');
      await assert.rejects(saveOrphanComment(ds, 'after-failed-restore'), FK_FAILED);
    } finally {
      delete conn.exec;
      delete conn.export;
      await ds.destroy();
    }
  });
});

// TypeORM/sql.js 는 이벤트 루프를 붙잡아 두는 핸들을 남긴다. 이 스위트는 `--test-force-exit` 로 실행돼 그런 핸들을
// 정리하고 node:test 가 계산한 실제 종료 코드로 끝난다 — 수동 process.exit() 은 그 코드를 덮어써 실패한 assertion 을
// 가릴 수 있으므로 쓰지 않는다.
