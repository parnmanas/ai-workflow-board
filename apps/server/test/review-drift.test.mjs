// Unit test — review-drift classifier + budget + merge-gate Q3 integration
// (ticket 59efbde9).
//
// ec498050's retrospective: the same NON-conflicting base-freshness reason
// bounced one ticket Review→In Progress→Review 5 times in a row, because the
// old gate bounced on ANY origin/main advance regardless of path overlap.
// `classifyDrift` (shared/review-drift.ts) replaces raw-commit-count gating
// with path-overlap classification + a one-shot-per-episode reverification
// budget. This file drives the compiled module directly (same "import dist,
// call the real pure function" posture as prompt-audit-forbidden-phrases.
// test.mjs uses for DEFAULT_PROMPT_TEMPLATES) so the full truth table is
// pinned without a network or a booted app — the qa-flows/review-drift.test.mjs
// sibling covers the live MCP tool + episode-state persistence end to end.
//
// 티켓 6a9f9de9 이 축 하나를 더 얹는다: feature tip 이 이미 base tip 의 조상인
// (= 이미 병합된) 브랜치. 그 경우 branchPaths 는 빈 배열이 되는데, Q1 의
// repo-global 규칙 ③ 은 branch 쪽을 아예 보지 않고 발동하므로 이미 main 에
// 들어간 브랜치가 `overlapping_drift` -> `rebase_required` 로 오분류됐다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const reviewDrift = await import(
  'file://' + path.join(DIST, 'modules', 'mcp', 'shared', 'review-drift.js')
);
const mergeGate = await import(
  'file://' + path.join(DIST, 'modules', 'mcp', 'shared', 'merge-gate.js')
);
const gitRepoCache = await import(
  'file://' + path.join(DIST, 'modules', 'mcp', 'shared', 'git-repo-cache.js')
);
const entities = await import('file://' + path.join(DIST, 'entities', 'index.js'));

test('review-drift module exports the classifier, recommender, orchestrator + test seam', () => {
  assert.equal(typeof reviewDrift.classifyDrift, 'function', 'classifyDrift must be exported');
  assert.equal(typeof reviewDrift.recommendationFor, 'function', 'recommendationFor must be exported');
  assert.equal(typeof reviewDrift.checkReviewDrift, 'function', 'checkReviewDrift orchestrator must be exported');
  assert.equal(typeof reviewDrift.defaultReviewDriftProbe, 'function', 'defaultReviewDriftProbe must be exported');
  assert.equal(typeof reviewDrift.__setReviewDriftProbeForTests, 'function', 'test seam must be exported (qa-flow needs it)');
  assert.equal(reviewDrift.MAX_DRIFT_REVERIFICATIONS, 1, 'default budget must be 1 (no env override in this process)');
});

test('classifyDrift: no main drift at all -> fresh, regardless of branch paths', () => {
  assert.equal(reviewDrift.classifyDrift([], [], 0), 'fresh');
  assert.equal(reviewDrift.classifyDrift(['apps/server/src/a.ts'], [], 0), 'fresh');
});

test('classifyDrift: Q1 rule 1 - exact path intersection is overlapping', () => {
  const c = reviewDrift.classifyDrift(['apps/server/src/a.ts'], ['apps/server/src/a.ts'], 0);
  assert.equal(c, 'overlapping_drift');
});

test('classifyDrift: Q1 rule 2 - same immediate parent directory is overlapping', () => {
  const c = reviewDrift.classifyDrift(['apps/server/src/dir/a.ts'], ['apps/server/src/dir/b.ts'], 0);
  assert.equal(c, 'overlapping_drift', 'same directory, different file, must still count as overlap');
});

test('classifyDrift: different directories with no repo-global file is non-overlapping', () => {
  const c = reviewDrift.classifyDrift(['apps/server/src/a.ts'], ['apps/client/src/b.ts'], 0);
  assert.equal(c, 'non_overlapping_drift');
});

test('classifyDrift: Q1 rule 3 - repo-global files (package.json/lockfile/tsconfig*/workflows) always overlap', () => {
  const cases = [
    ['package.json'],
    ['package-lock.json'],
    ['turbo.json'],
    ['tsconfig.json'],
    ['tsconfig.build.json'],
    ['.github/workflows/ci.yml'],
  ];
  for (const mainDriftPaths of cases) {
    const c = reviewDrift.classifyDrift([], mainDriftPaths, 0);
    assert.equal(
      c, 'overlapping_drift',
      `${JSON.stringify(mainDriftPaths)} must overlap even with an empty/unrelated branch diff`,
    );
  }
  // A non-repo-global root file must NOT trip rule 3.
  assert.equal(reviewDrift.classifyDrift([], ['README.md'], 0), 'non_overlapping_drift');
});

test('classifyDrift: budget gating - overlapping drift is a rebase candidate only while count < MAX', () => {
  assert.equal(
    reviewDrift.classifyDrift(['a/b.ts'], ['a/b.ts'], 0), 'overlapping_drift',
    'count(0) < MAX(1) must still recommend a bounce',
  );
  assert.equal(
    reviewDrift.classifyDrift(['a/b.ts'], ['a/b.ts'], 1), 'overlapping_drift_budget_exhausted',
    'count(1) >= MAX(1) must stop recommending a bounce',
  );
  assert.equal(
    reviewDrift.classifyDrift(['a/b.ts'], ['a/b.ts'], 5), 'overlapping_drift_budget_exhausted',
    'a stale/over-count must still degrade to budget_exhausted, never throw or recommend endlessly',
  );
});

// ── 티켓 6a9f9de9: 이미 병합된 브랜치는 overlapping drift 가 아니다 ──────────
test('classifyDrift: 이미 병합된 브랜치는 repo-global drift 앞에서도 already_merged 다 (오분류 재현)', () => {
  // 재현 조건 그대로: 병합돼서 branchPaths 가 비었고, 그 사이 main 이
  // package-lock.json 을 건드렸다. 수정 전에는 규칙 ③ 이 branch 쪽을 보지 않고
  // 발동해 overlapping_drift -> rebase_required 가 나왔다.
  assert.equal(
    reviewDrift.classifyDrift([], ['package-lock.json'], 0, true),
    'already_merged',
    '이미 main 에 들어간 브랜치는 repo-global 변경이 있어도 rebase 대상이 아니다',
  );
  // 같은 입력에서 조상 사실만 빼면 기존 오분류가 그대로 재현된다 — 이 테스트가
  // 무엇을 고쳤는지 대조군으로 못박는다.
  assert.equal(
    reviewDrift.classifyDrift([], ['package-lock.json'], 0, false),
    'overlapping_drift',
    '병합되지 않은 브랜치의 repo-global 규칙 ③ 은 그대로 유지돼야 한다',
  );
});

test('classifyDrift: 병합-조상 판정이 overlap·budget 판정보다 먼저다', () => {
  // 실제 경로 교집합이 있어도(= 규칙 ①), budget 이 남았든 소진됐든 결과는
  // already_merged 하나로 수렴해야 한다. rebase 로 더 최신이 될 수 없는
  // 브랜치이므로 budget 을 태울 이유 자체가 없다.
  for (const count of [0, 1, 5]) {
    assert.equal(
      reviewDrift.classifyDrift(['a/b.ts'], ['a/b.ts'], count, true),
      'already_merged',
      `count=${count} 에서도 병합-조상이 우선해야 한다`,
    );
  }
  // main 이 전혀 움직이지 않은 경우에도 같은 판정 — 병합 직후와 몇 분 뒤가
  // 같은 verdict 여야 한다(fresh <-> already_merged 로 흔들리면 안 된다).
  assert.equal(reviewDrift.classifyDrift([], [], 0, true), 'already_merged');
});

test('classifyDrift: 4번째 인자를 생략하면 티켓 6a9f9de9 이전과 바이트 단위로 같다', () => {
  // 기존 호출자(테스트 포함)는 3-인자로 부른다 — 기본값이 false 여야 한다.
  assert.equal(reviewDrift.classifyDrift([], ['package-lock.json'], 0), 'overlapping_drift');
  assert.equal(reviewDrift.classifyDrift(['a/b.ts'], ['a/b.ts'], 1), 'overlapping_drift_budget_exhausted');
  assert.equal(reviewDrift.classifyDrift(['apps/server/src/a.ts'], ['apps/client/src/b.ts'], 0), 'non_overlapping_drift');
  assert.equal(reviewDrift.classifyDrift([], [], 0), 'fresh');
});

test('isFeatureContainedInBase: merge-base == feature tip 일 때만 참, 빈 SHA 는 거짓', () => {
  assert.equal(typeof reviewDrift.isFeatureContainedInBase, 'function', '조상 판정 술어가 export 돼야 한다');
  assert.equal(reviewDrift.isFeatureContainedInBase('sha-tip', 'sha-tip'), true, 'merge-base 가 feature tip 이면 base 에 포함된 것');
  assert.equal(reviewDrift.isFeatureContainedInBase('sha-fork', 'sha-tip'), false, 'fork point 가 tip 과 다르면 아직 분기 중');
  // 빈 문자열 두 개가 우연히 같다고 "이미 병합"으로 오판하면 미해결 probe 가
  // 조용히 rebase 게이트를 통과시킨다 — availability-first 와 정반대 방향의
  // 오류이므로 명시적으로 막는다.
  assert.equal(reviewDrift.isFeatureContainedInBase('', ''), false, '빈 SHA 쌍은 병합 증거가 아니다');
  assert.equal(reviewDrift.isFeatureContainedInBase('', 'sha-tip'), false);
  assert.equal(reviewDrift.isFeatureContainedInBase('sha-tip', ''), false);
});

test('overlappingSubset: returns only the paths that actually overlap, not the whole mainDriftPaths set', () => {
  const branchPaths = ['apps/server/src/modules/mcp/shared/review-drift.ts'];
  const mainDriftPaths = [
    'apps/client/src/unrelated-r2.ts',
    'apps/client/src/unrelated-r3.ts',
    'apps/server/src/modules/mcp/shared/review-drift.ts',
  ];
  assert.deepEqual(
    reviewDrift.overlappingSubset(branchPaths, mainDriftPaths),
    ['apps/server/src/modules/mcp/shared/review-drift.ts'],
    'must exclude the unrelated paths main also touched',
  );
});

test('overlappingSubset: a repo-global hit is included even when the branch never touched that exact path', () => {
  const branchPaths = ['apps/server/src/modules/mcp/shared/a.ts'];
  const mainDriftPaths = ['package.json', 'apps/client/src/unrelated.ts'];
  assert.deepEqual(
    reviewDrift.overlappingSubset(branchPaths, mainDriftPaths),
    ['package.json'],
    'repo-global files are reported, unrelated paths are not',
  );
});

test('overlappingSubset: no overlap -> empty array', () => {
  assert.deepEqual(
    reviewDrift.overlappingSubset(['apps/server/src/a.ts'], ['apps/client/src/b.ts']),
    [],
  );
});

test('recommendationFor: only overlapping_drift (budget remaining) ever recommends a bounce', () => {
  assert.equal(reviewDrift.recommendationFor('fresh'), 'proceed');
  assert.equal(reviewDrift.recommendationFor('non_overlapping_drift'), 'proceed');
  assert.equal(reviewDrift.recommendationFor('already_merged'), 'proceed', '이미 병합된 브랜치는 rebase 를 요구하지 않는다');
  assert.equal(reviewDrift.recommendationFor('overlapping_drift'), 'rebase_required');
  assert.equal(reviewDrift.recommendationFor('overlapping_drift_budget_exhausted'), 'proceed_no_action');
});

test('git-repo-cache exports diffChangedPaths for the drift probe', () => {
  assert.equal(typeof gitRepoCache.diffChangedPaths, 'function', 'diffChangedPaths must be exported');
});

test('git-repo-cache exports mergeBase (blocker 1 fix: seeds base_sha_at_entry from the fork point)', () => {
  assert.equal(typeof gitRepoCache.mergeBase, 'function', 'mergeBase must be exported');
});

test('entities barrel exports ReviewDriftState for TypeORM synchronize auto-DDL', () => {
  assert.equal(typeof entities.ReviewDriftState, 'function', 'ReviewDriftState entity class must be exported');
});

// ── Q3: merge-gate overlap-aware integration (ticket 59efbde9) ─────────────
// merge-gate-guard.test.mjs pins that decideMergeGate/evaluateMergeGate's
// EXISTING behavior is untouched (zero line changes there, per the ticket's
// own risk/rollback requirement) — this block covers the NEW optional
// driftClassification behavior added on top, kept in this file rather than
// modifying that one.
test('decideMergeGate: omitting driftClassification is byte-for-byte the pre-59efbde9 behavior', () => {
  const gate = { enabled: true, require_fresh_base: true, require_full_merge: true };
  const decision = mergeGate.decideMergeGate('review_to_merging', gate, { behind: 2, ahead: 0 });
  assert.equal(decision.blocked, true, 'no classification supplied must still block a stale base');
  assert.equal(decision.code, 'merge_gate_stale_base');
});

test('decideMergeGate: non_overlapping_drift and budget_exhausted bypass the stale-base block', () => {
  const gate = { enabled: true, require_fresh_base: true, require_full_merge: true };
  const ba = { behind: 2, ahead: 0 };
  // already_merged 도 같은 집합에 든다 (티켓 6a9f9de9): 이미 병합된 브랜치는
  // 정의상 behind>0 인데, 그 상태로 stale-base 를 막으면 classifier 가
  // proceed 를 말하는 동안 게이트가 막는 Q3 데드락이 그대로 재현된다.
  for (const cls of ['non_overlapping_drift', 'overlapping_drift_budget_exhausted', 'already_merged']) {
    const decision = mergeGate.decideMergeGate('review_to_merging', gate, ba, cls);
    assert.equal(decision.blocked, false, `${cls} must bypass the stale-base block (Q3 deadlock fix)`);
  }
});

test('decideMergeGate: a live (budget-remaining) overlapping_drift does NOT bypass the block', () => {
  const gate = { enabled: true, require_fresh_base: true, require_full_merge: true };
  const decision = mergeGate.decideMergeGate('review_to_merging', gate, { behind: 2, ahead: 0 }, 'overlapping_drift');
  assert.equal(decision.blocked, true, 'an unspent-budget overlap must still funnel through the single rebase-and-reverify cycle');
});

test('decideMergeGate: "fresh" classification does not manufacture a bypass (conservative default)', () => {
  const gate = { enabled: true, require_fresh_base: true, require_full_merge: true };
  const decision = mergeGate.decideMergeGate('review_to_merging', gate, { behind: 2, ahead: 0 }, 'fresh');
  assert.equal(decision.blocked, true, 'only a resolved SAFE classification may bypass — availability-first');
});

test('decideMergeGate: merging_to_done ignores driftClassification entirely', () => {
  const gate = { enabled: true, require_fresh_base: true, require_full_merge: true };
  const decision = mergeGate.decideMergeGate('merging_to_done', gate, { behind: 0, ahead: 3 }, 'non_overlapping_drift');
  assert.equal(decision.blocked, true, 'partial-merge must still block regardless of drift classification');
  assert.equal(decision.code, 'merge_gate_partial_merge');
});
