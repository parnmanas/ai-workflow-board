import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { HermesRuntime } from '../dist/lib/runtime/hermes/hermes-runtime.js';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-acp-server.mjs', import.meta.url),
);

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

// 버그 A/B 회귀 커버리지: 선택된 프로파일은 반드시 `--profile <name>`으로
// Hermes에 전달돼야 하고(`_apply_profile_override()`가 읽는 유일한 선택자),
// 이 경우 HERMES_HOME을 강제하면 안 된다 — Hermes 자신의
// get_default_hermes_root()는 `~/.hermes` 밖의 HERMES_HOME을 외부 커스텀
// 배포 루트로 취급해 `~/.hermes/profiles/<name>` 아래 실제 프로파일
// 디렉터리를 못 찾는다.

test('no profile: HERMES_HOME is forced to the per-agent isolated dir, no --profile arg, HERMES_PROFILE unset', async (t) => {
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

test('profile selected: --profile <name> is passed, HERMES_HOME is left unset, HERMES_PROFILE kept for kanban labels', async (t) => {
  const { runtime, rootDir } = await createHarness(t);
  const captureFile = join(rootDir, 'capture-profile.json');
  await runtime.ensureAgent({
    agentId: 'agent-with-profile',
    profile: 'coder',
    env: { FAKE_ACP_CAPTURE_FILE: captureFile },
  });
  const capture = JSON.parse(await readFile(captureFile, 'utf8'));
  assert.equal(capture.HERMES_HOME, null);
  assert.equal(capture.HERMES_PROFILE, 'coder');
  const flagIndex = capture.argv.indexOf('--profile');
  assert.ok(flagIndex >= 0, 'expected --profile in argv');
  assert.equal(capture.argv[flagIndex + 1], 'coder');
});
