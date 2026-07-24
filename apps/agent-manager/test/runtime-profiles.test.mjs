import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  getRuntimeProvider,
  listRuntimeProviders,
  registerRuntimeProvider,
  startRuntimeProfile,
  validateRuntimeProfile,
} from '../dist/lib/runtime-profiles.js';

const fixtureRoot = join(process.cwd(), '.test-runtime-profile');

test.after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('ships vllm and accepts a second provider through the registry', () => {
  assert.ok(listRuntimeProviders().some((p) => p.name === 'vllm'));
  const generic = getRuntimeProvider('generic');
  registerRuntimeProvider({ ...generic, name: 'local-openai' });
  assert.equal(getRuntimeProvider('local-openai').name, 'local-openai');
});

test('reports invalid venv and port with actionable field names', () => {
  assert.throws(
    () => validateRuntimeProfile({
      id: 'bad',
      provider: 'vllm',
      model: 'demo',
      venv: join(fixtureRoot, 'missing-venv'),
      port: 70_000,
    }),
    /port.*1 to 65535.*venv does not exist/s,
  );
});

test('resolves module Python directly from .venv without shell activation', async () => {
  const binDir = join(fixtureRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  await mkdir(binDir, { recursive: true });
  const python = join(binDir, process.platform === 'win32' ? 'python.exe' : 'python');
  await writeFile(python, '');
  const launch = getRuntimeProvider('vllm').build({
    id: 'vllm-demo',
    provider: 'vllm',
    model: 'demo-model',
    venv: join(fixtureRoot, '.venv'),
    module: 'vllm.entrypoints.openai.api_server',
    port: 8123,
  });
  assert.equal(launch.bin, python);
  assert.deepEqual(launch.args.slice(0, 2), ['-m', 'vllm.entrypoints.openai.api_server']);
  assert.ok(launch.args.includes('demo-model'));
});

test('waits for health and reaps the owned runtime process', async () => {
  const port = 41_000 + (process.pid % 10_000);
  const lease = await startRuntimeProfile({
    id: 'generic-fixture',
    provider: 'generic',
    model: 'fixture-model',
    executable: process.execPath,
    extra_args: [
      '-e',
      `require('http').createServer((q,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},'127.0.0.1')`,
    ],
    base_url: `http://127.0.0.1:${port}`,
    startup_timeout_ms: 10_000,
  });
  assert.ok(lease.child?.pid);
  assert.equal(lease.claudeEnv().ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`);
  const pid = lease.child.pid;
  try {
    assert.ok(pid);
  } finally {
    await lease.close();
  }
  assert.ok(lease.child.exitCode !== null || lease.child.signalCode !== null);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
