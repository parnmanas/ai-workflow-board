// QA flow: the full ticket status lifecycle (docs/tickets.md), once through
// REST (a human driving the Tickets page) and once through MCP (an agent).
//
//   backlog ─(move)→ todo ─(dispatcher)→ in_progress ─→ review ─→ done
//
//   - backlog is never dispatched; moving to todo queues the ticket and the
//     dispatcher starts it at once (todo → in_progress) with ONE agent_trigger
//     addressed to the assignee — no other agent hears about it;
//   - subtasks are a checklist: no assignee, never dispatched, only todo/done,
//     and MCP refuses to move the parent to done while one is still open;
//   - review and done are never dispatched; entering done stamps
//     terminal_entered_at and leaving it clears the stamp (and a reopened
//     todo ticket is started again);
//   - archive hides the ticket from the list (include_archived / archived_only
//     bring it back), blocks moves, and unarchive restores it.
//
// Each agent is a VirtualAgent with its own Runtime Host SSE stream and MCP
// HTTP client.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  createUser,
  createWorkspace,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';
import { runtimeIdentityKey } from '../../dist/common/runtime-spec.js';

const { app, port, modules } = await bootApp({ port: 0 });
const gdst = modules.getDataSourceToken;
const ds = app.get(gdst());
const ticketRepo = ds.getRepository('Ticket');

const ws = await createWorkspace(app, gdst, 'lifecycle');
const user = await createUser(app, gdst, { name: 'driver' });
const token = app.get(modules.AuthService).createSession(user.id);

// `worker` does the REST-created ticket; `planner` creates and works its own
// ticket over MCP. Separate hosts, separate SSE streams.
const worker = await createAgent(app, gdst, ws.id, { name: 'worker', runtime: true });
const planner = await createAgent(app, gdst, ws.id, { name: 'planner', runtime: true });

const makeAgent = async (name, agent) => {
  const key = await createApiKey(app, gdst, agent.id, { workspaceId: ws.id, label: name });
  return new VirtualAgent({
    name,
    agentId: agent.id,
    apiKey: key.raw_key,
    port,
    // Pull the ticket over MCP on every trigger — the round-trip a real
    // subagent does first.
    onTrigger: async ({ mcp, trigger }) => {
      const resp = await mcp.callTool('get_ticket', { ticket_id: trigger.ticket_id });
      trigger._fetched_title = resp?.title || resp?.error || null;
    },
  });
};
const workerAgent = await makeAgent('worker', worker);
const plannerAgent = await makeAgent('planner', planner);
await Promise.all([workerAgent.start(), plannerAgent.start()]);

test.after(async () => {
  await Promise.all([workerAgent.stop(), plannerAgent.stop()]);
  await app.close().catch(() => {});
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

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const row = (id) => ticketRepo.findOneBy({ id });
const listIds = async (query = '') => (await api('GET', `/workspaces/${ws.id}/tickets${query}`)).body.tickets.map((t) => t.id);

let ticket;
let children;

test('REST: a backlog ticket with subtasks is created and never dispatched', async () => {
  step('POST /workspaces/:wsId/tickets in backlog');
  const res = await api('POST', `/workspaces/${ws.id}/tickets`, {
    title: 'Lifecycle test ticket',
    prompt_text: 'Please progress me through the statuses.',
    status: 'backlog',
    tags: ['lifecycle'],
    assignee: worker.runtime_spec,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  ticket = res.body;
  assert.equal(ticket.status, 'backlog');
  assert.deepEqual(ticket.tags, ['lifecycle']);
  assert.equal(ticket.assignee_key, runtimeIdentityKey(worker.runtime_spec));
  assert.equal(ticket.assignee.label, worker.runtime_spec.label);
  assert.equal(ticket.terminal_entered_at, null);

  step('POST /tickets/:id/children twice — the checklist');
  children = [];
  for (const title of ['write the code', 'write the tests']) {
    const child = await api('POST', `/tickets/${ticket.id}/children`, { title });
    assert.equal(child.status, 201, JSON.stringify(child.body));
    assert.equal(child.body.parent_id, ticket.id);
    assert.equal(child.body.status, 'todo');
    assert.equal(child.body.assignee, null, 'subtasks have no assignee of their own');
    children.push(child.body);
  }
  const full = await api('GET', `/tickets/${ticket.id}`);
  assert.deepEqual(full.body.children.map((c) => c.title), ['write the code', 'write the tests']);

  await settle();
  assert.equal(workerAgent.triggers.length, 0, 'backlog is never dispatched');
  assert.equal((await row(ticket.id)).status, 'backlog');
  assert.deepEqual(await listIds('?status=backlog'), [ticket.id], 'children are not listed as roots');
});

test('REST: backlog → todo queues the ticket and the dispatcher starts it for the assignee only', async () => {
  const moved = await api('PATCH', `/tickets/${ticket.id}/move`, { status: 'todo' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  const trig = await workerAgent.waitForTrigger((t) => t.ticket_id === ticket.id, 5000);
  assert.equal(trig.agent_id, ticket.assignee_key, 'trigger addressed to the assignee identity');
  assert.equal(trig.role, 'assignee');
  assert.equal(trig.trigger_source, 'start');
  assert.match(trig.ticket_prompt || '', /progress me/, 'ticket_prompt carries prompt_text');
  assert.equal(trig._wire.status, 'in_progress');
  assert.equal((await row(ticket.id)).status, 'in_progress');

  await settle();
  assert.equal(trig._fetched_title, ticket.title, 'assignee fetched the ticket via MCP get_ticket');
  assert.equal(workerAgent.triggers.length, 1, 'exactly one trigger, for the root ticket');
  for (const child of children) assert.equal(workerAgent.triggersFor(child.id).length, 0, 'subtasks are not dispatched');
  assert.equal(plannerAgent.triggers.length, 0, 'other agents hear nothing');
});

test('MCP (assignee): done is refused while a subtask is open; review is allowed and not dispatched', async () => {
  const mcp = workerAgent.mcp;
  const doneChild = await mcp.callTool('update_child_ticket', { ticket_id: children[0].id, status: 'done' });
  assert.ok(!doneChild.isError, JSON.stringify(doneChild));
  assert.equal(doneChild.status, 'done');

  const subtaskMove = await mcp.callTool('move_ticket', { ticket_id: children[1].id, status: 'done' });
  assert.equal(subtaskMove.isError, true, 'subtasks have no status lane');

  const refused = await mcp.callTool('move_ticket', { ticket_id: ticket.id, status: 'done' });
  assert.equal(refused.isError, true, 'open subtask blocks done');
  assert.match(refused.error.error, /1 child ticket\(s\) are still open/);
  assert.equal((await row(ticket.id)).status, 'in_progress');

  const review = await mcp.callTool('move_ticket', { ticket_id: ticket.id, status: 'review' });
  assert.ok(!review.isError, JSON.stringify(review));
  assert.equal(review.status, 'review');
  assert.equal(review.terminal_entered_at, null);
  await settle();
  assert.equal(workerAgent.triggersFor(ticket.id).length, 1, 'review is never dispatched');
});

test('REST: finish the checklist, review → done stamps terminal_entered_at without a trigger', async () => {
  const child = await api('PATCH', `/tickets/${children[1].id}/move`, { status: 'done' });
  assert.equal(child.status, 200, JSON.stringify(child.body));
  assert.equal((await row(children[1].id)).status, 'done');

  const done = await api('PATCH', `/tickets/${ticket.id}/move`, { status: 'done' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'done');
  assert.ok(done.body.terminal_entered_at, 'entering done stamps terminal_entered_at');
  assert.ok(done.body.children.every((c) => c.status === 'done'));

  const bogus = await api('PATCH', `/tickets/${ticket.id}/move`, { status: 'Shipped' });
  assert.equal(bogus.status, 400, 'unknown statuses are rejected');

  await settle();
  assert.equal(workerAgent.triggersFor(ticket.id).length, 1, 'done is never dispatched');
});

test('REST: archive hides the ticket and blocks moves; unarchive restores it', async () => {
  const archived = await api('POST', `/tickets/${ticket.id}/archive`);
  assert.equal(archived.status, 201, JSON.stringify(archived.body));
  assert.ok(archived.body.archived_at);
  assert.equal(archived.body.on_terminal, true, 'archived from done');

  assert.ok(!(await listIds()).includes(ticket.id), 'archived tickets drop out of the default list');
  assert.ok((await listIds('?include_archived=1')).includes(ticket.id));
  assert.deepEqual(await listIds('?archived_only=1'), [ticket.id]);

  const blocked = await api('PATCH', `/tickets/${ticket.id}/move`, { status: 'todo' });
  assert.equal(blocked.status, 409, 'an archived ticket cannot move');
  const childBlocked = await api('POST', `/tickets/${ticket.id}/children`, { title: 'late item' });
  assert.equal(childBlocked.status, 409, 'an archived ticket takes no new subtasks');

  const restored = await api('POST', `/tickets/${ticket.id}/unarchive`);
  assert.equal(restored.status, 201, JSON.stringify(restored.body));
  assert.equal(restored.body.archived_at, null);
  assert.equal(restored.body.status, 'done', 'unarchive keeps the status');
  assert.ok(restored.body.terminal_entered_at, 'done clock restarts so the archiver does not re-eat it');
  assert.ok((await listIds()).includes(ticket.id));
});

test('REST: reopening done → todo clears terminal_entered_at and starts the ticket again', async () => {
  const reopened = await api('PATCH', `/tickets/${ticket.id}/move`, { status: 'todo' });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  await workerAgent.waitForTrigger((t) => t.ticket_id === ticket.id && workerAgent.triggersFor(ticket.id).length === 2, 5000);
  const fresh = await row(ticket.id);
  assert.equal(fresh.status, 'in_progress');
  assert.equal(fresh.terminal_entered_at, null, 'leaving done clears terminal_entered_at');
});

test('MCP: an agent creates, starts, finishes, archives and restores its own ticket', async () => {
  const mcp = plannerAgent.mcp;
  const plannerKey = runtimeIdentityKey(planner.runtime_spec);

  step('create_ticket in backlog with inline subtasks');
  const created = await mcp.callTool('create_ticket', {
    title: 'MCP lifecycle ticket',
    status: 'backlog',
    tags: ['lifecycle', 'mcp'],
    assignee: planner.runtime_spec,
    subtasks: ['investigate'],
  });
  assert.ok(!created.isError, JSON.stringify(created));
  assert.equal(created.status, 'backlog');
  assert.equal(created.workspace_id, ws.id, 'defaults to the caller workspace');
  assert.equal(created.assignee_key, plannerKey);
  assert.deepEqual(created.tags, ['lifecycle', 'mcp']);
  assert.deepEqual(created.children.map((c) => c.title), ['investigate']);
  const id = created.id;
  await settle();
  assert.equal(plannerAgent.triggersFor(id).length, 0, 'backlog is never dispatched');

  step('move_ticket → todo; the dispatcher starts it');
  const bad = await mcp.callTool('move_ticket', { ticket_id: id, status: 'bogus' });
  assert.equal(bad.isError, true, 'unknown status is rejected');
  const todo = await mcp.callTool('move_ticket', { ticket_id: id, status: 'todo' });
  assert.ok(!todo.isError, JSON.stringify(todo));
  const trig = await plannerAgent.waitForTrigger((t) => t.ticket_id === id, 5000);
  assert.equal(trig.trigger_source, 'start');
  assert.equal(trig.agent_id, plannerKey);
  assert.equal((await row(id)).status, 'in_progress');
  assert.equal(workerAgent.triggersFor(id).length, 0, 'other agents hear nothing');

  const claim = await mcp.callTool('claim_ticket', { ticket_id: id });
  assert.deepEqual({ claimed: claim.claimed, status: claim.status }, { claimed: true, status: 'in_progress' }, 'claim_ticket is a no-op on in_progress');

  const mine = await mcp.callTool('get_my_tickets', { status: 'in_progress' });
  assert.deepEqual(mine.map((t) => t.id), [id], 'get_my_tickets follows the caller identity');

  step('finish the subtask, move to done');
  const childId = created.children[0].id;
  assert.ok(!(await mcp.callTool('update_child_ticket', { ticket_id: childId, status: 'done' })).isError);
  const done = await mcp.callTool('move_ticket', { ticket_id: id, status: 'done' });
  assert.ok(!done.isError, JSON.stringify(done));
  assert.equal(done.status, 'done');
  assert.ok(done.terminal_entered_at);

  step('archive_ticket / list_archived_tickets / unarchive_ticket');
  const archived = await mcp.callTool('archive_ticket', { ticket_id: id });
  assert.ok(!archived.isError, JSON.stringify(archived));
  assert.ok(archived.archived_at);
  const archivedList = await mcp.callTool('list_archived_tickets', {});
  const listed = archivedList.tickets.find((t) => t.id === id);
  assert.ok(listed, 'archived ticket is listed');
  assert.equal(listed.status, 'done', 'archived rows keep their status');
  const live = await mcp.callTool('list_tickets', {});
  assert.ok(!live.tickets.some((t) => t.id === id), 'list_tickets hides archived tickets');
  const blocked = await mcp.callTool('move_ticket', { ticket_id: id, status: 'todo' });
  assert.equal(blocked.isError, true, 'archived tickets cannot move');

  const restored = await mcp.callTool('unarchive_ticket', { ticket_id: id });
  assert.ok(!restored.isError, JSON.stringify(restored));
  assert.equal(restored.archived_at, null);
  const after = await mcp.callTool('list_tickets', { status: ['done'], tags: ['mcp'] });
  assert.deepEqual(after.tickets.map((t) => t.id), [id], 'restored ticket is back in the list');
});

exitAfterTests();
