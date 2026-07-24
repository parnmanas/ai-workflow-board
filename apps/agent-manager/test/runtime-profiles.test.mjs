import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  getRuntimeProvider,
  listRuntimeProviders,
  registerRuntimeProvider,
  runtimeCredentialEnv,
  shutdownRuntimeProfiles,
  startRuntimeProfile,
  validateRuntimeProfile,
} from '../dist/lib/runtime-profiles.js';

const fixtureRoot = join(process.cwd(), '.test-runtime-profile');

function assertNotRunning(pid) {
  if (process.platform === 'win32') {
    assert.throws(() => process.kill(pid, 0));
    return;
  }
  let state = '';
  try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch {}
  assert.ok(!state || state.startsWith('Z'), `pid ${pid} remains live with state ${state}`);
}

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
  const profile = {
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
  };
  const lease = await startRuntimeProfile(profile);
  const secondLease = await startRuntimeProfile(profile);
  assert.ok(lease.child?.pid);
  assert.equal(lease.claudeEnv().ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`);
  const pid = lease.child.pid;
  try {
    assert.ok(pid);
    await lease.close();
    assert.doesNotThrow(() => process.kill(pid, 0), 'first release must not reap a shared runtime');
  } finally {
    await secondLease.close();
  }
  assert.ok(lease.child.exitCode !== null || lease.child.signalCode !== null);
  assertNotRunning(pid);
});

test('manager_exit survives lease release but manager drain kills its process group', async () => {
  const port = 43_000 + (process.pid % 10_000);
  const profile = {
    id: 'manager-exit-fixture',
    provider: 'generic',
    model: 'fixture-model',
    executable: process.execPath,
    extra_args: [
      '-e',
      `process.on('SIGTERM',()=>{});require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')`,
    ],
    base_url: `http://127.0.0.1:${port}`,
    startup_timeout_ms: 10_000,
    shutdown_policy: 'manager_exit',
  };
  const lease = await startRuntimeProfile(profile);
  const pid = lease.child.pid;
  await lease.close();
  assert.doesNotThrow(() => process.kill(pid, 0), 'lease release keeps manager_exit runtime');
  await shutdownRuntimeProfiles();
  assertNotRunning(pid);
});

test('manager drain kills a SIGTERM-ignoring grandchild with the whole process group', async () => {
  const port = 44_000 + (process.pid % 10_000);
  const pidFile = join(fixtureRoot, 'grandchild.pid');
  const childScript =
    `const{spawn}=require('child_process'),fs=require('fs');` +
    `const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});` +
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));` +
    `process.on('SIGTERM',()=>{});require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')`;
  const lease = await startRuntimeProfile({
    id: 'tree-fixture',
    provider: 'generic',
    model: 'fixture-model',
    executable: process.execPath,
    extra_args: ['-e', childScript],
    base_url: `http://127.0.0.1:${port}`,
    startup_timeout_ms: 10_000,
    shutdown_policy: 'manager_exit',
  });
  const grandchildPid = Number(await readFile(pidFile, 'utf8'));
  await shutdownRuntimeProfiles();
  assertNotRunning(lease.child.pid);
  assertNotRunning(grandchildPid);
});

test('credential injection is reference-bound and exposes only the provider mapping', () => {
  const ref = '00000000-0000-4000-8000-000000000001';
  const profile = { id: 'secure', provider: 'generic', model: 'm', credential_ref: ref };
  assert.deepEqual(runtimeCredentialEnv(profile, ref, {
    ANTHROPIC_API_KEY: 'selected',
    OPENAI_API_KEY: 'must-not-leak',
    UNRELATED: 'must-not-leak',
  }), { ANTHROPIC_API_KEY: 'selected' });
  assert.throws(
    () => runtimeCredentialEnv(profile, '00000000-0000-4000-8000-000000000002', { ANTHROPIC_API_KEY: 'x' }),
    /does not match/,
  );
});

test('opt-in live vLLM starts from .venv and serves the configured model', {
  skip: !process.env.AWB_TEST_VLLM_VENV || !process.env.AWB_TEST_VLLM_MODEL,
  timeout: 600_000,
}, async () => {
  const port = Number(process.env.AWB_TEST_VLLM_PORT || 48_000 + (process.pid % 10_000));
  const profile = {
    id: 'live-vllm',
    provider: 'vllm',
    model: process.env.AWB_TEST_VLLM_MODEL,
    venv: process.env.AWB_TEST_VLLM_VENV,
    module: 'vllm.entrypoints.openai.api_server',
    port,
    base_url: `http://127.0.0.1:${port}`,
    health_check: '/health',
    startup_timeout_ms: 540_000,
  };
  const lease = await startRuntimeProfile(profile);
  try {
    const response = await fetch(`${profile.base_url}/v1/models`);
    assert.equal(response.ok, true);
    const body = await response.json();
    assert.ok(body.data.some((entry) => entry.id === profile.model));
  } finally {
    await lease.close();
  }
});
