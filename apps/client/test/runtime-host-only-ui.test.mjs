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
  // P4c-4: AgentDetailModal 삭제 — 항목에서 제외.
  const source = [
    'api.ts',
    'components/admin/AgentManagerPage.tsx',
  ].map(read).join('\n');

  assert.doesNotMatch(source, /setAgentMainSession|clearAgentMainSession/);
  assert.doesNotMatch(source, /None\s*[—-]\s*legacy|standalone behaviour|daemon or proxy instances/);
  assert.doesNotMatch(source, /source\s*===\s*['"]proxy['"]|mode\s*===\s*['"]daemon['"]/);
});

// P4c-3b/4: Agent 생성 폼 삭제 — 선언은 RuntimeSpecEditor 가 받는다. Host
// 미선택·상대경로 working_dir 을 거부하는지 소스 계약으로 단언한다.
test('Runtime declaration requires an explicit Host and an absolute working dir', () => {
  const source = read('components/runtime/RuntimeSpecEditor.tsx') + read('components/runtime/RuntimeSelectionFields.tsx');

  assert.match(source, /label="Runtime Host"/);
  assert.match(source, /value:\s*''\s*,\s*label:\s*'선택…'/);
  assert.match(source, /isAbsoluteHostPath/);
  assert.match(source, /dirError/);
  assert.doesNotMatch(source, /cli:\s*['"]claude['"]/);
});

// P4c-3b: AgentsPage 생성 폼 삭제 — healthy-runtime 매칭은 DeclareRuntimeSection
// + resolveSpecAgent 가 하고 test/runtime-spec.test.mjs 가 커버한다.
test('Runtime declaration resolves hosts through the shared matcher (no per-form logic)', () => {
  const section = read('components/runtime/DeclareRuntimeSection.tsx');
  assert.match(section, /validate/);
  assert.doesNotMatch(section, /health\.installed\s*&&\s*health\.healthy/);
});

test('Hermes is explicit in the CLI catalog and collaboration controls are gated by its descriptor, not a literal', () => {
  const catalog = read('cli/catalog.ts');
  // P4c-4: AgentsPage 삭제 — 항목에서 제외.
  const components = [
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
