// 회귀 테스트 — ticket 61622dbb
// "sql.js 트랜잭션 큐: 한 차례가 오래 잡히면 어디서 잡았는지 경고로 남긴다 (데드락 · 느린 콜백 진단)"
//
// 배경: sql.js(dev)에서는 연결에 쓰는 모든 일이 serializeSqljsTransactions() 큐의 차례를 탄다(ticket 13f5b0f6). 차례를 쥔
// 콜백이 다른 체인의 쓰기를 기다리거나(데드락) 느린 I/O 를 하면 그 연결의 모든 쓰기가 소리 없이 멈췄고, 멈춘 뒤에는
// 무엇이 차례를 쥐었는지 볼 수단이 없었다.
//
// 이 스위트가 증명하는 것:
//   1. 기준(SQLJS_TURN_WARN_MS)보다 오래 쥔 차례는 경고를 한 번 남긴다 — 연결 이름, 차례를 연 일, 쥔 시간, 뒤에서
//      기다리는 일 수(차례 안의 재진입 쓰기는 세지 않는다). 그 차례가 풀리면 걸린 시간을 한 줄 더 남긴다. 쥔 동안 감시가
//      보지 못한 차례(이벤트 루프를 막았다)는 풀릴 때 한 번 알린다. 기준보다 짧은 차례는 조용하다 — 줄 서 있던 시간은
//      쥔 시간에 들지 않는다.
//   2. 호출 위치 — SQLJS_TURN_STACKS=1 이면 첫 경고부터 실린다. 아니면 첫 경고는 위치 없이 플래그를 안내하고, 그 연결에서
//      그 뒤에 열린 차례부터 위치가 실린다(연결마다 따로). 위치에는 큐 안쪽 프레임이 없다.
//   3. 차례를 연 일마다 이름이 있다 — transaction, save, 문장의 첫 단어, synchronize, afterSqljsTransactions() 의 이름, export.
//   4. 감시 주기는 차례마다 만들지 않는다 — 바쁜 DataSource 마다 하나(unref)이고, 큐가 쉬면 스스로 멈춘다. 차례가 없던
//      DataSource 에는 주기가 없다. 주기는 DataSource 를 만든 비동기 문맥에서 돈다 — 그것을 건 요청의 문맥이 아니다.
//   5. 감시가 실패해도 쓰기 결과와 큐는 그대로 간다 — 경고를 못 씀(console.warn 이 던짐), 주기를 못 걺(setInterval 이
//      던짐 — 다음 차례가 다시 건다).
//   6. 기준값 해석 — 비었거나 틀리면 30초, 하한 50ms.
//
// 컴파일된 dist/ 를 대상으로 실행한다(`npm run build` 필요, test 스크립트가 보장). 공유 dev database/ 의
// 파일을 건드리지 않도록 모든 sql.js 파일을 임시 디렉터리에 둔다.

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const DIST_ROOT = path.join(path.dirname(THIS_FILE), '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-sqljs-queue-watch-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const {
  buildDataSourceOptions,
  serializeSqljsTransactions,
  afterSqljsTransactions,
  flushSqljs,
  resolveSqljsTurnWarnMs,
  DEFAULT_SQLJS_TURN_WARN_MS,
  SQLJS_EXPORT_TXN_WAIT_MS,
} = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { Account } = await import('file://' + path.join(DIST_ROOT, 'entities', 'Account.js'));
const { DataSource } = await import('typeorm');

const WARN_MS = 200;
/** watchSqljsTurns() 의 tick 주기 — min(5초, 기준/4). */
const tickMsFor = (warnMs) => Math.min(5_000, Math.ceil(warnMs / 4));
const QUEUE_INTERNALS = /[\\/]dist[\\/]db\.js:/;

let fileSeq = 0;
const opened = [];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

/** NestJS DatabaseModule 과 같은 모양 — 초기화한 뒤 큐를 건다. 기준과 SQLJS_TURN_STACKS 는 큐를 걸 때 읽힌다. */
async function openDataSource({ warnMs = WARN_MS, stacks } = {}) {
  const ds = new DataSource({ ...buildDataSourceOptions(), location: path.join(tmpDir, `watch-${++fileSeq}.db`) });
  opened.push(ds);
  await ds.initialize();
  withEnv({ SQLJS_TURN_WARN_MS: String(warnMs), SQLJS_TURN_STACKS: stacks }, () => serializeSqljsTransactions(ds));
  return ds;
}

const connectionOf = (ds) => path.basename(ds.options.location);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function gate() {
  let open;
  const wait = new Promise((resolve) => { open = resolve; });
  return { wait, open };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

async function withinDeadlockTimeout(promise) {
  let timer;
  const deadlock = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadlock')), 5_000); });
  try {
    return await Promise.race([promise, deadlock]);
  } finally {
    clearTimeout(timer);
  }
}

/** 멈춤 지점에 닿았다는 신호. 일이 그 전에 끝나면 기다리지 않고 실패한다. */
function reached(signal, work) {
  return Promise.race([signal, work.then(() => { throw new Error('the work ended before its hold point'); })]);
}

/** 콜백 안에서 행 하나를 쓰고(차례 안의 재진입 쓰기) gate 에서 멈추는 트랜잭션. */
function holdTransaction(ds, tag) {
  const inside = gate();
  const release = gate();
  const done = ds.transaction(async (manager) => {
    const accounts = manager.getRepository(Account);
    await accounts.save(accounts.create({ name: `${tag}-inside`, description: 'watch' }));
    inside.open();
    await release.wait;
    return `${tag}: committed`;
  });
  return { inside: reached(inside.wait, done), release: release.open, done };
}

// 호출 위치를 구별하려고 이름을 붙인 진입점들.
function openFirstLongTransaction(ds) { return holdTransaction(ds, 'first'); }
function openSecondLongTransaction(ds) { return holdTransaction(ds, 'second'); }
function openFlaggedLongTransaction(ds) { return holdTransaction(ds, 'flagged'); }

/** 큐 경고만 모은다. 다른 console.warn 은 그대로 내보낸다. */
function captureQueueWarnings() {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[DB] sql.js write queue')) lines.push(text);
    else original.apply(console, args);
  };
  return { lines, restore: () => { console.warn = original; } };
}

describe('sql.js: a queue turn held too long is reported with where it was opened (ticket 61622dbb)', { timeout: 60_000 }, () => {
  let warnings;
  beforeEach(() => { warnings = captureQueueWarnings(); });
  afterEach(() => warnings.restore());
  const warningsFor = (ds) => warnings.lines.filter((line) => line.includes(`(${connectionOf(ds)})`));

  after(async () => {
    for (const ds of opened) if (ds.isInitialized) await ds.destroy();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('a turn held past the threshold warns once — connection, what opened it, how long, how many wait behind — and its release adds how long it took', async () => {
    const ds = await openDataSource();
    const held = holdTransaction(ds, 'once');
    await held.inside;
    const accounts = ds.getRepository(Account);
    const waiters = [
      accounts.save(accounts.create({ name: 'once-waiter', description: 'watch' })),
      accounts.update({ name: 'once-inside' }, { description: 'updated' }),
      ds.transaction(async (manager) => manager.getRepository(Account).countBy({ name: 'once-waiter' })),
    ];

    await until(() => warningsFor(ds).length > 0, 'the long-turn warning');
    await sleep(WARN_MS * 3); // 기준을 몇 번 더 넘겨 쥐어도 경고는 그대로 하나다
    const [warning, ...more] = warningsFor(ds);
    assert.deepEqual(more, [], 'one warning per turn, however long it is held');
    assert.match(
      warning,
      new RegExp(
        `^\\[DB\\] sql\\.js write queue \\(${escapeRe(connectionOf(ds))}\\): the turn opened by "transaction" ` +
          'has been held for \\d+\\.\\ds, 3 waiting behind it — every write on this connection waits until it is released\\.',
      ),
      'the save inside the callback ran in the held turn and is not counted as waiting',
    );
    const heldFor = Number(/held for (\d+\.\d)s/.exec(warning)[1]);
    assert.ok(heldFor >= WARN_MS / 1000, `held for ${heldFor}s when it warned — not before the threshold`);

    held.release();
    assert.equal(await withinDeadlockTimeout(held.done), 'once: committed');
    const [, , counted] = await withinDeadlockTimeout(Promise.all(waiters));
    assert.equal(counted, 1, 'the writes queued behind it ran after it');
    const lines = warningsFor(ds);
    assert.equal(lines.length, 2, `a warning and its release line: ${JSON.stringify(lines)}`);
    const releasedAfter = Number(/the turn opened by "transaction" was released after (\d+\.\d)s$/.exec(lines[1])?.[1]);
    assert.ok(releasedAfter >= heldFor + 0.5, `released after ${releasedAfter}s — the whole time it was held, not the time to the warning`);
  });

  it('turns shorter than the threshold stay quiet, even while the watch is ticking', async () => {
    const warnMs = 1_000;
    const ds = await openDataSource({ warnMs });
    const accounts = ds.getRepository(Account);
    for (let i = 0; i < 20; i++) await accounts.save(accounts.create({ name: `quiet-${i}`, description: 'watch' }));
    await Promise.all(Array.from({ length: 20 }, (_, i) => accounts.update({ name: `quiet-${i}` }, { description: 'u' })));
    // 기준의 40% 동안 쥔다 — 그 사이 tick 이 한두 번 지나간다.
    await ds.transaction(async () => { await sleep(tickMsFor(warnMs) * 1.6); });
    await sleep(tickMsFor(warnMs) * 2);
    assert.deepEqual(warningsFor(ds), []);
  });

  it('time spent waiting in the queue is not time held: a quick turn behind a long one stays quiet', async () => {
    const warnMs = 400;
    const ds = await openDataSource({ warnMs });
    const ahead = holdTransaction(ds, 'ahead');
    await ahead.inside;
    // 앞 차례가 기준을 넘길 때까지 줄 서 있다가, 자기 차례는 tick 한두 번 동안만 쥔다(기준까지 250ms 여유).
    const behind = ds.transaction(async () => { await sleep(tickMsFor(warnMs) * 1.5); return 'behind: done'; });
    await until(() => warningsFor(ds).length === 1, 'the warning for the turn ahead');
    ahead.release();
    await withinDeadlockTimeout(ahead.done);
    assert.equal(await withinDeadlockTimeout(behind), 'behind: done');
    await sleep(tickMsFor(warnMs) * 2);
    const lines = warningsFor(ds);
    assert.equal(lines.length, 2, `only the turn ahead warned, then was released: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /has been held for .*, 1 waiting behind it/);
    assert.match(lines[1], /was released after/);
  });

  it('a turn the watch could not check while it was held — it blocked the event loop — is reported once, when it is released', async () => {
    const ds = await openDataSource();
    const blocking = ds.transaction(async (manager) => {
      const accounts = manager.getRepository(Account);
      await accounts.save(accounts.create({ name: 'blocking-inside', description: 'watch' }));
      const busyUntil = performance.now() + WARN_MS * 1.5;
      while (performance.now() < busyUntil) {
        // 이벤트 루프를 막는다 — 그동안 감시 tick 이 돌 틈이 없다.
      }
      return 'blocking: committed';
    });
    const accounts = ds.getRepository(Account);
    const waiter = accounts.save(accounts.create({ name: 'blocking-waiter', description: 'watch' }));
    assert.equal(await withinDeadlockTimeout(blocking), 'blocking: committed');
    assert.ok((await withinDeadlockTimeout(waiter)).id);
    await sleep(tickMsFor(WARN_MS) * 2);
    const lines = warningsFor(ds);
    assert.equal(lines.length, 1, `one report, made when the turn was released, and no separate release line: ${JSON.stringify(lines)}`);
    assert.match(
      lines[0],
      new RegExp(
        `^\\[DB\\] sql\\.js write queue \\(${escapeRe(connectionOf(ds))}\\): the turn opened by "transaction" was held for \\d+\\.\\ds ` +
          'before it was released, 1 waiting behind it — the watch could not check it while it was held ' +
          '\\(it blocked the event loop, or ended between checks\\)\\. Its call site was not recorded;',
      ),
    );
    const heldFor = Number(/was held for (\d+\.\d)s/.exec(lines[0])[1]);
    assert.ok(heldFor >= WARN_MS / 1000, `held for ${heldFor}s — past the threshold`);

    // 쥔 동안 남긴 경고와 마찬가지로, 그 뒤로 이 연결은 호출 위치를 기록한다.
    const next = openSecondLongTransaction(ds);
    await next.inside;
    await until(() => warningsFor(ds).length === 2, 'the next warning');
    assert.match(warningsFor(ds)[1], /has been held for .* Opened at:\n.*at openSecondLongTransaction \(/s);
    next.release();
    await withinDeadlockTimeout(next.done);
  });

  it('without SQLJS_TURN_STACKS the first warning has no call site and says how to get one; turns opened after it on that connection carry theirs', async () => {
    const ds = await openDataSource();
    const first = openFirstLongTransaction(ds);
    await first.inside;
    await until(() => warningsFor(ds).length === 1, 'the first warning');
    const [firstWarning] = warningsFor(ds);
    assert.doesNotMatch(firstWarning, /Opened at:/);
    assert.match(firstWarning, /Its call site was not recorded; turns opened from now on record theirs\. Set SQLJS_TURN_STACKS=1 to record them from the start\.$/);
    first.release();
    await withinDeadlockTimeout(first.done);

    const second = openSecondLongTransaction(ds);
    await second.inside;
    await until(() => warningsFor(ds).length === 3, 'the second warning');
    const secondWarning = warningsFor(ds)[2];
    assert.match(secondWarning, /the turn opened by "transaction" has been held for .* Opened at:\n {4}at /s);
    assert.match(secondWarning, /at openSecondLongTransaction \(/, 'the call site names the function that opened the turn');
    assert.ok(secondWarning.includes(THIS_FILE), 'and the file it is in');
    second.release();
    await withinDeadlockTimeout(second.done);

    const other = await openDataSource();
    const third = openFirstLongTransaction(other);
    await third.inside;
    await until(() => warningsFor(other).length === 1, 'the first warning on another connection');
    assert.doesNotMatch(warningsFor(other)[0], /Opened at:/, 'each connection starts recording after its own first warning');
    third.release();
    await withinDeadlockTimeout(third.done);
  });

  it('with SQLJS_TURN_STACKS=1 the first warning already carries the call site, without the queue\'s own frames', async () => {
    const ds = await openDataSource({ stacks: '1' });
    const held = openFlaggedLongTransaction(ds);
    await held.inside;
    await until(() => warningsFor(ds).length === 1, 'the warning');
    const [warning] = warningsFor(ds);
    assert.match(warning, / Opened at:\n {4}at /);
    assert.match(warning, /at openFlaggedLongTransaction \(/);
    assert.ok(warning.includes(THIS_FILE));
    assert.doesNotMatch(warning, QUEUE_INTERNALS, 'the frames of db.js that opened the turn are not a call site');
    held.release();
    await withinDeadlockTimeout(held.done);
  });

  describe('every kind of turn is named (call sites recorded)', () => {
    /** 기준을 넘겨 쥔 차례의 경고를 기다렸다가 돌려준다. */
    async function warningFor(ds, what) {
      await until(() => warningsFor(ds).length > 0, `the warning for ${what}`);
      return warningsFor(ds)[0];
    }

    it('save — held in a subscriber', async () => {
      const ds = await openDataSource({ stacks: 'true' });
      const hold = gate();
      const inside = gate();
      ds.subscribers.push({
        listenTo: () => Account,
        async beforeInsert(event) {
          if (event.entity?.name !== 'held-save') return;
          inside.open();
          await hold.wait;
        },
      });
      async function saveHeldAccount() {
        const accounts = ds.getRepository(Account);
        return accounts.save(accounts.create({ name: 'held-save', description: 'watch' }));
      }
      const saving = saveHeldAccount();
      await reached(inside.wait, saving);
      const warning = await warningFor(ds, 'save');
      assert.match(warning, /the turn opened by "save" has been held/);
      assert.match(warning, /at saveHeldAccount \(/);
      assert.doesNotMatch(warning, QUEUE_INTERNALS);
      hold.open();
      assert.ok((await withinDeadlockTimeout(saving)).id);
      await until(() => warningsFor(ds).length === 2, 'the release line');
      assert.match(warningsFor(ds)[1], /the turn opened by "save" was released after/);
    });

    for (const { kind, label, write } of [
      {
        kind: 'a repository update',
        label: 'UPDATE',
        write: async function updateHeldAccount(ds) {
          await ds.getRepository(Account).update({ name: 'statement-row' }, { description: 'held-statement' });
        },
      },
      {
        kind: 'a raw statement',
        label: 'DELETE',
        write: async function deleteHeldAccount(ds) {
          await ds.query('  DELETE FROM accounts WHERE name = ? AND description <> ?', ['nobody', 'held-statement']);
        },
      },
    ]) {
      it(`${kind} — the statement's first word`, async () => {
        const ds = await openDataSource({ stacks: '1' });
        const accounts = ds.getRepository(Account);
        await accounts.save(accounts.create({ name: 'statement-row', description: 'watch' }));
        const hold = gate();
        const inside = gate();
        ds.subscribers.push({
          async beforeQuery(event) {
            if (!event.parameters?.includes('held-statement')) return;
            inside.open();
            await hold.wait;
          },
        });
        const writing = write(ds);
        await reached(inside.wait, writing);
        const warning = await warningFor(ds, label);
        assert.match(warning, new RegExp(`the turn opened by "${label}" has been held`));
        assert.match(warning, new RegExp(`at (async )?${write.name} \\(`), 'the write\'s caller is on the call site');
        assert.doesNotMatch(warning, QUEUE_INTERNALS);
        hold.open();
        await withinDeadlockTimeout(writing);
      });
    }

    it('a DataSource method — synchronize', async () => {
      const ds = await openDataSource({ stacks: '1' });
      const hold = gate();
      const inside = gate();
      let armed = false;
      ds.subscribers.push({
        async beforeQuery() {
          if (!armed) return;
          armed = false;
          inside.open();
          await hold.wait;
        },
      });
      armed = true;
      const syncing = ds.synchronize();
      await reached(inside.wait, syncing);
      const warning = await warningFor(ds, 'synchronize');
      assert.match(warning, /the turn opened by "synchronize" has been held/);
      assert.doesNotMatch(warning, QUEUE_INTERNALS);
      hold.open();
      await withinDeadlockTimeout(syncing);
    });

    it('afterSqljsTransactions() — the label it is given, or its own name', async () => {
      const ds = await openDataSource({ stacks: '1' });
      for (const [label, expected] of [['rebuild-index', 'rebuild-index'], [undefined, 'afterSqljsTransactions']]) {
        warnings.lines.length = 0;
        const hold = gate();
        const work = label === undefined
          ? afterSqljsTransactions(ds, () => hold.wait)
          : afterSqljsTransactions(ds, () => hold.wait, label);
        const warning = await warningFor(ds, expected);
        assert.match(warning, new RegExp(`the turn opened by "${expected}" has been held`));
        assert.ok(warning.includes(THIS_FILE), 'the caller of afterSqljsTransactions() is on the call site');
        assert.doesNotMatch(warning, QUEUE_INTERNALS);
        hold.open();
        await withinDeadlockTimeout(work);
        await until(() => warningsFor(ds).length === 2, 'the release line');
      }
    });

    it('export — a flush waiting for a transaction opened outside the queue', async () => {
      const ds = await openDataSource({ stacks: '1' });
      await ds.query('BEGIN'); // 큐 밖에서 연 트랜잭션 — export 는 차례를 쥔 채 그것이 닫히기를 기다린다
      try {
        const flushing = flushSqljs(ds, true).then(() => null, (e) => e);
        const warning = await warningFor(ds, 'export');
        assert.match(warning, /the turn opened by "export" has been held/);
        assert.match(warning, /at flushSqljs \(/, 'the export turn is opened by the flush');
        const failure = await withinDeadlockTimeout(flushing);
        assert.match(failure?.message || '', /sql\.js export skipped/, 'the export gave up rather than end the open transaction');
        await until(() => warningsFor(ds).length === 2, 'the release line');
        const releasedAfter = Number(/the turn opened by "export" was released after (\d+\.\d)s$/.exec(warningsFor(ds)[1])?.[1]);
        assert.ok(releasedAfter >= SQLJS_EXPORT_TXN_WAIT_MS / 1000 - 0.1, `released after ${releasedAfter}s, once it stopped waiting`);
      } finally {
        await ds.query('ROLLBACK');
      }
    });
  });

  it('the watch is one unref\'d interval per busy DataSource, not one per turn, and stops itself once the queue is idle', async () => {
    const tickMs = tickMsFor(WARN_MS);
    const created = [];
    const cleared = new Set();
    const { setInterval: realSetInterval, clearInterval: realClearInterval } = globalThis;
    globalThis.setInterval = function trackedSetInterval(fn, ms, ...args) {
      const handle = realSetInterval(fn, ms, ...args);
      if (ms === tickMs) created.push(handle);
      return handle;
    };
    globalThis.clearInterval = function trackedClearInterval(handle) {
      cleared.add(handle);
      return realClearInterval(handle);
    };
    try {
      const ds = await openDataSource();
      await sleep(tickMs * 2);
      assert.equal(created.length, 0, 'a DataSource that has had no turn yet has no watch');

      const accounts = ds.getRepository(Account);
      const started = Date.now();
      for (let i = 0; i < 100; i++) await accounts.save(accounts.create({ name: `timer-${i}`, description: 'watch' }));
      await Promise.all(Array.from({ length: 100 }, (_, i) => accounts.update({ name: `timer-${i}` }, { description: 'u' })));
      await ds.transaction(async () => { await sleep(tickMs * 3); }); // 쥔 동안 tick 이 돈다
      const elapsed = Date.now() - started;

      assert.ok(created.length >= 1, 'a busy queue is watched');
      // 큐가 쉬는 것을 본 tick 마다 한 번 멈추고 다시 걸 수 있다 — 그래도 tick 수를 넘지 않는다.
      const bound = Math.ceil(elapsed / tickMs) + 1;
      assert.ok(created.length <= bound, `${created.length} intervals for 201 turns in ${elapsed}ms (at most ${bound})`);
      assert.ok(created.every((handle) => !handle.hasRef()), 'the watch never keeps the process alive');
      await until(() => created.every((handle) => cleared.has(handle)), 'the idle watch to stop', tickMs * 10);
      assert.deepEqual(warningsFor(ds), []);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });

  it('a warning that fails to write does not stop the queue or the process', async () => {
    const ds = await openDataSource();
    const capturing = console.warn;
    let attempts = 0;
    console.warn = () => {
      attempts += 1;
      throw new Error('the console is gone');
    };
    try {
      const held = holdTransaction(ds, 'throwing');
      await held.inside;
      const waiter = ds.getRepository(Account).save(ds.getRepository(Account).create({ name: 'throwing-waiter', description: 'watch' }));
      await until(() => attempts === 1, 'the warning attempt from the watch tick');
      held.release();
      assert.equal(await withinDeadlockTimeout(held.done), 'throwing: committed', 'the release line failed, the transaction still resolves as it did');
      assert.equal(attempts, 2, 'the release line was attempted');
      assert.ok((await withinDeadlockTimeout(waiter)).id, 'the queue moved on to the waiting write');
    } finally {
      console.warn = capturing;
    }
  });

  it('a watch that cannot start its interval neither fails the write nor stops the queue — the next turn tries again', async () => {
    const ds = await openDataSource();
    const accounts = ds.getRepository(Account);
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => { throw new Error('setInterval is unavailable'); };
    try {
      // 차례는 줄을 선 뒤에 시작하므로, 쓰기가 끝날 때까지 setInterval 을 망가뜨린 채 둔다.
      const writes = await withinDeadlockTimeout(Promise.allSettled([
        accounts.save(accounts.create({ name: 'no-interval-1', description: 'watch' })),
        accounts.save(accounts.create({ name: 'no-interval-2', description: 'watch' })),
      ]));
      assert.deepEqual(writes.map((w) => w.reason?.message ?? w.status), ['fulfilled', 'fulfilled'], 'the writes resolve as they would without the watch');
      // 주기가 없어도 기준을 넘긴 차례는 풀릴 때 알린다.
      await withinDeadlockTimeout(afterSqljsTransactions(ds, () => sleep(WARN_MS * 1.5), 'no-interval'));
      assert.match(warningsFor(ds)[0] ?? '', /the turn opened by "no-interval" was held for \d+\.\ds before it was released/);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    const held = holdTransaction(ds, 'interval-back');
    await held.inside;
    await until(
      () => warningsFor(ds).some((line) => line.includes('the turn opened by "transaction" has been held')),
      'a warning while the turn is still held, from the interval the next turn started',
    );
    held.release();
    assert.equal(await withinDeadlockTimeout(held.done), 'interval-back: committed');
  });

  it('the watch runs in the async context the DataSource was set up in, not in the request that happened to start it', async () => {
    const request = new AsyncLocalStorage();
    const ds = await openDataSource();
    const accounts = ds.getRepository(Account);
    const capturing = console.warn;
    const written = [];
    console.warn = (...args) => {
      written.push({ request: request.getStore(), text: args.map(String).join(' ') });
      capturing.apply(console, args);
    };
    try {
      // 쉬던 DataSource 의 첫 차례 — 요청 A 가 감시 주기를 걸고 곧 끝난다.
      await request.run('request A', () => accounts.save(accounts.create({ name: 'context-a', description: 'watch' })));
      const held = request.run('request B', () => holdTransaction(ds, 'context-b'));
      await held.inside;
      await until(() => warningsFor(ds).length === 1, 'the warning for the turn request B holds');
      const warning = written.find(({ text }) => text.includes('has been held'));
      assert.equal(warning?.request, undefined, `the warning was written in the context of ${warning?.request}`);
      held.release();
      await withinDeadlockTimeout(held.done);
    } finally {
      console.warn = capturing;
    }
  });

  it('the threshold: 30s when SQLJS_TURN_WARN_MS is unset or invalid, never below 50ms', () => {
    assert.equal(DEFAULT_SQLJS_TURN_WARN_MS, 30_000);
    for (const [raw, expected] of [
      [undefined, 30_000],
      ['', 30_000],
      ['soon', 30_000],
      ['0', 30_000],
      ['-5', 30_000],
      ['10', 50],
      ['1500', 1_500],
    ]) {
      assert.equal(withEnv({ SQLJS_TURN_WARN_MS: raw }, () => resolveSqljsTurnWarnMs()), expected, `SQLJS_TURN_WARN_MS=${raw}`);
    }
  });
});

// TypeORM/sql.js 는 이벤트 루프를 붙잡아 두는 핸들을 남긴다. 이 스위트는 `--test-force-exit` 로 실행돼
// 그런 핸들을 정리하고 node:test 가 계산한 실제 종료 코드로 끝난다 — 수동 process.exit() 은 그 코드를 덮어써
// 실패한 assertion 을 가릴 수 있으므로 쓰지 않는다.
