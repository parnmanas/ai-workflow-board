import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createProject, createTicket, createAccount } from './helpers/fixtures.mjs';

// 이 파일의 테스트들은 각자 자기 NestJS 앱을 부팅한다. 예전에는 전부
// 고정 포트 하나(7827)를 다시 바인딩했는데, close() 한 앞 서버가 아직
// 소켓을 놓지 못한 상태에서 다음 테스트가 bind 하면 EADDRINUSE 로 깨졌다
// (부하 걸린 전체 스위트에서만 재현되는 flake, ticket 6a9a3fe4). 고정 지연
// 으로 덮는 대신 `port: 0` 으로 OS 에 빈 포트를 받아 쓴다 — bootApp() 이
// 실제 바인딩된 포트를 돌려주므로 아래 URL 들은 그 값을 쓴다.
//
// 보드가 없어진 뒤(docs/tickets.md) 두 fallback 은 workspace 의 티켓 풀에
// tags / project_id 로 분류된 티켓을 TicketService 를 거쳐 만든다.

async function bootCapabilityScene(t, name) {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const ws = await createAccount(app, modules.getDataSourceToken, name);
  const post = (messageId, roomId = 'room-1') => fetch(`http://127.0.0.1:${port}/api/agent/operational-capability-ticket`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      account_id: ws.id, dedupe_key: 'deploy-awb-key',
      operation: 'deploy awb', missing_capability: 'awb deploy action',
      original_request: 'AWB 배포해라', room_id: roomId, message_id: messageId,
    }),
  });
  return { app, port, modules, ds, ws, post };
}

test('operational fallback is exactly-once and traces concurrent recurrence', async (t) => {
  const { ds, post } = await bootCapabilityScene(t, 'operational-fallback');

  // Two initial requests exercise the open lookup/create unique race. Both
  // callers must converge on one ticket, and the loser source must be traced.
  const responses = await Promise.all([post('message-a'), post('message-b')]);
  assert.ok(responses.every(r => r.status === 200 || r.status === 201));
  const bodies = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(bodies.map(body => body.id)).size, 1);
  assert.equal(await ds.getRepository('Ticket').count({ where: { operational_dedupe_key: 'deploy-awb-key' } }), 1);

  const ticketId = bodies[0].id;
  const ticket = await ds.getRepository('Ticket').findOneByOrFail({ id: ticketId });
  assert.equal(ticket.status, 'backlog', 'a capability gap is parked in backlog, not dispatched');
  assert.ok(JSON.parse(ticket.tags).includes('mcp-missing'), 'the capability ticket is tagged for triage');
  const comments = await ds.getRepository('Comment').find({ where: { ticket_id: ticketId } });
  assert.equal(comments.length, 1, 'the racing loser recurrence source was persisted');
  assert.match(comments[0].content, /message-(a|b)/);
  const loserMessageId = comments[0].content.match(/message-(?:a|b)/)?.[0];
  assert.ok(loserMessageId, 'the persisted recurrence identifies the racing loser source');

  // Retrying the actual loser source is idempotent. The same message id in a
  // different room is a distinct source and must be retained.
  assert.equal((await post(loserMessageId)).status, 200);
  assert.equal((await post(loserMessageId, 'room-2')).status, 200);
  const recurrence = await ds.getRepository('Comment').find({ where: { ticket_id: ticketId } });
  assert.equal(recurrence.length, 2);
  assert.deepEqual(new Set(recurrence.map(c => c.operational_recurrence_key)).size, 2);
});

// TicketService.move() releases operational_dedupe_key on entering done — only
// open work dedupes, a later request for a finished operation files new work.
test('operational fallback key is released when the ticket is done', async (t) => {
  const { app, ds, post } = await bootCapabilityScene(t, 'operational-fallback-done');
  const { TicketService, SYSTEM_ACTOR } = await import('../dist/modules/tickets/ticket.service.js');

  const first = await post('message-c');
  assert.equal(first.status, 201);
  const ticketId = (await first.json()).id;

  await app.get(TicketService).move(ticketId, 'done', SYSTEM_ACTOR);
  const done = await ds.getRepository('Ticket').findOneByOrFail({ id: ticketId });
  assert.equal(done.status, 'done');
  assert.equal(done.operational_dedupe_key, null, 'entering done releases the dedupe key');
  const next = await post('message-d');
  assert.equal(next.status, 201, 'done completion permits a fresh capability ticket');
  assert.notEqual((await next.json()).id, ticketId);
});

test('ordinary work fallback creates one focused ticket with tags, project and chat provenance', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const ws = await createAccount(app, modules.getDataSourceToken, 'ordinary-work-fallback');
  const project = await createProject(app, modules.getDataSourceToken, ws.id, { name: 'ordinary-work' });
  const payload = {
    account_id: ws.id, dedupe_key: 'room-message-key',
    title: '일반 코드 수정', description: '회귀 테스트와 함께 수정한다.',
    original_request: '코드를 수정해줘', room_id: 'room-source', message_id: 'message-source',
    tags: ['bugfix'], project_id: project.id,
  };
  const post = (body = payload) => fetch(`http://127.0.0.1:${port}/api/agent/ordinary-work-ticket`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const first = await post();
  const second = await post();
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
  assert.equal(firstBody.id, secondBody.id);
  const tickets = await ds.getRepository('Ticket').find({ where: { operational_dedupe_key: 'ordinary:room-message-key' } });
  assert.equal(tickets.length, 1, '동일 채팅 요청은 focused ticket 한 건만 만든다');
  assert.equal(tickets[0].account_id, ws.id);
  assert.equal(tickets[0].status, 'todo', '일반 작업은 바로 큐에 들어간다');
  assert.equal(tickets[0].source_kind, 'chat');
  assert.equal(tickets[0].source_chat_room_id, 'room-source');
  assert.equal(tickets[0].project_id, project.id, '선택한 project 로 분류한다');
  assert.deepEqual(JSON.parse(tickets[0].tags).sort(), ['bugfix', 'source:chat']);

  // A project from another workspace is rejected instead of silently dropped.
  const otherWs = await createAccount(app, modules.getDataSourceToken, 'ordinary-work-other');
  const foreign = await createProject(app, modules.getDataSourceToken, otherWs.id, { name: 'foreign' });
  const rejected = await post({ ...payload, dedupe_key: 'foreign-project-key', project_id: foreign.id });
  assert.equal(rejected.status, 404);
  assert.equal(await ds.getRepository('Ticket').count({ where: { operational_dedupe_key: 'ordinary:foreign-project-key' } }), 0);
});

test('ordinary work candidates list the workspace projects and its tag suggestions', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => { void app.close().catch(() => {}); });
  const gdst = modules.getDataSourceToken;
  const ws = await createAccount(app, gdst, 'ordinary-work-candidates');
  const otherWs = await createAccount(app, gdst, 'ordinary-work-candidates-other');
  const project = await createProject(app, gdst, ws.id, { name: 'game' });
  const foreign = await createProject(app, gdst, otherWs.id, { name: 'foreign' });
  await createTicket(app, gdst, { accountId: ws.id, title: 'one', tags: ['terrain', 'bug'] });
  await createTicket(app, gdst, { accountId: ws.id, title: 'two', tags: ['terrain'] });
  const archived = await createTicket(app, gdst, { accountId: ws.id, title: 'archived', tags: ['stale-tag'] });
  await app.get(gdst()).getRepository('Ticket').update(archived.id, { archived_at: new Date() });
  await createTicket(app, gdst, { accountId: otherWs.id, title: 'elsewhere', tags: ['foreign-tag'] });

  const response = await fetch(`http://127.0.0.1:${port}/api/agent/ordinary-work-candidates?account_id=${ws.id}`);
  assert.equal(response.status, 200);
  const candidates = await response.json();
  assert.deepEqual(candidates.projects.map(p => p.id), [project.id], '다른 워크스페이스 project 는 후보가 아니다');
  assert.equal(candidates.projects.some(p => p.id === foreign.id), false);
  assert.deepEqual(candidates.tags, [{ tag: 'terrain', count: 2 }, { tag: 'bug', count: 1 }],
    '활성 티켓의 tag 만, 많이 쓰인 순으로 제안한다');
});

test.after(() => exitAfterTests());
