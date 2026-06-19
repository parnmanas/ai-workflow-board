// QA: MCP chat-message read surface — get_chat_room_messages + search_chat_messages.
//
// Ticket 9d892da9 added agent-facing read tools so a chat subagent can pull
// room history / search past discussion via MCP instead of relying solely on
// the history injected at wake time. This exercises the contract end-to-end
// over the real MCP HTTP transport (initialize → tools/call):
//   - empty room                → count 0, no error
//   - populated room            → full messages in chronological order
//   - `before` cursor boundary  → returns only messages strictly older
//   - `limit`                   → caps to the N newest (chronological)
//   - non-participant agent     → rejected (active-participant guard)
//   - search scoped to rooms the calling agent participates in
//   - search from a non-participant agent returns nothing (no cross-room leak)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_CHAT_READ_PORT || '7814';

// Insert a chat room, its participants, and a spaced-out message history
// directly via repositories — there is no chat fixture helper, and the read
// tools only need persisted rows (the SSE/send path is covered elsewhere).
async function seedRoom(ds, { workspaceId, participants, messages }) {
  const roomRepo = ds.getRepository('ChatRoom');
  const partRepo = ds.getRepository('ChatRoomParticipant');
  const msgRepo = ds.getRepository('ChatRoomMessage');

  const room = await roomRepo.save(roomRepo.create({
    workspace_id: workspaceId,
    type: participants.length > 2 ? 'group' : 'dm',
    name: 'qa-read-room',
  }));

  for (const p of participants) {
    await partRepo.save(partRepo.create({
      room_id: room.id,
      participant_type: p.type,
      participant_id: p.id,
      last_read_at: null,
      left_at: null,
    }));
  }

  // Space created_at by 1s so (created_at, id) ordering is deterministic and
  // the cursor-boundary assertion can't be flaked by millisecond ties.
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const saved = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const row = await msgRepo.save(msgRepo.create({
      room_id: room.id,
      workspace_id: workspaceId,
      sender_type: m.sender_type,
      sender_id: m.sender_id,
      type: m.type || 'message',
      content: m.content,
      images: '[]',
      created_at: new Date(base + i * 1000),
    }));
    saved.push(row);
  }
  return { room, saved };
}

test('MCP get_chat_room_messages + search_chat_messages contract', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'chat-read' });

  const member = await createAgent(app, getDataSourceToken, ws.id, { name: 'member' });
  const memberKey = await createApiKey(app, getDataSourceToken, member.id, {
    workspaceId: ws.id,
    label: 'member',
  });
  const outsider = await createAgent(app, getDataSourceToken, ws.id, { name: 'outsider' });
  const outsiderKey = await createApiKey(app, getDataSourceToken, outsider.id, {
    workspaceId: ws.id,
    label: 'outsider',
  });

  const memberMcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: memberKey.raw_key });
  const outsiderMcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: outsiderKey.raw_key });
  await memberMcp.initialize();
  await outsiderMcp.initialize();
  t.after(async () => { await memberMcp.close(); await outsiderMcp.close(); });

  step('Empty room → count 0, no error');
  const emptyRoom = await seedRoom(ds, {
    workspaceId: ws.id,
    participants: [{ type: 'agent', id: member.id }],
    messages: [],
  });
  const emptyRes = await memberMcp.callTool('get_chat_room_messages', { room_id: emptyRoom.room.id });
  assert.ok(!emptyRes.isError, `empty-room read must succeed: ${JSON.stringify(emptyRes)}`);
  assert.equal(emptyRes.count, 0, 'empty room has zero messages');
  assert.deepEqual(emptyRes.messages, [], 'empty room returns []');

  step('Populated room → chronological full history');
  const { room, saved } = await seedRoom(ds, {
    workspaceId: ws.id,
    participants: [{ type: 'agent', id: member.id }],
    messages: [
      { sender_type: 'agent', sender_id: member.id, content: 'alpha apple' },
      { sender_type: 'agent', sender_id: member.id, content: 'beta banana' },
      { sender_type: 'agent', sender_id: member.id, content: 'gamma cherry' },
      // a progress heartbeat — must be excluded from the agent's read view
      { sender_type: 'agent', sender_id: member.id, content: 'tool-call narration', type: 'progress' },
    ],
  });
  const allRes = await memberMcp.callTool('get_chat_room_messages', { room_id: room.id });
  assert.ok(!allRes.isError, `populated read must succeed: ${JSON.stringify(allRes)}`);
  assert.equal(allRes.count, 3, 'progress row is excluded; 3 real messages remain');
  const order = allRes.messages.map((m) => m.content);
  assert.deepEqual(order, ['alpha apple', 'beta banana', 'gamma cherry'], 'chronological order');
  // Full content contract: sender + attachments + created_at present.
  const first = allRes.messages[0];
  assert.equal(first.sender_id, member.id, 'sender_id present');
  assert.ok('sender_name' in first, 'sender_name present');
  assert.ok(Array.isArray(first.attachments), 'attachments array present');
  assert.ok(first.created_at, 'created_at present');

  step('`before` cursor → only messages strictly older than the cursor');
  const ids = allRes.messages.map((m) => m.id); // [alpha, beta, gamma] chronological
  const beforeBeta = await memberMcp.callTool('get_chat_room_messages', { room_id: room.id, before: ids[1] });
  assert.equal(beforeBeta.count, 1, 'one message older than beta');
  assert.deepEqual(beforeBeta.messages.map((m) => m.content), ['alpha apple'], 'cursor excludes beta + newer');

  step('`limit` → caps to the N newest, still chronological');
  const limited = await memberMcp.callTool('get_chat_room_messages', { room_id: room.id, limit: 2 });
  assert.equal(limited.count, 2, 'limit=2 returns 2 messages');
  assert.deepEqual(limited.messages.map((m) => m.content), ['beta banana', 'gamma cherry'], '2 newest, chronological');

  step('Non-participant agent is rejected by the active-participant guard');
  const denied = await outsiderMcp.callTool('get_chat_room_messages', { room_id: room.id });
  assert.ok(denied.isError, 'non-participant read must be an error');
  assert.match(JSON.stringify(denied.error), /participant/i, 'error mentions participant gate');

  step('search_chat_messages is scoped to the calling agent\'s rooms');
  const found = await memberMcp.callTool('search_chat_messages', { query: 'banana' });
  assert.ok(!found.isError, `search must succeed: ${JSON.stringify(found)}`);
  assert.equal(found.count, 1, 'one message matches "banana"');
  assert.equal(found.results[0].content, 'beta banana', 'correct match returned');
  assert.equal(found.results[0].room_id, room.id, 'match carries room_id');

  step('search rejects <2-char queries');
  const tooShort = await memberMcp.callTool('search_chat_messages', { query: 'b' });
  assert.ok(tooShort.isError, 'short query is rejected');

  step('Non-participant agent\'s search sees nothing from rooms it is not in');
  const noLeak = await outsiderMcp.callTool('search_chat_messages', { query: 'banana' });
  assert.ok(!noLeak.isError, 'search call itself succeeds for the outsider');
  assert.equal(noLeak.count, 0, 'outsider gets no matches from a room it is not a participant of');

  exitAfterTests(0);
});
