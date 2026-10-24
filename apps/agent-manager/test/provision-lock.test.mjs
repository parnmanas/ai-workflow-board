import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { withProvisionDirectoryLock } from '../dist/lib/provision-lock.js';

const options = { timeoutMs: 500, staleMs: 10, heartbeatMs: 5 };
const deadPid = 2147483647;
const ownerName = (pid = deadPid) => `owner-${pid}-${randomUUID()}.json`;
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'awb-provision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = join(root, '.provision.lock');
  const run = (fn, extra = {}) => withProvisionDirectoryLock(root, { ...options, ...extra }, fn);
  return { root, dir, run };
}
async function seed(dir, name) {
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await fs.writeFile(path, 'partial');
  await fs.utimes(path, new Date(0), new Date(0));
  return path;
}

test('independent contenders serialize, heartbeat uses owner, and failures release', async (t) => {
  const { dir, run } = await fixture(t);
  let active = 0;
  const work = async () => {
    assert.equal(++active, 1);
    const [name] = await fs.readdir(dir);
    assert.match(name, /^owner-/);
    const path = join(dir, name);
    await fs.utimes(path, new Date(0), new Date(0));
    await new Promise(r => setTimeout(r, 30));
    assert.ok((await fs.stat(path)).mtimeMs > 1000);
    active--;
  };
  await Promise.all([run(work), run(work), run(work)]);
  await assert.rejects(run(async () => { throw new Error('callback failed'); }), /callback failed/);
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
});

test('stale dead and empty owners recover, but partial live and legacy owners survive', async (t) => {
  const { dir, run } = await fixture(t);
  await seed(dir, ownerName());
  await run(async () => {});
  await fs.mkdir(dir);
  await fs.utimes(dir, new Date(0), new Date(0));
  await run(async () => {});
  for (const name of [ownerName(process.pid), 'owner.json', 'unknown']) {
    const path = await seed(dir, name);
    await assert.rejects(run(async () => assert.fail('must not enter')), /provision lock timeout/);
    assert.equal(await fs.readFile(path, 'utf8'), 'partial');
    await fs.unlink(path);
    await fs.rmdir(dir);
  }
});

test('delayed stale unlink cannot remove the successor owner', async (t) => {
  const { dir, run } = await fixture(t);
  const stale = await seed(dir, ownerName());
  const unlink = fs.unlink.bind(fs);
  let successor;
  t.mock.method(fs, 'unlink', async path => {
    if (path === stale && !successor) {
      await unlink(stale);
      await fs.rmdir(dir);
      successor = await seed(dir, ownerName(process.pid));
    }
    return unlink(path);
  });
  await assert.rejects(run(async () => assert.fail('successor holds lock')), /timeout/);
  assert.equal(await fs.readFile(successor, 'utf8'), 'partial');
});

test('delayed release and heartbeat cannot touch a replacement lock', async (t) => {
  const { dir, run } = await fixture(t);
  let successor;
  await run(async () => {
    const [name] = await fs.readdir(dir);
    await fs.unlink(join(dir, name));
    await fs.rmdir(dir);
    successor = await seed(dir, ownerName(process.pid));
    await new Promise(r => setTimeout(r, 25));
    assert.equal((await fs.stat(successor)).mtimeMs, 0);
  });
  assert.equal(await fs.readFile(successor, 'utf8'), 'partial');
});

test('late publisher withdraws from a successor directory', async (t) => {
  const { dir, run } = await fixture(t);
  const write = fs.writeFile.bind(fs);
  let successor;
  t.mock.method(fs, 'writeFile', async (path, ...args) => {
    if (!successor && String(path).startsWith(dir)) {
      await fs.rmdir(dir);
      await fs.mkdir(dir);
      successor = join(dir, ownerName(process.pid));
      await write(successor, 'successor');
    }
    return write(path, ...args);
  });
  await assert.rejects(run(async () => assert.fail('late publisher entered')), /timeout/);
  assert.deepEqual(await fs.readdir(dir), [successor.slice(dir.length + 1)]);
});

test('write failure removes only its partial owner and permits retry', async (t) => {
  const { dir, run } = await fixture(t);
  const write = fs.writeFile.bind(fs);
  const mock = t.mock.method(fs, 'writeFile', async (path, ...args) => {
    await write(path, ...args);
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  await assert.rejects(run(async () => assert.fail('incomplete owner')), /disk full/);
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
  mock.mock.restore();
  await run(async () => {});
});

test('separate processes never overlap their protected operations', async (t) => {
  const { root } = await fixture(t);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const script = `
    import { withProvisionDirectoryLock } from ${JSON.stringify(new URL('../dist/lib/provision-lock.js', import.meta.url).href)};
    import { promises as fs } from 'node:fs';
    const root = process.argv[1];
    for (let i = 0; i < 4; i++) {
      await withProvisionDirectoryLock(root, { timeoutMs: 5000, staleMs: 10, heartbeatMs: 5 }, async () => {
        const sentinel = root + '/exclusive';
        await fs.writeFile(sentinel, 'held', { flag: 'wx' });
        await new Promise(r => setTimeout(r, 20));
        await fs.unlink(sentinel);
      });
    }
  `;
  await Promise.all(Array.from({ length: 3 }, () =>
    promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root])));
});

test('permission errors probing a stale PID do not authorize recovery', async (t) => {
  const { dir, run } = await fixture(t);
  const owner = await seed(dir, ownerName());
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
  });
  await assert.rejects(run(async () => assert.fail('unconfirmed death')), /timeout/);
  assert.equal(await fs.readFile(owner, 'utf8'), 'partial');
});

test('successor published between release unlink and rmdir is preserved', async (t) => {
  const { dir, run } = await fixture(t);
  const rmdir = fs.rmdir.bind(fs);
  let successor;
  t.mock.method(fs, 'rmdir', async path => {
    if (path === dir && !successor) {
      await rmdir(dir);
      successor = await seed(dir, ownerName(process.pid));
    }
    return rmdir(path);
  });
  await run(async () => {});
  assert.equal(await fs.readFile(successor, 'utf8'), 'partial');
});

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`delete-pending mkdir ${code} retries without touching the existing owner`, async (t) => {
    const { dir, run } = await fixture(t);
    const owner = await seed(dir, ownerName(process.pid));
    const mkdir = fs.mkdir.bind(fs);
    let attempts = 0;
    t.mock.method(fs, 'mkdir', async (path, ...args) => {
      if (path === dir && ++attempts <= 2) {
        assert.equal(await fs.readFile(owner, 'utf8'), 'partial');
        throw Object.assign(new Error('delete pending'), { code });
      }
      if (path === dir && attempts === 3) {
        assert.equal(await fs.readFile(owner, 'utf8'), 'partial');
        await fs.unlink(owner);
        await fs.rmdir(dir);
      }
      return mkdir(path, ...args);
    });
    let entered = 0;
    await run(async () => { entered++; });
    assert.equal(attempts, 3);
    assert.equal(entered, 1);
  });

  test(`persistent mkdir ${code} preserves the original error at the deadline`, async (t) => {
    const { dir, run } = await fixture(t);
    const mkdir = fs.mkdir.bind(fs);
    const denied = Object.assign(new Error('permission denied'), { code });
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    let attempts = 0;
    t.mock.method(fs, 'mkdir', async (path, ...args) => {
      if (path === dir) {
        attempts++;
        now += 25;
        throw denied;
      }
      return mkdir(path, ...args);
    });
    await assert.rejects(run(async () => assert.fail('must not enter'), { timeoutMs: 30 }), err => err === denied);
    assert.equal(attempts, 2);
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
  });
}

test('owner publication permission errors are not retried as mkdir contention', async (t) => {
  const { dir, run } = await fixture(t);
  const denied = Object.assign(new Error('owner write denied'), { code: 'EPERM' });
  let attempts = 0;
  t.mock.method(fs, 'writeFile', async () => { attempts++; throw denied; });
  await assert.rejects(run(async () => assert.fail('must not enter')), err => err === denied);
  assert.equal(attempts, 1);
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
});

test('persistent mkdir denial is bounded even if the clock does not advance', async (t) => {
  const { dir, run } = await fixture(t);
  const mkdir = fs.mkdir.bind(fs);
  const denied = Object.assign(new Error('permission denied'), { code: 'EPERM' });
  t.mock.method(Date, 'now', () => 0);
  // This branch only schedules its retry pause; run it immediately so the
  // attempt bound is tested independently of wall-clock progress.
  t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); });
  let attempts = 0;
  t.mock.method(fs, 'mkdir', async (path, ...args) => {
    if (path === dir) { attempts++; throw denied; }
    return mkdir(path, ...args);
  });
  await assert.rejects(run(async () => assert.fail('must not enter')), err => err === denied);
  assert.equal(attempts, 80);
});
