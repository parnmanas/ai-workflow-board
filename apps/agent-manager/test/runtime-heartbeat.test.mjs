import assert from 'node:assert/strict';
import test from 'node:test';

import { InstanceHeartbeat } from '../dist/lib/instance-heartbeat.js';
import {
  discoverRuntimeCapabilities,
} from '../dist/lib/runtime/runtime-health.js';
import {
  getRuntimeDescriptor,
  KNOWN_RUNTIME_IDS,
} from '../dist/lib/runtime/runtime-registry.js';

test('runtime discovery reports every registered runtime without conflating missing and unhealthy', async () => {
  const seen = [];
  const report = await discoverRuntimeCapabilities({
    resolveCommand(runtimeId) {
      return runtimeId === 'hermes'
        ? { command: 'hermes-acp', args: ['--help'] }
        : { command: `${runtimeId}-bin`, args: ['--version'] };
    },
    async probe(command, args) {
      seen.push([command, args]);
      if (command === 'hermes-acp') {
        return {
          installed: false,
          healthy: false,
          version: null,
          reason: 'not_found',
        };
      }
      if (command === 'codex-bin') {
        return {
          installed: true,
          healthy: false,
          version: 'codex 1.2.3',
          reason: 'probe_failed',
        };
      }
      return {
        installed: true,
        healthy: true,
        version: `${command} 1.0.0`,
        reason: null,
      };
    },
  });

  assert.deepEqual(Object.keys(report).sort(), [...KNOWN_RUNTIME_IDS].sort());
  assert.deepEqual(seen.find(([command]) => command === 'hermes-acp'), [
    'hermes-acp',
    ['--help'],
  ]);
  assert.equal(report.hermes.installed, false);
  assert.equal(report.hermes.healthy, false);
  assert.equal(report.hermes.reason, 'not_found');
  assert.equal(report.codex.installed, true);
  assert.equal(report.codex.healthy, false);
  assert.equal(report.codex.reason, 'probe_failed');
  assert.deepEqual(
    report.hermes.capabilities,
    getRuntimeDescriptor('hermes').capabilities,
  );
});

test('instance heartbeat publishes the cached runtime capability report', async (t) => {
  const originalFetch = globalThis.fetch;
  let resolvePayload;
  const payloadPromise = new Promise((resolve) => {
    resolvePayload = resolve;
  });
  globalThis.fetch = async (_url, init) => {
    resolvePayload(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const runtimeCapabilities = {
    hermes: {
      installed: true,
      healthy: true,
      version: 'hermes-acp 0.3.0',
      reason: null,
      capabilities: getRuntimeDescriptor('hermes').capabilities,
    },
  };
  const heartbeat = new InstanceHeartbeat(
    { url: 'http://awb.invalid', apiKey: 'secret', workspace_id: 'ws-1' },
    'manager-1',
    {
      mode: 'manager',
      version: 'test',
      cli: 'mixed',
      cliAdapters: [],
      runtimeCapabilities,
    },
  );
  t.after(() => heartbeat.stop());
  heartbeat.start();

  const payload = await payloadPromise;
  assert.deepEqual(payload.runtime_capabilities, runtimeCapabilities);
});
