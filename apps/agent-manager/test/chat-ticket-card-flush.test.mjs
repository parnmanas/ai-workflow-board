// Unit test — F-1 (ticket 24694916) ticket-action card FLUSH, multi-message chunking.
//
// The pure capture math lives in ticket-ref-capture.test.mjs; this test drives the
// REAL ChatSessionManager stream-json glue (_onStdoutParsed: assistant tool_use →
// user tool_result → result) and asserts which chat-room card messages actually get
// POSTed. It proves the 3rd-review fix: a turn with MORE successful ticket actions
// than the server's per-message bound (TICKET_REFS_PER_MESSAGE = 20) is emitted as
// MULTIPLE cards (20 + 1), never truncated at 20 — acceptance #1 "누락 없이".
//
// Card posts carry `metadata.ticket_refs`; the manager's progress heartbeats are a
// separate `type:'progress'` post and are filtered out here.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionManager } from '../dist/lib/chat-session-manager.js';

function makeConfig() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    delegation: { enabled: true, maxConcurrent: 10, ttlMinutes: 15 },
  };
}

let pidSeq = 70000;
function makeSess(overrides = {}) {
  // Minimal SessionRecord — #flushTicketRefs / #emitProgress read only these fields.
  return { pid: ++pidSeq, roomId: 'room-1', agentId: 'agent-1', _effectiveApiKey: 'test-key', ...overrides };
}

let originalFetch;
let posts; // { roomId, body } for every POST to chat-rooms/:id/messages
beforeEach(() => {
  originalFetch = globalThis.fetch;
  posts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const m = u.match(/\/api\/agent\/chat-rooms\/([^/]+)\/messages$/);
    if (m && (init?.method || 'GET') === 'POST') {
      posts.push({ roomId: decodeURIComponent(m[1]), body: JSON.parse(init.body) });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });

// Drive one full turn through the real stdout path: an assistant message carrying the
// tool_use blocks, then the user carrier message with their tool_results, then the
// result line that triggers the flush.
function driveTurn(mgr, sess, actions) {
  const useBlocks = actions.map((a, i) => ({
    type: 'tool_use', id: `tu-${sess.pid}-${i}`, name: `mcp__awb__${a.tool}`, input: a.input,
  }));
  mgr._onStdoutParsed(sess, { isResult: false, raw: { type: 'assistant', message: { content: useBlocks } } }, '');
  const resultBlocks = actions.map((a, i) => ({
    type: 'tool_result', tool_use_id: `tu-${sess.pid}-${i}`,
    content: JSON.stringify(a.result), is_error: a.isError === true,
  }));
  mgr._onStdoutParsed(sess, { isResult: false, raw: { type: 'user', message: { content: resultBlocks } } }, '');
  mgr._onStdoutParsed(sess, { isResult: true, raw: { type: 'result' } }, '');
}

const cardPosts = () => posts.filter((p) => Array.isArray(p.body?.metadata?.ticket_refs));
// F2-4 ⓒ: 결과물 카드 post 는 metadata.artifact_refs 를 싣는다(ticket_refs 와 독립).
const artifactCardPosts = () => posts.filter((p) => Array.isArray(p.body?.metadata?.artifact_refs));
// agent-status(P4c-4) / board-summary(board-less) 카드 채널은 제거됐다 — 방출되면 안 된다.
const agentCardPosts = () => posts.filter((p) => Array.isArray(p.body?.metadata?.agent_refs));
const boardCardPosts = () => posts.filter((p) => Array.isArray(p.body?.metadata?.board_refs));
// Let the fire-and-forget postChatRoomMessage promises settle.
const settle = () => new Promise((r) => setTimeout(r, 30));

const createAction = (id) => ({ tool: 'create_ticket', input: { title: id }, result: { id, title: id } });

test('21 successful ticket actions in one turn → 2 cards (20 + 1), every id carded (누락 없이)', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeSess();
  driveTurn(mgr, sess, Array.from({ length: 21 }, (_, i) => createAction(`ticket-${i}`)));
  await settle();

  const cards = cardPosts();
  assert.equal(cards.length, 2, 'the 21st action forces a SECOND card — the old code silently dropped it');
  const lens = cards.map((c) => c.body.metadata.ticket_refs.length).sort((a, b) => b - a);
  assert.deepEqual(lens, [20, 1], 'refs chunked 20 + 1 to fit the server per-message bound');

  const ids = cards.flatMap((c) => c.body.metadata.ticket_refs.map((r) => r.ticket_id));
  assert.equal(ids.length, 21, 'no ref dropped across the split');
  assert.equal(new Set(ids).size, 21, 'all 21 distinct ticket_ids survive');
  for (let i = 0; i < 21; i++) assert.ok(ids.includes(`ticket-${i}`), `ticket-${i} carded`);

  // content ↔ metadata parity: each card's fallback text has one line per ref it carries.
  for (const c of cards) {
    assert.equal(c.body.content.split('\n').length, c.body.metadata.ticket_refs.length, 'content lines == refs');
    assert.equal(c.roomId, 'room-1');
    assert.equal(c.body.agent_id, 'agent-1');
    assert.notEqual(c.body.type, 'progress', 'card post is not a progress heartbeat');
  }
});

test('201 successful ticket actions → 11 cards (20×10 + 1), all 201 ids carded (no per-turn ceiling)', async () => {
  // 5th-review fix: the previous tip capped the turn at TICKET_REFS_MAX_CARD_MESSAGES = 10
  // cards and dropped the remainder past 200. This drives ceiling+1 (201) refs and proves
  // EVERY chunk is now emitted — 200 refs fill 10 full cards and the 201st forces an 11th.
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeSess();
  driveTurn(mgr, sess, Array.from({ length: 201 }, (_, i) => createAction(`big-${i}`)));
  await settle();

  const cards = cardPosts();
  assert.equal(cards.length, 11, 'the 201st action forces an 11th card — the old ceiling dropped it');
  const lens = cards.map((c) => c.body.metadata.ticket_refs.length).sort((a, b) => b - a);
  assert.deepEqual(lens, [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 1], '201 refs chunked 20×10 + 1');

  const ids = cards.flatMap((c) => c.body.metadata.ticket_refs.map((r) => r.ticket_id));
  assert.equal(ids.length, 201, 'no ref dropped beyond the old 200-ref ceiling');
  assert.equal(new Set(ids).size, 201, 'all 201 distinct ticket_ids survive the split');
  for (let i = 0; i < 201; i++) assert.ok(ids.includes(`big-${i}`), `big-${i} carded`);
});

test('the common case (≤ per-message bound) still emits exactly one coalesced card', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeSess();
  driveTurn(mgr, sess, Array.from({ length: 20 }, (_, i) => createAction(`t-${i}`)));
  await settle();

  const cards = cardPosts();
  assert.equal(cards.length, 1, 'no behaviour change for a normal turn — one card');
  assert.equal(cards[0].body.metadata.ticket_refs.length, 20, 'all 20 in the single card');
});

test('server-bound send metadata suppresses the legacy duplicate card post', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeSess();
  driveTurn(mgr, sess, [
    createAction('bound-ticket'),
    {
      tool: 'send_chat_room_message',
      input: { room_id: sess.roomId, content: 'created' },
      result: {
        message_id: 'message-1',
        metadata: {
          ticket_refs: [{ action: 'create', ticket_id: 'bound-ticket', title: 'bound-ticket' }],
        },
      },
    },
  ]);
  await settle();

  assert.equal(
    cardPosts().length,
    0,
    'the manager must not post a second card after the server persisted it on the final reply',
  );
});

test('post-commit send failure ack suppresses turn-end duplicate; pre-commit failure still flushes', async () => {
  const durableRef = {
    action: 'create',
    ticket_id: 'post-commit-ticket',
    title: 'post-commit-ticket',
  };
  const persistedHistory = [{
    id: 'durable-message-1',
    metadata: { ticket_refs: [durableRef] },
  }];

  const postCommitMgr = new ChatSessionManager(makeConfig());
  const postCommitSess = makeSess();
  driveTurn(postCommitMgr, postCommitSess, [
    createAction(durableRef.ticket_id),
    {
      tool: 'send_chat_room_message',
      input: { room_id: postCommitSess.roomId, content: 'created' },
      result: {
        error: 'injected post-commit room update failure',
        message_id: 'durable-message-1',
        room_id: postCommitSess.roomId,
        metadata: { ticket_refs: [durableRef] },
        message_persisted: true,
      },
      isError: true,
    },
  ]);
  await settle();

  const allPostCommitRefs = [
    ...persistedHistory.flatMap((row) => row.metadata.ticket_refs),
    ...cardPosts().flatMap((post) => post.body.metadata.ticket_refs),
  ].filter((ref) => ref.ticket_id === durableRef.ticket_id);
  assert.deepEqual(
    allPostCommitRefs,
    [durableRef],
    'create → post-commit send failure → turn end leaves exactly one artifact in complete history',
  );
  assert.equal(cardPosts().length, 0, 'durable error ack prevents a standalone manager flush');

  posts = [];
  const preCommitMgr = new ChatSessionManager(makeConfig());
  const preCommitSess = makeSess();
  driveTurn(preCommitMgr, preCommitSess, [
    createAction('pre-commit-ticket'),
    {
      tool: 'send_chat_room_message',
      input: { room_id: preCommitSess.roomId, content: 'not saved' },
      result: { error: 'injected pre-commit save failure' },
      isError: true,
    },
  ]);
  await settle();

  assert.deepEqual(
    cardPosts().flatMap((post) => post.body.metadata.ticket_refs)
      .map((ref) => ref.ticket_id),
    ['pre-commit-ticket'],
    'a pre-commit failure has no durable ack, so turn-end fallback remains intact',
  );
});

test('only SUCCESSFUL, tracked actions count toward the chunks (errors + reads excluded)', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeSess();
  const actions = [];
  for (let i = 0; i < 21; i++) actions.push(createAction(`s-${i}`)); // 21 successes
  actions.push({ tool: 'create_ticket', input: { title: 'x' }, result: { error: 'boom' }, isError: true }); // errored → no card
  actions.push({ tool: 'get_ticket', input: { ticket_id: 's-0' }, result: { id: 's-0', title: 'read' } }); // read → no card
  driveTurn(mgr, sess, actions);
  await settle();

  const cards = cardPosts();
  const ids = cards.flatMap((c) => c.body.metadata.ticket_refs.map((r) => r.ticket_id));
  assert.equal(ids.length, 21, 'exactly the 21 successes are carded — errored create + read excluded');
  assert.equal(cards.length, 2, 'still split 20 + 1 by success count, not tool-call count');
  assert.ok(!ids.some((id) => id == null), 'no null/undefined ticket id leaked into a card');
});

// ── F2-4 ⓒ (ticket d21b28fc): 결과물(빌드/배포) 카드 FLUSH ─────────────────────
// 결과물성 tool(register_build_artifact·report_deployment)은 티켓 row 를 안 바꾸므로
// ticket_refs 가 아니라 metadata.artifact_refs 로 방출된다. 아래는 실제 stream-json
// glue 를 태워 방출되는 실 wire payload(board lesson #5)로 이를 고정한다.

const buildAction = (target, commit) => ({
  tool: 'register_build_artifact', input: { target },
  result: { id: `B-${target}`, target, status: 'ok', commit_sha: commit },
});
const deployAction = (env) => ({
  tool: 'report_deployment', input: { environment: env },
  result: { id: `D-${env}`, environment: env, base_url: `https://${env}.example.com`, deployed_commit_sha: 'deplo1234' },
});

test('결과물 tool → artifact_refs 카드 방출(빌드/배포 실제 wire payload)', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeSess();
  driveTurn(mgr, sess, [buildAction('server', 'abc1234'), deployAction('production')]);
  await settle();

  const acards = artifactCardPosts();
  assert.equal(acards.length, 1, '한 turn 의 결과물들은 하나의 카드로 합쳐진다');
  const refs = acards[0].body.metadata.artifact_refs;
  assert.deepEqual(refs, [
    { kind: 'build', title: 'server', status: 'ok', commit: 'abc1234' },
    { kind: 'deploy', title: 'production', status: 'deployed', commit: 'deplo1234', url: 'https://production.example.com' },
  ], '실 wire artifact_refs payload');
  // content 폴백 ↔ metadata parity: 결과물마다 한 줄.
  assert.equal(acards[0].body.content.split('\n').length, refs.length, 'content lines == artifact refs');
  assert.equal(acards[0].roomId, 'room-1');
  // 티켓 카드는 이 turn 에 없다(결과물 tool 은 ticket_refs 를 만들지 않는다).
  assert.equal(cardPosts().length, 0, '결과물 turn 은 ticket_refs 카드를 만들지 않는다');
});

test('티켓 액션 + 결과물이 한 turn 에 섞이면 두 카드로 독립 방출', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeSess();
  driveTurn(mgr, sess, [createAction('T-1'), buildAction('client', 'def5678'), deployAction('staging')]);
  await settle();

  const tcards = cardPosts();
  const acards = artifactCardPosts();
  assert.equal(tcards.length, 1, 'ticket_refs 카드 1개');
  assert.equal(acards.length, 1, 'artifact_refs 카드 1개');
  assert.deepEqual(tcards[0].body.metadata.ticket_refs.map((r) => r.ticket_id), ['T-1']);
  assert.deepEqual(acards[0].body.metadata.artifact_refs.map((r) => r.title), ['client', 'staging']);
  // 두 카드는 서로 metadata 를 섞지 않는다(독립 flush).
  assert.equal(tcards[0].body.metadata.artifact_refs, undefined, 'ticket 카드에 artifact_refs 없음');
  assert.equal(acards[0].body.metadata.ticket_refs, undefined, 'artifact 카드에 ticket_refs 없음');
});

test('실패한 결과물(에러 result)은 카드로 방출되지 않는다(fail-closed)', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeSess();
  driveTurn(mgr, sess, [
    { tool: 'register_build_artifact', input: { target: 'server' }, result: { error: 'boom' }, isError: true },
    { tool: 'report_deployment', input: { environment: 'prod' }, result: { message: 'no environment echoed' } }, // env 없음 → null
  ]);
  await settle();

  assert.equal(artifactCardPosts().length, 0, '에러/미인식 shape → 결과물 카드 없음');
});

// ── board-less (docs/tickets.md): board-summary 카드 채널 제거 ─────────────────
// get_board_summary 는 서버에서 삭제됐고 board_refs 카드 채널도 함께 없어졌다. 혹시
// 구버전 서버에 붙어 그 tool 결과가 흘러와도 카드로 방출되지 않아야 한다.

const boardAction = (id, name) => ({
  tool: 'get_board_summary', input: { board_id: id },
  result: { board: name, description: '', columns: [] },
});

test('board-summary 결과는 더 이상 board_refs 카드를 만들지 않는다(티켓·결과물 채널만)', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeSess();
  driveTurn(mgr, sess, [
    createAction('T-1'),
    buildAction('client', 'def5678'),
    boardAction('B-1', 'AWB'),
  ]);
  await settle();

  assert.equal(cardPosts().length, 1, 'ticket_refs 카드 1개');
  assert.equal(artifactCardPosts().length, 1, 'artifact_refs 카드 1개');
  assert.equal(boardCardPosts().length, 0, 'board_refs 채널 제거됨 — 카드 없음');
  assert.equal(agentCardPosts().length, 0, 'agent 채널 제거됨 — 카드 없음');
});

// list_tickets(board-less 티켓 풀 조회)는 read 지만 `{ tickets: [...] }` 결과가 제목
// 캐시를 채워, 같은 turn 의 제목 없는 액션(add_comment) 카드가 제목으로 렌더된다.
test('list_tickets 결과의 제목이 뒤따르는 add_comment 카드 라벨이 된다', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeSess();
  driveTurn(mgr, sess, [
    {
      tool: 'list_tickets', input: { status: ['in_progress'] },
      result: { tickets: [{ id: 'T-list-1', title: '로그인 오류 수정' }], tags: [] },
    },
    { tool: 'add_comment', input: { ticket_id: 'T-list-1', content: '진행 상황' }, result: { id: 'C-1' } },
  ]);
  await settle();

  const cards = cardPosts();
  assert.equal(cards.length, 1, 'list_tickets(read) 는 카드가 아니고 add_comment 만 카드');
  assert.deepEqual(cards[0].body.metadata.ticket_refs, [
    { action: 'comment', ticket_id: 'T-list-1', title: '로그인 오류 수정' },
  ]);
});
