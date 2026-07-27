import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentRuntimeConfigError,
  validateAgentRuntimeConfig,
} from '../dist/common/runtime-config.js';

test('runtime config rejects unknown fields instead of silently dropping them', () => {
  assert.throws(
    () => validateAgentRuntimeConfig('hermes', {
      strategy: 'delegated',
      permission_mode: 'approve',
      ungoverned_option: true,
    }),
    (error) => {
      assert.ok(error instanceof AgentRuntimeConfigError);
      assert.equal(error.code, 'runtime_config_invalid');
      assert.match(error.message, /unknown/i);
      return true;
    },
  );
});

test('runtime config preserves only explicitly supported bounded fields', () => {
  assert.deepEqual(
    validateAgentRuntimeConfig('hermes', {
      strategy: 'swarm',
      permission_mode: 'strict',
      profile: 'analysis',
      max_children: 4,
      max_iterations: 12,
      extra: { coordinator: 'kanban' },
    }),
    {
      strategy: 'swarm',
      permission_mode: 'strict',
      profile: 'analysis',
      max_children: 4,
      max_iterations: 12,
      extra: { coordinator: 'kanban' },
    },
  );
});
