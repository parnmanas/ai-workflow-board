import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  createWorkspace,
} from './helpers/fixtures.mjs';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';

process.env.PORT = process.env.RUNTIME_CAPABILITIES_HEARTBEAT_PORT || '7908';

test('Runtime Host heartbeat stores structured runtime health and capabilities', async (t) => {
  const { app, port, modules } = await bootApp({
    port: Number.parseInt(process.env.PORT, 10),
  });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'runtime-health');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'runtime-host',
    type: 'manager',
  });
  const key = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'runtime-health',
  });
  const runtimeCapabilities = {
    hermes: {
      installed: true,
      healthy: true,
      version: 'hermes-acp 0.3.0',
      reason: null,
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
    },
    codex: {
      installed: true,
      healthy: false,
      version: 'codex 1.2.3',
      reason: 'probe_failed',
      capabilities: {
        protocol: 'jsonl',
        session: 'oneshot',
        native_mcp: true,
        native_approvals: false,
        steering: false,
        cancellation: true,
        usage: 'tokens',
        collaboration: [],
        skill_delivery: ['prompt', 'filesystem'],
      },
    },
  };

  const response = await fetch(
    `http://127.0.0.1:${port}/api/agent/instance-heartbeat`,
    {
      method: 'POST',
      headers: {
        'X-Agent-Key': key.raw_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instance_id: 'runtime-host-test',
        agent_id: manager.id,
        workspace_id: workspace.id,
        mode: 'manager',
        hostname: 'test-host',
        plugin_version: 'test',
        cli: 'mixed',
        cli_adapters: ['codex', 'hermes'],
        runtime_capabilities: runtimeCapabilities,
        pid: 123,
        started_at: new Date().toISOString(),
      }),
    },
  );
  assert.equal(response.status, 201, await response.text());

  const record = app
    .get(InstanceRegistryService)
    .get('runtime-host-test');
  assert.deepEqual(record.runtime_capabilities, runtimeCapabilities);
  assert.equal(record.runtime_capabilities.hermes.healthy, true);
  assert.equal(record.runtime_capabilities.codex.healthy, false);
});

exitAfterTests();
