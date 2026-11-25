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
    return { callback, verifier, cookie };
  }
  const invalidIdentity = await begin();
  assert.equal((await invalidIdentity.callback('unverified')).searchParams.get('error'), 'access_denied');

  async function decision(flow, value, accountId) {
    const consent = await flow.callback('verified');
    assert.equal(consent.origin, issuer);
    const page = base + consent.pathname;
    assert.equal((await fetch(page)).status, 400);
    const body = await (await fetch(page, { headers: { cookie: flow.cookie } })).text();
    assert.ok(body.includes(alice.email) && body.includes(owned.id));
    assert.ok(!body.includes(other.id));
    const post = (id, origin) => fetch(page, { method: 'POST', redirect: 'manual',
      headers: { cookie: flow.cookie, origin }, body: new URLSearchParams({ account_id: id, decision: value }) });
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
  async function grant(connector = client, uri = redirectUri, requested = scope) {
    const flow = await begin(connector, uri, requested);
    const returned = await decision(flow, 'allow', owned.id);
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
  assert.deepEqual(tools.map(item => item.name).sort(), ['get_project', 'get_ticket', 'list_projects', 'list_tickets']);
  assert.ok(tools.every(item => item.annotations?.readOnlyHint === true));
  assert.ok((await mcp.callTool({ name: 'list_projects', arguments: {} })).content[0].text.includes(project.name));
  assert.ok((await mcp.callTool({ name: 'get_ticket', arguments: { ticket_id: ticket.id } })).content[0].text.includes(ticket.title));
  assert.equal((await mcp.callTool({ name: 'get_ticket', arguments: { ticket_id: privateTicket.id } })).isError, true);
  const sessionRequest = (credential) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', authorization: 'Bearer ' + credential, 'mcp-session-id': transport.sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await sessionRequest(claudeAccess.access_token)).status, 404);
  const refresh = (refresh_token) => token({ grant_type: 'refresh_token', refresh_token });
  const rotation = await refresh(access.refresh_token);
  assert.equal(rotation.status, 200);
  const rotated = await rotation.json();
  assert.notEqual(rotated.refresh_token, access.refresh_token);
  assert.equal((await sessionRequest(bearer)).status, 401);
  bearer = rotated.access_token;
  assert.equal((await mcp.listTools()).tools.length, 4);
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
});
