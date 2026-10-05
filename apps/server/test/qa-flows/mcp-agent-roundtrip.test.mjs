// QA: a virtual agent receives an SSE trigger and responds by calling MCP
// tools. Verifies the closed-loop contract (SSE in → tool call out) the
// real proxy.mjs + Claude CLI stack depends on.
//
// A human creates a `todo` ticket for the agent over REST; the dispatcher
// starts it (todo → in_progress) and sends agent_trigger; the agent answers
// with MCP add_comment + move_ticket { status: 'review' } (docs/tickets.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createAccount,
  createAgent,
  createApiKey,
  createUser,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_MCP_ROUNDTRIP_PORT || '0';

test('Virtual agent reacts to agent_trigger by calling MCP move_ticket + add_comment', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;

  const ws = await createAccount(app, getDataSourceToken, 'roundtrip');
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker', runtime: true });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, {
    accountId: ws.id,
    label: 'worker',
  });
  const user = await createUser(app, getDataSourceToken, { name: 'manager' });
  const token = app.get(AuthService).createSession(user.id);

  const va = new VirtualAgent({
    name: 'worker',
    agentId: worker.id,
    apiKey: workerKey.raw_key,
    port,
    onTrigger: async ({ mcp, trigger }) => {
      await mcp.callTool('add_comment', {
        ticket_id: trigger.ticket_id,
        content: 'Got it — advancing to review.',
        type: 'note',
      });
      await mcp.callTool('move_ticket', {
        ticket_id: trigger.ticket_id,
        status: 'review',
      });
    },
  });
  await va.start();
  t.after(() => va.stop());
  await new Promise((r) => setTimeout(r, 200));

  step('Create a todo ticket for the worker over REST — the dispatcher starts it');
  const res = await fetch(`http://localhost:${port}/api/accounts/${ws.id}/tickets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Account-Id': ws.id },
    body: JSON.stringify({
      title: 'Roundtrip ticket',
      prompt_text: 'Move me to review and leave a note.',
      assignee: worker.runtime_spec,
    }),
  });
  assert.equal(res.status, 201);
  const ticket = await res.json();
  assert.equal(ticket.status, 'todo', 'REST create defaults to todo');

  step('Wait for trigger, then verify agent called add_comment + move_ticket via MCP');
  const trigger = await va.waitForTrigger((tr) => tr.ticket_id === ticket.id, 4000);
  assert.equal(trigger.role, 'assignee');
  assert.equal(trigger.trigger_source, 'start');

  // Poll DB until the agent's reactions commit (move + comment).
  const ticketRepo = app.get(getDataSourceToken()).getRepository('Ticket');
  const commentRepo = app.get(getDataSourceToken()).getRepository('Comment');
  const deadline = Date.now() + 8000;
  let finalTicket;
  while (Date.now() < deadline) {
    finalTicket = await ticketRepo.findOne({ where: { id: ticket.id } });
    if (finalTicket?.status === 'review') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(finalTicket?.status, 'review', 'Agent moved ticket to review via MCP');

  // System comments may also be posted on the ticket; filter to the
  // agent-authored ones we actually care about.
  const allComments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  const agentComments = allComments.filter((c) => c.author_type === 'agent');
  assert.equal(agentComments.length, 1, 'Exactly one agent-authored comment');
  assert.equal(agentComments[0].content, 'Got it — advancing to review.');
  assert.equal(agentComments[0].author_id, worker.id, 'authored by the assignee runtime identity');
  exitAfterTests(0);
});
