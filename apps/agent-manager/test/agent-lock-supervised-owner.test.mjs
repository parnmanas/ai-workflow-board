// 락 소유자가 살아 있을 때 `--force` 의 새 규칙(agent-lockfile.ts decideForceTakeover).
//
// 배경: rolf 에서 AWB 세션이 `npm i -g awb-agent-manager@1.6.247` 을 돌린 뒤 매니저를 직접
// 띄우면, 예전 `--force` 는 systemd 가 감독하는 매니저에 SIGTERM 을 보내고 자리를 차지했다.
// 서비스는 exit 0 으로 내려가 Restart=on-failure 가 다시 띄우지 않고, 세션이 끝나는 순간
// 매니저가 아예 없어진다. 이제는
//   1. 소유자가 systemd 감독 아래면: contender 가 더 새 빌드 → SIGUSR2 로 재기동을 넘기고
//      EAGENTHANDOFF, 아니면 EAGENTSUPERVISED. 소유자는 SIGTERM 을 받지 않는다.
//      단 handoff 는 SIGUSR2 가 있는 플랫폼 전용이다 — win32 에서는 그 시그널이 없어
//      `process.kill` 이 던지고, 예전에는 그것을 삼킨 채 EAGENTHANDOFF(→ exit 0)를 올려
//      "일어나지 않은 재기동" 을 성공으로 보고했다. 그 플랫폼에서는 refuse 로 판정한다.
//      그래서 아래 세 테스트는 skip 이 아니라 **분기**다: skip 하면 같은 구멍이 다시 조용해진다.
//   2. contender 가 AWB 세션(AWB_SESSION_ID) 안이면 소유자가 감독 중이 아니어도 같은 규칙.
//   3. AWB_AGENT_MANAGER_TAKEOVER=1 일 때만 예전대로 takeover. contender 가 INVOCATION_ID /
//      JOURNAL_STREAM 을 물려받았어도(systemd 가 띄운 데스크톱 앱의 자식 셸) 예외가 아니다 —
//      그 오판이 rolf 의 서비스를 실제로 죽였다. 감독 판정은 부모 프로세스(또는 테스트 seam
//      AWB_AGENT_MANAGER_SUPERVISOR)로 한다.
//   4. --force 없이는 언제나 EAGENTLOCKED 이고, 더 새 빌드면 재기동 안내가 붙는다 — 그 문구도
//      플랫폼별로 갈린다. 이건 handoff 축(SIGUSR2 존재 여부)과 **다른 축**이다 — systemctl 은
//      linux 전용이라 darwin 은 SIGUSR2 는 있어도 그 명령을 못 돌린다. 이 경로의 메시지는
//      exit 2 + stderr 로만 남는 유일한 운영자 단서라, 실행 불가능한 지시가 거기 남으면
//      운영자에게 아무 경로도 없는 것과 같다.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compareLockVersions, decideForceTakeover } from '../dist/lib/agent-lockfile.js';
import { detectSupervisor } from '../dist/lib/supervisor.js';

const lockModuleUrl = pathToFileURL(
  join(fileURLToPath(new URL('.', import.meta.url)), '../dist/lib/agent-lockfile.js'),
).href;

const tempDirs = [];
const children = new Set();
after(async () => {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function makeHome(tag) {
  const home = await fsp.mkdtemp(join(tmpdir(), `awb-lock-owner-${tag}-`));
  tempDirs.push(home);
  return home;
}

/** 락을 잡고 살아 있는 소유자. SIGUSR2/SIGTERM 수신을 stdout 으로 알린다. */
async function startOwner(home, { version, env = {} }) {
  const source = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    const lock = await acquireAgentLock({ role: 'manager', version: ${JSON.stringify(version)} });
    console.log('OWNER_ACQUIRED:' + JSON.stringify(lock.payload));
    process.on('SIGUSR2', () => console.log('OWNER_SIGUSR2'));
    process.on('SIGTERM', () => { console.log('OWNER_SIGTERM'); lock.release(); process.exit(0); });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, AWB_AGENT_MANAGER_HOME: home, AWB_AGENT_MANAGER_SUPERVISOR: 'none', AWB_SESSION_ID: undefined, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (stdout.includes('OWNER_ACQUIRED:')) return resolve();
      if (Date.now() - started > 15_000) return reject(new Error(`owner did not acquire: ${stdout}`));
      setTimeout(tick, 25);
    };
    tick();
  });
  return {
    child,
    get stdout() { return stdout; },
    alive: () => child.exitCode === null && child.signalCode === null,
    exited: () => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve))),
  };
}

async function contend(home, { version, force, env = {} }) {
  const source = `
    const { acquireAgentLock } = await import(${JSON.stringify(lockModuleUrl)});
    try {
      const lock = await acquireAgentLock({ role: 'manager', version: ${JSON.stringify(version)}, force: ${force ? 'true' : 'false'} });
      console.log('ACQUIRED:' + JSON.stringify(lock.payload));
      lock.release();
    } catch (error) {
      console.log('REJECTED:' + error.code + ':' + error.message);
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: {
      ...process.env,
      AWB_AGENT_MANAGER_HOME: home,
      AWB_AGENT_MANAGER_SUPERVISOR: 'none',
      AWB_SESSION_ID: undefined,
      AWB_AGENT_MANAGER_TAKEOVER: undefined,
      AWB_AGENT_MANAGER_PLATFORM: undefined,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  return { code, stdout };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// win32 에는 SIGUSR2 가 없다 — 이 축이 갈리는 유일한 이유다.
const HANDOFF_AVAILABLE = process.platform !== 'win32';
// 안내 문구가 갈리는 축은 그것과 다르다 — systemctl 은 linux 전용이라 darwin 도 비-linux 쪽이다.
// contend() 는 AWB_AGENT_MANAGER_PLATFORM 을 항상 벗겨 넘기므로 seam 을 안 준 호출은 네이티브 축이다.
const SYSTEMCTL_AVAILABLE = process.platform === 'linux';

/** 보호된 소유자 + 더 새 빌드 + `--force` 의 결과. 플랫폼에 따라 에러 코드와 시그널 수신이
 *  갈리지만 "소유자는 SIGTERM 을 받지 않고 살아 있다" 는 양쪽에서 같다. */
async function assertProtectedFromNewerBuild(stdout, owner) {
  if (HANDOFF_AVAILABLE) {
    assert.match(stdout, /^REJECTED:EAGENTHANDOFF:/m, stdout);
  } else {
    assert.match(stdout, /^REJECTED:EAGENTSUPERVISED:/m, stdout);
    assert.match(stdout, /has no SIGUSR2/, stdout);
    assert.match(stdout, /restart_manager/, '거부 사유가 실제로 동작하는 대체 경로를 남긴다');
  }
  await settle(300);
  if (HANDOFF_AVAILABLE) {
    assert.match(owner.stdout, /OWNER_SIGUSR2/, 'owner was asked to re-exec in place');
  } else {
    assert.doesNotMatch(owner.stdout, /OWNER_SIGUSR2/, 'win32 에서는 보낼 수 있는 시그널이 없다');
  }
  assert.doesNotMatch(owner.stdout, /OWNER_SIGTERM/, 'owner was NOT terminated');
  assert.ok(owner.alive(), 'owner still alive');
}

test('decideForceTakeover: pure rules', () => {
  const base = { ownerVersion: '1.6.246', contenderVersion: '1.6.247', contenderInSession: false, takeoverAllowed: false, platform: 'linux' };
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: null }).kind, 'takeover', 'unsupervised owner, foreground contender → legacy takeover');
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: 'systemd' }).kind, 'handoff', 'systemd owner + newer build → handoff');
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: 'systemd', contenderVersion: '1.6.246' }).kind, 'refuse', 'systemd owner + same build → refuse');
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: 'systemd', contenderVersion: '1.6.200' }).kind, 'refuse', 'systemd owner + older build → refuse');
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: null, contenderInSession: true }).kind, 'handoff', 'inside an AWB session the owner is protected even without systemd');
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: 'systemd', takeoverAllowed: true }).kind, 'takeover', 'operator override is the ONLY way past a supervised owner');
  // 플랫폼 축 — 같은 입력에서 SIGUSR2 가 없는 플랫폼만 handoff 대신 refuse 로 갈린다.
  const win = { ...base, platform: 'win32' };
  assert.equal(decideForceTakeover({ ...win, ownerSupervisor: 'systemd' }).kind, 'refuse', 'win32: SIGUSR2 가 없어 handoff 가 성립하지 않는다');
  assert.equal(decideForceTakeover({ ...win, ownerSupervisor: null, contenderInSession: true }).kind, 'refuse', 'win32: 세션 축에서도 같다');
  assert.match(
    decideForceTakeover({ ...win, ownerSupervisor: 'systemd' }).reason,
    /has no SIGUSR2/,
    'win32 거부 사유는 왜 넘길 수 없는지 밝힌다',
  );
  assert.match(
    decideForceTakeover({ ...win, ownerSupervisor: 'systemd' }).reason,
    /restart_manager/,
    'win32 거부 사유는 systemctl 대신 실제로 동작하는 경로를 안내한다',
  );
  assert.equal(decideForceTakeover({ ...win, ownerSupervisor: null }).kind, 'takeover', 'win32: 보호 대상이 아니면 그대로 takeover');
  assert.equal(decideForceTakeover({ ...win, ownerSupervisor: 'systemd', takeoverAllowed: true }).kind, 'takeover', 'win32: 운영자 override 는 그대로 통한다');
  assert.match(
    decideForceTakeover({ ...base, ownerSupervisor: 'systemd', contenderVersion: '1.6.246' }).reason,
    /systemctl --user restart/,
    'linux 거부 사유는 systemctl 경로를 그대로 안내한다',
  );
  assert.doesNotMatch(
    decideForceTakeover({ ...win, ownerSupervisor: 'systemd', contenderVersion: '1.6.246' }).reason,
    /systemctl/,
    'win32 에 systemctl 을 안내하면 유일한 단서가 실행 불가능한 지시가 된다',
  );

  assert.equal(compareLockVersions('1.6.247', '1.6.246'), 1);
  assert.equal(compareLockVersions('1.6.246', '1.6.246'), 0);
  assert.equal(compareLockVersions('e2e', '1.6.246'), 0, 'non-semver compares equal (no false "newer")');
});

test('systemd-managed owner + newer build with --force → owner protected (SIGUSR2 hand-off where the platform has it), owner keeps running', async () => {
  const home = await makeHome('handoff');
  const owner = await startOwner(home, { version: '1.6.246', env: { AWB_AGENT_MANAGER_SUPERVISOR: 'systemd' } });
  assert.match(owner.stdout, /"supervisor":"systemd"/, 'owner lock records its supervisor');

  const { stdout } = await contend(home, { version: '1.6.247', force: true });
  assert.match(stdout, /newer than the systemd-managed manager/);
  await assertProtectedFromNewerBuild(stdout, owner);
  owner.child.kill('SIGKILL');
});

test('systemd-managed owner + same build with --force → refused, owner untouched', async () => {
  const home = await makeHome('refuse');
  const owner = await startOwner(home, { version: '1.6.246', env: { AWB_AGENT_MANAGER_SUPERVISOR: 'systemd' } });
  const { stdout } = await contend(home, { version: '1.6.246', force: true });
  assert.match(stdout, /^REJECTED:EAGENTSUPERVISED:/m, stdout);
  assert.match(stdout, /AWB_AGENT_MANAGER_TAKEOVER=1/, 'the refusal names the override');
  await settle(200);
  assert.doesNotMatch(owner.stdout, /OWNER_SIGUSR2|OWNER_SIGTERM/);
  assert.ok(owner.alive());
  owner.child.kill('SIGKILL');
});

test('inside an AWB session, --force against an unsupervised owner protects it instead of killing it', async () => {
  const home = await makeHome('session');
  const owner = await startOwner(home, { version: '1.6.246' });
  const { stdout } = await contend(home, { version: '1.6.247', force: true, env: { AWB_SESSION_ID: 'ses_test' } });
  // 양쪽 플랫폼의 문구에 공통으로 남는 부분만 본다 — linux 는 "started from an AWB agent
  // session", win32 는 "refusing --force takeover from an AWB agent session" 이다.
  assert.match(stdout, /from an AWB agent session/);
  await assertProtectedFromNewerBuild(stdout, owner);
  owner.child.kill('SIGKILL');
});

test('inherited INVOCATION_ID / JOURNAL_STREAM on the contender do NOT unlock a takeover (the rolf regression)', async () => {
  const home = await makeHome('inherited-markers');
  const owner = await startOwner(home, { version: '1.6.246', env: { AWB_AGENT_MANAGER_SUPERVISOR: 'systemd' } });
  // Claude Code 데스크톱 앱처럼 systemd 가 띄운 프로세스의 자식 셸은 이 두 변수를 물려받는다.
  const { stdout } = await contend(home, { version: '1.6.247', force: true, env: { INVOCATION_ID: 'inherited', JOURNAL_STREAM: '8:12345' } });
  await assertProtectedFromNewerBuild(stdout, owner);
  owner.child.kill('SIGKILL');
});

// 위 세 테스트의 win32 축은 windows-latest 잡에서만 실제로 실행된다. 그 잡 하나에 기대면
// 언젠가 그 잡이 빠지거나 skip 되는 순간 "일어나지 않은 재기동을 exit 0 으로 보고" 하던
// 구멍이 다시 조용해지므로, 플랫폼 seam 으로 같은 경로를 **모든** OS 에서 한 번 더 고정한다.
// tmpdir()/path.join 까지 win32 로 바꿀 수는 없으니 갈리는 축 하나만 바꿔 끼운다.
test('AWB_AGENT_MANAGER_PLATFORM=win32: hand-off 대신 거부하고, 소유자는 아무 시그널도 받지 않는다', async () => {
  const home = await makeHome('win32-seam');
  const owner = await startOwner(home, { version: '1.6.246', env: { AWB_AGENT_MANAGER_SUPERVISOR: 'systemd' } });

  const { stdout } = await contend(home, {
    version: '1.6.247',
    force: true,
    env: { AWB_AGENT_MANAGER_PLATFORM: 'win32' },
  });
  // 더 새 빌드인데도 handoff 가 아니다 — 보낼 수 있는 시그널이 없기 때문이고, 그 사실이
  // 운영자에게 남는 유일한 단서다.
  assert.match(stdout, /^REJECTED:EAGENTSUPERVISED:/m, stdout);
  assert.match(stdout, /newer than the systemd-managed manager/, stdout);
  assert.match(stdout, /win32 has no SIGUSR2/, stdout);
  assert.match(stdout, /restart_manager/, '거부 사유가 실제로 동작하는 대체 경로를 남긴다');
  assert.doesNotMatch(stdout, /systemctl/, 'win32 에 systemctl 을 안내하지 않는다');
  assert.doesNotMatch(stdout, /REJECTED:EAGENTHANDOFF/, stdout);

  await settle(300);
  assert.doesNotMatch(owner.stdout, /OWNER_SIGUSR2/, '보낼 수 없는 시그널을 보냈다고 하지 않는다');
  assert.doesNotMatch(owner.stdout, /OWNER_SIGTERM/, '보호 대상은 여전히 SIGTERM 을 받지 않는다');
  assert.ok(owner.alive(), 'owner still alive');
  owner.child.kill('SIGKILL');
});

test('detectSupervisor: parent-process based, with the explicit seam; env markers alone mean nothing', () => {
  assert.equal(detectSupervisor({ AWB_AGENT_MANAGER_SUPERVISOR: 'systemd' }), 'systemd');
  assert.equal(detectSupervisor({ AWB_AGENT_MANAGER_SUPERVISOR: 'none', INVOCATION_ID: 'x', JOURNAL_STREAM: 'y' }), null);
  // 이 테스트 러너의 부모는 node(또는 npm)이지 systemd 가 아니다 — 물려받은 표식이 있어도 null.
  assert.equal(detectSupervisor({ INVOCATION_ID: 'inherited', JOURNAL_STREAM: '8:1' }), null);
});

test('AWB_AGENT_MANAGER_TAKEOVER=1 restores the legacy takeover from a foreground shell', async () => {
  const home = await makeHome('override');
  const owner = await startOwner(home, { version: '1.6.246', env: { AWB_AGENT_MANAGER_SUPERVISOR: 'systemd' } });
  const { stdout } = await contend(home, { version: '1.6.247', force: true, env: { AWB_AGENT_MANAGER_TAKEOVER: '1' } });
  assert.match(stdout, /^ACQUIRED:/m, stdout);
  await owner.exited();
});

test('without --force a live owner is always EAGENTLOCKED; a newer build gets the SIGUSR2 hint', async () => {
  const home = await makeHome('locked');
  const owner = await startOwner(home, { version: '1.6.246', env: { AWB_AGENT_MANAGER_SUPERVISOR: 'systemd' } });
  const newer = await contend(home, { version: '1.6.247', force: false });
  assert.match(newer.stdout, /^REJECTED:EAGENTLOCKED:/m, newer.stdout);
  if (SYSTEMCTL_AVAILABLE) {
    assert.match(newer.stdout, /systemctl --user kill -s SIGUSR2 awb-agent-manager/, 'linux: 제자리 재적재 명령을 그대로 안내한다');
  } else {
    assert.doesNotMatch(newer.stdout, /systemctl/, 'systemctl 이 없는 플랫폼에 그 명령을 안내하지 않는다');
    assert.match(newer.stdout, /restart_manager/, '대신 실제로 동작하는 경로를 남긴다');
  }
  assert.match(newer.stdout, /\(systemd\)/, 'owner supervisor shown');
  const same = await contend(home, { version: '1.6.246', force: false });
  assert.match(same.stdout, /^REJECTED:EAGENTLOCKED:/m);
  assert.match(same.stdout, /pass --force to take over/);
  await settle(200);
  assert.doesNotMatch(owner.stdout, /OWNER_SIGUSR2|OWNER_SIGTERM/);
  owner.child.kill('SIGKILL');
});

// 위 테스트가 보는 것은 이 잡이 도는 OS 하나의 축뿐이다. 문구가 갈리는 두 쪽을
// **모든** OS 에서 한 번씩 고정해 두지 않으면, 어느 한 잡이 빠지는 순간 실행 불가능한
// 지시가 조용히 돌아온다 — :225-227 의 근거를 비-force 경로에 그대로 적용한다.
test('AWB_AGENT_MANAGER_PLATFORM: 비-force 의 더 새 빌드 안내도 플랫폼별로 갈린다', async () => {
  const home = await makeHome('locked-platform-seam');
  const owner = await startOwner(home, { version: '1.6.246', env: { AWB_AGENT_MANAGER_SUPERVISOR: 'systemd' } });

  const win = await contend(home, {
    version: '1.6.247',
    force: false,
    env: { AWB_AGENT_MANAGER_PLATFORM: 'win32' },
  });
  assert.match(win.stdout, /^REJECTED:EAGENTLOCKED:/m, win.stdout);
  assert.doesNotMatch(win.stdout, /systemctl/, 'win32 에 systemctl 을 안내하면 유일한 단서가 실행 불가능한 지시가 된다');
  assert.match(win.stdout, /restart_manager/, '거기에도 실제로 동작하는 대체 경로를 남긴다');

  const linux = await contend(home, {
    version: '1.6.247',
    force: false,
    env: { AWB_AGENT_MANAGER_PLATFORM: 'linux' },
  });
  assert.match(linux.stdout, /^REJECTED:EAGENTLOCKED:/m, linux.stdout);
  assert.match(
    linux.stdout,
    /systemctl --user kill -s SIGUSR2 awb-agent-manager/,
    'linux 명령은 글자 그대로 보존된다 — 이 변경은 문구를 갈라 넣을 뿐 바꾸지 않는다',
  );

  // --force 가 없으므로 어느 쪽도 실제 재기동을 시도하지 않는다 — 안내만 한다.
  await settle(200);
  assert.doesNotMatch(owner.stdout, /OWNER_SIGUSR2|OWNER_SIGTERM/, '비-force 경로는 소유자를 건드리지 않는다');
  assert.ok(owner.alive(), 'owner still alive');
  owner.child.kill('SIGKILL');
});
