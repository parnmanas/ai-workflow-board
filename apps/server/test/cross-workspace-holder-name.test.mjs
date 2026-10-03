// Regression: an agent assigned to a ticket in ANOTHER workspace must resolve
// to its canonical display name on both role-holder read paths — never a bare
// leaf name (ticket 0cccf9b5).
//
// P4c-4: linked uuid → Host bare name; unresolvable uuid → id-prefix fallback
// (holder 유지가 우선). Both resolvers run resolveAgentDisplayMap (id-only
// lookup, no workspace filter), matching the MCP get_ticket path
// (hydrateRoleAssignments).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from './helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createApiKey,
  createUser,
  setupKanbanScene,
  createTicket,
  addRoleHolder,
} from './helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const BASE_PORT = parseInt(process.env.QA_XWS_HOLDER_NAME_PORT || '0', 10);
process.env.PORT = String(BASE_PORT);

test('cross-workspace assigned agent → <Manager>/<Agent>, never a raw id', async (t) => {
  const { app, modules } = await bootApp({ port: BASE_PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const { TicketRoleAssignmentService } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'workspace-roles', 'ticket-role-assignment.service.js')
  );
  const svc = app.get(TicketRoleAssignmentService);

  // Board + columns live in WS_BOARD; the assigned agent lives in a DISTINCT
  // workspace (WS_AGENT) — the exact shape the client's workspace-filtered
  // /api/agents list cannot resolve.
  const { ws: wsBoard, board, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'xws-board' });
  const wsAgent = await createWorkspace(app, getDataSourceToken, 'xws-agent');

  // P4c-4: managed→manager 연결은 api_keys 페어링 링크다 (Agent 행 없음).
  // linked uuid 는 Host bare name 으로 해소된다 (runbook agent-display-name P4c-4 단서).
  const manager = await createAgent(app, getDataSourceToken, wsAgent.id, { name: 'MgrX', type: 'manager' });
  const managed = await createAgent(app, getDataSourceToken, wsAgent.id, { name: 'CoderX' });
  await createApiKey(app, getDataSourceToken, managed.id, { workspaceId: wsAgent.id, hostId: manager.id, label: 'xws-link' });
  const expectedManagedDisplay = manager.name;

  // Same-workspace, unmanaged agent as a second assignee holder → no regression:
  // must still resolve to its bare name (no manager prefix, no crash).
  const localAgent = await createAgent(app, getDataSourceToken, wsBoard.id, { name: 'LocalY' });

  // A user holder (reporter) → must still resolve to name/email.
  const user = await createUser(app, getDataSourceToken, { name: 'UserZ' });

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: wsBoard.id,
    title: 'cross-ws holder name',
    assigneeId: managed.id,          // cross-workspace managed agent (first assignee holder)
    reporterId: '',
  });
  // Second assignee holder (same-workspace, unmanaged) via the multi-holder path.
  await addRoleHolder(app, getDataSourceToken, {
    ticketId: ticket.id, workspaceId: wsBoard.id, agentId: localAgent.id, slug: 'assignee',
  });
  // User holder on reporter.
  const reporterRole = await ds.getRepository('WorkspaceRole').findOne({
    where: { workspace_id: wsBoard.id, slug: 'reporter' },
  });
  await ds.getRepository('TicketRoleAssignment').save(
    ds.getRepository('TicketRoleAssignment').create({
      ticket_id: ticket.id, role_id: reporterRole.id, agent_id: null, user_id: user.id, holder_key: `user:${user.id}`,
    }),
  );

  // ── Path 1: resolveForTicket (REST /tickets/:id/role-assignments) ──────────
  await step('resolveForTicket returns canonical names', async () => {
    const resolved = await svc.resolveForTicket(ticket.id);
    const byId = new Map(resolved.filter(r => r.holder).map(r => [r.holder.id, r.holder]));

    const managedHolder = byId.get(managed.id);
    assert.ok(managedHolder, 'cross-workspace managed agent must appear as a holder');
    assert.equal(managedHolder.name, expectedManagedDisplay,
      `cross-ws managed holder must be "${expectedManagedDisplay}", got "${managedHolder.name}"`);
    assert.notEqual(managedHolder.name, managed.id, 'must NOT leak the raw agent id');
    assert.ok(!managedHolder.name.includes('/'), 'linked display is the bare Host name');

    const localHolder = byId.get(localAgent.id);
    assert.ok(localHolder, 'same-workspace agent holder must appear');
    // P4c-4: 어디에도 해소되지 않는 uuid 는 id 앞 8자리 폴백 (holder 유지가 우선).
    assert.equal(localHolder.name, localAgent.id.slice(0, 8), 'unresolvable holder falls back to the id prefix');

    const userHolder = byId.get(user.id);
    assert.ok(userHolder, 'user holder must appear');
    assert.equal(userHolder.type, 'user');
    assert.equal(userHolder.name, user.name || user.email, 'user holder resolves to name/email');
  });

  // ── Path 2: resolveGroupedForTickets (board-card role_holders projection) ──
  await step('resolveGroupedForTickets returns canonical names', async () => {
    const map = await svc.resolveGroupedForTickets([ticket.id]);
    const groups = map.get(ticket.id) || [];
    const assignee = groups.find(g => g.role.slug === 'assignee');
    assert.ok(assignee, 'assignee role group must be present');
    const names = new Map(assignee.holders.map(h => [h.id, h.name]));
    assert.equal(names.get(managed.id), expectedManagedDisplay,
      `board-card cross-ws holder must be "${expectedManagedDisplay}", got "${names.get(managed.id)}"`);
    assert.notEqual(names.get(managed.id), managed.id, 'board card must NOT leak the raw agent id');
    assert.equal(names.get(localAgent.id), localAgent.id.slice(0, 8), 'board-card unresolvable holder falls back to the id prefix');
  });

  // The REST surfaces pass the resolver output through verbatim
  // (tickets.controller `holder: r.holder`; boards.controller
  // `holders: g.holders`), so the two service assertions above cover the wire
  // shape the TicketPanel + board card consume. The endpoints sit behind
  // AuthGuard (user session) — deliberately not re-plumbed here since the
  // resolver, not the controller, is what this fix changed.
});

exitAfterTests();
