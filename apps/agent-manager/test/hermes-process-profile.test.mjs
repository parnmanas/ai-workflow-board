import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { HermesRuntime } from '../dist/lib/runtime/hermes/hermes-runtime.js';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-acp-server.mjs', import.meta.url),
);

function expectedHermesRoot() {
  if (process.platform === 'win32') {
    const localAppData = (process.env.LOCALAPPDATA ?? '').trim();
    return join(localAppData || join(homedir(), 'AppData', 'Local'), 'hermes');
  }
  return join(homedir(), '.hermes');
}

async function createHarness(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'awb-hermes-profile-'));
  const runtime = new HermesRuntime({
    rootDir,
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 10_000,
  });
  t.after(async () => {
    await runtime.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { rootDir, runtime };
}

// 회귀 커버리지 — 우리가 띄우는 바이너리는 `hermes` CLI 가 아니라 `hermes-acp`
// (acp_adapter/entry.py) 이고, 그쪽 argparse 에는 `--profile` 이 존재하지 않는다.
// 예전 구현은 프로파일이 있으면 `--profile <name>` 을 argv 에 붙이고 HERMES_HOME
// 을 비워뒀는데, 운영에서 그건 `unrecognized arguments: --profile claude_opus`
// → exit(2) 로 100% 죽는 경로였다(2026-08-17 인시던트). 프로파일 선택의 유일한
// 통로는 HERMES_HOME = <root>/profiles/<name> 이다.

test('no profile: HERMES_HOME is the per-agent isolated dir, no --profile arg, HERMES_PROFILE unset', async (t) => {
  const { runtime, rootDir } = await createHarness(t);
  const captureFile = join(rootDir, 'capture-no-profile.json');
  await runtime.ensureAgent({
    agentId: 'agent-no-profile',
    env: { FAKE_ACP_CAPTURE_FILE: captureFile },
  });
  const capture = JSON.parse(await readFile(captureFile, 'utf8'));
  assert.equal(capture.HERMES_HOME, join(rootDir, 'agent-no-profile', 'hermes'));
  assert.equal(capture.HERMES_PROFILE, null);
  assert.equal(capture.argv.includes('--profile'), false);
});

test('profile selected: HERMES_HOME points at <root>/profiles/<name> and argv stays flagless', async (t) => {
  const { runtime, rootDir } = await createHarness(t);
  const captureFile = join(rootDir, 'capture-profile.json');
  await runtime.ensureAgent({
    agentId: 'agent-with-profile',
    profile: 'coder',
    env: { FAKE_ACP_CAPTURE_FILE: captureFile },
  });
  const capture = JSON.parse(await readFile(captureFile, 'utf8'));
  assert.equal(capture.HERMES_HOME, join(expectedHermesRoot(), 'profiles', 'coder'));
  assert.equal(capture.HERMES_PROFILE, 'coder');
  assert.equal(capture.argv.includes('--profile'), false);
});

test('profile name is lowercased to match the on-disk profile id', async (t) => {
  const { runtime, rootDir } = await createHarness(t);
  const captureFile = join(rootDir, 'capture-mixed-case.json');
  await runtime.ensureAgent({
    agentId: 'agent-mixed-case',
    profile: 'Claude_Opus',
    env: { FAKE_ACP_CAPTURE_FILE: captureFile },
  });
  const capture = JSON.parse(await readFile(captureFile, 'utf8'));
  assert.equal(capture.HERMES_HOME, join(expectedHermesRoot(), 'profiles', 'claude_opus'));
});

test('the "default" profile alias resolves to the root home, not profiles/default', async (t) => {
  const { runtime, rootDir } = await createHarness(t);
  const captureFile = join(rootDir, 'capture-default.json');
  await runtime.ensureAgent({
    agentId: 'agent-default-profile',
    profile: 'default',
    env: { FAKE_ACP_CAPTURE_FILE: captureFile },
  });
  const capture = JSON.parse(await readFile(captureFile, 'utf8'));
  assert.equal(capture.HERMES_HOME, expectedHermesRoot());
});
