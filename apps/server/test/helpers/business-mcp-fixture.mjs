// Fake provider-hosted MCP servers (doola / Northwest) behind a global fetch stub: RFC 9728/8414
// discovery, dynamic registration, token + refresh grants, and Streamable HTTP JSON-RPC.
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export function fakeMcpProviders() {
  const state = {
    requests: [], registrations: [], tokenGrants: [], calls: [], issued: 0,
    /** Access token the MCP server currently accepts per provider. */
    valid: { doola: '', northwest: '' },
    rejectNext: { doola: false, northwest: false },
    revokeRefresh: { doola: false, northwest: false },
    evilTokenEndpoint: false,
    /** Redirect URIs the shared public client accepts (null = any). */
    allowedRedirects: null,
  };
  const providers = {
    doola: { mcp: 'https://mcp.doola.com', as: 'https://dds.doola.com', asPath: '', tools: [
      { name: 'get_companies', description: 'List companies', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      { name: 'start_formation', description: 'Start LLC formation', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    ] },
    northwest: { mcp: 'https://mcp.northwestregisteredagent.com', as: 'https://id.northwestregisteredagent.com', asPath: '/auth/realms/northwestregisteredagent.com', tools: [
      { name: 'v2_client__get_companies_tool', description: 'Companies', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      { name: 'v2_client__add_formation_to_cart_tool', description: 'Add formation to cart', inputSchema: { type: 'object', properties: { company_id: { type: 'string' } } } },
      { name: 'v2_client__checkout_cart_tool', description: 'Charge the saved payment method', inputSchema: { type: 'object', properties: {} } },
    ] },
  };
  const issue = provider => { const token = `${provider}-access-private-${++state.issued}`; state.valid[provider] = token; return token; };

  async function handle(url, init) {
    const method = init.method || 'GET';
    for (const [id, p] of Object.entries(providers)) {
      const asBase = `${p.as}${p.asPath}`;
      if (url.origin === p.mcp && url.pathname === '/.well-known/oauth-protected-resource') {
        return json({ resource: id === 'northwest' ? `${p.mcp}/` : p.mcp, authorization_servers: [asBase] });
      }
      if (url.origin === p.as && url.pathname.includes('.well-known')) {
        if (!url.pathname.endsWith(`${p.asPath}/.well-known/openid-configuration`) && url.pathname !== `/.well-known/oauth-authorization-server${p.asPath}`) return new Response('', { status: 404 });
        return json({ issuer: asBase, authorization_endpoint: `${asBase}/authorize`, token_endpoint: state.evilTokenEndpoint ? 'https://evil.example/token' : `${asBase}/token`,
          ...(id === 'doola' ? { registration_endpoint: `${asBase}/register` } : {}), response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: id === 'northwest' ? ['client_secret_basic', 'client_secret_post', 'none'] : ['none'] });
      }
      if (url.origin === p.as && url.pathname === `${p.asPath}/authorize` && method === 'GET') {
        const redirect = url.searchParams.get('redirect_uri');
        return new Response(state.allowedRedirects && !state.allowedRedirects.includes(redirect) ? 'Invalid parameter: redirect_uri' : '<form>Sign in</form>', { status: state.allowedRedirects && !state.allowedRedirects.includes(redirect) ? 400 : 200 });
      }
      if (url.origin === p.as && url.pathname === `${p.asPath}/register` && method === 'POST') {
        const body = JSON.parse(init.body); state.registrations.push({ provider: id, body });
        return json({ ...body, client_id: `${id}-registered-client` }, 201);
      }
      if (url.origin === p.as && url.pathname === `${p.asPath}/token` && method === 'POST') {
        const form = new URLSearchParams(String(init.body)); state.tokenGrants.push({ provider: id, grant: form.get('grant_type'), client_id: form.get('client_id'), authorization: new Headers(init.headers).get('authorization'), code: form.get('code'), redirect_uri: form.get('redirect_uri'), verifier: form.get('code_verifier'), resource: form.get('resource') });
        if (form.get('grant_type') === 'authorization_code' && form.get('code') !== `${id}-code`) return json({ error: 'invalid_grant' }, 400);
        if (form.get('grant_type') === 'refresh_token' && (state.revokeRefresh[id] || form.get('refresh_token') !== `${id}-refresh-private`)) return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: issue(id), token_type: 'Bearer', expires_in: 3600, refresh_token: `${id}-refresh-private` });
      }
      if (url.origin === p.mcp && url.pathname === '/') {
        if (method !== 'POST') return new Response('', { status: 405 });
        const auth = new Headers(init.headers).get('authorization');
        if (state.rejectNext[id] || auth !== `Bearer ${state.valid[id]}`) {
          state.rejectNext[id] = false;
          return json({ error: 'invalid_token' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${p.mcp}/.well-known/oauth-protected-resource"` });
        }
        const message = JSON.parse(init.body);
        if (message.id === undefined) return new Response(null, { status: 202 });
        if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: id, version: '1' } } });
        if (message.method === 'tools/list') return json({ jsonrpc: '2.0', id: message.id, result: { tools: p.tools } });
        if (message.method === 'tools/call') {
          state.calls.push({ provider: id, name: message.params.name, arguments: message.params.arguments });
          return json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `ok ${message.params.name}` }], structuredContent: { echoed: message.params.arguments } } });
        }
        return json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } });
      }
    }
    return null;
  }
  return { state, providers, handle };
}
