import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createUser } from './helpers/fixtures.mjs';
import { fakeMcpProviders } from './helpers/business-mcp-fixture.mjs';
import { BusinessMcpService } from '../dist/modules/business/business-mcp.service.js';
import { MCP_LOOPBACK_REDIRECT } from '../dist/modules/business/connectors/mcp-providers.js';

test('Business MCP connectors: owner sign-in, pinned origins, confirm gate and owner-only payment tools', { timeout: 120000 }, async t => {
  const { app, port, modules } = await bootApp();
  t.after(() => closeTestApp(app));
  const ds = app.get(modules.getDataSourceToken());
  const owner = await createUser(app, modules.getDataSourceToken, { name: 'MCP owner', role: 'admin' });
  const other = await createUser(app, modules.getDataSourceToken, { name: 'Other owner', role: 'admin' });
  const mine = await createAccount(app, modules.getDataSourceToken, 'mcp-owner', { ownerUserId: owner.id });
  const theirs = await createAccount(app, modules.getDataSourceToken, 'mcp-other', { ownerUserId: other.id });
  const nativeFetch = globalThis.fetch; t.after(() => { globalThis.fetch = nativeFetch; });
  const publicUrl = process.env.AWB_PUBLIC_URL; t.after(() => { if (publicUrl === undefined) delete process.env.AWB_PUBLIC_URL; else process.env.AWB_PUBLIC_URL = publicUrl; });
  const fake = fakeMcpProviders(); const unexpected = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
    assert.equal(init.redirect, 'error', `${url} must refuse redirects`);
    const response = await fake.handle(url, init);
    if (response) return response;
    unexpected.push(`${init.method || 'GET'} ${url}`); throw new Error('unexpected provider request');
  };
  const tokens = new Map([owner, other].map(u => [u.id, app.get(modules.AuthService).createSession(u.id)]));
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST', user = owner, account = mine.id) => {
    const res = await nativeFetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { Authorization: `Bearer ${tokens.get(user.id)}`, 'Content-Type': 'application/json', 'X-Account-Id': account }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const created = await call('/business/companies', { name: 'MCP Orbit LLC', entity_type: 'LLC', country: 'US' });
  assert.equal(created.status, 201); const base = `/business/companies/${created.body.id}/mcp`;
  const service = app.get(BusinessMcpService);

  await t.test('catalog exposes doola and Northwest as MCP connectors without partner keys', async () => {
    const catalog = (await call('/business/connectors')).body;
    for (const id of ['doola', 'northwest']) {
      const c = catalog.find(row => row.id === id);
      assert.equal(c.mode, 'mcp'); assert.deepEqual(c.secret_fields, []); assert.equal(c.credential_provider, undefined);
      assert.ok(c.offering.pricing.plans.length > 0 && c.offering.pricing.checked_at);
    }
    const listed = (await call(base)).body;
    assert.deepEqual(listed.map(row => [row.provider, row.status]), [['doola', 'disconnected'], ['northwest', 'disconnected']]);
  });

  await t.test('doola: dynamic registration, browser-cookie bound callback and PKCE', async () => {
    process.env.AWB_PUBLIC_URL = `http://localhost:${port}`;
    const started = await call(`${base}/doola/authorize`, {});
    assert.equal(started.status, 201); assert.equal(started.body.mode, 'redirect');
    const authorize = new URL(started.body.url);
    assert.equal(authorize.origin, 'https://dds.doola.com');
    assert.equal(authorize.searchParams.get('client_id'), 'doola-registered-client');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('redirect_uri'), `http://localhost:${port}/api/business-mcp/oauth/callback`);
    assert.equal(fake.state.registrations.length, 1); assert.equal(fake.state.registrations[0].body.token_endpoint_auth_method, 'none');
    const cookie = started.headers.get('set-cookie').split(';')[0];
    const state = authorize.searchParams.get('state');
    const back = (c, code = 'doola-code') => nativeFetch(`http://127.0.0.1:${port}/api/business-mcp/oauth/callback?state=${state}&code=${code}`, { redirect: 'manual', headers: c ? { Cookie: c } : {} });
    assert.equal((await back('')).status, 400, 'a callback without the starting browser cookie is refused');
    const ok = await back(cookie);
    assert.equal(ok.status, 303); assert.match(ok.headers.get('location'), /mcp=doola/);
    assert.equal((await back(cookie)).status, 400, 'state is single use');
    const grant = fake.state.tokenGrants.at(-1);
    assert.equal(grant.grant, 'authorization_code'); assert.ok(grant.verifier); assert.equal(grant.resource, 'https://mcp.doola.com/');
    const listed = (await call(base)).body.find(row => row.provider === 'doola');
    assert.equal(listed.status, 'connected');
    const raw = JSON.stringify(await ds.getRepository('BusinessMcpConnection').find());
    assert.doesNotMatch(JSON.stringify((await call(base)).body) + raw, /access-private|refresh-private/, 'tokens stay encrypted and are never returned');
  });

  await t.test('doola: read-only runs directly, writes need confirm, 401 refreshes once', async () => {
    const tools = (await call(`${base}/doola/tools`)).body;
    assert.deepEqual(tools.tools.map(tool => [tool.name, tool.read_only]), [['get_companies', true], ['start_formation', false]]);
    assert.equal(tools.tools[0].input_schema, undefined, 'catalogue omits schemas unless names are requested');
    assert.ok((await call(`${base}/doola/tools?names=start_formation`)).body.tools[0].input_schema.properties.name);
    const read = await call(`${base}/doola/call`, { tool: 'get_companies', arguments: {} });
    assert.equal(read.status, 201); assert.equal(read.body.content_untrusted[0].text, 'ok get_companies');
    const before = fake.state.calls.length;
    const blocked = await call(`${base}/doola/call`, { tool: 'start_formation', arguments: { name: 'Orbit' } });
    assert.equal(blocked.status, 400); assert.match(blocked.body.message || blocked.body.error, /confirm/);
    assert.equal(fake.state.calls.length, before, 'an unconfirmed write never reaches the provider');
    fake.state.rejectNext.doola = true;
    const write = await call(`${base}/doola/call`, { tool: 'start_formation', arguments: { name: 'Orbit' }, confirm: true });
    assert.equal(write.status, 201); assert.deepEqual(write.body.structured_untrusted, { echoed: { name: 'Orbit' } });
    assert.equal(fake.state.tokenGrants.at(-1).grant, 'refresh_token');
    assert.equal(fake.state.calls.filter(c => c.name === 'start_formation').length, 1, 'the rejected attempt did not run the tool');
    const events = await ds.getRepository('BusinessEvent').findBy({ company_id: created.body.id });
    assert.ok(events.some(e => /start_formation 실행/.test(e.message))); assert.ok(!events.some(e => /get_companies/.test(e.message)));
    assert.equal((await call(`${base}/doola/call`, { tool: 'missing_tool' })).status, 404);
  });

  await t.test('Northwest: public client, loopback paste-back bound to the owner, owner-only checkout', async () => {
    const started = await call(`${base}/northwest/authorize`, {});
    assert.equal(started.body.mode, 'paste'); assert.equal(started.body.redirect_uri, MCP_LOOPBACK_REDIRECT);
    assert.equal(started.headers.get('set-cookie'), null);
    const authorize = new URL(started.body.url);
    assert.equal(authorize.origin, 'https://id.northwestregisteredagent.com');
    assert.equal(authorize.searchParams.get('client_id'), 'mcp-connector');
    assert.equal(authorize.searchParams.get('scope'), 'openid profile email');
    assert.equal(fake.state.registrations.filter(r => r.provider === 'northwest').length, 0, 'Keycloak refuses anonymous registration; the public client is used');
    const pasted = `${MCP_LOOPBACK_REDIRECT}?state=${authorize.searchParams.get('state')}&session_state=x&code=northwest-code`;
    assert.equal((await call(`${base}/northwest/complete`, { callback_url: pasted.replace('/awb/oauth/callback', '/other') })).status, 400);
    assert.ok([403, 404].includes((await call(`${base}/northwest/complete`, { callback_url: pasted }, 'POST', other, theirs.id)).status), 'another account cannot finish the sign-in');
    const done = await call(`${base}/northwest/complete`, { callback_url: pasted });
    assert.equal(done.status, 201); assert.equal(done.body.provider, 'northwest');
    assert.equal(fake.state.tokenGrants.at(-1).client_id, 'mcp-connector');
    const tools = (await call(`${base}/northwest/tools`)).body.tools;
    assert.deepEqual(tools.map(tool => [tool.name, tool.read_only, tool.owner_only]), [
      ['v2_client__get_companies_tool', true, false], ['v2_client__add_formation_to_cart_tool', false, false], ['v2_client__checkout_cart_tool', false, true]]);
    const before = fake.state.calls.length;
    const checkout = await call(`${base}/northwest/call`, { tool: 'v2_client__checkout_cart_tool', arguments: {}, confirm: true });
    assert.equal(checkout.status, 403); assert.equal(fake.state.calls.length, before, 'checkout never reaches the provider, even with confirm');
    assert.equal((await call(`${base}/northwest/call`, { tool: 'v2_client__add_formation_to_cart_tool', arguments: { company_id: 'c1' }, confirm: true })).status, 201);
  });

  await t.test('Northwest: a rejected shared redirect stops before the provider page; an issued client returns to AWB', async () => {
    fake.state.allowedRedirects = ['https://claude.ai/api/mcp/auth_callback'];
    const rejected = await call(`${base}/northwest/authorize`, {});
    assert.equal(rejected.status, 409); assert.match(rejected.body.message || rejected.body.error, /NORTHWEST_MCP_CLIENT_ID/);
    process.env.NORTHWEST_MCP_CLIENT_ID = 'awb-issued'; process.env.NORTHWEST_MCP_CLIENT_SECRET = 'issued-secret-private';
    t.after(() => { delete process.env.NORTHWEST_MCP_CLIENT_ID; delete process.env.NORTHWEST_MCP_CLIENT_SECRET; fake.state.allowedRedirects = null; });
    process.env.AWB_PUBLIC_URL = `http://localhost:${port}`;
    const started = await call(`${base}/northwest/authorize`, {});
    assert.equal(started.status, 201); assert.equal(started.body.mode, 'redirect');
    const authorize = new URL(started.body.url);
    assert.equal(authorize.searchParams.get('client_id'), 'awb-issued');
    assert.equal(authorize.searchParams.get('redirect_uri'), `http://localhost:${port}/api/business-mcp/oauth/callback`);
    const cookie = started.headers.get('set-cookie').split(';')[0];
    const back = await nativeFetch(`http://127.0.0.1:${port}/api/business-mcp/oauth/callback?state=${authorize.searchParams.get('state')}&code=northwest-code`, { redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal(back.status, 303);
    assert.equal(fake.state.tokenGrants.at(-1).authorization, `Basic ${Buffer.from('awb-issued:issued-secret-private').toString('base64')}`);
    assert.doesNotMatch(JSON.stringify((await call(base)).body), /issued-secret-private/);
  });

  await t.test('foreign accounts, unpinned endpoints and disconnect', async () => {
    assert.ok([403, 404].includes((await call(base, undefined, 'GET', other, theirs.id)).status));
    assert.ok([403, 404].includes((await call(`${base}/doola/call`, { tool: 'get_companies' }, 'POST', other, theirs.id)).status));
    service.discovery.clear(); fake.state.evilTokenEndpoint = true;
    const evil = await call(`${base}/doola/authorize`, {});
    assert.equal(evil.status, 502, 'a token endpoint outside the pinned origins aborts sign-in');
    fake.state.evilTokenEndpoint = false; service.discovery.clear();
    fake.state.rejectNext.doola = true; fake.state.revokeRefresh.doola = true;
    assert.equal((await call(`${base}/doola/call`, { tool: 'get_companies' })).status, 409, 'a revoked grant asks the owner to sign in again');
    assert.equal((await call(base)).body.find(row => row.provider === 'doola').status, 'error');
    assert.equal((await call(`${base}/doola`, undefined, 'DELETE')).status, 200);
    assert.equal((await call(base)).body.find(row => row.provider === 'doola').status, 'disconnected');
    assert.equal((await call(`${base}/doola/call`, { tool: 'get_companies' })).status, 404);
  });
  assert.deepEqual(unexpected, []);
});
