// 단위 테스트 — error-log-uploader classify() (ticket 04d22ec0).
//
// uploader 는 agent-manager.log 를 스캔해 classify() 가 에러로 표시한 것을 AWB 로
// POST 하고, 이는 매니저의 last_error_upload_at 을 갱신한다. 기존 catch-all
// /error|failed/i 가 멀쩡한 라인 — 정상 턴의 "result subtype=success is_error=false",
// 정상 재시작의 "restart_all_agents → 4 restarted, 0 failed" — 을 에러로 오분류해
// 매니저가 영구 DEGRADED 배지에 고정됐다. 이 테스트들은 구조화된 성공/제로카운트
// 신호는 skip 하고 실제 실패는 계속 분류됨을 고정한다.
//
// 아래 문자열은 LINE_RE 가 "[iso] [pid=N]" prefix 를 벗겨낸 뒤의 메시지 —
// 즉 classify() 가 실제로 받는 값이다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify } from '../dist/lib/error-log-uploader.js';

// ── 성공 로그 (is_error=false / subtype=success) → skip ─────────────────
test('clean subagent result (subtype=success is_error=false) → skipped', () => {
  // base-session-manager.ts:837 — the line that was permanently marking DEGRADED.
  assert.equal(classify('[claude:5678] result subtype=success is_error=false'), null);
});

test('success flag alone (subtype=success is_error=-) → skipped', () => {
  // Non-claude CLI: is_error unknown ("-") but subtype says success.
  assert.equal(classify('[codex:42] result subtype=success is_error=-'), null);
});

test('is_error=false alone (subtype=-) → skipped', () => {
  assert.equal(classify('[gemini:9] result subtype=- is_error=false'), null);
});

// ── 재시작 로그 (0 failed) → skip ────────────────────────────────────────
test('restart summary with 0 failed → skipped', () => {
  // agent-manager-commands.ts:208 → 723 — the other DEGRADED-pinning line.
  assert.equal(
    classify(
      'agent_manager_command restart_all_agents id=abc123 → restart_all_agents → 4 restarted, 0 failed',
    ),
    null,
  );
});

test('restart no-op (0 failed edge) → skipped', () => {
  assert.equal(classify('restart_all_agents → 0 restarted, 0 failed'), null);
});

// ── 실제 에러 로그 (is_error=true / subtype=error) → classified ──────────
test('subagent error (is_error=true) → error/subagent', () => {
  assert.deepEqual(classify('[claude:5678] result subtype=error is_error=true'), {
    level: 'error',
    category: 'subagent',
  });
});

test('subagent error (subtype=error, is_error unknown) → error/subagent', () => {
  assert.deepEqual(classify('[claude:5678] result subtype=error is_error=-'), {
    level: 'error',
    category: 'subagent',
  });
});

// ── 실제 재시작 실패 (N failed, N>0) → 여전히 카운트 ─────────────────────
test('restart summary with 2 failed → classified (warn/misc)', () => {
  const r = classify(
    'agent_manager_command restart_all_agents id=abc → restart_all_agents → 2 restarted, 2 failed (failed: ab12, cd34)',
  );
  assert.ok(r, 'a real restart failure must not be skipped');
  assert.equal(r.level, 'warn');
});

test('per-agent restart FAILED line → classified', () => {
  const r = classify('restart_all_agents: agent=ab12ef34 FAILED: spawn ETIMEDOUT');
  assert.ok(r, 'a per-agent restart failure must not be skipped');
});

test('word boundary: "10 failed" is NOT the "0 failed" skip case → classified', () => {
  // Regression guard for the \b0 boundary: 10 failed is a real failure, the
  // trailing "...0 failed" substring must not suppress it.
  const r = classify('restart_all_agents → 0 restarted, 10 failed (failed: a, b)');
  assert.ok(r, '10 failed must classify as an error, not be swallowed by the 0-count skip');
  assert.equal(r.level, 'warn');
});

// ── 값자리 0 / 혼합 카운트 오매치 회귀 (리뷰 지적, 04d22ec0) ──────────────
// 성공 신호가 라인 어딘가 있다는 이유로 같은 라인의 nonzero 실패를 삼키면 안 된다.
test('update_plugins with failed=2 (preceded by skipped=0) → classified, NOT skipped', () => {
  // agent-manager-commands.ts:822-824 실측 형식. "skipped=0 failed=2" 의 "0 failed"
  // 부분문자열이 실패 2건을 드롭시키던 회귀. failed=2 는 nonzero → 반드시 분류.
  const r = classify(
    'agent_manager_command update_plugins id=xyz → update_plugins ok: agent=ab12ef34 updated=1 skipped=0 failed=2 — first error: ENOSPC',
  );
  assert.ok(r, 'update_plugins failed=2 must not be swallowed by the skipped=0 "0 failed" substring');
  assert.equal(r.level, 'warn');
});

test('mixed counts "3 failed, 0 errors" → classified (0-count must not whitelist the line)', () => {
  const r = classify('some_command → 3 failed, 0 errors');
  assert.ok(r, '3 failed is a real failure; the trailing "0 errors" must not skip the line');
  assert.equal(r.level, 'warn');
});

test('update_plugins failed=0 success stays flagged (기존 동작 — 스코프 밖 오탐, drop 아님)', () => {
  // 값자리 "failed=0" 는 "0 failed"(공백 앞) 가 아니라 성공신호로 안 잡히고,
  // catch-all 로 warn 처리된다(수정 전과 동일한 오탐). update_plugins 는 per-turn
  // 이 아니라 DEGRADED 재유발 없음 → 스코프 밖. 여기서 검증하는 핵심은 "실제
  // 실패를 드롭하지 않는다" 이지 이 오탐을 없애는 게 아니다.
  const r = classify(
    'agent_manager_command update_plugins id=xyz → update_plugins ok: agent=ab12ef34 updated=1 skipped=0 failed=0',
  );
  assert.ok(r, 'failed=0 update_plugins stays classified (pre-existing behavior, not dropped)');
});

// ── 기존 specific 규칙 회귀 (unchanged) ──────────────────────────────────
test('specific error rules still fire', () => {
  assert.deepEqual(classify('Uncaught error: boom'), { level: 'fatal', category: 'crash' });
  assert.deepEqual(classify('EXIT code=1 child died'), { level: 'fatal', category: 'crash' });
  assert.deepEqual(classify('SSE error: connection reset'), { level: 'error', category: 'sse' });
  assert.deepEqual(classify('Presence ping failed: HTTP 500'), {
    level: 'error',
    category: 'presence',
  });
  assert.deepEqual(classify('stdout error: broken pipe'), { level: 'error', category: 'ipc' });
});

test('uploader / DIAG / claude-bin traces are skipped', () => {
  assert.equal(classify('[uploader] uploaded 3 entries (errors=0 events=3)'), null);
  assert.equal(classify('[DIAG] heartbeat ok'), null);
  assert.equal(classify('[claude-bin] resolved path /usr/bin/claude'), null);
});

// ── catch-all: 구조화되지 않은 진짜 에러성 라인은 여전히 잡힘 ───────────
test('unstructured error-ish lines still caught by catch-all', () => {
  assert.deepEqual(classify('Trigger dispatch failed: timeout'), {
    level: 'warn',
    category: 'misc',
  });
  assert.deepEqual(classify('marker write failed: ENOSPC'), { level: 'warn', category: 'misc' });
});

test('plain healthy noise (no error/failed) is skipped', () => {
  assert.equal(classify('SSE connected'), null);
  assert.equal(classify('[claude:5678] assistant: editing foo.ts'), null);
});
