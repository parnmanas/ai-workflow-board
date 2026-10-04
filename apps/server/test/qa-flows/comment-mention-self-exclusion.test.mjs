// QA flow: comment_mention self-exclusion.
//
// When an agent writes a comment that @-tags ITSELF, the server must never
// fire comment_mention back to the author. Without this, the assignee
// mentioning its own identity would notify itself → agent-manager re-spawns
// the author's own subagent → recursive loop.
//
// Workspace roles and `@[role:…]` fan-out are gone (docs/tickets.md): a
// ticket has exactly one agent — its assignee — and only a mention of the
// assignee identity can wake anything. So the author that can hit the loop
// is the assignee itself. Two agents drive the REAL MCP add_comment tool,
// each authenticated with its Host-bound runtime credential (the key a
// dispatched subagent gets, so the author id is the runtime identity key):
//   1. assignee A tags `@[agent:A]` (+ bystander B) → nobody is notified:
//      A's self-mention is dropped, B is not on the ticket.
//   2. peer B tags `@[agent:A]`                     → A gets exactly one
//      comment_mention, attributed to B. This proves the mention path is
//      live, so the zero in (1) is self-exclusion and not a dead pipe.
// Both comments also pin the author_role stamp (author-role.ts #3): A's
// comment is badged `assignee` (author id == ticket.assignee_key), B's has no
// badge.
//
// Regression cover for DoD #5 (재귀 방지) of ticket 40024001.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createApiKey,
  createTicket,
  runtimeHostKeyForAgent,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_MENTION_SELF_EXCL_PORT || '0';

test('self-mention dropped: the assignee never wakes itself; a peer mention still lands', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const ws = await createWorkspace(app, getDataSourceToken, 'mention-self-excl');
  const agentA = await createAgent(app, getDataSourceToken, ws.id, { name: 'assignee-a', runtime: true });
  const agentB = await createAgent(app, getDataSourceToken, ws.id, { name: 'peer-b', runtime: true });
  // The Host-bound runtime credential (`runtime:<label>:<rt-key>`): MCP calls
  // made with it are authored as the runtime identity key, exactly like a
  // dispatched subagent's.
  const keyA = await createApiKey(app, getDataSourceToken, agentA.id, { workspaceId: ws.id, label: 'assignee-a' });
  const keyB = await createApiKey(app, getDataSourceToken, agentB.id, { workspaceId: ws.id, label: 'peer-b' });

  const ticket = await createTicket(app, getDataSourceToken, {
    workspaceId: ws.id,
    title: 'Discussion self-exclusion',
    status: 'in_progress',
    assignee: agentA,
  });

  // SSE rides the Host key (one stream per Runtime Host); MCP rides the
  // runtime credential.
  const vaA = new VirtualAgent({ name: 'assignee-a', agentId: agentA.id, apiKey: keyA.raw_key, port });
  const vaB = new VirtualAgent({ name: 'peer-b', agentId: agentB.id, apiKey: keyB.raw_key, port });
  assert.ok(runtimeHostKeyForAgent(agentA.id) && runtimeHostKeyForAgent(agentB.id));
  await Promise.all([vaA.start(), vaB.start()]);
  t.after(() => { vaA.stop(); vaB.stop(); });
  await new Promise((r) => setTimeout(r, 200));

  step('Assignee A posts a comment mentioning itself and B via MCP add_comment');
  const self = await vaA.mcp.callTool('add_comment', {
    ticket_id: ticket.id,
    content: `note to @[agent:${agentA.id}|Me] and @[agent:${agentB.id}|Peer]`,
  });
  assert.ok(!self?.isError, `add_comment must succeed, got: ${JSON.stringify(self)}`);

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(
    vaA.mentionsFor(ticket.id).length,
    0,
    'author A must NOT receive a comment_mention for their own direct self-mention',
  );
  assert.equal(vaB.mentionsFor(ticket.id).length, 0, 'B is not on the ticket — its tag wakes nothing');

  step('Peer B mentions the assignee A — A is woken once, attributed to B');
  const peer = await vaB.mcp.callTool('add_comment', {
    ticket_id: ticket.id,
    content: `@[agent:${agentA.id}|Assignee] can you double-check this?`,
  });
  assert.ok(!peer?.isError, `add_comment must succeed, got: ${JSON.stringify(peer)}`);

  const aMention = await vaA.waitForMention((m) => m.ticket_id === ticket.id, 4000);
  assert.equal(aMention.agent_id, agentA.id, 'A is the mentioned agent');
  assert.equal(aMention.mention_source, 'direct', 'delivered via direct agent mention');
  assert.equal(aMention.actor_type, 'agent');
  assert.equal(aMention.actor_id, agentB.id, 'the author is B\'s runtime identity');

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(vaA.mentionsFor(ticket.id).length, 1, 'A gets exactly one mention — only the peer\'s');
  assert.equal(vaB.mentionsFor(ticket.id).length, 0, 'B never self-notifies');

  step('author_role: the assignee\'s comment is badged, the peer\'s is not');
  const rows = await app.get(getDataSourceToken()).getRepository('Comment')
    .find({ where: { ticket_id: ticket.id }, order: { created_at: 'ASC' } });
  const byAuthor = (id) => rows.find((c) => c.author_id === id);
  const meta = (c) => (typeof c?.metadata === 'string' ? JSON.parse(c.metadata || '{}') : (c?.metadata || {}));
  assert.equal(byAuthor(agentA.id)?.author_type, 'agent');
  assert.equal(meta(byAuthor(agentA.id)).author_role, 'assignee');
  assert.ok(byAuthor(agentB.id), 'peer comment stored under B\'s runtime identity');
  assert.equal(meta(byAuthor(agentB.id)).author_role, undefined, 'a non-assignee agent gets no role badge');

  exitAfterTests(0);
});
