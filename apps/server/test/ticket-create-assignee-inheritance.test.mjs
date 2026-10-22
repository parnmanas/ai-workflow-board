import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createProject, createTicket, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { normalizeRuntimeSpec, runtimeIdentityKey } from '../dist/common/runtime-spec.js';

test('MCP follow-up tickets inherit the current ticket assignee', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const token = modules.getDataSourceToken;
  const ds = app.get(token());
  const owner = await createUser(app, token, { name: 'follow-up owner' });
  const account = await createAccount(app, token, 'follow-ups', { ownerUserId: owner.id });
  await ds.getRepository('Account').update(account.id, { dispatch_paused_at: new Date() });
  const host = await createAgent(app, token, account.id, { name: 'worker host', type: 'manager' });
  const key = await createApiKey(app, token, host.id, { accountId: account.id, hostId: host.id });
  const credential = await ds.getRepository('Credential').save({
    account_id: account.id, name: 'worker credential', provider: 'codex', encrypted_data: 'unused in this test',
  });
  const spec = normalizeRuntimeSpec({
    manager_agent_id: host.id, cli: 'codex', model: 'source-model', working_dir: '/srv/source',
    credential_id: credential.id, cli_runtime_profile: 'none', folder_scope: 'shared',
    runtime_config: { strategy: 'single', permission_mode: 'strict' },
    label: 'Source worker', role_prompt: 'Keep the source worker instructions.',
  }, 'source');
  const defaultSpec = normalizeRuntimeSpec({ ...spec, model: 'project-model', label: 'Project worker' }, 'default');
  const project = await createProject(app, token, account.id, { name: 'follow-ups', defaultAssignee: defaultSpec });
  const source = await createTicket(app, token, {
    accountId: account.id, title: 'Work in progress', status: 'in_progress', assignee: spec,
  });
  const tickets = ds.getRepository('Ticket');

  async function clientFor(t, ticketId) {
    const client = new McpClient({
      baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key,
      extraHeaders: ticketId ? {
        'X-AWB-Client-Type': 'managed-subagent',
        'X-AWB-Subagent-Role': 'assignee',
        'X-AWB-Subagent-Ticket-Id': ticketId,
      } : {},
    });
    t.after(() => client.close());
    await client.initialize();
    return client;
  }

  async function create(client, title, body = {}) {
    const result = await client.callTool('create_ticket', { title, status: 'backlog', ...body });
    assert.ok(result?.id, JSON.stringify(result));
    return result;
  }

  await t.test('inherits the complete spec without a project and keeps checklist children unassigned', async (t) => {
    const client = await clientFor(t, source.id);
    const created = await create(client, 'Follow-up from the active ticket', { status: 'todo', subtasks: ['Verify the fix'] });
    assert.deepEqual(created.assignee, spec);
    assert.equal(created.assignee_key, runtimeIdentityKey(spec));
    assert.equal(created.account_id, account.id);
    assert.equal(created.parent_id, null);
    assert.equal(created.status, 'todo');
    const stored = await tickets.findOneByOrFail({ id: created.id });
    assert.deepEqual(stored.assignee, spec);
    assert.equal(stored.assignee_key, runtimeIdentityKey(spec));
    const children = await tickets.find({ where: { parent_id: created.id } });
    assert.equal(children.length, 1);
    assert.equal(children[0].assignee, null);
    assert.equal(children[0].assignee_key, '');
  });

  await t.test('uses the connection ticket, ahead of the project default, even for concurrent sessions on one runtime', async (t) => {
    const otherSpec = normalizeRuntimeSpec({ ...spec, model: 'other-model', label: 'Other ticket worker' }, 'other');
    assert.equal(runtimeIdentityKey(otherSpec), runtimeIdentityKey(spec));
    const other = await createTicket(app, token, {
      accountId: account.id, title: 'Another active ticket', status: 'in_progress', assignee: otherSpec,
    });
    const firstClient = await clientFor(t, source.id);
    const secondClient = await clientFor(t, other.id);
    const [first, second] = await Promise.all([
      create(firstClient, 'First session follow-up', { project_id: project.id }),
      create(secondClient, 'Second session follow-up', { project_id: project.id }),
    ]);
    assert.deepEqual(first.assignee, spec);
    assert.deepEqual(second.assignee, otherSpec);
  });

  await t.test('honors an explicit assignee and explicit null', async (t) => {
    const client = await clientFor(t, source.id);
    const explicit = await create(client, 'Explicitly assigned follow-up', { assignee: defaultSpec });
    assert.deepEqual(explicit.assignee, defaultSpec);
    const unassigned = await create(client, 'Intentionally unassigned follow-up', { project_id: project.id, assignee: null });
    assert.equal(unassigned.assignee, null);
    assert.equal(unassigned.assignee_key, '');
  });

  await t.test('keeps project defaults outside ticket sessions and when the source has no assignee', async (t) => {
    const client = await clientFor(t);
    const ordinary = await create(client, 'Ordinary project ticket', { project_id: project.id });
    assert.deepEqual(ordinary.assignee, defaultSpec);
    const unassigned = await create(client, 'Ordinary unassigned ticket', { related_ticket_id: source.id });
    assert.equal(unassigned.assignee, null, 'a related ticket is not the current session ticket');
    const emptySource = await createTicket(app, token, {
      accountId: account.id, title: 'Unassigned source', status: 'backlog',
    });
    const emptyClient = await clientFor(t, emptySource.id);
    const fallback = await create(emptyClient, 'Project fallback', { project_id: project.id });
    assert.deepEqual(fallback.assignee, defaultSpec);
  });

  await t.test('rejects a missing or foreign source without creating a ticket', async (t) => {
    const foreignAccount = await createAccount(app, token, 'foreign');
    const foreign = await createTicket(app, token, {
      accountId: foreignAccount.id, title: 'Private source', status: 'backlog', assignee: spec,
    });
    for (const id of [randomUUID(), foreign.id]) {
      const client = await clientFor(t, id);
      const before = await tickets.count();
      const result = await client.callTool('create_ticket', { title: 'Must not be created', status: 'backlog' });
      assert.equal(result?.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result), /Current ticket not found in the caller account/);
      assert.equal(await tickets.count(), before);
    }
  });

  await t.test('reads the current stored assignment and validates inherited host access', async (t) => {
    const changing = await createTicket(app, token, {
      accountId: account.id, title: 'Reassigned ticket', status: 'backlog', assignee: spec,
    });
    const client = await clientFor(t, changing.id);
    await tickets.update(changing.id, { assignee: defaultSpec, assignee_key: runtimeIdentityKey(defaultSpec) });
    assert.deepEqual((await create(client, 'After reassignment')).assignee, defaultSpec);

    const foreignAccount = await createAccount(app, token, 'foreign host');
    const foreignHost = await createAgent(app, token, foreignAccount.id, { type: 'manager' });
    await tickets.update(changing.id, { assignee: { ...spec, manager_agent_id: foreignHost.id } });
    const before = await tickets.count();
    const rejected = await client.callTool('create_ticket', { title: 'Invalid inherited host', status: 'backlog' });
    assert.equal(rejected?.isError, true, JSON.stringify(rejected));
    assert.match(JSON.stringify(rejected), /Runtime Host is not available to this account/);
    assert.equal(await tickets.count(), before);
  });
});
