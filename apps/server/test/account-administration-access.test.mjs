// Ownership administration must remain protected after work routes become global.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createTicket, createUser } from './helpers/fixtures.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';

test('account administration permits owners and admins without letting members escalate', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const [accountA, accountB] = await Promise.all([
    createAccount(app, getDataSourceToken, 'administration-A'),
    createAccount(app, getDataSourceToken, 'administration-B'),
  ]);
  const owner = await createUser(app, getDataSourceToken, { name: 'account-owner', role: 'user' });
  const member = await createUser(app, getDataSourceToken, { name: 'account-member', role: 'user' });
  const target = await createUser(app, getDataSourceToken, { name: 'new-member', role: 'user' });
  const admin = await createUser(app, getDataSourceToken, { name: 'account-admin', role: 'admin' });
  const tuples = ds.getRepository('RelationTuple');
  await tuples.save([
    tuples.create({ subject_type: 'user', subject_id: owner.id, relation: 'owner', object_type: 'account', object_id: accountA.id }),
    tuples.create({ subject_type: 'user', subject_id: owner.id, relation: 'member', object_type: 'account', object_id: accountB.id }),
    tuples.create({ subject_type: 'user', subject_id: member.id, relation: 'member', object_type: 'account', object_id: accountA.id }),
  ]);
  const tokens = new Map([owner, member, admin].map(user => [user.id, app.get(AuthService).createSession(user.id)]));
  const request = async (user, path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${tokens.get(user.id)}`, 'X-Account-Id': accountA.id, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const expect = (response, status) => {
    assert.equal(response.status, status, JSON.stringify(response.body));
    return response.body;
  };
  const relation = (userId, accountId, value) => tuples.findOneBy({
    subject_type: 'user', subject_id: userId, relation: value, object_type: 'account', object_id: accountId,
  });

  await t.test('reads and account discovery exclude nonmember ownership even with a valid ambient account', async () => {
    assert.deepEqual(expect(await request(member, '/api/accounts'), 200).map(row => row.id), [accountA.id]);
    assert.equal(expect(await request(member, `/api/accounts/${accountA.id}`), 200).id, accountA.id);
    assert.ok(Array.isArray(expect(await request(member, `/api/accounts/${accountA.id}/members`), 200)));
    for (const suffix of ['', '/members', '/mention-candidates']) {
      expect(await request(member, `/api/accounts/${accountB.id}${suffix}`), 403);
    }
    const encodedId = `%${accountB.id.charCodeAt(0).toString(16)}${accountB.id.slice(1)}`;
    expect(await request(member, `/api/accounts/${encodedId}?account_id=${accountA.id}`), 403);
    const adminIds = expect(await request(admin, '/api/accounts'), 200).map(row => row.id);
    assert.ok(adminIds.includes(accountA.id) && adminIds.includes(accountB.id));
  });

  await t.test('members cannot change policy, delete accounts, or grant themselves ownership', async () => {
    for (const account of [accountA, accountB]) {
      expect(await request(member, `/api/accounts/${account.id}`, 'PATCH', {
        account_id: accountA.id, name: 'unauthorized change', dispatch_paused_at: true,
      }), 403);
      expect(await request(member, `/api/accounts/${account.id}`, 'DELETE'), 403);
      expect(await request(member, `/api/accounts/${account.id}/members`, 'POST', { user_id: member.id, relation: 'owner' }), 403);
      expect(await request(member, `/api/accounts/${account.id}/members/${member.id}`, 'PATCH', { relation: 'owner' }), 403);
      expect(await request(member, `/api/accounts/${account.id}/members/${owner.id}`, 'DELETE'), 403);
      assert.ok(await ds.getRepository('Account').findOneBy({ id: account.id }));
      assert.equal(await relation(member.id, account.id, 'owner'), null);
      const stored = await ds.getRepository('Account').findOneBy({ id: account.id });
      assert.equal(stored.name, account.name);
      assert.equal(stored.dispatch_paused_at, null);
    }
    assert.ok(await relation(member.id, accountA.id, 'member'));
    assert.ok(await relation(owner.id, accountA.id, 'owner'));
  });

  await t.test('an owner administers its account but membership in another account does not confer ownership', async () => {
    const updated = expect(await request(owner, `/api/accounts/${accountA.id}`, 'PATCH', { supervisor_stale_ms: 60000 }), 200);
    assert.equal(updated.supervisor_stale_ms, 60000);
    expect(await request(owner, `/api/accounts/${accountA.id}/members`, 'POST', { user_id: target.id, relation: 'member' }), 201);
    assert.ok(await relation(target.id, accountA.id, 'member'));
    expect(await request(owner, `/api/accounts/${accountA.id}/members/${target.id}`, 'PATCH', { relation: 'owner' }), 200);
    assert.equal(await relation(target.id, accountA.id, 'member'), null);
    assert.ok(await relation(target.id, accountA.id, 'owner'));
    expect(await request(owner, `/api/accounts/${accountA.id}/members/${target.id}`, 'DELETE'), 200);
    assert.equal(await relation(target.id, accountA.id, 'owner'), null);
    expect(await request(owner, `/api/accounts/${accountB.id}`, 'GET'), 200);
    expect(await request(owner, `/api/accounts/${accountB.id}`, 'PATCH', { dispatch_paused_at: true }), 403);
    expect(await request(owner, `/api/accounts/${accountB.id}/members`, 'POST', { user_id: owner.id, relation: 'owner' }), 403);
    expect(await request(owner, `/api/accounts/${accountB.id}`, 'DELETE'), 403);
  });

  await t.test('admins retain ownership administration without membership tuples', async () => {
    expect(await request(admin, `/api/accounts/${accountB.id}`, 'PATCH', { max_concurrent_tickets_per_agent: 3 }), 200);
    expect(await request(admin, `/api/accounts/${accountB.id}/members`, 'POST', { user_id: target.id, relation: 'member' }), 201);
    expect(await request(admin, `/api/accounts/${accountB.id}/members/${target.id}`, 'PATCH', { relation: 'owner' }), 200);
    expect(await request(admin, `/api/accounts/${accountB.id}/members/${target.id}`, 'DELETE'), 200);
    assert.equal(await relation(target.id, accountB.id, 'owner'), null);
  });

  await t.test('membership revocation closes existing human streams and reconnects enforce native and ticket ownership', async () => {
    // Keep B accessible so the revoked member can reconnect and has a useful
    // positive control for every event type, while the owner still owns A.
    expect(await request(admin, `/api/accounts/${accountB.id}/members`, 'POST', { user_id: member.id, relation: 'member' }), 201);
    const ticketA = await createTicket(app, getDataSourceToken, { accountId: accountA.id, title: 'Revoked-account ticket', status: 'backlog' });
    const ticketB = await createTicket(app, getDataSourceToken, { accountId: accountB.id, title: 'Retained-account ticket', status: 'backlog' });
    const executions = ds.getRepository('AgentSessionExecution');
    const sessionA = await executions.save(executions.create({
      account_id: accountA.id, manager_id: 'revocation-test-host', cli: 'claude', session_id: 'revoked-native', config_defaults: '{}',
    }));
    const sessionB = await executions.save(executions.create({
      account_id: accountB.id, manager_id: 'revocation-test-host', cli: 'claude', session_id: 'retained-native', config_defaults: '{}',
    }));
    const { activityEvents, ActivityService } = modules;
    const activity = app.get(ActivityService);
    const nativeEvent = (session, driver, marker) => activityEvents.emit('agent_session_event', {
      manager_id: session.manager_id, cli: session.cli, session_id: session.session_id, driver_user_id: driver.id,
      event: { type: 'text', payload: { text: marker }, seq: 1, at: new Date().toISOString() },
    });
    const nativeUpdate = (session, driver, marker) => activityEvents.emit('agent_session_update', {
      session: { manager_id: session.manager_id, cli: session.cli, session_id: session.session_id, driver_user_id: driver.id, status: 'busy' },
      reason: marker,
    });
    const ticketEvent = (ticket, marker) => activity.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, account_id: ticket.account_id,
      action: 'updated', field_changed: marker,
    });
    let memberStream = await openSseStream(port, tokens.get(member.id));
    let ownerStream = await openSseStream(port, tokens.get(owner.id));
    try {
      nativeEvent(sessionA, member, 'before-revocation');
      await memberStream.waitFor('agent_session_event', data => data.event?.payload?.text === 'before-revocation');
      nativeUpdate(sessionA, member, 'before-revocation');
      await memberStream.waitFor('agent_session_update', data => data.reason === 'before-revocation');
      await ticketEvent(ticketA, 'before-revocation');
      await memberStream.waitFor('board_update', data => data.ticket_id === ticketA.id && data.field_changed === 'before-revocation');

      const memberClosed = assert.rejects(memberStream.waitFor('no-more-member-events', () => true, 2000), /SSE stream.*closed|terminated|aborted/i);
      const ownerClosed = assert.rejects(ownerStream.waitFor('no-more-owner-events', () => true, 2000), /SSE stream.*closed|terminated|aborted/i);
      expect(await request(owner, `/api/accounts/${accountA.id}/members/${member.id}`, 'DELETE'), 200);
      await Promise.all([memberClosed, ownerClosed]);
      assert.equal(memberStream.isClosed(), true);
      assert.equal(ownerStream.isClosed(), true);

      const memberObserved = [];
      memberStream = await openSseStream(port, tokens.get(member.id), { onFrame: frame => memberObserved.push(frame) });
      ownerStream = await openSseStream(port, tokens.get(owner.id));
      // Native SSE producers do not carry account_id. Delivery must resolve
      // the persisted execution owner before applying the new membership set.
      nativeEvent(sessionA, member, 'revoked-native-event');
      nativeUpdate(sessionA, member, 'revoked-native-update');
      await ticketEvent(ticketA, 'revoked-ticket-event');

      nativeEvent(sessionA, owner, 'owner-native-event');
      nativeUpdate(sessionA, owner, 'owner-native-update');
      await ownerStream.waitFor('agent_session_event', data => data.event?.payload?.text === 'owner-native-event');
      await ownerStream.waitFor('agent_session_update', data => data.reason === 'owner-native-update');
      await ownerStream.waitFor('board_update', data => data.ticket_id === ticketA.id && data.field_changed === 'revoked-ticket-event');

      nativeEvent(sessionB, member, 'retained-native-event');
      nativeUpdate(sessionB, member, 'retained-native-update');
      await ticketEvent(ticketB, 'retained-ticket-event');
      await memberStream.waitFor('agent_session_event', data => data.event?.payload?.text === 'retained-native-event');
      await memberStream.waitFor('agent_session_update', data => data.reason === 'retained-native-update');
      await memberStream.waitFor('board_update', data => data.ticket_id === ticketB.id && data.field_changed === 'retained-ticket-event');
      assert.equal(memberObserved.some(frame => frame.event === 'agent_session_event' && frame.data.session_id === sessionA.session_id), false);
      assert.equal(memberObserved.some(frame => frame.event === 'agent_session_update' && frame.data.session?.session_id === sessionA.session_id), false);
      assert.equal(memberObserved.some(frame => frame.event === 'board_update' && frame.data.ticket_id === ticketA.id), false);
    } finally {
      memberStream.close();
      ownerStream.close();
      // Later administration checks use A as their ambient ownership default.
      expect(await request(owner, `/api/accounts/${accountA.id}/members`, 'POST', { user_id: member.id, relation: 'member' }), 201);
    }
  });

  await t.test('creation grants the caller ownership and deletion removes only its execution bindings', async () => {
    const created = expect(await request(member, '/api/accounts', 'POST', { name: 'Owned organization' }), 201);
    assert.ok(await relation(member.id, created.id, 'owner'));
    expect(await request(member, `/api/accounts/${created.id}`, 'PATCH', { description: 'Owned by the creator' }), 200);
    const executions = ds.getRepository('AgentSessionExecution');
    const ownExecution = await executions.save(executions.create({
      account_id: created.id, manager_id: 'ownership-test-host', cli: 'claude', session_id: 'own-native-session', config_defaults: '{}',
    }));
    const foreignExecution = await executions.save(executions.create({
      account_id: accountB.id, manager_id: 'ownership-test-host', cli: 'claude', session_id: 'foreign-native-session', config_defaults: '{}',
    }));
    expect(await request(member, `/api/accounts/${created.id}`, 'DELETE'), 200);
    assert.equal(await ds.getRepository('Account').findOneBy({ id: created.id }), null);
    assert.equal(await executions.findOneBy({ id: ownExecution.id }), null);
    assert.ok(await executions.findOneBy({ id: foreignExecution.id }));
    assert.equal(await relation(member.id, created.id, 'owner'), null);
  });
});
