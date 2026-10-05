// Regression: a ticket's assignee whose Runtime Host is registered in ANOTHER
// workspace must still render as its canonical `<Host>/<label>` display on
// every ticket read path — never a bare label or a raw host id (ticket
// 0cccf9b5, originally about role holders).
//
// Role holders are gone with the board model (docs/tickets.md): a ticket has
// one assignee, a RuntimeSpec whose `manager_agent_id` names the Runtime Host.
// The property survives unchanged — Runtime Hosts carry a `account_id`, so
// the client's workspace-filtered host list cannot name a host paired in a
// different workspace, and the server must resolve it by id with NO workspace
// filter. Both projections do that independently, so both are covered:
//
//   1. Full ticket (GET /tickets/:id → loadTicketFull — also MCP get_ticket).
//   2. Ticket cards (GET /accounts/:wsId/tickets → TicketService.cards).
//
// A spec whose host no longer exists falls back to the spec's label — still
// never the raw id (docs/runbooks/agent-display-name.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import {
  createAccount,
  createAgent,
  createUser,
  createTicket,
} from './helpers/fixtures.mjs';

const BASE_PORT = parseInt(process.env.QA_XWS_HOLDER_NAME_PORT || '0', 10);

test('cross-workspace assignee host → <Host>/<label>, never a raw id', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { AuthService } = await import('../dist/services/auth.service.js');

  // The ticket lives in WS_TICKETS; the assignee's Runtime Host is registered
  // in a DISTINCT workspace (WS_HOST) — the exact shape a workspace-filtered
  // host list cannot resolve.
  const wsTickets = await createAccount(app, getDataSourceToken, 'xws-tickets');
  const wsHost = await createAccount(app, getDataSourceToken, 'xws-host');

  const crossAgent = await createAgent(app, getDataSourceToken, wsHost.id, { name: 'CoderX', runtime: true });
  const crossSpec = { ...crossAgent.runtime_spec, label: 'CoderX' };
  const crossHost = await ds.getRepository('RuntimeHost').findOneBy({ id: crossSpec.manager_agent_id });
  assert.equal(crossHost.account_id, wsHost.id, 'precondition: the host belongs to the OTHER workspace');
  const expectedCross = `${crossHost.name}/CoderX`;

  // Same-workspace assignee → no regression.
  const localAgent = await createAgent(app, getDataSourceToken, wsTickets.id, { name: 'LocalY', runtime: true });
  const localSpec = { ...localAgent.runtime_spec, label: 'LocalY' };
  const expectedLocal = `${localAgent.name}/LocalY`;

  // Host that no longer exists → falls back to the spec label, not the id.
  const orphanSpec = { ...localAgent.runtime_spec, manager_agent_id: randomUUID(), working_dir: '/tmp/qa/orphan', label: 'OrphanZ' };

  // backlog: never dispatched, so the fixture rows stay exactly as written.
  const make = (title, assignee) => createTicket(app, getDataSourceToken, {
    accountId: wsTickets.id, title, status: 'backlog', assignee,
  });
  const crossTicket = await make('cross-ws assignee', crossSpec);
  const localTicket = await make('local assignee', localSpec);
  const orphanTicket = await make('orphan assignee', orphanSpec);

  const admin = await createUser(app, getDataSourceToken, { name: 'admin', role: 'admin' });
  const token = app.get(AuthService).createSession(admin.id);
  const api = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Account-Id': wsTickets.id },
    });
    const body = await res.json().catch(() => null);
    assert.equal(res.status, 200, `GET ${path} → ${res.status} ${JSON.stringify(body)}`);
    return body;
  };

  // ── Path 1: full ticket (TicketPanel, MCP get_ticket) ─────────────────────
  await t.test('GET /tickets/:id returns the canonical assignee_name', async () => {
    const cross = await api(`/tickets/${crossTicket.id}`);
    assert.equal(cross.assignee_name, expectedCross,
      `cross-ws assignee must be "${expectedCross}", got "${cross.assignee_name}"`);
    assert.ok(!cross.assignee_name.includes(crossSpec.manager_agent_id), 'must NOT leak the raw host id');

    const local = await api(`/tickets/${localTicket.id}`);
    assert.equal(local.assignee_name, expectedLocal, 'same-workspace assignee resolves the same way');

    const orphan = await api(`/tickets/${orphanTicket.id}`);
    assert.equal(orphan.assignee_name, 'OrphanZ', 'unresolvable host falls back to the spec label');
  });

  // ── Path 2: ticket cards (Tickets page list) ──────────────────────────────
  await t.test('GET /accounts/:wsId/tickets cards return the canonical assignee_name', async () => {
    const { tickets } = await api(`/accounts/${wsTickets.id}/tickets`);
    const names = new Map(tickets.map((c) => [c.id, c.assignee_name]));
    assert.equal(names.get(crossTicket.id), expectedCross,
      `card cross-ws assignee must be "${expectedCross}", got "${names.get(crossTicket.id)}"`);
    assert.equal(names.get(localTicket.id), expectedLocal, 'card same-workspace assignee');
    assert.equal(names.get(orphanTicket.id), 'OrphanZ', 'card unresolvable host falls back to the spec label');
  });
});

exitAfterTests();
