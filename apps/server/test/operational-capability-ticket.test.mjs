import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createApiKey, setupKanbanScene } from './helpers/fixtures.mjs';

// 이 파일의 테스트 4개는 각자 자기 NestJS 앱을 부팅한다. 예전에는 전부
// 고정 포트 하나(7827)를 다시 바인딩했는데, close() 한 앞 서버가 아직
// 소켓을 놓지 못한 상태에서 다음 테스트가 bind 하면 EADDRINUSE 로 깨졌다
// (부하 걸린 전체 스위트에서만 재현되는 flake, ticket 6a9a3fe4). 고정 지연
// 으로 덮는 대신 `port: 0` 으로 OS 에 빈 포트를 받아 쓴다 — bootApp() 이
// 실제 바인딩된 포트를 돌려주므로 아래 URL 들은 그 값을 쓴다.

test('operational fallback is exactly-once, traces concurrent recurrence, clears on terminal', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
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
  const { app, port, modules } = await bootApp({ port: 0 });
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

test('ordinary work board candidates include only boards with an active workflow column', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const { ws, board } = await setupKanbanScene(app, modules.getDataSourceToken, { workspaceName: 'ordinary-work-candidates' });
  const manager = await createAgent(app, modules.getDataSourceToken, ws.id, {
    name: 'ordinary-work-candidate-agent', hosted: false,
  });
  const key = await createApiKey(app, modules.getDataSourceToken, manager.id, {
    workspaceId: ws.id, label: 'ordinary-work-candidates',
  });
  const columns = await ds.getRepository('BoardColumn').find({ where: { board_id: board.id } });
  await ds.getRepository('BoardColumn').update(
    columns.filter(column => !column.is_terminal).map(column => column.id),
    { is_terminal: true },
  );

  const response = await fetch(`http://127.0.0.1:${port}/api/agent/ordinary-work-board-candidates?workspace_id=${ws.id}`, {
    headers: { 'X-Agent-Key': key.raw_key },
  });
  assert.equal(response.status, 200);
  const candidates = await response.json();
  assert.equal(candidates.some(candidate => candidate.id === board.id), false,
    '활성 비종료 컬럼이 없는 보드는 생성 후보로 노출하지 않는다');
});

test('ordinary work fallback retry recovers dispatch after post-commit emission failure', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const { ws, board } = await setupKanbanScene(app, modules.getDataSourceToken, { workspaceName: 'ordinary-work-recovery' });
  const activityService = app.get(modules.ActivityService);
  const originalEmitLogged = activityService.emitLogged.bind(activityService);
  let attempts = 0;
  activityService.emitLogged = (rows) => {
    attempts += 1;
    if (attempts === 1) throw new Error('의도한 방출 실패');
    return originalEmitLogged(rows);
  };
  t.after(() => { activityService.emitLogged = originalEmitLogged; });
  const payload = {
    workspace_id: ws.id, board_id: board.id, dedupe_key: 'recover-dispatch-key',
    title: '방출 복구', room_id: 'room-recovery', message_id: 'message-recovery',
  };
  const post = () => fetch(`http://127.0.0.1:${port}/api/agent/ordinary-work-ticket`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal((await post()).status, 503, '커밋 뒤 방출 실패를 성공으로 숨기지 않는다');
  assert.equal((await post()).status, 200, '같은 요청 재시도가 durable activity를 다시 방출한다');
  const tickets = await ds.getRepository('Ticket').find({ where: { operational_dedupe_key: 'ordinary:recover-dispatch-key' } });
  assert.equal(tickets.length, 1);
  assert.equal(await ds.getRepository('ActivityLog').count({
    where: { ticket_id: tickets[0].id, action: 'created' },
  }), 1, '생성 activity는 티켓과 같은 트랜잭션에서 정확히 한 건 저장된다');
  assert.equal(attempts, 2, '재시도가 누락된 워크플로 방출을 정확히 복구한다');
  const activity = await ds.getRepository('ActivityLog').findOneByOrFail({ ticket_id: tickets[0].id, action: 'created' });
  assert.equal(activity.new_value, 'dispatched', '복구 성공 뒤 durable dispatch intent를 완료 처리한다');
});

test.after(() => exitAfterTests());
