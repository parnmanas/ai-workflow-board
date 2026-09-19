// Agent Session(CLI 직접 세션) 트랜스크립트/목록 순수 로직 회귀 테스트.
// 실행: node --import tsx --test apps/client/test/agent-session-transcript.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendLiveEvent,
  applySlashCommand,
  buildTranscript,
  canConnect,
  canPrompt,
  describeSessionStatus,
  isWaitingStatus,
  matchSlashCommands,
  normalizeElicitationSchema,
  pendingInteraction,
  pendingPermission,
  sessionDisplayTitle,
  shouldAutoConnect,
} from '../src/components/sessions/sessionTranscript.logic.ts';
import {
  cwdBaseName,
  groupSessionsByCwd,
  sessionPath,
  sortSessionsByActivity,
} from '../src/components/sessions/sessionList.logic.ts';

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

test('session list helpers: activity sort, canonical paths', () => {
  const sorted = sortSessionsByActivity([
    { cli: 'claude', session_id: 'old', cwd: '/a', title: 'old', created_at: null, updated_at: '2026-09-01T00:00:00Z', source: 'cli' },
    { cli: 'claude', session_id: 'new', cwd: '/a', title: 'new', created_at: null, updated_at: '2026-09-10T00:00:00Z', source: 'cli' },
  ]);
  assert.deepEqual(sorted.map((s) => s.session_id), ['new', 'old']);
  assert.equal(sessionPath('/ws/w1', 'm1', 'claude', 'abc def'), '/ws/w1/sessions/m1/claude/abc%20def');
});

test('cwdBaseName 은 표시용 마지막 경로 요소를 뽑는다 — POSIX·Windows·후행 구분자·빈 입력', () => {
  assert.equal(cwdBaseName(''), '(unknown)', '빈 cwd 는 자리표시자로 대체된다');
  assert.equal(cwdBaseName('/a/b'), 'b');
  assert.equal(cwdBaseName('/a/b/'), 'b', '후행 구분자는 무시한다');
  assert.equal(cwdBaseName('a/b'), 'b', '상대 경로도 마지막 요소를 뽑는다');
  assert.equal(cwdBaseName('C:\\a\\b'), 'b', 'Windows 구분자');
  assert.equal(cwdBaseName('C:\\a\\b\\'), 'b', 'Windows 후행 구분자');
  assert.equal(cwdBaseName('project'), 'project', '구분자가 없으면 입력이 곧 이름이다');
  // 루트는 후행 구분자를 떼고 나면 남는 요소가 없어 cwd 원문으로 되돌아간다.
  // '(unknown)' 이 아니라 '/' 인 것이 이 폴백의 유일한 관측 지점이다.
  assert.equal(cwdBaseName('/'), '/');
});

// groupSessionsByCwd 픽스처 — 실제 페이로드 모양(AgentSessionSummary 필수 필드)을 유지한다.
// updated_at 은 전부 다르게 둔다: 동률 tie-break 은 열거 순서에 의존해 단언 대상이 아니다.
function sessionsByCliFixture() {
  return {
    claude: [
      { cli: 'claude', session_id: 'alpha-claude', cwd: '/repo/alpha', title: 'alpha (claude)', created_at: null, updated_at: '2026-09-01T00:00:00Z', source: 'cli' },
      { cli: 'claude', session_id: 'beta-claude', cwd: '/repo/beta', title: 'beta (claude)', created_at: null, updated_at: '2026-09-09T00:00:00Z', source: 'cli' },
    ],
    codex: [
      { cli: 'codex', session_id: 'alpha-codex', cwd: '/repo/alpha', title: 'alpha (codex)', created_at: null, updated_at: '2026-09-05T00:00:00Z', source: 'cli' },
      { cli: 'codex', session_id: 'blank-cwd', cwd: '', title: 'cwd 가 빈 문자열', created_at: null, updated_at: '2026-09-03T00:00:00Z', source: 'cli' },
      { cli: 'codex', session_id: 'no-cwd', title: 'cwd 키 자체가 없음', created_at: null, updated_at: '2026-09-02T00:00:00Z', source: 'cli' },
    ],
  };
}

test('groupSessionsByCwd 는 그룹을 각 그룹 최신 세션 기준 내림차순으로 놓는다', () => {
  const groups = groupSessionsByCwd(sessionsByCliFixture());
  assert.deepEqual(
    groups.map((g) => g.cwd),
    ['/repo/beta', '/repo/alpha', ''],
    'beta(09-09) > alpha(09-05) > 빈 cwd(09-03) — 사이드바와 목록 페이지가 공유하는 그룹 경계',
  );
  assert.deepEqual(groups.map((g) => g.cwdLabel), ['beta', 'alpha', '(unknown)']);
});

test('groupSessionsByCwd 는 그룹 안에서 CLI 가 섞여도 updated_at 내림차순을 지키고 cli 를 보존한다', () => {
  const alpha = groupSessionsByCwd(sessionsByCliFixture()).find((g) => g.cwd === '/repo/alpha');
  // cli 는 sessionPath 가 URL 을 만드는 데 쓰므로 그룹핑을 거쳐도 살아남아야 한다.
  assert.deepEqual(
    alpha.sessions.map((s) => [s.cli, s.session_id]),
    [['codex', 'alpha-codex'], ['claude', 'alpha-claude']],
  );
});

test('groupSessionsByCwd 는 cwd 가 빈 문자열이거나 없는 세션을 하나의 (unknown) 그룹으로 묶는다', () => {
  const unknown = groupSessionsByCwd(sessionsByCliFixture()).filter((g) => g.cwd === '');
  assert.equal(unknown.length, 1, '빈 cwd 와 누락 cwd 가 그룹을 나눠 가지면 안 된다');
  assert.equal(unknown[0].cwdLabel, '(unknown)');
  assert.deepEqual(unknown[0].sessions.map((s) => s.session_id), ['blank-cwd', 'no-cwd']);
});

// ─── 질문/폼(elicitation) · plan · slash command ────────────────────────────────

test('buildTranscript folds an elicitation decision into its question card, and pendingInteraction sees form questions but not url ones', () => {
  seq = 0;
  const schema = { type: 'object', title: 'Deployment target', properties: { env: { type: 'string', title: 'Environment', enum: ['dev', 'prod'] }, notes: { type: 'string', title: 'Notes' } }, required: ['env'] };
  const events = [
    ev('user_prompt', { text: 'deploy' }),
    ev('elicitation_request', { elicitation_id: 'e1', mode: 'form', message: 'Which environment?', schema, tool_call_id: 'c1' }),
  ];
  let blocks = buildTranscript(events);
  const card = blocks.find((b) => b.kind === 'elicitation');
  assert.ok(card, 'question card exists');
  assert.equal(card.mode, 'form');
  assert.equal(card.message, 'Which environment?');
  assert.deepEqual(card.schema.fields.map((f) => [f.name, f.type, f.required, f.choices?.map((c) => c.value) ?? null]), [['env', 'string', true, ['dev', 'prod']], ['notes', 'string', false, null]]);
  assert.equal(pendingInteraction(blocks)?.elicitationId, 'e1', 'an unanswered form question is the pending interaction');

  blocks = buildTranscript([...events, ev('elicitation_decision', { elicitation_id: 'e1', action: 'accept', content: { env: 'prod' }, decided_by: 'user' })]);
  const answered = blocks.find((b) => b.kind === 'elicitation');
  assert.deepEqual(answered.decision, { action: 'accept', content: { env: 'prod' }, decided_by: 'user' });
  assert.equal(pendingInteraction(blocks), null, 'answered question is no longer pending');
  assert.equal(blocks.filter((b) => b.kind === 'system').length, 0, 'decision folded, no stray system note');

  // url 방식은 기다리지 않는다 — 카드만 남고 elicitation/complete 로 닫힌다
  const urlBlocks = buildTranscript([
    ev('elicitation_request', { elicitation_id: 'u1', mode: 'url', message: 'Sign in', url: 'https://example.com/login' }),
  ]);
  assert.equal(urlBlocks[0].mode, 'url');
  assert.equal(urlBlocks[0].url, 'https://example.com/login');
  assert.equal(pendingInteraction(urlBlocks), null, 'url elicitations do not block the composer');
  // permission 은 여전히 pendingInteraction 이다
  const perm = buildTranscript([ev('permission_request', { request_id: 'p1', tool_call_id: 'c1', title: 'Run', description: 'Reason: tests', options: [{ option_id: 'a', name: 'Allow', kind: 'allow_once' }] })]);
  assert.equal(pendingInteraction(perm)?.kind, 'permission');
  assert.equal(perm[0].description, 'Reason: tests', 'permission description is kept for the card');
  assert.equal(pendingPermission(perm)?.requestId, 'p1');
});

test('plan rows in the same turn replace each other; plans in different turns stay separate', () => {
  seq = 0;
  const blocks = buildTranscript([
    ev('plan', { entries: [{ content: 'Ask', priority: 'high', status: 'in_progress' }, { content: 'Deploy', priority: 'medium', status: 'pending' }] }, 't1'),
    ev('text', { text: 'working' }, 't1'),
    ev('plan', { entries: [{ content: 'Ask', priority: 'high', status: 'completed' }, { content: 'Deploy', priority: 'medium', status: 'in_progress' }] }, 't1'),
    ev('plan', { entries: [{ content: 'Next turn plan', priority: 'low', status: 'pending' }] }, 't2'),
  ]);
  const plans = blocks.filter((b) => b.kind === 'plan');
  assert.equal(plans.length, 2, 'one plan per turn');
  assert.deepEqual(plans[0].entries.map((e) => e.status), ['completed', 'in_progress'], 'the latest plan of the turn wins in place');
  assert.equal(blocks.indexOf(plans[0]), 0, 'the plan keeps its original position');
  assert.equal(plans[1].entries[0].content, 'Next turn plan');
});

test('normalizeElicitationSchema handles oneOf titles, multi-select arrays, numbers and booleans', () => {
  const view = normalizeElicitationSchema({
    type: 'object',
    properties: {
      size: { type: 'string', title: 'Size', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] },
      tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b'] } },
      count: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
      ok: { type: 'boolean', default: true },
    },
    required: ['size'],
  });
  assert.deepEqual(view.fields.find((f) => f.name === 'size').choices, [{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }]);
  assert.deepEqual(view.fields.find((f) => f.name === 'tags').choices, [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }]);
  const count = view.fields.find((f) => f.name === 'count');
  assert.equal(count.type, 'integer');
  assert.equal(count.minimum, 1);
  assert.equal(count.maximum, 5);
  assert.equal(count.defaultValue, 2);
  assert.equal(count.title, 'count', 'missing title falls back to the property name');
  assert.equal(view.fields.find((f) => f.name === 'ok').defaultValue, true);
  assert.equal(normalizeElicitationSchema(null), null);
});

test('awaiting_input is a waiting status: labelled, blocks prompting, and counts as waiting', () => {
  assert.equal(describeSessionStatus('awaiting_input').label, 'Needs your input');
  assert.equal(describeSessionStatus('awaiting_input').tone, 'warning');
  assert.equal(canPrompt('awaiting_input'), false);
  assert.equal(isWaitingStatus('awaiting_input'), true);
  assert.equal(isWaitingStatus('awaiting_permission'), true);
  assert.equal(isWaitingStatus('busy'), false);
});

test('slash command matching is active only while the command name is being typed', () => {
  const commands = [
    { name: 'review', description: 'Review', input_hint: 'focus' },
    { name: 'compact', description: 'Compact' },
    { name: 'review-branch', description: 'Review a branch' },
  ];
  assert.deepEqual(matchSlashCommands('/', commands).matches.map((c) => c.name), ['compact', 'review', 'review-branch'], 'bare slash lists everything, sorted');
  assert.deepEqual(matchSlashCommands('/re', commands).matches.map((c) => c.name), ['review', 'review-branch']);
  assert.deepEqual(matchSlashCommands('/RE', commands).matches.map((c) => c.name), ['review', 'review-branch'], 'case-insensitive');
  assert.equal(matchSlashCommands('/review focus here', commands).active, false, 'a space after the name means arguments — popup closes');
  assert.equal(matchSlashCommands('hello /re', commands).active, false, 'only a leading slash counts');
  assert.equal(matchSlashCommands('/re', []).active, false, 'no commands, no popup');
  assert.equal(applySlashCommand(commands[0]), '/review ', 'commands that take input get a trailing space');
  assert.equal(applySlashCommand(commands[1]), '/compact');
});

test('entering a session page auto-connects only idle sessions; closed/error keep a manual Connect', () => {
  assert.equal(shouldAutoConnect('idle'), true, 'idle → open it so model/mode settings arrive');
  for (const status of ['closed', 'error', 'starting', 'ready', 'busy', 'awaiting_permission', 'awaiting_input']) {
    assert.equal(shouldAutoConnect(status), false, `${status} is not auto-connected`);
  }
  assert.deepEqual(['idle', 'closed', 'error'].map(canConnect), [true, true, true]);
  assert.deepEqual(['starting', 'ready', 'busy', 'awaiting_permission', 'awaiting_input'].map(canConnect), [false, false, false, false, false]);
});

test('a tool_call that arrives already completed/failed (codex mcp startup) is never shown as running', () => {
  seq = 0;
  const blocks = buildTranscript([
    ev('tool_call', { tool_call_id: 'mcp_startup.awb', title: 'mcp__awb__startup', kind: 'other', status: 'failed' }),
    ev('tool_call', { tool_call_id: 'c1', title: 'Read', kind: 'read' }),
  ]);
  assert.equal(blocks[0].kind, 'tool');
  assert.equal(blocks[0].status, 'failed', 'initial status is honoured');
  assert.equal(blocks[1].status, 'in_progress', 'calls without a status still start as running');
});

// ─── 라이브 창(window) — 오래 켜 둔 세션이 무한히 자라지 않는다 ────────────────
test('appendLiveEvent keeps only the most recent window and says how many it dropped', () => {
  seq = 0;
  let events = [];
  for (let i = 0; i < 5; i += 1) events = appendLiveEvent(events, ev('text', { text: `t${i}` }), 3);
  assert.equal(events.length, 4, 'window of 3 plus the marker');
  assert.equal(events[0].type, 'system');
  assert.equal(events[0].payload.dropped, 2);
  assert.match(events[0].payload.text, /Earlier messages trimmed \(2 events\)/);
  assert.deepEqual(events.slice(1).map((e) => e.payload.text), ['t2', 't3', 't4'], 'the newest rows survive');

  // 계속 흘러도 마커는 하나뿐이고 누적 개수만 올라간다
  events = appendLiveEvent(events, ev('text', { text: 't5' }), 3);
  assert.equal(events.filter((e) => e.type === 'system').length, 1, 'one marker, not one per trim');
  assert.equal(events[0].payload.dropped, 3);
  assert.deepEqual(events.slice(1).map((e) => e.payload.text), ['t3', 't4', 't5']);
  assert.ok(events.slice(1).every((e, i) => e.seq === events[i + 1].seq), 'kept rows keep their display seq');

  // 상한 안에서는 아무것도 버리지 않는다(기본 동작)
  let small = [];
  for (let i = 0; i < 3; i += 1) small = appendLiveEvent(small, ev('text', { text: `s${i}` }), 10);
  assert.equal(small.length, 3);
  assert.equal(small.some((e) => e.id === 'live:trimmed'), false);
});

test('the trim marker renders as a system note and does not disturb folding', () => {
  seq = 0;
  let events = [];
  for (let i = 0; i < 4; i += 1) events = appendLiveEvent(events, ev('text', { text: `chunk${i} ` }, 't1'), 2);
  const blocks = buildTranscript(events);
  assert.equal(blocks[0].kind, 'system', 'the marker is a plain system note');
  assert.match(blocks[0].text, /Earlier messages trimmed/);
  const assistant = blocks.find((b) => b.kind === 'assistant');
  assert.equal(assistant.text, 'chunk2 chunk3 ', 'surviving chunks of the same turn still merge');
});
