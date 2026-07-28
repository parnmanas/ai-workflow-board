import test from 'node:test';
import assert from 'node:assert/strict';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';

function record(overrides = {}) {
  return {
    instance_id: 'instance-old',
    agent_id: 'manager-agent',
    workspace_id: 'workspace',
    mode: 'manager',
    hostname: 'PARN-HOME',
    plugin_version: '1.6.73',
    cli: 'codex',
    cli_adapters: ['codex'],
    pid: 100,
    started_at: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

test('a restarted manager immediately supersedes its prior host instance', () => {
  const logs = [];
  const registry = new InstanceRegistryService(
    { debug: (...args) => logs.push(args) },
    { register() {} },
  );

  registry.upsert(record());
  registry.upsert(record({
    instance_id: 'instance-new',
    plugin_version: '1.6.75',
    pid: 200,
    started_at: '2026-07-28T00:01:00.000Z',
  }));

  assert.equal(registry.get('instance-old'), null);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].instance_id, 'instance-new');
  assert.equal(registry.list()[0].plugin_version, '1.6.75');
  assert.equal(logs.length, 1);
  registry.onModuleDestroy();
});

test('a manager on another host is not superseded', () => {
  const registry = new InstanceRegistryService(
    { debug() {} },
    { register() {} },
  );

  registry.upsert(record());
  registry.upsert(record({
    instance_id: 'instance-other-host',
    hostname: 'BUILD-02',
  }));

  assert.equal(registry.list().length, 2);
  registry.onModuleDestroy();
});
