// Pending-user-action gate — last-moment re-check before the SSE emit
// (ticket be934f61, TOCTOU race investigated by f0d12d48 / TXIV 1e8b8e36).
//
// TriggerLoopService._emitTrigger already re-read the ticket fresh
// (`freshForGate`) right after the archived-ticket gate — but a dozen-plus
// further `await`s (agent/role lookup, base-repo/column-prompt/harness/
// effort/environment resolution, board-lessons injection, chain-target
// lookup) separated that check from the actual
// `activityEvents.emit('agent_trigger', ...)`. A pend_ticket() landing
// inside that window was invisible to the early check and the trigger still
// fired.
//
// The fix extracts the fresh-read + drop + audit-log logic into
// `_checkPendingUserGate` and calls it TWICE: once at the original position
// (an early drop that also skips the harness/effort/env resolution for an
// already-pending ticket) and once more immediately before the emit, with
// nothing awaited in between.
//
// `_emitTrigger` has 8 injected NestJS dependencies and touches ~10
// repositories before it reaches the emit — not cheaply bootable in
// isolation. This is a structural/static guard over the compiled TypeScript
// source, the same tradeoff (and the same technique) documented in
// board-lessons-dispatch.test.mjs: assert the call sites and their exact
// position relative to the emit, so a refactor that silently re-opens the
// window fails this test immediately.

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
const CALL_RE = /await this\._checkPendingUserGate\(/g;

test('_checkPendingUserGate helper exists and centralizes the drop-action logic (no per-call-site duplication)', () => {
  const src = code(SRC_PATH);
  assert.match(src, /private async _checkPendingUserGate\(/, '_checkPendingUserGate helper must exist');

  // Before the fix this literal was inlined once, at the single original
  // call site. After extraction it must live ONLY inside the helper — if a
  // future edit re-inlines the gate at a call site instead of calling the
  // helper, this count goes to 2+ and catches it.
  const dropActionMentions = (src.match(/'agent_trigger_dropped_pending_user'/g) || []).length;
  assert.equal(dropActionMentions, 1, 'the pending_user drop action string must appear exactly once (inside the helper)');
});

test('_checkPendingUserGate is called exactly twice in _emitTrigger: once early, once right before the SSE emit', () => {
  const src = code(SRC_PATH);
  const callSites = [...src.matchAll(CALL_RE)];
  assert.equal(callSites.length, 2, `expected 2 call sites (early gate + last-moment recheck), found ${callSites.length}`);

  const emitIdx = src.indexOf(EMIT_MARKER);
  assert.ok(emitIdx > -1, 'agent_trigger SSE emit call must exist');

  const [firstCallIdx, secondCallIdx] = callSites.map((m) => m.index);
  assert.ok(firstCallIdx < secondCallIdx, 'call sites must appear in source order (early gate before last-moment recheck)');
  assert.ok(secondCallIdx < emitIdx, 'the last-moment recheck must precede the SSE emit');
});

test('last-moment 재확인 성공 경로에는 SSE emit 전 추가 await가 없다', () => {
  const src = code(SRC_PATH);
  const callSites = [...src.matchAll(CALL_RE)];
  const emitIdx = src.indexOf(EMIT_MARKER);
  const lastGateIdx = callSites[callSites.length - 1].index;

  const between = src.slice(lastGateIdx, emitIdx);
  // late-pending 드롭 분기는 선저장 trigger_emitted를 지우기 위해 await할 수
  // 있다. 다만 조건문을 통과한 성공 경로에는 emit 전 추가 await가 없어야
  // 하므로, cleanup 분기 뒤의 꼬리만 검사한다.
  const dropReturnIdx = between.indexOf("return '';");
  assert.ok(dropReturnIdx > -1, 'late-pending 드롭 분기가 있어야 한다');
  const successfulTail = between.slice(dropReturnIdx + "return '';".length);
  assert.doesNotMatch(successfulTail, /\bawait\b/,
    'late-pending 검사를 통과한 성공 경로는 추가 비동기 창 없이 바로 emit해야 한다');
});

test('_checkPendingUserGate short-circuits on an explicit bypass before touching the DB', () => {
  const src = code(SRC_PATH);
  assert.match(
    src,
    /if \(bypassTicketPending\) return false;/,
    'bypassTicketPending must short-circuit ahead of the fresh DB read, so exempt dispatches (e.g. comment_summary) take no extra query',
  );
});

test('both call sites forward opts?.bypassTicketPending unchanged', () => {
  const src = code(SRC_PATH);
  const callSites = [...src.matchAll(/await this\._checkPendingUserGate\(([^)]*)\)/g)];
  assert.equal(callSites.length, 2);
  for (const m of callSites) {
    assert.match(
      m[1],
      /opts\?\.bypassTicketPending/,
      `each call site must forward opts?.bypassTicketPending so exempt dispatch sources (emitCommentSummaryTrigger) stay exempt at BOTH checkpoints: ${m[0]}`,
    );
  }
});
