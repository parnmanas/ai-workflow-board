// QA: chat-attachment review-bounce regressions for ticket 92082b55.
//
// Two findings from the reviewer (2026-05-26):
//
//   P1 — attachment_ids binding is not atomic. Two concurrent sends with the
//        same pending attachment_ids[] both passed validation, both saved
//        messages, then the last UPDATE owner_id=msgId won. The first
//        sender's POST / SSE response then referenced attachments that the
//        DB later showed bound to the OTHER message.
//
//   P2 — REST + MCP upload trusted the client-claimed mime via
//        inferTicketAttachmentMimetype (explicit-first). The AC security
//        item required magic-byte sniffing to reject forged mimes.
//
// This QA boots the real NestJS app and exercises both:
//   1. Run two parallel POST /messages with the same attachment_ids[];
//      exactly one must return 201 with both attachments bound, and the
//      other must return 4xx with no attachment leak.
//   2. Upload bytes whose magic does NOT match the claimed mime — server
//      must respond 400 and persist no row.
//
// Pattern mirrors qa-flows/chat-attachments.test.mjs so the boot helpers,
// db isolation, and fixture wiring are identical.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const __testDbName = `qa-chat-attach-security-${Date.now()}-${process.pid}.db`;
process.env.SQLJS_DB_PATH = path.join(os.tmpdir(), __testDbName);

import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createWorkspace, createUser, createAgent, createApiKey } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_CHAT_ATTACH_SEC_PORT || '7832';

// Real PNG signature + a couple of IHDR bytes — sniffer matches "image/png".
const FAKE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
]).toString('base64');
// Real PDF header — sniffer matches "application/pdf". Same bytes but
// labeled as image/png is the P2 mismatch case.
const FAKE_PDF = Buffer.from('%PDF-1.4\n%example\n').toString('base64');

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

test('chat-attachment security regressions: atomic claim + mime sniffing', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { AuthService, getDataSourceToken } = modules;

  const ws = await createWorkspace(app, getDataSourceToken, 'chat-attach-sec');
  const sender = await createUser(app, getDataSourceToken, { name: 'sender' });
  const peer = await createUser(app, getDataSourceToken, { name: 'peer' });
  const senderToken = app.get(AuthService).createSession(sender.id);

  const room = await createDmRoom(app, getDataSourceToken, { wsId: ws.id, userA: sender, userB: peer });
  const ds = app.get(getDataSourceToken());
  const attRepo = ds.getRepository('TicketAttachment');
  const msgRepo = ds.getRepository('ChatRoomMessage');

  // ── P1: atomic claim under concurrent sends ─────────────────────────

  step('P1.1 Upload two pending attachments (same room, same sender)');
  const uploadRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/attachments`, {
    method: 'POST',
    headers: authHeaders(senderToken, ws.id),
    body: JSON.stringify({
      attachments: [
        { file_name: 'a.png', file_data: FAKE_PNG },
        { file_name: 'b.png', file_data: FAKE_PNG },
      ],
    }),
  });
  const uploadText = await uploadRes.text();
  assert.equal(uploadRes.status, 201, uploadText);
  const [attA, attB] = JSON.parse(uploadText);
  assert.ok(attA.id && attB.id);

  step('P1.2 Fire two concurrent sends with the SAME attachment_ids[]');
  const body = JSON.stringify({
    content: 'race',
    attachment_ids: [attA.id, attB.id],
  });
  const [first, second] = await Promise.all([
    fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/messages`, {
      method: 'POST',
      headers: authHeaders(senderToken, ws.id),
      body,
    }),
    fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/messages`, {
      method: 'POST',
      headers: authHeaders(senderToken, ws.id),
      body,
    }),
  ]);

  const firstStatus = first.status;
  const secondStatus = second.status;
  const firstText = await first.text();
  const secondText = await second.text();
  const firstBody = JSON.parse(firstText);
  const secondBody = JSON.parse(secondText);

  // Exactly one send must succeed. The loser may receive 400 (rejected by
  // the pre-flight validator if it observed the row post-claim) or 409
  // (rejected by the CAS update). Either is acceptable as long as it is
  // NOT 201 — the contract is "no double-claim".
  const statuses = [firstStatus, secondStatus].sort();
  assert.deepEqual(
    statuses,
    [201, statuses[1]],
    `expected exactly one 201, got [${statuses.join(', ')}]`,
  );
  assert.notEqual(statuses[1], 201, 'second send must NOT succeed');
  assert.ok(
    statuses[1] === 400 || statuses[1] === 409,
    `loser status must be 400 or 409, got ${statuses[1]}`,
  );

  step('P1.3 DB shows attachments bound to exactly the winning message');
  const winnerBody = firstStatus === 201 ? firstBody : secondBody;
  const loserBody = firstStatus === 201 ? secondBody : firstBody;
  const winnerMsgId = winnerBody.id;
  assert.ok(winnerMsgId, 'winner response must include message id');
  // The loser body is an error envelope — must not look like a saved message
  assert.ok(!loserBody.id || loserBody.id === winnerMsgId, 'loser must not have produced a separate message id');

  const rowA = await attRepo.findOne({ where: { id: attA.id } });
  const rowB = await attRepo.findOne({ where: { id: attB.id } });
  assert.equal(rowA.owner_type, 'chat_message');
  assert.equal(rowA.owner_id, winnerMsgId, 'attA must be bound to winner');
  assert.equal(rowB.owner_type, 'chat_message');
  assert.equal(rowB.owner_id, winnerMsgId, 'attB must be bound to winner');

  step('P1.4 Loser must not have left a phantom message row');
  // The CAS rollback path must roll the message row back along with the
  // attachment update. Count rows with content='race' — should be exactly 1.
  const raceMessages = await msgRepo.find({ where: { room_id: room.id, content: 'race' } });
  assert.equal(raceMessages.length, 1, `expected exactly 1 'race' message row, found ${raceMessages.length}`);

  // ── P2: magic-byte mime sniffing ────────────────────────────────────

  step('P2.1 Upload PDF bytes claiming image/png mime — must be 400');
  const forgeRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/attachments`, {
    method: 'POST',
    headers: authHeaders(senderToken, ws.id),
    body: JSON.stringify({
      file_name: 'fake.png',
      file_data: FAKE_PDF,
      file_mimetype: 'image/png',
    }),
  });
  const forgeText = await forgeRes.text();
  assert.equal(forgeRes.status, 400, forgeText);

  step('P2.2 Forged upload must NOT have persisted a row');
  const allRowsAfter = await attRepo.find({ where: { room_id: room.id } });
  // The two pending uploads from P1 + the now-attached pair → 2 rows total.
  // No row from the forged upload should exist.
  assert.equal(allRowsAfter.length, 2, `forged upload should not persist any row (saw ${allRowsAfter.length} rows)`);

  step('P2.3 Upload PNG with the canonical mime succeeds — sniffer accepts matching bytes');
  const okRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/attachments`, {
    method: 'POST',
    headers: authHeaders(senderToken, ws.id),
    body: JSON.stringify({
      file_name: 'shot.png',
      file_data: FAKE_PNG,
      file_mimetype: 'image/png',
    }),
  });
  const okText = await okRes.text();
  assert.equal(okRes.status, 201, okText);
  const okAtt = JSON.parse(okText);
  assert.equal(okAtt.mime_type, 'image/png');

  step('P2.4 jpg/jpeg synonym must not falsely reject — alias normalization');
  // Real JPEG bytes labeled with the non-canonical "image/jpg" spelling
  // (some browsers + legacy SDKs still emit this). The sniffer detects
  // image/jpeg; the alias table must reconcile so the upload is accepted.
  const FAKE_JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
  ]).toString('base64');
  const jpgRes = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/attachments`, {
    method: 'POST',
    headers: authHeaders(senderToken, ws.id),
    body: JSON.stringify({
      file_name: 'photo.jpg',
      file_data: FAKE_JPEG,
      file_mimetype: 'image/jpg',
    }),
  });
  const jpgText = await jpgRes.text();
  assert.equal(jpgRes.status, 201, jpgText);

  // ── P3 (review 2026-05-26): cross-owner MCP tool bypass ─────────────
  //
  // After the generic-owner refactor, chat rows live in the same
  // ticket_attachments table as ticket rows. get_ticket_attachment and
  // delete_ticket_attachment previously looked up by raw attachment_id and
  // would happily return / hard-delete a chat row, bypassing the chat
  // participant-only download path and the uploader+pending-only delete
  // tool. Both MCP tools must now refuse rows where owner_type !== 'ticket'.

  step('P3.1 Create an agent MCP session for the cross-owner probe');
  const probeAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'probe' });
  const probeKey = await createApiKey(app, getDataSourceToken, probeAgent.id, {
    workspaceId: ws.id, label: 'probe',
  });
  const mcp = new McpClient({
    baseUrl: `http://localhost:${port}`,
    apiKey: probeKey.raw_key,
    clientInfo: { name: 'qa-chat-attach-sec-mcp', version: '1.0.0' },
  });
  await mcp.initialize();
  t.after(() => { void mcp.close().catch(() => {}); });

  step('P3.2 get_ticket_attachment on a chat attachment id returns "not found"');
  // attA was bound to a chat message in P1 (owner_type='chat_message');
  // rowA still exists in DB and is reachable via /api/chat-rooms/... for
  // participants. The ticket MCP tool must not project it.
  const getRes = await mcp.callTool('get_ticket_attachment', { attachment_id: attA.id });
  assert.ok(
    getRes && getRes.isError,
    `get_ticket_attachment must reject a chat row, got: ${JSON.stringify(getRes)}`,
  );
  // Confirm the row is still there — the rejection must be from the owner
  // guard, not because the row got swept by some other path.
  const stillThere = await attRepo.findOne({ where: { id: attA.id } });
  assert.ok(stillThere, 'chat attachment row must still exist (only the MCP read should have been blocked)');
  assert.equal(stillThere.owner_type, 'chat_message');

  step('P3.3 delete_ticket_attachment on a chat attachment id returns "not found" and does not delete');
  const delRes = await mcp.callTool('delete_ticket_attachment', { attachment_id: attA.id });
  assert.ok(
    delRes && delRes.isError,
    `delete_ticket_attachment must reject a chat row, got: ${JSON.stringify(delRes)}`,
  );
  const survivor = await attRepo.findOne({ where: { id: attA.id } });
  assert.ok(survivor, 'chat attachment row must survive an MCP delete_ticket_attachment attempt');
  assert.equal(survivor.id, attA.id);

  step('P3.4 Same tools also refuse a pending chat_room-owned row');
  // Re-upload a single attachment that stays in pending state
  // (owner_type='chat_room') and confirm the same guards reject it.
  const pendingUp = await fetch(`http://localhost:${port}/api/chat-rooms/${room.id}/attachments`, {
    method: 'POST',
    headers: authHeaders(senderToken, ws.id),
    body: JSON.stringify({
      file_name: 'pending.png',
      file_data: FAKE_PNG,
    }),
  });
  assert.equal(pendingUp.status, 201);
  const pendingAtt = await pendingUp.json();
  const pendingRow = await attRepo.findOne({ where: { id: pendingAtt.id } });
  assert.equal(pendingRow.owner_type, 'chat_room', 'fresh upload should be in pending chat_room state');

  const getPendingRes = await mcp.callTool('get_ticket_attachment', { attachment_id: pendingAtt.id });
  assert.ok(getPendingRes && getPendingRes.isError, 'get_ticket_attachment must reject a chat_room (pending) row');
  const delPendingRes = await mcp.callTool('delete_ticket_attachment', { attachment_id: pendingAtt.id });
  assert.ok(delPendingRes && delPendingRes.isError, 'delete_ticket_attachment must reject a chat_room (pending) row');
  const pendingSurvivor = await attRepo.findOne({ where: { id: pendingAtt.id } });
  assert.ok(pendingSurvivor, 'pending chat attachment must survive the ticket MCP delete attempt');

  exitAfterTests(0);
});
