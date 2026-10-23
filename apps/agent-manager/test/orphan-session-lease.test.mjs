import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cleanupOrphanSubagents } from '../dist/lib/orphan-cleanup.js';
import {
  resolveLostCreateRace,
  isTransientLockRaceCode,
  waitForRecoveryGuard,
  RECOVERY_GUARD_TRANSIENT_LIMIT,
} from '../dist/lib/agent-lockfile.js';
import { currentBootIdentity, readProcessStartTicks } from '../dist/lib/boot-identity.js';

const tempDirs = [];
const children = [];
const lockModuleUrl = pathToFileURL(
  join(fileURLToPath(new URL('.', import.meta.url)), '../dist/lib/agent-lockfile.js'),
).href;

/** 결과 경쟁(Promise.race)에 쓰는 대기. unref 해 두어, 상대가 먼저 끝나면 남은 타이머가
 *  테스트 프로세스를 붙잡지 않는다. */
function sleep(ms, value) {
  return new Promise((resolve) => setTimeout(resolve, ms, value).unref());
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── 동시 contender 시작 배리어 ────────────────────────────────────────────
//
// 아래 두 레이스 테스트의 전제는 "두 contender 가 **같은 시점에** 같은 lock 상태를
// 보고 경쟁한다" 이다. 두 프로세스를 연달아 spawn 하는 것만으로는 그 전제가
// 보장되지 않는다 — 부하가 높은 러너(Windows CI 실측)에서는 두 번째 프로세스의
// 기동·ESM 로드가 수백 ms 늦어, 첫 번째가 이미 owner 가 된 뒤에 도착한다. 그러면
// 두 번째는 "동시 경쟁자" 가 아니라 **순차적인 두 번째 takeover** 가 되고, 이는
// --force 의 정상 동작이라 제품이 아니라 테스트만 red 가 된다.
//
// 그래서 contender 는 모듈 로드를 마친 뒤 READY 를 찍고 stdin 의 go 신호를
// 기다린다. 테스트가 둘 다 READY 인 것을 확인한 뒤에야 신호를 보내므로, 경쟁
// 시작 시점이 wall-clock 추측이 아니라 happens-before 로 고정된다.
// `destroy()` 는 필수다 — 신호를 읽고 나서 stdin 파이프를 열어두면 그 핸들이
// 이벤트 루프를 붙잡아 contender 가 영원히 종료하지 않는다(`pause()` 만으로는
// unref 되지 않는다).
const BARRIER_PROLOGUE = `
  process.stdout.write('READY\\n');
  await new Promise((resolve) => process.stdin.once('data', () => {
    process.stdin.destroy();
    resolve();
  }));
`;

// ── 이긴 쪽의 보유 시간 ───────────────────────────────────────────────────
//
// 레이스 테스트에서 이긴 쪽은 **진 쪽이 판정을 마칠 때까지** lock 을 쥔다. 정해진
// 시간만 쥐면, 느린 러너에서 진 쪽이 그 뒤에야 lock 을 읽어 이미 풀린 lock 을
// 정당하게 취득한다. 그건 동시 경쟁이 아니라 순차 취득이라 ACQUIRED 가 2 가 되고,
// 제품이 아니라 이 테스트의 전제만 깨진다. 진 쪽의 가드 대기는 삭제 대기 errno 를
// 그 자리에서 기다리므로(티켓 b14c5669) 그만큼 늦어질 수 있다. 진 쪽은 거절되는 즉시
// 표시를 남기고, 이긴 쪽은 그 표시를 볼 때까지 쥔다. 둘 다 이기는 버그에서도
// 테스트가 끝나도록 상한(10초)을 둔다.
const MARK_LOSER_DECIDED = `
  (await import('node:fs')).writeFileSync(
    (await import('node:path')).join(process.env.AWB_AGENT_MANAGER_HOME, 'race-loser-decided'),
    '',
  );
`;
const HOLD_UNTIL_LOSER_DECIDED = `
  {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const decided = join(process.env.AWB_AGENT_MANAGER_HOME, 'race-loser-decided');
    const until = Date.now() + 10_000;
    while (!existsSync(decided) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
`;

// ── 취득 확인 ─────────────────────────────────────────────────────────────
//
// contender 는 lock 파일이 자기를 가리킬 때만 취득을 알린다. promise 가 풀렸다는
// 것만으로 알리면, lock 을 만들지 못하고도 성공을 돌려주는 버그(가짜 취득 — 예:
// 재생성의 일시적 errno 를 삼키기)가 모든 단언을 통과한다. 확인에 실패하면
// `PHANTOM_LOCK:<디스크의 lock>` 을 찍는다.
const lockedByMe = `(await import(${JSON.stringify(lockModuleUrl)})).inspectAgentLock()?.pid === process.pid`;
const PRINT_ACQUIRED = `
  if (${lockedByMe}) console.log('ACQUIRED');
  else console.log('PHANTOM_LOCK:' + JSON.stringify((await import(${JSON.stringify(lockModuleUrl)})).inspectAgentLock()));
`;
// owner 가 가짜로 취득했으면 준비를 알리지 않고 끝난다 — 기다리는 쪽이 곧바로 실패한다.
const PRINT_OWNER_READY = `
  if (!(${lockedByMe})) {
    console.log('PHANTOM_LOCK');
    process.exit(1);
  }
  console.log('OWNER_READY');
`;

/** 배리어를 지키는 contender 를 띄운다. `ready` 는 READY 수신, `done` 은 종료.
 *  `awaitStderr(needle)` 는 contender 의 진행 상황을 제품 로그로 관찰하는 용도다
 *  — 제품 로그는 stderr 로 나가므로 stdout 마커(ACQUIRED/REJECTED)와 섞이지
 *  않는다. 관찰한 내용은 CI 진단이 사라지지 않도록 부모 stderr 로도 흘린다. */
function spawnBarrieredContender(source, env, spawnChild = spawn) {
  const child = spawnChild(process.execPath, ['--input-type=module', '-e', source], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  // contender 가 신호를 읽자마자 stdin 을 destroy 하므로, 부모의 write 가
  // EPIPE 로 끝날 수 있다 — 리스너가 없으면 테스트 프로세스가 죽는다.
  child.stdin.on('error', () => {});
  let output = '';
  child.stdout.setEncoding('utf8');
  let signalReady;
  const ready = new Promise((resolve) => { signalReady = resolve; });
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.includes('READY')) signalReady();
  });

  let stderrText = '';
  const stderrWaiters = new Set();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrText += chunk;
    process.stderr.write(chunk);
    for (const waiter of [...stderrWaiters]) {
      if (stderrText.includes(waiter.needle)) {
        stderrWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  });
  const awaitStderr = (needle) => new Promise((resolve) => {
    if (stderrText.includes(needle)) resolve();
    else stderrWaiters.add({ needle, resolve });
  });

  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    // close follows stdout/stderr draining; exit alone can lose the last marker.
    child.once('close', (code, signal) => resolve({ code, signal, output, stderr: stderrText }));
  });
  return { child, ready, done, awaitStderr, stderrNow: () => stderrText };
}

/** 둘 다 READY 가 될 때까지 기다린 뒤 동시에 출발시키고 결과를 모은다.
 *  `afterGo` 는 출발 직후 한 번 실행되는 훅으로, 출발만으로는 고정되지 않는
 *  전제를 마저 고정할 때 쓴다(아래 force 레이스의 인수 가드 배리어). 훅 안에서
 *  contender 가 죽어도 무한 대기하지 않도록 조기 종료와 race 시킨다. */
async function raceContenders(source, env, afterGo) {
  const contenders = [spawnBarrieredContender(source, env), spawnBarrieredContender(source, env)];
  const earlyExits = contenders.map((c) => {
    // 배리어 도달 전에 죽으면 무한 대기 대신 그 사실을 즉시 드러낸다.
    const earlyExit = c.done.then(({ code, output }) => {
      throw new Error(`contender가 배리어 도달 전에 종료됨: code=${code} output=${JSON.stringify(output)}`);
    });
    earlyExit.catch(() => {}); // race 가 끝난 뒤 남는 rejection 흡수
    return earlyExit;
  });
  await Promise.all(contenders.map((c, i) => Promise.race([c.ready, earlyExits[i]])));
  for (const c of contenders) c.child.stdin.write('go\n');
  if (afterGo) await Promise.race([afterGo(contenders), ...earlyExits]);
  return Promise.all(contenders.map((c) => c.done));
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && alive(child.pid)) process.kill(child.pid, 'SIGKILL');
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

test('contender result waits for output pipes after process exit', async () => {
  // Model the documented ChildProcess ordering directly: exit may precede
  // final pipe data. Inheriting a grandchild's stdio is not portable to Windows.
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const contender = spawnBarrieredContender('', process.env, () => child);
  child.stdout.write('READY\n');
  await contender.ready;
  child.emit('exit', 0, null);
  child.stdout.end('REJECTED:EAGENTLOCKED\n');
  child.stderr.end('LATE_DIAGNOSTIC\n');
  child.emit('close', 0, null);
  const result = await contender.done;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.output, /REJECTED:EAGENTLOCKED/);
  assert.match(result.stderr, /LATE_DIAGNOSTIC/);
  child.stdin.destroy();
});

test('manager 재시작 orphan 정리는 이전 CLI 종료를 확인한 뒤 sidecar를 회수한다', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'awb-session-lease-'));
  tempDirs.push(dir);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: false,
  });
  children.push(child);
  assert.ok(child.pid);

  const cfg = join(dir, 'cfg-chat-room-a.json');
  const pid = join(dir, 'cfg-chat-room-a.pid');
  await fsp.writeFile(cfg, '{}');
  await fsp.writeFile(pid, String(child.pid));

  const result = await cleanupOrphanSubagents(dir);

  assert.deepEqual(result, { scanned: 1, reaped: 1, skipped: 0, failed: 0, failedPids: [] });
  assert.equal(alive(child.pid), false, '정리 완료 시점에는 이전 CLI 프로세스가 종료돼야 한다');
  await assert.rejects(fsp.access(cfg));
  await assert.rejects(fsp.access(pid));
});

test('force takeover는 이전 manager 종료 전에 새 lock 소유권을 공개하지 않는다', async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-lock-'));
  tempDirs.push(home);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const ownerSource = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    await acquireAgentLock({ role: 'manager', version: 'old' });
    ${PRINT_OWNER_READY}
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 350));
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', ownerSource], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(owner);
  await new Promise((resolve, reject) => {
    owner.stdout.setEncoding('utf8');
    owner.stdout.on('data', (chunk) => {
      if (chunk.includes('OWNER_READY')) resolve();
    });
    owner.once('error', reject);
    owner.once('exit', (code) => reject(new Error(`owner가 준비 전에 종료됨: ${code}`)));
  });

  const contenderSource = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    const started = Date.now();
    const lock = await acquireAgentLock({ role: 'manager', version: 'new', force: true });
    console.log((${lockedByMe} ? 'ACQUIRED:' : 'PHANTOM_LOCK:') + (Date.now() - started));
    lock.release();
  `;
  const contender = spawn(process.execPath, ['--input-type=module', '-e', contenderSource], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(contender);
  let output = '';
  contender.stdout.setEncoding('utf8');
  contender.stdout.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    contender.once('exit', resolve);
    contender.once('error', reject);
  });

  assert.equal(code, 0);
  assert.match(output, /ACQUIRED:\d+/, 'contender가 새 lock 소유권을 취득해야 한다');
  assert.equal(alive(owner.pid), false, '새 소유권 공개 시점에는 이전 manager가 종료돼야 한다');
});

test('동시 force contender 둘 중 정확히 하나만 종료된 owner의 lock을 취득한다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-lock-race-'));
  tempDirs.push(home);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const ownerSource = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    await acquireAgentLock({ role: 'manager', version: 'old' });
    ${PRINT_OWNER_READY}
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250));
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', ownerSource], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(owner);
  await new Promise((resolve, reject) => {
    owner.stdout.setEncoding('utf8');
    owner.stdout.on('data', (chunk) => chunk.includes('OWNER_READY') && resolve());
    owner.once('error', reject);
    owner.once('exit', (code) => reject(new Error(`owner가 준비 전에 종료됨: ${code}`)));
  });

  const contenderSource = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    ${BARRIER_PROLOGUE}
    try {
      const lock = await acquireAgentLock({ role: 'manager', version: 'new', force: true });
      ${PRINT_ACQUIRED}
      ${HOLD_UNTIL_LOSER_DECIDED}
      lock.release();
    } catch (error) {
      console.log('REJECTED:' + error.code);
      console.error('CONTENDER_ERROR:' + JSON.stringify({ pid: process.pid, code: error.code, message: error.message, stack: error.stack }));
      ${MARK_LOSER_DECIDED}
    }
  `;

  // ── 인수 가드 배리어 ──────────────────────────────────────────────────
  //
  // READY/go 배리어는 두 contender 의 **출발**만 맞춘다. 출발한 뒤 lock 을 읽기
  // 까지 수백 ms 밀리면(4-vCPU Windows 러너 실측) 늦은 쪽은 원래 owner 가 아니라
  // **먼저 이긴 동료의 lock** 을 읽는다 — 그건 동시 경쟁이 아니라 순차 takeover
  // 이고 --force 의 정상 동작이라, 제품이 아니라 이 테스트의 전제만 깨진다.
  //
  // 그래서 회수 가드(agent.lock.recovery)를 테스트가 먼저 잡아 둔다. 가드를 잡고
  // 있는 동안에는 아무도 새 lock 을 설치할 수 없으므로, 두 contender 가 읽는
  // owner 는 반드시 원래 owner 다. 둘 다 "가드 대기" 를 찍은 것을 확인한 뒤에야
  // 놓아 주므로, 경쟁 전제가 벽시계 추측이 아니라 happens-before 로 고정된다.
  // 가드 소유자 pid 를 이 테스트 프로세스로 적어 두면 stale 회수 대상이 아니다.
  const recoveryLock = join(home, 'agent.lock.recovery');
  await fsp.mkdir(recoveryLock);
  await fsp.writeFile(join(recoveryLock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  const awaitingGuard = `--force: waiting for takeover guard (owner pid=${owner.pid}`;

  const results = await raceContenders(contenderSource, env, async (contenders) => {
    await Promise.all(contenders.map((c) => c.awaitStderr(awaitingGuard)));
    await fsp.rm(recoveryLock, { recursive: true, force: true });
  });
  // 진 contender 는 정상적으로 거절되고 스스로 빠져나가야 한다. 여기서 0 이 아닌
  // 코드가 나오면 진 쪽이 이긴 쪽에게 force-kill 당했다는 뜻이다(Windows 는
  // 원격 SIGTERM 을 TerminateProcess 로 흉내내 exit code 1 을 남긴다).
  const diagnostics = JSON.stringify(results, null, 2);
  assert.deepEqual(results.map(({ code }) => code), [0, 0], diagnostics);
  assert.equal(results.filter(({ output }) => output.includes('ACQUIRED')).length, 1, diagnostics);
  assert.equal(results.filter(({ output }) => output.includes('REJECTED:EAGENTLOCKED')).length, 1, diagnostics);
});

for (const fixture of [
  { name: 'stale', contents: JSON.stringify({ pid: 999_999_999, role: 'manager' }) },
  { name: 'unparseable', contents: '{not-json' },
]) {
  test(`${fixture.name} lock 동시 회수에서도 새 owner lock을 삭제하지 않는다`, { timeout: 60_000 }, async () => {
    const home = await fsp.mkdtemp(join(tmpdir(), `awb-manager-${fixture.name}-race-`));
    tempDirs.push(home);
    await fsp.writeFile(join(home, 'agent.lock'), fixture.contents);
    const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
    const contenderSource = `
      const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
      ${BARRIER_PROLOGUE}
      try {
        const lock = await acquireAgentLock({ role: 'manager', version: 'new' });
        ${PRINT_ACQUIRED}
        ${HOLD_UNTIL_LOSER_DECIDED}
        lock.release();
      } catch (error) {
        console.log('REJECTED:' + error.code);
        ${MARK_LOSER_DECIDED}
      }
    `;
    if (fixture.name === 'unparseable') {
      const results = await raceContenders(contenderSource, env);
      assert.ok(results.every(({ output }) => output.includes('REJECTED:EAGENTLOCKINVALID')));
      assert.equal(await fsp.readFile(join(home, 'agent.lock'), 'utf8'), fixture.contents);
      return;
    }
    // ── 회수 진입 배리어 ──────────────────────────────────────────────────
    //
    // READY/go 배리어는 두 contender 의 **출발**만 맞춘다. 출발한 뒤 회수 경로에
    // 닿기까지 수백 ms 밀리면(4-vCPU Windows 러너 실측) 늦은 쪽은 이미 이긴
    // 동료가 보유 시간(당시 300ms)이 지나 풀어준 **빈 lock** 을 만나 정당하게 취득한다 — 그건
    // 동시 회수가 아니라 순차 취득이라, 제품이 아니라 이 테스트의 전제만 깨진다.
    // 실측 로그가 정확히 그 모양이었다: acquire(pid=10588) → released →
    // acquire(pid=10356) → released 로 겹침이 0 이고, 그래서 ACQUIRED 가 2 였다.
    // (같은 run 의 stale fixture 는 "reusing stale lock" 이 두 번 찍혀 실제로
    // 겹쳤고 취득은 1 이었다 — 상호배제 자체는 그때도 지켜졌다.)
    //
    // 그래서 형제 --force 테스트와 같은 방식으로 회수 가드를 테스트가 먼저 잡아
    // 둔다. 가드를 쥐고 있는 동안에는 아무도 회수를 끝낼 수 없으므로, 두
    // contender 가 모두 "가드 대기" 를 찍은 것을 확인한 뒤 놓아 주면 둘 다 자기
    // 첫 O_EXCL create 를 이미 실패한 채 회수 경로 안에 들어와 있음이 벽시계
    // 추측이 아니라 happens-before 로 고정된다. 가드 owner pid 를 이 테스트
    // 프로세스로 적어 두면 stale 회수 대상이 아니다.
    const recoveryLock = join(home, 'agent.lock.recovery');
    await fsp.mkdir(recoveryLock);
    await fsp.writeFile(join(recoveryLock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    const awaitingGuard = 'waiting for recovery guard before stale-cleanup';

    const outputs = (
      await raceContenders(contenderSource, env, async (contenders) => {
        await Promise.all(contenders.map((c) => c.awaitStderr(awaitingGuard)));
        await fsp.rm(recoveryLock, { recursive: true, force: true });
      })
    ).map(({ output }) => output);
    assert.equal(outputs.filter((output) => output.includes('ACQUIRED')).length, 1);
    // 진 쪽은 반드시 소유권 오류(EAGENTLOCKED)여야 한다. 회수 경로가 create
    // 레이스에서 지면 예전에는 raw `EEXIST` 가 그대로 새어 나왔다 — 그 누수를
    // 다시 들이면 이 단언이 정확히 그 지점에서 깨진다.
    assert.equal(
      outputs.filter((output) => output.includes('REJECTED:EAGENTLOCKED')).length,
      1,
      `진 contender는 EAGENTLOCKED로 거절돼야 한다: ${JSON.stringify(outputs)}`,
    );
  });
}

// ── 회수 경로가 create 레이스에서 졌을 때의 판정 (티켓 6fd625bb) ────────────
//
// 회수 가드(acquireRecoveryLock)는 stale-cleanup 경로에 들어온 contender 만
// 직렬화한다. 갓 시작한 contender 의 **첫 시도** O_EXCL create 는 가드를 거치지
// 않으므로, 회수 경로가 unlink 한 직후 create 하기 전 사이에 파일을 선점할 수
// 있다. Windows CI 에서 실제로 그 창이 열렸고(파일 연산이 느려 창이 넓다),
// 회수 경로가 raw `EEXIST` 를 그대로 올려 `EAGENTLOCKED` 를 기대하는 호출자에게
// fs 오류 코드가 새어 나갔다 — 위 "unparseable lock 동시 회수" 가 그때 red 였다.
//
// 창 자체는 O_EXCL 의미상 없앨 수 없으므로 결과를 다시 판정한다. 그 판정 규칙은
// 순수 함수 + 의존성 주입이라, 재현 불가능한 실제 프로세스 레이스를 흉내내지
// 않고도 두 분기를 결정적으로 검증할 수 있다.
test('create 레이스에서 살아있는 승자에게 지면 EAGENTLOCKED로 판정한다', () => {
  const winner = { pid: 4242, role: 'manager', version: 'new', started_at: 'now' };
  const verdict = resolveLostCreateRace(() => winner, (pid) => pid === 4242);
  assert.equal(verdict.outcome, 'locked');
  assert.deepEqual(verdict.owner, winner, '거절 메시지에 실제 승자 정보가 실려야 한다');
});

test('create 레이스 승자가 이미 죽었으면 재시도로 판정한다 — 죽은 lock에 갇히지 않는다', () => {
  const dead = { pid: 999_999_999, role: 'manager' };
  assert.deepEqual(resolveLostCreateRace(() => dead, () => false), { outcome: 'retry' });
});

test('create 레이스 직후 lock이 사라졌거나 읽을 수 없으면 재시도로 판정한다', () => {
  // readLock 은 unparseable/pid<=0/파일없음 을 모두 null 로 degrade 한다.
  assert.deepEqual(resolveLostCreateRace(() => null, () => true), { outcome: 'retry' });
});

// ── Windows 삭제 대기 errno 누수 (티켓 4667de43, flake-repro shard2 round4 실측) ──
//
// 회수 진입 배리어를 넣어 두 contender 가 **실제로 겹치기 시작**하자 그 다음 결함이
// 드러났다: 진 contender 가 `EAGENTLOCKED` 가 아니라 raw `EPERM` 으로 거절됐다
// (관측 출력 `["READY\nACQUIRED\n","READY\nREJECTED:EPERM\n"]`). 취득은 정확히
// 1건이라 상호배제 자체는 지켜졌고 **오류 계약만** 샜다. Windows 는 삭제 대기
// 상태의 파일·디렉터리에 대한 create/mkdir 을 EEXIST 가 아니라 EPERM 으로 거절한다.
test('삭제 대기 errno(EPERM/EACCES/EBUSY)는 일시적 레이스로 분류된다', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    assert.equal(isTransientLockRaceCode(code), true, `${code} 는 일시적 레이스여야 한다`);
  }
  // EEXIST/ENOENT 는 이미 각 호출부가 제 의미로 처리한다 — 여기로 접으면 안 된다.
  for (const code of ['EEXIST', 'ENOENT', 'EROFS', 'EAGENTLOCKED', undefined]) {
    assert.equal(isTransientLockRaceCode(code), false, `${code} 는 접으면 안 된다`);
  }
});

// 분류만 맞고 실제 acquire 경로가 안 바뀌면 의미가 없으므로 **제품 경로의 결과**로
// 검증한다. 영구적인 권한 오류를 만들어 두고 (1) 재시도 상한이 있어 스스로 끝나는지,
// (2) 상한을 넘겼을 때 합성한 ELOCKRACE 가 아니라 **원본 errno** 가 올라오는지 본다.
// 원본을 잃으면 진짜 권한 문제가 "레이스" 로 위장돼 진단이 불가능해진다.
test('권한 오류가 계속되면 합성 ELOCKRACE 가 아니라 원본 errno 가 올라온다', async (t) => {
  if (process.platform === 'win32') {
    t.skip('chmod 기반 권한 차단이 Windows 에서 같은 의미를 갖지 않는다');
    return;
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 는 쓰기 권한 차단을 무시한다');
    return;
  }
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-perm-'));
  tempDirs.push(home);
  // lock 파일 생성 자체가 막히도록 홈을 읽기 전용으로 만든다. 정리(rm)가 가능하도록
  // 단언 전에 되돌린다 — afterEach 의 rm 이 읽기 전용 디렉터리에서 실패하면 안 된다.
  await fsp.chmod(home, 0o500);

  const source = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    try {
      await acquireAgentLock({ role: 'manager', version: 'new' });
      console.log('ACQUIRED');
    } catch (error) { console.log('REJECTED:' + error.code); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, AWB_AGENT_MANAGER_HOME: home },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  await fsp.chmod(home, 0o700);

  assert.equal(code, 0, '재시도 상한이 있어 스스로 끝나야 한다 (무한 루프 금지)');
  assert.match(out, /REJECTED:(EACCES|EPERM)/, `원본 errno 가 보존돼야 한다: ${JSON.stringify(out)}`);
  assert.doesNotMatch(out, /ELOCKRACE/, '합성한 레이스 코드가 호출자에게 새면 안 된다');
});

// ── 회수 가드 mkdir 의 삭제 대기 (티켓 b14c5669, run 39970880454 실측) ──────────
//
// 위 접기 이후에도 "동시 force contender" 가 `REJECTED:EPERM` 으로 다시 졌다. 이번
// 스택은 force 경로의 가드 mkdir(`acquireRecoveryLock`)이었다 — 삭제 대기 errno
// 를 접는 처리가 stale 경로에만 있었다. force 경로에는 바깥에서 다시 도는 처리를
// 넣을 수 없다: 다시 돌면 가드를 기다리기 전에 관측한 owner 를 잃고, 그사이 인수를
// 끝낸 동료를 새 owner 로 읽어 죽인다. 그래서 가드 획득 루프가 그 자리에서 기다린다.
function fsError(code) {
  return Object.assign(new Error(`${code}: simulated, mkdir 'agent.lock.recovery'`), { code });
}

/** create 가 outcomes 를 차례로 던지고, 다 쓰면 성공하는 가드 연산. */
function scriptedGuard(outcomes, { reclaim = () => false } = {}) {
  const calls = [];
  const transients = [];
  const ops = {
    create: () => {
      calls.push('create');
      const next = outcomes.shift();
      if (next) throw next;
    },
    reclaimStale: () => {
      calls.push('reclaim');
      return reclaim();
    },
    pause: async () => {
      calls.push('pause');
    },
    onTransient: (err, streak) => transients.push([err.code, streak]),
  };
  return { ops, calls, transients };
}

test('회수 가드 대기: 삭제 대기 errno 는 회수 없이 한 박자 쉬고 다시 만든다', async () => {
  const { ops, calls, transients } = scriptedGuard([fsError('EPERM'), fsError('EACCES'), fsError('EBUSY')]);
  await waitForRecoveryGuard(ops);
  assert.deepEqual(calls, ['create', 'pause', 'create', 'pause', 'create', 'pause', 'create']);
  assert.deepEqual(transients, [['EPERM', 1], ['EACCES', 2], ['EBUSY', 3]]);
});

/** create 가 늘 같은 오류를 던지는 가드 연산. 상한 없이 도는 루프가 테스트를
 *  멈춰 세우지 않도록, 지나치게 오래 쉬면 실패한다. */
function failingGuard(original) {
  const state = { creates: 0 };
  const ops = {
    create: () => {
      state.creates += 1;
      throw original;
    },
    reclaimStale: () => assert.fail('삭제 대기 errno 에서는 회수를 시도하지 않는다'),
    pause: async () => {
      if (state.creates > 10_000) throw new Error('상한 없이 계속 기다린다');
    },
  };
  return { ops, state };
}

test('회수 가드 대기: 삭제 대기 errno 가 연달아 상한에 닿으면 원본 오류를 그대로 올린다', async () => {
  const original = fsError('EACCES');
  const { ops, state } = failingGuard(original);
  await assert.rejects(waitForRecoveryGuard(ops, 4), (err) => err === original);
  assert.equal(state.creates, 4);
});

test('회수 가드 대기: 기본 상한도 유한하다 — 영구 권한 오류에서 끝난다', async () => {
  const original = fsError('EPERM');
  const { ops, state } = failingGuard(original);
  await assert.rejects(waitForRecoveryGuard(ops), (err) => err === original);
  assert.equal(state.creates, RECOVERY_GUARD_TRANSIENT_LIMIT);
});

for (const reclaimed of [false, true]) {
  test(`회수 가드 대기: 남이 쥔 가드(EEXIST)를 보면 연속 횟수를 처음부터 다시 센다 (회수 ${reclaimed ? '성공' : '안 함'})`, async () => {
    // 상한이 3 이어도 끝나지 않는다 — 가드를 오래 쥔 동료들이 차례로 놓을 때마다
    // 삭제 대기를 한 번씩 만나는 경우다. 그건 권한 오류가 아니다.
    const { ops, calls, transients } = scriptedGuard(
      [fsError('EPERM'), fsError('EPERM'), fsError('EEXIST'), fsError('EPERM'), fsError('EPERM')],
      { reclaim: () => reclaimed },
    );
    await waitForRecoveryGuard(ops, 3);
    assert.deepEqual(transients, [['EPERM', 1], ['EPERM', 2], ['EPERM', 1], ['EPERM', 2]]);
    assert.deepEqual(calls, [
      'create', 'pause', 'create', 'pause',
      'create', 'reclaim', ...(reclaimed ? [] : ['pause']),
      'create', 'pause', 'create', 'pause',
      'create',
    ]);
  });
}

test('회수 가드 대기: EEXIST 에서 회수했으면 쉬지 않고 바로 다시 만든다', async () => {
  const { ops, calls } = scriptedGuard([fsError('EEXIST')], { reclaim: () => true });
  await waitForRecoveryGuard(ops);
  assert.deepEqual(calls, ['create', 'reclaim', 'create']);
});

test('회수 가드 대기: 삭제 대기도 EEXIST 도 아닌 오류는 기다리지 않고 바로 올린다', async () => {
  for (const code of ['ENOENT', 'EROFS', 'ENOSPC']) {
    const original = fsError(code);
    const { ops, calls } = scriptedGuard([original]);
    await assert.rejects(waitForRecoveryGuard(ops), (err) => err === original);
    assert.deepEqual(calls, ['create'], code);
  }
});

/** lock 을 쥐고 가만히 있는 manager. 준비되면 돌려준다. */
async function startLockOwner(env, version) {
  const source = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    await acquireAgentLock({ role: 'manager', version: ${JSON.stringify(version)} });
    ${PRINT_OWNER_READY}
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(owner);
  await new Promise((resolve, reject) => {
    owner.stdout.setEncoding('utf8');
    owner.stdout.on('data', (chunk) => chunk.includes('OWNER_READY') && resolve());
    owner.once('error', reject);
    owner.once('exit', (code) => reject(new Error(`owner(${version})가 준비 전에 종료됨: ${code}`)));
  });
  return owner;
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

// 위 대기 규칙이 실제 force 경로에서 **관측한 owner 를 지키는지** 본다. Windows 의
// 삭제 대기는 이 호스트에서 만들 수 없으므로 contender 의 `fs.mkdirSync` 를 감싸
// 흉내 낸다(`syncBuiltinESMExports` 가 lock 모듈의 named import 까지 바꾼다). 흉내는
// 스스로 끝난다 — 가드 경로 mkdir 을 세 번만 EPERM 으로 거절한다. 그래서 테스트가
// 느리게 반응해도 상한(RECOVERY_GUARD_TRANSIENT_LIMIT)에 닿지 않는다.
//
// 장면: 테스트가 "먼저 이긴 동료" 역할을 한다. 가드를 쥔 채 원래 owner 를 끝내고 새
// owner 를 세운 뒤 가드를 놓는다. 그 순간 진 contender 의 mkdir 이 삭제 대기를
// 만난다 — run 39970880454 와 같은 자리다. 결과는 수정 방식에 따라 갈린다.
//   - 수정 없음: 그 EPERM 이 그대로 올라와 REJECTED:EPERM.
//   - 바깥에서 처음부터 다시 도는 수정: 새 owner 를 다시 관측하고, 그것을 죽인 뒤 ACQUIRED.
//   - 그 자리에서 기다리는 수정: 가드를 잡고 owner 가 바뀐 것을 보고 EAGENTLOCKED.
test('force contender 는 회수 가드 삭제 대기(EPERM)에서 관측한 owner 를 잃지 않는다 — 먼저 인수를 끝낸 동료를 죽이지 않고 EAGENTLOCKED', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-pending-'));
  tempDirs.push(home);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const lockPath = join(home, 'agent.lock');
  const recoveryLock = `${lockPath}.recovery`;
  const pendingMarker = join(home, 'simulate-guard-delete-pending');

  const original = await startLockOwner(env, 'old');

  // 가드를 테스트가 먼저 쥔다 — contender 가 owner 를 관측한 뒤 가드 앞에서 기다리게.
  await fsp.mkdir(recoveryLock);
  await fsp.writeFile(join(recoveryLock, 'owner.json'), JSON.stringify({ pid: process.pid }));

  const contenderSource = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const guardPath = ${JSON.stringify(recoveryLock)};
    const pendingMarker = ${JSON.stringify(pendingMarker)};
    const realMkdirSync = fs.mkdirSync;
    let simulated = 0;
    fs.mkdirSync = function (path, ...rest) {
      if (path === guardPath && simulated < 3 && fs.existsSync(pendingMarker)) {
        simulated += 1;
        process.stderr.write('SIMULATED_DELETE_PENDING\\n');
        throw Object.assign(new Error("EPERM: operation not permitted, mkdir '" + path + "'"), {
          code: 'EPERM', errno: -4048, syscall: 'mkdir', path,
        });
      }
      return realMkdirSync.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    try {
      const lock = await acquireAgentLock({ role: 'manager', version: 'new', force: true });
      console.log('ACQUIRED');
      lock.release();
    } catch (error) {
      console.log('REJECTED:' + error.code);
      console.error('CONTENDER_ERROR:' + JSON.stringify({ code: error.code, message: error.message }));
    }
  `;
  const contender = spawnBarrieredContender(contenderSource, env);
  const endedEarly = contender.done.then((result) => {
    throw new Error(`contender가 가드 앞에 닿기 전에 종료됨: ${JSON.stringify(result)}`);
  });
  endedEarly.catch(() => {});
  await Promise.race([
    contender.awaitStderr(`--force: waiting for takeover guard (owner pid=${original.pid}`),
    endedEarly,
  ]);

  // 먼저 이긴 동료의 인수: 원래 owner 를 끝내고 그 lock 을 지운 뒤 새 owner 를 세운다.
  // 새 owner 는 가드가 필요 없는 첫 create 로 들어온다(lock 이 비어 있으므로).
  original.kill('SIGKILL');
  await waitForExit(original);
  await fsp.rm(lockPath, { force: true });
  const peer = await startLockOwner(env, 'peer');

  // 가드를 놓는다. 표시를 먼저 만들어야 contender 가 그 사이 진짜 mkdir 로 가드를
  // 잡지 않는다 — 그러면 흉내가 걸리지 않고 이 테스트는 아무것도 증명하지 못한다.
  await fsp.writeFile(pendingMarker, '');
  await fsp.rm(recoveryLock, { recursive: true, force: true });
  const result = await contender.done;

  const diagnostics = JSON.stringify({ original: original.pid, peer: peer.pid, result }, null, 2);
  const simulatedHits = result.stderr.split('SIMULATED_DELETE_PENDING').length - 1;
  assert.ok(simulatedHits >= 1, `삭제 대기 흉내가 걸려야 한다: ${diagnostics}`);
  assert.equal(result.code, 0, diagnostics);
  assert.match(result.output, /REJECTED:EAGENTLOCKED/, diagnostics);
  assert.doesNotMatch(result.output, /ACQUIRED/, diagnostics);
  assert.equal(alive(peer.pid), true, `먼저 인수를 끝낸 동료(새 owner)를 죽이면 안 된다: ${diagnostics}`);
  assert.deepEqual(
    result.stderr.match(/--force: waiting for takeover guard \(owner pid=\d+/g),
    [`--force: waiting for takeover guard (owner pid=${original.pid}`],
    `owner 는 가드를 기다리기 전에 한 번만 관측해야 한다: ${diagnostics}`,
  );
  assert.equal(JSON.parse(await fsp.readFile(lockPath, 'utf8')).pid, peer.pid, diagnostics);
  assert.equal(simulatedHits, 3, `흉내 낸 삭제 대기를 모두 그 자리에서 기다려야 한다: ${diagnostics}`);
});

// stale 경로도 가드 획득이 스스로 기다리므로, 상한을 다 쓴 영구 오류를 바깥 루프가
// 다시 돌리지 않는다 — 다시 돌리면 같은 대기(약 2초)를 MAX_ACQUIRE_ATTEMPTS 번
// 되풀이한 뒤에야 같은 오류를 낸다.
test('stale lock 회수 중 가드 mkdir 권한 오류가 계속되면 회수를 한 번만 시도하고 원본 errno 로 끝난다', { timeout: 30_000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('chmod 기반 권한 차단이 Windows 에서 같은 의미를 갖지 않는다');
    return;
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 는 쓰기 권한 차단을 무시한다');
    return;
  }
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-perm-'));
  tempDirs.push(home);
  await fsp.writeFile(join(home, 'agent.lock'), JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  // lock 은 이미 있어 첫 create 는 EEXIST 로 지고 stale 회수로 들어간다. 가드 mkdir 만
  // 권한 오류를 받는다.

  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      // The initial temporary file has already been cleaned up. Deny only
      // subsequent guard creation, preserving this test's original boundary.
      if (path === ${JSON.stringify(join(home, 'agent.lock'))}) fs.chmodSync(${JSON.stringify(home)}, 0o500);
      return read(path, ...args);
    };
    syncBuiltinESMExports();

    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    try {
      await acquireAgentLock({ role: 'manager', version: 'new' });
      console.log('ACQUIRED');
    } catch (error) { console.log('REJECTED:' + error.code); }
  `;
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, AWB_AGENT_MANAGER_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const code = await new Promise((resolve) => child.once('close', resolve));
  const elapsedMs = Date.now() - startedAt;
  await fsp.chmod(home, 0o700);

  const diagnostics = JSON.stringify({ code, elapsedMs, out, err });
  assert.equal(code, 0, diagnostics);
  assert.match(out, /REJECTED:(EACCES|EPERM)/, `원본 errno 가 보존돼야 한다: ${diagnostics}`);
  assert.equal(
    err.split('waiting for recovery guard before stale-cleanup').length - 1,
    1,
    `상한을 다 쓴 가드 대기를 바깥 루프가 되풀이하면 안 된다: ${diagnostics}`,
  );
  // 상한까지 실제로 쉬어야 한다(약 2초). 쉬지 않고 돌면 Windows 의 삭제 대기 창이
  // 닫히기 전에 상한을 다 써서, 이 수정이 막으려던 EPERM 이 그대로 새어 나간다.
  assert.ok(elapsedMs >= 1_000, `가드 대기가 쉬지 않고 상한을 다 썼다: ${diagnostics}`);
});

/** fs 함수 하나를 감싸, 경로가 맞을 때 정해진 횟수만 오류를 내게 하는 contender
 *  머리말. `syncBuiltinESMExports` 가 lock 모듈의 named import 까지 바꾼다 — Windows 의
 *  삭제 대기나 지워지지 않는 잔해를 이 호스트에서 만들지 않고 결정적으로 흉내 낸다.
 *  걸릴 때마다 stderr 에 `SIMULATED_FAULT` 를 남겨, 흉내가 실제로 걸렸는지 단언한다.
 *  `matches` 는 `(path, rest) => boolean` 함수의 소스다. `delayMs` 는 실패하기 전에
 *  동기로 머무는 시간이다 — 느린 디스크처럼 실패 창을 넓힌다. */
function faultPrologue({ fn, matches, code, times = 1, delayMs = 0 }) {
  return `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const realFn = fs[${JSON.stringify(fn)}];
    const matches = ${matches};
    let faults = 0;
    fs[${JSON.stringify(fn)}] = function (path, ...rest) {
      if (faults < ${times} && matches(String(path), rest)) {
        faults += 1;
        if (${delayMs} > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});
        process.stderr.write('SIMULATED_FAULT\\n');
        throw Object.assign(new Error(${JSON.stringify(`${code}: simulated, ${fn}`)} + " '" + path + "'"), {
          code: ${JSON.stringify(code)}, syscall: ${JSON.stringify(fn)}, path,
        });
      }
      return realFn.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
  `;
}

const ACQUIRE_ONCE = (force) => `
  const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
  try {
    const lock = await acquireAgentLock({ role: 'manager', version: 'new', force: ${force} });
    ${PRINT_ACQUIRED}
    lock.release();
  } catch (error) {
    console.log('REJECTED:' + error.code);
  }
`;

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

// 가드 **안**의 unlink·재생성은 여전히 처음부터 다시 판정한다(stale 경로만 — 아무도
// 죽이지 않으므로 다시 관측해도 잃는 것이 없다). 그 접기는 원래 가드 획득까지 한데
// 감쌌는데, 가드 획득이 스스로 기다리게 되면서 가드 안쪽으로 옮겼다. 옮긴 뒤에도 두
// 연산 모두에 남아 있는지 고정한다. 재생성은 첫 시도의 O_EXCL create(EEXIST 로 지는
// happy path) 다음, 가드 안의 두 번째 create 다 — 우리 unlink 는 성공했는데 이름이
// 아직 남은, 전형적인 삭제 대기 자리다.
for (const fault of [
  { subject: 'unlink 가', fn: 'unlinkSync', matches: (lockPath) => `(path) => path === ${JSON.stringify(lockPath)}` },
  {
    subject: '재생성이',
    fn: 'linkSync',
    matches: (lockPath) =>
      `(() => { let links = 0; return (path, rest) => rest[0] === ${JSON.stringify(lockPath)} && ++links === 2; })()`,
  },
]) {
  test(`stale 회수의 ${fault.subject} 삭제 대기 errno 를 받으면 처음부터 다시 판정해 취득한다`, { timeout: 60_000 }, async () => {
    const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-stale-reclaim-pending-'));
    tempDirs.push(home);
    const lockPath = join(home, 'agent.lock');
    await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
    const contender = spawnBarrieredContender(
      faultPrologue({ fn: fault.fn, matches: fault.matches(lockPath), code: 'EPERM' }) + ACQUIRE_ONCE(false),
      { ...process.env, AWB_AGENT_MANAGER_HOME: home },
    );
    const result = await contender.done;
    const diagnostics = JSON.stringify(result, null, 2);
    assert.equal(countOf(result.stderr, 'SIMULATED_FAULT'), 1, `흉내가 걸려야 한다: ${diagnostics}`);
    assert.equal(result.code, 0, diagnostics);
    assert.match(result.output, /ACQUIRED/, diagnostics);
  });
}

// stale 회수(unlink·재생성)는 가드를 쥔 채 돈다. 가드 밖에서 돌면 두 회수자가 겹치고,
// 늦게 끝난 쪽의 unlink 가 먼저 세운 owner 의 lock 을 지워 owner 가 둘이 된다. 첫
// 회수자를 첫 unlink 안에서 동기로 멈춰 세워(가드를 쥔 채) 두 번째를 들여보낸다. 두
// 번째가 그 사이 취득하는지 1.5초 지켜본다 — 이 시간은 느린 러너에서 버그를 놓칠 수만
// 있고, 올바른 코드를 빨갛게 만들지는 않는다(이긴 쪽은 진 쪽이 판정할 때까지 쥔다).
test('stale 회수는 가드를 쥔 채 lock 을 지우고 다시 만든다 — 그동안 온 contender 는 EAGENTLOCKED', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-stale-guard-held-'));
  tempDirs.push(home);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const lockPath = join(home, 'agent.lock');
  const resumeFirst = join(home, 'resume-first-reclaimer');
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  const body = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    try {
      const lock = await acquireAgentLock({ role: 'manager', version: 'new' });
      ${PRINT_ACQUIRED}
      ${HOLD_UNTIL_LOSER_DECIDED}
      lock.release();
    } catch (error) {
      console.log('REJECTED:' + error.code);
      ${MARK_LOSER_DECIDED}
    }
  `;
  const first = spawnBarrieredContender(`
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const lockPath = ${JSON.stringify(lockPath)};
    const resume = ${JSON.stringify(resumeFirst)};
    const realUnlinkSync = fs.unlinkSync;
    const parked = new Int32Array(new SharedArrayBuffer(4));
    let held = false;
    fs.unlinkSync = function (path, ...rest) {
      if (path === lockPath && !held) {
        held = true;
        // 곧 이벤트 루프를 막으므로 동기로 쓴다 — 비동기 stderr 는 나가지 못할 수 있다.
        fs.writeSync(2, 'FIRST_RECLAIMER_HELD\\n');
        const until = Date.now() + 30_000;
        while (!fs.existsSync(resume) && Date.now() < until) Atomics.wait(parked, 0, 0, 10);
      }
      return realUnlinkSync.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
  ` + body, env);
  await first.awaitStderr('FIRST_RECLAIMER_HELD');
  const second = spawnBarrieredContender(body, env);
  await second.awaitStderr('waiting for recovery guard before stale-cleanup');
  await Promise.race([second.done, sleep(1_500)]);
  await fsp.writeFile(resumeFirst, '');
  const [held, late] = await Promise.all([first.done, second.done]);
  const diagnostics = JSON.stringify({ held, late }, null, 2);
  assert.equal([held, late].filter(({ output }) => output.includes('ACQUIRED')).length, 1, diagnostics);
  assert.match(held.output, /ACQUIRED/, diagnostics);
  assert.match(late.output, /REJECTED:EAGENTLOCKED/, diagnostics);
});

// 가드를 쥔 쪽이 놓는 바로 그 순간, 대기자의 판정은 "가드가 이미 사라짐" 이 될 수 있다
// (Windows 는 지워지는 중인 디렉터리의 stat 도 실패로 돌려줘, 놓을 때마다 나온다). 그
// 판정 뒤에 대기자가 그 경로를 rename 하면, 판정과 rename 사이에 남이 새로 만든 가드를
// 격리해 지운다. 둘이 함께 가드를 쥐고, 늦게 끝난 쪽의 unlink 가 먼저 세운 lock 을 지워
// owner 가 둘이 된다(Windows CI 실측, run 39991446432: 동시 force contender 둘 다
// ACQUIRED). 흉내: 대기자의 가드 lstat 한 번을 감싸, lstat 직전에 가드를 지우고(놓음)
// lstat 직후에 남의 새 가드를 세운다(다시 잡음). 남의 가드 owner 는 살아 있는 이
// 테스트 프로세스다. 대기자는 그 가드를 건드리지 말고 놓일 때까지 기다려야 한다.
test('가드가 막 사라졌다는 판정 뒤 그 자리에 새로 생긴 남의 가드를 옮기지 않는다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-gone-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const recoveryLock = `${lockPath}.recovery`;
  const peerOwnerPath = join(recoveryLock, 'owner.json');
  const peerOwner = JSON.stringify({ pid: process.pid, role: 'recovery-guard' });
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  // 대기자가 mkdir 에서 EEXIST 를 받고 판정으로 가게 하는 가드. owner.json 이 없고 갓
  // 만든 것이라 회수 대상이 아니다.
  await fsp.mkdir(recoveryLock);

  const waiter = spawnBarrieredContender(`
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const guard = ${JSON.stringify(recoveryLock)};
    const realLstatSync = fs.lstatSync;
    const realRenameSync = fs.renameSync;
    const parked = new Int32Array(new SharedArrayBuffer(4));
    let swapped = false;
    fs.lstatSync = function (path, ...rest) {
      if (path !== guard || swapped) return realLstatSync.call(this, path, ...rest);
      swapped = true;
      // Windows 에서는 남이 잠깐 연 핸들(백신 등) 때문에 rm 이, 지워지는 중이면 mkdir 이 잠깐
      // 거절될 수 있다 — 둘 다 될 때까지 다시 한다.
      const retry = (op) => {
        const until = Date.now() + 10_000;
        for (;;) {
          try {
            return op();
          } catch (error) {
            if (Date.now() > until) throw error;
            Atomics.wait(parked, 0, 0, 5);
          }
        }
      };
      retry(() => fs.rmSync(guard, { recursive: true, force: true }));
      try {
        return realLstatSync.call(this, path, ...rest);
      } finally {
        retry(() => fs.mkdirSync(guard));
        fs.writeFileSync(${JSON.stringify(peerOwnerPath)}, ${JSON.stringify(peerOwner)});
        process.stderr.write('PEER_GUARD_CREATED\\n');
      }
    };
    fs.renameSync = function (from, ...rest) {
      if (from === guard) process.stderr.write('RENAMED_GUARD_PATH\\n');
      return realRenameSync.call(this, from, ...rest);
    };
    syncBuiltinESMExports();
  ` + ACQUIRE_ONCE(false), { ...process.env, AWB_AGENT_MANAGER_HOME: home });

  await waiter.awaitStderr('PEER_GUARD_CREATED');
  // 옮겼다면 대기자는 곧바로 자기 가드를 만들어 끝까지 간다. 그럴 시간을 준다 — 이
  // 대기는 느린 러너에서 버그를 놓칠 수만 있고 올바른 코드를 빨갛게 만들지는 않는다.
  await Promise.race([waiter.done, sleep(1_500)]);
  const peerGuardBeforeRelease = await fsp.readFile(peerOwnerPath, 'utf8').catch(() => null);
  // 남이 할 일을 마치고 가드를 놓는다 — 이제 대기자가 들어갈 수 있다.
  await fsp.rm(recoveryLock, { recursive: true, force: true });
  const result = await waiter.done;
  const diagnostics = JSON.stringify({ peerGuardBeforeRelease, ...result }, null, 2);
  assert.equal(peerGuardBeforeRelease, peerOwner, `남의 가드를 옮겨 지우면 안 된다: ${diagnostics}`);
  assert.doesNotMatch(result.stderr, /RENAMED_GUARD_PATH/, `사라진 가드 판정 뒤 그 경로를 rename 하면 안 된다: ${diagnostics}`);
  assert.equal(result.code, 0, diagnostics);
  assert.match(result.output, /ACQUIRED/, diagnostics);
});

// ── 판정과 회수 사이에 가드 자리의 주인이 바뀌는 장면 (티켓 4fb0f842) ─────────
//
// 아래 세 장면은 contender 를 fs 호출 한가운데 동기로 세워 순서를 고정한다. 세우는 자리는
// 구현에 기대지 않는다. 그래서 같은 테스트가 고치기 전 코드(rename 회수)에서는 실패하고,
// 고친 코드에서는 통과한다.
//   - guard-removal: 가드 경로나 그 안을 대상으로 하는 첫 rename · unlink · rmdir · rm
//     (회수가 실제로 무언가를 지우기 직전)
//   - lock-unlink: 주 lock 의 첫 unlink. stale 회수는 가드를 쥔 채 이것을 하므로, 여기
//     섰다는 것은 "가드 안에 있다" 는 뜻이다.
//   - guard-lstat: 가드 경로의 첫 lstat. 회수 판정은 owner 를 읽은 뒤 이것을 한다.
//   - owner-write: 가드 안에 대한 첫 writeFileSync(갓 만든 가드에 owner 를 적기 직전)
// 선 자리는 stderr 의 `<이름>:<자리> PARKED` 로 알리고, 홈의 `resume-<이름>-<자리>`
// 파일이 생길 때까지 기다린다(상한 30초 — 테스트가 죽어도 contender 가 끝나게). `extra` 는 같은
// `fs` 로 함수를 더 감싸는 소스다(흉내 낼 실패 등) — 맨 바깥에 감긴다.
function parkPrologue({ name, home, parks, extra = '' }) {
  const lockPath = join(home, 'agent.lock');
  return `
    import fs from 'node:fs';
    import { join, sep } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const home = ${JSON.stringify(home)};
    const lockPath = ${JSON.stringify(lockPath)};
    const guard = ${JSON.stringify(`${lockPath}.recovery`)};
    const parks = new Set(${JSON.stringify(parks)});
    const parkedFlag = new Int32Array(new SharedArrayBuffer(4));
    const inGuard = (path) => path === guard || path.startsWith(guard + sep);
    const park = (label) => {
      if (!parks.delete(label)) return;
      // 곧 이벤트 루프를 막으므로 동기로 쓴다.
      fs.writeSync(2, ${JSON.stringify(name)} + ':' + label + ' PARKED\\n');
      const resume = join(home, 'resume-' + ${JSON.stringify(name)} + '-' + label);
      const until = Date.now() + 30_000;
      while (!fs.existsSync(resume) && Date.now() < until) Atomics.wait(parkedFlag, 0, 0, 10);
    };
    const parkBefore = (fn, label, when) => {
      const real = fs[fn];
      fs[fn] = function (...args) {
        if (when(...args)) park(label);
        return real.apply(this, args);
      };
    };
    for (const fn of ['renameSync', 'unlinkSync', 'rmdirSync', 'rmSync']) {
      parkBefore(fn, 'guard-removal', (path) => inGuard(String(path)));
    }
    parkBefore('unlinkSync', 'lock-unlink', (path) => String(path) === lockPath);
    parkBefore('lstatSync', 'guard-lstat', (path) => String(path) === guard);
    parkBefore('writeFileSync', 'owner-write', (path) => typeof path === 'string' && path.startsWith(guard + sep));
    ${extra}
    syncBuiltinESMExports();
  `;
}

const ACQUIRE_AND_HOLD = `
  const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
  try {
    const lock = await acquireAgentLock({ role: 'manager', version: 'new' });
    ${PRINT_ACQUIRED}
    ${HOLD_UNTIL_LOSER_DECIDED}
    lock.release();
  } catch (error) {
    console.log('REJECTED:' + error.code);
    ${MARK_LOSER_DECIDED}
  }
`;

function resumeParked(home, name, label) {
  return fsp.writeFile(join(home, `resume-${name}-${label}`), '');
}

async function untilParked(contender, name, label) {
  const ended = contender.done.then((result) => {
    throw new Error(`${name} 가 ${label} 에 서기 전에 끝남: ${JSON.stringify(result)}`);
  });
  ended.catch(() => {});
  await Promise.race([contender.awaitStderr(`${name}:${label} PARKED`), ended]);
}

/** 가드 안에 있는 holder 가 서 있는 동안 다른 contender 를 놓았을 때 그쪽이 어디로 가는지.
 *  가드 안(주 lock unlink)에 서면 holder 가 둘이다 — 'entered'. 고친 코드가 물러났다고
 *  남기는 줄(`backedOff`)을 보면 'backed_off'. 둘 다 결정적으로 오므로 시간 창에 기대지
 *  않는다. 20초 안에 어느 쪽도 아니면 그 장면이 재현되지 않은 것이다 — 'timeout'. */
function enteredOrBackedOff(contender, name, backedOff) {
  return Promise.race([
    contender.awaitStderr(`${name}:lock-unlink PARKED`).then(() => 'entered'),
    contender.awaitStderr(backedOff).then(() => 'backed_off'),
    contender.done.then((result) => `ended:${JSON.stringify(result)}`),
    sleep(20_000, 'timeout'),
  ]);
}

// 고친 코드가 물러났다고 남기는 줄. 판정한 owner 가 이미 없어 회수하지 않았다 / 같은 가드에 다른
// owner 가 있어 쥐지 않았다.
const RECLAIM_BACKED_OFF = 'reclaimed or released that guard first; leaving the guard now at';
const CLAIM_BACKED_OFF = 'recovery guard claim: the guard holds other owners too';

async function resumeAll(home, names) {
  for (const name of names) {
    for (const label of ['guard-removal', 'lock-unlink', 'guard-lstat', 'owner-write']) {
      await resumeParked(home, name, label);
    }
  }
}

/** 가드 안(주 lock unlink)에 선 holder 가 정말 가드를 쥐고 있는지 — 가드에 owner 파일이 하나뿐이고
 *  그것이 holder 의 pid 를 적고 있어야 한다. 가드 없이 들어왔거나(확인을 건너뜀) 남이 그 owner 를
 *  지웠으면 여기서 드러난다. 물러난 쪽이 물러나며 무엇을 지웠는지도 이것으로 본다 — 물러난다는 줄은
 *  물러나는 일을 다 마친 뒤에 남는다. */
async function assertHoldsGuard(home, pid, why) {
  const guard = join(home, 'agent.lock.recovery');
  let names;
  try {
    names = await fsp.readdir(guard);
  } catch (error) {
    assert.fail(`${why}: 가드가 없다 (${error.code})`);
  }
  const owners = names.filter((name) => name === 'owner.json' || /^owner-.+\.json$/.test(name));
  assert.equal(owners.length, 1, `${why}: 가드의 owner 가 하나여야 한다 — ${JSON.stringify(names)}`);
  const owner = JSON.parse(await fsp.readFile(join(guard, owners[0]), 'utf8'));
  assert.equal(owner.pid, pid, `${why}: 가드 owner 가 holder 여야 한다 — ${JSON.stringify(owner)}`);
}

/** 물러난 뒤 잠깐 동안의 stderr. 그 사이 holder 는 가드 안에 서 있으므로, 물러난 쪽이 가드에 손대려
 *  했다면 그 흔적은 이 안에 있다. 그 뒤(holder 가 놓은 다음)의 일은 정상 경합이라 보지 않는다 —
 *  Windows 의 일시적 실패가 거기서 날 수 있다. */
async function stderrShortlyAfter(contender, ms = 300) {
  await sleep(ms);
  return contender.stderrNow();
}

/** 이 테스트 프로세스를 owner 로 적은, 살아 있는 holder 의 가드 owner. 부팅 세대까지 담아 구버전
 *  owner 의 벽시계 상한에도 걸리지 않는다. */
function liveGuardOwner() {
  const boot = currentBootIdentity();
  return JSON.stringify({
    pid: process.pid,
    role: 'recovery-guard',
    started_at: new Date().toISOString(),
    boot_id: boot.id,
    boot_time_ms: boot.approxBootTimeMs,
    pid_start_ticks: readProcessStartTicks(process.pid),
  });
}

// E5 — 크래시로 남은 가드(owner 가 죽은 pid)를 두 대기자가 함께 stale 로 판정한다. 먼저
// 회수한 쪽은 자기 가드를 만들고 그 안에 선다. 그때 늦은 쪽이 회수를 마저 하면, 회수가
// 판정한 가드가 아니라 지금 그 자리에 있는 것(먼저 회수한 쪽의 새 가드)을 지운다. 그러면
// 둘이 함께 가드 안에 있고, 늦게 끝난 쪽의 unlink 가 먼저 세운 lock 을 지워 owner 가 둘이
// 된다. 늦은 쪽은 그 가드를 건드리지 말고, 놓일 때까지 기다려야 한다.
for (const debris of [
  { name: '구버전 owner.json', file: 'owner.json' },
  { name: '고유 이름 owner 파일', file: 'owner-999999999-debris.json' },
]) {
  test(`같은 크래시 잔해를 두 대기자가 판정해도 가드 안에는 하나만 선다 — ${debris.name} (E5)`, { timeout: 90_000 }, async () => {
    const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-e5-'));
    tempDirs.push(home);
    const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
    const lockPath = join(home, 'agent.lock');
    const guard = `${lockPath}.recovery`;
    await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
    await fsp.mkdir(guard);
    await fsp.writeFile(join(guard, debris.file), JSON.stringify({ pid: 999_999_999, role: 'recovery-guard' }));
    // 고유 이름 owner 파일을 모르는 코드도 이 잔해를 회수 대상으로 보게 오래된 시각을 단다
    // (owner 미상 가드의 상한 규칙). owner 를 읽는 코드는 죽은 pid 로 판정한다.
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await fsp.utimes(guard, longAgo, longAgo);

    const parks = ['guard-removal', 'lock-unlink'];
    const w1 = spawnBarrieredContender(parkPrologue({ name: 'W1', home, parks }) + ACQUIRE_AND_HOLD, env);
    const w2 = spawnBarrieredContender(parkPrologue({ name: 'W2', home, parks }) + ACQUIRE_AND_HOLD, env);
    try {
      // 둘 다 잔해를 판정하고 회수 직전에 섰다.
      await Promise.all([untilParked(w1, 'W1', 'guard-removal'), untilParked(w2, 'W2', 'guard-removal')]);
      // W1 이 회수를 마치고 자기 가드 안(주 lock unlink)에 선다.
      await resumeParked(home, 'W1', 'guard-removal');
      await untilParked(w1, 'W1', 'lock-unlink');
      await assertHoldsGuard(home, w1.child.pid, 'W1 이 가드 안에 섰다');
      // 그 사이 W2 의 회수를 놓는다.
      await resumeParked(home, 'W2', 'guard-removal');
      const w2Outcome = await enteredOrBackedOff(w2, 'W2', RECLAIM_BACKED_OFF);
      let afterBackOff = '';
      if (w2Outcome === 'backed_off') {
        afterBackOff = await stderrShortlyAfter(w2);
        await assertHoldsGuard(home, w1.child.pid, 'W2 가 물러난 뒤에도 W1 이 가드를 쥔다');
      }
      await resumeAll(home, ['W1', 'W2']);
      const [first, late] = await Promise.all([w1.done, w2.done]);
      const diagnostics = JSON.stringify({ w2Outcome, first, late }, null, 2);
      assert.equal(w2Outcome, 'backed_off', `W1 이 가드 안에 있는 동안 W2 가 들어오면 안 된다: ${diagnostics}`);
      // 판정한 가드가 이미 없으면 지금 그 자리의 가드에는 손대지 않는다(지우려다 실패하는 것도 아니다).
      assert.doesNotMatch(afterBackOff, /recovery guard reclaim: could not remove/, diagnostics);
      assert.match(first.output, /ACQUIRED/, diagnostics);
      assert.match(late.output, /REJECTED:EAGENTLOCKED/, diagnostics);
    } finally {
      await resumeAll(home, ['W1', 'W2']);
    }
  });
}

// E10b — 크래시 잔해 없이도 난다. R 이 가드를 쥔 동안 W 가 R 의 owner 를 읽는다. R 이 할
// 일을 마치고 가드를 놓은 뒤 죽고, C 가 새 가드를 만들어 그 안에 선다. W 가 판정을
// 이어 가면 미리 읽은 R 은 죽었으니 stale 이다. 그런데 지금 그 자리에 있는 것은 C 의 살아
// 있는 가드다 — 그것을 지우면 W 와 C 가 함께 가드 안에 있다.
test('먼저 읽은 owner 가 그 사이 놓고 죽어도, 그 자리에 새로 선 남의 가드를 회수하지 않는다 (E10b)', { timeout: 90_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-e10b-'));
  tempDirs.push(home);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const lockPath = join(home, 'agent.lock');
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  const acquireAndHang = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    await acquireAgentLock({ role: 'manager', version: 'new' });
    ${PRINT_ACQUIRED}
    setInterval(() => {}, 1000);
  `;
  const r = spawnBarrieredContender(parkPrologue({ name: 'R', home, parks: ['lock-unlink'] }) + acquireAndHang, env);
  let w;
  let c;
  try {
    await untilParked(r, 'R', 'lock-unlink');
    // R 이 가드 안에 있다. W 는 그 가드를 판정하다 owner 를 읽은 뒤 선다.
    w = spawnBarrieredContender(parkPrologue({ name: 'W', home, parks: ['guard-lstat', 'lock-unlink'] }) + ACQUIRE_AND_HOLD, env);
    await untilParked(w, 'W', 'guard-lstat');
    // R 이 마저 끝내고 가드를 놓는다. 그다음 죽는다(SIGKILL — lock 은 stale 로 남는다).
    await resumeParked(home, 'R', 'lock-unlink');
    await r.awaitStderr('[lockfile] acquired after stale-cleanup');
    r.child.kill('SIGKILL');
    await r.done;
    // C 가 새 가드를 만들어 그 안에 선다.
    c = spawnBarrieredContender(parkPrologue({ name: 'C', home, parks: ['lock-unlink'] }) + ACQUIRE_AND_HOLD, env);
    await untilParked(c, 'C', 'lock-unlink');
    await assertHoldsGuard(home, c.child.pid, 'C 가 가드 안에 섰다');
    // W 가 판정을 이어 간다.
    await resumeParked(home, 'W', 'guard-lstat');
    const wOutcome = await enteredOrBackedOff(w, 'W', RECLAIM_BACKED_OFF);
    let afterBackOff = '';
    if (wOutcome === 'backed_off') {
      afterBackOff = await stderrShortlyAfter(w);
      await assertHoldsGuard(home, c.child.pid, 'W 가 물러난 뒤에도 C 가 가드를 쥔다');
    }
    await resumeAll(home, ['W', 'C']);
    const [held, late] = await Promise.all([c.done, w.done]);
    const diagnostics = JSON.stringify({ wOutcome, held, late }, null, 2);
    assert.equal(wOutcome, 'backed_off', `C 가 가드 안에 있는 동안 W 가 들어오면 안 된다: ${diagnostics}`);
    assert.doesNotMatch(afterBackOff, /recovery guard reclaim: could not remove/, diagnostics);
    assert.match(held.output, /ACQUIRED/, diagnostics);
    assert.match(late.output, /REJECTED:EAGENTLOCKED/, diagnostics);
  } finally {
    await resumeAll(home, ['R', 'W', 'C']);
  }
});

// 갓 만든 가드가 owner 를 적기 전에 치워질 수 있다 — 회수 판정이 그 자리의 예전 상태를
// 보고 빈 디렉터리를 지운 경우다. 그 사이 다른 contender 가 같은 자리에 가드를 만들면,
// 둘의 owner 기록이 둘 다 그 새 디렉터리로 들어간다. 경로로 적는 한 이것은 막을 수 없다.
// 그래서 적은 뒤 그 가드에 자기 owner 하나만 있는지 확인해야 한다 — 확인이 없으면 둘 다
// 쥔다. 흉내: C 가 owner 를 적기 직전에 테스트가 C 의 가드를 치우고, D 가 새 가드를 만든다.
// D 를 먼저 띄워 pid 를 작게 한다 — D 의 owner 이름(owner-<pid>-…)이 C 보다 앞서 정렬되게. 나중에
// 적은 쪽은 이름 순서와 상관없이 물러나야 한다("이름이 앞서는 쪽이 쥔다" 같은 확인은 여기서 진다).
test('갓 만든 가드가 owner 기록 전에 바뀌어 둘이 같은 가드에 적어도 하나만 쥔다', { timeout: 90_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-double-claim-'));
  tempDirs.push(home);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const lockPath = join(home, 'agent.lock');
  const guard = `${lockPath}.recovery`;
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  const parks = ['owner-write', 'lock-unlink'];
  const d = spawnBarrieredContender(parkPrologue({ name: 'D', home, parks }) + BARRIER_PROLOGUE + ACQUIRE_AND_HOLD, env);
  let c;
  try {
    await Promise.race([d.ready, d.done.then((result) => assert.fail(`D 가 준비 전에 끝남: ${JSON.stringify(result)}`))]);
    c = spawnBarrieredContender(parkPrologue({ name: 'C', home, parks }) + ACQUIRE_AND_HOLD, env);
    await untilParked(c, 'C', 'owner-write');
    await fsp.rm(guard, { recursive: true, force: true });
    d.child.stdin.write('go\n');
    await untilParked(d, 'D', 'owner-write');
    // C 가 먼저 적고 가드 안에 선다. 그다음 D 가 같은 가드에 적는다.
    await resumeParked(home, 'C', 'owner-write');
    await untilParked(c, 'C', 'lock-unlink');
    await assertHoldsGuard(home, c.child.pid, 'C 가 가드 안에 섰다');
    await resumeParked(home, 'D', 'owner-write');
    const dOutcome = await enteredOrBackedOff(d, 'D', CLAIM_BACKED_OFF);
    if (dOutcome === 'backed_off') await assertHoldsGuard(home, c.child.pid, 'D 가 물러난 뒤에도 C 가 가드를 쥔다');
    await resumeAll(home, ['C', 'D']);
    const [held, late] = await Promise.all([c.done, d.done]);
    const diagnostics = JSON.stringify({ dOutcome, held, late }, null, 2);
    assert.equal(dOutcome, 'backed_off', `C 가 가드 안에 있는 동안 D 가 들어오면 안 된다: ${diagnostics}`);
    assert.match(held.output, /ACQUIRED/, diagnostics);
    assert.match(late.output, /REJECTED:EAGENTLOCKED/, diagnostics);
  } finally {
    await resumeAll(home, ['C', 'D']);
  }
});

// 가드를 놓을 때도 자기 owner 이름으로만 지운다. 쥔 동안 그 자리가 남의 것이 됐다면(정상
// 경로에서는 일어나지 않는다 — 부팅 시각 근사가 크게 어긋난 판정 같은 예외) 경로째 지우는
// 놓기는 그 남의 가드를 지워 셋째를 들인다. 흉내: C 를 가드 안에 세워 둔 채 테스트가 그 자리를
// 남의 가드로 바꾼다. C 는 할 일을 마치고 놓지만 남의 가드는 그대로여야 하고, 그 사실을 남긴다.
test('가드를 쥔 동안 그 자리가 남의 것이 되면, 놓을 때 남의 가드를 지우지 않고 그 사실을 남긴다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-release-foreign-'));
  tempDirs.push(home);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const lockPath = join(home, 'agent.lock');
  const guard = `${lockPath}.recovery`;
  const peerOwnerPath = join(guard, 'owner.json');
  const peerOwner = JSON.stringify({ pid: process.pid, role: 'recovery-guard' });
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  const c = spawnBarrieredContender(parkPrologue({ name: 'C', home, parks: ['lock-unlink'] }) + ACQUIRE_ONCE(false), env);
  try {
    await untilParked(c, 'C', 'lock-unlink');
    await fsp.rm(guard, { recursive: true, force: true });
    await fsp.mkdir(guard);
    await fsp.writeFile(peerOwnerPath, peerOwner);
    await resumeParked(home, 'C', 'lock-unlink');
    const result = await c.done;
    const diagnostics = JSON.stringify(result, null, 2);
    assert.match(result.output, /ACQUIRED/, diagnostics);
    assert.match(result.stderr, /recovery guard release: this process's owner owner-\S+ is already gone/, diagnostics);
    assert.equal(await fsp.readFile(peerOwnerPath, 'utf8').catch(() => null), peerOwner, `남의 가드를 지우면 안 된다: ${diagnostics}`);
  } finally {
    await resumeAll(home, ['C']);
  }
});

// 회수는 판정할 때 본 owner 를 그 이름으로 지운 뒤, 그 밖에 본 항목(낯선 파일 — 탐색기가 남기는
// desktop.ini 같은)도 지우고 빈 디렉터리를 치운다. 낯선 파일을 남기면 rmdir 가 비지 않은 가드에서
// 진다. 두 장면:
//   - owner 를 적다 죽은 잔해: owner 파일은 'wx' 로 먼저 생기고 내용은 나중에 들어가, 깨진 owner
//     하나가 남는다. owner 로 읽히지 않으니 owner 미상 가드의 상한(오래된 시각)으로 회수한다.
//   - 죽은 owner 의 잔해: owner 로 판정하므로 시각과 상관없이 곧 회수한다.
for (const scene of [
  {
    name: '깨진 owner 와 낯선 파일만 남은 오래된 가드',
    owner: ['owner-999999999-torn.json', '{"pid": 9999'],
    old: true,
    // 어느 규칙인지는 러너가 언제 부팅했는지에 달렸다(위 끊긴 링크 테스트와 같다).
    reclaimedAs: /reclaiming stale recovery guard — (guard_expired|guard_predates_boot)/,
  },
  {
    name: '죽은 owner 와 낯선 파일이 든 가드',
    owner: ['owner.json', JSON.stringify({ pid: 999_999_999, role: 'recovery-guard' })],
    old: false,
    reclaimedAs: /reclaiming stale recovery guard — owner_stale/,
  },
]) {
  test(`${scene.name}도 곧 회수하고 취득한다`, { timeout: 60_000 }, async () => {
    const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-debris-junk-'));
    tempDirs.push(home);
    const lockPath = join(home, 'agent.lock');
    const guard = `${lockPath}.recovery`;
    await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
    await fsp.mkdir(guard);
    await fsp.writeFile(join(guard, scene.owner[0]), scene.owner[1]);
    await fsp.writeFile(join(guard, 'desktop.ini'), '[.ShellClassInfo]');
    if (scene.old) {
      const longAgo = new Date(Date.now() - 10 * 60_000);
      await fsp.utimes(guard, longAgo, longAgo);
    }
    const contender = spawnBarrieredContender(ACQUIRE_ONCE(false), { ...process.env, AWB_AGENT_MANAGER_HOME: home });
    const result = await Promise.race([contender.done, sleep(20_000, { code: null, output: 'STILL_WAITING', stderr: '' })]);
    const diagnostics = JSON.stringify(result, null, 2);
    assert.equal(result.code, 0, diagnostics);
    assert.match(result.output, /ACQUIRED/, diagnostics);
    assert.match(result.stderr, scene.reclaimedAs, diagnostics);
  });
}

// owner 를 적은 바로 뒤 가드가 통째로 치워지면(확인하는 readdir 가 ENOENT) 우리 owner 도 함께
// 사라진 것이다 — 쥔 것이 아니다. 기다렸다 다시 만들어 쥐어야 하고, 가드 안에서는 그 가드가 우리를
// owner 로 담고 있어야 한다. 흉내: 확인하는 readdir 직전에 그 가드를 지운다.
test('owner 를 적은 직후 가드가 치워지면 쥔 것으로 보지 않고 다시 만들어 쥔다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-verify-gone-'));
  tempDirs.push(home);
  await fsp.writeFile(join(home, 'agent.lock'), JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  const extra = `{
    const realReaddirSync = fs.readdirSync;
    let removed = false;
    fs.readdirSync = function (path, ...rest) {
      if (!removed && String(path) === guard) {
        removed = true;
        fs.rmSync(guard, { recursive: true, force: true });
        fs.writeSync(2, 'GUARD_REMOVED_BEFORE_VERIFY\\n');
      }
      return realReaddirSync.call(this, path, ...rest);
    };
  }`;
  const x = spawnBarrieredContender(
    parkPrologue({ name: 'X', home, parks: ['lock-unlink'], extra }) + ACQUIRE_ONCE(false),
    { ...process.env, AWB_AGENT_MANAGER_HOME: home },
  );
  try {
    await untilParked(x, 'X', 'lock-unlink');
    await assertHoldsGuard(home, x.child.pid, 'X 가 가드 안에 섰다');
    await resumeParked(home, 'X', 'lock-unlink');
    const result = await x.done;
    const diagnostics = JSON.stringify(result, null, 2);
    assert.match(result.stderr, /GUARD_REMOVED_BEFORE_VERIFY/, diagnostics);
    assert.match(result.stderr, /recovery guard claim: the guard was removed right after its owner was recorded/, diagnostics);
    assert.match(result.output, /ACQUIRED/, diagnostics);
  } finally {
    await resumeAll(home, ['X']);
  }
});

// 가드에는 owner 가 여럿 있을 수 있다 — 같은 가드에 적은 두 contender 중 물러나지 못하고 죽은 쪽의
// 잔해가 holder 의 owner 와 함께 남는다. 디렉터리 시각은 마지막으로 항목이 바뀐 때일 뿐이라
// (오래 쥔 force 인수, 절전 · VM 정지, 벽시계 조정) 오래됐어도 holder 는 살아 있을 수 있다. owner
// 를 하나하나 판정해, 살아 있는 owner 가 있으면 회수하지 않아야 한다(리뷰 B1). 이 테스트
// 프로세스가 holder 다. 시각은 owner 미상 가드의 상한(60초)은 넘고 이번 부팅보다는 늦게 단다.
test('owner 가 여럿인 가드는 그중 하나라도 살아 있으면 오래됐어도 회수하지 않는다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-multi-owner-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const guard = `${lockPath}.recovery`;
  const livePath = join(guard, 'owner-live-holder.json');
  const deadPath = join(guard, 'owner-dead-claimant.json');
  const live = liveGuardOwner();
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  await fsp.mkdir(guard);
  await fsp.writeFile(livePath, live);
  await fsp.writeFile(deadPath, JSON.stringify({ pid: 999_999_999, role: 'recovery-guard' }));
  const ninetySecondsAgo = new Date(Date.now() - 90_000);
  await fsp.utimes(guard, ninetySecondsAgo, ninetySecondsAgo);
  const contender = spawnBarrieredContender(ACQUIRE_ONCE(false), { ...process.env, AWB_AGENT_MANAGER_HOME: home });
  await contender.awaitStderr('waiting for recovery guard before stale-cleanup');
  // 회수했다면 곧바로 취득까지 간다. 이 대기는 느린 러너에서 버그를 놓칠 수만 있다.
  await Promise.race([contender.done, sleep(1_500)]);
  const liveBeforeRelease = await fsp.readFile(livePath, 'utf8').catch(() => null);
  await fsp.rm(guard, { recursive: true, force: true }); // holder 가 놓는다
  const result = await contender.done;
  const diagnostics = JSON.stringify({ liveBeforeRelease, ...result }, null, 2);
  assert.equal(liveBeforeRelease, live, `살아 있는 holder 의 owner 를 지우면 안 된다: ${diagnostics}`);
  assert.doesNotMatch(result.stderr, /reclaiming stale recovery guard/, diagnostics);
  assert.match(result.output, /ACQUIRED/, diagnostics);
});

// 하나뿐인 owner 를 잠깐 못 읽는 것(Windows 백신이 연 핸들 등)은 owner 가 없는 것이 아니다. 그때
// 디렉터리 시각으로 판정하면 살아 있는 holder 의 owner 를 지운다(리뷰 B1b). 흉내: owner 읽기를 세 번
// EBUSY 로 거절한다. 그 뒤로는 읽혀 살아 있는 owner 로 판정되고, holder 가 놓을 때까지 기다린다.
test('가드 owner 를 잠깐 못 읽어도 오래된 가드라고 회수하지 않는다 — 살아 있는 holder 일 수 있다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-owner-unreadable-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const guard = `${lockPath}.recovery`;
  const livePath = join(guard, 'owner-live-holder.json');
  const live = liveGuardOwner();
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  await fsp.mkdir(guard);
  await fsp.writeFile(livePath, live);
  const ninetySecondsAgo = new Date(Date.now() - 90_000);
  await fsp.utimes(guard, ninetySecondsAgo, ninetySecondsAgo);
  const contender = spawnBarrieredContender(
    faultPrologue({
      fn: 'readFileSync',
      matches: `(path) => path.startsWith(${JSON.stringify(join(guard, 'owner-'))})`,
      code: 'EBUSY',
      times: 3,
    }) + ACQUIRE_ONCE(false),
    { ...process.env, AWB_AGENT_MANAGER_HOME: home },
  );
  await contender.awaitStderr('waiting for recovery guard before stale-cleanup');
  await Promise.race([contender.done, sleep(1_500)]);
  const liveBeforeRelease = await fsp.readFile(livePath, 'utf8').catch(() => null);
  await fsp.rm(guard, { recursive: true, force: true }); // holder 가 놓는다
  const result = await contender.done;
  const diagnostics = JSON.stringify({ liveBeforeRelease, ...result }, null, 2);
  assert.equal(countOf(result.stderr, 'SIMULATED_FAULT'), 3, `흉내가 걸려야 한다: ${diagnostics}`);
  assert.equal(liveBeforeRelease, live, `살아 있는 holder 의 owner 를 지우면 안 된다: ${diagnostics}`);
  assert.doesNotMatch(result.stderr, /reclaiming stale recovery guard/, diagnostics);
  assert.match(result.output, /ACQUIRED/, diagnostics);
});

// 같은 가드에 적었다 물러나는 contender 가 자기 owner 를 못 지우면(Windows 백신 등), 그 owner 는
// 살아 있는 그 contender 를 가리킨 채 남는다. holder 가 놓아도 그 가드는 그 owner 하나를 담고 남아,
// 그 contender 자신을 포함한 모든 대기자가 끝없이 기다렸다(리뷰 B2). 물러난 쪽은 기다리는 동안 자기
// owner 를 다시 지워야 한다. 흉내: 위 이중 기록 장면에서 D 가 물러날 때 자기 owner 지우기를 한 번
// EBUSY 로 거절한다.
test('물러나다 자기 owner 를 못 지운 contender 는 기다리는 동안 다시 지운다 — 자기 owner 에 갇히지 않는다', { timeout: 90_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-abandoned-owner-'));
  tempDirs.push(home);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const lockPath = join(home, 'agent.lock');
  const guard = `${lockPath}.recovery`;
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  const parks = ['owner-write', 'lock-unlink'];
  const failOwnUnlinkOnce = `{
    const realUnlinkSync = fs.unlinkSync;
    let failed = false;
    fs.unlinkSync = function (path, ...rest) {
      if (!failed && String(path).startsWith(guard + sep + 'owner-')) {
        failed = true;
        fs.writeSync(2, 'SIMULATED_FAULT\\n');
        throw Object.assign(new Error("EBUSY: simulated, unlink '" + path + "'"), { code: 'EBUSY', syscall: 'unlink', path: String(path) });
      }
      return realUnlinkSync.call(this, path, ...rest);
    };
  }`;
  const c = spawnBarrieredContender(parkPrologue({ name: 'C', home, parks }) + ACQUIRE_AND_HOLD, env);
  let d;
  try {
    await untilParked(c, 'C', 'owner-write');
    await fsp.rm(guard, { recursive: true, force: true });
    d = spawnBarrieredContender(parkPrologue({ name: 'D', home, parks, extra: failOwnUnlinkOnce }) + ACQUIRE_AND_HOLD, env);
    await untilParked(d, 'D', 'owner-write');
    await resumeParked(home, 'C', 'owner-write');
    await untilParked(c, 'C', 'lock-unlink');
    await resumeParked(home, 'D', 'owner-write');
    await d.awaitStderr(CLAIM_BACKED_OFF);
    await resumeAll(home, ['C', 'D']);
    const STILL_WAITING = { code: null, output: 'STILL_WAITING', stderr: '' };
    const [held, late] = await Promise.all([c.done, Promise.race([d.done, sleep(30_000, STILL_WAITING)])]);
    const diagnostics = JSON.stringify({ held, late: { ...late, stderr: d.stderrNow() } }, null, 2);
    assert.equal(countOf(d.stderrNow(), 'SIMULATED_FAULT'), 1, `흉내가 걸려야 한다: ${diagnostics}`);
    assert.match(held.output, /ACQUIRED/, diagnostics);
    assert.match(late.output, /REJECTED:EAGENTLOCKED/, `자기 owner 에 갇히지 않고 판정을 받아야 한다: ${diagnostics}`);
    assert.match(d.stderrNow(), /recovery guard: removed this process's leftover owner owner-/, diagnostics);
  } finally {
    await resumeAll(home, ['C', 'D']);
  }
});

// 가드 자리의 디렉터리가 아닌 것(끊긴 링크)은 unlink 로만 지운다 — 판정과 지우기 사이에 그 자리에
// 살아 있는 가드(디렉터리)가 서면 unlink 는 그것을 지우지 못한다. 경로째 지우는 연산(rm -r)이면 그
// 가드를 지운다. 흉내: 링크를 회수하려는 순간 테스트가 그 자리를 살아 있는 가드로 바꾼다.
test('가드 자리의 링크를 회수하는 사이 그 자리에 살아 있는 가드가 서면 그 가드를 지우지 않는다', { timeout: 60_000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 러너는 심볼릭 링크를 만들 권한이 없을 수 있다');
    return;
  }
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-link-swap-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const guard = `${lockPath}.recovery`;
  const livePath = join(guard, 'owner-live-holder.json');
  const live = liveGuardOwner();
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  await fsp.symlink(join(home, 'nowhere'), guard);
  const longAgo = new Date(Date.now() - 10 * 60_000);
  await fsp.lutimes(guard, longAgo, longAgo);
  const w = spawnBarrieredContender(
    parkPrologue({ name: 'W', home, parks: ['guard-removal'] }) + ACQUIRE_ONCE(false),
    { ...process.env, AWB_AGENT_MANAGER_HOME: home },
  );
  try {
    await untilParked(w, 'W', 'guard-removal');
    await fsp.unlink(guard);
    await fsp.mkdir(guard);
    await fsp.writeFile(livePath, live);
    await resumeParked(home, 'W', 'guard-removal');
    await Promise.race([w.done, sleep(1_500)]);
    const liveBeforeRelease = await fsp.readFile(livePath, 'utf8').catch(() => null);
    await fsp.rm(guard, { recursive: true, force: true }); // holder 가 놓는다
    const result = await w.done;
    const diagnostics = JSON.stringify({ liveBeforeRelease, ...result }, null, 2);
    assert.equal(liveBeforeRelease, live, `그 자리에 선 살아 있는 가드를 지우면 안 된다: ${diagnostics}`);
    assert.match(result.output, /ACQUIRED/, diagnostics);
  } finally {
    await resumeAll(home, ['W']);
  }
});

// 빈 가드를 끝내 지우지 못하면(rmdir 가 계속 실패) 상한까지 다시 시도한 뒤 원본 errno 로 끝나야
// 한다. 지우지 못한 것을 지운 것으로 치면 판정 → rmdir 실패 → mkdir EEXIST → 판정을 쉬지 않고
// 되풀이한다(바쁜 루프). 흉내: 가드 rmdir 를 계속 ENOTEMPTY 로 거절한다. owner 는 죽은 pid 라 곧
// 지워지고, 남은 빈 가드는 빈 가드의 상한 뒤 다시 회수 대상이 된다.
test('빈 가드를 끝내 지우지 못하면 상한까지 다시 시도한 뒤 원본 errno 로 끝난다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-rmdir-denied-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const guard = `${lockPath}.recovery`;
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  await fsp.mkdir(guard);
  await fsp.writeFile(join(guard, 'owner.json'), JSON.stringify({ pid: 999_999_999, role: 'recovery-guard' }));
  const contender = spawnBarrieredContender(
    faultPrologue({ fn: 'rmdirSync', matches: `(path) => path === ${JSON.stringify(guard)}`, code: 'ENOTEMPTY', times: 'Infinity' }) +
      ACQUIRE_ONCE(false),
    { ...process.env, AWB_AGENT_MANAGER_HOME: home },
  );
  const result = await Promise.race([contender.done, sleep(30_000, { code: null, output: 'STILL_WAITING', stderr: '' })]);
  const diagnostics = JSON.stringify({ output: result.output, stderrTail: result.stderr.slice(-2_000) }, null, 2);
  assert.match(result.output, /REJECTED:ENOTEMPTY/, `원본 errno 로 끝나야 한다: ${diagnostics}`);
  assert.match(result.stderr, /recovery guard reclaim: gave up after \d+ consecutive failures \(ENOTEMPTY\)/, diagnostics);
});

// 가드 자리에 디렉터리가 아닌 것이 있으면(끊긴 심볼릭 링크) mkdir 은 EEXIST 인데 stat
// 은 실패한다. 그것을 "사라짐" 으로만 읽으면 끝없이, 아무 말 없이 기다린다. 판정은
// lstat 으로 그 자리의 시각을 읽어 owner 미상 가드의 상한(60초) 규칙으로 회수한다.
test('가드 자리의 끊긴 심볼릭 링크도 상한이 지나면 회수하고 취득한다', { timeout: 60_000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 러너는 심볼릭 링크를 만들 권한이 없을 수 있다');
    return;
  }
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-dangling-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const recoveryLock = `${lockPath}.recovery`;
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  await fsp.symlink(join(home, 'nowhere'), recoveryLock);
  const longAgo = new Date(Date.now() - 10 * 60_000);
  await fsp.lutimes(recoveryLock, longAgo, longAgo);
  const contender = spawnBarrieredContender(ACQUIRE_ONCE(false), { ...process.env, AWB_AGENT_MANAGER_HOME: home });
  const result = await Promise.race([contender.done, sleep(20_000, { code: null, output: 'STILL_WAITING', stderr: '' })]);
  const diagnostics = JSON.stringify(result, null, 2);
  assert.match(result.output, /ACQUIRED/, `끝없이 기다리면 안 된다: ${diagnostics}`);
  assert.equal(result.code, 0, diagnostics);
  // 어느 규칙으로 회수하는지는 러너가 언제 부팅했는지에 달렸다 — 10분 전 시각은 막 뜬 CI
  // 러너에서는 "이번 부팅보다 이른 가드", 오래 켜진 호스트에서는 "상한이 지난 가드" 다.
  assert.match(result.stderr, /reclaiming stale recovery guard — (guard_expired|guard_predates_boot)/, diagnostics);
});

// force 인수가 가드를 잡고 보니 owner 가 이미 없을 수 있다(기다리는 사이 죽었다). 그때는
// 죽일 것 없이 그 자리를 지우고 취득하되, 무엇을 읽었는지 남긴다 — 둘이 함께 가드를 쥐는
// 일이 다시 생기면 이 줄이 그것을 바로 드러낸다(티켓 b14c5669 의 CI 실측은 이 줄이 없어
// 로그만으로는 갈리지 않았다). 죽은 owner 와 없는 lock 은 회수하지만, 깨진 lock 은
// 새 작성자가 생겼을 수 있어 보존하고 오류로 끝낸다.
for (const scene of [
  { name: '죽은 owner 의 lock 이 남음', after: async () => {}, read: (pid) => `pid=${pid}, not alive` },
  { name: 'lock 이 깨짐', after: (lockPath) => fsp.writeFile(lockPath, '{not-json'), invalid: true },
  { name: 'lock 에 pid 가 없음', after: (lockPath) => fsp.writeFile(lockPath, JSON.stringify({ pid: 0 })), invalid: true },
  { name: 'lock 이 없음', after: (lockPath) => fsp.rm(lockPath, { force: true }), read: () => 'no lock' },
]) {
  test(`force 인수: 대기 중 owner 종료 후 읽은 상태에 따라 취득하거나 보존한다 (${scene.name})`, { timeout: 60_000 }, async () => {
    const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-force-owner-gone-'));
    tempDirs.push(home);
    const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
    const lockPath = join(home, 'agent.lock');
    const recoveryLock = `${lockPath}.recovery`;
    const owner = await startLockOwner(env, 'old');
    await fsp.mkdir(recoveryLock);
    await fsp.writeFile(join(recoveryLock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    const contender = spawnBarrieredContender(ACQUIRE_ONCE(true), env);
    await contender.awaitStderr(`--force: waiting for takeover guard (owner pid=${owner.pid}`);
    owner.kill('SIGKILL');
    await waitForExit(owner);
    await scene.after(lockPath);
    const invalidContents = scene.invalid ? await fsp.readFile(lockPath, 'utf8') : null;
    await fsp.rm(recoveryLock, { recursive: true, force: true });
    const result = await contender.done;
    const diagnostics = JSON.stringify(result, null, 2);
    assert.equal(result.code, 0, diagnostics);
    if (scene.invalid) {
      assert.match(result.output, /REJECTED:EAGENTLOCKINVALID/, diagnostics);
      assert.equal(await fsp.readFile(lockPath, 'utf8'), invalidContents);
      assert.doesNotMatch(result.stderr, /SIGTERM previous owner/, diagnostics);
      return;
    }
    assert.match(result.output, /ACQUIRED/, diagnostics);
    assert.doesNotMatch(result.stderr, /SIGTERM previous owner/, diagnostics);
    assert.ok(
      result.stderr.includes(`--force: no live owner at takeover (read ${scene.read(owner.pid)}; observed pid=${owner.pid})`),
      diagnostics,
    );
  });
}

// release 는 lock 이 자기를 가리킬 때만 지운다. 남의 것이 돼 있거나 이미 없으면 지우지 않고
// 그 사실을 남긴다 — 정상 경로에서는 일어나지 않는 일이라(누가 우리 lock 을 지웠다)
// 상호 배제가 깨진 흔적이다.
for (const scene of [
  {
    name: '남의 것이 됨',
    tamper: (lockPath) => `fs.writeFileSync(${JSON.stringify(lockPath)}, ${JSON.stringify(JSON.stringify({ pid: 4242, role: 'manager' }))});`,
    logged: /release: .*agent\.lock now names pid=4242, not this process — not removing/,
    left: JSON.stringify({ pid: 4242, role: 'manager' }),
  },
  {
    name: '이미 없음',
    tamper: (lockPath) => `fs.rmSync(${JSON.stringify(lockPath)});`,
    logged: /release: .*agent\.lock is already gone — someone removed this process's lock/,
    left: null,
  },
]) {
  test(`release 는 lock 이 자기 것이 아니면 지우지 않고 그 사실을 남긴다 (${scene.name})`, { timeout: 60_000 }, async () => {
    const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-release-foreign-'));
    tempDirs.push(home);
    const lockPath = join(home, 'agent.lock');
    const result = await spawnBarrieredContender(`
      import fs from 'node:fs';
      const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
      const lock = await acquireAgentLock({ role: 'manager', version: 'new' });
      ${scene.tamper(lockPath)}
      lock.release();
    `, { ...process.env, AWB_AGENT_MANAGER_HOME: home }).done;
    const diagnostics = JSON.stringify(result, null, 2);
    assert.equal(result.code, 0, diagnostics);
    assert.match(result.stderr, scene.logged, diagnostics);
    assert.equal(await fsp.readFile(lockPath, 'utf8').catch(() => null), scene.left, diagnostics);
  });
}

// 크래시로 남은 회수 가드를 회수하다 지우기가 한 번 실패해도(Windows 에서 아직 열린 핸들,
// 백신) 취득을 접거나 오래 멈추면 안 된다. 회수는 판정한 owner 를 지운 뒤 빈 디렉터리를
// 치운다(3-2번 규칙). owner 가 죽은 pid 인 가드를 깔고 두 단계를 하나씩 한 번 EBUSY 로 거절한다.
//   - owner 지우기: 아무것도 지우지 못했으니 다시 판정해 다시 회수한다.
//   - 빈 디렉터리 치우기: 빈 가드가 남는다. owner 를 지운 순간 그 시각이 새로워져 owner 미상
//     가드의 상한(60초)으로는 한참 멈추지만, 빈 가드의 짧은 상한(수 초)으로 곧 다시 회수한다.
for (const force of [false, true]) {
  for (const step of [
    {
      name: 'owner 지우기',
      fn: 'unlinkSync',
      target: (guard) => join(guard, 'owner.json'),
      failed: () => 'recovery guard reclaim: could not remove the judged owner owner.json (EBUSY); will retry',
      // 아무것도 지우지 못했으니 같은 판정으로 곧바로 다시 회수한다(연달아 실패하는 동안은 회수
      // 줄을 다시 남기지 않는다).
      lastReclaim: /owner_stale/,
    },
    {
      name: '빈 디렉터리 치우기',
      fn: 'rmdirSync',
      target: (guard) => guard,
      failed: (guard) => `recovery guard reclaim: could not remove ${guard} (EBUSY); will retry`,
      // owner 는 지워져 빈 가드가 남았다 — 빈 가드의 상한으로 다시 회수한다.
      lastReclaim: /guard_empty/,
    },
  ]) {
    test(`${force ? 'force' : 'stale'} 경로: 남은 회수 가드의 ${step.name}가 한 번 실패해도 곧 취득한다`, { timeout: 90_000 }, async () => {
      const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-reclaim-retry-'));
      tempDirs.push(home);
      const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
      const lockPath = join(home, 'agent.lock');
      const recoveryLock = `${lockPath}.recovery`;
      const owner = force ? await startLockOwner(env, 'old') : null;
      if (!force) await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
      await fsp.mkdir(recoveryLock);
      await fsp.writeFile(join(recoveryLock, 'owner.json'), JSON.stringify({ pid: 999_999_999, role: 'recovery-guard' }));

      const startedAt = Date.now();
      const contender = spawnBarrieredContender(
        faultPrologue({
          fn: step.fn,
          matches: `(path) => path === ${JSON.stringify(step.target(recoveryLock))}`,
          code: 'EBUSY',
        }) + ACQUIRE_ONCE(force),
        env,
      );
      const result = await Promise.race([contender.done, sleep(30_000, { code: null, output: 'STILL_WAITING', stderr: '' })]);
      const elapsedMs = Date.now() - startedAt;
      const diagnostics = JSON.stringify({ elapsedMs, ...result }, null, 2);
      assert.equal(countOf(result.stderr, 'SIMULATED_FAULT'), 1, `지우기 실패 흉내가 걸려야 한다: ${diagnostics}`);
      assert.equal(result.code, 0, diagnostics);
      assert.match(result.output, /ACQUIRED/, diagnostics);
      assert.ok(result.stderr.includes(step.failed(recoveryLock)), diagnostics);
      assert.match(result.stderr.split('reclaiming stale recovery guard').pop(), step.lastReclaim, diagnostics);
      if (owner) {
        await waitForExit(owner);
        assert.equal(alive(owner.pid), false, diagnostics);
      }
    });
  }
}

// 지울 수 없는 잔해(다른 사용자가 남긴 가드 — 그 디렉터리 안을 바꿀 권한이 없다)는 판정한 그
// 가드만 지우는 회수로는 치울 수 없다. 경로째 옆으로 옮기는 길은 남의 새 가드를 옮길 수 있어
// 막혀 있다. 그때 25ms 마다 끝없이 다시 시도하면 안 된다 — 삭제 대기 errno 와 같은 상한에서
// 원본 오류로 끝내고, 그 가드는 그대로 둔다(손으로 치우라는 줄을 남긴다).
test('지울 수 없는 회수 가드 잔해는 상한까지 다시 시도한 뒤 원본 errno 로 끝난다 — 끝없이 돌지 않는다', { timeout: 90_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-reclaim-denied-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const recoveryLock = `${lockPath}.recovery`;
  const debrisOwner = JSON.stringify({ pid: 999_999_999, role: 'recovery-guard' });
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  await fsp.mkdir(recoveryLock);
  await fsp.writeFile(join(recoveryLock, 'owner.json'), debrisOwner);
  const startedAt = Date.now();
  const contender = spawnBarrieredContender(
    faultPrologue({
      fn: 'unlinkSync',
      matches: `(path) => path === ${JSON.stringify(join(recoveryLock, 'owner.json'))}`,
      code: 'EACCES',
      times: 'Infinity',
    }) + ACQUIRE_ONCE(false),
    { ...process.env, AWB_AGENT_MANAGER_HOME: home },
  );
  const result = await Promise.race([contender.done, sleep(30_000, { code: null, output: 'STILL_WAITING', stderr: '' })]);
  const elapsedMs = Date.now() - startedAt;
  const diagnostics = JSON.stringify({ elapsedMs, output: result.output, stderrTail: result.stderr.slice(-2_000) }, null, 2);
  assert.equal(result.code, 0, diagnostics);
  assert.match(result.output, /REJECTED:EACCES/, `원본 errno 로 끝나야 한다: ${diagnostics}`);
  assert.match(result.stderr, /recovery guard reclaim: gave up after \d+ consecutive failures \(EACCES\)/, diagnostics);
  // 실패 줄은 연속 구간마다 한 번만 남긴다.
  assert.equal(countOf(result.stderr, 'could not remove the judged owner owner.json (EACCES); will retry'), 1, diagnostics);
  assert.equal(await fsp.readFile(join(recoveryLock, 'owner.json'), 'utf8'), debrisOwner, `잔해를 다른 방법으로 치우면 안 된다: ${diagnostics}`);
});

// 가드 디렉터리는 만들었는데 owner 를 못 적으면, 만든 디렉터리를 치우고 원본 오류로 바로
// 끝난다. 그 디렉터리는 우리가 방금 만든 것이라 정상적인 경합으로는 쓰기가 실패하지 않는다
// — 실패는 환경 문제(umask · ACL · 백신 · 디스크)다. 그래서 삭제 대기처럼 기다리지 않는다
// (EPERM 이어도). owner 없는 가드를 남기면 자기 자신을 포함한 모든 대기자가 그 가드의
// 상한까지 멈추므로 치우기는 한다 — 처음에는 그렇게 60초 뒤에야 취득했다.
// owner 파일 이름은 가드마다 고유하다(`owner-<pid>-<uuid>.json`) — 그 앞부분으로 고른다.
const ownerWriteOf = (recoveryLock) => `(path) => path.startsWith(${JSON.stringify(join(recoveryLock, 'owner-'))})`;
for (const code of ['EPERM', 'ENOSPC']) {
  test(`회수 가드 owner 기록 실패(${code}): 가드를 치우고 기다리지 않고 원본 오류로 끝난다`, { timeout: 90_000 }, async () => {
    const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-owner-write-'));
    tempDirs.push(home);
    const lockPath = join(home, 'agent.lock');
    const recoveryLock = `${lockPath}.recovery`;
    await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
    const startedAt = Date.now();
    const contender = spawnBarrieredContender(
      faultPrologue({
        fn: 'writeFileSync',
        matches: ownerWriteOf(recoveryLock),
        code,
      }) + ACQUIRE_ONCE(false),
      { ...process.env, AWB_AGENT_MANAGER_HOME: home },
    );
    const result = await contender.done;
    const elapsedMs = Date.now() - startedAt;
    const diagnostics = JSON.stringify({ elapsedMs, ...result }, null, 2);
    assert.equal(countOf(result.stderr, 'SIMULATED_FAULT'), 1, `흉내가 걸려야 한다: ${diagnostics}`);
    assert.equal(result.code, 0, diagnostics);
    assert.match(result.output, new RegExp(`REJECTED:${code}`), `원본 errno 가 보존돼야 한다: ${diagnostics}`);
    assert.doesNotMatch(result.stderr, /recovery guard \S+ hit \S+; waiting/, `owner 기록 실패를 기다리면 안 된다: ${diagnostics}`);
    assert.ok(elapsedMs < 20_000, `owner 없는 가드에 막혀 그 상한까지 기다리면 안 된다: ${diagnostics}`);
    await assert.rejects(fsp.access(recoveryLock), `가드가 남으면 안 된다: ${diagnostics}`);
  });
}

// owner 기록이 계속 실패하는 참여자가 여럿이면, 기다렸다 다시 시도하는 설계는 끝나지
// 않는다(리뷰 B1). 실패할 때마다 잠깐 생겼다 사라지는 서로의 가드 디렉터리가 상대의 mkdir
// 에 EEXIST 를 주어 연속 횟수를 되돌리기 때문이다. 다섯이 동시에 출발해도 모두 정해진
// 시간 안에 원본 오류로 끝나고 가드를 남기지 않아야 한다. 실패를 3ms 끌어 그 창을 넓힌다.
test('owner 기록이 계속 실패하는 참여자 다섯은 서로를 붙잡지 않고 모두 원본 오류로 끝난다', { timeout: 90_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-owner-livelock-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const recoveryLock = `${lockPath}.recovery`;
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  const source =
    faultPrologue({
      fn: 'writeFileSync',
      matches: ownerWriteOf(recoveryLock),
      code: 'EPERM',
      times: 'Infinity',
      delayMs: 3,
    }) +
    BARRIER_PROLOGUE +
    ACQUIRE_ONCE(false);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const contenders = Array.from({ length: 5 }, () => spawnBarrieredContender(source, env));
  await Promise.all(contenders.map((c) => c.ready));
  for (const c of contenders) c.child.stdin.write('go\n');
  const STILL_WAITING = { output: 'STILL_WAITING', stderr: '' };
  const results = await Promise.all(
    contenders.map((c) => Promise.race([c.done, sleep(20_000, STILL_WAITING)])),
  );
  const leftovers = (await fsp.readdir(home)).filter((name) => name.startsWith('agent.lock.recovery'));
  const diagnostics = JSON.stringify({ outputs: results.map((r) => r.output), leftovers }, null, 2);
  for (const result of results) assert.match(result.output, /REJECTED:EPERM/, diagnostics);
  assert.deepEqual(leftovers, [], diagnostics);
});

// 같은 자리에서 ENOENT 는 다르다. 우리가 만든 디렉터리를 남이 이미 치웠다는 뜻이다(회수
// 판정이 옛 상태를 보고 지웠다). 경합이지 오류가 아니므로 EEXIST 처럼 기다린다. 그 자리에
// 지금 있는 것은 남의 새 가드일 수 있으니 치우지도 않는다. 흉내: owner 를 적으려는 순간 그
// 자리를 남의 가드로 바꿔치기하고 ENOENT 를 낸다. 남의 가드 owner 는 살아 있는 이 테스트
// 프로세스다 — 테스트가 그 가드를 놓은 뒤에야 contender 가 들어갈 수 있다.
test('회수 가드 owner 를 적다 ENOENT 면 그 자리의 가드를 치우지 않고, 놓일 때까지 기다려 취득한다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-owner-stolen-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const recoveryLock = `${lockPath}.recovery`;
  const peerOwnerPath = join(recoveryLock, 'owner.json');
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  const peerOwner = JSON.stringify({ pid: process.pid, role: 'recovery-guard' });
  const contender = spawnBarrieredContender(`
    import fs from 'node:fs';
    import { sep } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const guard = ${JSON.stringify(recoveryLock)};
    const realWriteFileSync = fs.writeFileSync;
    let stolen = false;
    fs.writeFileSync = function (path, ...rest) {
      if (typeof path === 'string' && path.startsWith(guard + sep + 'owner-') && !stolen) {
        stolen = true;
        process.stderr.write('SIMULATED_FAULT\\n');
        fs.renameSync(guard, guard + '.taken-by-peer');
        fs.mkdirSync(guard);
        realWriteFileSync(${JSON.stringify(peerOwnerPath)}, ${JSON.stringify(peerOwner)});
        throw Object.assign(new Error("ENOENT: simulated, open '" + path + "'"), { code: 'ENOENT', syscall: 'open', path });
      }
      return realWriteFileSync.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
  ` + ACQUIRE_ONCE(false), { ...process.env, AWB_AGENT_MANAGER_HOME: home });
  await contender.awaitStderr('SIMULATED_FAULT');
  // 실패로 끝나거나 남의 가드를 치우면 그 사이 드러난다. 이 대기는 느린 러너에서 버그를 놓칠
  // 수만 있고 올바른 코드를 빨갛게 만들지는 않는다.
  await Promise.race([contender.done, sleep(1_500)]);
  const peerGuardBeforeRelease = await fsp.readFile(peerOwnerPath, 'utf8').catch(() => null);
  await fsp.rm(recoveryLock, { recursive: true, force: true });
  const result = await contender.done;
  const diagnostics = JSON.stringify({ peerGuardBeforeRelease, ...result }, null, 2);
  assert.equal(countOf(result.stderr, 'SIMULATED_FAULT'), 1, `흉내가 걸려야 한다: ${diagnostics}`);
  assert.equal(peerGuardBeforeRelease, peerOwner, `그 자리의 남의 가드를 지우면 안 된다: ${diagnostics}`);
  assert.match(result.stderr, /recovery guard claim: .*\(ENOENT\); waiting/, diagnostics);
  assert.equal(result.code, 0, diagnostics);
  assert.match(result.output, /ACQUIRED/, `ENOENT 로 실패하지 않고 기다렸다 취득해야 한다: ${diagnostics}`);
});

// Windows 에서는 치워지는 중인(삭제 대기) 디렉터리에 적으면 ENOENT 가 아니라 삭제 대기 errno(EPERM
// 등)가 난다. 그 errno 에 가드 자리가 비어 있으면 같은 경합이다 — 환경 오류로 보고 끝내면 안 된다
// (가드 자리가 그대로 있으면 위 "owner 기록 실패" 테스트처럼 끝낸다). 흉내: owner 를 적으려는 순간
// 가드를 지우고 EPERM 을 낸다.
test('회수 가드 owner 를 적다 삭제 대기 errno 인데 가드가 이미 치워졌으면 기다렸다 취득한다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-owner-delete-pending-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const recoveryLock = `${lockPath}.recovery`;
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  const contender = spawnBarrieredContender(`
    import fs from 'node:fs';
    import { sep } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const guard = ${JSON.stringify(recoveryLock)};
    const realWriteFileSync = fs.writeFileSync;
    let failed = false;
    fs.writeFileSync = function (path, ...rest) {
      if (typeof path === 'string' && path.startsWith(guard + sep + 'owner-') && !failed) {
        failed = true;
        process.stderr.write('SIMULATED_FAULT\\n');
        fs.rmSync(guard, { recursive: true, force: true });
        throw Object.assign(new Error("EPERM: simulated, open '" + path + "'"), { code: 'EPERM', syscall: 'open', path });
      }
      return realWriteFileSync.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
  ` + ACQUIRE_ONCE(false), { ...process.env, AWB_AGENT_MANAGER_HOME: home });
  const result = await Promise.race([contender.done, sleep(20_000, { code: null, output: 'STILL_WAITING', stderr: '' })]);
  const diagnostics = JSON.stringify(result, null, 2);
  assert.equal(countOf(result.stderr, 'SIMULATED_FAULT'), 1, `흉내가 걸려야 한다: ${diagnostics}`);
  assert.match(result.stderr, /recovery guard claim: .*\(EPERM\); waiting/, diagnostics);
  assert.equal(result.code, 0, diagnostics);
  assert.match(result.output, /ACQUIRED/, `환경 오류로 끝내지 않고 다시 만들어 취득해야 한다: ${diagnostics}`);
});

// force 경로도 상한을 다 쓴 가드 대기를 처음부터 다시 돌리지 않는다 — 다시 돌면 owner 를
// 새로 관측해 5번 규칙이 지키려는 관측을 잃고, 같은 대기를 되풀이한다. 권한 문제를
// "잠김"(EAGENTLOCKED)으로 보고해서도 안 된다. 가드를 못 잡았으니 owner 는 그대로다.
test('force 경로: 가드 mkdir 권한 오류가 계속되면 owner 를 건드리지 않고 원본 errno 로 끝난다', { timeout: 60_000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('chmod 기반 권한 차단이 Windows 에서 같은 의미를 갖지 않는다');
    return;
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 는 쓰기 권한 차단을 무시한다');
    return;
  }
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-force-guard-perm-'));
  tempDirs.push(home);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const owner = await startLockOwner(env, 'old');
  // owner 의 lock 이 이미 있어 첫 create 는 EEXIST 로 지고 인수 경로로 간다. 가드
  // mkdir 만 권한 오류를 받는다.

  let result;
  try {
    result = await spawnBarrieredContender(`
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      // The initial temporary file has already been cleaned up. Deny only
      // subsequent guard creation, preserving this test's original boundary.
      if (path === ${JSON.stringify(join(home, 'agent.lock'))}) fs.chmodSync(${JSON.stringify(home)}, 0o500);
      return read(path, ...args);
    };
    syncBuiltinESMExports();
` + ACQUIRE_ONCE(true), env).done;
  } finally {
    await fsp.chmod(home, 0o700);
  }
  const diagnostics = JSON.stringify(result, null, 2);
  assert.equal(result.code, 0, diagnostics);
  assert.match(result.output, /REJECTED:(EACCES|EPERM)/, `원본 errno 가 보존돼야 한다: ${diagnostics}`);
  assert.equal(countOf(result.stderr, '--force: waiting for takeover guard'), 1, `owner 를 다시 관측하면 안 된다: ${diagnostics}`);
  assert.equal(alive(owner.pid), true, `가드를 못 잡았으면 owner 를 건드리면 안 된다: ${diagnostics}`);
});
