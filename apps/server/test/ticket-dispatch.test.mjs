// TicketDispatchService end to end (docs/tickets.md): the one place that decides
// when a ticket's assignee gets an agent_trigger.
//
//   - a todo ticket with an assignee starts at once (todo → in_progress) and
//     the trigger carries the single-agent work order, status, the project and
//     the project's main clone folder on the assignee's host;
//   - capacity: a second todo ticket for the same agent waits until the first
//     leaves in_progress;
//   - a HUMAN comment on an in_progress ticket re-sends it; an agent comment
//     does not;
//   - unpend re-sends; a paused workspace starts nothing until resumed;
//   - the supervisor re-sends a dead in_progress ticket (force respawn) and
//     parks it for a human after MAX_SUPERVISOR_REDISPATCHES.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createProject, createUser, createWorkspace, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { VirtualAgent } from './helpers/virtual-agent.mjs';

const { app, port, modules } = await bootApp({ port: 0 });
const gdst = modules.getDataSourceToken;
const ds = app.get(gdst());
const { AuthService } = await import('../dist/services/auth.service.js');
const { TicketDispatchService, MAX_SUPERVISOR_REDISPATCHES } = await import('../dist/modules/agents/ticket-dispatch.service.js');
const dispatcher = app.get(TicketDispatchService);

const ws = await createWorkspace(app, gdst, 'dispatch');
const admin = await createUser(app, gdst, { name: 'admin', role: 'admin' });
const token = app.get(AuthService).createSession(admin.id);
const agent = await createAgent(app, gdst, ws.id, { name: 'worker', runtime: true });
const project = await createProject(app, gdst, ws.id, {
  name: 'game',
  hostFolders: [{ hostId: agent.runtime_spec.manager_agent_id, path: '/srv/game' }],
});
const vagent = new VirtualAgent({ name: 'worker', agentId: agent.id, apiKey: runtimeHostKeyForAgent(agent.id), port });
await vagent.start();

test.after(async () => {
  await vagent.stop();
  await app.close();
});

async function api(method, path, body) {
  const res = await fetch(`http://localhost:${port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Workspace-Id': ws.id },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const status = async (id) => (await ds.getRepository('Ticket').findOneBy({ id })).status;
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

let first;
let second;

test('a todo ticket with an assignee starts at once and carries the work order', async () => {
  const res = await api('POST', `/workspaces/${ws.id}/tickets`, {
    title: 'implement terrain', assignee: agent.runtime_spec, project_id: project.id, tags: ['terrain'],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  first = res.body;
  const trigger = await vagent.waitForTrigger((t) => t.ticket_id === first.id, 5000);
  const wire = trigger._wire;
  assert.equal(trigger.role, 'assignee');
  assert.equal(trigger.trigger_source, 'start');
  assert.equal(wire.status, 'in_progress');
  assert.equal(wire.current_column_kind, 'active');
  assert.equal(wire.column_prompt.template_id, 'builtin:ticket-work-order');
  assert.match(wire.column_prompt.content, /only agent on this ticket/);
  assert.match(wire.column_prompt.content, /\/srv\/game/);
  assert.equal(wire.base_repo.id, project.id);
  assert.equal(wire.base_repo.main_clone_dir, '/srv/game');
  assert.equal(wire.project.id, project.id);
  assert.equal(await status(first.id), 'in_progress');
});

test('a second ticket for a busy agent waits in todo until the first leaves in_progress', async () => {
  const res = await api('POST', `/workspaces/${ws.id}/tickets`, { title: 'second', assignee: agent.runtime_spec });
  second = res.body;
  await settle();
  assert.equal(await status(second.id), 'todo');
  assert.equal(vagent.triggersFor(second.id).length, 0);

  const moved = await api('PATCH', `/tickets/${first.id}/move`, { status: 'done' });
  assert.equal(moved.status, 200);
  assert.ok(moved.body.terminal_entered_at, 'done stamps terminal_entered_at');
  await vagent.waitForTrigger((t) => t.ticket_id === second.id && t.trigger_source === 'start', 5000);
  assert.equal(await status(second.id), 'in_progress');
});

test('a human comment re-sends an in_progress ticket; an agent comment does not', async () => {
  const before = vagent.triggersFor(second.id).length;
  const res = await api('POST', `/tickets/${second.id}/comments`, { content: 'please also cover the edge case' });
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.body));
  await vagent.waitForTrigger((t) => t.ticket_id === second.id && t.trigger_source === 'comment', 5000);

  const afterHuman = vagent.triggersFor(second.id).length;
  assert.equal(afterHuman, before + 1);
  await vagent.mcp.callTool('add_comment', { ticket_id: second.id, content: 'working on it' });
  await settle();
  assert.equal(vagent.triggersFor(second.id).length, afterHuman);
});

test('unpend re-sends the ticket', async () => {
  await api('PATCH', `/tickets/${second.id}`, { pending_user_action: true, pending_reason: 'need a decision' });
  await settle();
  const res = await api('PATCH', `/tickets/${second.id}`, { pending_user_action: false });
  assert.equal(res.status, 200);
  await vagent.waitForTrigger((t) => t.ticket_id === second.id && t.trigger_source === 'unpend', 5000);
});

test('a paused workspace starts nothing until it is resumed', async () => {
  await api('PATCH', `/tickets/${second.id}/move`, { status: 'review' });
  await api('PATCH', `/workspaces/${ws.id}`, { dispatch_paused_at: true });
  const third = (await api('POST', `/workspaces/${ws.id}/tickets`, { title: 'third', assignee: agent.runtime_spec })).body;
  await settle();
  assert.equal(await status(third.id), 'todo');
  const run = await api('POST', `/tickets/${third.id}/trigger`);
  assert.equal(run.body.dispatched, false);
  assert.equal(run.body.reason, 'workspace_paused');

  await api('PATCH', `/workspaces/${ws.id}`, { dispatch_paused_at: null });
  await vagent.waitForTrigger((t) => t.ticket_id === third.id, 5000);
  assert.equal(await status(third.id), 'in_progress');
});

test('the supervisor re-sends a dead ticket, then parks it for a human', async () => {
  const [third] = await ds.getRepository('Ticket').find({ where: { workspace_id: ws.id, title: 'third' } });
  const later = Date.now() + 3 * 60 * 60 * 1000;
  for (let i = 0; i < MAX_SUPERVISOR_REDISPATCHES; i += 1) {
    await dispatcher.supervise(later + i * 60 * 60 * 1000);
  }
  const supervisorSends = () => vagent.triggersFor(third.id).filter((t) => t.trigger_source === 'supervisor');
  for (let i = 0; i < 50 && supervisorSends().length < MAX_SUPERVISOR_REDISPATCHES; i += 1) await settle(100);
  const sent = supervisorSends();
  assert.equal(sent.length, MAX_SUPERVISOR_REDISPATCHES);
  assert.equal(sent[0]._wire.force_respawn, true);

  await dispatcher.supervise(later + 10 * 60 * 60 * 1000);
  const parked = await ds.getRepository('Ticket').findOneBy({ id: third.id });
  assert.equal(parked.pending_user_action, true);
  assert.match(parked.pending_reason, /stopped/);
});

test('tickets list filters by status, tags and project', async () => {
  const byTag = await api('GET', `/workspaces/${ws.id}/tickets?tags=terrain`);
  assert.deepEqual(byTag.body.tickets.map((t) => t.id), [first.id]);
  assert.ok(byTag.body.tags.some((t) => t.tag === 'terrain'));
  const byStatus = await api('GET', `/workspaces/${ws.id}/tickets?status=review`);
  assert.deepEqual(byStatus.body.tickets.map((t) => t.id), [second.id]);
  const byProject = await api('GET', `/workspaces/${ws.id}/tickets?project_id=${project.id}`);
  assert.deepEqual(byProject.body.tickets.map((t) => t.id), [first.id]);
  assert.equal(byProject.body.tickets[0].assignee.label, agent.runtime_spec.label);
});

exitAfterTests();
