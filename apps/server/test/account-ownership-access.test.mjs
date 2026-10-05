// Ownership follows the resource and the caller's memberships after removal
// of the ambient workspace UI. Run against either isolated harness dialect.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { bootApp } from './helpers/boot.mjs';
import { createAccount, createProject, createTicket, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';
import { ReBACService } from '../dist/services/rebac.service.js';
import { PairingService } from '../dist/modules/agent-manager/pairing.service.js';
import { normalizeOwnershipFields, withLegacyOwnershipFields } from '../dist/common/ownership-contract.js';

test('legacy ownership aliases preserve canonical values, globals, and opaque inputs', () => {
  const raw = {
    account_id: 'canonical', workspace_id: 'legacy', owner_workspace_id: 'owner',
    allowed_workspace_ids: ['one', 'two'], requested_workspace_id: 'requested',
    scope: 'workspace', args: { workspace_id: 'nested' },
    run_provision: { workspace_id: 'run-owner', workspace_folder: '.awb/chat/session' },
    credentials: { workspace_id: 'provider-value' }, fields: { workspace_id: 'field-value' },
  };
  const normalized = normalizeOwnershipFields(raw);
  assert.equal(normalized.account_id, 'canonical');
  assert.equal(normalized.owner_account_id, 'owner');
  assert.deepEqual(normalized.allowed_account_ids, ['one', 'two']);
  assert.equal(normalized.requested_account_id, 'requested');
  assert.equal(normalized.scope, 'account');
  assert.equal(normalized.args.account_id, 'nested');
  assert.equal(normalized.run_provision.account_id, 'run-owner');
  assert.equal(normalized.run_provision.workspace_folder, '.awb/chat/session');
  assert.deepEqual(normalized.credentials, raw.credentials);
  assert.deepEqual(normalized.fields, raw.fields);
  assert.equal('workspace_id' in normalized, false);
  assert.equal(raw.workspace_id, 'legacy', 'input is not rewritten');
  assert.deepEqual(normalizeOwnershipFields({ account_id: null, workspace_id: 'legacy', scope: 'global' }), {
    account_id: null, scope: 'global',
  });
  const outgoing = withLegacyOwnershipFields({ account_id: null, payload: { account_id: 'nested' }, fields: raw.fields });
  assert.equal(outgoing.account_id, null);
  assert.equal(outgoing.workspace_id, null);
  assert.equal(outgoing.payload.workspace_id, 'nested');
  assert.deepEqual(outgoing.fields, raw.fields);
});

test('canonical task surfaces authorize actual owners across multiple accounts', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(async () => { await app.close(); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;
  const accounts = [];
  for (const label of ['first', 'second', 'private']) {
    accounts.push(await createAccount(app, getDataSourceToken, `ownership-${label}`));
  }
  const [first, second] = accounts;
  // Stable ordering makes the headerless default assertion independent of UUID
  // ordering and millisecond precision in either database dialect.
  for (const [index, account] of accounts.entries()) {
    await ds.getRepository('Account').update(account.id, { created_at: new Date(Date.UTC(2026, 0, index + 1)) });
  }
  const member = await createUser(app, getDataSourceToken, { name: 'two-account-member', role: 'user' });
  await ds.getRepository('User').update(member.id, {
    permissions: JSON.stringify(['admin.actions', 'admin.resources', 'admin.credentials']),
  });
  const rebac = app.get(ReBACService);
  for (const account of [first, second]) {
    await rebac.grant({ type: 'user', id: member.id }, 'member', { type: 'account', id: account.id });
  }
  const authorization = `Bearer ${app.get(AuthService).createSession(member.id)}`;
  const admin = await createUser(app, getDataSourceToken, { name: 'credential-admin', role: 'admin' });
  const adminAuthorization = `Bearer ${app.get(AuthService).createSession(admin.id)}`;

  async function request(path, { method = 'GET', body, headers = {}, auth = authorization } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: auth, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  function expectStatus(result, expected) {
    assert.equal(result.status, expected, JSON.stringify(result.body));
    return result.body;
  }
  const tickets = [];
  const projects = [];
  const missions = [];
  for (const account of accounts) {
    const project = await createProject(app, getDataSourceToken, account.id, { name: `owner-project-${account.id}` });
    projects.push(project);
    tickets.push(await createTicket(app, getDataSourceToken, {
      accountId: account.id, projectId: project.id, title: `owner-ticket-${account.id}`, status: 'backlog',
    }));
    const teamRepo = ds.getRepository('OrchestrationTeam');
    const team = await teamRepo.save(teamRepo.create({ account_id: account.id, owner_account_id: account.id, name: `team-${account.id}` }));
    const missionRepo = ds.getRepository('OrchestrationMission');
    missions.push(await missionRepo.save(missionRepo.create({
      account_id: account.id, team_id: team.id, title: `owner-mission-${account.id}`, objective: 'ownership test',
    })));
  }

  await t.test('headerless canonical lists include both memberships and exclude private account data', async () => {
    const cases = [
      ['/api/tickets', tickets, (value) => value.tickets],
      ['/api/projects', projects, (value) => value],
      ['/api/orchestration/missions', missions, (value) => value],
    ];
    for (const [path, rows, select] of cases) {
      for (const headers of [{}, { 'X-Account-Id': first.id }]) {
        const body = expectStatus(await request(path, { headers }), 200);
        const visible = select(body);
        assert.ok(visible.some(row => row.id === rows[0].id), `${path} omits first membership`);
        assert.ok(visible.some(row => row.id === rows[1].id), `${path} omits second membership`);
        assert.equal(visible.some(row => row.id === rows[2].id), false, `${path} leaks a nonmember account`);
        assert.equal(JSON.stringify(body).includes(rows[2].title || rows[2].name), false);
      }
    }
  });

  await t.test('unread counts and read-all cover both memberships while preserving nonmember read state', async () => {
    const unreadTickets = [];
    const commentRepo = ds.getRepository('Comment');
    for (const account of accounts) {
      const ticket = await createTicket(app, getDataSourceToken, { accountId: account.id, title: `unread-${account.id}`, status: 'backlog' });
      // Involvement can outlive membership. The private fixture verifies that
      // neither unread queries nor read-all trust that relation on its own.
      await ds.getRepository('Ticket').update(ticket.id, { created_by_id: member.id });
      unreadTickets.push(ticket);
      await commentRepo.save(commentRepo.create({
        account_id: account.id, ticket_id: ticket.id, author: 'Other person', author_id: admin.id,
        content: 'Unread ownership fixture',
      }));
    }
    await commentRepo.save(commentRepo.create({
      account_id: first.id, ticket_id: unreadTickets[0].id, author: member.name, author_id: member.id,
      content: 'My own comment does not add an unread badge',
    }));
    const unread = expectStatus(await request('/api/tickets/unread-counts'), 200);
    assert.equal(unread.total, 2);
    assert.deepEqual(unread.perTicket, { [unreadTickets[0].id]: 1, [unreadTickets[1].id]: 1 });
    const cleared = expectStatus(await request('/api/tickets/read-all', { method: 'POST', body: {} }), 201);
    assert.equal(cleared.updated, 2);
    const rows = await ds.getRepository('TicketReadState').find({ where: { user_id: member.id } });
    assert.deepEqual(rows.map(row => row.account_id).sort(), [first.id, second.id].sort());
    assert.ok(rows.every(row => row.last_read_at));
    assert.equal(rows.some(row => row.ticket_id === unreadTickets[2].id), false);
    assert.deepEqual(expectStatus(await request('/api/tickets/unread-counts'), 200), { total: 0, perTicket: {} });
  });

  await t.test('human SSE includes both authorized owners and filters private ticket events', async () => {
    const observed = [];
    const memberStream = await openSseStream(port, authorization.slice(7), { onFrame: frame => observed.push(frame) });
    const adminStream = await openSseStream(port, adminAuthorization.slice(7));
    try {
      const activity = app.get(modules.ActivityService);
      const marker = `owner-event-${randomUUID()}`;
      for (const ticket of tickets) {
        await activity.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id,
          account_id: ticket.account_id, action: 'updated', field_changed: marker,
        });
      }
      for (const ticket of tickets.slice(0, 2)) {
        const frame = await memberStream.waitFor('board_update', data => data.ticket_id === ticket.id && data.field_changed === marker);
        assert.equal(frame.data.account_id, ticket.account_id);
      }
      await adminStream.waitFor('board_update', data => data.ticket_id === tickets[2].id && data.field_changed === marker);
      // This barrier follows confirmed processing of the private event. Waiting
      // for it on the member's stream avoids a negative assertion based on sleep.
      const barrier = `${marker}-barrier`;
      await activity.logActivity({
        entity_type: 'ticket', entity_id: tickets[0].id, ticket_id: tickets[0].id,
        account_id: first.id, action: 'updated', field_changed: barrier,
      });
      await memberStream.waitFor('board_update', data => data.field_changed === barrier);
      assert.equal(observed.some(frame => frame.event === 'board_update' && frame.data.ticket_id === tickets[2].id), false);
    } finally {
      memberStream.close();
      adminStream.close();
    }
  });

  await t.test('task detail and writes use the target owner despite a conflicting ambient hint', async () => {
    const ambient = { 'X-Account-Id': first.id };
    const detail = expectStatus(await request(`/api/tickets/${tickets[1].id}`, { headers: ambient }), 200);
    assert.equal(detail.account_id, second.id);
    const updated = expectStatus(await request(`/api/tickets/${tickets[1].id}`, {
      method: 'PATCH', headers: ambient, body: { title: 'updated second-account task', account_id: first.id },
    }), 200);
    assert.equal(updated.account_id, second.id);
    assert.equal(updated.title, 'updated second-account task');
    const row = await ds.getRepository('Ticket').findOneBy({ id: tickets[1].id });
    assert.equal(row.account_id, second.id, 'an ambient hint cannot move ownership');
    const project = expectStatus(await request(`/api/projects/${projects[1].id}`, { headers: ambient }), 200);
    assert.equal(project.account_id, second.id);
    const mission = expectStatus(await request(`/api/orchestration/missions/${missions[1].id}?account_id=${first.id}`), 200);
    assert.equal(mission.account_id, second.id);

    for (const method of ['GET', 'PATCH']) {
      const denied = await request(`/api/tickets/${tickets[2].id}`, {
        method, headers: ambient, ...(method === 'PATCH' ? { body: { title: 'forbidden update', account_id: first.id } } : {}),
      });
      expectStatus(denied, 403);
      assert.equal(JSON.stringify(denied.body).includes(tickets[2].title), false);
    }
    assert.equal((await ds.getRepository('Ticket').findOneBy({ id: tickets[2].id })).title, tickets[2].title);
    expectStatus(await request(`/api/projects/${projects[2].id}`, { headers: ambient }), 403);
    expectStatus(await request(`/api/orchestration/missions/${missions[2].id}`, { headers: ambient }), 403);
  });

  await t.test('artifact refs resolve each real owner without an ambient account and redact unauthorized labels', async () => {
    const refs = [...tickets.map(ticket => ({ type: 'ticket', id: ticket.id })), { type: 'ticket', id: randomUUID() }];
    const result = expectStatus(await request('/api/artifact-refs/resolve', { method: 'POST', body: { refs } }), 201);
    for (const [index, account] of [first, second].entries()) {
      assert.equal(result[index].available, true);
      assert.equal(result[index].deepLink, `/tickets?ticket=${tickets[index].id}`);
      assert.equal(result[index].accountName, account.name);
      assert.equal(result[index].label, index === 1 ? 'updated second-account task' : tickets[index].title);
    }
    assert.equal(result[2].available, false);
    assert.equal(result[2].reason, 'account_access_denied');
    assert.equal(result[2].deepLink, null);
    assert.equal(result[2].accountName, undefined);
    assert.equal(JSON.stringify(result[2]).includes(tickets[2].title), false);
    assert.equal(result[3].reason, 'not_found');
    assert.equal(result[3].deepLink, null);
  });

  await t.test('headerless creation chooses a stable accessible default account', async () => {
    const created = expectStatus(await request('/api/tickets', {
      method: 'POST', body: { title: 'headerless default-account task', status: 'backlog' },
    }), 201);
    assert.equal(created.account_id, first.id);
    assert.equal((await ds.getRepository('Ticket').findOneBy({ id: created.id })).account_id, first.id);
  });

  await t.test('global credentials keep null ownership during headerless creation and ambient-account edits', async () => {
    const created = expectStatus(await request('/api/credentials', {
      method: 'POST', auth: adminAuthorization,
      body: { name: 'global owner fixture', provider: 'github', scope: 'global', credentials: { token: 'fixture-token' } },
    }), 201);
    assert.equal(created.account_id, null);
    assert.equal(created.scope, 'global');
    const updated = expectStatus(await request(`/api/credentials/${created.id}`, {
      method: 'PATCH', auth: adminAuthorization, headers: { 'X-Account-Id': second.id },
      body: { name: 'renamed global owner fixture' },
    }), 200);
    assert.equal(updated.account_id, null);
    assert.equal(updated.scope, 'global');
    assert.equal((await ds.getRepository('Credential').findOneBy({ id: created.id })).account_id, null);
    const inherited = expectStatus(await request(`/api/credentials?account_id=${second.id}`), 200);
    assert.ok(inherited.some(row => row.id === created.id && row.account_id === null && row.scope === 'global'));
    const denied = await request(`/api/credentials/${created.id}`, { method: 'PATCH', body: { name: 'unauthorized global edit' } });
    expectStatus(denied, 403);
  });

  await t.test('legacy headers, routes, queries, and body fields reach canonical ownership with unchanged UUIDs', async () => {
    const listed = expectStatus(await request(`/api/workspaces/${second.id}/tickets`, {
      headers: { 'X-Workspace-Id': second.id },
    }), 200);
    assert.ok(listed.tickets.some(row => row.id === tickets[1].id));
    assert.equal(listed.tickets.some(row => row.account_id !== second.id), false);
    const created = expectStatus(await request('/api/tickets', {
      method: 'POST', headers: { 'X-Account-Id': first.id },
      body: { workspace_id: second.id, title: 'legacy owner task', status: 'backlog' },
    }), 201);
    assert.equal(created.account_id, second.id);
    assert.equal(created.workspace_id, second.id, 'the old caller still receives its owner alias');
    const credential = expectStatus(await request('/api/credentials', {
      method: 'POST', body: { workspace_id: second.id, scope: 'workspace', name: 'legacy account credential', provider: 'github', credentials: { token: 'fixture-scoped-token' } },
    }), 201);
    assert.equal(credential.account_id, second.id);
    assert.equal(credential.scope, 'account');
    const credentials = expectStatus(await request(`/api/credentials?workspace_id=${second.id}`), 200);
    assert.ok(credentials.some(row => row.id === credential.id && row.workspace_id === second.id));
  });

  await t.test('ownerless legacy pairing replies carry aliases and old MCP argument names are normalized before validation', async () => {
    const rec = app.get(PairingService).mint({ account_id: second.id, created_by_user_id: admin.id, agent_name: 'compatibility-test-host' });
    const paired = expectStatus(await request('/api/agent-manager/pair/redeem', {
      method: 'POST', body: { token: rec.token, instance_id: `ownership-compat-${randomUUID()}` },
    }), 201);
    assert.equal(paired.account_id, second.id);
    assert.equal(paired.workspace_id, second.id);
    assert.equal(paired.agent_id, paired.host_id);
    const mcp = new McpClient({ baseUrl: base, apiKey: paired.api_key });
    try {
      const created = await mcp.callTool('create_ticket', {
        workspace_id: second.id, title: 'legacy MCP owner task', status: 'backlog',
      });
      assert.equal(!!created?.isError, false, JSON.stringify(created));
      const ticket = created?.ticket || created;
      assert.ok(ticket.id, JSON.stringify(created));
      assert.equal((await ds.getRepository('Ticket').findOneBy({ id: ticket.id })).account_id, second.id);
    } finally {
      await mcp.close();
    }
  });
});
