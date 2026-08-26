import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { setupKanbanScene } from './helpers/fixtures.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '7827';

test('operational fallback is exactly-once, traces concurrent recurrence, clears on terminal', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const { ws, board } = await setupKanbanScene(app, modules.getDataSourceToken, { workspaceName: 'operational-fallback' });
  const endpoint = `http://127.0.0.1:${port}/api/agent/operational-capability-ticket`;
  const post = (messageId, roomId = 'room-1') => fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace_id: ws.id, board_id: board.id, dedupe_key: 'deploy-awb-key',
      operation: 'deploy awb', missing_capability: 'awb deploy action',
      original_request: 'AWB 배포해라', room_id: roomId, message_id: messageId,
    }),
  });

  // Two initial requests exercise the open lookup/create unique race. Both
  // callers must converge on one ticket, and the loser source must be traced.
  const responses = await Promise.all([post('message-a'), post('message-b')]);
  assert.ok(responses.every(r => r.status === 200 || r.status === 201));
  const bodies = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(bodies.map(body => body.id)).size, 1);
  assert.equal(await ds.getRepository('Ticket').count({ where: { operational_dedupe_key: 'deploy-awb-key' } }), 1);

  const ticketId = bodies[0].id;
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

  const move = await fetch(`http://127.0.0.1:${port}/api/agent/move-ticket`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ boardId: board.id, ticketId, toColumn: 'Done' }),
  });
  assert.ok(move.status === 200 || move.status === 201);
  assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: ticketId })).operational_dedupe_key, null);
  const next = await post('message-d');
  assert.equal(next.status, 201, 'terminal completion permits a fresh capability ticket');
  assert.notEqual((await next.json()).id, ticketId);
});

test('ordinary work fallback creates one focused ticket on the selected board with chat provenance', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const { ws, board } = await setupKanbanScene(app, modules.getDataSourceToken, { workspaceName: 'ordinary-work-fallback' });
  const payload = {
    workspace_id: ws.id, board_id: board.id, dedupe_key: 'room-message-key',
    title: '일반 코드 수정', description: '회귀 테스트와 함께 수정한다.',
    original_request: '코드를 수정해줘', room_id: 'room-source', message_id: 'message-source',
  };
  const post = () => fetch(`http://127.0.0.1:${port}/api/agent/ordinary-work-ticket`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const first = await post();
  const second = await post();
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
  assert.equal(firstBody.id, secondBody.id);
  const tickets = await ds.getRepository('Ticket').find({ where: { operational_dedupe_key: 'ordinary:room-message-key' } });
  assert.equal(tickets.length, 1, '동일 채팅 요청은 focused ticket 한 건만 만든다');
  assert.equal(tickets[0].source_kind, 'chat');
  assert.equal(tickets[0].source_chat_room_id, 'room-source');
  const column = await ds.getRepository('BoardColumn').findOneByOrFail({ id: tickets[0].column_id });
  assert.equal(column.board_id, board.id, '선택한 기존 보드의 워크플로에 생성한다');
});

test.after(() => exitAfterTests());
