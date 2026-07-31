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

test('recommendationFor: only overlapping_drift (budget remaining) ever recommends a bounce', () => {
  assert.equal(reviewDrift.recommendationFor('fresh'), 'proceed');
  assert.equal(reviewDrift.recommendationFor('non_overlapping_drift'), 'proceed');
  assert.equal(reviewDrift.recommendationFor('overlapping_drift'), 'rebase_required');
  assert.equal(reviewDrift.recommendationFor('overlapping_drift_budget_exhausted'), 'proceed_no_action');
});

test('git-repo-cache exports diffChangedPaths for the drift probe', () => {
  assert.equal(typeof gitRepoCache.diffChangedPaths, 'function', 'diffChangedPaths must be exported');
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
  for (const cls of ['non_overlapping_drift', 'overlapping_drift_budget_exhausted']) {
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
