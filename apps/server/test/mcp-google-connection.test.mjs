import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createProject, createTicket, createUser } from './helpers/fixtures.mjs';

const issuer = 'https://awb.example.org';
const resource = issuer + '/mcp';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const scope = 'awb.read offline_access';

test('Google connector discovery, account consent, scoped MCP tools, refresh and disconnect', async t => {
  process.env.AWB_PUBLIC_URL = issuer;
  process.env.MCP_DEV_MODE = 'false';
  const { app, port, modules: { getDataSourceToken } } = await bootApp();
  t.after(() => closeTestApp(app));
  const base = 'http://127.0.0.1:' + port;
  const { GoogleOAuthService } = await import('../dist/services/google-oauth.service.js');
  const { AuthService } = await import('../dist/services/auth.service.js');
  const google = app.get(GoogleOAuthService);
  const alice = await createUser(app, getDataSourceToken, { name: 'alice', role: 'user' });
  const bob = await createUser(app, getDataSourceToken, { name: 'bob', role: 'user' });
  const owned = await createAccount(app, getDataSourceToken, 'owned', { ownerUserId: alice.id });
  const other = await createAccount(app, getDataSourceToken, 'other', { ownerUserId: bob.id });
  const project = await createProject(app, getDataSourceToken, owned.id);
  const privateTicket = await createTicket(app, getDataSourceToken, { accountId: other.id, title: 'Private ticket' });
  const ticket = await createTicket(app, getDataSourceToken, { accountId: owned.id, title: 'Shared ticket' });
  t.mock.method(google, 'getAuthUrl', async (uri, state) => {
    assert.equal(uri, issuer + '/api/auth/oauth/google/callback');
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ state });
  });
  t.mock.method(google, 'exchangeCodeForUser', async (code, uri) => {
    assert.equal(uri, issuer + '/api/auth/oauth/google/callback');
    return { sub: 'google-alice', email: alice.email, name: alice.name, email_verified: code === 'verified', picture: '' };
  });

  const challenge = await fetch(base + '/mcp');
  assert.equal(challenge.status, 401);
  assert.ok(challenge.headers.get('www-authenticate').includes(issuer + '/.well-known/oauth-protected-resource/mcp'));
  const metadata = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(metadata.resource, resource);
  assert.deepEqual(metadata.authorization_servers, [issuer]);
  assert.ok(metadata.scopes_supported.includes('awb.manage'));
  const server = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  process.env.AWB_PUBLIC_URL = issuer + '/awb';
  assert.equal((await (await fetch(base + '/.well-known/oauth-authorization-server/awb')).json()).issuer, issuer + '/awb');
  assert.equal((await (await fetch(base + '/.well-known/oauth-protected-resource/awb/mcp')).json()).resource, issuer + '/awb/mcp');
  process.env.AWB_PUBLIC_URL = issuer;
  const register = (uri, method) => fetch(base + new URL(server.registration_endpoint).pathname, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: method }),
  });
  assert.equal((await register('https://example.org/callback', 'none')).status, 400);
  process.env.MCP_OAUTH_REDIRECT_URIS = 'https://assistant.example.net/auth/callback';
  const otherClient = await register('https://assistant.example.net/auth/callback', 'none');
  assert.equal(otherClient.status, 201);
  assert.equal((await otherClient.json()).client_name, 'https://assistant.example.net');
  const registration = await register(redirectUri, 'none');
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const claudeUri = 'https://claude.ai/api/mcp/auth_callback';
  const claudeRegistration = await register(claudeUri, 'client_secret_post');
  assert.equal(claudeRegistration.status, 201);
  const claude = await claudeRegistration.json();
  assert.equal(claude.client_name, 'Claude');
  assert.ok(claude.client_secret);

  // Follow the real browser redirect chain with only Google's code exchange substituted.
  async function begin(connector = client, uri = redirectUri, requested = scope) {
    const verifier = randomBytes(40).toString('base64url');
    const params = new URLSearchParams({ client_id: connector.client_id, redirect_uri: uri, response_type: 'code', resource,
      state: 'return-to-chat', scope: requested, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const authorize = await fetch(base + new URL(server.authorization_endpoint).pathname + '?' + params, { redirect: 'manual' });
    const next = new URL(authorize.headers.get('location'));
    assert.equal(next.origin, issuer);
    assert.equal(next.pathname, '/api/auth/oauth/google/start');
    const cookie = authorize.headers.get('set-cookie').split(';')[0];
    assert.match(authorize.headers.get('set-cookie'), /HttpOnly/);
    const signIn = await fetch(base + next.pathname + next.search, { headers: { cookie }, redirect: 'manual' });
    const googleUrl = new URL(signIn.headers.get('location'));
    assert.equal(googleUrl.origin, 'https://accounts.google.com');
    const callback = async (code) => {
      const params = new URLSearchParams({ state: googleUrl.searchParams.get('state'), code });
      const res = await fetch(base + '/api/auth/oauth/google/callback?' + params, { headers: { cookie }, redirect: 'manual' });
      return new URL(res.headers.get('location'));
    };
    return { callback, verifier, cookie, requested };
  }
  const invalidIdentity = await begin();
  assert.equal((await invalidIdentity.callback('unverified')).searchParams.get('error'), 'access_denied');

  async function decision(flow, value, accountId, keys = false) {
    const consent = await flow.callback('verified');
    assert.equal(consent.origin, issuer);
    const page = base + consent.pathname;
    assert.equal((await fetch(page)).status, 400);
    const body = await (await fetch(page, { headers: { cookie: flow.cookie, 'accept-language': 'en' } })).text();
    assert.equal(body.includes('Allow account actions'), flow.requested.includes('awb.manage'));
    assert.ok(body.includes(alice.email) && body.includes(owned.id));
    assert.ok(!body.includes(other.id));
    const post = (id, origin) => fetch(page, { method: 'POST', redirect: 'manual',
      headers: { cookie: flow.cookie, origin }, body: new URLSearchParams({ account_id: id, decision: value, ...(keys && { keys: 'allow' }) }) });
    assert.equal((await post(accountId, 'https://example.org')).status, 403);
    if (value === 'allow') assert.equal((await post(other.id, issuer)).status, 403);
    const res = await post(accountId, issuer);
    assert.equal(res.status, 303);
    const dest = new URL(res.headers.get('location'));
    assert.equal(dest.searchParams.get('iss'), issuer);
    assert.equal(dest.searchParams.get('state'), 'return-to-chat');
    return dest;
  }
  const denied = await decision(await begin(), 'deny', owned.id);
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  const token = params => fetch(base + new URL(server.token_endpoint).pathname, {
    method: 'POST', body: new URLSearchParams({ client_id: client.client_id, resource, ...params }),
  });
  async function grant(connector = client, uri = redirectUri, requested = scope, choice = 'allow', keys = false) {
    const flow = await begin(connector, uri, requested);
    const returned = await decision(flow, choice, owned.id, keys);
    assert.equal(returned.origin + returned.pathname, uri);
    const params = { grant_type: 'authorization_code', code: returned.searchParams.get('code'), redirect_uri: uri,
      client_id: connector.client_id, code_verifier: flow.verifier, ...(connector.client_secret && { client_secret: connector.client_secret }) };
    assert.equal((await token({ ...params, code_verifier: randomBytes(40).toString('base64url') })).status, 400);
    assert.equal((await token({ ...params, resource: issuer + '/other' })).status, 400);
    const res = await token(params);
    assert.equal(res.status, 200);
    assert.equal((await token(params)).status, 400);
    return res.json();
  }
  const access = await grant();
  assert.equal(access.scope, scope);
  const claudeAccess = await grant(claude, claudeUri, 'awb.read');
  assert.equal(claudeAccess.refresh_token, undefined);
  const mcp = new Client({ name: 'external-client', version: '1.0' });
  const endpoint = new URL('/mcp', base);
  let bearer = access.access_token;
  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', 'Bearer ' + bearer);
    return fetch(url, { ...init, headers });
  } });
  await mcp.connect(transport);
  t.after(() => mcp.close());
  const { tools } = await mcp.listTools();
  assert.ok(tools.every(tool => tool._meta?.securitySchemes?.length));
  const reads = tools.filter(tool => tool._meta.securitySchemes.some(scheme => scheme.scopes.includes('awb.read')));
  assert.deepEqual(reads.map(tool => tool.name).sort(), ['get_project', 'get_ticket', 'list_projects', 'list_tickets']);
  assert.ok(reads.every(tool => tool.annotations?.readOnlyHint === true));
  const sessionTool = tools.find(tool => tool.name === 'send_session_message');
  assert.deepEqual(sessionTool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['awb.manage'] }]);
  const deniedSend = await mcp.callTool({ name: 'send_session_message', arguments: { session_id: 'example', content: 'Hello' } });
  assert.equal(deniedSend.isError, true);
  const upgrade = deniedSend._meta['mcp/www_authenticate'][0];
  assert.ok(upgrade.includes(`resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`));
  assert.ok(upgrade.includes('error="insufficient_scope"') && upgrade.includes('scope="awb.manage"') && upgrade.includes('error_description='));
  const deniedCreate = await mcp.callTool({ name: 'create_ticket', arguments: { title: 'Blocked before consent' } });
  assert.equal(deniedCreate.isError, true);
  assert.equal(await app.get(getDataSourceToken()).getRepository('Ticket').countBy({ title: 'Blocked before consent' }), 0);
  assert.ok((await mcp.callTool({ name: 'list_projects', arguments: {} })).content[0].text.includes(project.name));
  assert.ok((await mcp.callTool({ name: 'get_ticket', arguments: { ticket_id: ticket.id } })).content[0].text.includes(ticket.title));
  assert.equal((await mcp.callTool({ name: 'get_ticket', arguments: { ticket_id: privateTicket.id } })).isError, true);
  const sessionRequest = (credential) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', authorization: 'Bearer ' + credential, 'mcp-session-id': transport.sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await sessionRequest(claudeAccess.access_token)).status, 404);
  const refresh = (refresh_token) => token({ grant_type: 'refresh_token', refresh_token });
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: access.refresh_token, scope: 'awb.read awb.manage offline_access' })).status, 400);
  const rotation = await refresh(access.refresh_token);
  assert.equal(rotation.status, 200);
  const rotated = await rotation.json();
  assert.notEqual(rotated.refresh_token, access.refresh_token);
  assert.equal((await sessionRequest(bearer)).status, 401);
  bearer = rotated.access_token;
  assert.deepEqual((await mcp.listTools()).tools, tools);
  assert.equal((await refresh(access.refresh_token)).status, 400);
  assert.equal((await sessionRequest(bearer)).status, 401);
  const simultaneous = await grant();
  const attempts = await Promise.all([refresh(simultaneous.refresh_token), refresh(simultaneous.refresh_token)]);
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 400]);
  const winner = await attempts.find(r => r.ok).json();
  assert.equal((await sessionRequest(winner.access_token)).status, 401);

  const management = (user, account) => ({ authorization: 'Bearer ' + app.get(AuthService).createSession(user.id), 'x-account-id': account.id });
  const list = base + '/api/mcp-oauth/connections';
  const owner = management(alice, owned);
  const stranger = management(bob, other);
  const { connections } = await (await fetch(list, { headers: owner })).json();
  assert.deepEqual(connections.map(c => c.client_name), ['Claude']);
  assert.deepEqual((await (await fetch(list, { headers: stranger })).json()).connections, []);
  await fetch(list + '/' + connections[0].id, { method: 'DELETE', headers: stranger });
  assert.equal((await (await fetch(list, { headers: owner })).json()).connections.length, 1);
  assert.equal((await fetch(list + '/' + connections[0].id, { method: 'DELETE', headers: owner })).status, 200);
  assert.equal((await sessionRequest(claudeAccess.access_token)).status, 401);

  const readChoice = await grant(client, redirectUri, 'awb.read awb.manage', 'read');
  assert.equal(readChoice.scope, 'awb.read');
  const manage = await grant(client, redirectUri, 'awb.read awb.manage awb.keys offline_access', 'allow', true);
  assert.equal(manage.scope, 'awb.read awb.manage offline_access', 'a user without key administration cannot grant it');
  const appClient = new Client({ name: 'AWB app', version: '1' });
  const managedTransport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: {
    authorization: 'Bearer ' + manage.access_token, 'X-AWB-Client-Type': 'agent-session', 'X-AWB-Session-Id': 'native-sender',
  } } });
  await appClient.connect(managedTransport);
  t.after(() => appClient.close());
  const fullTools = (await appClient.listTools()).tools;
  assert.deepEqual(fullTools, tools, 'a scan using a read grant discovers the same actions as a scan after consent');
  const names = fullTools.map(t => t.name);
  for (const name of ['create_ticket', 'move_ticket', 'add_comment', 'list_sessions', 'open_session', 'send_session_message', 'get_session_messages', 'get_business_cashbook', 'get_action']) {
    assert.ok(names.includes(name), name);
  }
  for (const name of ['list_session_hosts', 'list_sessions', 'get_session_messages']) {
    assert.equal(fullTools.find(tool => tool.name === name)?.annotations?.readOnlyHint, true, name);
  }
  assert.ok(!fullTools.find(tool => tool.name === 'send_session_message').annotations?.readOnlyHint);
  const call = (name, args = {}) => appClient.callTool({ name, arguments: args });
  const me = JSON.parse((await call('whoami')).content[0].text);
  assert.equal(me.user_id, alice.id);
  assert.equal(me.account_id, owned.id);
  assert.equal((await call('list_session_hosts')).isError, true, 'ordinary users need agent_sessions.use even with app consent');
  const ds = app.get(getDataSourceToken());
  await ds.getRepository('User').update(alice.id, { permissions: JSON.stringify(['agent_sessions.use']) });
  assert.ok(!(await call('list_session_hosts')).isError);
  assert.equal((await call('get_ticket', { ticket_id: privateTicket.id })).isError, true);
  assert.equal((await call('create_ticket', { account_id: other.id, title: 'wrong account' })).isError, true);
  const added = await call('create_ticket', { title: 'From connected app' });
  assert.ok(!added.isError, added.content[0].text);
  const commented = await call('add_comment', { ticket_id: ticket.id, content: 'App note', author_id: bob.id, author_type: 'agent' });
  assert.ok(!commented.isError, commented.content[0].text);
  const saved = await ds.getRepository('Comment').findOneByOrFail({ ticket_id: ticket.id, content: 'App note' });
  assert.equal(saved.author_type, 'user');
  assert.equal(saved.author_id, alice.id);
  const rooms = ds.getRepository('ChatRoom');
  const mine = await rooms.save(rooms.create({ account_id: owned.id, type: 'group', name: 'Own room' }));
  const theirs = await rooms.save(rooms.create({ account_id: other.id, type: 'group', name: 'Outside room' }));
  for (const room of [mine, theirs]) {
    await ds.getRepository('ChatRoomParticipant').insert({ room_id: room.id, participant_id: alice.id, participant_type: 'user' });
  }
  const roomList = (await call('list_chat_rooms')).content[0].text;
  assert.ok(roomList.includes(mine.id) && !roomList.includes(theirs.id), roomList);
  const chat = await call('send_chat_room_message', { room_id: mine.id, content: 'Room note' });
  assert.ok(!chat.isError, chat.content[0].text);
  assert.ok((await call('get_chat_room_messages', { room_id: mine.id })).content[0].text.includes('Room note'));
  assert.equal((await call('send_chat_room_message', { room_id: theirs.id, content: 'wrong account' })).isError, true);
  await ds.getRepository('User').update(alice.id, { permissions: '[]' });
  assert.equal((await call('list_session_hosts')).isError, true, 'permission removal takes effect on an open connection');
  const actions = ds.getRepository('Action');
  const action = await actions.save(actions.create({ account_id: owned.id, name: 'My action' }));
  const foreignAction = await actions.save(actions.create({ account_id: other.id, name: 'Other action' }));
  assert.equal((await call('get_action', { id: action.id })).isError, true);
  await ds.getRepository('User').update(alice.id, { permissions: JSON.stringify(['admin.actions']) });
  assert.ok(!(await call('get_action', { id: action.id })).isError);
  assert.equal((await call('get_action', { id: foreignAction.id })).isError, true);
  assert.equal((await call('list_actions', { account_id: '' })).isError, true);
  const visibleTickets = (await call('list_tickets')).content[0].text;
  assert.ok(visibleTickets.includes(ticket.id));
  assert.ok(!visibleTickets.includes(privateTicket.id));
  await ds.getRepository('User').update(alice.id, { permissions: JSON.stringify(['admin.api_keys']) });
  assert.deepEqual(tools.find(tool => tool.name === 'create_api_key')._meta.securitySchemes[0].scopes, ['awb.manage', 'awb.keys']);
  const deniedKey = await call('create_api_key', { name: 'not-issued' });
  assert.equal(deniedKey.isError, true);
  assert.match(deniedKey._meta['mcp/www_authenticate'][0], /scope="awb.manage awb.keys"/);
  const narrowed = await token({ grant_type: 'refresh_token', refresh_token: manage.refresh_token, scope: 'awb.read offline_access' });
  assert.equal(narrowed.status, 200);
  const reduced = await narrowed.json();
  assert.equal(reduced.scope, 'awb.read offline_access');
  const reused = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    authorization: 'Bearer ' + reduced.access_token, 'mcp-session-id': managedTransport.sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  assert.equal(reused.status, 404, 'a narrowed grant cannot reuse its full tool session');
  assert.equal((await grant(client, redirectUri, 'awb.manage awb.keys')).scope, 'awb.manage', 'key issuance requires separate opt-in');
  const keyGrant = await grant(client, redirectUri, 'awb.manage awb.keys', 'allow', true);
  assert.equal(keyGrant.scope, 'awb.manage awb.keys');
  const keyClient = new Client({ name: 'key admin', version: '1' });
  await keyClient.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: 'Bearer ' + keyGrant.access_token } } }));
  t.after(() => keyClient.close());
  const issued = await keyClient.callTool({ name: 'create_api_key', arguments: { name: 'account-test', scope: 'read' } });
  assert.ok(!issued.isError && JSON.parse(issued.content[0].text).raw_key);
});
