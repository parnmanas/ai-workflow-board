import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  RuntimeDispatchError,
  RuntimeSupervisor,
} from '../dist/lib/runtime/runtime-supervisor.js';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-acp-server.mjs', import.meta.url),
);

async function harness(t, options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'awb-runtime-supervisor-'));
  const events = [];
  const supervisor = new RuntimeSupervisor({
    rootDir,
    command: process.execPath,
    args: [fixture],
    awbUrl: 'https://awb.example.test',
    onEvent: (context, event) => events.push({ context, event }),
    ...options,
  });
  t.after(async () => {
    await supervisor.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { supervisor, events };
}

const base = {
  agentId: 'agent-a',
  runId: 'run-a',
  leaseId: 'lease-a',
  cwd: process.cwd(),
  apiKey: 'awb-secret-key',
  runtimeId: 'hermes',
  runtimeConfig: {
    strategy: 'single',
    permission_mode: 'trusted',
    profile: 'coding',
  },
  systemContext: 'You are the AWB assignee.',
  task: 'Inspect the project.',
};

test('Hermes dispatch binds cwd, MCP attribution, prompt context, events and usage', async (t) => {
  const { supervisor, events } = await harness(t);
  const result = await supervisor.dispatch(base);

  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.usage.totalTokens, 21);
  assert.equal(events.some(({ event }) => event.type === 'message_delta'), true);
  assert.equal(events.every(({ context }) =>
    context.agentId === base.agentId && context.runId === base.runId), true);

  const record = supervisor.getSession(base.agentId, base.runId);
  assert.equal(record.cwd, process.cwd());
  assert.equal(record.leaseId, base.leaseId);
});

test('permission mode is explicit: strict denies, approve bridges, trusted selects allow once', async (t) => {
  let approvals = 0;
  const { supervisor } = await harness(t, {
    requestApproval: async () => {
      approvals++;
      return { outcome: 'selected', optionId: 'allow-once' };
    },
  });

  const strict = await supervisor.dispatch({
    ...base,
    runId: 'run-strict',
    runtimeConfig: { strategy: 'single', permission_mode: 'strict' },
  });
  assert.equal(strict.stopReason, 'refusal');
  assert.equal(approvals, 0);

  const approved = await supervisor.dispatch({
    ...base,
    runId: 'run-approve',
    runtimeConfig: { strategy: 'single', permission_mode: 'approve' },
  });
  assert.equal(approved.stopReason, 'end_turn');
  assert.equal(approvals, 1);
});

test('missing/unknown runtime configuration fails closed with no CLI fallback', async (t) => {
  const { supervisor } = await harness(t);
  await assert.rejects(
    supervisor.dispatch({ ...base, runtimeId: '' }),
    (error) => error instanceof RuntimeDispatchError
      && error.code === 'runtime_not_configured',
  );
  await assert.rejects(
    supervisor.dispatch({ ...base, runtimeId: 'future' }),
    (error) => error instanceof RuntimeDispatchError
      && error.code === 'runtime_unknown',
  );
  await assert.rejects(
    supervisor.dispatch({ ...base, runtimeConfig: null }),
    (error) => error instanceof RuntimeDispatchError
      && error.code === 'runtime_config_invalid',
  );
});

test('cancel and steering stay bound to the same ACP session', async (t) => {
  const { supervisor } = await harness(t);
  await supervisor.dispatch(base);
  await supervisor.cancel(base.agentId, base.runId);
  const steered = await supervisor.steer(base.agentId, base.runId, 'Also run tests.');
  assert.equal(steered.stopReason, 'end_turn');
  assert.equal(supervisor.getSession(base.agentId, base.runId).sessionId, 'session-1');
});
