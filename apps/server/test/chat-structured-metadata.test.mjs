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

  // ── 3. "누락 없이" — the 20 + 1 two-message path (F-1 3차 재요청) ──────────────
  // The server bounds EACH message's ticket_refs at MAX_TICKET_REFS (20), so the
  // agent-manager CHUNKS a >20-action turn across multiple messages. This asserts the
  // server side of that contract: (a) a single 21-ref message is bounded to 20 (the
  // reason the manager must chunk rather than lean on one message), and (b) the
  // manager's chunked output — one message of 20 + one of 1 — both persist in full, so
  // all 21 ticket_ids survive across the pair (no action silently dropped).

  // (a) one over-sized message → the sanitizer keeps the first 20 (per-message defense).
  const twentyOne = Array.from({ length: 21 }, (_, i) => ({ action: 'create', ticket_id: `big-${i}` }));
  const bigRes = await sendAgentMessage({ agent_id: responder.id, content: 'oversized single message', metadata: { ticket_refs: twentyOne } });
  const bigBody = await bigRes.json();
  assert.equal(bigRes.status, 201, 'oversized send still succeeds');
  assert.equal(bigBody.metadata?.ticket_refs.length, 20, 'a single message is bounded to 20 — the manager must not rely on one message for 21');

  // (b) the manager's chunked output: message A (a full 20) + message B (the overflow 1).
  const chunkA = Array.from({ length: 20 }, (_, i) => ({ action: 'create', ticket_id: `chunk-${i}` }));
  const chunkB = [{ action: 'create', ticket_id: 'chunk-20' }];
  const aBody = await (await sendAgentMessage({ agent_id: responder.id, content: 'chunk A', metadata: { ticket_refs: chunkA } })).json();
  const bBody = await (await sendAgentMessage({ agent_id: responder.id, content: 'chunk B', metadata: { ticket_refs: chunkB } })).json();
  assert.equal(aBody.metadata?.ticket_refs.length, 20, 'chunk A (a full 20) persists intact');
  assert.equal(bBody.metadata?.ticket_refs.length, 1, 'chunk B (the 21st) persists intact');

  // Read history back and prove all 21 chunk ids are present across the two persisted rows.
  const hist2 = await (await fetch(`${base}/api/agent/chat-rooms/${room.id}/messages`, { headers: { 'X-Agent-Key': responderKey.raw_key } })).json();
  const rows2 = Array.isArray(hist2) ? hist2 : (hist2?.messages ?? []);
  const chunkIds = new Set();
  for (const m of rows2) {
    if (!Array.isArray(m.metadata?.ticket_refs)) continue;
    for (const r of m.metadata.ticket_refs) if (String(r.ticket_id).startsWith('chunk-')) chunkIds.add(r.ticket_id);
  }
  assert.equal(chunkIds.size, 21, 'all 21 chunk ticket_ids survive across the 20 + 1 message pair (누락 없이)');

  // No process.exit — the suite runs with --test-force-exit.
});

// F2-4 (ticket d21b28fc): 결과물(artifact_refs) 카드 + 승인(detail) 확장이 같은
// 채팅 표면(REST 201 · SSE wire · history read-back)을 ticket_refs 와 독립적으로
// 왕복하는지, 그리고 서버 sanitizer 가 두 배열을 서로 무너뜨리지 않는지 고정한다.
test('F2-4: artifact_refs + detail round-trip REST 201 + SSE wire + history; 독립 sanitation', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) + 1 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'chat-meta-f24' });
  const user = await createUser(app, getDataSourceToken, { name: 'human24' });
  const userToken = app.get(AuthService).createSession(user.id);
  const responder = await createAgent(app, getDataSourceToken, ws.id, { name: 'responder24' });
  const responderKey = await createApiKey(app, getDataSourceToken, responder.id, { workspaceId: ws.id, label: 'responder24' });

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

  // ── 1. artifact_refs (build + deploy) round-trip REST + SSE + history ────────
  const artifactRefs = [
    { kind: 'build', title: 'server', status: 'ok', commit: 'abc1234' },
    { kind: 'deploy', title: 'production', status: 'deployed', commit: 'def5678', url: 'https://app.example.com' },
  ];
  const aRes = await sendAgentMessage({
    agent_id: responder.id,
    content: '📦 빌드: server (ok)\n📦 배포: production (deployed)',
    metadata: { artifact_refs: artifactRefs },
  });
  const aBody = await aRes.json();
  assert.equal(aRes.status, 201, `artifact send should 201: ${JSON.stringify(aBody)}`);
  assert.deepEqual(aBody.metadata?.artifact_refs, artifactRefs, 'REST return carries metadata.artifact_refs');
  assert.equal(aBody.metadata?.ticket_refs, undefined, 'artifact-only message carries no ticket_refs key');

  const aFrame = await userStream.waitFor(
    'chat_room_message',
    (d) => (d?.metadata?.artifact_refs?.length ?? 0) === 2,
    4000,
  );
  assert.ok(aFrame, 'participant receives chat_room_message with metadata.artifact_refs on the SSE wire');
  const aWire = aFrame.data ?? aFrame;
  assert.equal(aWire.metadata.artifact_refs[0].kind, 'build', 'wire artifact[0] kind');
  assert.equal(aWire.metadata.artifact_refs[1].url, 'https://app.example.com', 'wire artifact[1] url survives');

  const aHist = await (await fetch(`${base}/api/agent/chat-rooms/${room.id}/messages`, { headers: { 'X-Agent-Key': responderKey.raw_key } })).json();
  const aRows = Array.isArray(aHist) ? aHist : (aHist?.messages ?? []);
  const aPersisted = aRows.find((m) => Array.isArray(m.metadata?.artifact_refs));
  assert.ok(aPersisted, 'history read-back returns a message with parsed metadata.artifact_refs');
  assert.equal(aPersisted.metadata.artifact_refs.length, 2, 'both artifact refs persisted + read back');

  // ── 2. detail (승인 카드 배지) 는 ticket_refs 에서 보존된다 ──────────────────
  const proposeRes = await sendAgentMessage({
    agent_id: responder.id,
    content: '📋 티켓 이동 제안: 제안 티켓',
    metadata: { ticket_refs: [{ action: 'propose', ticket_id: 'ticket-prop', title: '제안 티켓', detail: 'Review', bogus: 'strip' }] },
  });
  const proposeBody = await proposeRes.json();
  assert.equal(proposeRes.status, 201, 'propose send succeeds');
  assert.deepEqual(
    proposeBody.metadata?.ticket_refs?.[0],
    { action: 'propose', ticket_id: 'ticket-prop', title: '제안 티켓', detail: 'Review' },
    'detail 보존 + 미지의 키 제거',
  );

  // ── 3. 독립 sanitation: 한 배열이 비어도 다른 배열은 살아남는다 ───────────────
  // (a) artifact_refs 만 유효(ticket_refs 는 malformed) → artifact 만 남고 ticket 은 없음.
  const mixRes = await sendAgentMessage({
    agent_id: responder.id,
    content: 'artifact only, ticket junk',
    metadata: { ticket_refs: 'not-an-array', artifact_refs: [{ kind: 'build', title: 'client' }] },
  });
  const mixBody = await mixRes.json();
  assert.equal(mixBody.metadata?.ticket_refs, undefined, 'malformed ticket_refs dropped');
  assert.deepEqual(mixBody.metadata?.artifact_refs, [{ kind: 'build', title: 'client' }], '유효한 artifact_refs 는 생존');

  // (b) kind/title 없는 artifact ref 는 제거; 둘 다 비면 metadata 자체가 drop.
  const badArtifactRes = await sendAgentMessage({
    agent_id: responder.id,
    content: 'all-bad metadata',
    metadata: { artifact_refs: [{ kind: 'build' }, { title: 'x' }, 'nope'] },
  });
  const badArtifactBody = await badArtifactRes.json();
  assert.equal(badArtifactBody.metadata, undefined, 'kind/title 없는 ref 만 있으면 metadata drop');

  // (c) 둘 다 유효 → 둘 다 생존(한 메시지가 ticket + artifact 를 함께 실을 수 있다).
  const bothRes = await sendAgentMessage({
    agent_id: responder.id,
    content: 'both refs',
    metadata: {
      ticket_refs: [{ action: 'move', ticket_id: 'ticket-both' }],
      artifact_refs: [{ kind: 'deploy', title: 'staging', status: 'deployed' }],
    },
  });
  const bothBody = await bothRes.json();
  assert.equal(bothBody.metadata?.ticket_refs?.length, 1, 'ticket_refs 생존');
  assert.equal(bothBody.metadata?.artifact_refs?.length, 1, 'artifact_refs 생존');

  // No process.exit — the suite runs with --test-force-exit.
});
