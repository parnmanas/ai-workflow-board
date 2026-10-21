import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createProject, createTicket, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';

test('MCP enforces stored ownership before reading or mutating tickets, comments, files and linked objects', async t => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const token = modules.getDataSourceToken;
  const ds = app.get(token());
  const ownerA = await createUser(app, token, { name: 'MCP owner A', role: 'admin' });
  const ownerB = await createUser(app, token, { name: 'MCP owner B', role: 'admin' });
  const a = await createAccount(app, token, 'A', { ownerUserId: ownerA.id });
  const b = await createAccount(app, token, 'B', { ownerUserId: ownerB.id });
  const host = await createAgent(app, token, a.id, { type: 'manager', name: 'A host' });
  const foreignHost = await createAgent(app, token, b.id, { type: 'manager', name: 'B host' });
  const key = await createApiKey(app, token, host.id, { accountId: a.id, hostId: host.id, scope: 'full' });
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => client.close());
  const own = await createTicket(app, token, { accountId: a.id, title: 'Own ticket', status: 'backlog' });
  const foreign = await createTicket(app, token, { accountId: b.id, title: 'Private ticket', status: 'backlog' });
  const project = await createProject(app, token, b.id, { name: 'Private project' });
  const comments = ds.getRepository('Comment');
  const question = await comments.save(comments.create({ account_id: b.id, ticket_id: foreign.id, type: 'question', status: 'open', content: 'private question', author_type: 'user', author_id: ownerB.id, author: ownerB.name }));
  const files = ds.getRepository('TicketAttachment');
  const file = await files.save(files.create({ account_id: b.id, ticket_id: foreign.id, owner_type: 'ticket', owner_id: foreign.id, file_name: 'private.txt', file_data: 'c2VjcmV0', file_size: 6 }));
  const channels = ds.getRepository('Channel');
  const privateChannel = await channels.save(channels.create({ name: 'Private channel', account_id: b.id }));
  const creds = ds.getRepository('Credential');
  const privateCredential = await creds.save(creds.create({ name: 'Private token', provider: 'github', account_id: b.id, encrypted_data: 'must-not-decrypt-foreign-secret' }));
  const before = { tickets: await ds.getRepository('Ticket').count(), comments: await comments.count(), files: await files.count() };
  for (const [name, args] of [
    ['list_tickets', { account_id: b.id }],
    ['list_archived_tickets', { account_id: b.id }],
    ['create_ticket', { account_id: b.id, title: 'Hijack', status: 'backlog' }],
    ['get_ticket', { ticket_id: foreign.id }],
    ['update_ticket', { ticket_id: foreign.id, title: 'Hijack' }],
    ['delete_ticket', { ticket_id: foreign.id }],
    ['move_ticket', { ticket_id: foreign.id, status: 'done' }],
    ['archive_ticket', { ticket_id: foreign.id }],
    ['claim_ticket', { ticket_id: foreign.id }],
    ['set_current_task', { agent_id: foreignHost.id, ticket_id: own.id }],
    ['clear_current_task', { agent_id: foreignHost.id }],
    ['create_child_ticket', { parent_id: foreign.id, title: 'Hijack' }],
    ['add_comment', { ticket_id: foreign.id, content: 'Hijack' }],
    ['ask_question', { ticket_id: foreign.id, content: 'Hijack' }],
    ['answer_question', { question_comment_id: question.id, content: 'Hijack' }],
    ['list_ticket_attachments', { ticket_id: foreign.id }],
    ['get_ticket_attachment', { attachment_id: file.id }],
    ['delete_ticket_attachment', { attachment_id: file.id }],
    ['add_ticket_attachment', { ticket_id: foreign.id, file_name: 'x', file_data: 'eA==' }],
    ['add_ticket_prerequisites', { ticket_id: own.id, prerequisite_ticket_ids: [foreign.id] }],
    ['update_ticket', { ticket_id: own.id, next_ticket_id: foreign.id }],
    ['update_ticket', { ticket_id: own.id, project_id: project.id }],
    ['subscribe_events', { account_id: b.id }],
    ['update_channel', { channel_db_id: privateChannel.id, name: 'Hijack' }],
    ['delete_channel', { channel_db_id: privateChannel.id }],
    ['fetch_github_info', { owner: 'example', repo: 'private', credential_id: privateCredential.id }],
    ['get_latest_artifact', { account_id: b.id, repo: { url: 'https://github.com/example/private.git' }, target: 'linux' }],
  ]) {
    const result = await client.callTool(name, args);
    assert.equal(result?.isError, true, name + ': ' + JSON.stringify(result));
    assert.match(JSON.stringify(result), /Unauthorized.*caller account/, name);
  }
  assert.deepEqual({ tickets: await ds.getRepository('Ticket').count(), comments: await comments.count(), files: await files.count() }, before);
  assert.equal((await ds.getRepository('Ticket').findOneBy({ id: foreign.id })).title, 'Private ticket');
  assert.equal((await comments.findOneBy({ id: question.id })).status, 'open');
  assert.equal((await client.callTool('get_ticket', { ticket_id: own.id })).id, own.id);
  assert.deepEqual((await client.callTool('list_tickets', {})).tickets.map(row => row.id), [own.id]);
  const added = await client.callTool('create_channel', { name: 'Owned channel' });
  assert.equal(added.account_id, a.id);
  assert.deepEqual((await client.callTool('list_channels', {})).map(row => row.id), [added.id]);
  const activity = ds.getRepository('ActivityLog');
  await activity.save(activity.create({ account_id: a.id, ticket_id: own.id, entity_type: 'ticket', entity_id: own.id, action: 'created', new_value: 'own' }));
  await activity.save(activity.create({ account_id: b.id, ticket_id: foreign.id, entity_type: 'ticket', entity_id: foreign.id, action: 'created', new_value: 'private' }));
  const events = await client.callTool('subscribe_events', {});
  assert.ok(events.events.some(row => row.ticket_id === own.id));
  assert.ok(events.events.every(row => row.ticket_id !== foreign.id));
});
