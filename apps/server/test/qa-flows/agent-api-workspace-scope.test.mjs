// Regression — security finding (authz): the legacy /api/agent/* surface never
// enforced workspace scoping, so a account-scoped API key could read/mutate
// tickets and chat in ANY workspace (cross-workspace IDOR). The fix
// stamps request.currentAccountId from the presented DB key and rejects a
// scoped key whose workspace doesn't match the target resource.
//
// This flow drives the REST endpoints directly with `fetch`. Crucially it
// disables AGENT_DEV_MODE before boot — the dev bypass sets scope=null (full
// scope) on every request, which would mask the very check we're verifying.
import test from 'node:test';
import assert from 'node:assert/strict';

// MUST run before bootApp reads the env. With AGENT_DEV_MODE off, AgentAuthGuard
// validates the X-Agent-Key for real and derives the workspace scope from it.
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

test('agent-api enforces workspace scoping on the legacy /api/agent surface', async (t) => {
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
  // accountId '' → guard resolves scope to null → full-scope (env/admin/manager).
  const keyGlobal = await createApiKey(app, getDataSourceToken, null, { accountId: '', label: 'global' });

  step('a key scoped to the ticket\'s own workspace can read it (200)');
  const sameWs = await getTicket(port, ticket.id, keyA.raw_key);
  assert.equal(sameWs.status, 200, 'same-workspace key must be allowed');
  const body = await sameWs.json();
  assert.equal(body.id, ticket.id, 'returns the ticket payload');

  step('a key scoped to a DIFFERENT workspace is rejected (403) — the IDOR fix');
  const crossWs = await getTicket(port, ticket.id, keyB.raw_key);
  assert.equal(crossWs.status, 403, 'cross-workspace key must be denied');
  const err = await crossWs.json();
  assert.equal(err.error, 'workspace_scope_denied', 'returns the scope-denied error code');

  step('a full-scope (workspace-less) key still works — env/admin/manager keys unaffected');
  const globalRead = await getTicket(port, ticket.id, keyGlobal.raw_key);
  assert.equal(globalRead.status, 200, 'null-scope key keeps full access');

  // Regression — daemon "Ticket/Chat history/fallback POST 403" (ticket
  // 2f13e3d7): pair/redeem mints the manager's key scoped to its pairing
  // workspace, but the manager supervises children across ALL accounts and
  // fetches their tickets/chat over /api/agent/*. Once AgentApiController added
  // account-scope guards, that scoped key 403'd every cross-workspace fetch.
  // AgentAuthGuard now treats a manager-owned key as full-scope, matching the
  // "workspace-less manager keys" invariant the IDOR fix documents.
  step('a manager-owned key scoped to a DIFFERENT workspace still reads cross-workspace (200)');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'mgr', type: 'manager',
  });
  // Scoped to wsB on the row, but owned by a manager → guard resolves full-scope.
  // P4c-4: manager 판정은 host 바인딩만 본다 — agent_id 만으로는 부족하다.
  const keyManager = await createApiKey(app, getDataSourceToken, manager.id, {
    accountId: wsB.id, label: 'mgr', hostId: manager.id,
  });
  const mgrCross = await getTicket(port, ticket.id, keyManager.raw_key);
  assert.equal(mgrCross.status, 200, 'manager key must reach across accounts');
  const mgrBody = await mgrCross.json();
  assert.equal(mgrBody.id, ticket.id, 'returns the cross-workspace ticket payload');

  step('an invalid key is rejected by the guard (401) — dev bypass is off');
  const noKey = await getTicket(port, ticket.id, 'awb_not_a_real_key');
  assert.equal(noKey.status, 401, 'unknown key is unauthorized');
});

exitAfterTests(0);
