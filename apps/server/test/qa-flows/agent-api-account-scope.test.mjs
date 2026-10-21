// Regression — security finding (authz): the legacy /api/agent/* surface never
// enforced account scoping, so a account-scoped API key could read/mutate
// tickets and chat in ANY account (cross-account IDOR). The fix
// stamps request.currentAccountId from the presented DB key and rejects a
// scoped key whose account doesn't match the target resource.
//
// This flow drives the REST endpoints directly with `fetch`. Crucially it
// disables AGENT_DEV_MODE before boot — the dev bypass sets scope=null (full
// scope) on every request, which would mask the very check we're verifying.
import test from 'node:test';
import assert from 'node:assert/strict';

// MUST run before bootApp reads the env. With AGENT_DEV_MODE off, AgentAuthGuard
// validates the X-Agent-Key for real and derives the account scope from it.
process.env.AGENT_DEV_MODE = 'false';

import { bootApp, closeTestApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createAccount,
  createTicket,
  createAgent,
  createApiKey,
} from '../helpers/fixtures.mjs';

function getTicket(port, ticketId, rawKey) {
  return fetch(`http://127.0.0.1:${port}/api/agent/tickets/${encodeURIComponent(ticketId)}`, {
    headers: rawKey ? { 'X-Agent-Key': rawKey } : {},
  });
}

test('agent-api enforces account scoping on the legacy /api/agent surface', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT || '0', 10) });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken } = modules;

  // Two isolated accounts; the target ticket lives in ws_a.
  const wsA = await createAccount(app, getDataSourceToken, 'scope-a');
  const wsB = await createAccount(app, getDataSourceToken, 'scope-b');
  const ticket = await createTicket(app, getDataSourceToken, {
    accountId: wsA.id, title: 'secret ticket', status: 'todo',
  });

  const keyA = await createApiKey(app, getDataSourceToken, null, { accountId: wsA.id, label: 'a' });
  const keyB = await createApiKey(app, getDataSourceToken, null, { accountId: wsB.id, label: 'b' });
  // A credential without an owning account cannot authorize work.
  const keyGlobal = await createApiKey(app, getDataSourceToken, null, { accountId: '', label: 'global' });

  step('a key scoped to the ticket\'s own account can read it (200)');
  const sameWs = await getTicket(port, ticket.id, keyA.raw_key);
  assert.equal(sameWs.status, 200, 'same-account key must be allowed');
  const body = await sameWs.json();
  assert.equal(body.id, ticket.id, 'returns the ticket payload');

  step('a key scoped to a DIFFERENT account is rejected (403) — the IDOR fix');
  const crossWs = await getTicket(port, ticket.id, keyB.raw_key);
  assert.equal(crossWs.status, 403, 'cross-account key must be denied');
  const err = await crossWs.json();
  assert.equal(err.error, 'account_scope_denied', 'returns the scope-denied error code');

  step('an account-less key is rejected instead of gaining global work access');
  const globalRead = await getTicket(port, ticket.id, keyGlobal.raw_key);
  assert.equal(globalRead.status, 401, 'unowned key must be rejected');

  step('a manager key stays inside its host account');
  const manager = await createAgent(app, getDataSourceToken, wsB.id, {
    name: 'mgr', type: 'manager',
  });
  const keyManager = await createApiKey(app, getDataSourceToken, manager.id, {
    accountId: wsB.id, label: 'mgr', hostId: manager.id,
  });
  const ownTicket = await createTicket(app, getDataSourceToken, {
    accountId: wsB.id, title: 'manager-owned ticket', status: 'todo',
  });
  assert.equal((await getTicket(port, ownTicket.id, keyManager.raw_key)).status, 200);
  const mgrCross = await getTicket(port, ticket.id, keyManager.raw_key);
  assert.equal(mgrCross.status, 403, 'manager key cannot reach another account');
  assert.equal((await mgrCross.json()).error, 'account_scope_denied');

  step('an invalid key is rejected by the guard (401) — dev bypass is off');
  const noKey = await getTicket(port, ticket.id, 'awb_not_a_real_key');
  assert.equal(noKey.status, 401, 'unknown key is unauthorized');
});

exitAfterTests(0);
