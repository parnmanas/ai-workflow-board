import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createUser, createAgent, createApiKey, createTicket, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';
import { AgentSessionsService } from '../dist/modules/agent-sessions/agent-sessions.service.js';
import { EventSubscriptionsService } from '../dist/modules/event-subscriptions/event-subscriptions.service.js';
import { AgentConnectivityRegistry } from '../dist/services/agent-connectivity.registry.js';
import { OperatorReportService } from '../dist/modules/voice/operator-report.service.js';
import { RoomMessagingService } from '../dist/modules/chat-rooms/room-messaging.service.js';

test('durable event subscriptions wake the owning session or chat across Hosts', async t => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken, activityEvents, ActivityService } = modules;
  const db = app.get(getDataSourceToken());
  const service = app.get(EventSubscriptionsService);
  // Drive the real worker deterministically; leave its actual matching/delivery paths intact.
  clearInterval(service.timer);
  const sessions = app.get(AgentSessionsService);
  const connectivity = app.get(AgentConnectivityRegistry);
  const base = `http://localhost:${port}`;
  const user = await createUser(app, getDataSourceToken, { name: 'event-owner', role: 'admin' });
  const account = await createAccount(app, getDataSourceToken, 'event-account', { ownerUserId: user.id });
  const outsider = await createUser(app, getDataSourceToken, { name: 'outside', role: 'admin' });
  const foreign = await createAccount(app, getDataSourceToken, 'event-foreign', { ownerUserId: outsider.id });

  async function host(accountId, name, existing) {
    const row = existing || await createAgent(app, getDataSourceToken, accountId, { name, type: 'manager' });
    const id = row.manager_agent_id || row.id;
    const key = runtimeHostKeyForAgent(row.id);
    const response = await fetch(`${base}/api/agent/instance-heartbeat`, {
      method: 'POST', headers: { 'X-Agent-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: `inst-${id}`, agent_id: id, host_id: id, mode: 'manager', hostname: name,
        plugin_version: 'test', cli: 'codex', cli_adapters: ['codex', 'claude'], acp_session_clis: ['codex', 'claude'], pid: 1234, started_at: new Date().toISOString() }),
    });
    assert.ok(response.ok, await response.text());
    const stream = await openSseStream(port, key);
    t.after(() => stream.close());
    return { id, key, stream, accountId };
  }
  const first = await host(account.id, 'codex-host');
  const second = await host(account.id, 'claude-host');
  const other = await host(foreign.id, 'foreign-host');
  async function native(h, id, cli, owner = user) {
    await sessions.prompt(h.accountId, owner.id, h.id, cli, id, 'User work');
    sessions.applyState(h.id, cli, id, { status: 'ready' });
    return { manager_id: h.id, cli, session_id: id };
  }
  const to = await native(first, 'waiting-codex', 'codex');
  const source = await native(second, 'working-claude', 'claude');
  const forbidden = await native(other, 'foreign-claude', 'claude', outsider);
  const client = (h, id, key = h.key) => {
    const c = new McpClient({ baseUrl: base, apiKey: key, clientInfo: { name: 'codex-acp', version: 'test' },
      extraHeaders: id ? { 'X-AWB-Client-Type': 'agent-session', 'X-AWB-Session-Id': id, 'X-AWB-Tool-Profile': 'compact' } : {} });
    t.after(() => c.close()); return c;
  };
  const mcp = client(first, to.session_id);
  const peer = client(second, source.session_id);
  const requests = [], chatRequests = [], roomMessages = [];
  for (const [name, records] of [['agent_session_request', requests], ['chat_request', chatRequests], ['chat_room_message', roomMessages]]) {
    const listener = p => records.push(p); activityEvents.on(name, listener); t.after(() => activityEvents.off(name, listener));
  }
  const subscribe = (overrides = {}, c = mcp) => c.callTool('subscribe_to_event', {
    event_type: 'session.turn_completed', source, prompt: 'Claude 결과를 검증하고 후속 작업을 진행해.', ...overrides,
  });
  const completion = (turn, stop = 'end_turn', ref = source) => sessions.relayEvents(ref.manager_id, ref.cli, ref.session_id, [
    { id: `event-${turn}`, seq: 2, turn_id: turn, type: 'turn', payload: { phase: 'finished', stop_reason: stop } },
  ], { status: 'ready', reason: 'turn_finished' });
  const ready = () => sessions.applyState(to.manager_id, to.cli, to.session_id, { status: 'ready' });
  const flush = () => service.processPending();
  const delivery = id => db.getRepository('EventDelivery').findOneByOrFail({ subscription_id: id });
  const due = id => db.getRepository('EventDelivery').update({ subscription_id: id }, { available_at: new Date(0) });
  const error = (result, code) => { assert.equal(result.isError, true, JSON.stringify(result)); assert.equal(result.error.code, code, JSON.stringify(result)); };

  await t.test('MCP discovery, cross-CLI completion, one-shot dedup and no approval powers', async () => {
    assert.equal((await mcp.callTool('list_event_types', {})).events.length, 4);
    const result = await subscribe(); assert.ok(result.subscription?.id, JSON.stringify(result));
    completion('first-turn'); await flush();
    const d = await delivery(result.subscription.id); assert.equal(d.status, 'submitted');
    const sent = requests.filter(p => p.op === 'prompt' && p.text?.includes(d.id));
    assert.equal(sent.length, 1); assert.equal(sent[0].manager_id, first.id); assert.equal(sent[0].cli, 'codex');
    assert.match(sent[0].text, /not new user input or approval/);
    assert.equal(app.get(OperatorReportService).isOperatorTaskTurn(d.dispatched_turn_id), true);
    // Same callback replay and a later turn must not wake a one-shot subscription twice.
    ready(); completion('first-turn'); completion('next-turn'); await flush();
    assert.equal(await db.getRepository('EventDelivery').countBy({ subscription_id: result.subscription.id }), 1);
    assert.equal(requests.filter(p => p.op === 'prompt' && p.text?.includes(d.id)).length, 1);
    const listed = await mcp.callTool('list_event_subscriptions', {});
    assert.equal(listed.subscriptions.find(s => s.id === result.subscription.id).status, 'exhausted');
  });

  await t.test('cancellations/failures never masquerade as success; exact turn replay works', async () => {
    const success = await subscribe({ source: { ...source, turn_id: 'cancelled-turn' } });
    const failure = await subscribe({ event_type: 'session.turn_failed', source: { ...source, turn_id: 'cancelled-turn' } });
    completion('cancelled-turn', 'cancelled'); await flush();
    assert.equal(await db.getRepository('EventDelivery').countBy({ subscription_id: success.subscription.id }), 0);
    assert.equal((await delivery(failure.subscription.id)).status, 'submitted');
    ready(); completion('already-finished'); await flush();
    const replay = await subscribe({ source: { ...source, turn_id: 'already-finished' } }); await flush();
    assert.equal((await delivery(replay.subscription.id)).status, 'submitted'); ready();
    await mcp.callTool('cancel_event_subscription', { subscription_id: success.subscription.id });
  });

  await t.test('busy and disconnected targets retain deliveries across service restart', async () => {
    const result = await subscribe({ source: { ...source, turn_id: 'busy-source' } });
    sessions.applyState(to.manager_id, to.cli, to.session_id, { status: 'busy' });
    completion('busy-source'); await flush();
    assert.equal((await delivery(result.subscription.id)).status, 'pending');
    assert.match((await delivery(result.subscription.id)).last_error, /turn is already/);
    await service.onModuleDestroy(); service.onModuleInit(); clearInterval(service.timer);
    ready(); await due(result.subscription.id); await flush();
    assert.equal((await delivery(result.subscription.id)).status, 'submitted');
    ready();
    const offline = await subscribe({ source: { ...source, turn_id: 'offline-source' } });
    const reachable = connectivity.isReachable.bind(connectivity);
    connectivity.isReachable = id => id === first.id ? false : reachable(id);
    try { completion('offline-source'); await flush(); assert.equal((await delivery(offline.subscription.id)).status, 'pending'); }
    finally { connectivity.isReachable = reachable; }
    // Simulate a server crash while this pending delivery held a now-expired lease.
    await db.getRepository('EventDelivery').update({ subscription_id: offline.subscription.id }, { status: 'dispatching', lease_token: 'old-worker', available_at: new Date(0) });
    await flush();
    assert.equal((await delivery(offline.subscription.id)).status, 'submitted'); ready();
  });

  await t.test('closed recipients reopen, but cancellation or expiry during open prevents dispatch', async () => {
    for (const mode of ['resume', 'cancel', 'expire']) {
      const sub = await subscribe({ source: { ...source, turn_id: `open-${mode}` } });
      sessions.applyState(to.manager_id, to.cli, to.session_id, { status: 'closed' });
      const errors = [];
      let opens = 0;
      const respond = request => {
        if (request.op !== 'open' || request.session_id !== to.session_id) return;
        opens++;
        void (async () => {
          if (mode === 'cancel') await mcp.callTool('cancel_event_subscription', { subscription_id: sub.subscription.id });
          if (mode === 'expire') await db.getRepository('EventSubscription').update(sub.subscription.id, { expires_at: new Date(0) });
          sessions.resolveRpc(request.request_id, first.id, { ok: true, result: { ...to, cwd: '/repo', status: 'ready' } });
        })().catch(err => errors.push(err));
      };
      activityEvents.on('agent_session_request', respond);
      try { completion(`open-${mode}`); await flush(); }
      finally { activityEvents.off('agent_session_request', respond); }
      assert.deepEqual(errors, []); assert.equal(opens, 1);
      const d = await delivery(sub.subscription.id);
      assert.equal(d.status, mode === 'resume' ? 'submitted' : mode === 'cancel' ? 'cancelled' : 'expired');
      assert.equal(requests.filter(p => p.op === 'prompt' && p.text?.includes(d.id)).length, mode === 'resume' ? 1 : 0);
      ready();
    }
  });

  await t.test('subscription cancellation, expiry, and another session cannot manage the wait', async () => {
    const result = await subscribe({ source: { ...source, turn_id: 'cancel-wait' } });
    error(await peer.callTool('cancel_event_subscription', { subscription_id: result.subscription.id }), 'subscription_not_found');
    await mcp.callTool('cancel_event_subscription', { subscription_id: result.subscription.id });
    completion('cancel-wait'); await flush();
    assert.equal(await db.getRepository('EventDelivery').countBy({ subscription_id: result.subscription.id }), 0);
    const expired = await subscribe({ source: { ...source, turn_id: 'expired-wait' } });
    await db.getRepository('EventSubscription').update(expired.subscription.id, { expires_at: new Date(0) });
    completion('expired-wait'); await flush();
    assert.equal((await db.getRepository('EventSubscription').findOneByOrFail({ id: expired.subscription.id })).status, 'expired');
    assert.equal(await db.getRepository('EventDelivery').countBy({ subscription_id: expired.subscription.id }), 0);
  });

  await t.test('account isolation, self loops, permission revocation, and Host moves fail closed', async () => {
    error(await subscribe({ source: forbidden }), 'host_access_denied');
    error(await subscribe({ source: to }), 'self_subscription');
    const result = await subscribe({ source: { ...source, turn_id: 'moved-source' } });
    completion('moved-source'); await service.captures;
    await db.getRepository('RuntimeHost').update(second.id, { account_id: foreign.id });
    try { await flush(); assert.equal((await delivery(result.subscription.id)).status, 'failed'); }
    finally { await db.getRepository('RuntimeHost').update(second.id, { account_id: account.id }); }
    const denied = await subscribe({ source: { ...source, turn_id: 'revoked-owner' } });
    completion('revoked-owner');
    await db.getRepository('User').update(user.id, { role: 'user', permissions: '[]' });
    try { await flush(); assert.equal((await delivery(denied.subscription.id)).status, 'failed'); }
    finally { await db.getRepository('User').update(user.id, { role: 'admin' }); }
  });

  await t.test('ticket status filter and bounded repeated matching', async () => {
    const ticket = await createTicket(app, getDataSourceToken, { accountId: account.id, title: 'event ticket', status: 'backlog' });
    const sub = await subscribe({ event_type: 'ticket.changed', source: { ticket_id: ticket.id, status: 'done' }, max_triggers: 2, cooldown_seconds: 10 });
    const activity = app.get(ActivityService);
    const change = status => activity.logActivity({ entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, action: 'moved', field_changed: 'status', new_value: status });
    await change('in_progress'); await flush(); assert.equal(await db.getRepository('EventDelivery').countBy({ subscription_id: sub.subscription.id }), 0);
    await change('done'); await flush(); ready();
    await change('done'); await flush(); assert.equal(await db.getRepository('EventDelivery').countBy({ subscription_id: sub.subscription.id }), 1);
    await db.getRepository('EventSubscription').update(sub.subscription.id, { last_matched_at: new Date(Date.now() - 11000) });
    await change('done'); await flush(); ready();
    assert.equal(await db.getRepository('EventDelivery').countBy({ subscription_id: sub.subscription.id }), 2);
    assert.equal((await db.getRepository('EventSubscription').findOneByOrFail({ id: sub.subscription.id })).status, 'exhausted');
  });

  await t.test('concurrent workers reserve and submit a one-shot event once', async () => {
    const sub = await subscribe();
    completion('concurrent-a'); completion('concurrent-b'); await service.captures;
    const events = (await db.getRepository('WorkflowEvent').find()).filter(e => ['concurrent-a', 'concurrent-b'].includes(e.data.turn_id));
    // In the PG matrix these are independent real transactions, not sql.js queue turns.
    await Promise.all(Array.from({ length: 8 }, (_, i) => service.match(sub.subscription.id, events[i % 2])));
    assert.equal(await db.getRepository('EventDelivery').countBy({ subscription_id: sub.subscription.id }), 1);
    const d = await delivery(sub.subscription.id);
    await Promise.all(Array.from({ length: 8 }, () => service.deliver(d)));
    assert.equal(requests.filter(p => p.op === 'prompt' && p.text?.includes(d.id)).length, 1);
    assert.equal((await delivery(sub.subscription.id)).status, 'submitted'); ready();
  });

  await t.test('completion during registration is recovered even if the worker already processed it', async () => {
    const validate = service.validateSource.bind(service);
    let injected = false;
    service.validateSource = async (...args) => {
      await validate(...args);
      if (!injected) { injected = true; completion('during-registration'); await flush(); }
    };
    let sub;
    try { sub = await subscribe(); } finally { service.validateSource = validate; }
    await flush();
    assert.equal((await delivery(sub.subscription.id)).status, 'submitted'); ready();
  });

  await t.test('chat runtime wakes only itself in the subscribed room with a persisted system message', async () => {
    const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'chat-runtime', runtime: true });
    const h = await host(account.id, 'chat-host', agent);
    const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: account.id, label: 'events' });
    const chatMcp = client(h, null, key.raw_key);
    const room = await db.getRepository('ChatRoom').save({ account_id: account.id, name: 'event recipient', type: 'group' });
    await db.getRepository('ChatRoomParticipant').save({ room_id: room.id, participant_type: 'agent', participant_id: agent.id, runtime_spec: agent.runtime_spec });
    const result = await subscribe({ room_id: room.id, source: { ...source, turn_id: 'chat-wake' } }, chatMcp);
    assert.ok(result.subscription?.id, JSON.stringify(result));
    completion('chat-wake'); await flush();
    const d = await delivery(result.subscription.id); assert.equal(d.status, 'submitted', d.last_error);
    const dispatched = chatRequests.filter(p => p.message_id === d.id);
    assert.equal(dispatched.length, 1); assert.equal(dispatched[0].agent_id, agent.id);
    assert.equal(dispatched[0].runtime.manager_agent_id, h.id);
    assert.equal(dispatched[0].user_id, 'system');
    assert.equal((await db.getRepository('ChatRoomMessage').findOneByOrFail({ id: d.id })).sender_type, 'system');
    assert.deepEqual(roomMessages.find(p => p.message_id === d.id).dispatch_agent_ids, [agent.id]);
    // Event retry reuses the persisted message and the manager's idempotency anchor.
    await db.getRepository('EventDelivery').update(d.id, { status: 'pending', available_at: new Date(0) }); await flush();
    assert.equal(await db.getRepository('ChatRoomMessage').countBy({ id: d.id }), 1);
    assert.equal(chatRequests.filter(p => p.message_id === d.id).length, 2);

    const messages = await subscribe({ event_type: 'chat.message', source: { room_id: room.id, sender_type: 'user' }, room_id: room.id }, chatMcp);
    assert.ok(messages.subscription?.id, JSON.stringify(messages));
    await db.getRepository('ChatRoomParticipant').save({ room_id: room.id, participant_type: 'user', participant_id: user.id });
    await app.get(RoomMessagingService).sendMessage(room.id, account.id, 'user', user.id, 'Owner', 'Start after this message');
    await flush(); assert.equal((await delivery(messages.subscription.id)).status, 'submitted');
    const removed = await subscribe({ room_id: room.id, source: { ...source, turn_id: 'removed-runtime' } }, chatMcp);
    await db.getRepository('ChatRoomParticipant').update({ room_id: room.id, participant_id: agent.id }, { left_at: new Date() });
    completion('removed-runtime'); await flush(); assert.equal((await delivery(removed.subscription.id)).status, 'failed');
  });
});
