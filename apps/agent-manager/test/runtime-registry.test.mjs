import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KNOWN_ADAPTER_CLI_TYPES,
  createAdapter,
} from '../dist/lib/cli-adapters/index.js';

const runtimeModule = await import('../dist/lib/cli-adapters/index.js');

test('missing runtime selection fails closed instead of launching Claude', () => {
  assert.throws(
    () => createAdapter(null),
    (error) => {
      assert.equal(error?.code, 'runtime_not_configured');
      return true;
    },
  );
});

test('unknown runtime selection fails closed instead of launching Claude', () => {
  assert.throws(
    () => createAdapter('future-runtime'),
    (error) => {
      assert.equal(error?.code, 'runtime_unknown');
      assert.equal(error?.runtimeId, 'future-runtime');
      return true;
    },
  );
});

test('Hermes is a registered runtime while custom remains identity-only', () => {
  assert.equal(KNOWN_ADAPTER_CLI_TYPES.includes('hermes'), true);
  assert.equal(KNOWN_ADAPTER_CLI_TYPES.includes('custom'), false);
});

test('Hermes descriptor declares ACP ownership and collaboration capabilities', () => {
  assert.equal(typeof runtimeModule.getRuntimeDescriptor, 'function');
  const descriptor = runtimeModule.getRuntimeDescriptor('hermes');
  assert.deepEqual(descriptor, {
    id: 'hermes',
    capabilities: {
      protocol: 'acp',
      session: 'resumable',
      native_mcp: true,
      native_approvals: true,
      steering: true,
      cancellation: true,
      usage: 'tokens',
      collaboration: ['delegated', 'swarm'],
      skill_delivery: ['filesystem', 'native'],
    },
  });
});

test('runtime config requires explicit strategy and permission mode', () => {
  assert.equal(typeof runtimeModule.validateRuntimeConfig, 'function');

  assert.throws(
    () => runtimeModule.validateRuntimeConfig('hermes', { permission_mode: 'approve' }),
    (error) => error?.code === 'runtime_config_invalid',
  );
  assert.throws(
    () => runtimeModule.validateRuntimeConfig('hermes', { strategy: 'single' }),
    (error) => error?.code === 'runtime_config_invalid',
  );

  assert.deepEqual(
    runtimeModule.validateRuntimeConfig('hermes', {
      strategy: 'delegated',
      permission_mode: 'approve',
      max_children: 3,
    }),
    {
      strategy: 'delegated',
      permission_mode: 'approve',
      max_children: 3,
    },
  );
});

test('runtime config rejects collaboration a runtime does not advertise', () => {
  assert.throws(
    () => runtimeModule.validateRuntimeConfig('codex', {
      strategy: 'delegated',
      permission_mode: 'strict',
    }),
    (error) => error?.code === 'runtime_config_invalid',
  );
});
