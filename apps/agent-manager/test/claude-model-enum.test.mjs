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

// 스캔이 실패했을 때 **구체 모델 id 를 하드코딩으로 메꾸지 않는다.** 예전에는 큐레이션
// 목록(claude-opus-5 …)을 끼워 넣었는데, 그 목록은 정의상 썩고(모델이 나올 때마다 사람이
// 범프해야 한다) 하류에서 실제 열거 결과와 구분되지 않아 "스캔이 통째로 실패함" 을
// "목록이 좀 오래됨" 처럼 보이게 했다 — Windows shim 을 스캔하던 ralf 가 CLI 를 올려도
// Opus 5.5 를 영영 못 본 것이 그 비용이다(claude-model-scan-windows-shim.test.mjs).
// alias 는 설치된 CLI 에서 각 family 의 최신을 자동으로 따라가므로 썩지 않는다.
test('listModels: 스캔이 실패하면 alias 만 남는다 — 하드코딩 구체 id 로 메꾸지 않는다', async () => {
  const adapter = new ClaudeCliAdapter();
  adapter.resolveBin = () => '/nonexistent/claude-for-model-enum-test';

  const models = await adapter.listModels();
  assert.deepEqual(models, ['opus', 'sonnet', 'haiku', 'fable']);
  assert.equal(
    models.some((m) => m.startsWith('claude-')),
    false,
    '구체 id 가 하나라도 있으면 하드코딩 폴백이 되살아난 것이다',
  );
});

test('listModels: resolveBin 이 던져도 alias 는 남고 던지지 않는다', async () => {
  const adapter = new ClaudeCliAdapter();
  adapter.resolveBin = () => {
    throw new Error('claude is not installed');
  };
  assert.deepEqual(await adapter.listModels(), ['opus', 'sonnet', 'haiku', 'fable']);
});
