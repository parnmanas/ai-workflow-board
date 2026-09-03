import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cleanupOrphanSubagents } from '../dist/lib/orphan-cleanup.js';
import { resolveLostCreateRace } from '../dist/lib/agent-lockfile.js';

const tempDirs = [];
const children = [];
const lockModuleUrl = pathToFileURL(
  join(fileURLToPath(new URL('.', import.meta.url)), '../dist/lib/agent-lockfile.js'),
).href;

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

/** 배리어를 지키는 contender 를 띄운다. `ready` 는 READY 수신, `done` 은 종료.
 *  `awaitStderr(needle)` 는 contender 의 진행 상황을 제품 로그로 관찰하는 용도다
 *  — 제품 로그는 stderr 로 나가므로 stdout 마커(ACQUIRED/REJECTED)와 섞이지
 *  않는다. 관찰한 내용은 CI 진단이 사라지지 않도록 부모 stderr 로도 흘린다. */
function spawnBarrieredContender(source, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
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
    child.once('exit', (code) => resolve({ code, output }));
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

  assert.deepEqual(result, { scanned: 1, reaped: 1, skipped: 0, failed: 0 });
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
    console.log('OWNER_READY');
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
    console.log('ACQUIRED:' + (Date.now() - started));
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

test('동시 force contender 둘 중 정확히 하나만 종료된 owner의 lock을 취득한다', async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'awb-manager-lock-race-'));
  tempDirs.push(home);
  const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
  const ownerSource = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    await acquireAgentLock({ role: 'manager', version: 'old' });
    console.log('OWNER_READY');
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
      console.log('ACQUIRED');
      await new Promise((resolve) => setTimeout(resolve, 500));
      lock.release();
    } catch (error) {
      console.log('REJECTED:' + error.code);
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
  assert.deepEqual(results.map(({ code }) => code), [0, 0]);
  assert.equal(results.filter(({ output }) => output.includes('ACQUIRED')).length, 1);
  assert.equal(results.filter(({ output }) => output.includes('REJECTED:EAGENTLOCKED')).length, 1);
});

for (const fixture of [
  { name: 'stale', contents: JSON.stringify({ pid: 999_999_999, role: 'manager' }) },
  { name: 'unparseable', contents: '{not-json' },
]) {
  test(`${fixture.name} lock 동시 회수에서도 새 owner lock을 삭제하지 않는다`, async () => {
    const home = await fsp.mkdtemp(join(tmpdir(), `awb-manager-${fixture.name}-race-`));
    tempDirs.push(home);
    await fsp.writeFile(join(home, 'agent.lock'), fixture.contents);
    const env = { ...process.env, AWB_AGENT_MANAGER_HOME: home };
    const contenderSource = `
      const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
      ${BARRIER_PROLOGUE}
      try {
        const lock = await acquireAgentLock({ role: 'manager', version: 'new' });
        console.log('ACQUIRED');
        await new Promise((resolve) => setTimeout(resolve, 300));
        lock.release();
      } catch (error) {
        console.log('REJECTED:' + error.code);
      }
    `;
    const outputs = (await raceContenders(contenderSource, env)).map(({ output }) => output);
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
