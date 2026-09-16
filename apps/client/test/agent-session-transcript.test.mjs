// Agent Session(CLI 직접 세션) 트랜스크립트/목록 순수 로직 회귀 테스트.
// 실행: node --import tsx --test apps/client/test/agent-session-transcript.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTranscript,
  canPrompt,
  describeSessionStatus,
  hasSeqGap,
  mergeIncomingEvent,
  pendingPermission,
  sessionDisplayTitle,
} from '../src/components/sessions/sessionTranscript.logic.ts';
import { applySessionUpdate, sortSessionsByActivity } from '../src/components/sessions/sessionList.logic.ts';

let seq = 0;
function ev(type, payload, turn_id = 't1') {
  seq += 1;
  return { id: `e${seq}`, seq, turn_id, type, payload, created_at: `2026-09-17T00:00:${String(seq).padStart(2, '0')}.000Z` };
}

test('buildTranscript merges streamed text chunks per turn and folds tool updates / permission decisions', () => {
  seq = 0;
  const events = [
    ev('user_prompt', { text: 'run tests' }),
    ev('turn', { phase: 'started' }),
    ev('reasoning', { text: 'let me ' }),
    ev('reasoning', { text: 'think' }),
    ev('text', { text: 'Run' }),
    ev('text', { text: 'ning tests' }),
    ev('tool_call', { tool_call_id: 'c1', title: 'Bash', kind: 'execute', input: { cmd: 'npm test' } }),
    ev('permission_request', { request_id: 'p1', tool_call_id: 'c1', title: 'Run npm test', options: [{ option_id: 'a', name: 'Allow', kind: 'allow_once' }, { option_id: 'd', name: 'Deny', kind: 'reject_once' }] }),
    ev('permission_decision', { request_id: 'p1', outcome: 'selected', option_id: 'a', decided_by: 'user' }),
    ev('tool_update', { tool_call_id: 'c1', status: 'completed', output: 'ok' }),
    ev('text', { text: ' done' }),
    ev('usage', { input_tokens: 10, output_tokens: 5, total_tokens: 15 }),
    ev('turn', { phase: 'finished', stop_reason: 'end_turn' }),
  ];
  const blocks = buildTranscript(events);
  assert.deepEqual(blocks.map((b) => b.kind), ['prompt', 'reasoning', 'assistant', 'tool', 'permission', 'assistant', 'usage']);
  assert.equal(blocks[1].text, 'let me think');
  assert.equal(blocks[2].text, 'Running tests', 'consecutive chunks merge');
  assert.equal(blocks[3].status, 'completed');
  assert.equal(blocks[3].output, 'ok');
  assert.equal(blocks[4].decision.option_id, 'a');
  assert.equal(blocks[4].decision.decided_by, 'user');
  assert.equal(blocks[5].text, ' done', 'text after a tool call starts a new assistant block');
  assert.equal(pendingPermission(blocks), null, 'decided permission is not pending');
  assert.ok(!blocks.some((b) => b.kind === 'turn'), 'end_turn is not rendered');
});

test('buildTranscript keeps non-end_turn turn ends, errors and system notes; pending permission is detected', () => {
  seq = 0;
  const events = [
    ev('user_prompt', { text: 'go' }),
    ev('permission_request', { request_id: 'p2', tool_call_id: 'c2', title: 'Edit file', options: [{ option_id: 'a', name: 'Allow', kind: 'allow_always' }] }),
    ev('error', { message: 'boom', code: 'acp_timeout' }),
    ev('turn', { phase: 'finished', stop_reason: 'cancelled' }),
    ev('system', { text: 'Agent process exited (code 1).' }),
  ];
  const blocks = buildTranscript(events);
  assert.deepEqual(blocks.map((b) => b.kind), ['prompt', 'permission', 'error', 'turn', 'system']);
  assert.equal(pendingPermission(blocks)?.requestId, 'p2');
  assert.equal(blocks[2].code, 'acp_timeout');
  assert.equal(blocks[3].stopReason, 'cancelled');
});

test('text chunks from different turns never merge', () => {
  seq = 0;
  const blocks = buildTranscript([ev('text', { text: 'a' }, 't1'), ev('text', { text: 'b' }, 't2')]);
  assert.equal(blocks.length, 2);
});

test('mergeIncomingEvent appends in seq order, ignores duplicates, and hasSeqGap detects loss', () => {
  const base = [{ id: 'a', seq: 1, turn_id: '', type: 'system', payload: {}, created_at: '' }];
  const withTwo = mergeIncomingEvent(base, { id: 'b', seq: 2, turn_id: '', type: 'system', payload: {}, created_at: '' });
  assert.equal(withTwo.length, 2);
  assert.equal(mergeIncomingEvent(withTwo, { id: 'b', seq: 2, turn_id: '', type: 'system', payload: {}, created_at: '' }), withTwo, 'duplicate id is a no-op');
  const outOfOrder = mergeIncomingEvent(mergeIncomingEvent(base, { id: 'd', seq: 4, turn_id: '', type: 'system', payload: {}, created_at: '' }), { id: 'c', seq: 3, turn_id: '', type: 'system', payload: {}, created_at: '' });
  assert.deepEqual(outOfOrder.map((e) => e.seq), [1, 3, 4]);
  assert.equal(hasSeqGap(outOfOrder), true);
  assert.equal(hasSeqGap(withTwo), false);
});

test('status helpers mirror the server prompt rules', () => {
  assert.equal(canPrompt('ready'), true);
  assert.equal(canPrompt('suspended'), true, 'a suspended session reopens on prompt');
  assert.equal(canPrompt('error'), true);
  assert.equal(canPrompt('busy'), false);
  assert.equal(canPrompt('awaiting_permission'), false);
  assert.equal(canPrompt('closed'), false);
  assert.equal(describeSessionStatus('awaiting_permission').tone, 'warning');
  assert.equal(describeSessionStatus('closed').live, false);
  assert.equal(sessionDisplayTitle({ title: '', agent_name: 'ralf/coder', runtime: 'claude' }), 'ralf/coder · claude');
  assert.equal(sessionDisplayTitle({ title: 'Fix login', agent_name: 'ralf/coder', runtime: 'claude' }), 'Fix login');
});

test('session list: SSE update upserts, deletes, and keeps most-recent-activity order', () => {
  const s = (id, last) => ({ id, workspace_id: 'ws', last_activity_at: last, updated_at: last, created_at: last, status: 'ready', title: id, agent_name: 'a', runtime: 'claude' });
  const sorted = sortSessionsByActivity([s('old', '2026-09-01T00:00:00Z'), s('new', '2026-09-10T00:00:00Z')]);
  assert.deepEqual(sorted.map((x) => x.id), ['new', 'old']);
  const upserted = applySessionUpdate(sorted, { event_type: 'agent_session_update', reason: 'status', timestamp: '', session: { ...s('old', '2026-09-20T00:00:00Z'), status: 'busy' } });
  assert.deepEqual(upserted.map((x) => x.id), ['old', 'new']);
  assert.equal(upserted[0].status, 'busy');
  const added = applySessionUpdate(upserted, { event_type: 'agent_session_update', reason: 'created', timestamp: '', session: s('fresh', '2026-09-21T00:00:00Z') });
  assert.equal(added[0].id, 'fresh');
  const removed = applySessionUpdate(added, { event_type: 'agent_session_update', reason: 'deleted', timestamp: '', session: s('old', '') });
  assert.deepEqual(removed.map((x) => x.id), ['fresh', 'new']);
});
