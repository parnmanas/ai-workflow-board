// add_comment `metadata.auto_notice` 검증 (ticket 3c8b8026).
//
// 매니저가 남기는 "⚠️ 중복 dispatch 억제" 같은 자동 알림은 add_comment MCP
// 호출로 생성되고 실제 Manager 에이전트의 진짜 UUID로 인증되므로, 그 알림
// 자체가 코멘트→트리거 경로를 다시 타 새 trigger_emitted 를 낳는 자기증폭
// 루프였다(재현: hard-budget 30회를 16분 만에 소진, 그중 27%가 순수
// 자기메아리). `metadata.auto_notice===true` 를 실은 호출은 activity-log
// 의 actor_id 를 'system' 으로 남겨, trigger-loop.service.ts 의 기존
// system-actor 가드(`actor_id === 'system' || actor_id === ''`)가 그대로
// 걸러내게 한다 — 코멘트 자체의 author/author_id 는 실제 호출자 그대로
// 저장되어 화면 귀속은 바뀌지 않는다.
//
// 리뷰 라운드1 지적1: 값 자체가 아니라 발신자를 검증한다 — auto_notice 는
// 인증 세션의 Agent 가 Agent.type==='manager'이고 저장 author와 일치할 때만
// 존중된다(agent-manager 가 이 알림들을 남길 때 항상 인증하는 페어링 전용
// 신원). 그 외 caller 의
// auto_notice 는 조용히 무시되어(에러 아님) 평범한 코멘트로 저장된다 —
// 임의의 agent 가 자기선언만으로 자신의 코멘트를 트리거 경로에서 숨길 수
// 없다는 것을 아래 거부/대조 테스트들로 증명한다.
//
// 지금(ticket 193a7392) 이 스탬프를 읽는 곳은 trigger-loop 가 아니라
// TicketDispatchService.onComment 다 — actor 'system' 인 에이전트 코멘트는
// supervisor 재전송 카운트를 되돌리지 않는다. 그래서 'system' 은 검증된 매니저
// 알림에만 남아야 한다: 같은 Host 에 묶인 런타임(rt-) 키는 매니저가 아니고,
// author_id 로 'system' 을 대도 activity actor 는 인증된 호출자다.
//
// 컴파일된 dist/ 를 real sql.js DataSource 로 실행한다 — 레시피는
// test/comment-tools-dedupe.test.mjs 와 동일.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-comment-tools-auto-notice-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'comment-tools-auto-notice-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { RuntimeHost } = await import('file://' + path.join(DIST, 'entities', 'RuntimeHost.js')); // P4c-4
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
const { registerCommentTools } = await import('file://' + path.join(DIST, 'modules', 'mcp', 'tools', 'comment-tools.js'));
const { sessionStore } = await import('file://' + path.join(DIST, 'modules', 'mcp', 'internal', 'session-store.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds, logStub);
const mentionServiceStub = { parseMentions: () => [] };

const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);
const activityRepo = ds.getRepository(ActivityLog);
const agentRepo = ds.getRepository(RuntimeHost); // P4c-4: manager-tier = Host 행

function registerTools(ctxOverrides = {}) {
  const handlers = new Map();
  const server = { tool(name, _description, _schema, handler) { handlers.set(name, handler); } };
  const ctx = {
    dataSource: ds, activityService, mentionService: mentionServiceStub,
    logger: logStub, ticketRoleAssignmentService: null, roomMessagingService: null,
    instanceQuiesceService: { isQuiesced: async () => false },
    ...ctxOverrides,
  };
  registerCommentTools(server, ctx);
  return handlers;
}

async function makeTicket(overrides = {}) {
  return ticketRepo.save(ticketRepo.create({
    title: 'T', account_id: 'w1', pending_user_action: false, ...overrides,
  }));
}
/** agent-manager가 fire-and-forget 자동 알림에 사용하는 페어링 발급 신원이다. */
async function makeManagerAgent(name = 'Manager') {
  return agentRepo.save(agentRepo.create({ name, hostname: 'auto-notice-test' }));
}
/** auto_notice를 활성화할 권한이 없는 일반 디스패치 agent다. */
// P4c-4: 일반 agent 는 Host 행이 없어 manager-tier 가 아니다 — id 만 쓴다 (행 없음).
const { randomUUID } = await import('node:crypto');
async function makeRegularAgent(name = 'Assignee', type = 'claude') {
  void name; void type;
  return { id: randomUUID(), name };
}
function parse(res) {
  return JSON.parse(res.content[0].text);
}
function authenticatedExtra(agent) {
  const sessionId = `auto-notice-${agent.id}-${Math.random()}`;
  sessionStore.register(sessionId, { close: async () => {} }, {}, {
    agentId: agent.id, agentName: agent.name, accountId: 'w1', source: 'db',
  });
  return { sessionId };
}
/** 같은 Host 에 묶인 런타임(rt-) 키 세션 — agentId 가 Host id 다(mcp-http-auth). */
function runtimeKeyExtra(host, runtimeKey) {
  const sessionId = `auto-notice-rt-${runtimeKey}-${Math.random()}`;
  sessionStore.register(sessionId, { close: async () => {} }, {}, {
    agentId: host.id, runtimeKey, agentName: `runtime:worker:${runtimeKey}`, accountId: 'w1', source: 'db',
  });
  return { sessionId };
}
async function lastActivityFor(commentId) {
  const rows = await activityRepo.find({
    where: { entity_type: 'comment', entity_id: commentId },
    order: { created_at: 'DESC' },
  });
  return rows[0];
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('auto_notice:true from a manager-tier agent (Agent.type=manager) stamps actor_id=system on the first insert', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const manager = await makeManagerAgent();

  const comment = parse(await addComment({
    ticket_id: t.id, content: '⚠️ 중복 dispatch 억제 — 새 트리거를 무시했습니다.',
    author_type: 'agent', author_id: manager.id, author: 'Manager',
    metadata: { auto_notice: true },
  }, authenticatedExtra(manager)));

  const log = await lastActivityFor(comment.id);
  assert.equal(log.action, 'created');
  assert.equal(log.actor_id, 'system',
    'auto_notice from the Host\'s manager key must stamp actor_id=system so the dispatcher does not count it as progress');
});

test('auto_notice:true does not change the saved comment\'s own author attribution', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const manager = await makeManagerAgent();

  const comment = parse(await addComment({
    ticket_id: t.id, content: '⚠️ 중복 dispatch 억제 — 새 트리거를 무시했습니다.',
    author_type: 'agent', author_id: manager.id, author: 'Manager',
    metadata: { auto_notice: true },
  }, authenticatedExtra(manager)));

  assert.equal(comment.author_id, manager.id, 'the comment row itself still attributes to the real caller');
  assert.equal(comment.author, 'Manager');
  const reloaded = await commentRepo.findOne({ where: { id: comment.id } });
  assert.equal(reloaded.author_id, manager.id);
});

test('without auto_notice, the activity-log actor_id stays the real caller (baseline unchanged)', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const manager = await makeManagerAgent();

  const comment = parse(await addComment({
    ticket_id: t.id, content: 'ordinary note', author_type: 'agent', author_id: manager.id, author: 'Manager',
  }, authenticatedExtra(manager)));

  const log = await lastActivityFor(comment.id);
  assert.equal(log.actor_id, manager.id, 'omitting auto_notice must not change pre-existing attribution behavior');
});

test('auto_notice:false (explicit) behaves identically to omitting it', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const manager = await makeManagerAgent();

  const comment = parse(await addComment({
    ticket_id: t.id, content: 'ordinary note', author_type: 'agent', author_id: manager.id, author: 'Manager',
    metadata: { auto_notice: false },
  }, authenticatedExtra(manager)));

  const log = await lastActivityFor(comment.id);
  assert.equal(log.actor_id, manager.id);
});

test('auto_notice combined with dedupe_key: both the first insert and the folded bump log actor_id=system', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const manager = await makeManagerAgent();

  const first = parse(await addComment({
    ticket_id: t.id, content: '⚠️ 중복 dispatch 억제 (attempt 1)',
    author_type: 'agent', author_id: manager.id, author: 'Manager',
    metadata: { auto_notice: true, dedupe_key: 'dispatch_suppress:inflight:t1:assignee:a1' },
  }, authenticatedExtra(manager)));
  const second = parse(await addComment({
    ticket_id: t.id, content: '⚠️ 중복 dispatch 억제 (attempt 2)',
    author_type: 'agent', author_id: manager.id, author: 'Manager',
    metadata: { auto_notice: true, dedupe_key: 'dispatch_suppress:inflight:t1:assignee:a1' },
  }, authenticatedExtra(manager)));
  assert.equal(second.id, first.id, 'still folds into one row — auto_notice does not disturb the dedupe path');
  assert.equal(second.repeat_count, 2);

  const logs = await activityRepo.find({
    where: { entity_type: 'comment', entity_id: first.id },
    order: { created_at: 'ASC' },
  });
  assert.equal(logs.length, 2);
  assert.equal(logs[0].action, 'created');
  assert.equal(logs[0].actor_id, 'system', 'first (unfolded) auto_notice occurrence already logs actor_id=system');
  assert.equal(logs[1].action, 'updated');
  assert.equal(logs[1].actor_id, 'system', 'the dedupe-bump path already logged actor_id=system independently of auto_notice');
});

test('an unrelated comment interleaved between two auto_notice occurrences: the fresh (unfolded) row still logs actor_id=system', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const manager = await makeManagerAgent();

  const a = parse(await addComment({
    ticket_id: t.id, content: '⚠️ 중복 dispatch 억제 (a)', author_type: 'agent', author_id: manager.id, author: 'Manager',
    metadata: { auto_notice: true, dedupe_key: 'k1' },
  }, authenticatedExtra(manager)));
  await addComment({
    ticket_id: t.id, content: 'human reply in between', author_type: 'user', author_id: 'u1', author: 'User',
  }, {});
  const c = parse(await addComment({
    ticket_id: t.id, content: '⚠️ 중복 dispatch 억제 (c)', author_type: 'agent', author_id: manager.id, author: 'Manager',
    metadata: { auto_notice: true, dedupe_key: 'k1' },
  }, authenticatedExtra(manager)));

  assert.notEqual(c.id, a.id, 'the intervening reply breaks the dedupe chain — this is the exact busy-ticket scenario the ticket reproduces');
  const log = await lastActivityFor(c.id);
  assert.equal(log.actor_id, 'system',
    'even though it could not fold, the fresh occurrence still must not self-trigger — this is the case the dedupe_key fold alone cannot cover');
});

// ── 거부/대조 테스트 (ticket 3c8b8026 리뷰 라운드1 지적1) ────────────────

test('auto_notice:true from a REGULAR (non-manager) agent is ignored — actor_id stays the real caller, comment triggers normally', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const regular = await makeRegularAgent('Assignee', 'claude');

  const comment = parse(await addComment({
    ticket_id: t.id, content: 'this is a substantive comment, not a system notice',
    author_type: 'agent', author_id: regular.id, author: 'Assignee',
    metadata: { auto_notice: true },
  }, {}));

  const log = await lastActivityFor(comment.id);
  assert.equal(log.action, 'created');
  assert.equal(log.actor_id, regular.id,
    'a non-manager-type agent cannot self-declare auto_notice to exempt its own comment from triggering');
});

test('auto_notice:true does not error for an unauthorized caller — the comment still saves normally', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const regular = await makeRegularAgent();

  const res = await addComment({
    ticket_id: t.id, content: 'trying to fake a system notice',
    author_type: 'agent', author_id: regular.id, author: 'Assignee',
    metadata: { auto_notice: true },
  }, {});
  const parsed = parse(res);
  assert.ok(parsed.id, 'the call succeeds (silently ignoring the unauthorized flag, not rejecting the whole call)');
  assert.ok(!parsed.suppressed, 'not treated as a suppression outcome either');
});

test('auto_notice:true with an author_id that matches no Agent row at all is ignored', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  const comment = parse(await addComment({
    ticket_id: t.id, content: 'forged author id, no matching Agent row',
    author_type: 'agent', author_id: 'nonexistent-agent-id', author: 'Ghost',
    metadata: { auto_notice: true },
  }, {}));

  const log = await lastActivityFor(comment.id);
  assert.equal(log.actor_id, 'nonexistent-agent-id',
    'an author_id with no backing Agent row must not be treated as manager-tier');
});

test('auto_notice:true from a user-type author (not an agent at all) is ignored', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();

  const comment = parse(await addComment({
    ticket_id: t.id, content: 'a human typed this',
    author_type: 'user', author_id: 'u-1', author: 'Human',
    metadata: { auto_notice: true },
  }, {}));

  const log = await lastActivityFor(comment.id);
  assert.equal(log.actor_id, 'u-1', 'user-authored comments are never eligible for auto_notice regardless of the flag');
});

test('a manager-tier agent posting WITHOUT auto_notice still logs its real actor_id (the tier alone does not suppress triggering)', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const manager = await makeManagerAgent();

  const comment = parse(await addComment({
    ticket_id: t.id, content: 'a substantive manager-authored comment, not a notice',
    author_type: 'agent', author_id: manager.id, author: 'Manager',
  }, authenticatedExtra(manager)));

  const log = await lastActivityFor(comment.id);
  assert.equal(log.actor_id, manager.id,
    'being manager-tier is necessary but not sufficient — the caller must ALSO opt in via auto_notice:true');
});

test('일반 에이전트 인증 세션이 Manager author_id를 주입해도 auto_notice 권한을 얻지 못한다', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const manager = await makeManagerAgent('Forged Manager');
  const regular = await makeRegularAgent('Authenticated Assignee');

  const comment = parse(await addComment({
    ticket_id: t.id, content: '위조한 자동 알림',
    author_type: 'agent', author_id: manager.id, author: 'Forged Manager',
    metadata: { auto_notice: true },
  }, authenticatedExtra(regular)));

  const log = await lastActivityFor(comment.id);
  assert.equal(log.actor_id, manager.id,
    '요청 author가 manager여도 인증 호출자가 다르면 system actor로 바뀌지 않아야 한다');
});

test('a runtime key on the same Host cannot post the manager\'s notice, even naming the Host as author', async () => {
  const handlers = registerTools();
  const addComment = handlers.get('add_comment');
  const t = await makeTicket();
  const host = await makeManagerAgent('Runtime Host');

  const comment = parse(await addComment({
    ticket_id: t.id, content: '진행 보고를 매니저 알림처럼',
    author_type: 'agent', author_id: host.id,
    metadata: { auto_notice: true },
  }, runtimeKeyExtra(host, 'rt-0123456789abcdef')));

  const log = await lastActivityFor(comment.id);
  assert.equal(log.actor_id, host.id, 'only the Host\'s manager key (no runtime key) speaks for the manager');
});

test('no caller gets actor system by naming itself the author — on any of the four comment tools', async () => {
  const handlers = registerTools();
  const t = await makeTicket();
  const host = await makeManagerAgent('Runtime Host');
  const regular = await makeRegularAgent();
  const callers = [
    { name: 'agent session', extra: () => authenticatedExtra(regular), actor: regular.id },
    { name: 'runtime key', extra: () => runtimeKeyExtra(host, 'rt-fedcba9876543210'), actor: 'rt-fedcba9876543210' },
    { name: 'manager key', extra: () => authenticatedExtra(host), actor: host.id },
    { name: 'no session', extra: () => ({}), actor: '' },
  ];
  for (const caller of callers) {
    const question = parse(await handlers.get('ask_question')({
      ticket_id: t.id, content: 'q', author_id: 'system',
    }, caller.extra()));
    const written = [
      question,
      parse(await handlers.get('add_comment')({ ticket_id: t.id, content: 'c', author_id: 'system' }, caller.extra())),
      parse(await handlers.get('add_comment')({
        ticket_id: t.id, content: 'n', author_id: 'system', metadata: { auto_notice: true },
      }, caller.extra())),
      parse(await handlers.get('answer_question')({ question_comment_id: question.id, content: 'a', author_id: 'system' }, caller.extra())),
      parse(await handlers.get('record_decision')({ ticket_id: t.id, content: 'd', author_id: 'system' }, caller.extra())),
    ];
    for (const comment of written) {
      assert.ok(comment.id, `${caller.name}: written ${JSON.stringify(comment)}`);
      assert.equal(comment.author_id, 'system', `${caller.name}: the comment keeps the author it was given`);
      const log = await lastActivityFor(comment.id);
      assert.equal(log.actor_id, caller.actor, `${caller.name} ${comment.type}: the activity names the caller, not 'system'`);
    }
  }
});
