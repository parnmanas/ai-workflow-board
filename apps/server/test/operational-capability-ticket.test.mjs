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
  const post = (messageId) => fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace_id: ws.id, board_id: board.id, dedupe_key: 'deploy-awb-key',
      operation: 'deploy awb', missing_capability: 'awb deploy action',
      original_request: 'AWB 배포해라', room_id: 'room-1', message_id: messageId,
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

  // Retrying that same source is idempotent; a distinct source is retained.
  assert.equal((await post('message-b')).status, 200);
  assert.equal((await post('message-c')).status, 200);
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

test.after(() => exitAfterTests());
