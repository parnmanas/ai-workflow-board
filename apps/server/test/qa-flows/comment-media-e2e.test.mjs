// QA flow / e2e: comment media attachment over the streaming endpoints.
//
// End-to-end proof for ticket ff3e7337 (comment attachments invisible; large
// video 413; design-vs-impl mismatch). Exercises the real HTTP surface of a
// booted server — not mocks — covering every AC:
//
//   1. Large media (>10MB) uploads via POST /api/resources/upload (raw bytes)
//      WITHOUT a 413 — the old base64-in-JSON path died here for ~7MB+ mp4s.
//   2. A comment references that Resource by id (attachment_resource_ids) — the
//      design-recommended "reference existing Resource" path, no bytes re-sent.
//   3. GET /api/tickets/:id hydrates the comment with attachment METADATA only
//      (file_name + file_mimetype, never file_data).
//   4. GET /api/resources/:id/raw streams the bytes, honours HTTP Range with a
//      206 + correct Content-Range/chunk (required for <video> seeking), and
//      ?download forces an attachment Content-Disposition.
//   5. An oversize JSON POST surfaces a CLEAN 413 with a user-facing message
//      (AllExceptionsFilter entity.too.large mapping), not an opaque 500.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from '../helpers/boot.mjs';
import { setupKanbanScene, createUser, createTicket } from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_COMMENT_MEDIA_PORT || '7834';

test('comment media e2e: large upload, reference-by-id, range stream, clean 413', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken, AuthService } = modules;
  const base = `http://127.0.0.1:${port}`;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'media-e2e' });
  const user = await createUser(app, getDataSourceToken, { name: 'media-user' });
  const token = app.get(AuthService).createSession(user.id);
  const authHeaders = { Authorization: `Bearer ${token}` };

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'media e2e ticket',
  });

  // ── 1. Upload a 15MB "video" via the raw endpoint (would 413 under the old
  //       10MB base64-in-JSON path). Fill with a recognizable byte pattern so
  //       the Range slice can be asserted exactly.
  const SIZE = 15 * 1024 * 1024;
  const big = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) big[i] = i % 251; // 251 prime → no 256-alignment
  const upRes = await fetch(`${base}/api/resources/upload?workspace_id=${ws.id}&type=comment_attachment`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'video/mp4',
      'X-File-Name': encodeURIComponent('big-clip.mp4'),
    },
    body: big,
  });
  assert.equal(upRes.status, 201, `large upload should succeed, got ${upRes.status}`);
  const uploaded = await upRes.json();
  assert.ok(uploaded.id, 'upload returns a resource id');
  assert.equal(uploaded.file_mimetype, 'video/mp4');
  assert.equal(uploaded.size, SIZE, 'server reports full byte size');
  assert.ok(!('file_data' in uploaded), 'upload response must NOT echo file_data');

  // ── 2. Comment references the Resource by id — no bytes in the POST body.
  const cRes = await fetch(`${base}/api/tickets/${ticket.id}/comments`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'see the clip', attachment_resource_ids: [uploaded.id] }),
  });
  assert.equal(cRes.status, 201, `comment create should succeed, got ${cRes.status}`);

  // ── 3. Ticket GET hydrates attachment metadata only (no file_data).
  const tRes = await fetch(`${base}/api/tickets/${ticket.id}`, { headers: authHeaders });
  assert.equal(tRes.status, 200);
  const tBody = await tRes.json();
  const comment = (tBody.comments || []).find(c => c.content === 'see the clip');
  assert.ok(comment, 'comment present in full thread');
  assert.ok(Array.isArray(comment.attachments) && comment.attachments.length === 1, 'one hydrated attachment');
  const att = comment.attachments[0];
  assert.equal(att.id, uploaded.id);
  assert.equal(att.file_name, 'big-clip.mp4');
  assert.equal(att.file_mimetype, 'video/mp4');
  assert.ok(!att.file_data, 'hydrated attachment must NOT carry base64 file_data');

  // ── 4a. Range request → 206 with the exact slice (video seeking).
  const start = 1_000_000, end = 1_000_063; // 64 bytes mid-file
  const rRes = await fetch(`${base}/api/resources/${uploaded.id}/raw`, {
    headers: { ...authHeaders, Range: `bytes=${start}-${end}` },
  });
  assert.equal(rRes.status, 206, 'range request returns 206 Partial Content');
  assert.equal(rRes.headers.get('content-range'), `bytes ${start}-${end}/${SIZE}`);
  assert.equal(rRes.headers.get('accept-ranges'), 'bytes');
  const chunk = Buffer.from(await rRes.arrayBuffer());
  assert.equal(chunk.length, end - start + 1, 'chunk length matches range');
  for (let i = 0; i < chunk.length; i++) {
    assert.equal(chunk[i], (start + i) % 251, `byte ${i} matches original pattern`);
  }

  // ── 4b. Full GET → 200, full length, inline disposition.
  const fullRes = await fetch(`${base}/api/resources/${uploaded.id}/raw`, { headers: authHeaders });
  assert.equal(fullRes.status, 200);
  assert.equal(Number(fullRes.headers.get('content-length')), SIZE);
  assert.match(fullRes.headers.get('content-disposition') || '', /^inline/);
  await fullRes.arrayBuffer();

  // ── 4c. ?download → attachment disposition.
  const dlRes = await fetch(`${base}/api/resources/${uploaded.id}/raw?download=1`, { headers: authHeaders });
  assert.equal(dlRes.status, 200);
  assert.match(dlRes.headers.get('content-disposition') || '', /^attachment/);
  await dlRes.arrayBuffer();

  // ── 4d. Media tag auth via ?token (no Authorization header possible on <video>).
  const tokRes = await fetch(`${base}/api/resources/${uploaded.id}/raw?token=${encodeURIComponent(token)}`);
  assert.equal(tokRes.status, 200, 'query-token auth works for media tags');
  await tokRes.arrayBuffer();

  // ── 4e. No token → 401.
  const noAuthRes = await fetch(`${base}/api/resources/${uploaded.id}/raw`);
  assert.equal(noAuthRes.status, 401, 'unauthenticated raw fetch rejected');

  // ── 5. Oversize JSON body → CLEAN 413 with a friendly message (not 500).
  const huge = 'x'.repeat(11 * 1024 * 1024); // > the 10MB json() ceiling
  const bigJsonRes = await fetch(`${base}/api/tickets/${ticket.id}/comments`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: huge }),
  });
  assert.equal(bigJsonRes.status, 413, `oversize JSON should 413, got ${bigJsonRes.status}`);
  const errBody = await bigJsonRes.json().catch(() => ({}));
  const msg = errBody.error || errBody.message || '';
  assert.match(String(msg), /too large/i, 'clear oversize message surfaced to the client');
});

exitAfterTests();
