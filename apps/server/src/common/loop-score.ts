/**
 * Generalized ticket-comment loop-score detector (ticket 24df8677).
 *
 * Background: `f0d12d48` (TXIV 1e8b8e36 coverage audit) found that AWB's
 * existing anti-ping-pong defenses are each scoped to ONE exact-match shape —
 * `terminalAckKey` (agent-comment-pingpong.ts) dedupes identical terminal
 * receipts, `computeSystemFingerprint` (agent-api.controller.ts) dedupes
 * identical silent-exit system rows, `computeChainDepth` (agent-chain-depth.ts)
 * counts strictly-alternating agent authorship. None of them catch a loop that
 * varies its wording slightly (a SHA / PID / timestamp changes each cycle) or
 * that never quite repeats the exact same key but still cycles fast. This
 * module adds two SCORED (not exact-match) signals — timing cadence and
 * near-duplicate content — and a combinator that produces a single
 * loop-risk score, with a third slot reserved for the author-alternation
 * signal `07402c57` already computes (`computeChainDepth` /
 * `computeTicketCommentChainDepth`), normalized to [0,1] by that ticket's own
 * follow-up guard-wiring work — NOT wired here.
 *
 * Boundary with adjacent detectors (so the three never fight over the same
 * ticket):
 *   - `stuck-ticket-detector.service.ts` explicitly bails when the comment
 *     span is UNDER `STUCK_DETECTOR_MIN_SPAN_MS` (2h) — see its "Time span
 *     guard — fast-loop comments... are explicitly excluded" comment. That 2h
 *     floor is deliberately this module's ceiling: stuck-detector owns SLOW
 *     repetition (>=2h, "the agent stopped making progress"), this module
 *     owns FAST repetition (<2h, "the agent is spinning"). The chosen
 *     `LOOP_SCORE_FAST_GAP_MS` default (5 min) sits nearly 24x below that 2h
 *     floor, so the two detectors' trip zones never overlap.
 *   - `respawn-storm-detector.service.ts` counts SUBAGENT PROCESS DEATHS
 *     (an abnormally-short-lived CLI process exiting repeatedly), not
 *     comment/trigger cadence — a ticket can loop-score TRIP with every
 *     subagent exiting cleanly (no deaths at all), and a respawn storm can
 *     fire with zero comments written. Disjoint signals, disjoint code.
 *
 * Scope of THIS ticket: compute + expose the score for logging/observability
 * only. Thresholds are exposed (WARN/TRIP) so a caller can classify a score,
 * but no caller in this change acts on that classification (block, pend,
 * suppress) — that policy wiring is deliberately left to a follow-up ticket
 * once real WARN-tier data justifies specific guard behavior. This keeps the
 * calculator pure and the (future) policy at the call site, mirroring the
 * split `agent-comment-pingpong.ts` already uses between its pure key
 * functions and `applyAgentCommentPingPongGuard`'s side effects.
 *
 * Config shape deliberately follows `stuck-ticket-detector.service.ts`'s
 * simple env-folded-constants style (`readConfigFromEnv` reading `process.env`
 * directly) rather than `respawn-storm-config.ts`'s zod per-board schema: this
 * ticket ships a compute-and-log utility with no per-board policy to vary yet,
 * so a per-board override surface would be speculative. The guard-wiring
 * follow-up can graduate to the zod pattern once a real policy needs
 * per-board tuning.
 */

// ───────────────────────── Config ─────────────────────────

export interface LoopScoreConfig {
  /** Most recent N eligible comments considered for the signals below. */
  window: number;
  /** Adjacent-comment gap at/under which a step counts as "fast". */
  fastGapMs: number;
  /** Fewer than this many eligible comments → all signals report 0 (new-ticket / thin-sample guard, mirrors stuck-detector's WINDOW=4 minimum-sample logic). */
  minComments: number;
  /** Masked-content Jaccard similarity at/over which two comments count as near-duplicates. */
  simThreshold: number;
  /** Score at/over which `warn` is set — observation-only tier (logged, no action). */
  warn: number;
  /** Score at/over which `trip` is set — the tier a future guard-wiring ticket would act on. */
  trip: number;
}

const DEFAULTS: LoopScoreConfig = {
  window: 6, // gaps=5: 4 is noise-prone (per stuck-detector's own WINDOW=4 lesson), 8+ means tokens are already burned by the time it trips.
  fastGapMs: 300_000, // 5 min — a mention-trigger auto-dispatch round trip (spawn -> work -> comment) usually lands in 1-5 min; a human isn't likely to sustain 5 consecutive sub-5-min replies.
  minComments: 4,
  simThreshold: 0.85,
  warn: 0.5,
  trip: 0.7,
};

// Fixed structural weights — deliberately NOT part of LoopScoreConfig / not
// env-configurable. timing/content capped at 0.4 each and alternation at 0.2
// is a policy guarantee, not a tuning knob: a single maxed-out signal (0.4)
// can never even reach WARN (0.5), let alone TRIP (0.7) — a loop must be BOTH
// fast AND repetitive (or, once 07402c57's signal is wired in, alternating)
// to trip. Exposing these as env vars would let an operator silently break
// that guarantee (e.g. an env-set timing weight of 0.8 would let cadence
// alone trip). The 6 LOOP_SCORE_* knobs below are the tuning surface; this
// combination policy is not.
const WEIGHT_TIMING = 0.4;
const WEIGHT_CONTENT = 0.4;
const WEIGHT_ALTERNATION = 0.2;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Re-applied to both env-parsed AND directly-constructed configs so a bad `window`/`minComments` (NaN, or below the divide-by-zero floor) can never break downstream math. NaN/non-finite falls back to the built-in default; any other finite number is floored and clamped — 0 is a legitimate (if extreme) input, not a signal to silently swap in the default. */
function sanitizeConfig(config: LoopScoreConfig): LoopScoreConfig {
  const safeInt = (n: number, fallback: number, floor: number): number => {
    const v = Math.floor(n);
    return Number.isFinite(v) ? Math.max(floor, v) : fallback;
  };
  // NaN falls back to the DEFAULT threshold, not to clamp01's 0 — for a
  // threshold, 0 is the maximally-PERMISSIVE value (every gap "fast", every
  // pair "duplicate", every score "warn"), the opposite of a safe fallback.
  const safeRatio = (n: number, fallback: number): number =>
    Number.isFinite(n) ? clamp01(n) : fallback;
  return {
    window: safeInt(config.window, DEFAULTS.window, 2),
    fastGapMs: safeInt(config.fastGapMs, DEFAULTS.fastGapMs, 0),
    minComments: safeInt(config.minComments, DEFAULTS.minComments, 2),
    simThreshold: safeRatio(config.simThreshold, DEFAULTS.simThreshold),
    warn: safeRatio(config.warn, DEFAULTS.warn),
    trip: safeRatio(config.trip, DEFAULTS.trip),
  };
}

function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LoopScoreConfig {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return sanitizeConfig({
    window: num(env.LOOP_SCORE_WINDOW, DEFAULTS.window),
    fastGapMs: num(env.LOOP_SCORE_FAST_GAP_MS, DEFAULTS.fastGapMs),
    minComments: num(env.LOOP_SCORE_MIN_COMMENTS, DEFAULTS.minComments),
    simThreshold: num(env.LOOP_SCORE_SIM_THRESHOLD, DEFAULTS.simThreshold),
    warn: num(env.LOOP_SCORE_WARN, DEFAULTS.warn),
    trip: num(env.LOOP_SCORE_TRIP, DEFAULTS.trip),
  });
}

// Exposed for unit tests, same convention as stuck-ticket-detector.service.ts.
export const __test__ = { readConfigFromEnv, sanitizeConfig, DEFAULTS };

// ───────────────────────── Content masking ─────────────────────────
//
// Order is load-bearing (Planner review, ticket 24df8677): a UUID's dashed
// hex groups would otherwise get chewed up piecemeal by the short-hex rule,
// and a long SHA would collide with the short-hex rule too. Each step
// replaces its match with a single opaque type token (never deletes) so
// sentence structure survives — "commit <sha> failed" and "commit <sha>
// succeeded" stay distinguishable after masking, only the volatile id/number
// itself is erased.

const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RE_LONG_HEX = /\b(?:[0-9a-f]{40}|[0-9a-f]{64})\b/gi;
const RE_SHORT_HEX = /\b[0-9a-f]{7,12}\b/gi;
// ISO-8601: bare date or full timestamp, optional fractional seconds/Z.
const RE_ISO_TS = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\b/g;
// Numbers with an attached unit (12.3s, 45ms, 87%, 3h, 20min) — matched as
// ONE token before bare integers so e.g. "45ms" doesn't leave a dangling unit.
// Trailing boundary is a negative lookahead, NOT `\b`: `%` is a non-word
// character, so `\b` can never match right after it (a `%`-then-space has no
// word/non-word transition) and would silently fail to consume "87%". The
// lookahead also still rejects a partial match inside a longer word (e.g.
// "ms" inside "45msec" is followed by the word-char "e" -> rejected), the
// same protection `\b` gave for the word-ending units.
const RE_UNIT_NUM = /\b\d+(?:\.\d+)?\s?(?:ms|min|s|m|h|%)(?!\w)/gi;
// Bare integers of 2+ digits. Single digits are left alone on purpose — Planner
// review: "3개 후속 티켓" vs "4개 후속 티켓" should NOT normalize to the same
// text, preserving a genuinely distinguishing small count.
const RE_BARE_INT = /\b\d{2,}\b/g;
const RE_MD_DECORATION = /[*_`#>]+/g;

/** Pure text -> text masking step, exported so tests can pin the exact token substitutions independent of the similarity metric on top. */
export function maskDynamicTokens(content: string): string {
  let s = content || '';
  s = s.replace(RE_UUID, '<uuid>');
  s = s.replace(RE_LONG_HEX, '<sha>');
  s = s.replace(RE_SHORT_HEX, '<sha>');
  s = s.replace(RE_ISO_TS, '<ts>');
  s = s.replace(RE_UNIT_NUM, '<num>');
  s = s.replace(RE_BARE_INT, '<num>');
  return s;
}

/** Masked -> lowercase -> markdown-decoration-stripped -> whitespace-collapsed word tokens. */
export function normalizeForSimilarity(content: string): string[] {
  const masked = maskDynamicTokens(content);
  const stripped = masked.replace(RE_MD_DECORATION, ' ').toLowerCase();
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed.split(' ') : [];
}

/**
 * Word-set Jaccard similarity, [0,1]. Two comments that both go fully blank
 * after masking (e.g. two comments that were ONLY a sha/timestamp) are
 * treated as identical (1) rather than undefined-similarity — they read as
 * the same "content" post-normalization, which is exactly the near-duplicate
 * shape this signal exists to catch.
 */
export function jaccardSimilarity(aTokens: readonly string[], bTokens: readonly string[]): number {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// ───────────────────────── Input filter ─────────────────────────

/** Minimal comment shape the calculator needs — structurally compatible with the `Comment` entity, but this module takes no TypeORM/entity dependency (stays a pure, dependency-free calculator). */
export interface LoopScoreCommentInput {
  content: string;
  created_at: Date | number | string;
  author_type: string;
  author_id: string;
  type: string;
  operational_recurrence_key?: string | null;
}

/** `type:id` — callers build the `holderKeys` set with this same format from a ticket's resolved role-assignment holders (any type, agent or user). */
function holderKeyOf(c: { author_type: string; author_id: string }): string {
  return `${c.author_type}:${c.author_id}`;
}

/**
 * Three-rule input filter (Planner + Reviewer review, ticket 24df8677) — ALL
 * THREE are required, not just a type filter:
 *   (1) `type === 'system'` — SystemCommentService housekeeping rows.
 *   (2) `operational_recurrence_key != null` — existing operational-fallback
 *       recurrence marker (reused, not redefined).
 *   (3) author is not a CURRENT role-assignment holder on this ticket.
 *
 * Rule (3) is the load-bearing one, verified against real data on this exact
 * ticket: the dispatch-suppression note `ebe29c44` (this ticket's own
 * comment history) is `author_type='agent'`, `type='note'`,
 * `operational_recurrence_key=null` — rules (1) and (2) both MISS it. Only
 * (3) catches it, because its author (an infra/manager agent) holds none of
 * this ticket's roles (reporter/planner/assignee/reviewer). Without (3), a
 * recurring operational note like that would inflate S_content against
 * itself and the detector would trip on its own infrastructure chatter.
 */
export function isEligibleLoopScoreComment(
  comment: LoopScoreCommentInput,
  holderKeys: ReadonlySet<string>,
): boolean {
  if (comment.type === 'system') return false;
  if (comment.operational_recurrence_key != null) return false;
  if (!holderKeys.has(holderKeyOf(comment))) return false;
  return true;
}

// ───────────────────────── Score ─────────────────────────

export interface LoopScoreBreakdown {
  score: number;
  timing: number;
  content: number;
  alternation: number;
  /** Count of ELIGIBLE (post-filter) comments found — not capped to `window`. Explains a 0 score caused by a thin sample vs. a genuinely-low score. */
  commentCount: number;
  warn: boolean;
  trip: boolean;
}

const ZERO_BREAKDOWN = (commentCount: number): LoopScoreBreakdown => ({
  score: 0, timing: 0, content: 0, alternation: 0, commentCount, warn: false, trip: false,
});

/**
 * Pure loop-risk score over a ticket's comment sequence, oldest-first.
 *
 * Determinism (Planner + Reviewer review): no `now`/wall-clock input exists
 * anywhere in this function — every signal is derived ONLY from relative gaps
 * between the comments' own `created_at` values, so the same sequence
 * produces the same score no matter when it's evaluated, and there are no
 * side effects.
 *
 * `alternationScore` is the `07402c57` extension point: an OPTIONAL,
 * pre-normalized [0,1] author-alternation signal (e.g. derived from
 * `computeChainDepth` / `computeTicketCommentChainDepth`, capped and scaled
 * by the caller). Omitted or 0 by default — deliberately NOT wired to
 * `agent-chain-depth.ts` in this ticket (see file header); the weighted-sum
 * combinator with no re-normalization means an unwired alternation signal
 * caps the reachable score at 0.8 (still above TRIP=0.7), so this detector is
 * fully load-bearing on its own before that follow-up ticket wires anything
 * in — wiring it later only strengthens borderline cases, never changes the
 * combination formula.
 */
export function computeLoopScore(
  commentsAscending: readonly LoopScoreCommentInput[],
  holderKeys: ReadonlySet<string>,
  opts: { config?: LoopScoreConfig; alternationScore?: number } = {},
): LoopScoreBreakdown {
  const config = sanitizeConfig(opts.config ?? readConfigFromEnv());
  const alternation = clamp01(opts.alternationScore ?? 0);

  const filtered = commentsAscending.filter((c) => isEligibleLoopScoreComment(c, holderKeys));
  if (filtered.length < config.minComments) return ZERO_BREAKDOWN(filtered.length);

  const windowSize = Math.min(config.window, filtered.length);
  const windowSlice = filtered.slice(filtered.length - windowSize);

  const timestamps = windowSlice.map((c) => new Date(c.created_at).getTime());
  const tokensByIndex = windowSlice.map((c) => normalizeForSimilarity(c.content));

  // (b) Timing signal — fraction of ADJACENT gaps at/under FAST_GAP_MS.
  // Boundary convention (Planner + Reviewer review): equal counts as fast.
  let fastGapCount = 0;
  for (let i = 1; i < windowSize; i++) {
    if (timestamps[i] - timestamps[i - 1] <= config.fastGapMs) fastGapCount++;
  }
  const timing = fastGapCount / (windowSize - 1);

  // (c) Content signal — fraction of window members (excluding the first,
  // which has no earlier member to compare against) whose BEST match among
  // all earlier window members is at/over SIM_THRESHOLD. Compares against
  // every earlier member (not just the immediately-preceding one) so an
  // A-B-A-B alternating repeat is still caught even though the immediate
  // predecessor differs each time.
  let duplicateCount = 0;
  for (let i = 1; i < windowSize; i++) {
    let maxSim = 0;
    for (let j = 0; j < i; j++) {
      const sim = jaccardSimilarity(tokensByIndex[i], tokensByIndex[j]);
      if (sim > maxSim) maxSim = sim;
    }
    if (maxSim >= config.simThreshold) duplicateCount++;
  }
  const content = duplicateCount / (windowSize - 1);

  // (d) Weighted-sum combination, no re-normalization when alternation is
  // absent (see file header + docstring above for why).
  const score = clamp01(WEIGHT_TIMING * timing + WEIGHT_CONTENT * content + WEIGHT_ALTERNATION * alternation);

  return {
    score,
    timing,
    content,
    alternation,
    commentCount: filtered.length,
    warn: score >= config.warn,
    trip: score >= config.trip,
  };
}
