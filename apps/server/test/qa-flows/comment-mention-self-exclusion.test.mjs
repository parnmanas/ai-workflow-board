// QA flow: 다중담당자 T3 — comment_mention self-exclusion.
//
// T2 gave the DISPATCH path a per-holder self-guard. This is its twin on the
// MENTION path: when a co-holder writes `@[role:assignee]` to summon their
// peers for discussion, the server must fire comment_mention to every OTHER
// holder but NEVER back to the author. Without this, an assignee mentioning
// their own role would notify themselves → agent-manager re-spawns the author's
// own subagent → recursive loop.
//
// Two agents (A, B) both hold the assignee role. A drives the REAL MCP
// add_comment tool:
//   1. `@[role:assignee]` fan-out   → B gets exactly one comment_mention,
//                                      A (author) gets zero.
//   2. direct `@[agent:A]` + `@[agent:B]` in one comment
//                                   → B gets it, A's own self-mention dropped.
//
// Regression cover for DoD #1 (전원 호출) and #5 (재귀 방지) of ticket 40024001.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createTicket,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

// Each test boots its own app on a distinct port so a not-yet-released listener
// from the prior test can't collide (EADDRINUSE).
const BASE_PORT = parseInt(process.env.QA_MENTION_SELF_EXCL_PORT || '7853', 10);
process.env.PORT = String(BASE_PORT);

/**
 * Seed a SECOND agent holder onto the ticket's assignee role. createTicket
 * wrote the first holder with holder_key='' (fixture default); a distinct
 * holder_key ('agent:<id>') is required or the second row collides on the
 * uniq_ticket_role_holder index (same shape as multi-holder-fanout.test.mjs).
 */
async function addAssigneeHolder(app, getDataSourceToken, { ticketId, workspaceId, agentId }) {
  const ds = app.get(getDataSourceToken());
  const role = await ds.getRepository('WorkspaceRole').findOne({
    where: { workspace_id: workspaceId, slug: 'assignee' },
  });
  assert.ok(role, 'assignee WorkspaceRole must exist');
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  await assignRepo.save(assignRepo.create({
    ticket_id: ticketId,
    role_id: role.id,
    agent_id: agentId,
    user_id: null,
    holder_key: `agent:${agentId}`,
  }));
}

async function seedTwoAssigneeScene(app, getDataSourceToken, port, wsName) {
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: wsName });

  const agentA = await createAgent(app, getDataSourceToken, ws.id, { name: 'assignee-a' });
  const keyA = await createApiKey(app, getDataSourceToken, agentA.id, { workspaceId: ws.id, label: 'assignee-a' });
  const agentB = await createAgent(app, getDataSourceToken, ws.id, { name: 'assignee-b' });
  const keyB = await createApiKey(app, getDataSourceToken, agentB.id, { workspaceId: ws.id, label: 'assignee-b' });

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'Discussion self-exclusion',
    assigneeId: agentA.id,
  });
  await addAssigneeHolder(app, getDataSourceToken, {
    ticketId: ticket.id, workspaceId: ws.id, agentId: agentB.id,
  });

  const vaA = new VirtualAgent({ name: 'assignee-a', agentId: agentA.id, apiKey: keyA.raw_key, port });
  const vaB = new VirtualAgent({ name: 'assignee-b', agentId: agentB.id, apiKey: keyB.raw_key, port });
  await Promise.all([vaA.start(), vaB.start()]);
  await new Promise((r) => setTimeout(r, 200));

  return { ws, columns, agentA, agentB, ticket, vaA, vaB };
}

test('role fan-out self-exclusion: co-holder gets comment_mention, author does not', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { agentA, agentB, ticket, vaA, vaB } =
    await seedTwoAssigneeScene(app, getDataSourceToken, port, 'mention-self-excl');
  t.after(() => { vaA.stop(); vaB.stop(); });

  step('Author (holder A) posts @[role:assignee] to summon co-assignees via MCP add_comment');
  const res = await vaA.mcp.callTool('add_comment', {
    ticket_id: ticket.id,
    content: '@[role:assignee|Assignees] 이 phase 어떻게 나눌까요?',
    author_role: 'assignee',
  });
  assert.ok(!res?.isError, `add_comment must succeed, got: ${JSON.stringify(res)}`);

  step('Verify co-holder B received exactly one role-sourced comment_mention');
  const bMention = await vaB.waitForMention((m) => m.ticket_id === ticket.id, 4000);
  assert.equal(bMention.agent_id, agentB.id, 'B is the mentioned agent');
  assert.equal(bMention.mention_source, 'role', 'delivered via role fan-out');

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(vaB.mentionsFor(ticket.id).length, 1, 'B gets exactly one mention (no duplicate)');
  assert.equal(
    vaA.mentionsFor(ticket.id).length,
    0,
    'author A must NOT receive a comment_mention for their own role fan-out (self-exclusion)',
  );
});

test('direct self-mention dropped: @[agent:self] excluded, @[agent:other] delivered', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT + 1 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { agentA, agentB, ticket, vaA, vaB } =
    await seedTwoAssigneeScene(app, getDataSourceToken, port, 'mention-self-excl-direct');
  t.after(() => { vaA.stop(); vaB.stop(); });

  step('Author A posts a comment mentioning BOTH themselves and B directly');
  const res = await vaA.mcp.callTool('add_comment', {
    ticket_id: ticket.id,
    content: `note to @[agent:${agentA.id}|Me] and @[agent:${agentB.id}|Peer]`,
    author_role: 'assignee',
  });
  assert.ok(!res?.isError, `add_comment must succeed, got: ${JSON.stringify(res)}`);

  step('Verify B received the direct mention but A did not self-notify');
  const bMention = await vaB.waitForMention((m) => m.ticket_id === ticket.id, 4000);
  assert.equal(bMention.agent_id, agentB.id, 'B is the mentioned agent');
  assert.equal(bMention.mention_source, 'direct', 'delivered via direct agent mention');

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(vaB.mentionsFor(ticket.id).length, 1, 'B gets exactly one direct mention');
  assert.equal(
    vaA.mentionsFor(ticket.id).length,
    0,
    'author A must NOT receive a comment_mention for their own direct self-mention',
  );

  exitAfterTests(0);
});
