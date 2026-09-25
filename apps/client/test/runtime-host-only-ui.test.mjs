import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'src');
const read = (path) => fs.readFileSync(join(root, path), 'utf8');

test('client types expose Runtime Host sessions only', () => {
  const source = read('types.ts');

  assert.match(source, /mode:\s*'manager';/);
  assert.match(source, /source:\s*'manager';/);
  assert.doesNotMatch(source, /'daemon'\s*\|\s*'proxy'|'proxy'\s*\|\s*'manager'/);
  assert.doesNotMatch(source, /AgentProxySession|main_pinned|is_main/);
});

test('client has no standalone session routing controls or legacy topology choices', () => {
  const source = [
    'api.ts',
    'components/admin/AgentManagerPage.tsx',
    'components/AgentDetailModal.tsx',
  ].map(read).join('\n');

  assert.doesNotMatch(source, /setAgentMainSession|clearAgentMainSession/);
  assert.doesNotMatch(source, /None\s*[—-]\s*legacy|standalone behaviour|daemon or proxy instances/);
  assert.doesNotMatch(source, /source\s*===\s*['"]proxy['"]|mode\s*===\s*['"]daemon['"]/);
});

test('Agent forms require explicit Runtime Host, runtime, strategy, and permission mode', () => {
  const source = [
    'components/AgentsPage.tsx',
    'components/admin/ManagedAgentDialog.tsx',
    'components/admin/RuntimeConfigFields.tsx',
  ].map(read).join('\n');

  assert.match(source, /Runtime Host \*/);
  assert.match(source, /Runtime \*/);
  assert.match(source, /Strategy \*/);
  assert.match(source, /Permission mode \*/);
  assert.match(source, /runtime_config/);
  assert.doesNotMatch(source, /cli:\s*['"]claude['"]/);
  assert.doesNotMatch(source, /strategy:\s*['"]single['"]/);
});

test('Agent creation resolves healthy runtimes from live Runtime Host instances', () => {
  const source = read('components/AgentsPage.tsx');

  assert.match(source, /listAgentManagerInstances\(\)/);
  assert.match(source, /instance\.agent_id\s*===\s*managedForm\.manager_agent_id/);
  assert.match(source, /health\.installed\s*&&\s*health\.healthy/);
  assert.doesNotMatch(source, /managerInstanceByManagerAgentId/);
});

test('Hermes is explicit in the CLI catalog and collaboration controls are gated by its descriptor, not a literal', () => {
  const catalog = read('cli/catalog.ts');
  const components = [
    'components/AgentsPage.tsx',
    'components/admin/ManagedAgentDialog.tsx',
    'components/admin/RuntimeConfigFields.tsx',
  ].map(read).join('\n');

  // The catalog is the only place hermes and its collaboration modes are named…
  assert.match(catalog, /id:\s*['"]hermes['"]/);
  assert.match(catalog, /collaboration:\s*\[\s*'single',\s*'delegated',\s*'swarm'\s*\]/);
  assert.match(catalog, /runtime_config:\s*\{\s*profiles:\s*true,\s*child_limits:\s*true\s*\}/);
  // …and the components gate on descriptor facts instead of the id.
  assert.doesNotMatch(components, /(?:cli|runtime)\s*===\s*['"]hermes['"]/);
  assert.match(components, /cliRuntimeConfig\(/);
  assert.match(components, /cliCollaboration\(/);
  assert.match(components, /child_limits/);
  assert.match(components, /max_children/);
});
