// Hard-budget dispatch-window gate — call-site/ordering guard (ticket a940d75b).
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
  const match = src.match(/private async _checkHardBudgetGate\([\s\S]*?\n  \}\n/);
  assert.ok(match, 'could not isolate the _checkHardBudgetGate method body');
  const body = match[0];
  assert.match(body, /triggerSource === 'manual'/, 'must exempt manual triggers');
  assert.match(body, /triggerSource === 'comment_summary'/, 'must exempt comment_summary triggers');
});
