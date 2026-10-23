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
  return { child, ready, done, awaitStderr };
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
  await fsp.chmod(home, 0o500);

  const source = `
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
    fn: 'writeFileSync',
    matches: (lockPath) =>
      `(() => { let wx = 0; return (path, rest) => path === ${JSON.stringify(lockPath)} && rest[1]?.flag === 'wx' && ++wx === 2; })()`,
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
// 로그만으로는 갈리지 않았다).
test('force 인수: 기다리는 사이 owner 가 죽었으면 죽이지 않고 취득하며, 읽은 것을 남긴다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-force-owner-gone-'));
  tempDirs.push(home);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const recoveryLock = join(home, 'agent.lock.recovery');
  const owner = await startLockOwner(env, 'old');
  await fsp.mkdir(recoveryLock);
  await fsp.writeFile(join(recoveryLock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  const contender = spawnBarrieredContender(ACQUIRE_ONCE(true), env);
  await contender.awaitStderr(`--force: waiting for takeover guard (owner pid=${owner.pid}`);
  owner.kill('SIGKILL');
  await waitForExit(owner);
  await fsp.rm(recoveryLock, { recursive: true, force: true });
  const result = await contender.done;
  const diagnostics = JSON.stringify(result, null, 2);
  assert.equal(result.code, 0, diagnostics);
  assert.match(result.output, /ACQUIRED/, diagnostics);
  assert.doesNotMatch(result.stderr, /SIGTERM previous owner/, diagnostics);
  assert.match(
    result.stderr,
    new RegExp(`--force: no live owner at takeover \\(read pid=${owner.pid}, not alive; observed pid=${owner.pid}\\)`),
    diagnostics,
  );
});

// release 는 lock 이 자기를 가리킬 때만 지운다. 남의 것이 돼 있으면 지우지 않고 그 사실을
// 남긴다 — 정상 경로에서는 일어나지 않는 일이라(누가 우리 lock 을 지우고 자기 것을 세웠다)
// 상호 배제가 깨진 흔적이다.
test('release 는 lock 이 남의 것이 됐으면 지우지 않고 그 사실을 남긴다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-release-foreign-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const foreign = JSON.stringify({ pid: 4242, role: 'manager' });
  const result = await spawnBarrieredContender(`
    import fs from 'node:fs';
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    const lock = await acquireAgentLock({ role: 'manager', version: 'new' });
    fs.writeFileSync(${JSON.stringify(lockPath)}, ${JSON.stringify(foreign)});
    lock.release();
  `, { ...process.env, AWB_AGENT_MANAGER_HOME: home }).done;
  const diagnostics = JSON.stringify(result, null, 2);
  assert.equal(result.code, 0, diagnostics);
  assert.match(result.stderr, /release: .*agent\.lock now names pid=4242, not this process — not removing/, diagnostics);
  assert.equal(await fsp.readFile(lockPath, 'utf8'), foreign, diagnostics);
});

// 크래시로 남은 회수 가드를 회수할 때, 격리한 잔해의 rm 이 실패해도(Windows 에서 아직
// 열린 핸들, 다른 사용자가 남긴 가드) 회수는 rename 으로 이미 끝났다 — 가드 경로는
// 비었다. 그 실패로 취득을 접으면 안 된다. owner 가 죽은 pid 인 가드를 깔고, 잔해 rm 을
// 한 번 EBUSY 로 거절한다.
for (const force of [false, true]) {
  test(`${force ? 'force' : 'stale'} 경로: 남은 회수 가드의 격리 잔해를 못 지워도 취득한다`, { timeout: 60_000 }, async () => {
    const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-quarantine-rm-'));
    tempDirs.push(home);
    const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
    const lockPath = join(home, 'agent.lock');
    const recoveryLock = `${lockPath}.recovery`;
    const owner = force ? await startLockOwner(env, 'old') : null;
    if (!force) await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
    await fsp.mkdir(recoveryLock);
    await fsp.writeFile(join(recoveryLock, 'owner.json'), JSON.stringify({ pid: 999_999_999, role: 'recovery-guard' }));

    const contender = spawnBarrieredContender(
      faultPrologue({
        fn: 'rmSync',
        matches: `(path) => path.startsWith(${JSON.stringify(`${recoveryLock}.stale-`)})`,
        code: 'EBUSY',
      }) + ACQUIRE_ONCE(force),
      env,
    );
    const result = await contender.done;
    const diagnostics = JSON.stringify(result, null, 2);
    assert.equal(countOf(result.stderr, 'SIMULATED_FAULT'), 1, `잔해 rm 실패 흉내가 걸려야 한다: ${diagnostics}`);
    assert.equal(result.code, 0, diagnostics);
    assert.match(result.output, /ACQUIRED/, diagnostics);
    if (owner) {
      await waitForExit(owner);
      assert.equal(alive(owner.pid), false, diagnostics);
    }
  });
}

// 가드 디렉터리는 만들었는데 owner 를 못 적으면, 만든 디렉터리를 치우고 원본 오류로 바로
// 끝난다. 그 디렉터리는 우리가 방금 만든 것이라 정상적인 경합으로는 쓰기가 실패하지 않는다
// — 실패는 환경 문제(umask · ACL · 백신 · 디스크)다. 그래서 삭제 대기처럼 기다리지 않는다
// (EPERM 이어도). owner 없는 가드를 남기면 자기 자신을 포함한 모든 대기자가 그 가드의
// 상한(60초)까지 멈추므로 치우기는 한다 — main 에서는 그렇게 60초 뒤에야 취득했다.
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
        matches: `(path) => path === ${JSON.stringify(join(recoveryLock, 'owner.json'))}`,
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
      matches: `(path) => path === ${JSON.stringify(join(recoveryLock, 'owner.json'))}`,
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

// 같은 자리에서 ENOENT 는 다르다. 우리가 만든 디렉터리를 남이 이미 회수해 옮겼다는
// 뜻이라, 그 자리에 지금 있는 것은 남의 새 가드일 수 있다 — 치우면 남의 가드를 지운다.
// 흉내: owner 를 쓰려는 순간 그 자리를 남의 가드로 바꿔치기하고 ENOENT 를 낸다.
test('회수 가드 owner 를 적다 ENOENT 면 그 자리의 가드를 치우지 않는다 — 남이 새로 만든 가드일 수 있다', { timeout: 60_000 }, async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-guard-owner-stolen-'));
  tempDirs.push(home);
  const lockPath = join(home, 'agent.lock');
  const recoveryLock = `${lockPath}.recovery`;
  const ownerPath = join(recoveryLock, 'owner.json');
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, role: 'manager' }));
  const peerOwner = JSON.stringify({ pid: process.pid, role: 'recovery-guard' });
  const contender = spawnBarrieredContender(`
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const guard = ${JSON.stringify(recoveryLock)};
    const ownerPath = ${JSON.stringify(ownerPath)};
    const realWriteFileSync = fs.writeFileSync;
    let stolen = false;
    fs.writeFileSync = function (path, ...rest) {
      if (path === ownerPath && !stolen) {
        stolen = true;
        process.stderr.write('SIMULATED_FAULT\\n');
        fs.renameSync(guard, guard + '.taken-by-peer');
        fs.mkdirSync(guard);
        realWriteFileSync(ownerPath, ${JSON.stringify(peerOwner)});
        throw Object.assign(new Error("ENOENT: simulated, open '" + path + "'"), { code: 'ENOENT', syscall: 'open', path });
      }
      return realWriteFileSync.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
  ` + ACQUIRE_ONCE(false), { ...process.env, AWB_AGENT_MANAGER_HOME: home });
  const result = await contender.done;
  const diagnostics = JSON.stringify(result, null, 2);
  assert.equal(countOf(result.stderr, 'SIMULATED_FAULT'), 1, `흉내가 걸려야 한다: ${diagnostics}`);
  // 이 경우 지금은 원본 ENOENT 로 끝난다. 남이 가져간 가드를 기다리는 쪽으로 바뀔 수 있으니
  // (후속 4fb0f842) 결과는 고정하지 않는다 — 고정하는 것은 "남의 가드를 지우지 않는다" 다.
  assert.equal(
    await fsp.readFile(ownerPath, 'utf8').catch(() => null),
    peerOwner,
    `그 자리의 남의 가드를 지우면 안 된다: ${diagnostics}`,
  );
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
  await fsp.chmod(home, 0o500);
  let result;
  try {
    result = await spawnBarrieredContender(ACQUIRE_ONCE(true), env).done;
  } finally {
    await fsp.chmod(home, 0o700);
  }
  const diagnostics = JSON.stringify(result, null, 2);
  assert.equal(result.code, 0, diagnostics);
  assert.match(result.output, /REJECTED:(EACCES|EPERM)/, `원본 errno 가 보존돼야 한다: ${diagnostics}`);
  assert.equal(countOf(result.stderr, '--force: waiting for takeover guard'), 1, `owner 를 다시 관측하면 안 된다: ${diagnostics}`);
  assert.equal(alive(owner.pid), true, `가드를 못 잡았으면 owner 를 건드리면 안 된다: ${diagnostics}`);
});
