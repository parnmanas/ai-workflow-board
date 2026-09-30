// 락 소유자가 살아 있을 때 `--force` 의 새 규칙(agent-lockfile.ts decideForceTakeover).
//
// 배경: rolf 에서 AWB 세션이 `npm i -g awb-agent-manager@1.6.247` 을 돌린 뒤 매니저를 직접
// 띄우면, 예전 `--force` 는 systemd 가 감독하는 매니저에 SIGTERM 을 보내고 자리를 차지했다.
// 서비스는 exit 0 으로 내려가 Restart=on-failure 가 다시 띄우지 않고, 세션이 끝나는 순간
// 매니저가 아예 없어진다. 이제는
//   1. 소유자가 systemd 감독 아래면: contender 가 더 새 빌드 → SIGUSR2 로 재기동을 넘기고
//      EAGENTHANDOFF, 아니면 EAGENTSUPERVISED. 소유자는 SIGTERM 을 받지 않는다.
//   2. contender 가 AWB 세션(AWB_SESSION_ID) 안이면 소유자가 감독 중이 아니어도 같은 규칙.
//   3. contender 자신이 systemd 아래(서비스 재시작)거나 AWB_AGENT_MANAGER_TAKEOVER=1 이면
//      예전대로 takeover.
//   4. --force 없이는 언제나 EAGENTLOCKED 이고, 더 새 빌드면 SIGUSR2 안내가 붙는다.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compareLockVersions, decideForceTakeover } from '../dist/lib/agent-lockfile.js';

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
    env: { ...process.env, AWB_AGENT_MANAGER_HOME: home, INVOCATION_ID: undefined, JOURNAL_STREAM: undefined, AWB_SESSION_ID: undefined, ...env },
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
    env: { ...process.env, AWB_AGENT_MANAGER_HOME: home, INVOCATION_ID: undefined, JOURNAL_STREAM: undefined, AWB_SESSION_ID: undefined, AWB_AGENT_MANAGER_TAKEOVER: undefined, ...env },
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

test('decideForceTakeover: pure rules', () => {
  const base = { ownerVersion: '1.6.246', contenderVersion: '1.6.247', contenderSupervisor: null, contenderInSession: false, takeoverAllowed: false };
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: null }).kind, 'takeover', 'unsupervised owner, foreground contender → legacy takeover');
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: 'systemd' }).kind, 'handoff', 'systemd owner + newer build → handoff');
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: 'systemd', contenderVersion: '1.6.246' }).kind, 'refuse', 'systemd owner + same build → refuse');
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: 'systemd', contenderVersion: '1.6.200' }).kind, 'refuse', 'systemd owner + older build → refuse');
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: null, contenderInSession: true }).kind, 'handoff', 'inside an AWB session the owner is protected even without systemd');
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: 'systemd', contenderSupervisor: 'systemd' }).kind, 'takeover', 'a systemd-started contender (service restart) may take over');
  assert.equal(decideForceTakeover({ ...base, ownerSupervisor: 'systemd', takeoverAllowed: true }).kind, 'takeover', 'operator override');
  assert.equal(compareLockVersions('1.6.247', '1.6.246'), 1);
  assert.equal(compareLockVersions('1.6.246', '1.6.246'), 0);
  assert.equal(compareLockVersions('e2e', '1.6.246'), 0, 'non-semver compares equal (no false "newer")');
});

test('systemd-managed owner + newer build with --force → SIGUSR2 hand-off, owner keeps running', async () => {
  const home = await makeHome('handoff');
  const owner = await startOwner(home, { version: '1.6.246', env: { INVOCATION_ID: 'fake-unit-invocation' } });
  assert.match(owner.stdout, /"supervisor":"systemd"/, 'owner lock records its supervisor');

  const { stdout } = await contend(home, { version: '1.6.247', force: true });
  assert.match(stdout, /^REJECTED:EAGENTHANDOFF:/m, stdout);
  assert.match(stdout, /newer than the systemd-managed manager/);
  await settle(300);
  assert.match(owner.stdout, /OWNER_SIGUSR2/, 'owner was asked to re-exec in place');
  assert.doesNotMatch(owner.stdout, /OWNER_SIGTERM/, 'owner was NOT terminated');
  assert.ok(owner.alive(), 'owner still alive');
  owner.child.kill('SIGKILL');
});

test('systemd-managed owner + same build with --force → refused, owner untouched', async () => {
  const home = await makeHome('refuse');
  const owner = await startOwner(home, { version: '1.6.246', env: { INVOCATION_ID: 'fake-unit-invocation' } });
  const { stdout } = await contend(home, { version: '1.6.246', force: true });
  assert.match(stdout, /^REJECTED:EAGENTSUPERVISED:/m, stdout);
  assert.match(stdout, /AWB_AGENT_MANAGER_TAKEOVER=1/, 'the refusal names the override');
  await settle(200);
  assert.doesNotMatch(owner.stdout, /OWNER_SIGUSR2|OWNER_SIGTERM/);
  assert.ok(owner.alive());
  owner.child.kill('SIGKILL');
});

test('inside an AWB session, --force against an unsupervised owner hands off instead of killing it', async () => {
  const home = await makeHome('session');
  const owner = await startOwner(home, { version: '1.6.246' });
  const { stdout } = await contend(home, { version: '1.6.247', force: true, env: { AWB_SESSION_ID: 'ses_test' } });
  assert.match(stdout, /^REJECTED:EAGENTHANDOFF:/m, stdout);
  assert.match(stdout, /started from an AWB agent session/);
  await settle(300);
  assert.match(owner.stdout, /OWNER_SIGUSR2/);
  assert.doesNotMatch(owner.stdout, /OWNER_SIGTERM/);
  owner.child.kill('SIGKILL');
});

test('a systemd-started contender (service restart) still takes over a supervised owner', async () => {
  const home = await makeHome('service-restart');
  const owner = await startOwner(home, { version: '1.6.246', env: { INVOCATION_ID: 'old-invocation' } });
  const { stdout } = await contend(home, { version: '1.6.247', force: true, env: { INVOCATION_ID: 'new-invocation' } });
  assert.match(stdout, /^ACQUIRED:/m, stdout);
  await owner.exited();
  assert.match(owner.stdout, /OWNER_SIGTERM/, 'legacy takeover terminated the owner');
});

test('AWB_AGENT_MANAGER_TAKEOVER=1 restores the legacy takeover from a foreground shell', async () => {
  const home = await makeHome('override');
  const owner = await startOwner(home, { version: '1.6.246', env: { INVOCATION_ID: 'fake-unit-invocation' } });
  const { stdout } = await contend(home, { version: '1.6.247', force: true, env: { AWB_AGENT_MANAGER_TAKEOVER: '1' } });
  assert.match(stdout, /^ACQUIRED:/m, stdout);
  await owner.exited();
});

test('without --force a live owner is always EAGENTLOCKED; a newer build gets the SIGUSR2 hint', async () => {
  const home = await makeHome('locked');
  const owner = await startOwner(home, { version: '1.6.246', env: { INVOCATION_ID: 'fake-unit-invocation' } });
  const newer = await contend(home, { version: '1.6.247', force: false });
  assert.match(newer.stdout, /^REJECTED:EAGENTLOCKED:/m, newer.stdout);
  assert.match(newer.stdout, /SIGUSR2/, 'newer build → reload hint');
  assert.match(newer.stdout, /\(systemd\)/, 'owner supervisor shown');
  const same = await contend(home, { version: '1.6.246', force: false });
  assert.match(same.stdout, /^REJECTED:EAGENTLOCKED:/m);
  assert.match(same.stdout, /pass --force to take over/);
  await settle(200);
  assert.doesNotMatch(owner.stdout, /OWNER_SIGUSR2|OWNER_SIGTERM/);
  owner.child.kill('SIGKILL');
});
