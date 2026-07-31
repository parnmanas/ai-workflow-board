// Unit test — terminal-aware system pend gate (ticket ec498050, root cause of
// ticket 0709ea7c: a Done ticket got auto-pended by a system guard that never
// checked terminal state).
//
// 무엇을 증명하나
// ───────────────
// 1. `evaluateTerminalPendGate` — 순수 predicate. DB·Nest 없이 dist 모듈만
//    임포트해 검증한다(common/consensus-state.ts / pend-action-gate.ts 선례).
//    3 케이스: terminal 컬럼 → 거부, non-terminal 컬럼 → 허용, 컬럼 미해결(null)
//    → 허용(fail-open).
// 2. `loadTicketColumnForPendGate` — DB 로더. 가벼운 fake repo(findOne 스텁)로
//    검증해 실 DataSource 없이도 subtask 부모-walk 로직을 고정한다.
//    케이스: 루트 티켓 직접 해결 / subtask가 부모의 컬럼으로 해결 / 컬럼도
//    부모도 없으면 null.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist', 'modules', 'mcp', 'shared', 'terminal-pend-gate.js');
const { evaluateTerminalPendGate, loadTicketColumnForPendGate } = await import('file://' + DIST);

// ── evaluateTerminalPendGate (pure, no DB) ──────────────────────────────────

test('terminal column (is_terminal=true) → pend BLOCKED', () => {
  const r = evaluateTerminalPendGate({ is_terminal: true, kind: 'active' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'ticket_already_terminal');
});

test('terminal column (kind="terminal") → pend BLOCKED, regardless of is_terminal', () => {
  const r = evaluateTerminalPendGate({ is_terminal: false, kind: 'terminal' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'ticket_already_terminal');
});

test('non-terminal column → pend ALLOWED', () => {
  const r = evaluateTerminalPendGate({ is_terminal: false, kind: 'active' });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, undefined);
});

test('unresolved column (null) → pend ALLOWED (fail-open — a lookup gap must never block a legitimate pend)', () => {
  assert.equal(evaluateTerminalPendGate(null).allowed, true);
  assert.equal(evaluateTerminalPendGate(undefined).allowed, true);
});

// ── loadTicketColumnForPendGate (DB loader, fake repos — no real DataSource) ─

function fakeRepos({ columns = {}, tickets = {} } = {}) {
  const ticketRepo = { async findOne({ where: { id } }) { return tickets[id] ?? null; } };
  const columnRepo = { async findOne({ where: { id } }) { return columns[id] ?? null; } };
  return { ticketRepo, columnRepo };
}

test('root ticket with column_id resolves directly (no parent walk)', async () => {
  const { ticketRepo, columnRepo } = fakeRepos({
    columns: { colA: { id: 'colA', kind: 'active', is_terminal: false } },
  });
  const col = await loadTicketColumnForPendGate(ticketRepo, columnRepo, { id: 't1', column_id: 'colA', parent_id: null });
  assert.deepEqual(col, { id: 'colA', kind: 'active', is_terminal: false });
});

test('subtask (column_id=null) walks up to the parent\'s column', async () => {
  const { ticketRepo, columnRepo } = fakeRepos({
    columns: { colDone: { id: 'colDone', kind: 'terminal', is_terminal: true } },
    tickets: { parent1: { id: 'parent1', column_id: 'colDone', parent_id: null } },
  });
  const col = await loadTicketColumnForPendGate(
    ticketRepo, columnRepo, { id: 'sub1', column_id: null, parent_id: 'parent1' },
  );
  assert.deepEqual(col, { id: 'colDone', kind: 'terminal', is_terminal: true });
});

test('no column_id and no parent_id → null (nothing to resolve)', async () => {
  const { ticketRepo, columnRepo } = fakeRepos();
  const col = await loadTicketColumnForPendGate(ticketRepo, columnRepo, { id: 't2', column_id: null, parent_id: null });
  assert.equal(col, null);
});

test('a broken parent chain (orphan row) resolves to null rather than throwing', async () => {
  const { ticketRepo, columnRepo } = fakeRepos({
    tickets: {}, // parent1 does not exist — findOne returns null, walk stops
  });
  const col = await loadTicketColumnForPendGate(
    ticketRepo, columnRepo, { id: 'sub2', column_id: null, parent_id: 'missing-parent' },
  );
  assert.equal(col, null);
});

test('walk is bounded (depth < 3) so a pathological cycle cannot loop forever', async () => {
  // A -> B -> C -> A cycle, none carrying column_id. The bound must stop the
  // walk rather than spin — resolves to null (fail-open for the caller).
  const { ticketRepo, columnRepo } = fakeRepos({
    tickets: {
      a: { id: 'a', column_id: null, parent_id: 'b' },
      b: { id: 'b', column_id: null, parent_id: 'c' },
      c: { id: 'c', column_id: null, parent_id: 'a' },
    },
  });
  const col = await loadTicketColumnForPendGate(ticketRepo, columnRepo, { id: 'start', column_id: null, parent_id: 'a' });
  assert.equal(col, null);
});
