import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const moduleUrl = new URL('../dist/lib/agent-lockfile.js', import.meta.url).href;
async function scenario(body) {
  const home = await mkdtemp(join(tmpdir(), 'awb-lock-publication-'));
  try {
    await run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const path = join(process.env.AWB_AGENT_MANAGER_HOME, 'agent.lock');
      const realRead = fs.readFileSync;
      const realLink = fs.linkSync;
      const realUnlink = fs.unlinkSync;
      const owner = JSON.stringify({ pid: 999999999, role: 'manager' });
      const live = JSON.stringify({ pid: process.pid, role: 'manager' });
      const load = async () => { syncBuiltinESMExports(); return import(${JSON.stringify(moduleUrl)}); };
      const opts = { role: 'manager', version: '1.0.0' };
      ${body}
    `], { env: { ...process.env, AWB_AGENT_MANAGER_HOME: home, AWB_AGENT_MANAGER_TAKEOVER: '1' }, timeout: 10000 });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('publication exposes complete JSON; failed exclusive link preserves winner and cleans temporary file', async () => {
  await scenario(`
    let links = 0;
    fs.linkSync = (src, dst) => {
      assert.equal(JSON.parse(realRead(src, 'utf8')).pid, process.pid);
      links++;
      return realLink(src, dst);
    };
    const { acquireAgentLock } = await load();
    const handle = await acquireAgentLock(opts);
    await assert.rejects(acquireAgentLock(opts), { code: 'EAGENTLOCKED' });
    assert.equal(links, 2);
    assert.deepEqual(fs.readdirSync(process.env.AWB_AGENT_MANAGER_HOME).filter(name => name !== 'agent-manager.log'), ['agent.lock']);
    handle.release();
  `);
});

test('unsupported hard links fail closed without creating agent.lock', async () => {
  await scenario(`
    const fault = Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
    fs.linkSync = () => { throw fault; };
    const { acquireAgentLock } = await load();
    await assert.rejects(acquireAgentLock(opts), err => err === fault);
    assert.deepEqual(fs.readdirSync(process.env.AWB_AGENT_MANAGER_HOME), []);
  `);
});

for (const stage of ['initial', 'stale', 'force', 'after-kill']) {
  for (const code of ['empty', 'EBUSY', 'EPERM', 'EACCES']) {
    test(`${stage}: ${code} never removes an unknown owner`, async () => {
      await scenario(`
        const stage = ${JSON.stringify(stage)};
        const code = ${JSON.stringify(code)};
        fs.writeFileSync(path, stage === 'initial' ? '' : owner);
        let reads = 0, signals = 0, dead = false;
        process.kill = (pid, signal) => {
          if (pid !== 999999999) return true;
          if (stage === 'stale' || dead) throw Object.assign(new Error(), { code: 'ESRCH' });
          if (signal !== 0) { signals++; dead = true; }
          return true;
        };
        const start = stage === 'initial' ? 1 : stage === 'after-kill' ? 3 : 2;
        const fault = Object.assign(new Error('read denied'), { code });
        fs.readFileSync = (file, ...args) => {
          if (file === path && ++reads >= start) {
            if (code === 'empty') return '';
            throw fault;
          }
          return realRead(file, ...args);
        };
        let unlinks = 0;
        fs.unlinkSync = (file) => { if (file === path) unlinks++; return realUnlink(file); };
        const { acquireAgentLock } = await load();
        await assert.rejects(acquireAgentLock({ ...opts, force: stage === 'force' || stage === 'after-kill' }),
          err => code === 'empty' ? err.code === 'EAGENTLOCKINVALID' : err === fault);
        assert.equal(unlinks, 0);
        assert.equal(signals, stage === 'after-kill' ? 1 : 0);
        assert.equal(reads, start + 4);
        assert.equal(realRead(path, 'utf8'), stage === 'initial' ? '' : owner);
      `);
    });
  }
}

test('legacy writer can finish after contender gives up; its open inode remains the lock', async () => {
  await scenario(`
    const fd = fs.openSync(path, 'wx');
    const { acquireAgentLock } = await load();
    await assert.rejects(acquireAgentLock(opts), { code: 'EAGENTLOCKINVALID' });
    fs.writeSync(fd, live);
    fs.closeSync(fd);
    assert.equal(realRead(path, 'utf8'), live);
  `);
});

for (const failure of ['empty', 'EBUSY']) {
  test(`transient ${failure} resolves to live owner on retry`, async () => {
    await scenario(`
      fs.writeFileSync(path, live);
      let reads = 0;
      fs.readFileSync = (file, ...args) => {
        if (file === path && ++reads === 1) {
          if (${JSON.stringify(failure)} === 'empty') return '';
          throw Object.assign(new Error(), { code: 'EBUSY' });
        }
        return realRead(file, ...args);
      };
      const { acquireAgentLock } = await load();
      await assert.rejects(acquireAgentLock(opts), { code: 'EAGENTLOCKED' });
      assert.equal(reads, 2);
      assert.equal(realRead(path, 'utf8'), live);
    `);
  });
}

test('ENOENT under recovery guard does not unlink a newly published winner', async () => {
  await scenario(`
    fs.writeFileSync(path, owner);
    let reads = 0;
    fs.readFileSync = (file, ...args) => {
      if (file === path && ++reads === 2) {
        fs.writeFileSync(path, live);
        throw Object.assign(new Error(), { code: 'ENOENT' });
      }
      return realRead(file, ...args);
    };
    let unlinks = 0;
    fs.unlinkSync = (file) => { if (file === path) unlinks++; return realUnlink(file); };
    const { acquireAgentLock } = await load();
    await assert.rejects(acquireAgentLock(opts), { code: 'EAGENTLOCKED' });
    assert.equal(unlinks, 0);
    assert.equal(realRead(path, 'utf8'), live);
  `);
});

test('partial temporary write is never visible at agent.lock and is cleaned on failure', async () => {
  await scenario(`
    const realWrite = fs.writeFileSync;
    const fault = Object.assign(new Error(), { code: 'ENOSPC' });
    fs.writeFileSync = (file, ...args) => {
      if (String(file).startsWith(path + '.tmp-')) {
        realWrite(file, '');
        assert.equal(fs.existsSync(path), false);
        throw fault;
      }
      return realWrite(file, ...args);
    };
    const { acquireAgentLock } = await load();
    await assert.rejects(acquireAgentLock(opts), err => err === fault);
    assert.deepEqual(fs.readdirSync(process.env.AWB_AGENT_MANAGER_HOME), []);
  `);
});

for (const force of [false, true]) {
  test(`lost create race read errors preserve errno without restarting (force=${force})`, async () => {
    await scenario(`
      fs.writeFileSync(path, owner);
      let links = 0, reads = 0;
      fs.linkSync = (src, dst) => {
        if (++links === 2) {
          fs.writeFileSync(path, live);
          throw Object.assign(new Error(), { code: 'EEXIST' });
        }
        return realLink(src, dst);
      };
      let dead = false;
      process.kill = (pid, signal) => {
        if (pid !== 999999999) return true;
        if (!${force} || dead) throw Object.assign(new Error(), { code: 'ESRCH' });
        if (signal !== 0) dead = true;
        return true;
      };
      const fault = Object.assign(new Error('busy winner'), { code: 'EBUSY' });
      fs.readFileSync = (file, ...args) => {
        if (file === path && links >= 2) { reads++; throw fault; }
        return realRead(file, ...args);
      };
      const { acquireAgentLock } = await load();
      await assert.rejects(acquireAgentLock({ ...opts, force: ${force} }), err => err === fault);
      assert.equal(links, 2);
      assert.equal(reads, 5);
      assert.equal(realRead(path, 'utf8'), live);
    `);
  });
}

test('force losing publication to a departed winner does not restart takeover', async () => {
  await scenario(`
    fs.writeFileSync(path, owner);
    let links = 0, signals = 0, dead = false;
    process.kill = (pid, signal) => {
      if (pid !== 999999999) return true;
      if (dead) throw Object.assign(new Error(), { code: 'ESRCH' });
      if (signal !== 0) { dead = true; signals++; }
      return true;
    };
    fs.linkSync = (src, dst) => {
      if (++links === 2) throw Object.assign(new Error(), { code: 'EEXIST' });
      return realLink(src, dst);
    };
    const { acquireAgentLock } = await load();
    await assert.rejects(acquireAgentLock({ ...opts, force: true }), { code: 'EAGENTTAKEOVER' });
    assert.equal(links, 2);
    assert.equal(signals, 1);
    assert.equal(fs.existsSync(path), false);
  `);
});
