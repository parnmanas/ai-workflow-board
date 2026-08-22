// Mission 실행 계약(ticket 2dc3c62f) — 완료 조건 체크리스트 + post-action
// 파이프라인의 순수 로직 단위 테스트.
//
// 이 파일이 지키는 불변식들:
//   allCriteriaMet()            — 빈/null 배열은 게이트 없음(하위호환)이라 true;
//                                 그 외엔 전원 met이어야만 true.
//   normalizeCompletionCriteria — key 중복/빈 description을 거부하고, met=true가
//                                 아닌 항목은 met_at을 절대 채우지 않는다.
//   normalizePostActions       — 정의 단계에서 항상 status:'pending'으로
//                                 리셋하고 order로 정렬한다(실행 상태는 오직
//                                 runPostActions()만 쓴다).
//   postActionApplies          — condition과 최종 mission status의 매핑표.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const {
  allCriteriaMet,
  normalizeCompletionCriteria,
  normalizePostActions,
  postActionApplies,
} = await import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration.constants.js')).href);

test('allCriteriaMet — null/empty는 게이트 없음(기존 모든 미션에 대한 하위호환)', () => {
  assert.equal(allCriteriaMet(null), true);
  assert.equal(allCriteriaMet(undefined), true);
  assert.equal(allCriteriaMet([]), true);
});

test('allCriteriaMet — 모든 항목이 met이어야만 true', () => {
  assert.equal(allCriteriaMet([{ key: 'a', met: true }, { key: 'b', met: true }]), true);
  assert.equal(allCriteriaMet([{ key: 'a', met: true }, { key: 'b', met: false }]), false);
  assert.equal(allCriteriaMet([{ key: 'a', met: false }]), false);
});

test('normalizeCompletionCriteria — null/undefined는 빈(게이트 없는) 배열로 정규화된다', () => {
  assert.deepEqual(normalizeCompletionCriteria(null), { criteria: [] });
  assert.deepEqual(normalizeCompletionCriteria(undefined), { criteria: [] });
});

test('normalizeCompletionCriteria — 배열이 아닌 입력을 거부한다', () => {
  const result = normalizeCompletionCriteria('not-an-array');
  assert.ok('error' in result);
});

test('normalizeCompletionCriteria — 형식이 잘못된 key와 중복 key를 거부한다', () => {
  const badKey = normalizeCompletionCriteria([{ key: 'Not Valid!', description: 'x' }]);
  assert.ok('error' in badKey);

  const dup = normalizeCompletionCriteria([
    { key: 'tests-pass', description: 'a' },
    { key: 'tests-pass', description: 'b' },
  ]);
  assert.ok('error' in dup);
});

test('normalizeCompletionCriteria — 빈 description을 거부한다', () => {
  const result = normalizeCompletionCriteria([{ key: 'x', description: '  ' }]);
  assert.ok('error' in result);
});

test('normalizeCompletionCriteria — met:false는 호출자가 met_at을 줘도 절대 채우지 않는다', () => {
  const result = normalizeCompletionCriteria([
    { key: 'x', description: 'desc', met: false, met_at: '2026-01-01T00:00:00Z' },
  ]);
  assert.equal('error' in result, false);
  assert.equal(result.criteria[0].met_at, null);
});

test('normalizeCompletionCriteria — met:true는 전달된 met_at을 그대로 유지한다', () => {
  const result = normalizeCompletionCriteria([
    { key: 'x', description: 'desc', met: true, met_at: '2026-01-01T00:00:00Z' },
  ]);
  assert.equal('error' in result, false);
  assert.equal(result.criteria[0].met_at, '2026-01-01T00:00:00Z');
});

test('normalizePostActions — null/undefined는 빈 목록으로 정규화된다', () => {
  assert.deepEqual(normalizePostActions(null), { postActions: [] });
});

test('normalizePostActions — 배열이 아닌 입력을 거부한다', () => {
  assert.ok('error' in normalizePostActions('nope'));
});

test('normalizePostActions — action_id가 없는 항목은 조용히 버린다(UI가 편집 중 빈 행을 보낼 수 있음)', () => {
  const result = normalizePostActions([{ action_id: '' }, { action_id: 'a-1' }]);
  assert.equal('error' in result, false);
  assert.equal(result.postActions.length, 1);
  assert.equal(result.postActions[0].action_id, 'a-1');
});

test('normalizePostActions — 항상 status를 pending으로 리셋하고 run 관련 필드를 지운다(정의 단계는 실행 상태를 갖지 않는다)', () => {
  const result = normalizePostActions([
    { action_id: 'a-1', status: 'dispatched', run_id: 'stale-run', error: 'stale error' },
  ]);
  assert.equal('error' in result, false);
  const [pa] = result.postActions;
  assert.equal(pa.status, 'pending');
  assert.equal(pa.run_id, null);
  assert.equal(pa.error, '');
});

test('normalizePostActions — condition 기본값은 "always"이고 order로 정렬한다', () => {
  const result = normalizePostActions([
    { action_id: 'second', order: 2 },
    { action_id: 'first', order: 1, condition: 'on_failure' },
    { action_id: 'third-bad-condition', order: 3, condition: 'not-a-real-condition' },
  ]);
  assert.equal('error' in result, false);
  assert.deepEqual(
    result.postActions.map((p) => p.action_id),
    ['first', 'second', 'third-bad-condition'],
  );
  assert.equal(result.postActions[0].condition, 'on_failure');
  assert.equal(result.postActions[1].condition, 'always');
  assert.equal(result.postActions[2].condition, 'always'); // 유효하지 않은 condition은 'always'로 폴백
});

test('postActionApplies — always는 최종 status와 무관하게 항상 실행된다', () => {
  assert.equal(postActionApplies('always', 'completed'), true);
  assert.equal(postActionApplies('always', 'failed'), true);
  assert.equal(postActionApplies('always', 'cancelled'), true);
});

test('postActionApplies — on_success/on_failure는 최종 status에 대해 서로 배타적이다', () => {
  assert.equal(postActionApplies('on_success', 'completed'), true);
  assert.equal(postActionApplies('on_success', 'failed'), false);
  assert.equal(postActionApplies('on_failure', 'failed'), true);
  assert.equal(postActionApplies('on_failure', 'completed'), false);
  // 운영자 cancel에는 둘 다 실행되지 않는다 — post_actions는 completeMission()
  // (completed/failed)에서만 평가되고 cancelMission()에서는 절대 평가되지
  // 않지만, 이 순수 함수 자체는 인식되지 않는 status에 대해 조용히 적용돼서는
  // 안 된다.
  assert.equal(postActionApplies('on_success', 'cancelled'), false);
  assert.equal(postActionApplies('on_failure', 'cancelled'), false);
});
