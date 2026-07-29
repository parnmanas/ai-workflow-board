import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { HermesRuntime } from '../dist/lib/runtime/hermes/hermes-runtime.js';
import { HermesSessionOwnershipError } from '../dist/lib/runtime/hermes/hermes-session-store.js';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-acp-server.mjs', import.meta.url),
);

async function createHarness(t, options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'awb-hermes-runtime-'));
  const runtime = new HermesRuntime({
    rootDir,
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 10_000,
    env: options.env,
  });
  t.after(async () => {
    await runtime.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { rootDir, runtime };
}

test('Hermes owns exactly one initialized ACP process per managed Agent', async (t) => {
  const { runtime } = await createHarness(t);
  const first = await runtime.ensureAgent({ agentId: 'agent-a', profile: 'coding' });
  const again = await runtime.ensureAgent({ agentId: 'agent-a', profile: 'coding' });
  const sibling = await runtime.ensureAgent({ agentId: 'agent-b', profile: 'review' });

  assert.equal(first, again);
  assert.notEqual(first, sibling);
  assert.equal(first.healthy, true);
  assert.equal(sibling.healthy, true);
  assert.notEqual(first.processPid, sibling.processPid);
  assert.notEqual(first.stateDir, sibling.stateDir);
  assert.equal(first.stateDir.endsWith(join('agent-a', 'hermes')), true);
});

test('run/session mapping persists and restores only under the same owner and lease', async (t) => {
  const { runtime } = await createHarness(t);
  const cwd = process.cwd();
  const opened = await runtime.openSession({
    agentId: 'agent-a',
    runId: 'run-1',
    leaseId: 'lease-1',
    cwd,
  });
  assert.equal(opened.sessionId, 'session-1');

  const restored = await runtime.restoreSession({
    agentId: 'agent-a',
    runId: 'run-1',
    leaseId: 'lease-1',
    cwd,
  });
  assert.equal(restored.sessionId, opened.sessionId);

  await assert.rejects(
    runtime.restoreSession({
      agentId: 'agent-b',
      runId: 'run-1',
      leaseId: 'lease-1',
      cwd,
    }),
    (error) => error instanceof HermesSessionOwnershipError
      && error.code === 'hermes_session_owner_mismatch',
  );
  await assert.rejects(
    runtime.restoreSession({
      agentId: 'agent-a',
      runId: 'run-1',
      leaseId: 'lease-other',
      cwd,
    }),
    (error) => error instanceof HermesSessionOwnershipError
      && error.code === 'hermes_session_lease_mismatch',
  );
});

test('cancel keeps recovery mapping while close removes it', async (t) => {
  const { runtime } = await createHarness(t);
  const session = await runtime.openSession({
    agentId: 'agent-a',
    runId: 'run-cancel',
    leaseId: 'lease-a',
    cwd: process.cwd(),
  });

  await runtime.cancelRun('agent-a', 'run-cancel');
  assert.equal(runtime.getSession('agent-a', 'run-cancel')?.sessionId, session.sessionId);

  await runtime.closeRun('agent-a', 'run-cancel');
  assert.equal(runtime.getSession('agent-a', 'run-cancel'), null);
});

test('close tolerates ACP implementations without session/close', async (t) => {
  const { runtime } = await createHarness(t, {
    env: { FAKE_ACP_NO_CLOSE: '1' },
  });
  await runtime.openSession({
    agentId: 'agent-a',
    runId: 'run-no-close',
    leaseId: 'lease-a',
    cwd: process.cwd(),
  });

  await runtime.closeRun('agent-a', 'run-no-close');
  assert.equal(runtime.getSession('agent-a', 'run-no-close'), null);
});
