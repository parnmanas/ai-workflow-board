// QA: chat_room_message SSE delivery is filtered to room participants only.
//
// ChatRoom + ChatRoomParticipant + chat_room_message is the current chat
// model (legacy chat_messages was dropped — see DropLegacyChatMessages
// migration). This test validates the critical scope filter at the SSE
// layer: only users/agents whose ID is in the room's participant set
// receive the event. Emitting directly via activityEvents bypasses the
// REST/MCP persistence path so the test is fast and focused — the goal
// here is the SSE fan-out, not the DB write.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createUser,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';
import { openSseStream } from '../helpers/sse-listener.mjs';

process.env.PORT = process.env.QA_CHAT_PORT || '7806';

test('chat_room_message is delivered only to the room participants', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'chat-room' });

  const agentInRoom = await createAgent(app, getDataSourceToken, ws.id, { name: 'insider' });
  const keyIn = await createApiKey(app, getDataSourceToken, agentInRoom.id, {
    workspaceId: ws.id,
    label: 'insider',
  });
  const agentOutOfRoom = await createAgent(app, getDataSourceToken, ws.id, { name: 'outsider' });
  const keyOut = await createApiKey(app, getDataSourceToken, agentOutOfRoom.id, {
    workspaceId: ws.id,
    label: 'outsider',
  });
  const userInRoom = await createUser(app, getDataSourceToken, { name: 'room-user' });
  const userOutOfRoom = await createUser(app, getDataSourceToken, { name: 'lurker' });
  const tokenIn = app.get(AuthService).createSession(userInRoom.id);
  const tokenOut = app.get(AuthService).createSession(userOutOfRoom.id);

  const insider = new VirtualAgent({
    name: 'insider',
    agentId: agentInRoom.id,
    apiKey: keyIn.raw_key,
    port,
  });
  const outsider = new VirtualAgent({
    name: 'outsider',
    agentId: agentOutOfRoom.id,
    apiKey: keyOut.raw_key,
    port,
  });
  await Promise.all([insider.start(), outsider.start()]);
  const userInStream = await openSseStream(port, tokenIn);
  const userOutStream = await openSseStream(port, tokenOut);
  t.after(async () => {
    userInStream.close();
    userOutStream.close();
    await Promise.all([insider.stop(), outsider.stop()]);
  });
  await new Promise((r) => setTimeout(r, 250));

  step('Emit chat_room_message with insider user+agent as participants');
  const roomId = 'room-qa-1';
  const content = 'hello room — from driver test';
  // member_ids + agent_member_ids are the scope hints the SSE filter uses.
  activityEvents.emit('chat_room_message', {
    room_id: roomId,
    workspace_id: ws.id,
    message_id: 'msg-1',
    sender_type: 'user',
    sender_id: userInRoom.id,
    sender_name: userInRoom.name,
    content,
    images: [],
    created_at: new Date().toISOString(),
    member_ids: new Set([userInRoom.id]),
    agent_member_ids: new Set([agentInRoom.id]),
  });

  // Insider user sees the message.
  const userInFrame = await userInStream.waitFor(
    'chat_room_message',
    (d) => d?.content === content || d?.payload?.content === content,
    4000,
  );
  assert.ok(userInFrame, 'participant user must receive chat_room_message');

  // Insider agent sees the message (buffer poll via VirtualAgent.frames).
  const waitFrameOnAgent = async (va, predicate, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = va.frames.find((f) => f.event === 'chat_room_message' && predicate(f.data));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`[${va.name}] chat_room_message frame not seen`);
  };
  const insiderFrame = await waitFrameOnAgent(insider, (d) =>
    d?.content === content || d?.payload?.content === content,
  );
  assert.ok(insiderFrame, 'participant agent must receive chat_room_message');

  // Outsiders (user + agent) must NOT have received anything with this content.
  const outDrain = await userOutStream.drainOfType('chat_room_message', 400);
  assert.equal(outDrain.length, 0, 'non-participant user must not receive room message');
  const outsiderHits = outsider.frames.filter(
    (f) => f.event === 'chat_room_message' && (f.data?.content === content || f.data?.payload?.content === content),
  );
  assert.equal(outsiderHits.length, 0, 'non-participant agent must not receive room message');

  exitAfterTests(0);
});
