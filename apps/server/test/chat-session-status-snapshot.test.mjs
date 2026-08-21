// Regression for ticket e18be8ff review round 1, P1 #2 — "새로고침·방 재진입
// 시 이미 활성인 세션 상태를 복원할 수 없습니다." The chat_room_session_status
// SSE push (agent-fullname-orchestration-typing.test.mjs, case 6) is
// fire-and-forget: a client that opens/re-enters a room between pushes had no
// way to learn there's a currently-active keep-alive or live background task.
//
// GET /api/chat-rooms/:roomId/session-status (user-auth surface, distinct
// from the agent-auth POST at /api/agent/chat-rooms/:roomId/session-status)
// now answers exactly that question from the in-memory last-known-status
// cache in chat-session-status.store.ts. This test drives the real POST →
// store → GET path end to end, plus the liveness-pruning contract the store
// shares with the client's own isSessionStatusLive filter (a "not live" push
// — no future keep-alive deadline and no background tasks — must not surface
// on the next GET).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '7891';

async function seedGroupRoom(ds, { workspaceId, participants }) {
  const roomRepo = ds.getRepository('ChatRoom');
  const partRepo = ds.getRepository('ChatRoomParticipant');
  const room = await roomRepo.save(roomRepo.create({
    workspace_id: workspaceId,
    type: 'group',
    name: 'session-status snapshot room',
    created_by_type: 'user',
    created_by: 'tester',
  }));
  for (const p of participants) {
    await partRepo.save(partRepo.create({
      room_id: room.id,
      participant_type: p.type,
      participant_id: p.id,
      joined_at: new Date(),
    }));
  }
  return room;
}

test('GET session-status: a live push is visible on the next room entry without waiting for a fresh SSE frame', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'chat-session-status-snapshot' });
  const user = await createUser(app, getDataSourceToken, { name: 'viewer' });
  const userToken = app.get(AuthService).createSession(user.id);
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });
  const agentKey = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'status-poster' });

  const room = await seedGroupRoom(ds, {
    workspaceId: ws.id,
    participants: [{ type: 'user', id: user.id }, { type: 'agent', id: agent.id }],
  });

  // GET before any push — nothing has ever been posted, must be an empty snapshot.
  const beforeRes = await fetch(`${base}/api/chat-rooms/${room.id}/session-status`, {
    headers: { Authorization: `Bearer ${userToken}`, 'X-Workspace-Id': ws.id },
  });
  assert.equal(beforeRes.status, 200);
  assert.deepEqual(await beforeRes.json(), [], 'no session-status has ever been posted for this room yet');

  // Agent-manager posts a live keep-alive + background-task-count.
  const keepAliveUntilMs = Date.now() + 10 * 60_000;
  const postRes = await fetch(`${base}/api/agent/chat-rooms/${room.id}/session-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': agentKey.raw_key },
    body: JSON.stringify({ agent_id: agent.id, keep_alive_until_ms: keepAliveUntilMs, background_task_count: 3 }),
  });
  assert.ok(postRes.ok, `session-status POST should succeed: ${await postRes.text()}`);

  // A user who was NOT subscribed to any SSE stream (simulates opening the
  // room fresh, e.g. after a page reload) must still see the live state.
  const afterRes = await fetch(`${base}/api/chat-rooms/${room.id}/session-status`, {
    headers: { Authorization: `Bearer ${userToken}`, 'X-Workspace-Id': ws.id },
  });
  assert.equal(afterRes.status, 200);
  const afterBody = await afterRes.json();
  assert.equal(afterBody.length, 1, 'the live push must be visible on room entry without a fresh SSE frame');
  assert.equal(afterBody[0].agent_id, agent.id);
  assert.equal(afterBody[0].keep_alive_until_ms, keepAliveUntilMs,
    'the snapshot must carry the absolute deadline, not a pre-computed remaining-minutes string');
  assert.equal(afterBody[0].background_task_count, 3);

  // A "not live" push (deadline already past, no background tasks) — the
  // same liveness contract the client's isSessionStatusLive() enforces —
  // must be pruned from the snapshot rather than lingering as a stale entry.
  const notLiveRes = await fetch(`${base}/api/agent/chat-rooms/${room.id}/session-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': agentKey.raw_key },
    body: JSON.stringify({ agent_id: agent.id, keep_alive_until_ms: Date.now() - 1000, background_task_count: 0 }),
  });
  assert.ok(notLiveRes.ok);

  const clearedRes = await fetch(`${base}/api/chat-rooms/${room.id}/session-status`, {
    headers: { Authorization: `Bearer ${userToken}`, 'X-Workspace-Id': ws.id },
  });
  assert.deepEqual(await clearedRes.json(), [],
    'an expired-deadline / no-background-task push must clear the room snapshot, not persist a stale "0분" entry');
});
