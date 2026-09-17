// Agent Session(CLI 직접 세션) 트랜스크립트/목록 순수 로직 회귀 테스트.
// 실행: node --import tsx --test apps/client/test/agent-session-transcript.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendLiveEvent,
  buildTranscript,
  canPrompt,
  describeSessionStatus,
  pendingPermission,
  sessionDisplayTitle,
} from '../src/components/sessions/sessionTranscript.logic.ts';
import { hostCliEntries, sessionPath, sortSessionsByActivity } from '../src/components/sessions/sessionList.logic.ts';

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

test('appendLiveEvent appends in arrival order, renumbers display seq, and drops duplicate ids', () => {
  const history = [
    { id: 's:1', seq: 1, turn_id: '', type: 'user_prompt', payload: { text: 'a' }, created_at: '' },
    { id: 's:2', seq: 2, turn_id: '', type: 'text', payload: { text: 'b' }, created_at: '' },
  ];
  // 라이브 seq 는 프로세스마다 1 부터 — 기록의 seq 와 겹쳐도 순서를 바꾸지 않는다
  const withLive = appendLiveEvent(history, { id: 's:live:ab12:1', seq: 1, turn_id: 't', type: 'turn', payload: { phase: 'started' }, created_at: '' });
  assert.deepEqual(withLive.map((e) => e.id), ['s:1', 's:2', 's:live:ab12:1']);
  assert.equal(withLive[2].seq, 3, 'display seq continues after history');
  assert.equal(appendLiveEvent(withLive, { id: 's:live:ab12:1', seq: 1, turn_id: 't', type: 'turn', payload: {}, created_at: '' }), withLive, 'duplicate id is a no-op');
  assert.equal(appendLiveEvent(withLive, { id: '', seq: 9, turn_id: '', type: 'text', payload: {}, created_at: '' }), withLive, 'events without an id are ignored');
});

test('status helpers mirror the server prompt rules', () => {
  assert.equal(canPrompt('ready'), true);
  assert.equal(canPrompt('idle'), true, 'an idle session reopens on prompt');
  assert.equal(canPrompt('closed'), true, 'a stopped session reopens on prompt');
  assert.equal(canPrompt('error'), true);
  assert.equal(canPrompt('busy'), false);
  assert.equal(canPrompt('awaiting_permission'), false);
  assert.equal(canPrompt('starting'), false);
  assert.equal(describeSessionStatus('awaiting_permission').tone, 'warning');
  assert.equal(describeSessionStatus('idle').live, false);
  assert.equal(describeSessionStatus(undefined).label, 'Unknown');
  assert.equal(sessionDisplayTitle({ title: '', cli: 'claude', session_id: '11111111-2222' }), 'Claude Code · 11111111');
  assert.equal(sessionDisplayTitle({ title: 'Fix login', cli: 'claude', session_id: 'x' }), 'Fix login');
});

test('session list helpers: activity sort, host×cli sidebar rows, canonical paths', () => {
  const sorted = sortSessionsByActivity([
    { cli: 'claude', session_id: 'old', cwd: '/a', title: 'old', created_at: null, updated_at: '2026-09-01T00:00:00Z', source: 'cli' },
    { cli: 'claude', session_id: 'new', cwd: '/a', title: 'new', created_at: null, updated_at: '2026-09-10T00:00:00Z', source: 'cli' },
  ]);
  assert.deepEqual(sorted.map((s) => s.session_id), ['new', 'old']);
  const rows = hostCliEntries([
    { manager_id: 'm1', instance_id: 'i1', hostname: 'rolf.local', name: 'rolf', clis: ['claude', 'codex'], plugin_version: '1', last_seen_at: '' },
    { manager_id: 'm2', instance_id: 'i2', hostname: 'ralf', name: 'ralf', clis: [], plugin_version: '1', last_seen_at: '' },
  ], '/ws/w1', (cli) => cli.toUpperCase());
  assert.deepEqual(rows.map((r) => r.label), ['rolf · CLAUDE', 'rolf · CODEX']);
  // 사이드바 행은 이제 managerId 수준(cwd 그룹 뷰)을 가리킨다 — 이전의 :managerId/:cli 대신
  assert.equal(rows[0].path, '/ws/w1/sessions/m1');
  assert.equal(sessionPath('/ws/w1', 'm1', 'claude', 'abc def'), '/ws/w1/sessions/m1/claude/abc%20def');
});
