// Hard-budget window gate — call-site/ordering guard (ticket a940d75b;
// extended with a token-sum ceiling by ticket ef53fdf4). Both the dispatch-
// count and token-sum ceilings live in the SAME `_checkHardBudgetGate`
// method/call site, so every ordering assertion below covers both.
//
// `_emitTrigger` has 9 injected NestJS dependencies and touches ~10
// repositories before it reaches the emit — not cheaply bootable in
// isolation (same tradeoff `pending-gate-recheck.test.mjs` and
// `board-lessons-dispatch.test.mjs` document). This is a structural/static
// guard over the compiled TypeScript source: it asserts `_checkHardBudgetGate`
// exists, is called EXACTLY ONCE, and sits AFTER the early
// `_checkPendingUserGate` call but BEFORE both the focus-window gate and the
// `agent_trigger` SSE emit — so a refactor that drops the gate, duplicates
// it, or reorders it past the point where a budget-exceeding ticket could
// still consume a focus-window slot fails this test immediately.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
function code(relPath) {
  return stripComments(fs.readFileSync(path.join(ROOT, 'src', relPath), 'utf8'));
}

const SRC_PATH = 'modules/agents/trigger-loop.service.ts';
const EMIT_MARKER = "activityEvents.emit('agent_trigger'";
const EARLY_PENDING_CALL_RE = /await this\._checkPendingUserGate\(/g;
// Code-level anchor (not a comment) for where the focus-window gate begins —
// stripComments() removes the `// Focus-window gate` prose header above it.
const FOCUS_WINDOW_MARKER = 'if (!opts?.bypassFocus && boardId)';
const HARD_BUDGET_CALL_RE = /await this\._checkHardBudgetGate\(/g;

test('_checkHardBudgetGate helper exists and centralizes the drop-action logic', () => {
  const src = code(SRC_PATH);
  assert.match(src, /private async _checkHardBudgetGate\(/, '_checkHardBudgetGate helper must exist');

  const dropActionMentions = (src.match(/'agent_trigger_dropped_hard_budget'/g) || []).length;
  assert.equal(dropActionMentions, 1, 'the hard-budget drop action string must appear exactly once (inside the helper)');
});

test('_checkHardBudgetGate is called exactly once, after the early pending gate and before both the focus-window gate and the SSE emit', () => {
  const src = code(SRC_PATH);

  const hardBudgetCalls = [...src.matchAll(HARD_BUDGET_CALL_RE)];
  assert.equal(hardBudgetCalls.length, 1, `expected exactly 1 call site, found ${hardBudgetCalls.length}`);

  const earlyPendingCalls = [...src.matchAll(EARLY_PENDING_CALL_RE)];
  assert.ok(earlyPendingCalls.length >= 1, '_checkPendingUserGate must still be called');
  const firstPendingIdx = earlyPendingCalls[0].index;

  const focusWindowIdx = src.indexOf(FOCUS_WINDOW_MARKER);
  const emitIdx = src.indexOf(EMIT_MARKER);
  assert.ok(focusWindowIdx > -1, 'focus-window gate must exist');
  assert.ok(emitIdx > -1, 'agent_trigger SSE emit call must exist');

  const hardBudgetIdx = hardBudgetCalls[0].index;
  assert.ok(firstPendingIdx < hardBudgetIdx, 'hard-budget gate must run after the early pending gate (both are "hard" ticket-state gates)');
  assert.ok(hardBudgetIdx < focusWindowIdx, 'hard-budget gate must run BEFORE the focus-window gate — an over-budget ticket must not consume a focus slot');
  assert.ok(hardBudgetIdx < emitIdx, 'hard-budget gate must precede the SSE emit');
});

test('_checkHardBudgetGate exempts manual and comment_summary trigger sources (matches countWindowDispatches\' own exclusion)', () => {
  const src = code(SRC_PATH);
  const match = src.match(/private async _checkHardBudgetGate\([\s\S]*?\r?\n  \}\r?\n/);
  assert.ok(match, 'could not isolate the _checkHardBudgetGate method body');
  const body = match[0];
  assert.match(body, /triggerSource === 'manual'/, 'must exempt manual triggers');
  assert.match(body, /triggerSource === 'comment_summary'/, 'must exempt comment_summary triggers');
});

// ── Token ceiling (ticket ef53fdf4) — shares _checkHardBudgetGate/its call
// site with the dispatch ceiling above, so it inherits every ordering
// guarantee already asserted (single call site, after pending gate, before
// focus-window gate and SSE emit). These assertions cover what's NEW: the
// token check itself exists, and its breach action string is independently
// grep-able (distinct from, and not a duplicate of, the dispatch one).
test('_checkHardBudgetGate also enforces a token-sum ceiling via countWindowTokens', () => {
  const src = code(SRC_PATH);
  const match = src.match(/private async _checkHardBudgetGate\([\s\S]*?\r?\n  \}\r?\n/);
  assert.ok(match, 'could not isolate the _checkHardBudgetGate method body');
  const body = match[0];
  assert.match(body, /countWindowTokens\(/, '_checkHardBudgetGate must call countWindowTokens');
  assert.match(body, /cfg\.maxTokensPerWindow/, '_checkHardBudgetGate must compare against cfg.maxTokensPerWindow');
});

test('the token hard-budget drop action string appears exactly once and is distinct from the dispatch one', () => {
  const src = code(SRC_PATH);
  const tokenDropMentions = (src.match(/'agent_trigger_dropped_hard_budget_tokens'/g) || []).length;
  assert.equal(tokenDropMentions, 1, 'the token hard-budget drop action string must appear exactly once');

  const dispatchDropMentions = (src.match(/'agent_trigger_dropped_hard_budget'/g) || []).length;
  assert.equal(dispatchDropMentions, 1, 'adding the token ceiling must not duplicate the dispatch drop action string');
});

// ── trigger_source breakdown (ticket 3c8b8026 acceptance #5) ───────────────
// A human clearing a hard-budget auto-pend needs to tell "one source stormed"
// (e.g. a comment self-echo loop) from "many roles were legitimately busy" at
// a glance. `_checkHardBudgetGate` only has the breach confirmed AFTER the
// scalar `countWindowDispatches` call trips — the breakdown query must run in
// that same (rare, already-breaching) branch, never on every dispatch's
// happy path, and its result must actually reach both the pend reason and the
// chat alert `_tripHardBudgetGate` composes.

test('the dispatch-breach branch fetches the trigger_source breakdown via countWindowDispatchesBySource', () => {
  const src = code(SRC_PATH);
  const match = src.match(/private async _checkHardBudgetGate\([\s\S]*?\r?\n  \}\r?\n/);
  assert.ok(match, 'could not isolate the _checkHardBudgetGate method body');
  const body = match[0];
  assert.match(body, /countWindowDispatchesBySource\(/, '_checkHardBudgetGate must call countWindowDispatchesBySource');

  // Must be called strictly AFTER the scalar dispatchCount breach check —
  // never unconditionally on every dispatch (that would run an extra grouped
  // query on the hot path for every single trigger, breach or not).
  const scalarIdx = body.indexOf('dispatchCount >= cfg.maxDispatchesPerWindow');
  const bySourceIdx = body.indexOf('countWindowDispatchesBySource(');
  assert.ok(scalarIdx > -1 && bySourceIdx > -1 && scalarIdx < bySourceIdx,
    'the breakdown query must run inside the already-breached branch, not unconditionally');
});

test('_tripHardBudgetGate wires bySource into both the pend reason and the chat alert for a dispatch breach', () => {
  const src = code(SRC_PATH);
  const match = src.match(/private async _tripHardBudgetGate\([\s\S]*?\r?\n  \}\r?\n/);
  assert.ok(match, 'could not isolate the _tripHardBudgetGate method body');
  const body = match[0];
  assert.match(body, /bySource/, '_tripHardBudgetGate must accept/use the bySource breakdown');
  assert.match(body, /sourceBreakdown/, 'must format the breakdown into a display string');

  // The formatted breakdown must actually be spliced into BOTH surfaces a
  // human reads after an auto-pend — the ticket's pending_reason (User tab)
  // and the chat alert — not computed and then dropped on the floor.
  const reasonIdx = body.indexOf('const reason =');
  const sourceLineDeclIdx = body.indexOf('const sourceLine =');
  assert.ok(sourceLineDeclIdx > -1 && reasonIdx > -1 && sourceLineDeclIdx < reasonIdx,
    'sourceLine must be computed before it is spliced into `reason`');
  assert.match(body.slice(reasonIdx), /\$\{sourceLine\}/, 'the pend reason string must interpolate sourceLine');
  assert.match(body, /sourceBreakdown \? \[`출처 분포: \$\{sourceBreakdown\}`\] : \[\]/,
    'the chat alert body array must conditionally include the same breakdown');
});
