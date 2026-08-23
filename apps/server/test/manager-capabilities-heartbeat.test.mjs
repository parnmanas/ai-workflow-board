// ticket c3b767c6 — manager_capabilities heartbeat wire path. Same technique
// as runtime-capabilities-heartbeat.test.mjs: POST a real heartbeat through
// the actual HTTP endpoint (not an internal object) and read back what
// InstanceRegistryService actually stored, so a producer-side flatten/parse
// bug can't hide behind a test that only exercises internal objects.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  createWorkspace,
} from './helpers/fixtures.mjs';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';

process.env.PORT = process.env.MANAGER_CAPABILITIES_HEARTBEAT_PORT || '7918';

test('Manager heartbeat with manager_capabilities stores it verbatim on the instance record', async (t) => {
  const { app, port, modules } = await bootApp({
    port: Number.parseInt(process.env.PORT, 10),
  });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'manager-capabilities');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'manager-capabilities-host',
    type: 'manager',
  });
  const key = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'manager-capabilities',
  });

  const response = await fetch(
    `http://127.0.0.1:${port}/api/agent/instance-heartbeat`,
    {
      method: 'POST',
      headers: {
        'X-Agent-Key': key.raw_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instance_id: 'manager-capabilities-test',
        agent_id: manager.id,
        workspace_id: workspace.id,
        mode: 'manager',
        hostname: 'test-host',
        plugin_version: '1.6.94',
        cli: 'mixed',
        cli_adapters: [],
        manager_capabilities: ['context_window_clamp', 'context_window_clamp', '', 42, null],
        pid: 123,
        started_at: new Date().toISOString(),
      }),
    },
  );
  assert.equal(response.status, 201, await response.text());

  const record = app.get(InstanceRegistryService).get('manager-capabilities-test');
  assert.ok(record, 'instance record must exist after the heartbeat');
  // Malformed entries (empty string, a number, null) are dropped defensively —
  // the server must never let a bad heartbeat field poison the registry.
  // Duplicates survive (Array.includes() in the gate is dedup-agnostic); the
  // producer (agent-manager) never sends duplicates in practice.
  assert.deepEqual(record.manager_capabilities, ['context_window_clamp', 'context_window_clamp']);
});

test('Manager heartbeat WITHOUT manager_capabilities leaves the field undefined (old-manager wire shape, not an empty array)', async (t) => {
  const { app, port, modules } = await bootApp({
    port: Number.parseInt(process.env.PORT, 10) + 1,
  });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'manager-capabilities-absent');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'manager-capabilities-absent-host',
    type: 'manager',
  });
  const key = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'manager-capabilities-absent',
  });

  const response = await fetch(
    `http://127.0.0.1:${port}/api/agent/instance-heartbeat`,
    {
      method: 'POST',
      headers: {
        'X-Agent-Key': key.raw_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instance_id: 'manager-capabilities-absent-test',
        agent_id: manager.id,
        workspace_id: workspace.id,
        mode: 'manager',
        hostname: 'test-host',
        plugin_version: '1.5.0',
        cli: 'mixed',
        cli_adapters: [],
        pid: 123,
        started_at: new Date().toISOString(),
      }),
    },
  );
  assert.equal(response.status, 201, await response.text());

  const record = app.get(InstanceRegistryService).get('manager-capabilities-absent-test');
  assert.ok(record, 'instance record must exist after the heartbeat');
  assert.equal(record.manager_capabilities, undefined, 'an old manager that never sends the field must round-trip as undefined, not []');

  // Non-vacuous proof this old-shaped record is actually treated as
  // incompatible by the dispatch gate, using the SAME live instance the
  // heartbeat above just wrote — not a hand-built fixture.
  const { evaluateManagerCapability } = await import('../dist/common/manager-capability-gate.js');
  const verdict = evaluateManagerCapability([record], 'context_window_clamp');
  assert.equal(verdict.ok, false);
});

exitAfterTests();
