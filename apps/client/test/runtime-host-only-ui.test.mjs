import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');

test('client types expose Runtime Host sessions only', () => {
  const source = read('apps/client/src/types.ts');

  assert.match(source, /mode:\s*'manager';/);
  assert.match(source, /source:\s*'manager';/);
  assert.doesNotMatch(source, /'daemon'\s*\|\s*'proxy'|'proxy'\s*\|\s*'manager'/);
  assert.doesNotMatch(source, /AgentProxySession|main_pinned|is_main/);
});

test('client has no standalone session routing controls or legacy topology choices', () => {
  const source = [
    'apps/client/src/api.ts',
    'apps/client/src/components/admin/AgentManager.tsx',
    'apps/client/src/components/admin/AgentManagerPage.tsx',
    'apps/client/src/components/AgentDetailModal.tsx',
  ].map(read).join('\n');

  assert.doesNotMatch(source, /setAgentMainSession|clearAgentMainSession/);
  assert.doesNotMatch(source, /None\s*[—-]\s*legacy|standalone behaviour|daemon or proxy instances/);
  assert.doesNotMatch(source, /source\s*===\s*['"]proxy['"]|mode\s*===\s*['"]daemon['"]/);
});

test('Agent forms require explicit Runtime Host, runtime, strategy, and permission mode', () => {
  const source = [
    'apps/client/src/components/AgentsPage.tsx',
    'apps/client/src/components/admin/AgentManager.tsx',
    'apps/client/src/components/admin/ManagedAgentDialog.tsx',
    'apps/client/src/components/admin/RuntimeConfigFields.tsx',
  ].map(read).join('\n');

  assert.match(source, /Runtime Host \*/);
  assert.match(source, /Runtime \*/);
  assert.match(source, /Strategy \*/);
  assert.match(source, /Permission mode \*/);
  assert.match(source, /runtime_config/);
  assert.doesNotMatch(source, /cli:\s*['"]claude['"]/);
  assert.doesNotMatch(source, /strategy:\s*['"]single['"]/);
});

test('Hermes is explicit and collaboration controls are Hermes-only', () => {
  const source = [
    'apps/client/src/components/AgentsPage.tsx',
    'apps/client/src/components/admin/AgentManager.tsx',
    'apps/client/src/components/admin/ManagedAgentDialog.tsx',
    'apps/client/src/components/admin/RuntimeConfigFields.tsx',
  ].map(read).join('\n');

  assert.match(source, /value:\s*['"]hermes['"]/);
  assert.match(source, /(?:cli|runtime)\s*===\s*['"]hermes['"]/);
  assert.match(source, /delegated/);
  assert.match(source, /swarm/);
  assert.match(source, /max_children/);
});
