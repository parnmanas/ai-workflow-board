// QA flow: comment payload contract for the two read paths that feed the UI.
//
// Regression guard for ticket 898c94ba ("Comments tab renders empty bodies").
// The bug surfaced after the board GET response was slimmed to a light comment
// projection (perf b3812637) and the detail panel was re-wired to fetch the
// full thread from GET /api/tickets/:id (fix d4113f7). The contract those two
// commits established — and which a future projection change could silently
// re-break — is:
//
//   • GET /api/boards/:id   → comments are the LIGHT projection: exactly
//     {id, ticket_id, type, status, created_at}. No content/author/author_type/
//     parent_id/metadata. (perf must stay: card payloads never carry bodies.)
//   • GET /api/tickets/:id  → comments are the FULL thread: content + author +
//     author_type + parent_id present, so the Comments tab can render body,
//     author, and threading.
//
// If the board GET ever starts shipping `content` (perf regression) OR the
// ticket GET ever stops shipping `content`/`author` (the Comments-tab
// regression), this test fails — locking both halves of the contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createTicket, createUser } from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_COMMENT_PROJECTION_PORT || '7811';

// Fields the light board projection is allowed to expose. Kept in lockstep
// with BoardCardComment (apps/server/src/modules/boards/boards.controller.ts
// and apps/client/src/types.ts).
const LIGHT_KEYS = ['id', 'ticket_id', 'type', 'status', 'created_at'];
// Fields the board projection must NOT leak (these carry the comment body and
// are the perf reason the projection exists).
const HEAVY_KEYS = ['content', 'author', 'author_type', 'parent_id', 'metadata'];

test('comment payload contract: board GET light, ticket GET full thread', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());

  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'comment-projection',
  });
  const user = await createUser(app, getDataSourceToken, { name: 'reader' });
  const token = app.get(AuthService).createSession(user.id);
  const authHeaders = { Authorization: `Bearer ${token}` };

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'projection ticket',
  });

  // Seed a root comment + a threaded reply so we can assert content, author,
  // and parent_id all survive the full-thread path.
  const commentRepo = ds.getRepository('Comment');
  const root = await commentRepo.save(commentRepo.create({
    ticket_id: ticket.id, workspace_id: ws.id, author: 'Alice', author_type: 'user',
    author_id: 'u-alice', content: 'HELLO_BODY_123', type: 'note', status: null,
    attachment_resource_ids: '[]', metadata: '{}',
  }));
  const reply = await commentRepo.save(commentRepo.create({
    ticket_id: ticket.id, workspace_id: ws.id, author: 'Bob', author_type: 'user',
    author_id: 'u-bob', content: 'REPLY_BODY_456', type: 'note', status: null,
    parent_id: root.id, attachment_resource_ids: '[]', metadata: '{}',
  }));

  step('GET /api/boards/:id — comments must be the light projection (no bodies)');
  const boardRes = await fetch(`http://localhost:${port}/api/boards/${board.id}`, { headers: authHeaders });
  assert.equal(boardRes.status, 200, 'board GET should succeed');
  const boardJson = await boardRes.json();
  const findCard = (cols) => {
    for (const col of cols || []) for (const tk of col.tickets || []) if (tk.id === ticket.id) return tk;
    return null;
  };
  const card = findCard(boardJson.columns);
  assert.ok(card, 'ticket card present on board');
  const boardComments = card.comments || [];
  assert.equal(boardComments.length, 2, 'board card carries the comment rows (count, not bodies)');
  for (const bc of boardComments) {
    const keys = Object.keys(bc).sort();
    assert.deepEqual(keys, [...LIGHT_KEYS].sort(),
      `board comment must expose ONLY the light projection keys, got: ${keys.join(',')}`);
    for (const heavy of HEAVY_KEYS) {
      assert.equal(bc[heavy], undefined,
        `board comment must not leak heavy field "${heavy}" (perf regression)`);
    }
  }

  step('GET /api/tickets/:id — comments must be the full thread (content + author + parent_id)');
  const ticketRes = await fetch(`http://localhost:${port}/api/tickets/${ticket.id}`, { headers: authHeaders });
  assert.equal(ticketRes.status, 200, 'ticket GET should succeed');
  const ticketJson = await ticketRes.json();
  const fullComments = ticketJson.comments || [];
  assert.equal(fullComments.length, 2, 'full thread returns both comments');

  const fullRoot = fullComments.find(c => c.id === root.id);
  const fullReply = fullComments.find(c => c.id === reply.id);
  assert.ok(fullRoot && fullReply, 'both comments resolve in the full thread');

  // The exact symptom from the ticket: body + author present (not empty).
  assert.equal(fullRoot.content, 'HELLO_BODY_123', 'root comment body renders');
  assert.equal(fullRoot.author, 'Alice', 'root comment author renders');
  assert.equal(fullRoot.author_type, 'user', 'root comment author_type present');

  assert.equal(fullReply.content, 'REPLY_BODY_456', 'reply comment body renders');
  assert.equal(fullReply.author, 'Bob', 'reply comment author renders');
  // Threading: the reply must carry its parent link so CommentList can nest it.
  assert.equal(fullReply.parent_id, root.id, 'reply parent_id survives the full-thread path');

  exitAfterTests(0);
});
