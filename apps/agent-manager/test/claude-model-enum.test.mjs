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
  // 설치된 2.1.281 바이너리에 실재하는 문자열. 예전 패턴은 fable 분기에만 minor
  // 자리가 없어서 이걸 통째로 떨어뜨렸고, 그래서 Fable 5.1 을 어느 경로로도 고를
  // 수 없었다.
  'claude-fable-5-1',
  'claude-fable-5-mythos-5',
];

function scanFixture(strings) {
  return [...strings.join('\n').matchAll(CLAUDE_MODEL_SCAN_PATTERN)].map((match) => match[0]);
}

test('Claude 2.1.220 model scan includes major-only ids and rejects dated/suffixed ids', () => {
  const filtered = scanFixture(CLAUDE_2_1_220_STRINGS);

  assert.ok(filtered.includes('claude-opus-5'));
  assert.ok(filtered.includes('claude-sonnet-5'));
  // family 마다 규칙이 다르면 이런 구멍이 조용히 생긴다 — fable 도 나머지와 같은
  // major-minor 를 받아들여야 한다.
  assert.ok(filtered.includes('claude-fable-5-1'), 'fable 도 minor 를 가질 수 있다');
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
    // 같은 family 안에서는 더 구체적인 minor 가 더 새것이다.
    'claude-fable-5-1',
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
    'claude-fable-5-1',
  ]);
});
