import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = await fs.mkdtemp(join(process.cwd(), '.test-session-pid-'));
process.env.AWB_AGENT_MANAGER_HOME = root;
const { BaseSessionManager } = await import('../dist/lib/base-session-manager.js');
const { createRuntimeAdapterResolver } = await import('../dist/lib/runtime/runtime-registry.js');
after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

for (const [code, failWrite] of [[0, false], [7, false], [0, true]]) {
  test(`close and initial result survive delayed PID I/O (exit=${code}, write failure=${failWrite})`, { timeout: 15_000 }, async t => {
    const closed = deferred();
    const releaseWrite = deferred();
    const pidRemoved = deferred();
    const hookCalled = deferred();
    let child;
    let writeStarted = false;
    let leaseCloses = 0;
    let sess;
    const events = [];
    const realWrite = fs.writeFile.bind(fs);
    const realUnlink = fs.unlink.bind(fs);
    t.mock.method(fs, 'writeFile', async (path, ...args) => {
      if (String(path).endsWith('.pid')) {
        writeStarted = true;
        // Neither elapsed time nor a fixture sleep controls this race. The
        // actual child must close before the write is allowed to create a file.
        await closed.promise;
        await releaseWrite.promise;
        if (failWrite) throw new Error('injected PID write failure');
      }
      return realWrite(path, ...args);
    });
    t.mock.method(fs, 'unlink', async path => {
      if (!String(path).endsWith('.pid')) return realUnlink(path);
      try { return await realUnlink(path); }
      finally { pidRemoved.resolve(); }
    });
    const resolver = createRuntimeAdapterResolver();
    const adapterResolver = {
      ports: resolver.ports,
      resolve: (...args) => resolver.resolve(...args),
      buildSession: (...args) => resolver.buildSession(...args),
      shouldRetry: (...args) => resolver.shouldRetry(...args),
      spawnProcess: () => {
        child = spawn(process.execPath, ['-e', `
          process.stdout.write(JSON.stringify({type:'result', subtype:'success', result:'early result'}) + '\\n');
          process.stderr.write('final stderr\\n');
          process.exitCode = ${code};
        `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        child.once('close', (code, signal) => closed.resolve({ code, signal }));
        return child;
      },
    };
    class Harness extends BaseSessionManager {
      _onStdoutParsed(record, parsed) {
        if (parsed.isResult) events.push(['result', record.identityReady]);
      }
      async _onChildExit(record, exitCode) {
        events.push(['close', record.identityReady, exitCode, this._collectOutputTail(record.pid, 1000)]);
        hookCalled.resolve();
      }
    }
    const manager = new Harness({
      url: 'http://127.0.0.1:0', apiKey: 'fixture',
      delegation: { enabled: true, claudeBin: process.execPath },
    }, { keyField: 'sessionKey', cfgPrefix: 'pid-race-', logTag: '[pid-race]', kindLabel: 'ticket_session', adapterResolver });
    try {
      sess = await manager._spawnSession('pid-race', '', 'first turn', { onProgress: () => {} });
      assert.ok(sess);
      // Mirrors ticket/chat callers: these fields and listeners are installed
      // immediately after await _spawnSession, before any child event may run.
      sess.identityReady = true;
      sess.runtimeLease = { close: async () => { leaseCloses++; } };
      let callerCloseCount = 0;
      sess.child.once('close', () => { callerCloseCount++; });
      assert.equal(writeStarted, true);
      assert.equal(manager._getSession('pid-race'), sess);
      assert.equal(sess.turnCount, 1);
      const actualClose = await closed.promise;
      await hookCalled.promise;
      assert.deepEqual(actualClose, { code, signal: null });
      assert.equal(callerCloseCount, 1);
      assert.equal(events[0][0], 'result');
      assert.equal(events[0][1], true, 'result must see caller identity');
      assert.equal(events[1][0], 'close');
      assert.equal(events[1][1], true, 'exit hook must see caller identity');
      assert.equal(events[1][2], code);
      assert.match(events[1][3], /final stderr/);
      assert.equal(sess._currentTurn, null);
      assert.equal(sess.idleTimer, null);
      releaseWrite.resolve();
      await pidRemoved.promise;
      assert.equal(leaseCloses, 1);
      assert.equal(manager._getSession('pid-race'), undefined);
      assert.equal(manager._outputRings.has(sess.pid), false);
      await assert.rejects(fs.stat(sess.configPath), { code: 'ENOENT' });
      await assert.rejects(fs.stat(sess.pidPath), { code: 'ENOENT' });
    } finally {
      releaseWrite.resolve();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'close');
        child.kill();
        await exit;
      }
      await manager.stop();
    }
  });
}
