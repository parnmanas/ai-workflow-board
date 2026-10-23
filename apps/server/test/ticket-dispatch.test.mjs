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
//   - an agent comment restarts that count; a silent-exit warning does not,
//     and neither does a manager auto-notice (add_comment with auto_notice) —
//     which only the Host's manager key can post: a runtime key's comment is
//     progress whatever author or flag it claims.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createApiKey, createProject, createTicket, createUser, createAccount, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { VirtualAgent } from './helpers/virtual-agent.mjs';

const { app, port, modules } = await bootApp({ port: 0 });
const gdst = modules.getDataSourceToken;
const ds = app.get(gdst());
const { AuthService } = await import('../dist/services/auth.service.js');
const { TicketDispatchService, MAX_SUPERVISOR_REDISPATCHES, SUPERVISOR_LIVE_QUIET_LIMIT_MS, SUPERVISOR_LIVE_ACK_TTL_MS } = await import('../dist/modules/agents/ticket-dispatch.service.js');
const dispatcher = app.get(TicketDispatchService);
const { Ticket } = await import('../dist/entities/Ticket.js');

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

// Runs `write` (which creates one comment) and resolves once the dispatcher has
// finished handling that comment's activity, so a count that did not change is
// read after the listener ran rather than before it.
async function afterDispatcherHandles(write) {
  const runs = [];
  dispatcher.onActivity = function (activity) {
    const run = TicketDispatchService.prototype.onActivity.call(this, activity);
    runs.push({ activity, run });
    return run;
  };
  try {
    const comment = await write();
    assert.ok(comment?.id, `the comment was written: ${JSON.stringify(comment)}`);
    const handled = runs.find(({ activity }) =>
      activity.entity_type === 'comment' && activity.action === 'created' && activity.entity_id === comment.id);
    assert.ok(handled, 'the dispatcher saw the comment');
    await handled.run;
    return { comment, activity: handled.activity };
  } finally {
    delete dispatcher.onActivity;
  }
}

const autoNotice = (ticketId, content) => vagent.mcp.callTool('add_comment', {
  ticket_id: ticketId, content, metadata: { auto_notice: true },
});

test('a manager auto-notice keeps the supervisor count; the same Host writing without it restarts it', async () => {
  // Unassigned, so neither the queue nor the supervisor sweep touches it.
  const ticket = await createTicket(app, gdst, { accountId: ws.id, title: 'auto notice', status: 'in_progress' });
  const tickets = ds.getRepository('Ticket');
  const redispatches = async () => (await tickets.findOneBy({ id: ticket.id })).supervisor_redispatches;
  await tickets.update({ id: ticket.id }, { supervisor_redispatches: 2 });

  const notice = await afterDispatcherHandles(() => autoNotice(ticket.id, '⚠️ duplicate dispatch suppressed'));
  assert.equal(notice.comment.author_type, 'agent', 'the notice is stored under the Host');
  assert.equal(notice.activity.actor_id, 'system', 'the Host\'s auto-notice is logged as a system actor');
  assert.equal(await redispatches(), 2, 'a notice about the dispatch is not the agent making progress');

  const plain = await afterDispatcherHandles(() => vagent.mcp.callTool('add_comment', {
    ticket_id: ticket.id, content: 'parser implemented, tests pass',
  }));
  assert.notEqual(plain.activity.actor_id, 'system');
  assert.equal(await redispatches(), 0, 'without auto_notice the same caller is the agent reporting progress');
});

test('a runtime key cannot pass its own comment off as a manager notice', async () => {
  // A runtime (rt-) key is bound to the same Host as the manager key, so the
  // session's agentId is the Host id too. Only the manager key is the manager.
  const ticket = await createTicket(app, gdst, { accountId: ws.id, title: 'runtime key notice', status: 'in_progress' });
  const tickets = ds.getRepository('Ticket');
  const hostId = agent.runtime_spec.manager_agent_id;
  const key = await createApiKey(app, gdst, agent.id, { accountId: ws.id, label: 'worker', hostId });
  const runtime = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  for (const claim of [
    { metadata: { auto_notice: true } },
    { author_id: hostId, metadata: { auto_notice: true } },
    { author_id: 'system' },
  ]) {
    await tickets.update({ id: ticket.id }, { supervisor_redispatches: 2 });
    const { activity } = await afterDispatcherHandles(() => runtime.callTool('add_comment', {
      ticket_id: ticket.id, content: 'parser implemented, tests pass', ...claim,
    }));
    assert.notEqual(activity.actor_id, 'system', JSON.stringify(claim));
    assert.equal((await tickets.findOneBy({ id: ticket.id })).supervisor_redispatches, 0,
      `${JSON.stringify(claim)}: the agent's own comment is progress`);
  }
});

test('re-sends that only draw manager auto-notices still end in a park', async () => {
  // The manager holds the seat (say, a spawn stuck in provisioning) while the
  // server sees nothing running: every supervisor re-send is dropped with a
  // notice. Those notices must not keep the ticket away from a human forever.
  const ticket = await createTicket(app, gdst, { accountId: ws.id, title: 'stuck spawn', status: 'in_progress', assignee: agent });
  // A fresh dispatch stamp keeps the app's own sweep, which runs on real time,
  // off this ticket; the passes below run hours ahead.
  await ds.getRepository('Ticket').update({ id: ticket.id }, { last_dispatched_at: new Date() });
  const later = Date.now() + 3 * 60 * 60 * 1000;
  for (let i = 0; i < MAX_SUPERVISOR_REDISPATCHES; i += 1) {
    await dispatcher.supervise(later + i * 60 * 60 * 1000);
    // A new row each time, as after a silent-exit warning broke the merge — a
    // merged repeat is an 'updated' row the dispatcher never looks at.
    await afterDispatcherHandles(() => autoNotice(ticket.id, `⚠️ duplicate dispatch suppressed (${i + 1})`));
  }
  const supervisorSends = () => vagent.triggersFor(ticket.id).filter((t) => t.trigger_source === 'supervisor');
  for (let i = 0; i < 50 && supervisorSends().length < MAX_SUPERVISOR_REDISPATCHES; i += 1) await settle(100);
  assert.equal(supervisorSends().length, MAX_SUPERVISOR_REDISPATCHES);
  assert.equal((await ds.getRepository('Ticket').findOneBy({ id: ticket.id })).supervisor_redispatches, MAX_SUPERVISOR_REDISPATCHES);

  await dispatcher.supervise(later + 10 * 60 * 60 * 1000);
  const parked = await ds.getRepository('Ticket').findOneBy({ id: ticket.id });
  assert.equal(parked.pending_user_action, true);
  assert.match(parked.pending_reason, /stopped/);
});

test('on a ticket the supervisor watches, an agent comment starts the count over', async () => {
  const tickets = ds.getRepository('Ticket');
  const ticket = await createTicket(app, gdst, { accountId: ws.id, title: 'watched', status: 'in_progress', assignee: agent });
  // As if already re-sent MAX times; the fresh stamp keeps the real-time sweep off.
  await tickets.update({ id: ticket.id }, { supervisor_redispatches: MAX_SUPERVISOR_REDISPATCHES, last_dispatched_at: new Date() });
  await afterDispatcherHandles(() => vagent.mcp.callTool('add_comment', { ticket_id: ticket.id, content: 'still on it: the parser is done' }));
  assert.equal((await tickets.findOneBy({ id: ticket.id })).supervisor_redispatches, 0);

  await dispatcher.supervise(Date.now() + 3 * 60 * 60 * 1000);
  const after = await tickets.findOneBy({ id: ticket.id });
  assert.equal(after.pending_user_action, false, 'the next silence is re-sent, not parked');
  assert.equal(after.supervisor_redispatches, 1);
  await tickets.update({ id: ticket.id }, { status: 'done' });
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

test('supervisor refreshes progress after waiting for an earlier runtime ack', { timeout: 15_000 }, async () => {
  const repo = ds.getRepository(Ticket);
  const fixtures = [];
  for (const count of [0, 0, 1, MAX_SUPERVISOR_REDISPATCHES]) {
    const ticket = await createTicket(app, gdst, {
      accountId: ws.id, title: `supervisor race ${fixtures.length}`,
      status: 'in_progress', assignee: agent.runtime_spec,
    });
    await repo.update(ticket.id, { supervisor_redispatches: count });
    fixtures.push(ticket);
  }
  const [blocker, ...progressing] = fixtures;
  const originalCommands = dispatcher.commands;
  const originalFind = repo.find;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const preparing = new Promise((resolve) => { entered = resolve; });
  let pending;
  const preparations = [];
  try {
    // SQL row order is unspecified; put the slow ticket first in the pass.
    repo.find = async function (options) {
      const rows = await originalFind.call(this, options);
      return rows.sort((a, b) => Number(b.id === blocker.id) - Number(a.id === blocker.id));
    };
    dispatcher.commands = {
      provisionSlotIdentity: async (spec, opts) => {
        preparations.push(opts.label);
        if (opts.label.startsWith(`ticket:${blocker.id.slice(0, 8)}/`)) {
          entered();
          await gate;
        }
        return { ok: true, reason: 'provisioned' };
      },
    };
    pending = dispatcher.supervise();
    await preparing;
    for (const ticket of progressing) {
      await afterDispatcherHandles(() => vagent.mcp.callTool('add_comment', {
        ticket_id: ticket.id, content: 'progress while the earlier runtime is preparing',
      }));
      assert.equal((await repo.findOneBy({ id: ticket.id })).supervisor_redispatches, 0);
    }
    release();
    await pending;
    await vagent.waitForTrigger((t) => t.ticket_id === blocker.id && t.trigger_source === 'supervisor', 5000);
    for (const ticket of progressing) {
      const fresh = await repo.findOneBy({ id: ticket.id });
      assert.equal(fresh.supervisor_redispatches, 0, 'progress reset survives the sweep');
      assert.equal(fresh.pending_user_action, false, 'recent progress must not be parked');
      assert.equal(fresh.last_dispatched_at, null, 'recent progress must not force a respawn');
      assert.equal(preparations.some((label) => label.startsWith(`ticket:${ticket.id.slice(0, 8)}/`)), false);
      assert.equal(await ds.getRepository('ActivityLog').countBy({
        ticket_id: ticket.id, field_changed: 'pending_user_action', trigger_source: 'supervisor',
      }), 0, 'no spurious park activity');
    }
  } finally {
    release();
    if (pending) await pending;
    dispatcher.commands = originalCommands;
    repo.find = originalFind;
    for (const ticket of fixtures) await repo.update(ticket.id, { status: 'done' });
  }
});

for (const count of [1, MAX_SUPERVISOR_REDISPATCHES]) {
  test(`supervisor skips a conditional write when progress resets count ${count}`, { timeout: 15_000 }, async () => {
    const repo = ds.getRepository(Ticket);
    const ticket = await createTicket(app, gdst, {
      accountId: ws.id, title: 'progress just before supervisor write',
      status: 'in_progress', assignee: agent.runtime_spec,
    });
    await repo.update(ticket.id, { supervisor_redispatches: count });
    const originalUpdate = repo.update;
    let raced = false;
    try {
      repo.update = async function (criteria, patch) {
        if (!raced && criteria.id === ticket.id &&
            (patch.supervisor_redispatches === count + 1 || patch.pending_user_action === true)) {
          raced = true;
          await afterDispatcherHandles(() => vagent.mcp.callTool('add_comment', {
            ticket_id: ticket.id, content: 'progress after the supervisor read',
          }));
        }
        return originalUpdate.call(this, criteria, patch);
      };
      await dispatcher.supervise();
      assert.equal(raced, true, 'progress arrived immediately before the supervisor write');
      const fresh = await repo.findOneBy({ id: ticket.id });
      assert.equal(fresh.supervisor_redispatches, 0);
      assert.equal(fresh.pending_user_action, false);
      assert.equal(fresh.last_dispatched_at, null);
      assert.equal(await ds.getRepository('ActivityLog').countBy({
        ticket_id: ticket.id, field_changed: 'pending_user_action', trigger_source: 'supervisor',
      }), 0);
    } finally {
      repo.update = originalUpdate;
      await repo.update(ticket.id, { status: 'done' });
    }
  });
}


// Seed the same durable correlation row dispatch() writes before SSE emission.
// Avoid spawning a fake worker: these tests exercise manager acknowledgements
// and supervisor decisions when the real worker produces no output.
async function liveProbe(ticket, triggerId, createdAt = new Date()) {
  await ds.getRepository('ActivityLog').save({
    entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id,
    account_id: ws.id, action: 'trigger_emitted', field_changed: triggerId,
    new_value: agent.id, role: 'assignee', trigger_source: 'supervisor',
    created_at: createdAt,
  });
  return {
    ticketId: ticket.id, triggerId, outcome: 'suppressed',
    reason: 'inflight_live_process', managerAgentId: agent.runtime_spec.manager_agent_id,
  };
}

test('live-PID ACKs require a fresh latest trigger and do not renew on replay', async () => {
  const repo = ds.getRepository(Ticket);
  const ticket = await createTicket(app, gdst, {
    accountId: ws.id, title: 'live ACK contract', status: 'in_progress', assignee: agent,
  });
  try {
    await repo.update(ticket.id, { last_dispatched_at: new Date(), supervisor_redispatches: 1 });
    const stale = await liveProbe(ticket, 'stale-live-probe', new Date(Date.now() - SUPERVISOR_LIVE_ACK_TTL_MS - 1000));
    assert.equal((await dispatcher.applyManagerAck(stale)).applied, false);
    const current = await liveProbe(ticket, 'current-live-probe');
    assert.equal((await dispatcher.applyManagerAck({ ...current, triggerId: 'unknown' })).applied, false);
    assert.equal((await dispatcher.applyManagerAck({ ...current, managerAgentId: 'wrong-host' })).applied, false);
    assert.equal((await dispatcher.applyManagerAck(stale)).applied, false);
    assert.equal((await repo.findOneBy({ id: ticket.id })).supervisor_live_since, null);

    // Exercise the REST contract and its authenticated manager guard too.
    const devMode = process.env.AGENT_DEV_MODE;
    process.env.AGENT_DEV_MODE = 'false';
    let response;
    try {
      response = await fetch(`http://localhost:${port}/api/agent-manager/dispatch/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Key': runtimeHostKeyForAgent(agent.id) },
        body: JSON.stringify({
          ticket_id: ticket.id, trigger_id: current.triggerId, role: 'assignee',
          outcome: current.outcome, reason: current.reason,
        }),
      });
    } finally {
      process.env.AGENT_DEV_MODE = devMode;
    }
    assert.equal(response.status, 200);
    assert.equal((await response.json()).applied, true);
    const confirmed = await repo.findOneBy({ id: ticket.id });
    assert.ok(confirmed.supervisor_live_since instanceof Date);
    assert.ok(confirmed.supervisor_live_at instanceof Date);
    assert.equal(confirmed.supervisor_redispatches, 1, 'PID confirmation is not progress');
    assert.equal((await dispatcher.applyManagerAck(current)).applied, false);
    const replayed = await repo.findOneBy({ id: ticket.id });
    assert.equal(+replayed.supervisor_live_since, +confirmed.supervisor_live_since);
    assert.equal(+replayed.supervisor_live_at, +confirmed.supervisor_live_at);

    await dispatcher.applyManagerAck({ ...stale, outcome: 'processed' });
    assert.equal(+(await repo.findOneBy({ id: ticket.id })).supervisor_live_since, +confirmed.supervisor_live_since,
      'a stale processed ACK cannot clear the current holder');
    const replacement = await liveProbe(ticket, 'replacement-live-probe', new Date(Date.now() + 1000));
    await dispatcher.applyManagerAck({ ...replacement, outcome: 'processed' });
    const replaced = await repo.findOneBy({ id: ticket.id });
    assert.equal(replaced.supervisor_live_since, null, 'a matching processed ACK clears the previous quiet holder');
    assert.equal(replaced.supervisor_live_at, null);

    await repo.update(ticket.id, { pending_user_action: true });
    const pending = await liveProbe(ticket, 'pending-live-probe', new Date(Date.now() + 2000));
    assert.equal((await dispatcher.applyManagerAck(pending)).applied, false);
  } finally {
    await repo.update(ticket.id, { status: 'done' });
  }
});

test('a quiet live PID retains capacity beyond three probes but reaches its durable time limit', async () => {
  const repo = ds.getRepository(Ticket);
  const ticket = await createTicket(app, gdst, {
    accountId: ws.id, title: 'quiet live PID', status: 'in_progress', assignee: agent,
  });
  const originalCadence = (await ds.getRepository('Account').findOneBy({ id: ws.id })).supervisor_resend_ms;
  try {
    await ds.getRepository('Account').update(ws.id, { supervisor_resend_ms: 60 * 60_000 });
    const now = Date.now();
    const since = new Date(now - 45 * 60_000);
    await repo.update(ticket.id, {
      last_dispatched_at: new Date(now - 10 * 60_000),
      supervisor_redispatches: MAX_SUPERVISOR_REDISPATCHES,
      supervisor_live_since: since, supervisor_live_at: new Date(now),
    });
    const ack = await liveProbe(ticket, 'quiet-live-probe');
    assert.equal((await dispatcher.applyManagerAck(ack)).applied, true);
    assert.equal(+(await repo.findOneBy({ id: ticket.id })).supervisor_live_since, +since,
      'another live ACK cannot restart the quiet episode');
    await dispatcher.supervise(now);
    let fresh = await repo.findOneBy({ id: ticket.id });
    assert.equal(fresh.pending_user_action, false, 'a live process survives the ordinary three-send park');
    assert.equal(fresh.supervisor_redispatches, MAX_SUPERVISOR_REDISPATCHES + 1);
    assert.ok((await dispatcher.runningCounts([agent.id])).get(agent.id) >= 1,
      'the live quiet ticket still consumes its assignee capacity');

    await afterDispatcherHandles(() => autoNotice(ticket.id, 'process still alive, automatic notice'));
    fresh = await repo.findOneBy({ id: ticket.id });
    assert.equal(+fresh.supervisor_live_since, +since, 'auto-notice does not extend the quiet limit');
    // These persisted timestamps also survive a dispatcher/server restart:
    // no in-memory confirmation is needed to make the next decision.
    await repo.update(ticket.id, { supervisor_live_since: new Date(now - SUPERVISOR_LIVE_QUIET_LIMIT_MS) });
    await dispatcher.supervise(now);
    fresh = await repo.findOneBy({ id: ticket.id });
    assert.equal(fresh.pending_user_action, true);
    assert.match(fresh.pending_reason, /alive.*no progress.*2 hours/);
    assert.doesNotMatch(fresh.pending_reason, /stopped 3 times/);
  } finally {
    await ds.getRepository('Account').update(ws.id, { supervisor_resend_ms: originalCadence });
    await repo.update(ticket.id, { status: 'done' });
  }
});

test('expired PID evidence and no-PID reservations retain ordinary stalled-ticket recovery', async () => {
  const repo = ds.getRepository(Ticket);
  for (const stalePid of [false, true]) {
    const ticket = await createTicket(app, gdst, {
      accountId: ws.id, title: `no live worker ${stalePid}`, status: 'in_progress', assignee: agent,
    });
    try {
      const now = Date.now();
      await repo.update(ticket.id, {
        supervisor_redispatches: MAX_SUPERVISOR_REDISPATCHES,
        last_dispatched_at: new Date(now - 10 * 60_000),
        supervisor_live_since: stalePid ? new Date(now - 30 * 60_000) : null,
        supervisor_live_at: stalePid ? new Date(now - SUPERVISOR_LIVE_ACK_TTL_MS - 1) : null,
      });
      const ack = await liveProbe(ticket, `reservation-probe-${stalePid}`);
      await dispatcher.applyManagerAck({ ...ack, reason: 'inflight_dispatch' });
      await dispatcher.supervise(now);
      const fresh = await repo.findOneBy({ id: ticket.id });
      assert.equal(fresh.pending_user_action, true);
      assert.match(fresh.pending_reason, /stopped/);
    } finally {
      await repo.update(ticket.id, { status: 'done' });
    }
  }
});

test('actual output and an agent comment restart a quiet live episode', async () => {
  const repo = ds.getRepository(Ticket);
  const ticket = await createTicket(app, gdst, {
    accountId: ws.id, title: 'live worker progresses', status: 'in_progress', assignee: agent,
  });
  const agentStatus = dispatcher.agentStatus;
  const originalOutput = agentStatus.getLatestOutputLivenessForTicket;
  try {
    const now = Date.now();
    await repo.update(ticket.id, {
      supervisor_redispatches: MAX_SUPERVISOR_REDISPATCHES,
      last_dispatched_at: new Date(now),
      supervisor_live_since: new Date(now - SUPERVISOR_LIVE_QUIET_LIMIT_MS),
      supervisor_live_at: new Date(now),
    });
    agentStatus.getLatestOutputLivenessForTicket = function (id) {
      return id === ticket.id ? now - 1000 : originalOutput.call(this, id);
    };
    await dispatcher.supervise(now);
    let fresh = await repo.findOneBy({ id: ticket.id });
    assert.equal(fresh.pending_user_action, false);
    assert.equal(+fresh.supervisor_live_since, now - 1000, 'real output advances the quiet baseline');
    assert.equal(fresh.supervisor_redispatches, 0, 'real output restarts the resend count');
    await afterDispatcherHandles(() => vagent.mcp.callTool('add_comment', {
      ticket_id: ticket.id, content: 'tool finished; validating the implementation',
    }));
    fresh = await repo.findOneBy({ id: ticket.id });
    assert.equal(fresh.supervisor_redispatches, 0);
    assert.equal(fresh.supervisor_live_since, null);
    assert.equal(fresh.supervisor_live_at, null);
  } finally {
    agentStatus.getLatestOutputLivenessForTicket = originalOutput;
    await repo.update(ticket.id, { status: 'done' });
  }
});

exitAfterTests();
