// Unit coverage for the generalized ticket-comment loop-score detector
// (ticket 24df8677 — timing + near-duplicate-content signals combined into a
// single loop-risk score). Mirrors agent-chain-depth.test.mjs's structure.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  maskDynamicTokens,
  normalizeForSimilarity,
  jaccardSimilarity,
  isEligibleLoopScoreComment,
  computeLoopScore,
  __test__,
} from '../dist/common/loop-score.js';

function c(authorId, content, tMs, opts = {}) {
  return {
    content,
    created_at: new Date(tMs),
    author_type: opts.author_type ?? 'agent',
    author_id: authorId,
    type: opts.type ?? 'note',
    operational_recurrence_key: opts.operational_recurrence_key ?? null,
  };
}

// ───────────────────────── masking ─────────────────────────

test('maskDynamicTokens replaces each volatile-id class with a single opaque token', () => {
  assert.equal(
    maskDynamicTokens('ticket 9b64e47c-5a0e-48d6-bfb3-9d7738383e14 done'),
    'ticket <uuid> done',
  );
  assert.equal(
    maskDynamicTokens('commit 1234567890abcdef1234567890abcdef12345678 pushed'),
    'commit <sha> pushed',
  );
  assert.equal(maskDynamicTokens('see f0d12d48 for details'), 'see <sha> for details');
  assert.equal(maskDynamicTokens('at 2026-07-22T09:17:40.295Z now'), 'at <ts> now');
  assert.equal(maskDynamicTokens('on 2026-07-22 today'), 'on <ts> today');
  assert.equal(maskDynamicTokens('took 45ms total'), 'took <num> total');
  assert.equal(maskDynamicTokens('waited 12.3s more'), 'waited <num> more');
  assert.equal(maskDynamicTokens('87% done'), '<num> done');
  assert.equal(maskDynamicTokens('42 items left'), '<num> items left');
});

test('maskDynamicTokens leaves single-digit integers untouched (a real distinguishing count, not a volatile id)', () => {
  assert.equal(maskDynamicTokens('3 items left'), '3 items left');
  assert.equal(maskDynamicTokens('4 items left'), '4 items left');
});

test('maskDynamicTokens order: UUID masks as ONE token before short-hex can chew its hex groups piecemeal', () => {
  const withUuid = maskDynamicTokens('id 9b64e47c-5a0e-48d6-bfb3-9d7738383e14 end');
  assert.equal(withUuid, 'id <uuid> end');
  // Sanity: if short-hex ran first (wrong order), the 8-hex and 12-hex groups
  // would each independently match {7,12} and leave the two 4-hex groups
  // ("5a0e", "48d6", "bfb3") as literal un-masked text instead.
  assert.ok(!withUuid.includes('5a0e'));
});

test('two different volatile ids in an otherwise-identical sentence normalize to the same text', () => {
  const a = normalizeForSimilarity('Retry succeeded, sha 1234567 pushed');
  const b = normalizeForSimilarity('Retry succeeded, sha 89abcde pushed');
  assert.deepEqual(a, b);
  assert.equal(jaccardSimilarity(a, b), 1);
});

test('normalizeForSimilarity strips markdown decoration and collapses whitespace', () => {
  assert.deepEqual(normalizeForSimilarity('**Bold**   `code`   ok'), ['bold', 'code', 'ok']);
});

// ───────────────────────── jaccardSimilarity ─────────────────────────

test('jaccardSimilarity: both-empty is treated as identical (1)', () => {
  assert.equal(jaccardSimilarity([], []), 1);
});

test('jaccardSimilarity: disjoint token sets are 0', () => {
  assert.equal(jaccardSimilarity(['a', 'b'], ['c', 'd']), 0);
});

test('jaccardSimilarity: partial overlap computes intersection/union', () => {
  assert.equal(jaccardSimilarity(['alpha', 'beta'], ['alpha', 'beta', 'gamma', 'delta']), 0.5);
});

// ───────────────────────── input filter ─────────────────────────

test('isEligibleLoopScoreComment applies all three filter rules', () => {
  const holderKeys = new Set(['agent:A']);
  const base = { content: 'x', created_at: new Date(0), author_type: 'agent', author_id: 'A', type: 'note', operational_recurrence_key: null };
  assert.equal(isEligibleLoopScoreComment(base, holderKeys), true);
  assert.equal(isEligibleLoopScoreComment({ ...base, type: 'system' }, holderKeys), false);
  assert.equal(isEligibleLoopScoreComment({ ...base, operational_recurrence_key: 'agent-terminal-ack:t:x' }, holderKeys), false);
  assert.equal(isEligibleLoopScoreComment({ ...base, author_id: 'unrelated-manager' }, holderKeys), false);
});

test('regression fixture: the ebe29c44 shape is excluded ONLY by rule (3) — rules (1)/(2) both miss it', () => {
  // Real shape from ticket 24df8677's own history: a dispatch-suppression
  // note from an infra/manager agent that is not a role holder on the ticket.
  const holderKeys = new Set(['agent:reporter-id', 'agent:planner-id', 'agent:assignee-id', 'agent:reviewer-id']);
  const dispatchSuppressionNote = {
    content: '⚠️ 중복 dispatch 억제 (동일 ticket-role live twin 방지) — ...',
    created_at: new Date(0),
    author_type: 'agent',
    author_id: 'infra-manager-id',
    type: 'note',
    operational_recurrence_key: null,
  };
  // Prove rules (1) and (2) are no-ops on this exact shape before asserting
  // the combined filter still excludes it via rule (3).
  assert.notEqual(dispatchSuppressionNote.type, 'system');
  assert.equal(dispatchSuppressionNote.operational_recurrence_key, null);
  assert.equal(isEligibleLoopScoreComment(dispatchSuppressionNote, holderKeys), false);
});

// ───────────────────────── computeLoopScore ─────────────────────────

test('fewer than minComments eligible comments -> all signals zero, even with maxed alternation input', () => {
  const holderKeys = new Set(['agent:A']);
  const config = { window: 6, fastGapMs: 999_999_999, minComments: 4, simThreshold: 0.01, warn: 0.5, trip: 0.7 };
  const comments = [0, 1, 2].map((i) => c('A', 'same same same', i));
  const result = computeLoopScore(comments, holderKeys, { config, alternationScore: 1 });
  assert.deepEqual(result, { score: 0, timing: 0, content: 0, alternation: 0, commentCount: 3, warn: false, trip: false });
});

test('timing signal: adjacent gap exactly equal to FAST_GAP_MS counts as fast (inclusive boundary)', () => {
  const holderKeys = new Set(['agent:A']);
  const config = { window: 4, fastGapMs: 1000, minComments: 4, simThreshold: 0.85, warn: 0.5, trip: 0.7 };
  const comments = [0, 1000, 2000, 3000].map((t, i) => c('A', `msg unique-${i}`, t));
  const result = computeLoopScore(comments, holderKeys, { config });
  assert.equal(result.timing, 1);
});

test('timing signal: adjacent gap one ms over FAST_GAP_MS does not count as fast', () => {
  const holderKeys = new Set(['agent:A']);
  const config = { window: 4, fastGapMs: 1000, minComments: 4, simThreshold: 0.85, warn: 0.5, trip: 0.7 };
  const comments = [0, 1001, 2002, 3003].map((t, i) => c('A', `msg unique-${i}`, t));
  const result = computeLoopScore(comments, holderKeys, { config });
  assert.equal(result.timing, 0);
});

test('content signal: similarity exactly equal to SIM_THRESHOLD counts as duplicate (inclusive boundary)', () => {
  const holderKeys = new Set(['agent:A']);
  const config = { window: 4, fastGapMs: 0, minComments: 4, simThreshold: 0.5, warn: 0.5, trip: 0.7 };
  const comments = [
    c('A', 'alpha beta', 0),
    c('A', 'monkey ninja octopus', 100_000),
    c('A', 'alpha beta gamma delta', 200_000), // jaccard vs comment[0] == 2/4 == 0.5 (== threshold)
    c('A', 'zebra yak xray weta', 300_000),
  ];
  const result = computeLoopScore(comments, holderKeys, { config });
  assert.equal(result.timing, 0); // gaps are 100s, fastGapMs=0 -> none fast
  assert.equal(result.content, 1 / 3); // only index 2 matches (vs index 0) at exactly the threshold
});

test('only the most recent `window` eligible comments feed the signals; commentCount reports the full filtered total', () => {
  const holderKeys = new Set(['agent:A']);
  const config = { window: 3, fastGapMs: 100, minComments: 2, simThreshold: 0.85, warn: 0.5, trip: 0.7 };
  const comments = [
    c('A', 'far in the past duplicate text', 0),
    c('A', 'far in the past duplicate text', 50), // near-identical to comment 0, but falls OUTSIDE the window once 3 more land
    c('A', 'fresh one', 10_000),
    c('A', 'fresh two', 10_200), // gap 200 > fastGapMs(100) -> not fast
    c('A', 'fresh three', 10_250), // gap 50 <= fastGapMs(100) -> fast
  ];
  const result = computeLoopScore(comments, holderKeys, { config });
  assert.equal(result.commentCount, 5);
  assert.equal(result.timing, 0.5); // 1 fast gap out of 2 within the 3-wide window
  assert.equal(result.content, 0); // the near-duplicate pair is outside the window
});

test('a single maxed-out signal cannot reach even WARN — the weighted-sum policy guarantee', () => {
  const holderKeys = new Set(['agent:A']);
  const config = { window: 4, fastGapMs: 100_000, minComments: 4, simThreshold: 0.85, warn: 0.5, trip: 0.7 };
  const comments = [
    c('A', 'first entirely unique message aaa', 0),
    c('A', 'second entirely unique message bbb', 1000),
    c('A', 'third entirely unique message ccc', 2000),
    c('A', 'fourth entirely unique message ddd', 3000),
  ];
  const result = computeLoopScore(comments, holderKeys, { config });
  assert.equal(result.timing, 1);
  assert.equal(result.content, 0);
  assert.equal(result.score, 0.4);
  assert.equal(result.warn, false);
  assert.equal(result.trip, false);
});

test('both timing and content signals maxed reaches TRIP without any alternation input', () => {
  const holderKeys = new Set(['agent:A']);
  const config = { window: 4, fastGapMs: 100_000, minComments: 4, simThreshold: 0.85, warn: 0.5, trip: 0.7 };
  const comments = [0, 1000, 2000, 3000].map((t) => c('A', 'please confirm status abc123defgh', t));
  const result = computeLoopScore(comments, holderKeys, { config });
  assert.equal(result.timing, 1);
  assert.equal(result.content, 1);
  assert.equal(result.score, 0.8);
  assert.equal(result.warn, true);
  assert.equal(result.trip, true);
});

test('score exactly equal to WARN/TRIP counts as reaching that tier (inclusive boundary)', () => {
  const holderKeys = new Set(['agent:A']);
  // timing=1, content=0 -> score = 0.4*1 = 0.4; set WARN=0.4 exactly.
  const config = { window: 4, fastGapMs: 100_000, minComments: 4, simThreshold: 0.85, warn: 0.4, trip: 0.4 };
  const comments = [
    c('A', 'first entirely unique message aaa', 0),
    c('A', 'second entirely unique message bbb', 1000),
    c('A', 'third entirely unique message ccc', 2000),
    c('A', 'fourth entirely unique message ddd', 3000),
  ];
  const result = computeLoopScore(comments, holderKeys, { config });
  assert.equal(result.score, 0.4);
  assert.equal(result.warn, true);
  assert.equal(result.trip, true);
});

test('alternationScore is an optional [0,1] extension point (07402c57) that defaults to 0 and composes additively', () => {
  const holderKeys = new Set(['agent:A']);
  const config = { window: 4, fastGapMs: 0, minComments: 4, simThreshold: 0.85, warn: 0.5, trip: 0.7 };
  const comments = [0, 1, 2, 3].map((i) => c('A', `unique msg number-token-${i}`, i * 100_000));
  const noAlt = computeLoopScore(comments, holderKeys, { config });
  assert.equal(noAlt.score, 0);
  assert.equal(noAlt.alternation, 0);
  const withAlt = computeLoopScore(comments, holderKeys, { config, alternationScore: 1 });
  assert.equal(withAlt.alternation, 1);
  assert.equal(withAlt.score, 0.2);
  assert.equal(withAlt.warn, false); // alternation alone (0.2) still can't reach WARN (0.5)
});

test('alternationScore out-of-range input is clamped to [0,1]', () => {
  const holderKeys = new Set(['agent:A']);
  const config = { window: 4, fastGapMs: 0, minComments: 4, simThreshold: 0.85, warn: 0.5, trip: 0.7 };
  const comments = [0, 1, 2, 3].map((i) => c('A', `unique msg number-token-${i}`, i * 100_000));
  const result = computeLoopScore(comments, holderKeys, { config, alternationScore: 5 });
  assert.equal(result.alternation, 1);
});

test('computeLoopScore is deterministic and takes no wall-clock input — repeated calls on the same sequence agree', () => {
  const holderKeys = new Set(['agent:A', 'agent:B']);
  const comments = [
    c('A', 'alpha bravo charlie', 0),
    c('B', 'delta echo foxtrot', 500),
    c('A', 'alpha bravo charlie', 1000),
    c('B', 'delta echo foxtrot', 1500),
  ];
  const r1 = computeLoopScore(comments, holderKeys);
  const r2 = computeLoopScore(comments, holderKeys);
  assert.deepEqual(r1, r2);
});

test('non-holder and system/operational-recurrence comments never contaminate the signals even inside an otherwise-tight loop', () => {
  const holderKeys = new Set(['agent:A', 'agent:B']);
  const config = { window: 4, fastGapMs: 100_000, minComments: 4, simThreshold: 0.85, warn: 0.5, trip: 0.7 };
  const comments = [
    c('A', 'status update aaa', 0),
    c('system-actor', 'housekeeping row', 100, { type: 'system' }),
    c('infra-manager', 'status update aaa', 150, { author_type: 'agent' }), // not a role holder -> excluded by rule (3)
    c('B', 'status update aaa', 200, { operational_recurrence_key: 'agent-terminal-ack:t:x' }), // excluded by rule (2)
    c('A', 'status update bbb', 300_000),
    c('B', 'status update ccc', 300_500),
    c('A', 'status update ddd', 301_000),
  ];
  // Eligible after filtering: [A@0 'aaa', A@300000 'bbb', B@300500 'ccc', A@301000 'ddd'] = 4 (== minComments, gate passes)
  const result = computeLoopScore(comments, holderKeys, { config });
  assert.equal(result.commentCount, 4);
  // gaps: 300000-0=300000(slow), 300500-300000=500(fast), 301000-300500=500(fast) -> 2/3 fast
  assert.equal(result.timing, 2 / 3);
  // content: 'aaa' vs 'bbb'/'ccc'/'ddd' all distinct words -> no duplicates
  assert.equal(result.content, 0);
});

// ───────────────────────── config ─────────────────────────

test('readConfigFromEnv falls back to defaults on empty/garbage env', () => {
  const cfg = __test__.readConfigFromEnv({});
  assert.deepEqual(cfg, __test__.DEFAULTS);
  const cfg2 = __test__.readConfigFromEnv({ LOOP_SCORE_WINDOW: 'not-a-number', LOOP_SCORE_WARN: '' });
  assert.equal(cfg2.window, __test__.DEFAULTS.window);
  assert.equal(cfg2.warn, __test__.DEFAULTS.warn);
});

test('readConfigFromEnv honors overrides', () => {
  const cfg = __test__.readConfigFromEnv({
    LOOP_SCORE_WINDOW: '10',
    LOOP_SCORE_FAST_GAP_MS: '60000',
    LOOP_SCORE_MIN_COMMENTS: '5',
    LOOP_SCORE_SIM_THRESHOLD: '0.9',
    LOOP_SCORE_WARN: '0.4',
    LOOP_SCORE_TRIP: '0.6',
  });
  assert.deepEqual(cfg, {
    window: 10, fastGapMs: 60000, minComments: 5, simThreshold: 0.9, warn: 0.4, trip: 0.6,
  });
});

test('sanitizeConfig clamps window/minComments to a floor of 2 (divide-by-zero guard) without silently defaulting a legitimate low value', () => {
  const cfg = __test__.sanitizeConfig({
    window: 1, fastGapMs: 100, minComments: 0, simThreshold: 0.5, warn: 0.5, trip: 0.5,
  });
  assert.equal(cfg.window, 2);
  assert.equal(cfg.minComments, 2);
});

test('sanitizeConfig falls back thresholds to the DEFAULT (not 0) on NaN input — 0 would be maximally permissive, not safe', () => {
  const cfg = __test__.sanitizeConfig({
    window: 6, fastGapMs: 100, minComments: 4, simThreshold: NaN, warn: NaN, trip: NaN,
  });
  assert.equal(cfg.simThreshold, __test__.DEFAULTS.simThreshold);
  assert.equal(cfg.warn, __test__.DEFAULTS.warn);
  assert.equal(cfg.trip, __test__.DEFAULTS.trip);
});
