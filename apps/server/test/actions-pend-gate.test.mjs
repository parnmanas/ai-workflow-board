// Unit test — pend_ticket Action 게이트 판정 (`evaluatePendActionGate`), 티켓 524bb434.
//
// 무엇을 증명하나
// ───────────────
// 에이전트가 배포 등 자동화 가능한 작업을 이유로 곧장 Pending 하지 못하게 하는
// 순수 판정 로직을 고정한다. DB·Nest 없이 dist 모듈만 임포트해 검증한다
// (common/consensus-state.ts 선례).
//
// 케이스:
//   1. 스코프 내 실행 가능한 Action 이 없으면 → pend 허용(강제할 게 없음).
//   2. 실행 가능한 Action 이 있는데 no_action_reason 없음 → pend 거부 + 후보 목록/
//      다음 절차(run_action / save_action / no_action_reason) 안내.
//   3. **사람 개입 필요 케이스** — 실행 가능한 Action 이 있어도 no_action_reason 을
//      주면 → pend 허용(사람의 판단·자격증명·승인이 반드시 필요한 경우).
//   4. 공백만 있는 no_action_reason 은 게이트를 통과시키지 않는다.
//   5. 후보 목록은 20개 초과 시 잘라내고 나머지 개수를 표기한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist', 'modules', 'mcp', 'shared', 'pend-action-gate.js');
const { evaluatePendActionGate, formatPendActionCandidates } = await import('file://' + DIST);

const candidate = (over = {}) => ({
  id: 'a1',
  name: 'Deploy',
  description: 'ships prod',
  target_agent_id: 'ag1',
  board_id: null,
  ...over,
});

test('no runnable Actions → pend allowed (nothing to force)', () => {
  const r = evaluatePendActionGate([], undefined);
  assert.equal(r.allowed, true);
  assert.equal(r.candidateCount, 0);
  assert.equal(r.message, undefined);
});

test('runnable Action present + no no_action_reason → pend BLOCKED with candidate list + next steps', () => {
  const r = evaluatePendActionGate(
    [candidate({ name: 'Merge To Production.Private and PUSH', description: 'deploy main → production.private' })],
    undefined,
  );
  assert.equal(r.allowed, false);
  assert.equal(r.candidateCount, 1);
  // The message must name the candidate so the agent can act on it immediately…
  assert.match(r.message, /Merge To Production\.Private and PUSH/);
  // …and point at the concrete tools + the escape hatch.
  assert.match(r.message, /run_action/);
  assert.match(r.message, /save_action/);
  assert.match(r.message, /no_action_reason/);
});

test('human-intervention case: runnable Action present but no_action_reason supplied → pend allowed', () => {
  const r = evaluatePendActionGate(
    [candidate()],
    'prod approval needs a human signer — no Action covers the sign-off',
  );
  assert.equal(r.allowed, true);
  // Still counted so the pend handler can audit that it parked past N Actions.
  assert.equal(r.candidateCount, 1);
  assert.equal(r.message, undefined);
});

test('whitespace-only no_action_reason does NOT satisfy the gate', () => {
  const r = evaluatePendActionGate([candidate()], '   \n  ');
  assert.equal(r.allowed, false);
  assert.match(r.message, /no_action_reason/);
});

test('multiple candidates are all reflected in the count', () => {
  const r = evaluatePendActionGate(
    [candidate({ id: 'a1', name: 'A' }), candidate({ id: 'a2', name: 'B', board_id: 'b1' })],
    undefined,
  );
  assert.equal(r.allowed, false);
  assert.equal(r.candidateCount, 2);
  assert.match(r.message, /\bA\b/);
  assert.match(r.message, /\bB\b/);
  // board-scope candidate is annotated as such
  assert.match(r.message, /scope: board/);
  assert.match(r.message, /scope: workspace/);
});

test('formatPendActionCandidates truncates beyond 20 and notes the remainder', () => {
  const many = Array.from({ length: 25 }, (_, i) => candidate({ id: 'a' + i, name: 'Act' + i }));
  const s = formatPendActionCandidates(many);
  assert.match(s, /and 5 more/);
  // Only the first 20 lines + the "…and N more" line.
  assert.equal(s.split('\n').length, 21);
});
