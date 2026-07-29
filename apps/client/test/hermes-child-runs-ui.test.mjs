import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..', 'src');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('Agent detail renders collapsible Hermes ChildRuns without promoting them to Agents', () => {
  const detail = read('components/AgentDetailModal.tsx');
  const panel = read('components/HermesChildRunsPanel.tsx');
  const api = read('api.ts');

  assert.match(detail, /'child-runs'/);
  assert.match(detail, /HermesChildRunsPanel/);
  assert.match(panel, /they are not Agents/);
  assert.match(panel, /setExpanded/);
  assert.match(panel, /parent_run_id/);
  assert.match(panel, /runtime_metadata/);
  assert.match(api, /listAgentChildRuns/);
});
