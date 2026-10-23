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
//   - unpend re-sends; a paused account starts nothing until resumed;
//   - the supervisor re-sends a dead in_progress ticket (force respawn) and
//     parks it for a human after MAX_SUPERVISOR_REDISPATCHES;
//   - an agent comment restarts that count; a silent-exit warning does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createProject, createTicket, createUser, createAccount, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { VirtualAgent } from './helpers/virtual-agent.mjs';

const { app, port, modules } = await bootApp({ port: 0 });
const gdst = modules.getDataSourceToken;
const ds = app.get(gdst());
const { AuthService } = await import('../dist/services/auth.service.js');
const { TicketDispatchService, MAX_SUPERVISOR_REDISPATCHES } = await import('../dist/modules/agents/ticket-dispatch.service.js');
const dispatcher = app.get(TicketDispatchService);

const ws = await createAccount(app, gdst, 'dispatch');
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
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Account-Id': ws.id },
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
  const res = await api('POST', `/accounts/${ws.id}/tickets`, {
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
  const res = await api('POST', `/accounts/${ws.id}/tickets`, { title: 'second', assignee: agent.runtime_spec });
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

test('a paused account starts nothing until it is resumed', async () => {
  await api('PATCH', `/tickets/${second.id}/move`, { status: 'review' });
  await api('PATCH', `/accounts/${ws.id}`, { dispatch_paused_at: true });
  const third = (await api('POST', `/accounts/${ws.id}/tickets`, { title: 'third', assignee: agent.runtime_spec })).body;
  await settle();
  assert.equal(await status(third.id), 'todo');
  const run = await api('POST', `/tickets/${third.id}/trigger`);
  assert.equal(run.body.dispatched, false);
  assert.equal(run.body.reason, 'account_paused');

  await api('PATCH', `/accounts/${ws.id}`, { dispatch_paused_at: null });
  await vagent.waitForTrigger((t) => t.ticket_id === third.id, 5000);
  assert.equal(await status(third.id), 'in_progress');
});

test('the supervisor re-sends a dead ticket, then parks it for a human', async () => {
  const [third] = await ds.getRepository('Ticket').find({ where: { account_id: ws.id, title: 'third' } });
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

test('a silent-exit warning keeps the supervisor count; an agent comment restarts it', async () => {
  // Unassigned, so neither the queue nor the supervisor sweep touches it.
  const ticket = await createTicket(app, gdst, { accountId: ws.id, title: 'silent exit', status: 'in_progress' });
  const tickets = ds.getRepository('Ticket');
  const redispatches = async () => (await tickets.findOneBy({ id: ticket.id })).supervisor_redispatches;
  await tickets.update({ id: ticket.id }, { supervisor_redispatches: 2 });

  const warning = await fetch(`http://localhost:${port}/api/agent/tickets/${ticket.id}/silent-exit-comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'subagent exited without a trace', exit_code: 0, role: 'assignee' }),
  });
  assert.equal(warning.status, 201);
  await settle();
  assert.equal(await redispatches(), 2, 'an agent that stopped without a trace made no progress');

  const progress = await vagent.mcp.callTool('add_comment', { ticket_id: ticket.id, content: 'parser implemented, tests pass' });
  assert.ok(progress?.id, `the agent comment was written: ${JSON.stringify(progress)}`);
  for (let i = 0; i < 50 && (await redispatches()) !== 0; i += 1) await settle(100);
  assert.equal(await redispatches(), 0, 'the agent writing on the ticket is progress');
});

test('tickets list filters by status, tags and project', async () => {
  const byTag = await api('GET', `/accounts/${ws.id}/tickets?tags=terrain`);
  assert.deepEqual(byTag.body.tickets.map((t) => t.id), [first.id]);
  assert.ok(byTag.body.tags.some((t) => t.tag === 'terrain'));
  const byStatus = await api('GET', `/accounts/${ws.id}/tickets?status=review`);
  assert.deepEqual(byStatus.body.tickets.map((t) => t.id), [second.id]);
  const byProject = await api('GET', `/accounts/${ws.id}/tickets?project_id=${project.id}`);
  assert.deepEqual(byProject.body.tickets.map((t) => t.id), [first.id]);
  assert.equal(byProject.body.tickets[0].assignee.label, agent.runtime_spec.label);
});

test('the trigger waits for the host to prepare the assignee runtime, and a host refusal stops it', async () => {
  // Fired unawaited, the preparation (spawn_agent: credential into cli-home) lost
  // the race to the trigger and tickets ran without their credential.
  const row = await ds.getRepository('Ticket').findOneBy({ id: first.id });
  const ticket = { ...row, status: 'in_progress' };
  const original = dispatcher.commands;
  try {
    let release;
    const prepares = [];
    dispatcher.commands = {
      provisionSlotIdentity: (spec, opts) => {
        prepares.push(opts);
        return new Promise((resolve) => { release = resolve; });
      },
    };
    const sentBefore = vagent.triggersFor(ticket.id).length;
    const pending = dispatcher.dispatch(ticket, 'manual');
    await settle(100);
    assert.equal(prepares.length, 1);
    assert.ok(prepares[0].waitForAckMs > 0, 'preparation waits for the host ack');
    assert.equal(vagent.triggersFor(ticket.id).length, sentBefore, 'no trigger before the runtime is prepared');
    release({ ok: true, reason: 'provisioned' });
    assert.equal((await pending).dispatched, true);
    await vagent.waitForTrigger((t) => t.ticket_id === ticket.id && t.trigger_source === 'manual', 5000);

    dispatcher.commands = {
      provisionSlotIdentity: async () => ({ ok: false, reason: 'spawn_agent: configured credential cred-x could not be loaded', refused: true }),
    };
    const sent = vagent.triggersFor(ticket.id).length;
    assert.deepEqual(await dispatcher.dispatch(ticket, 'manual'), { dispatched: false, reason: 'runtime_refused' });
    await settle(100);
    assert.equal(vagent.triggersFor(ticket.id).length, sent, 'a refused runtime is never triggered on another login');
    const failed = await ds.getRepository('ActivityLog').findOne({
      where: { ticket_id: ticket.id, action: 'dispatch_failed' },
      order: { created_at: 'DESC' },
    });
    assert.match(failed.new_value, /could not be loaded/);

    // Offline / timeout says nothing about the runtime — the manager prepares it itself.
    dispatcher.commands = { provisionSlotIdentity: async () => ({ ok: false, reason: 'provision_ack_timeout' }) };
    assert.equal((await dispatcher.dispatch(ticket, 'manual')).dispatched, true);
  } finally {
    dispatcher.commands = original;
  }
});

test('the work order lists the ticket\'s open child tickets by id', async () => {
  // Children are the assignee's own checklist; the order tells it which ones are left (822e54d6).
  const child = await api('POST', `/tickets/${first.id}/children`, { title: 'wire the screens' });
  assert.ok(child.status < 300, JSON.stringify(child.body));
  const row = await ds.getRepository('Ticket').findOneBy({ id: first.id });
  const result = await dispatcher.dispatch({ ...row, status: 'in_progress' }, 'manual');
  assert.equal(result.dispatched, true, JSON.stringify(result));
  const trigger = await vagent.waitForTrigger((t) => t.ticket_id === first.id && t.trigger_id === result.trigger_id, 5000);
  const order = trigger._wire.column_prompt.content;
  assert.match(order, /## Child tickets \(your checklist\)/);
  assert.ok(order.includes(`- \`${child.body.id}\` wire the screens`), order);
});

test('suppressed replay rechecks state and ownership and rebuilds the current checklist', async () => {
  const created = await api('POST', `/accounts/${ws.id}/tickets`, { title: 'replay freshness', status: 'backlog', assignee: agent.runtime_spec, project_id: project.id });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const hostId = agent.runtime_spec.manager_agent_id;
  const repo = ds.getRepository('Ticket');
  const row = await repo.findOneBy({ id });
  const refresh = (accountId = ws.id, host = hostId, assignee = row.assignee_key) => dispatcher.prepareSuppressedReplay(id, accountId, host, assignee);
  // Isolate the fixture from activity-driven dispatch while exercising the real
  // DB reads and payload builder used by the replay endpoint.
  await repo.update(id, { status: 'in_progress' });
  const child = await api('POST', `/tickets/${id}/children`, { title: 'fresh checklist item' });
  assert.ok(child.status < 300, JSON.stringify(child.body));
  const fresh = await refresh();
  assert.equal(fresh.payload.status, 'in_progress');
  assert.match(fresh.payload.column_prompt.content, /fresh checklist item/);
  await repo.update(child.body.id, { status: 'done' });
  const updated = await refresh();
  assert.match(updated.payload.column_prompt.content, /All 1 child tickets of this ticket are done/);
  assert.doesNotMatch(updated.payload.column_prompt.content, /fresh checklist item/);
  for (const status of ['done', 'review', 'todo', 'backlog']) {
    await repo.update(id, { status });
    assert.equal((await refresh()).reason, 'ticket_inactive');
  }
  await repo.update(id, { status: 'in_progress' });
  for (const flag of ['pending_user_action', 'pending_on_tickets', 'pending_ci_wait']) {
    await repo.update(id, { [flag]: true });
    assert.equal((await refresh()).reason, 'ticket_pending');
    await repo.update(id, { [flag]: false });
  }
  assert.equal((await refresh(ws.id, hostId, 'different-assignee')).reason, 'assignee_changed');
  assert.equal((await refresh(ws.id, 'different-host')).reason, 'host_changed');
  assert.equal((await refresh('different-account')).reason, 'ticket_not_found');
  const devMode = process.env.AGENT_DEV_MODE;
  process.env.AGENT_DEV_MODE = 'false';
  const response = await fetch(`http://localhost:${port}/api/agent/tickets/${id}/suppressed-replay`, {
    method: 'POST', headers: { 'X-Agent-Key': runtimeHostKeyForAgent(agent.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: row.assignee_key }),
  });
  process.env.AGENT_DEV_MODE = devMode;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).payload.ticket_id, id);
  await repo.update(id, { status: 'done' });
});

exitAfterTests();
