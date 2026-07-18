// Integration test — F-1 (ticket 24694916): structured ticket-action card
// metadata round-trips end-to-end over the REAL chat surface.
//
// The agent-manager captures ticket-action refs from mcp__awb__* tool results and
// POSTs them as `metadata.ticket_refs` on a chat message via the agent-api send
// endpoint (POST /api/agent/chat-rooms/:roomId/messages). This test drives that
// exact path against a booted app and asserts the metadata survives all three
// contract surfaces the client depends on:
//   1. the REST 201 response body (RoomMessagingService.sendMessage return)
//   2. the chat_room_message SSE wire (event-registry map()/flatten — criterion #3)
//   3. the GET history projection (getMessages — read-back through the column)
// plus the server-side sanitizer that bounds what an agent can persist.
//
// Acceptance criteria proven: #1 (a ticket action → a reliable card ref, no prose
// token needed), #2 (metadata persists + reads back through the nullable column
// the Postgres migration adds), #3 (server↔wire contract carries the field).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '7799';

async function seedDmRoom(ds, { workspaceId, participants }) {
  const roomRepo = ds.getRepository('ChatRoom');
  const partRepo = ds.getRepository('ChatRoomParticipant');
  const room = await roomRepo.save(roomRepo.create({ workspace_id: workspaceId, type: 'dm', name: '' }));
  for (const p of participants) {
    await partRepo.save(partRepo.create({
      room_id: room.id,
      participant_type: p.type,
      participant_id: p.id,
      last_read_at: null,
      left_at: null,
    }));
  }
  return room;
}

test('F-1: ticket-action metadata round-trips REST 201 + SSE wire + history read-back', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'chat-meta' });
  const user = await createUser(app, getDataSourceToken, { name: 'human' });
  const userToken = app.get(AuthService).createSession(user.id);
  const responder = await createAgent(app, getDataSourceToken, ws.id, { name: 'responder' });
  const responderKey = await createApiKey(app, getDataSourceToken, responder.id, { workspaceId: ws.id, label: 'responder' });

  const room = await seedDmRoom(ds, {
    workspaceId: ws.id,
    participants: [{ type: 'user', id: user.id }, { type: 'agent', id: responder.id }],
  });

  const userStream = await openSseStream(port, userToken);
  t.after(() => userStream.close());
  await new Promise((r) => setTimeout(r, 200));

  const sendAgentMessage = (body) =>
    fetch(`${base}/api/agent/chat-rooms/${room.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': responderKey.raw_key },
      body: JSON.stringify(body),
    });

  // ── 1. Valid ticket_refs (create + move) round-trip ────────────────────────
  const ticketRefs = [
    { action: 'create', ticket_id: 'ticket-aaa', title: '새 티켓' },
    { action: 'move', ticket_id: 'ticket-bbb', title: '이동한 티켓' },
  ];
  const res = await sendAgentMessage({
    agent_id: responder.id,
    content: '📋 티켓 생성: 새 티켓\n📋 티켓 이동: 이동한 티켓',
    metadata: { ticket_refs: ticketRefs },
  });
  const body = await res.json();
  assert.equal(res.status, 201, `agent send should 201: ${JSON.stringify(body)}`);

  // (a) REST 201 body carries the parsed refs.
  assert.deepEqual(body.metadata?.ticket_refs, ticketRefs, 'REST return carries metadata.ticket_refs');

  // (b) SSE wire (event-registry map + flatten) carries the refs — the seam the
  //     client BoardStreamContext reads. This is the real wire, not an in-memory obj.
  const frame = await userStream.waitFor(
    'chat_room_message',
    (d) => (d?.metadata?.ticket_refs?.length ?? 0) === 2,
    4000,
  );
  assert.ok(frame, 'participant must receive chat_room_message with metadata.ticket_refs on the SSE wire');
  const wire = frame.data ?? frame;
  assert.equal(wire.metadata.ticket_refs[0].ticket_id, 'ticket-aaa', 'wire ref[0] ticket_id');
  assert.equal(wire.metadata.ticket_refs[0].action, 'create', 'wire ref[0] action');
  assert.equal(wire.metadata.ticket_refs[1].title, '이동한 티켓', 'wire ref[1] title');

  // (c) GET history projection reads the metadata back through the persisted column.
  const histRes = await fetch(`${base}/api/agent/chat-rooms/${room.id}/messages`, {
    headers: { 'X-Agent-Key': responderKey.raw_key },
  });
  const hist = await histRes.json();
  const rows = Array.isArray(hist) ? hist : (hist?.messages ?? []);
  const persisted = rows.find((m) => Array.isArray(m.metadata?.ticket_refs));
  assert.ok(persisted, 'history read-back returns a message with parsed metadata.ticket_refs');
  assert.equal(persisted.metadata.ticket_refs.length, 2, 'both refs persisted + read back');

  // ── 2. Sanitizer bounds what an agent can persist ──────────────────────────
  // (a) ticket_refs not an array → metadata dropped entirely.
  const junkRes = await sendAgentMessage({
    agent_id: responder.id,
    content: 'junk metadata send',
    metadata: { ticket_refs: 'not-an-array', evil: { huge: 'x'.repeat(10) } },
  });
  const junkBody = await junkRes.json();
  assert.equal(junkRes.status, 201, 'junk-metadata send still succeeds (metadata is optional)');
  assert.equal(junkBody.metadata, undefined, 'malformed ticket_refs → metadata dropped, not persisted');

  // (b) mixed array: entries with no ticket_id are dropped; valid ones survive
  //     and unknown keys are stripped to the {action,ticket_id,title} shape.
  const mixedRes = await sendAgentMessage({
    agent_id: responder.id,
    content: 'mixed metadata send',
    metadata: {
      ticket_refs: [
        { action: 'comment', ticket_id: 'ticket-ccc', title: 'ok', bogus: 'strip-me' },
        { action: 'move' }, // no ticket_id → dropped
        { ticket_id: 'ticket-ddd' }, // no action → kept with action:''
      ],
    },
  });
  const mixedBody = await mixedRes.json();
  assert.equal(mixedRes.status, 201, 'mixed-metadata send succeeds');
  const kept = mixedBody.metadata?.ticket_refs;
  assert.equal(kept.length, 2, 'only refs with a ticket_id survive');
  assert.deepEqual(kept[0], { action: 'comment', ticket_id: 'ticket-ccc', title: 'ok' }, 'unknown keys stripped');
  assert.deepEqual(kept[1], { action: '', ticket_id: 'ticket-ddd' }, 'action defaults to empty, no title key');

  // No process.exit — the suite runs with --test-force-exit.
});
