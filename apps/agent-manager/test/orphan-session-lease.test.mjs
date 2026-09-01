import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cleanupOrphanSubagents } from '../dist/lib/orphan-cleanup.js';

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
  const elapsed = Number(/ACQUIRED:(\d+)/.exec(output)?.[1]);
  assert.ok(elapsed >= 300, `이전 manager drain 전에 lock을 취득함: ${elapsed}ms`);
  assert.equal(alive(owner.pid), false, '새 소유권 공개 시점에는 이전 manager가 종료돼야 한다');
});
