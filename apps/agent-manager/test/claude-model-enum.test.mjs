import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_MODEL_SCAN_PATTERN,
  ClaudeCliAdapter,
} from '../dist/lib/cli-adapters/claude.js';
import { latestPerFamily } from '../dist/lib/cli-adapters/model-introspect.js';

const CLAUDE_2_1_220_STRINGS = [
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-4-20250514',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6-fast',
  'claude-opus-4-6-v1',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001-v1',
  'claude-fable-5',
  'claude-fable-5-mythos-5',
];

function scanFixture(strings) {
  return [...strings.join('\n').matchAll(CLAUDE_MODEL_SCAN_PATTERN)].map((match) => match[0]);
}

test('Claude 2.1.220 model scan includes major-only ids and rejects dated/suffixed ids', () => {
  const filtered = scanFixture(CLAUDE_2_1_220_STRINGS);

  assert.ok(filtered.includes('claude-opus-5'));
  assert.ok(filtered.includes('claude-sonnet-5'));
  for (const rejected of [
    'claude-opus-4-20250514',
    'claude-opus-4-5-20251101',
    'claude-opus-4-6-fast',
    'claude-opus-4-6-v1',
    'claude-haiku-4-5-20251001-v1',
    'claude-fable-5-mythos-5',
  ]) {
    assert.equal(filtered.includes(rejected), false, `${rejected} must be filtered`);
  }
});

test('latestPerFamily prefers major 5 over older major-minor ids', () => {
  assert.deepEqual(latestPerFamily(scanFixture(CLAUDE_2_1_220_STRINGS)), [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
    'claude-fable-5',
  ]);
});

test('listModels fallback keeps stable aliases first and exposes current curated ids', async () => {
  const adapter = new ClaudeCliAdapter();
  adapter.resolveBin = () => '/nonexistent/claude-for-model-enum-test';

  assert.deepEqual(await adapter.listModels(), [
    'opus',
    'sonnet',
    'haiku',
    'fable',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
    'claude-fable-5',
  ]);
});
