// QA: chat-room attachment lifecycle.
//
// Coverage:
//   1. POST /api/chat-rooms/:roomId/attachments → returns id/download_url/mime/size,
//      stores row with owner_type='chat_room', owner_id=roomId (pending).
//   2. POST /api/chat-rooms/:roomId/messages with attachment_ids[] → transitions
//      owner_type to 'chat_message' + owner_id to message.id, and returns
//      attachments[] in the response.
//   3. GET /api/chat-rooms/:roomId/messages history → attachments[] populated.
//   4. GET /:roomId/attachments/:id with a non-participant returns 403.
//   5. DELETE /:roomId/attachments/:id on a *pending* upload succeeds (uploader).
//   6. DELETE on an already-sent attachment is 409.
//   7. Attaching the same id twice via send fails (409 second time).
//
// All paths run against the real NestJS app over HTTP — same surface a browser
// or the agent-manager would hit.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Isolate this test's sql.js database from the user's live `data.db` so
// concurrent runs (or a stray malformed shared db) don't poison the boot.
// Mirrors how the admin "Run Flow Tests" path sets SQLJS_DB_PATH per
// subprocess (see apps/server/src/db.ts).
const __testDbName = `qa-chat-attachments-${Date.now()}-${process.pid}.db`;
process.env.SQLJS_DB_PATH = path.join(os.tmpdir(), __testDbName);

import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createWorkspace, createUser } from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_CHAT_ATTACH_PORT || '7831';

// 8 bytes of "hello!\n" base64 — minimal valid payload.
const TINY_TXT = Buffer.from('hello!\n').toString('base64');
// 14-byte fake PNG header + IHDR — enough for mime sniffing to recognize image/png.
const FAKE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
]).toString('base64');

async function createDmRoom(app, getDataSourceToken, { wsId, userA, userB }) {
  const ds = app.get(getDataSourceToken());
  const roomRepo = ds.getRepository('ChatRoom');
  const partRepo = ds.getRepository('ChatRoomParticipant');
  const room = await roomRepo.save(roomRepo.create({
    workspace_id: wsId,
    type: 'dm',
    name: '',
  }));
  await partRepo.save(partRepo.create({
    room_id: room.id,
    participant_type: 'user',
    participant_id: userA.id,
  }));
  await partRepo.save(partRepo.create({
    room_id: room.id,
    participant_type: 'user',
    participant_id: userB.id,
  }));
  return room;
}

function authHeaders(token, wsId) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-Workspace-Id': wsId,
  };
}

test('chat-room attachment lifecycle: upload → send → history → download auth → discard', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { AuthService, getDataSourceToken } = modules;

  const ws = await createWorkspace(app, getDataSourceToken, 'chat-attach');
  const sender = await createUser(app, getDataSourceToken, { name: 'sender' });
  const peer = await createUser(app, getDataSourceToken, { name: 'peer' });
  const outsider = await createUser(app, getDataSourceToken, { name: 'outsider' });
  const senderToken = app.get(AuthService).createSession(sender.id);
  const outsiderToken = app.get(AuthService).createSession(outsider.id);

  const room = await createDmRoom(app, getDataSourceToken, { wsId: ws.id, userA: sender, userB: peer });

  step('1. Upload two attachments (one PNG, one TXT) — pending state');
  const uploadRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/attachments`, {
    method: 'POST',
    headers: authHeaders(senderToken, ws.id),
    body: JSON.stringify({
      attachments: [
        { file_name: 'screenshot.png', file_data: FAKE_PNG },
        { file_name: 'log.txt', file_data: TINY_TXT, file_mimetype: 'text/plain' },
      ],
    }),
  });
  const uploadBody = await uploadRes.text();
  assert.equal(uploadRes.status, 201, uploadBody);
  const uploaded = JSON.parse(uploadBody);
  assert.ok(Array.isArray(uploaded) && uploaded.length === 2, 'expected array of 2 attachments');
  const [pngAtt, txtAtt] = uploaded;
  assert.ok(pngAtt.id, 'attachment id present');
  assert.equal(pngAtt.filename, 'screenshot.png');
  assert.equal(pngAtt.mime_type, 'image/png');
  assert.ok(pngAtt.download_url.includes(`/api/chat-rooms/${room.id}/attachments/${pngAtt.id}`));
  assert.ok(pngAtt.thumbnail_url, 'image attachment should have thumbnail_url');
  assert.equal(txtAtt.mime_type, 'text/plain');
  assert.equal(txtAtt.thumbnail_url, undefined, 'non-image attachment must NOT have thumbnail_url');

  step('2. Verify pending rows exist with owner_type=chat_room, owner_id=roomId');
  const ds = app.get(getDataSourceToken());
  const attRepo = ds.getRepository('TicketAttachment');
  for (const att of [pngAtt, txtAtt]) {
    const row = await attRepo.findOne({ where: { id: att.id } });
    assert.equal(row.owner_type, 'chat_room');
    assert.equal(row.owner_id, room.id);
    assert.equal(row.room_id, room.id);
  }

  step('3. Send message with attachment_ids');
  const sendRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/messages`, {
    method: 'POST',
    headers: authHeaders(senderToken, ws.id),
    body: JSON.stringify({
      content: 'here is my screenshot',
      attachment_ids: [pngAtt.id, txtAtt.id],
    }),
  });
  const sendBody = await sendRes.text();
  assert.equal(sendRes.status, 201, sendBody);
  const message = JSON.parse(sendBody);
  assert.equal(message.attachments.length, 2);
  assert.equal(message.attachments[0].id, pngAtt.id);

  step('4. After send, owner_type/owner_id transition to chat_message + message.id');
  for (const att of [pngAtt, txtAtt]) {
    const row = await attRepo.findOne({ where: { id: att.id } });
    assert.equal(row.owner_type, 'chat_message', `attachment ${att.id} should transition to chat_message`);
    assert.equal(row.owner_id, message.id, `attachment ${att.id} should be owned by message ${message.id}`);
  }

  step('5. History fetch projects attachments[]');
  const histRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/messages?limit=10`, {
    headers: authHeaders(senderToken, ws.id),
  });
  assert.equal(histRes.status, 200);
  const history = await histRes.json();
  const histMsg = history.find(m => m.id === message.id);
  assert.ok(histMsg, 'sent message should appear in history');
  assert.equal(histMsg.attachments.length, 2);
  assert.equal(histMsg.attachments[0].mime_type, 'image/png');

  step('6. Non-participant download is forbidden');
  const outsiderRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/attachments/${pngAtt.id}`, {
    headers: authHeaders(outsiderToken, ws.id),
  });
  assert.equal(outsiderRes.status, 403);

  step('7. Participant download succeeds with file_data inlined');
  const downloadRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/attachments/${pngAtt.id}`, {
    headers: authHeaders(senderToken, ws.id),
  });
  assert.equal(downloadRes.status, 200);
  const downloaded = await downloadRes.json();
  assert.equal(downloaded.file_data, FAKE_PNG, 'download should include base64 file_data');

  step('8. DELETE on an already-sent attachment → 409');
  const deleteSentRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/attachments/${pngAtt.id}`, {
    method: 'DELETE',
    headers: authHeaders(senderToken, ws.id),
  });
  assert.equal(deleteSentRes.status, 409);

  step('9. Upload a new pending attachment and discard it');
  const pendingRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/attachments`, {
    method: 'POST',
    headers: authHeaders(senderToken, ws.id),
    body: JSON.stringify({
      file_name: 'draft.txt',
      file_data: TINY_TXT,
    }),
  });
  assert.equal(pendingRes.status, 201);
  const pending = await pendingRes.json();
  const discardRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/attachments/${pending.id}`, {
    method: 'DELETE',
    headers: authHeaders(senderToken, ws.id),
  });
  assert.equal(discardRes.status, 200);
  const stillThere = await attRepo.findOne({ where: { id: pending.id } });
  assert.equal(stillThere, null, 'discarded pending attachment should be hard-deleted');

  step('10. Re-using an already-attached id is rejected');
  const reuseRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/messages`, {
    method: 'POST',
    headers: authHeaders(senderToken, ws.id),
    body: JSON.stringify({
      content: 'try to reuse',
      attachment_ids: [pngAtt.id],
    }),
  });
  assert.equal(reuseRes.status, 400, 'reusing a bound attachment id must be rejected');

  exitAfterTests(0);
});
