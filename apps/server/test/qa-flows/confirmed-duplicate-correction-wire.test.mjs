import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createTicket } from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_DUPLICATE_CORRECTION_PORT || '7854';

test('MCP duplicate correction emits exactly one selected-role wire trigger and preserves canonical', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const { ws, columns } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'duplicate-correction-wire', envRepo: true, maxConcurrent: 5,
  });
  const assignee = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'worker' });
  const assigneeKey = await createApiKey(app, modules.getDataSourceToken, assignee.id, { workspaceId: ws.id });
  const operator = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'operator' });
  const operatorKey = await createApiKey(app, modules.getDataSourceToken, operator.id, { workspaceId: ws.id });
  const va = new VirtualAgent({ name: 'worker', agentId: assignee.id, apiKey: assigneeKey.raw_key, port });
  await va.start();
  t.after(async () => va.stop());
  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: operatorKey.raw_key });
  t.after(async () => mcp.close());

  const canonical = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.done.id, workspaceId: ws.id, title: 'unrelated done ticket',
  });
  const report = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'independent operation', assigneeId: assignee.id,
  });
  await ds.getRepository('Ticket').update(report.id, { canonical_ticket_id: canonical.id });
  await ds.getRepository('DispatchIntent').save({
    workspace_id: ws.id, board_id: columns.inProgress.board_id, ticket_id: report.id,
    role: 'assignee', agent_id: assignee.id, trigger_source: 'old', status: 'in_flight',
    attempts: 209, dispatch_generation: 209, next_attempt_at: new Date(),
  });

  const result = await mcp.callTool('correct_confirmed_ticket_duplicate', {
    ticket_id: report.id, role: 'assignee',
  });
  assert.equal(result.dispatch_attempted, 1);
  assert.equal(result.dispatch_landed, 1);
  assert.equal(result.dispatch_trigger_ids.length, 1);
  const trigger = await va.waitForTrigger(tr => tr.ticket_id === report.id, 4000);
  assert.equal(trigger.role, 'assignee');
  assert.equal(va.triggers.filter(tr => tr.ticket_id === report.id).length, 1);
  const intent = await ds.getRepository('DispatchIntent').findOneByOrFail({
    ticket_id: report.id, role: 'assignee', status: 'in_flight',
  });
  assert.equal(intent.last_trigger_id, trigger.trigger_id);
  assert.equal(intent.dispatch_generation, 1);
  assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: canonical.id })).title, 'unrelated done ticket');
  assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: canonical.id })).column_id, columns.done.id);
});

exitAfterTests();
