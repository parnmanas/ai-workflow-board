// 회귀 테스트 — ticket 61622dbb
// "sql.js 트랜잭션 큐: 한 차례가 오래 잡히면 어디서 잡았는지 경고로 남긴다 (데드락 · 느린 콜백 진단)"
// 와 그 후속 ticket c495ceaa
// "sql.js 큐 경고: 데드락이면 차례 뒤에서 기다리는 쓰기의 위치도 남긴다 (데드락의 다른 쪽)"
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
//   3. 차례를 연 일마다 이름이 있다 — transaction, save, 문장의 첫 단어(쓰기 문장은 대상 테이블까지 — c495ceaa), synchronize,
//      afterSqljsTransactions() 의 이름, export.
//   4. 감시 주기는 차례마다 만들지 않는다 — 바쁜 DataSource 마다 하나(unref)이고, 큐가 쉬면 스스로 멈춘다. 차례가 없던
//      DataSource 에는 주기가 없다. 주기는 큐를 건 비동기 문맥에서 돈다 — 그것을 건 요청의 문맥이 아니다. 주기의 타이머는
//      db.js 를 불러올 때 잡혀서, 나중에 켠 가짜 타이머(node:test mock timers)가 감시를 끄지 못한다.
//   5. 감시가 실패해도 쓰기 결과와 큐는 그대로 간다 — 경고를 못 씀(console.warn 이 던짐), 주기를 못 걺(setInterval 이
//      던짐 — 다음 차례가 다시 건다). 위치를 꾸미지 못하면(Error.prepareStackTrace 가 던짐) 위치만 빠지고 경고는 남는다.
//   6. 기준값 해석 — 비었거나 숫자가 아니면 30초, 하한 50ms.
//   7. 넘어간 차례는 호출자를 붙잡지 않는다 — 차례 안에서 만든 타이머가 차례 객체를 AsyncLocalStorage 값으로 오래 물고
//      있어도, 기록한 위치(프레임의 receiver)와 차례의 work(콜백이 쓰는 this)를 거쳐 호출자가 남지 않는다.
//   8. 데드락의 다른 쪽 (c495ceaa) — 쥔 동안 남기는 경고에 뒤에서 기다리는 차례가 실린다. 쥔 차례가 시작될 때 이미 기다리던
//      무리와 그 뒤에 줄 선 무리로 나뉘고, 무리마다 이름 · 위치가 같은 차례는 한 항목으로 묶여 수가 달린다(사이에 다른 쓰기가
//      끼어도). 항목은 처음 나타난 순서대로 무리마다 5개까지다(줄에서의 자리, 이름, 각자 줄 선 때부터 센 기다린 시간, 호출
//      위치 — 위치는 줄 설 때 기록한 것이다). 나머지는 수로 남고, 무리마다 앞의 1000개만 살펴본다. 위치가 없으면 이름으로만
//      묶이고 그 항목은 다른 쓰기들일 수 있다고 적는다 — 쓰기 문장의 이름에는 테이블이 붙어 있다. 쥔 콜백이 다른 체인의
//      쓰기를 기다리는 데드락에서는 그 쓰기와 그것을 부른 함수가 나온다 — 쥔 차례가 줄 서 있던 동안이든 시작한 뒤든, 같은
//      쓰기가 되풀이되며 앞에 쌓였어도 밀려나지 않는다. 시작한 차례는 목록에서 빠지고, 차례 안의 재진입 쓰기는 목록에 없고,
//      연결마다 자기 목록이다. 풀릴 때 남기는 보고에는 목록이 없다 — 풀리는 차례는 데드락이 아니었다. 경고를 만들다 실패해도
//      큐와 프로세스는 그대로 간다. 오래 남는 차례가 다른 차례들을 붙잡지 않는다(차례끼리 잇지 않는다 — 바쁜 큐에서도).
//
// 컴파일된 dist/ 를 대상으로 실행한다(`npm run build` 필요, test 스크립트가 보장). 공유 dev database/ 의
// 파일을 건드리지 않도록 모든 sql.js 파일을 임시 디렉터리에 둔다.

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const DIST_ROOT = path.join(path.dirname(THIS_FILE), '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-sqljs-queue-watch-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

// 감시 주기의 setInterval · clearInterval 은 db.js 를 불러올 때 잡힌다 — 나중에 켠 가짜 타이머가 감시를 끄지 못하게. 그래서
// 주기를 지켜보거나 망가뜨리는 테스트는 불러오기 전에 건 이 갈고리를 쓴다. 갈고리가 비어 있으면 진짜 함수로 넘긴다.
const { setInterval: realSetInterval, clearInterval: realClearInterval } = globalThis;
const watchTimerHooks = { setInterval: null, clearInterval: null };
globalThis.setInterval = function watchSetInterval(...args) {
  return (watchTimerHooks.setInterval ?? realSetInterval)(...args);
};
globalThis.clearInterval = function watchClearInterval(handle) {
  return (watchTimerHooks.clearInterval ?? realClearInterval)(handle);
};
const {
  buildDataSourceOptions,
  serializeSqljsTransactions,
  afterSqljsTransactions,
  flushSqljs,
  resolveSqljsTurnWarnMs,
  sqljsStatementLabel,
  DEFAULT_SQLJS_TURN_WARN_MS,
  SQLJS_WAITING_TURNS_IN_WARNING,
  SQLJS_WAITING_TURNS_EXAMINED,
  SQLJS_EXPORT_TXN_WAIT_MS,
} = await import('file://' + path.join(DIST_ROOT, 'db.js'));
// db.js 가 갈고리를 잡았다. 전역은 되돌린다 — 다른 코드와 mock timers 는 진짜 함수를 본다.
globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
const { Account } = await import('file://' + path.join(DIST_ROOT, 'entities', 'Account.js'));
const { Channel } = await import('file://' + path.join(DIST_ROOT, 'entities', 'Channel.js'));
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

/** 이 프로세스에서 gc() 를 쓸 수 있게 한다 — `node --expose-gc` 없이(jest 의 누수 검사와 같은 방법). */
function exposeGc() {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc');
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

/** 경고에서 뒤에서 기다리는 차례들을 적은 부분 — 없으면 null. */
function waitingSectionOf(warning) {
  const at = warning.indexOf('\nWaiting behind it');
  return at === -1 ? null : warning.slice(at + 1);
}

const WAITING_HEADER = 'Waiting behind it, in queue order — if the turn waits for one of these, that is a deadlock:';
/** 위치 없이 이름으로만 묶인 항목의 덧붙임 — 같은 쓰기가 되풀이된 것으로 읽지 않게. */
const MERGED_UNRECORDED = 'call sites not recorded — different writes with this name count together';

/**
 * 경고의 기다리는 차례 목록을 무리별로 읽는다 — `before`(쥔 차례가 시작될 때 이미 기다리던) · `after`(그 뒤에 줄 선), 없는
 * 무리는 undefined. 무리마다 제목의 수(total), 항목들(줄에서의 자리, 이름, 묶인 차례 수, 첫 차례가 기다린 시간(초), 위치의
 * 프레임 — 기록하지 않았으면 null), 싣지 못한 수(more). 모양이 다른 줄이 있거나, 항목의 수와 more 를 더한 것이 total 과 다르면
 * 던진다.
 */
function waitingGroupsOf(warning) {
  const [header, ...lines] = (waitingSectionOf(warning) ?? '').split('\n');
  if (header !== WAITING_HEADER) throw new Error(`not a waiting list: ${JSON.stringify(header)}`);
  const groups = {};
  let group;
  for (const line of lines) {
    const heading = /^ {2}(Already waiting when it started|Queued after it started) \((\d+)\):$/.exec(line);
    const entry = new RegExp(
      '^ {4}(\\d+)\\. "([^"]*)"(?: ×(\\d+), the first|,) waiting for (\\d+\\.\\d)s' +
        `(, queued at:| \\(call site not recorded\\)| \\(${escapeRe(MERGED_UNRECORDED)}\\))$`,
    ).exec(line);
    const more = /^ {4}… and ([1-9]\d*) more$/.exec(line);
    if (heading) {
      group = { total: Number(heading[2]), entries: [], more: 0 };
      groups[heading[1] === 'Queued after it started' ? 'after' : 'before'] = group;
    } else if (entry && group && !group.more) {
      const recorded = entry[5] === ', queued at:';
      const merged = entry[3] !== undefined;
      if (!recorded && merged !== entry[5].includes(MERGED_UNRECORDED)) throw new Error(`wrong note for ${merged ? 'a merged' : 'a single'} entry: ${line}`);
      group.entries.push({
        position: Number(entry[1]),
        label: entry[2],
        count: entry[3] === undefined ? 1 : Number(entry[3]),
        waited: Number(entry[4]),
        frames: recorded ? '' : null,
      });
    } else if (more && group && !group.more) {
      group.more = Number(more[1]);
    } else if (/^ {8}\S/.test(line) && typeof group?.entries.at(-1)?.frames === 'string' && !group.more) {
      group.entries.at(-1).frames += `${line}\n`;
    } else {
      throw new Error(`unexpected line in the waiting list: ${JSON.stringify(line)}`);
    }
  }
  for (const [name, { total, entries, more }] of Object.entries(groups)) {
    const counted = entries.reduce((sum, { count }) => sum + count, more);
    if (counted !== total) throw new Error(`the ${name} group has ${total} waiting, but its entries and "more" count ${counted}`);
    if (entries.length > SQLJS_WAITING_TURNS_IN_WARNING) throw new Error(`the ${name} group lists ${entries.length} entries`);
    if (entries.some(({ count }) => count === 1) && / ×1,/.test(warning)) throw new Error('a single turn is marked ×1');
  }
  return groups;
}

/** 무리의 항목들 — [줄에서의 자리, 이름, 묶인 차례 수]. */
const entriesOf = (group) => group?.entries.map(({ position, label, count }) => [position, label, count]);

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
    const queuedFrom = performance.now();
    const waiters = [
      accounts.save(accounts.create({ name: 'once-waiter', description: 'watch' })),
      accounts.update({ name: 'once-inside' }, { description: 'updated' }),
      ds.transaction(async (manager) => manager.getRepository(Account).countBy({ name: 'once-waiter' })),
    ];

    await until(() => warningsFor(ds).length > 0, 'the long-turn warning');
    const sinceQueued = (performance.now() - queuedFrom) / 1000;
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
    // 뒤에서 기다리는 쓰기들 (c495ceaa) — 모두 이 차례가 시작된 뒤에 줄 섰다. SQLJS_TURN_STACKS 없이는 이름과 기다린 시간뿐이다.
    assert.equal(
      waitingSectionOf(warning)?.split('\n').slice(0, 2).join('\n'),
      `${WAITING_HEADER}\n  Queued after it started (3):`,
    );
    const { before, after } = waitingGroupsOf(warning);
    assert.equal(before, undefined, 'nothing was waiting when it started');
    assert.deepEqual(after.entries.map(({ position }) => position), [1, 2, 3]);
    assert.deepEqual(
      after.entries.map(({ label }) => label).sort(),
      ['UPDATE accounts', 'save', 'transaction'],
      'the save inside the callback ran in the held turn and is not listed',
    );
    for (const { label, waited, frames } of after.entries) {
      assert.equal(frames, null, `${label}: its call site was not recorded`);
      assert.ok(waited <= sinceQueued + 0.05, `${label} waiting for ${waited}s — no longer than since it was queued (${sinceQueued.toFixed(3)}s)`);
    }

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
          '\\(the event loop was blocked, or the turn ended between checks\\)\\. Its call site was not recorded;',
      ),
    );
    const heldFor = Number(/was held for (\d+\.\d)s/.exec(lines[0])[1]);
    assert.ok(heldFor >= WARN_MS / 1000, `held for ${heldFor}s — past the threshold`);
    assert.equal(
      waitingSectionOf(lines[0]),
      null,
      'a report made as the turn is released counts the writes waiting but does not list them — the turn was not deadlocked',
    );

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

    const heldStatement = (event) => event.parameters?.includes('held-statement');
    for (const { kind, label, write, holds = heldStatement, callerOnSite = true } of [
      {
        kind: 'a repository update — the statement\'s first word and its table',
        label: 'UPDATE accounts',
        write: async function updateHeldAccount(ds) {
          await ds.getRepository(Account).update({ name: 'statement-row' }, { description: 'held-statement' });
        },
      },
      {
        kind: 'a raw statement — the statement\'s first word and its table',
        label: 'DELETE accounts',
        write: async function deleteHeldAccount(ds) {
          await ds.query('  DELETE FROM accounts WHERE name = ? AND description <> ?', ['nobody', 'held-statement']);
        },
      },
      {
        // TypeORM 이 async stack 을 끊어 위치에 부른 함수가 없을 수 있다 — 그래서 문장 차례의 이름에 테이블을 붙인다.
        kind: 'a repository insert — the statement\'s first word and its table, which tell it apart when its call site has only TypeORM frames',
        label: 'INSERT accounts',
        write: async function insertHeldAccount(ds) {
          await ds.getRepository(Account).insert({ name: 'inserted-row', description: 'held-statement' });
        },
        callerOnSite: false,
      },
      {
        kind: 'a raw statement without a table — the statement\'s first word',
        label: 'PRAGMA',
        write: async function setUserVersion(ds) {
          await ds.query('PRAGMA user_version = 7');
        },
        holds: (event) => event.query === 'PRAGMA user_version = 7',
      },
    ]) {
      it(kind, async () => {
        const ds = await openDataSource({ stacks: '1' });
        const accounts = ds.getRepository(Account);
        await accounts.save(accounts.create({ name: 'statement-row', description: 'watch' }));
        const hold = gate();
        const inside = gate();
        ds.subscribers.push({
          async beforeQuery(event) {
            if (!holds(event)) return;
            inside.open();
            await hold.wait;
          },
        });
        const writing = write(ds);
        await reached(inside.wait, writing);
        const warning = await warningFor(ds, label);
        assert.match(warning, new RegExp(`the turn opened by "${label}" has been held`));
        if (callerOnSite) assert.match(warning, new RegExp(`at (async )?${write.name} \\(`), 'the write\'s caller is on the call site');
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

  describe('the turns waiting behind it — the other side of a deadlock (ticket c495ceaa)', () => {
    // 다른 요청 — HTTP 핸들러처럼 따로 시작한 비동기 체인이다. 거기서 부른 쓰기는 차례를 쥔 콜백의 재진입이 아니라 줄을 선다.
    const inAnotherRequest = AsyncResource.bind((handle) => handle());

    it('a deadlock — the held callback waits for a write another request queued behind it — names that write and the function that called it', async () => {
      const ds = await openDataSource({ stacks: '1' });
      const accounts = ds.getRepository(Account);
      await accounts.save(accounts.create({ name: 'deadlock-row', description: 'watch' }));
      async function updateFromApiHelper() {
        await ds.getRepository(Account).update({ name: 'deadlock-row' }, { description: 'from the other request' });
      }
      const breakDeadlock = gate();
      let otherRequest;
      async function holdTurnWaitingForAnotherRequest() {
        return ds.transaction(async (manager) => {
          const inside = manager.getRepository(Account);
          await inside.save(inside.create({ name: 'deadlock-inside', description: 'watch' }));
          otherRequest = inAnotherRequest(updateFromApiHelper);
          // 그 요청의 쓰기를 기다린다 — 쓰기는 이 차례 뒤에 줄 서 있어 서로를 기다린다. 테스트가 확인한 뒤 끊어 준다.
          await Promise.race([otherRequest, breakDeadlock.wait]);
          return 'holder: committed';
        });
      }
      let holderSettled = false;
      const holder = holdTurnWaitingForAnotherRequest().finally(() => { holderSettled = true; });
      let warning;
      try {
        await until(() => warningsFor(ds).length === 1, 'the long-turn warning');
        [warning] = warningsFor(ds);
        await sleep(WARN_MS * 2);
        assert.equal(holderSettled, false, 'the turn is deadlocked: it cannot end until the write behind it runs');
        assert.equal(warningsFor(ds).length, 1, 'and no release line follows');
      } finally {
        breakDeadlock.open();
      }

      const waiting = waitingSectionOf(warning) ?? '';
      const heldSide = warning.slice(0, warning.length - waiting.length);
      assert.match(
        heldSide,
        /the turn opened by "transaction" has been held for \d+\.\ds, 1 waiting behind it — every write on this connection waits until it is released\. Opened at:\n {4}at /,
      );
      assert.match(heldSide, /\n {4}at holdTurnWaitingForAnotherRequest \(/, 'one side of the deadlock: where the held turn was opened');
      assert.doesNotMatch(heldSide, /updateFromApiHelper/);
      const { before, after } = waitingGroupsOf(warning);
      assert.equal(before, undefined);
      assert.deepEqual(entriesOf(after), [[1, 'UPDATE accounts', 1]], 'the other side: the write waiting behind the held turn');
      const [{ frames }] = after.entries;
      assert.match(frames ?? '', /^ {8}at (async )?updateFromApiHelper \(/m, 'and the function that called it');
      assert.ok(frames.includes(THIS_FILE), 'and the file it is in');
      assert.doesNotMatch(frames, QUEUE_INTERNALS, 'the frames of db.js that queued the write are not a call site');

      assert.equal(await withinDeadlockTimeout(holder), 'holder: committed');
      await withinDeadlockTimeout(otherRequest);
      const row = await accounts.findOneBy({ name: 'deadlock-row' });
      assert.equal(row.description, 'from the other request', 'the waiting write ran once the turn was released');
      await until(() => warningsFor(ds).length === 2, 'the release line');
      assert.match(warningsFor(ds)[1], /the turn opened by "transaction" was released after \d+\.\ds$/);
    });

    it('on a busy queue a deadlock\'s write is still named — the turns already waiting when it started are listed apart from those queued after, and repeated writes are one entry with a count', async () => {
      const warnMs = 1_000;
      const ds = await openDataSource({ warnMs, stacks: '1' });
      const accounts = ds.getRepository(Account);
      await accounts.save(accounts.create({ name: 'busy-row', description: 'watch' }));
      async function heartbeat() {
        return afterSqljsTransactions(ds, async () => 'beat', 'heartbeat');
      }
      async function heartbeatOfAnotherHost() {
        return afterSqljsTransactions(ds, async () => 'beat', 'heartbeat'); // 이름은 같고 위치가 다르다
      }
      async function activity() {
        return afterSqljsTransactions(ds, async () => 'logged', 'activity');
      }
      // 쥔 차례가 줄 서 있던 동안 보낸 쓰기 — 예: 콜백이 기다릴 앱 수준 잠금을 쥔 다른 요청의 쓰기.
      async function writeWhileHoldingLock() {
        return afterSqljsTransactions(ds, async () => 'lock holder: wrote', 'lock-holder-write');
      }
      async function updateFromApiHelper() {
        await ds.getRepository(Account).update({ name: 'busy-row' }, { description: 'from the other request' });
      }
      // 다른 요청들의 쓰기 — 타이머에서 줄 서므로 언제 줄 서든 위치가 같다. 두 무리에서 같은 쓰기다.
      const traffic = [];
      function queueTraffic(withActivity) {
        for (let i = 0; i < 3; i++) {
          traffic.push(heartbeat());
          if (withActivity) traffic.push(activity());
        }
      }
      const trafficLater = (withActivity) => new Promise((resolve) => { setTimeout(() => resolve(queueTraffic(withActivity)), 0); });

      // 앞 차례가 기준보다 짧게 줄을 쥐는 동안 데드락할 트랜잭션이 그 뒤에 선다.
      const ahead = gate();
      const aheadDone = afterSqljsTransactions(ds, () => ahead.wait, 'ahead');
      const breakDeadlock = gate();
      let otherRequest;
      const holder = ds.transaction(async () => {
        // 시작한 뒤: 다른 요청들의 쓰기가 번갈아 줄 서고, 그 뒤에 이 콜백이 기다리는 쓰기가 선다.
        await inAnotherRequest(() => trafficLater(true));
        otherRequest = inAnotherRequest(updateFromApiHelper);
        await Promise.race([otherRequest, breakDeadlock.wait]);
        return 'holder: committed';
      });
      const others = [];
      let warning;
      try {
        // 그 트랜잭션이 줄 서 있는 동안: 같은 쓰기가 300ms 사이를 두고 두 번 쌓이고, 이름만 같은 쓰기와 다른 쓰기가 그 뒤에 선다.
        await trafficLater(false);
        await sleep(300);
        await trafficLater(false);
        others.push(heartbeatOfAnotherHost(), writeWhileHoldingLock());
        ahead.open();
        await until(() => warningsFor(ds).length === 1, 'the deadlocked turn\'s warning');
        [warning] = warningsFor(ds);
      } finally {
        ahead.open();
        breakDeadlock.open();
      }

      assert.match(warning, /the turn opened by "transaction" has been held for \d+\.\ds, 15 waiting behind it/, 'the turn ahead was short and did not warn');
      const { before, after } = waitingGroupsOf(warning);
      assert.equal(before.total, 8);
      assert.deepEqual(
        entriesOf(before),
        [[1, 'heartbeat', 6], [7, 'heartbeat', 1], [8, 'lock-holder-write', 1]],
        'the six identical writes are one entry; the same name from another call site and the different write behind them are listed',
      );
      assert.match(before.entries[0].frames ?? '', /^ {8}at queueTraffic \(/m);
      assert.match(before.entries[1].frames ?? '', /^ {8}at heartbeatOfAnotherHost \(/m);
      assert.match(before.entries[2].frames ?? '', /^ {8}at writeWhileHoldingLock \(/m);
      assert.equal(after.total, 7);
      assert.deepEqual(
        entriesOf(after),
        [[9, 'heartbeat', 3], [10, 'activity', 3], [15, 'UPDATE accounts', 1]],
        'each group has its own entries — the identical writes queued after it started are not counted into the first group; ' +
          'identical writes are one entry even when other writes come between them; the write the callback waits for is listed',
      );
      assert.equal(after.entries[0].frames, before.entries[0].frames, 'the same write in both groups');
      assert.match(after.entries[2].frames ?? '', /^ {8}at (async )?updateFromApiHelper \(/m);
      // 묶인 항목은 첫 차례의 것이다 — 그 쓰기의 첫 차례는 300ms 뒤에 줄 선 쓰기들보다 그만큼 더 기다렸다.
      const [repeated, , lockWrite] = before.entries;
      assert.ok(repeated.waited - lockWrite.waited >= 0.15, `the entry shows its first turn: ${repeated.waited}s, against ${lockWrite.waited}s for a write queued after its last`);
      assert.ok(repeated.waited - after.entries[2].waited >= 0.15, `already waiting: ${repeated.waited}s; queued after it started: ${after.entries[2].waited}s`);

      assert.equal(await withinDeadlockTimeout(holder), 'holder: committed');
      await withinDeadlockTimeout(Promise.all([aheadDone, otherRequest, ...others, ...traffic]));
    });
    it('five entries at most per group, in the order they first queued, each with how long its turn has waited and where it was queued; the rest are counted', async () => {
      assert.equal(SQLJS_WAITING_TURNS_IN_WARNING, 5);
      const warnMs = 1_000;
      const ds = await openDataSource({ warnMs, stacks: '1' });
      const held = holdTransaction(ds, 'crowded');
      await held.inside;
      async function queueBehindHeldTurn(i) {
        return afterSqljsTransactions(ds, async () => i, `waiter-${i}`);
      }
      const firstQueuedAt = performance.now();
      const waiters = [1, 2, 3].map(queueBehindHeldTurn);
      await sleep(300);
      const laterQueuedAt = performance.now();
      waiters.push(...[4, 5, 6, 7].map(queueBehindHeldTurn));
      await until(() => warningsFor(ds).length === 1, 'the warning');
      const now = performance.now();
      const [warning] = warningsFor(ds);

      assert.match(warning, /has been held for \d+\.\ds, 7 waiting behind it/);
      assert.equal(
        waitingSectionOf(warning)?.split('\n').slice(0, 2).join('\n'),
        `${WAITING_HEADER}\n  Queued after it started (7):`,
      );
      const { before, after } = waitingGroupsOf(warning);
      assert.equal(before, undefined);
      assert.deepEqual(
        entriesOf(after),
        [[1, 'waiter-1', 1], [2, 'waiter-2', 1], [3, 'waiter-3', 1], [4, 'waiter-4', 1], [5, 'waiter-5', 1]],
        'the front of the queue, in the order the turns will start',
      );
      assert.equal(after.more, 2, 'the rest are counted');
      assert.match(warning, /\n {4}… and 2 more$/);
      assert.doesNotMatch(warning, /waiter-[67]/);
      for (const { label, frames } of after.entries) {
        assert.match(frames ?? '', /^ {8}at queueBehindHeldTurn \(/, `${label}: where it was queued`);
        assert.doesNotMatch(frames, QUEUE_INTERNALS);
      }
      // 각자 줄 선 때부터 센다 — 앞 차례의 시각도, 쥔 차례가 시작된 시각도 아니다.
      const [first, , , later] = after.entries;
      const sinceFirst = (now - firstQueuedAt) / 1000;
      const sinceLater = (now - laterQueuedAt) / 1000;
      assert.ok(first.waited >= warnMs / 1000 - 0.1, `waiter-1 waiting for ${first.waited}s — it queued as the held turn started`);
      assert.ok(first.waited <= sinceFirst + 0.05, `waiter-1 waiting for ${first.waited}s — no longer than since it queued (${sinceFirst.toFixed(3)}s)`);
      assert.ok(later.waited <= sinceLater + 0.05, `waiter-4 waiting for ${later.waited}s — no longer than since it queued (${sinceLater.toFixed(3)}s)`);
      assert.ok(first.waited - later.waited >= 0.15, `waiter-1 (${first.waited}s) queued 0.3s before waiter-4 (${later.waited}s)`);

      held.release();
      assert.equal(await withinDeadlockTimeout(held.done), 'crowded: committed');
      assert.deepEqual(await withinDeadlockTimeout(Promise.all(waiters)), [1, 2, 3, 4, 5, 6, 7]);
    });

    // 앞 무리가 상한을 넘을 때와, 작은 앞 무리 뒤에서 뒤 무리만 넘을 때 — 무리마다 자기 상한이다(두 무리가 나눠 쓰지 않는다).
    for (const alreadyWaiting of [1_500, 10]) {
      it(`each group is examined up to its first ${SQLJS_WAITING_TURNS_EXAMINED} turns — the turns after them are counted, not examined (${alreadyWaiting} identical turns already waiting)`, async () => {
        assert.equal(SQLJS_WAITING_TURNS_EXAMINED, 1_000);
        const ds = await openDataSource();
        const ahead = gate();
        const aheadDone = afterSqljsTransactions(ds, () => ahead.wait, 'ahead');
        const held = holdTransaction(ds, 'bulk');
        // 쥔 차례가 줄 서 있는 동안 같은 쓰기들과 다른 쓰기 하나가 그 뒤에 선다.
        const waiters = Array.from({ length: alreadyWaiting }, (_, i) => afterSqljsTransactions(ds, async () => i, 'bulk-write'));
        waiters.push(afterSqljsTransactions(ds, async () => 'last', 'last-before'));
        ahead.open();
        await held.inside;
        // 시작한 뒤에도 — 데드락이면 줄은 이쪽에서 자란다.
        waiters.push(...Array.from({ length: 1_500 }, (_, i) => afterSqljsTransactions(ds, async () => i, 'bulk-after')));
        waiters.push(afterSqljsTransactions(ds, async () => 'last', 'last-after'));
        await until(() => warningsFor(ds).length === 1, 'the warning');
        const [warning] = warningsFor(ds);
        const beforeTotal = alreadyWaiting + 1;
        assert.match(warning, new RegExp(`has been held for \\d+\\.\\ds, ${beforeTotal + 1_501} waiting behind it`));
        const { before, after } = waitingGroupsOf(warning);
        assert.equal(before.total, beforeTotal);
        if (alreadyWaiting >= SQLJS_WAITING_TURNS_EXAMINED) {
          assert.deepEqual(entriesOf(before), [[1, 'bulk-write', 1_000]], 'the first thousand were examined — one entry');
          assert.equal(before.more, beforeTotal - 1_000, 'the turns after them, the different one at the end too, are counted');
        } else {
          assert.deepEqual(entriesOf(before), [[1, 'bulk-write', alreadyWaiting], [beforeTotal, 'last-before', 1]]);
          assert.equal(before.more, 0);
        }
        assert.equal(after.total, 1_501);
        assert.deepEqual(entriesOf(after), [[beforeTotal + 1, 'bulk-after', 1_000]], 'the next group is examined too, up to its own limit');
        assert.equal(after.more, 501);
        held.release();
        assert.equal(await withinDeadlockTimeout(held.done), 'bulk: committed');
        await withinDeadlockTimeout(aheadDone);
        assert.equal((await withinDeadlockTimeout(Promise.all(waiters))).length, beforeTotal + 1_501);
      });
    }

    it('entries keep the order their first turns queued in — a write that came once is not pushed out by writes that repeat after it', async () => {
      const ds = await openDataSource();
      const held = holdTransaction(ds, 'order');
      await held.inside;
      const waiters = [afterSqljsTransactions(ds, async () => 'once', 'came-once')];
      for (let round = 0; round < 2; round++) {
        for (let i = 1; i <= 5; i++) waiters.push(afterSqljsTransactions(ds, async () => i, `repeated-${i}`));
      }
      await until(() => warningsFor(ds).length === 1, 'the warning');
      const { after } = waitingGroupsOf(warningsFor(ds)[0]);
      assert.deepEqual(
        entriesOf(after),
        [[1, 'came-once', 1], [2, 'repeated-1', 2], [3, 'repeated-2', 2], [4, 'repeated-3', 2], [5, 'repeated-4', 2]],
        'first come, first listed — not the ones that repeat most',
      );
      assert.equal(after.more, 2, 'repeated-5, twice');
      held.release();
      assert.equal(await withinDeadlockTimeout(held.done), 'order: committed');
      assert.equal((await withinDeadlockTimeout(Promise.all(waiters))).length, 11);
    });

    it('without call sites, waiting writes are told apart by name — a write statement\'s name carries its table — and an entry that merges several says they may be different writes', async () => {
      const ds = await openDataSource();
      const held = holdTransaction(ds, 'names');
      await held.inside;
      async function saveFromHeartbeat() {
        return ds.getRepository(Account).save(ds.getRepository(Account).create({ name: 'from-heartbeat', description: 'watch' }));
      }
      async function saveFromActivity() {
        return ds.getRepository(Account).save(ds.getRepository(Account).create({ name: 'from-activity', description: 'watch' }));
      }
      async function insertAccount(name) {
        await ds.getRepository(Account).insert({ name, description: 'watch' });
      }
      async function insertChannel() {
        await ds.getRepository(Channel).insert({ name: 'watch-channel' });
      }
      const waiters = [saveFromHeartbeat(), saveFromActivity(), insertAccount('inserted-a'), insertAccount('inserted-b'), insertChannel()];
      await until(() => warningsFor(ds).length === 1, 'the warning');
      const [warning] = warningsFor(ds);
      const { after } = waitingGroupsOf(warning);
      assert.deepEqual(
        entriesOf(after).map(([, label, count]) => [label, count]),
        [['save', 2], ['INSERT accounts', 2], ['INSERT channels', 1]],
        'inserts into different tables are different entries',
      );
      assert.match(warning, new RegExp(`\\n {4}1\\. "save" ×2, the first waiting for \\d+\\.\\ds \\(${escapeRe(MERGED_UNRECORDED)}\\)\\n`));
      assert.match(warning, /\n {4}\d+\. "INSERT channels", waiting for \d+\.\ds \(call site not recorded\)$/);
      held.release();
      assert.equal(await withinDeadlockTimeout(held.done), 'names: committed');
      assert.equal((await withinDeadlockTimeout(Promise.all(waiters))).length, 5);
    });

    it('each connection lists only its own waiting turns, split by when its own held turn started; five entries are all listed', async () => {
      const one = await openDataSource();
      const two = await openDataSource();
      // one: 쥔 차례가 시작될 때 이미 둘이 기다린다.
      const aheadOne = gate();
      const aheadOneDone = afterSqljsTransactions(one, () => aheadOne.wait, 'ahead');
      const heldOne = holdTransaction(one, 'one');
      const earlyQueuedFrom = performance.now();
      const early = [1, 2].map((i) => afterSqljsTransactions(one, async () => i, `one-early-${i}`));
      aheadOne.open();
      await heldOne.inside;
      // two: 쥔 차례가 one 의 것보다 나중에, 기다리는 것 없이 시작한다 — 두 연결이 수를 함께 쓰면 one 의 앞 무리가 사라진다.
      const heldTwo = holdTransaction(two, 'two');
      await heldTwo.inside;
      const queuedFrom = performance.now();
      const waiters = [
        ...[1, 2, 3, 4, 5].map((i) => afterSqljsTransactions(one, async () => i, `one-${i}`)),
        ...[1, 2].map((i) => afterSqljsTransactions(two, async () => i, `two-${i}`)),
      ];
      await until(() => warningsFor(one).length === 1 && warningsFor(two).length === 1, 'a warning on each connection');
      const now = performance.now();

      const [warningOne] = warningsFor(one);
      assert.match(warningOne, /has been held for \d+\.\ds, 7 waiting behind it/);
      const groupsOne = waitingGroupsOf(warningOne);
      assert.deepEqual(entriesOf(groupsOne.before), [[1, 'one-early-1', 1], [2, 'one-early-2', 1]]);
      assert.deepEqual(entriesOf(groupsOne.after), [[3, 'one-1', 1], [4, 'one-2', 1], [5, 'one-3', 1], [6, 'one-4', 1], [7, 'one-5', 1]]);
      assert.equal(groupsOne.after.more, 0, 'five entries are all listed — nothing left to count');
      assert.match(warningOne, /\n {2}Queued after it started \(5\):\n/);
      const [warningTwo] = warningsFor(two);
      assert.match(warningTwo, /has been held for \d+\.\ds, 2 waiting behind it/);
      const groupsTwo = waitingGroupsOf(warningTwo);
      assert.equal(groupsTwo.before, undefined);
      assert.deepEqual(entriesOf(groupsTwo.after), [[1, 'two-1', 1], [2, 'two-2', 1]]);
      // 위치를 기록하지 않아도 기다린 시간은 각자 줄 선 때부터다.
      const sinceEarly = (now - earlyQueuedFrom) / 1000;
      const sinceQueued = (now - queuedFrom) / 1000;
      for (const { label, waited, frames } of groupsOne.before.entries) {
        assert.equal(frames, null, `${label}: its call site was not recorded`);
        assert.ok(waited <= sinceEarly + 0.05, `${label} waiting for ${waited}s — no longer than since it was queued (${sinceEarly.toFixed(3)}s)`);
      }
      for (const { label, waited, frames } of [...groupsOne.after.entries, ...groupsTwo.after.entries]) {
        assert.equal(frames, null, `${label}: its call site was not recorded`);
        assert.ok(waited <= sinceQueued + 0.05, `${label} waiting for ${waited}s — no longer than since it was queued (${sinceQueued.toFixed(3)}s)`);
        assert.ok(waited >= WARN_MS / 1000 - 0.1, `${label} waiting for ${waited}s — it has waited since the held turn started`);
      }

      heldOne.release();
      heldTwo.release();
      await withinDeadlockTimeout(Promise.all([aheadOneDone, heldOne.done, heldTwo.done, ...early, ...waiters]));
    });

    it('a waiting turn leaves the list when it starts — the next long turn lists only what still waits behind it, and carries its own call site', async () => {
      const ds = await openDataSource({ stacks: '1' });
      const first = holdTransaction(ds, 'first-holder');
      await first.inside;
      const second = openSecondLongTransaction(ds); // 첫 차례 뒤에 줄 섰다가, 시작하면 자기도 오래 쥔다
      const third = afterSqljsTransactions(ds, async () => 'third: done', 'third-waiter');
      await until(() => warningsFor(ds).length === 1, 'the first turn\'s warning');
      assert.deepEqual(entriesOf(waitingGroupsOf(warningsFor(ds)[0]).after), [[1, 'transaction', 1], [2, 'third-waiter', 1]]);

      first.release();
      assert.equal(await withinDeadlockTimeout(first.done), 'first-holder: committed');
      await second.inside;
      await until(() => warningsFor(ds).length === 3, 'the second turn\'s warning, after the first one\'s release line');
      const secondWarning = warningsFor(ds)[2];
      const heldSide = secondWarning.slice(0, secondWarning.indexOf('\nWaiting behind it'));
      assert.match(heldSide, /the turn opened by "transaction" has been held for \d+\.\ds, 1 waiting behind it/);
      assert.match(heldSide, / Opened at:\n.*\n {4}at openSecondLongTransaction \(/s, 'listed as waiting before, it still has its own call site now that it holds the queue');
      const { before, after } = waitingGroupsOf(secondWarning);
      assert.deepEqual(
        entriesOf(before),
        [[1, 'third-waiter', 1]],
        'the turn that started is not listed as waiting behind itself; the one behind it was already waiting when it started',
      );
      assert.equal(after, undefined);

      second.release();
      assert.equal(await withinDeadlockTimeout(second.done), 'second: committed');
      assert.equal(await withinDeadlockTimeout(third), 'third: done');
    });

    it('a report made as a turn is released only counts the turns waiting — with call sites recorded, and turns queued both before and after it started', async () => {
      const ds = await openDataSource({ stacks: '1' });
      let queuedAfterStart;
      const blocking = ds.transaction(async () => {
        queuedAfterStart = inAnotherRequest(() => afterSqljsTransactions(ds, async () => 'late-after', 'late-after'));
        const busyUntil = performance.now() + WARN_MS * 1.5;
        while (performance.now() < busyUntil) {
          // 이벤트 루프를 막는다 — 그동안 감시 tick 이 돌 틈이 없다.
        }
        return 'blocking: committed';
      });
      const queuedBeforeStart = [
        afterSqljsTransactions(ds, async () => 'late-1', 'late-1'),
        afterSqljsTransactions(ds, async () => 'late-2', 'late-2'),
      ];
      assert.equal(await withinDeadlockTimeout(blocking), 'blocking: committed');
      assert.deepEqual(await withinDeadlockTimeout(Promise.all([...queuedBeforeStart, queuedAfterStart])), ['late-1', 'late-2', 'late-after']);
      await sleep(tickMsFor(WARN_MS) * 2);
      const lines = warningsFor(ds);
      assert.equal(lines.length, 1, `one report, made when the turn was released: ${JSON.stringify(lines)}`);
      assert.match(lines[0], /the turn opened by "transaction" was held for \d+\.\ds before it was released, 3 waiting behind it — .* Opened at:\n {4}at /s);
      assert.equal(waitingSectionOf(lines[0]), null, 'the turn was not deadlocked — the turns waiting are counted, not listed');
      assert.doesNotMatch(lines[0], /late-(1|2|after)/);
    });

    it('a warning that cannot be built — a waiting turn\'s name cannot be written — is dropped; the queue and the process go on', async () => {
      const ds = await openDataSource();
      const held = holdTransaction(ds, 'unwritable');
      await held.inside;
      const unwritableName = { toString() { throw new Error('this name cannot be written'); } };
      const waiter = afterSqljsTransactions(ds, async () => 'waiter: done', unwritableName);
      await sleep(WARN_MS * 2); // 감시 tick 이 경고를 만들다 실패한다
      held.release();
      assert.equal(await withinDeadlockTimeout(held.done), 'unwritable: committed');
      assert.equal(await withinDeadlockTimeout(waiter), 'waiter: done');

      const next = holdTransaction(ds, 'after-unwritable');
      await next.inside;
      const seenBefore = warningsFor(ds).length;
      await until(
        () => warningsFor(ds).slice(seenBefore).some((line) => line.includes('has been held')),
        'a warning for the next long turn — the watch still works',
      );
      next.release();
      assert.equal(await withinDeadlockTimeout(next.done), 'after-unwritable: committed');
    });

    it('a turn kept alive by what it left running keeps no other turn alive — turns are not linked to each other, also on a busy queue', async () => {
      const ds = await openDataSource();
      const collectGarbage = exposeGc();
      const leftRunning = [];
      // 차례 안에서 오래 사는 타이머를 건다 — 그 차례 객체를 AsyncLocalStorage 값으로 물고 있다.
      const leaveRunning = () => {
        const timer = setInterval(() => {}, 3_600_000);
        timer.unref();
        leftRunning.push(timer);
      };
      const settle = async () => {
        for (let i = 0; i < 5; i++) {
          collectGarbage();
          await sleep(10);
        }
      };
      // 바쁜 큐: 차례마다 다른 요청이, 앞 차례가 줄을 쥔 동안 다음 차례를 세운다. 첫 차례와 마지막 차례가 오래 사는 타이머를
      // 남긴다 — 어느 끝에서든 이웃 차례로 잇는 링크(앞 · 뒤에 선 차례, 쥐고 있던 차례)가 있으면 그 줄 전체가 산다.
      const runBusyQueue = (turns) => new Promise((resolve, reject) => {
        const step = (i) => afterSqljsTransactions(ds, async () => {
          if (i === 1 || i === turns) leaveRunning();
          if (i < turns) inAnotherRequest(() => { step(i + 1).catch(reject); });
          else resolve();
        }, 'passing');
        step(1).catch(reject);
      });
      try {
        await runBusyQueue(10);
        await settle();
        const heapBefore = process.memoryUsage().heapUsed;
        await runBusyQueue(30_000);
        await settle();
        const grownMiB = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
        assert.ok(
          grownMiB < 3,
          `the heap grew ${grownMiB.toFixed(1)} MiB over 30,000 turns run between two turns kept alive — they keep the turns next to them`,
        );
      } finally {
        for (const timer of leftRunning) clearInterval(timer);
      }
    });
  });

  it('the watch is one unref\'d interval per busy DataSource, not one per turn, and stops itself once the queue is idle', async () => {
    const tickMs = tickMsFor(WARN_MS);
    const created = [];
    const cleared = new Set();
    watchTimerHooks.setInterval = (fn, ms, ...args) => {
      const handle = realSetInterval(fn, ms, ...args);
      if (ms === tickMs) created.push(handle);
      return handle;
    };
    watchTimerHooks.clearInterval = (handle) => {
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
      watchTimerHooks.setInterval = null;
      watchTimerHooks.clearInterval = null;
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
    watchTimerHooks.setInterval = () => { throw new Error('setInterval is unavailable'); };
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
      watchTimerHooks.setInterval = null;
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

  it('node:test mock timers do not reach the watch — after a mocked window it still warns while a turn is held', async (t) => {
    const ds = await openDataSource();
    const accounts = ds.getRepository(Account);
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      // 가짜 setInterval 이 켜진 동안 첫 차례가 감시 주기를 건다.
      await withinDeadlockTimeout(accounts.save(accounts.create({ name: 'mocked-window', description: 'watch' })));
    } finally {
      t.mock.timers.reset();
    }
    const held = holdTransaction(ds, 'after-mocks');
    await held.inside;
    await until(
      () => warningsFor(ds).some((line) => line.includes('the turn opened by "transaction" has been held')),
      'a warning while the turn is still held — not only the late report',
    );
    held.release();
    assert.equal(await withinDeadlockTimeout(held.done), 'after-mocks: committed');
  });

  it('a call site that cannot be formatted leaves the rest of the warning — Error.prepareStackTrace throws', async () => {
    const ds = await openDataSource({ stacks: '1' });
    const held = holdTransaction(ds, 'unformattable');
    await held.inside;
    const waiter = afterSqljsTransactions(ds, async () => 'waiter: done', 'unformattable-waiter');
    const formatter = Error.prepareStackTrace;
    // 진짜 Error 만 받는다고 여기는 포매터 — 위치를 담은 평범한 객체에는 message 가 없다.
    Error.prepareStackTrace = (error) => error.message.trim();
    let warning;
    try {
      await until(() => warningsFor(ds).length === 1, 'the warning');
      [warning] = warningsFor(ds);
    } finally {
      Error.prepareStackTrace = formatter;
    }
    assert.match(
      warning,
      new RegExp(
        'the turn opened by "transaction" has been held for \\d+\\.\\ds, 1 waiting behind it — .* Opened at:\\n' +
          ' {4}\\(the call site could not be formatted — Error\\.prepareStackTrace threw\\)\\n' +
          'Waiting behind it, in queue order — .*:\\n' +
          ' {2}Queued after it started \\(1\\):\\n' +
          ' {4}1\\. "unformattable-waiter", waiting for \\d+\\.\\ds, queued at:\\n' +
          ' {8}\\(the call site could not be formatted — Error\\.prepareStackTrace threw\\)$',
        's',
      ),
      'neither call site could be formatted — the holder, the turn waiting behind it and the rest of the warning remain',
    );
    held.release();
    assert.equal(await withinDeadlockTimeout(held.done), 'unformattable: committed');
    assert.equal(await withinDeadlockTimeout(waiter), 'waiter: done');
  });

  it('the watch runs in the async context its queue was set up in, not in the request that happened to start it', async () => {
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

  it('a recorded call site is dropped when its turn is handed over — what the turn left running does not keep the caller alive', async () => {
    const ds = await openDataSource({ stacks: '1' });
    const collectGarbage = exposeGc();
    const leftRunning = [];
    class RequestScopedCaller {
      async write() {
        return ds.transaction(async () => {
          // 차례 안에서 만든 오래 사는 비동기 자원 — 차례 객체를 AsyncLocalStorage 값으로 물고 있다.
          const timer = setInterval(() => {}, 3_600_000);
          timer.unref();
          leftRunning.push(timer);
        });
      }
    }
    // 호출자는 이 함수 안에서만 산다. 끝나면 호출 위치의 프레임(receiver) 말고는 그것을 붙잡는 것이 없다.
    async function writeFromRequest() {
      const caller = new RequestScopedCaller();
      await caller.write();
      return new WeakRef(caller);
    }
    try {
      const callers = [];
      for (let i = 0; i < 3; i++) callers.push(await writeFromRequest());
      for (let i = 0; i < 5; i++) {
        collectGarbage();
        await sleep(10);
      }
      const alive = callers.filter((caller) => caller.deref() !== undefined).length;
      assert.equal(alive, 0, `${alive} of 3 callers are still alive after their turns, held by the timers their turns started`);
    } finally {
      for (const timer of leftRunning) clearInterval(timer);
    }
  });

  it('a turn handed over does not keep its work alive — a timer the turn left running does not keep what the callback used', async () => {
    const ds = await openDataSource(); // 위치를 기록하지 않는다 — 위치가 아니라 차례 자신이 붙잡는 것을 본다
    const collectGarbage = exposeGc();
    const leftRunning = [];
    // 차례 안에서 오래 사는 타이머를 건다. 타이머 자신의 closure 에는 요청의 것이 없다.
    function startLongLived() {
      const timer = setInterval(() => {}, 3_600_000);
      timer.unref();
      leftRunning.push(timer);
    }
    class RequestScopedCaller {
      async write() {
        return ds.transaction(async () => {
          this.writes = (this.writes ?? 0) + 1; // 콜백이 호출자를 쓴다 — 서비스의 콜백이 this.repo 를 쓰듯이
          startLongLived();
        });
      }
    }
    async function writeFromRequest() {
      const caller = new RequestScopedCaller();
      await caller.write();
      return new WeakRef(caller);
    }
    try {
      const callers = [];
      for (let i = 0; i < 3; i++) callers.push(await writeFromRequest());
      for (let i = 0; i < 5; i++) {
        collectGarbage();
        await sleep(10);
      }
      const alive = callers.filter((caller) => caller.deref() !== undefined).length;
      assert.equal(alive, 0, `${alive} of 3 callers are still alive after their turns, held through each turn's work by the timer it started`);
    } finally {
      for (const timer of leftRunning) clearInterval(timer);
    }
  });

  it('a write statement is named by its first word, and INSERT · REPLACE · UPDATE · DELETE by their table too (ticket c495ceaa)', () => {
    for (const [sql, expected] of [
      ['INSERT INTO "accounts"("id", "name") VALUES (?, ?)', 'INSERT accounts'],
      ['INSERT INTO "accounts"("id") VALUES (?) ON CONFLICT ( "id" ) DO UPDATE SET "name" = EXCLUDED."name"', 'INSERT accounts'],
      ['insert or replace into accounts (id) values (1)', 'INSERT accounts'],
      ['INSERT OR IGNORE INTO `channels` (id) VALUES (1)', 'INSERT channels'],
      ['REPLACE INTO [accounts] (id) VALUES (1)', 'REPLACE accounts'],
      ['UPDATE "accounts" SET "name" = ? WHERE "id" = ?', 'UPDATE accounts'],
      ['UPDATE OR IGNORE [channels] SET name = 1', 'UPDATE channels'],
      ['  DELETE FROM accounts WHERE name = ?', 'DELETE accounts'],
      ['\n\tdelete from "channels"', 'DELETE channels'],
      [`INSERT INTO "${'t'.repeat(80)}"(id) VALUES (1)`, `INSERT ${'t'.repeat(64)}`],
      ['PRAGMA user_version = 7', 'PRAGMA'],
      ['CREATE TABLE "x" ("id" integer)', 'CREATE'],
      ['WITH t AS (SELECT 1) INSERT INTO accounts SELECT * FROM t', 'WITH'],
      ['', 'STATEMENT'],
    ]) {
      assert.equal(sqljsStatementLabel(sql), expected, JSON.stringify(sql));
    }
  });

  it('the threshold: 30s when SQLJS_TURN_WARN_MS is unset or not a number, never below 50ms', () => {
    assert.equal(DEFAULT_SQLJS_TURN_WARN_MS, 30_000);
    for (const [raw, expected] of [
      [undefined, 30_000],
      ['', 30_000],
      ['soon', 30_000],
      ['30s', 30_000], // 숫자로 시작해도 숫자가 아니다 — 30ms(하한 50ms)로 읽히면 거의 모든 차례가 경고한다
      ['30_000', 30_000],
      ['0', 30_000],
      ['-5', 30_000],
      ['10', 50],
      ['1500', 1_500],
      [' 1500 ', 1_500],
      ['1e4', 10_000],
      ['1500.4', 1_500],
    ]) {
      assert.equal(withEnv({ SQLJS_TURN_WARN_MS: raw }, () => resolveSqljsTurnWarnMs()), expected, `SQLJS_TURN_WARN_MS=${raw}`);
    }
  });
});

// TypeORM/sql.js 는 이벤트 루프를 붙잡아 두는 핸들을 남긴다. 이 스위트는 `--test-force-exit` 로 실행돼
// 그런 핸들을 정리하고 node:test 가 계산한 실제 종료 코드로 끝난다 — 수동 process.exit() 은 그 코드를 덮어써
// 실패한 assertion 을 가릴 수 있으므로 쓰지 않는다.
