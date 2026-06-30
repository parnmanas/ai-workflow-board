// Regression — security finding (authz): the legacy /api/agent/* surface never
// enforced workspace scoping, so a workspace-scoped API key could read/mutate
// tickets, boards and chat in ANY workspace (cross-workspace IDOR). The fix
// stamps request.currentWorkspaceId from the presented DB key and rejects a
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

import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createBoard,
  createColumn,
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
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT || '7866', 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  // Two isolated workspaces; the target ticket lives in ws_a.
  const wsA = await createWorkspace(app, getDataSourceToken, 'scope-a');
  const wsB = await createWorkspace(app, getDataSourceToken, 'scope-b');
  const board = await createBoard(app, getDataSourceToken, wsA.id, { name: 'a-board' });
  const col = await createColumn(app, getDataSourceToken, board.id, {
    name: 'To Do', position: 0, workspaceId: wsA.id,
  });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: wsA.id, title: 'secret ticket',
  });

  const keyA = await createApiKey(app, getDataSourceToken, null, { workspaceId: wsA.id, label: 'a' });
  const keyB = await createApiKey(app, getDataSourceToken, null, { workspaceId: wsB.id, label: 'b' });
  // workspaceId '' → guard resolves scope to null → full-scope (env/admin/manager).
  const keyGlobal = await createApiKey(app, getDataSourceToken, null, { workspaceId: '', label: 'global' });

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
  // workspace, but the manager supervises children across ALL workspaces and
  // fetches their tickets/chat over /api/agent/*. Once AgentApiController added
  // workspace-scope guards, that scoped key 403'd every cross-workspace fetch.
  // AgentAuthGuard now treats a manager-owned key as full-scope, matching the
  // "workspace-less manager keys" invariant the IDOR fix documents.
  step('a manager-owned key scoped to a DIFFERENT workspace still reads cross-workspace (200)');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'mgr', type: 'manager',
  });
  // Scoped to wsB on the row, but owned by a manager → guard resolves full-scope.
  const keyManager = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: wsB.id, label: 'mgr',
  });
  const mgrCross = await getTicket(port, ticket.id, keyManager.raw_key);
  assert.equal(mgrCross.status, 200, 'manager key must reach across workspaces');
  const mgrBody = await mgrCross.json();
  assert.equal(mgrBody.id, ticket.id, 'returns the cross-workspace ticket payload');

  step('an invalid key is rejected by the guard (401) — dev bypass is off');
  const noKey = await getTicket(port, ticket.id, 'awb_not_a_real_key');
  assert.equal(noKey.status, 401, 'unknown key is unauthorized');
});

exitAfterTests(0);
