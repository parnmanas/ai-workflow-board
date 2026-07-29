import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CollaborationGovernor,
  CollaborationPolicyError,
} from '../dist/lib/runtime/collaboration-governor.js';
import { RuntimeSupervisor } from '../dist/lib/runtime/runtime-supervisor.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));

function permission(childId, input = {}) {
  return {
    sessionId: 'session-1',
    toolCall: {
      toolCallId: childId,
      title: 'Delegate subagent',
      kind: 'delegate',
      rawInput: input,
    },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  };
}

test('collaboration governor rejects single and enforces delegated bounds and subsets', () => {
  const governor = new CollaborationGovernor();
  assert.throws(
    () => governor.reservePermission(
      'single',
      { strategy: 'single', permission_mode: 'trusted' },
      permission('child-1'),
      true,
    ),
    CollaborationPolicyError,
  );

  const config = {
    strategy: 'delegated',
    permission_mode: 'trusted',
    max_children: 2,
    max_iterations: 2,
    extra: {
      max_depth: 1,
      max_concurrency: 1,
      allowed_child_tools: ['read'],
      allowed_child_skills: ['review'],
    },
  };
  governor.reservePermission(
    'delegated',
    config,
    permission('child-1', { depth: 1, tools: ['read'], skills: ['review'] }),
    true,
  );
  assert.throws(
    () => governor.reservePermission(
      'delegated',
      config,
      permission('child-2', { depth: 1, tools: ['read'] }),
      true,
    ),
    /max_concurrency/,
  );
  governor.finish('delegated', 'child-1');
  assert.throws(
    () => governor.reservePermission(
      'delegated',
      config,
      permission('child-2', { depth: 2, tools: ['read'] }),
      true,
    ),
    /max_depth/,
  );
  assert.throws(
    () => governor.reservePermission(
      'delegated',
      config,
      permission('child-2', { depth: 1, tools: ['execute'] }),
      true,
    ),
    /allowed_child_tools/,
  );
  assert.throws(
    () => governor.assertStrategy({
      strategy: 'delegated',
      permission_mode: 'trusted',
      extra: { allowed_child_tools: ['move_ticket'] },
    }, true),
    /terminal or consensus/,
  );
});

test('swarm requires an explicit healthy ACP probe', () => {
  const governor = new CollaborationGovernor();
  assert.throws(
    () => governor.reservePermission(
      'swarm',
      { strategy: 'swarm', permission_mode: 'trusted', max_children: 1 },
      permission('child-1'),
      false,
    ),
    /healthy Hermes ACP/,
  );
});

test('ACP delegation updates normalize into governed child start and finish events', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'awb-hermes-collaboration-'));
  const events = [];
  const supervisor = new RuntimeSupervisor({
    rootDir,
    command: process.execPath,
    args: [fixture],
    awbUrl: 'https://awb.example.test',
    onEvent: (context, event) => events.push({ context, event }),
  });
  t.after(async () => {
    await supervisor.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  });

  await supervisor.dispatch({
    agentId: 'agent-a',
    runId: 'run-child',
    leaseId: 'lease-a',
    cwd: process.cwd(),
    apiKey: 'awb-secret-key',
    runtimeId: 'hermes',
    runtimeConfig: {
      strategy: 'delegated',
      permission_mode: 'trusted',
      max_children: 2,
      max_iterations: 2,
      extra: {
        max_depth: 1,
        max_concurrency: 1,
        allowed_child_tools: ['read'],
        allowed_child_skills: ['review'],
      },
    },
    task: 'CHILD_EVENT_TEST',
  });

  assert.equal(events.some(({ event }) => event.type === 'child_started'), true);
  assert.equal(events.some(({ event }) => event.type === 'child_finished'), true);
  assert.equal(
    events.filter(({ event }) => event.type.startsWith('child_'))
      .every(({ context }) => context.strategy === 'delegated'),
    true,
  );
});
