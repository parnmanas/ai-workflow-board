// Ontology Graph 프레시니스 배지 순수 로직 테스트 (ticket d22b83b4).
//
// OntologyGraphPage.tsx가 실제로 import하는 freshness.ts를 그대로
// 구동한다(미러 아님) — 순수 함수라 React/jsdom 불필요
// (chat-session-status-badge.test.mjs와 같은 자세).
//
// 실행:  node --import tsx --test apps/client/test/ontology-freshness.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { freshnessBadge, dirtyRatioToFreshPercent } from '../src/components/ontology/freshness.ts';

test('building 상태(commit 없음)는 항상 building 톤 + "Building graph…"', () => {
  const badge = freshnessBadge({
    status: 'building', indexedAt: null, commit: '', behind: null, ahead: null, dirtyRatio: null, freshnessError: null,
  });
  assert.equal(badge.tone, 'building');
  assert.equal(badge.headline, 'Building graph…');
  assert.equal(badge.detail, null);
});

test('error 상태는 commit이 있어도 error 톤을 우선한다', () => {
  const badge = freshnessBadge({
    status: 'error', indexedAt: '2026-08-01T00:00:00.000Z', commit: 'abc1234567', behind: 3, ahead: 0, dirtyRatio: 0.1, freshnessError: null,
  });
  assert.equal(badge.tone, 'error');
  assert.equal(badge.headline, 'Graph build failed');
});

test('dirty_ratio가 있으면 research-ontology.md §8.6의 카피 패턴을 그대로 재현한다 — "graph is N% fresh as of <sha>"', () => {
  const badge = freshnessBadge({
    status: 'ready', indexedAt: '2026-08-01T00:00:00.000Z', commit: 'abcdef1234567', behind: 0, ahead: 0, dirtyRatio: 0.04, freshnessError: null,
  });
  assert.equal(badge.headline, 'Graph is 96% fresh as of abcdef1');
  assert.equal(badge.tone, 'stale', 'dirty_ratio>0이면 완전히 fresh는 아니다');
  assert.equal(badge.detail, 'Up to date with current HEAD');
});

test('dirty_ratio=0이고 behind=0이면 fresh 톤', () => {
  const badge = freshnessBadge({
    status: 'ready', indexedAt: '2026-08-01T00:00:00.000Z', commit: 'abcdef1234567', behind: 0, ahead: 0, dirtyRatio: 0, freshnessError: null,
  });
  assert.equal(badge.headline, 'Graph is 100% fresh as of abcdef1');
  assert.equal(badge.tone, 'fresh');
});

test('dirty_ratio가 0이어도 behind>0이면 stale 톤 — 커밋 드리프트가 스케줄러 미배선 상태에서도 조용히 fresh로 보이지 않게 한다', () => {
  const badge = freshnessBadge({
    status: 'ready', indexedAt: '2026-08-01T00:00:00.000Z', commit: 'abcdef1234567', behind: 12, ahead: 0, dirtyRatio: 0, freshnessError: null,
  });
  assert.equal(badge.tone, 'stale');
  assert.equal(badge.headline, 'Graph is 100% fresh as of abcdef1');
  assert.equal(badge.detail, '12 commits behind current HEAD');
});

test('dirty_ratio가 null(엣지 없음/미측정)이면 커밋 드리프트만으로 헤드라인을 구성한다 — 완료조건 2', () => {
  const behindOnly = freshnessBadge({
    status: 'ready', indexedAt: '2026-08-01T00:00:00.000Z', commit: 'abcdef1234567', behind: 5, ahead: 0, dirtyRatio: null, freshnessError: null,
  });
  assert.equal(behindOnly.headline, 'Graph is 5 commits behind HEAD (indexed at abcdef1)');
  assert.equal(behindOnly.tone, 'stale');

  const upToDate = freshnessBadge({
    status: 'ready', indexedAt: '2026-08-01T00:00:00.000Z', commit: 'abcdef1234567', behind: 0, ahead: 0, dirtyRatio: null, freshnessError: null,
  });
  assert.equal(upToDate.headline, 'Graph is up to date as of abcdef1');
  assert.equal(upToDate.tone, 'fresh');
});

test('behind가 정확히 1이면 단수형("1 commit", commits 아님)을 쓴다', () => {
  const badge = freshnessBadge({
    status: 'ready', indexedAt: '2026-08-01T00:00:00.000Z', commit: 'abcdef1234567', behind: 1, ahead: 0, dirtyRatio: null, freshnessError: null,
  });
  assert.match(badge.headline, /\b1 commit\b(?! s)/);
  assert.doesNotMatch(badge.headline, /1 commits/);
});

test('git 접근 실패(freshness_error)는 behind/ahead가 null이어도 detail에 원인을 보여준다', () => {
  const badge = freshnessBadge({
    status: 'ready', indexedAt: '2026-08-01T00:00:00.000Z', commit: 'abcdef1234567', behind: null, ahead: null, dirtyRatio: 0.1, freshnessError: 'Resource not found in workspace',
  });
  assert.equal(badge.detail, 'Unable to check current HEAD (Resource not found in workspace)');
});

test('dirtyRatioToFreshPercent은 반올림한 정수 퍼센트를 반환한다', () => {
  assert.equal(dirtyRatioToFreshPercent(0), 100);
  assert.equal(dirtyRatioToFreshPercent(1), 0);
  assert.equal(dirtyRatioToFreshPercent(0.04), 96);
  assert.equal(dirtyRatioToFreshPercent(0.005), 100); // 반올림
});
