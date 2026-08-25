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

test('_checkHardBudgetGate는 쌍둥이 억제된 emit을 실제 dispatch 수에서 제외한다', () => {
  const src = code(SRC_PATH);
  const match = src.match(/private async _checkHardBudgetGate\([\s\S]*?\r?\n  \}\r?\n/);
  assert.ok(match, '_checkHardBudgetGate 메서드 본문을 찾을 수 있어야 한다');
  const body = match[0];
  assert.match(body, /countTwinSuppressions\(/, '쌍둥이 억제 발생 수를 조회해야 한다');
  assert.match(body, /Math\.max\(0, emittedDispatchCount - suppressedDispatchCount\)/,
    '상한 판정 수는 원시 emit에서 억제 수를 빼고 음수를 막아야 한다');
  assert.match(body, /dispatchCount >= cfg\.maxDispatchesPerWindow/,
    '차감된 수를 상한과 비교해야 한다');
});

test('trigger 상관 activity는 SSE보다 먼저 저장되고 저장 실패는 fail-closed다', () => {
  const src = code(SRC_PATH);
  const saveIdx = src.indexOf('await activityLogRepo.save(activityLogRepo.create({');
  const emitIdx = src.indexOf(EMIT_MARKER);
  assert.ok(saveIdx > -1, 'trigger_emitted 상관 activity 저장이 있어야 한다');
  assert.ok(saveIdx < emitIdx, '즉시 억제 ACK도 상관되도록 activity 저장이 SSE보다 먼저여야 한다');
  assert.match(src, /TRIGGER_CORRELATION_PERSIST_FAILED/,
    '상관 activity 저장 실패 시 SSE를 보내지 않는 fail-closed 오류 계약이 있어야 한다');
});

test('late pending 드롭은 선저장 trigger_emitted 상관 행을 제거한다', () => {
  const src = code(SRC_PATH);
  const lateGateIdx = src.lastIndexOf('await this._checkPendingUserGate(');
  const emitIdx = src.indexOf(EMIT_MARKER);
  assert.ok(lateGateIdx > -1 && lateGateIdx < emitIdx, 'late pending 재확인은 SSE 직전에 있어야 한다');
  const lateGateBody = src.slice(lateGateIdx, emitIdx);
  assert.match(lateGateBody, /await activityLogRepo\.delete\(triggerCorrelation\.id\)/,
    '실제 SSE emit 없이 드롭할 때 선저장 trigger_emitted 행을 정확한 PK로 제거해야 한다');
  assert.ok(lateGateBody.indexOf('activityLogRepo.delete') < lateGateBody.indexOf("return ''"),
    '상관 행 제거를 마친 뒤에만 late-pending 드롭을 반환해야 한다');
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

// ── trigger_source 분포 (ticket 3c8b8026 성공 기준 5) ─────────────────────
// hard-budget 자동 pend를 해제할 사람은 한 출처의 폭주와 여러 역할의 정상
// 활동을 구분할 수 있어야 한다. 분포 조회는 상한 초과가 확정된 드문 분기에서만
// 실행하며, 결과는 pending 사유와 채팅 알림 양쪽에 전달해야 한다.

test('the dispatch-breach branch fetches the trigger_source breakdown via countWindowDispatchesBySource', () => {
  const src = code(SRC_PATH);
  const match = src.match(/private async _checkHardBudgetGate\([\s\S]*?\r?\n  \}\r?\n/);
  assert.ok(match, 'could not isolate the _checkHardBudgetGate method body');
  const body = match[0];
  assert.match(body, /countWindowDispatchesBySource\(/, '_checkHardBudgetGate must call countWindowDispatchesBySource');

  // 분포 조회는 dispatchCount 상한 검사 뒤에만 실행해야 한다. 모든 트리거의
  // 핫패스에서 무조건 그룹 쿼리를 실행하면 안 된다.
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

  // 포맷한 분포는 자동 pend 뒤 사람이 보는 pending_reason과 채팅 알림 양쪽에
  // 실제로 포함되어야 한다.
  const reasonIdx = body.indexOf('const reason =');
  const sourceLineDeclIdx = body.indexOf('const sourceLine =');
  assert.ok(sourceLineDeclIdx > -1 && reasonIdx > -1 && sourceLineDeclIdx < reasonIdx,
    'sourceLine must be computed before it is spliced into `reason`');
  assert.match(body.slice(reasonIdx), /\$\{sourceLine\}/, 'the pend reason string must interpolate sourceLine');
  assert.match(body, /sourceBreakdown \? \[`출처 분포: \$\{sourceBreakdown\}`\] : \[\]/,
    'the chat alert body array must conditionally include the same breakdown');
});
