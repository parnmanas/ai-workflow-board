// add_comment 합치기(dedupe merge) 검증 (ticket e341bcc2).
//
// silent-exit 엔드포인트의 fingerprint 기반 in-place bump
// (agent-api.controller.ts computeSystemFingerprint, 참고
// test/qa-flows/silent-exit-dedupe.test.mjs) 를 `metadata.dedupe_key` 로
// 옵트인하는 모든 add_comment 호출자에게 일반화한다 — 주 대상은
// agent-manager 의 dispatch 억제 코멘트(event-dispatcher.ts)로, 이게 없으면
// 억제될 때마다 코멘트 row 를 새로 쌓았다.
//
// 검증 대상 계약:
//   1. 같은 dedupe_key 로 연속 호출한 add_comment 는 한 row 로 합쳐진다:
//      repeat_count 증가, last_repeated_at 갱신, content 는 최신 호출로
//      갱신 — 새 row 없음.
//   2. 합치기는 티켓의 마지막 코멘트에만 적용된다. 그 사이에 다른 것(다른
//      dedupe_key, 또는 dedupe_key 없음)이 끼면 silent-exit 선례와 동일하게
//      새 occurrence row 로 시작한다.
//   3. bump 경로는 ActivityLog 에 `action:'updated'` + `actor_id:'system'`
//      을 남긴다(`'created'` + 호출 agent 자신의 id 가 아님) — 131,068-사이클
//      런어웨이 버그 계급을 막는 바로 그 규칙이다(agent-api.controller.ts 의
//      silent-exit 합치기 코멘트가 2026-05-28 인시던트를 문서화하고 있다).
//   4. dedupe_key 를 아예 안 실으면 add_comment 의 insert-only 동작은
//      완전히 그대로다(회귀 baseline).
//
// 컴파일된 dist/ 를 real sql.js DataSource 로 실행한다 — 레시피는
// test/comment-tools-pending-gate.test.mjs 와 동일.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-comment-tools-dedupe-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'comment-tools-dedupe-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { Resource } = await import('file://' + path.join(DIST, 'entities', 'Resource.js'));
const { Agent } = await import('file://' + path.join(DIST, 'entities', 'Agent.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
const { registerCommentTools } = await import('file://' + path.join(DIST, 'modules', 'mcp', 'tools', 'comment-tools.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds.getRepository(Agent), logStub);
const mentionServiceStub = { parseMentions: () => [] };

const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);
const resourceRepo = ds.getRepository(Resource);
const activityRepo = ds.getRepository(ActivityLog);

function registerTools(ctxOverrides = {}) {
  const handlers = new Map();
  const server = { tool(name, _description, _schema, handler) { handlers.set(name, handler); } };
  const ctx = {
    dataSource: ds, activityService, mentionService: mentionServiceStub,
    logger: logStub, ticketRoleAssignmentService: null, roomMessagingService: null,
    ...ctxOverrides,
  };
  registerCommentTools(server, ctx);
  return handlers;
}

async function makeTicket(overrides = {}) {
  return ticketRepo.save(ticketRepo.create({
    title: 'T', workspace_id: 'w1', pending_user_action: false, ...overrides,
  }));
}
function parse(res) {
  return JSON.parse(res.content[0].text);
}

// claim-verification-same-second-move.test.mjs 와 동일한 결정성 기법: 실제
// insert 를 반복해 그 행의 REAL(조작하지 않은) created_at 이 우연히 목표
// 초와 같아질 때까지 재시도한다. sql.js 의 datetime('now') 기본값은 초
// 단위라 직전 호출과 같은 초 안에서라면 대개 1~수회 안에 성공한다.
async function addCommentAlignedToSecond(addComment, args, targetMs, maxAttempts = 200) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = parse(await addComment(args, {}));
    const reloaded = await commentRepo.findOne({ where: { id: res.id } });
    if (reloaded.created_at.getTime() === targetMs) return res;
    await commentRepo.delete({ id: res.id });
  }
  throw new Error(`failed to align add_comment insert to target second within ${maxAttempts} attempts`);
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('consecutive add_comment calls with the same dedupe_key collapse into one row', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  const first = parse(await addComment({
    ticket_id: t.id, content: 'suppressed (attempt 1)', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'dispatch_suppress:inflight:t1:assignee:a1' },
  }, {}));
  assert.ok(first.id, 'first call creates a row');
  assert.ok(first.repeat_count === null || first.repeat_count === undefined,
    `first row repeat_count should be NULL, got ${first.repeat_count}`);

  const second = parse(await addComment({
    ticket_id: t.id, content: 'suppressed (attempt 2)', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'dispatch_suppress:inflight:t1:assignee:a1' },
  }, {}));
  assert.equal(second.id, first.id, 'second call bumps the SAME row');
  assert.equal(second.repeat_count, 2, 'repeat_count bumped to 2');
  assert.ok(second.last_repeated_at, 'last_repeated_at populated');
  assert.match(second.content, /attempt 2/, 'content refreshed to the latest call');

  const third = parse(await addComment({
    ticket_id: t.id, content: 'suppressed (attempt 3)', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'dispatch_suppress:inflight:t1:assignee:a1' },
  }, {}));
  assert.equal(third.id, first.id);
  assert.equal(third.repeat_count, 3);

  const rows = await commentRepo.find({ where: { ticket_id: t.id } });
  assert.equal(rows.length, 1, 'three suppressed retries collapse into a single comment row');
});

test('an unrelated comment in between breaks the dedupe chain', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  const a = parse(await addComment({
    ticket_id: t.id, content: 'suppressed (a)', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'k1' },
  }, {}));

  const unrelated = parse(await addComment({
    ticket_id: t.id, content: 'unrelated human-visible reply', author_type: 'user', author_id: 'u1', author: 'User',
  }, {}));
  assert.notEqual(unrelated.id, a.id);

  const c = parse(await addComment({
    ticket_id: t.id, content: 'suppressed (c)', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'k1' },
  }, {}));
  assert.notEqual(c.id, a.id, 'same dedupe_key does NOT reach back past the intervening comment');
  assert.ok(c.repeat_count === null || c.repeat_count === undefined, 'fresh occurrence row starts at NULL repeat_count');

  const rows = await commentRepo.find({ where: { ticket_id: t.id } });
  assert.equal(rows.length, 3, 'three distinct rows: a, the unrelated reply, and c');
});

test('an unrelated comment landing in the SAME wall-clock second still breaks the dedupe chain (review round 2 — no time manipulation)', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  const a = parse(await addComment({
    ticket_id: t.id, content: 'suppressed (a)', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'k1' },
  }, {}));
  const aReloaded = await commentRepo.findOne({ where: { id: a.id } });

  // 리뷰 라운드2 지적: created_at 을 미래로 강제하는 이전 버전은 sql.js 가
  // 초 단위로 truncate 하는 실제 실패 모드를 우회했다. 대신 REAL insert 를
  // `a` 와 정확히 같은 초에 자연스럽게 착지시킨다(값을 조작하지 않는다) —
  // 그 상태에서도 write-seq 타이브레이크 덕분에 "마지막 코멘트" 판정이
  // 여전히 결정적으로 `unrelated` 를 가리켜야 한다.
  const unrelated = await addCommentAlignedToSecond(addComment, {
    ticket_id: t.id, content: 'unrelated human-visible reply', author_type: 'user', author_id: 'u1', author: 'User',
  }, aReloaded.created_at.getTime());
  assert.notEqual(unrelated.id, a.id);
  const unrelatedReloaded = await commentRepo.findOne({ where: { id: unrelated.id } });
  assert.equal(unrelatedReloaded.created_at.getTime(), aReloaded.created_at.getTime(),
    'sanity: a and unrelated genuinely share the same truncated-to-the-second created_at');

  const c = parse(await addComment({
    ticket_id: t.id, content: 'suppressed (c)', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'k1' },
  }, {}));
  assert.notEqual(c.id, a.id,
    'same dedupe_key must not reach back past the intervening same-second comment to merge into `a`');
  assert.ok(c.repeat_count === null || c.repeat_count === undefined, 'fresh occurrence row starts at NULL repeat_count');

  const rows = await commentRepo.find({ where: { ticket_id: t.id } });
  assert.equal(rows.length, 3, 'three distinct rows: a, the same-second unrelated reply, and c');
});

test('a different dedupe_key never merges into the previous key\'s row', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  const a = parse(await addComment({
    ticket_id: t.id, content: 'inflight suppress', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'dispatch_suppress:inflight:t1:assignee:a1' },
  }, {}));
  const b = parse(await addComment({
    ticket_id: t.id, content: 'mention-seat suppress', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'dispatch_suppress:mention_seat:t1:assignee:a1' },
  }, {}));
  assert.notEqual(b.id, a.id, 'a different dedupe_key always starts its own row');
  assert.ok(b.repeat_count === null || b.repeat_count === undefined);

  const rows = await commentRepo.find({ where: { ticket_id: t.id } });
  assert.equal(rows.length, 2);
});

test('the bump path logs action=updated + actor_id=system; the first insert logs action=created + the real author', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  const first = parse(await addComment({
    ticket_id: t.id, content: 'suppressed (1)', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'k1' },
  }, {}));
  const second = parse(await addComment({
    ticket_id: t.id, content: 'suppressed (2)', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'k1' },
  }, {}));
  assert.equal(second.id, first.id);

  const logs = await activityRepo.find({
    where: { entity_type: 'comment', entity_id: first.id },
    order: { created_at: 'ASC' },
  });
  assert.equal(logs.length, 2, 'one activity row per add_comment call, both against the same comment id');

  assert.equal(logs[0].action, 'created');
  assert.equal(logs[0].actor_id, 'mgr-1', 'the first (genuine) insert attributes to the real caller');

  assert.equal(logs[1].action, 'updated', 'the bump is action=updated, never action=created');
  assert.equal(logs[1].actor_id, 'system',
    'actor_id=system is required so trigger-loop\'s system-actor guard does not re-dispatch the same agent (2026-05-28 131,068-cycle runaway incident)');
  assert.equal(logs[1].field_changed, 'repeat_count');
  assert.equal(logs[1].new_value, '2');
});

test('omitting dedupe_key leaves add_comment insert-only, unchanged', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  for (let i = 0; i < 3; i++) {
    await addComment({
      ticket_id: t.id, content: 'identical repeated note', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    }, {});
  }

  const rows = await commentRepo.find({ where: { ticket_id: t.id } });
  assert.equal(rows.length, 3, 'without dedupe_key, every call still inserts its own row');
  assert.ok(rows.every((r) => r.repeat_count === null), 'repeat_count stays NULL — dedupe logic never engaged');
});

// 리뷰 라운드2 지적 1 — 교차 작성자/타입 회귀 테스트.

test('a different author reusing the same dedupe_key never bumps the original author\'s row', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  const a = parse(await addComment({
    ticket_id: t.id, content: 'suppressed by manager A', author_type: 'agent', author_id: 'mgr-A', author: 'Manager A',
    metadata: { dedupe_key: 'shared-key' },
  }, {}));

  const b = parse(await addComment({
    ticket_id: t.id, content: 'suppressed by manager B', author_type: 'agent', author_id: 'mgr-B', author: 'Manager B',
    metadata: { dedupe_key: 'shared-key' },
  }, {}));

  assert.notEqual(b.id, a.id, 'a different author_id must never bump another author\'s row, even with the same dedupe_key');
  assert.equal(b.author, 'Manager B');

  const rows = await commentRepo.find({ where: { ticket_id: t.id } });
  assert.equal(rows.length, 2);
  const reloadedA = rows.find((r) => r.id === a.id);
  assert.equal(reloadedA.author, 'Manager A', 'original row author/content untouched by the other author\'s call');
  assert.equal(reloadedA.content, 'suppressed by manager A');
  assert.ok(reloadedA.repeat_count === null || reloadedA.repeat_count === undefined);
});

test('a different comment type reusing the same dedupe_key never merges', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  const a = parse(await addComment({
    ticket_id: t.id, content: 'note occurrence', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'shared-key' },
  }, {}));

  const q = parse(await addComment({
    ticket_id: t.id, content: 'question occurrence', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    type: 'question',
    metadata: { dedupe_key: 'shared-key' },
  }, {}));

  assert.notEqual(q.id, a.id, 'type=question must never bump a type=note row even with the same dedupe_key');
  assert.equal(q.status, 'open', 'the fresh question row still gets its normal type=question side effect');

  const rows = await commentRepo.find({ where: { ticket_id: t.id } });
  assert.equal(rows.length, 2);
});

test('dedupe merge is scoped to type=note — repeated non-note comments with the same dedupe_key never merge', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  const first = parse(await addComment({
    ticket_id: t.id, content: 'question 1', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    type: 'question', metadata: { dedupe_key: 'shared-key' },
  }, {}));
  const second = parse(await addComment({
    ticket_id: t.id, content: 'question 2', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    type: 'question', metadata: { dedupe_key: 'shared-key' },
  }, {}));

  assert.notEqual(second.id, first.id,
    'non-note types are never dedupe-merge-eligible, even repeated identically by the same author');
  const rows = await commentRepo.find({ where: { ticket_id: t.id } });
  assert.equal(rows.length, 2);
});

test('a dedupe_key note carrying an @-mention is never merged — the mention must actually dispatch each time', async () => {
  const mentioningMentionService = {
    parseMentions: (content) => (/@\[agent:/.test(content) ? [{ type: 'agent', id: 'bot-1', roleShortcut: null }] : []),
  };
  const handlers = registerTools({ mentionService: mentioningMentionService });
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  const a = parse(await addComment({
    ticket_id: t.id, content: 'plain suppress', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'shared-key' },
  }, {}));

  const withMention = parse(await addComment({
    ticket_id: t.id, content: 'suppress @[agent:11111111-1111-1111-1111-111111111111|Bot]',
    author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'shared-key' },
  }, {}));

  assert.notEqual(withMention.id, a.id,
    'a mention-bearing comment must start a fresh row — bumping in place would silently drop the mention dispatch');

  const rows = await commentRepo.find({ where: { ticket_id: t.id } });
  assert.equal(rows.length, 2);
});

test('a dedupe_key note carrying an attachment is never merged — the attachment link must persist', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const resource = await resourceRepo.save(resourceRepo.create({
    workspace_id: t.workspace_id, type: 'comment_attachment', name: 'log.txt',
  }));

  const a = parse(await addComment({
    ticket_id: t.id, content: 'plain suppress', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'shared-key' },
  }, {}));

  const withAttachment = parse(await addComment({
    ticket_id: t.id, content: 'suppress with log', author_type: 'agent', author_id: 'mgr-1', author: 'Manager',
    metadata: { dedupe_key: 'shared-key' }, attachment_resource_ids: [resource.id],
  }, {}));

  assert.notEqual(withAttachment.id, a.id,
    'an attachment-bearing comment must start a fresh row — bumping in place would silently drop the attachment link');

  const rows = await commentRepo.find({ where: { ticket_id: t.id } });
  assert.equal(rows.length, 2);
  const reloadedAttachment = rows.find((r) => r.id === withAttachment.id);
  assert.deepEqual(JSON.parse(reloadedAttachment.attachment_resource_ids), [resource.id]);
});
