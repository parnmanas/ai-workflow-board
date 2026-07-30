import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createTicket } from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_MENTION_AUDIT_PORT || '7894';

async function post(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('mention audit run atomically claims one retry and recognizes persisted work', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'mention-audit-retry',
  });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'Audit Agent' });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id,
    workspaceId: ws.id,
    title: 'mention retry',
  });
  const trigger = `mention:comment-1:${agent.id}`;
  const start = await post(port, `/api/agent/tickets/${ticket.id}/mention-audit-runs/start`, {
    cycle_trigger_id: trigger, agent_id: agent.id, role: 'assignee', attempt: 0,
  });
  assert.equal(start.status, 201);
  const completePath = `/api/agent/tickets/${ticket.id}/mention-audit-runs/${start.body.run_token}/complete`;
  const [a, b] = await Promise.all([
    post(port, completePath, { exit_code: 0 }),
    post(port, completePath, { exit_code: 0 }),
  ]);
  assert.deepEqual(
    [a.body.decision, b.body.decision].sort(),
    ['retry', 'retry_claimed'],
  );

  const ds = app.get(getDataSourceToken());
  const claims = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: ticket.id, action: 'silent_exit_retry_claimed' },
  });
  assert.equal(claims.length, 1);

  const retry = await post(port, `/api/agent/tickets/${ticket.id}/mention-audit-runs/start`, {
    cycle_trigger_id: trigger, agent_id: agent.id, role: 'assignee', attempt: 1,
    subagent_session_id: 'retry-session',
  });
  await ds.getRepository('Comment').save({
    ticket_id: ticket.id, author_type: 'agent', author_id: agent.id,
    author: agent.name, type: 'note', content: 'work completed',
    metadata: JSON.stringify({
      cycle_trigger_id: trigger, author_role: 'assignee',
      subagent_session_id: 'retry-session', run_provenance: retry.body.run_token,
    }),
  });
  const success = await post(
    port,
    `/api/agent/tickets/${ticket.id}/mention-audit-runs/${retry.body.run_token}/complete`,
    { exit_code: 0 },
  );
  assert.equal(success.body.decision, 'succeeded');
  assert.equal(success.body.audit_comment_count, 1);

  const mutationTicket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'mutation only',
  });
  const mutationTrigger = `mention:comment-2:${agent.id}`;
  const mutationRun = await post(port, `/api/agent/tickets/${mutationTicket.id}/mention-audit-runs/start`, {
    cycle_trigger_id: mutationTrigger, agent_id: agent.id, role: 'assignee', attempt: 0,
  });
  await ds.getRepository('ActivityLog').save({
    workspace_id: ws.id, entity_type: 'ticket', entity_id: mutationTicket.id,
    ticket_id: mutationTicket.id, action: 'updated', field_changed: 'title',
    old_value: 'before', new_value: 'after', actor_id: agent.id,
    actor_name: agent.name, role: 'assignee', trigger_source: mutationRun.body.run_token,
  });
  const mutationSuccess = await post(
    port,
    `/api/agent/tickets/${mutationTicket.id}/mention-audit-runs/${mutationRun.body.run_token}/complete`,
    { exit_code: 0 },
  );
  assert.equal(mutationSuccess.body.decision, 'succeeded');
  assert.equal(mutationSuccess.body.entity_change_count, 1);

  const exhaustedTicket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'retry exhausted',
  });
  const exhausted = await post(port, `/api/agent/tickets/${exhaustedTicket.id}/mention-audit-runs/start`, {
    cycle_trigger_id: `mention:comment-3:${agent.id}`, agent_id: agent.id,
    role: 'assignee', attempt: 1, subagent_session_id: 'silent-retry',
  });
  const exhaustedResult = await post(
    port,
    `/api/agent/tickets/${exhaustedTicket.id}/mention-audit-runs/${exhausted.body.run_token}/complete`,
    { exit_code: 0 },
  );
  assert.equal(exhaustedResult.body.decision, 'failed');
  assert.equal(exhaustedResult.body.reason, 'silent_exit_retry_exhausted');

  const spawnFailedTicket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'retry spawn failed',
  });
  const spawnFailed = await post(port, `/api/agent/tickets/${spawnFailedTicket.id}/mention-audit-runs/start`, {
    cycle_trigger_id: `mention:comment-4:${agent.id}`, agent_id: agent.id,
    role: 'assignee', attempt: 0,
  });
  const failedPath =
    `/api/agent/tickets/${spawnFailedTicket.id}/mention-audit-runs/${spawnFailed.body.run_token}/retry-spawn-failed`;
  const [failedA, failedB] = await Promise.all([
    post(port, failedPath, {}),
    post(port, failedPath, {}),
  ]);
  assert.equal(failedA.body.reason, 'silent_exit_retry_spawn_failed');
  assert.equal(failedB.body.reason, 'silent_exit_retry_spawn_failed');
  const failedRows = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: spawnFailedTicket.id, action: 'mention_audit_retry_spawn_failed' },
  });
  assert.equal(failedRows.length, 1);

  const { ws: otherWs } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'mention-audit-other-workspace',
  });
  const foreignAgent = await createAgent(app, getDataSourceToken, otherWs.id, { name: 'Foreign Agent' });
  const rejected = await post(port, `/api/agent/tickets/${ticket.id}/mention-audit-runs/start`, {
    cycle_trigger_id: `mention:foreign:${foreignAgent.id}`,
    agent_id: foreignAgent.id, role: 'assignee', attempt: 0,
  });
  assert.equal(rejected.status, 400);
});
