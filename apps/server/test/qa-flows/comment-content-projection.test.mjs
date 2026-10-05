// QA flow: comment payload contract for the two read paths that feed the UI.
//
// Regression guard for ticket 898c94ba ("Comments tab renders empty bodies").
// The bug surfaced after the card list response was slimmed to a light comment
// projection (perf b3812637) and the detail panel was re-wired to fetch the
// full thread from GET /api/tickets/:id (fix d4113f7). The contract those two
// commits established — and which a future projection change could silently
// re-break — is:
//
//   • GET /api/accounts/:wsId/tickets → card comments are the LIGHT
//     projection: exactly {id, ticket_id, type, status, created_at}. No
//     content/author/author_type/parent_id/metadata. (perf must stay: card
//     payloads never carry bodies.)
//   • GET /api/tickets/:id  → comments are the FULL thread: content + author +
//     author_type + parent_id present, so the Comments tab can render body,
//     author, and threading.
//
// If the card list ever starts shipping `content` (perf regression) OR the
// ticket GET ever stops shipping `content`/`author` (the Comments-tab
// regression), this test fails — locking both halves of the contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAccount, createTicket, createUser } from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_COMMENT_PROJECTION_PORT || '0';

// Fields the light card projection is allowed to expose. Kept in lockstep
// with TicketService.cards() (apps/server/src/modules/tickets/ticket.service.ts)
// and the client's card comment type.
const LIGHT_KEYS = ['id', 'ticket_id', 'type', 'status', 'created_at'];
// Fields the card projection must NOT leak (these carry the comment body and
// are the perf reason the projection exists).
const HEAVY_KEYS = ['content', 'author', 'author_type', 'parent_id', 'metadata'];

test('comment payload contract: card list GET light, ticket GET full thread', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());

  const ws = await createAccount(app, getDataSourceToken, 'comment-projection');
  const user = await createUser(app, getDataSourceToken, { name: 'reader' });
  const token = app.get(AuthService).createSession(user.id);
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'X-Account-Id': ws.id,
    Connection: 'close',
  };

  const ticket = await createTicket(app, getDataSourceToken, {
    accountId: ws.id,
    title: 'projection ticket',
  });

  // Seed a root comment + a threaded reply so we can assert content, author,
  // and parent_id all survive the full-thread path.
  const commentRepo = ds.getRepository('Comment');
  const root = await commentRepo.save(commentRepo.create({
    ticket_id: ticket.id, account_id: ws.id, author: 'Alice', author_type: 'user',
    author_id: 'u-alice', content: 'HELLO_BODY_123', type: 'note', status: null,
    attachment_resource_ids: '[]', metadata: '{}',
  }));
  const reply = await commentRepo.save(commentRepo.create({
    ticket_id: ticket.id, account_id: ws.id, author: 'Bob', author_type: 'user',
    author_id: 'u-bob', content: 'REPLY_BODY_456', type: 'note', status: null,
    parent_id: root.id, attachment_resource_ids: '[]', metadata: '{}',
  }));

  step('GET /api/accounts/:wsId/tickets — card comments must be the light projection (no bodies)');
  const listRes = await fetch(`http://localhost:${port}/api/accounts/${ws.id}/tickets`, { headers: authHeaders });
  assert.equal(listRes.status, 200, 'ticket list GET should succeed');
  const listJson = await listRes.json();
  const card = (listJson.tickets || []).find((tk) => tk.id === ticket.id);
  assert.ok(card, 'ticket card present in the workspace list');
  const cardComments = card.comments || [];
  assert.equal(cardComments.length, 2, 'card carries the comment rows (count, not bodies)');
  for (const cc of cardComments) {
    const keys = Object.keys(cc).sort();
    assert.deepEqual(keys, [...LIGHT_KEYS].sort(),
      `card comment must expose ONLY the light projection keys, got: ${keys.join(',')}`);
    for (const heavy of HEAVY_KEYS) {
      assert.equal(cc[heavy], undefined,
        `card comment must not leak heavy field "${heavy}" (perf regression)`);
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
