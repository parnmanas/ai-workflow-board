// QA flow: comment_mention delivery is scoped to a single target agent.
//
// comment_mention is the SSE channel used when a comment author @-tags a
// specific agent. Critical to verify:
//   - The mentioned agent receives the event.
//   - No sibling agent in the same workspace receives it.
//   - No agent in a different workspace receives it (workspace-scope safety).

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

process.env.PORT = process.env.QA_MENTION_PORT || '7808';

test('comment_mention is delivered only to the mentioned agent (workspace-scoped)', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, activityEvents } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'mention',
  });
  const ws2 = (await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'other-ws' })).ws;

  const alphaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'alpha' });
  const alphaKey = await createApiKey(app, getDataSourceToken, alphaAgent.id, {
    workspaceId: ws.id,
    label: 'alpha',
  });
  const betaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'beta' });
  const betaKey = await createApiKey(app, getDataSourceToken, betaAgent.id, {
    workspaceId: ws.id,
    label: 'beta',
  });
  const foreignAgent = await createAgent(app, getDataSourceToken, ws2.id, { name: 'foreign' });
  const foreignKey = await createApiKey(app, getDataSourceToken, foreignAgent.id, {
    workspaceId: ws2.id,
    label: 'foreign',
  });

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'Mention target',
  });

  const alphaVA = new VirtualAgent({
    name: 'alpha',
    agentId: alphaAgent.id,
    apiKey: alphaKey.raw_key,
    port,
  });
  const betaVA = new VirtualAgent({
    name: 'beta',
    agentId: betaAgent.id,
    apiKey: betaKey.raw_key,
    port,
  });
  const foreignVA = new VirtualAgent({
    name: 'foreign',
    agentId: foreignAgent.id,
    apiKey: foreignKey.raw_key,
    port,
  });
  await Promise.all([alphaVA.start(), betaVA.start(), foreignVA.start()]);
  t.after(async () => {
    await Promise.all([alphaVA.stop(), betaVA.stop(), foreignVA.stop()]);
  });
  await new Promise((r) => setTimeout(r, 250));

  step('Emit comment_mention event scoped to alpha agent only');
  // Emit a mention explicitly targeted at alpha only.
  activityEvents.emit('comment_mention', {
    ticket_id: ticket.id,
    comment_id: 'cmt-mention-1',
    workspace_id: ws.id,
    agent_id: alphaAgent.id,
    actor_id: 'user-x',
    actor_type: 'user',
    actor_name: 'Some User',
    content: '@alpha please look at this',
    role_prompt: alphaAgent.role_prompt,
    mention_source: 'direct',
  });

  const mention = await alphaVA.waitForMention((m) => m.ticket_id === ticket.id, 4000);
  assert.equal(mention.agent_id, alphaAgent.id);
  assert.equal(mention.mention_source, 'direct');
  assert.match(mention.content || '', /@alpha/);

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(betaVA.mentionsFor(ticket.id).length, 0, 'beta must not see alpha mention');
  assert.equal(
    foreignVA.mentionsFor(ticket.id).length,
    0,
    'cross-workspace agent must not see mention',
  );

  exitAfterTests(0);
});
