// Regression: the normalized `ticket_role_assignments` table is the single
// source of truth for a ticket's assignee/reporter/reviewer, and the flat
// legacy `tickets.assignee(_id)` / `reporter(_id)` / `reviewer_id` columns are
// a materialized projection of it that must NEVER diverge (ticket da39d1da).
//
// Root cause the fix addresses: board `default_role_assignments` and the
// generalized `role_assignments[]` create path wrote ONLY the assignment table.
// The board, MCP `get_board_summary` (`assignee: t.assignee || 'unassigned'`),
// and MCP `get_my_tickets` (whose SQL WHERE FILTERS on `assignee_id`) all read
// the flat columns — so a ticket assigned purely via those paths showed as
// "unassigned" and was excluded from its own assignee's ticket list, which read
// as dispatch loss even though the trigger loop (normalized-table reader) fired
// correctly.
//
// The fix makes every builtin-role write in TicketRoleAssignmentService mirror
// the FIRST holder back to the flat columns, and a migration
// (1760000000051-BackfillTicketFlatAssigneeFromRoleAssignments) heals rows that
// diverged before it shipped. This test drives the service write helpers and
// the migration directly and asserts flat ↔ normalized parity on every path.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from './helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createUser,
  createTicket,
} from './helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const BASE_PORT = parseInt(process.env.QA_ASSIGNEE_SOT_PORT || '7873', 10);
process.env.PORT = String(BASE_PORT);

test('role_assignments is SoT — flat assignee columns stay in lockstep (write-back + backfill)', async (t) => {
  const { app, modules } = await bootApp({ port: BASE_PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const ticketRepo = ds.getRepository('Ticket');
  const roleRepo = ds.getRepository('WorkspaceRole');
  const assignRepo = ds.getRepository('TicketRoleAssignment');

  const { TicketRoleAssignmentService } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'workspace-roles', 'ticket-role-assignment.service.js')
  );
  const svc = app.get(TicketRoleAssignmentService);

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'assignee-sot' });

  const agentA = await createAgent(app, getDataSourceToken, ws.id, { name: 'AgentA' });
  const agentB = await createAgent(app, getDataSourceToken, ws.id, { name: 'AgentB' });
  const manager = await createAgent(app, getDataSourceToken, ws.id, { name: 'Mgr', type: 'manager' });
  const managed = await createAgent(app, getDataSourceToken, ws.id, { name: 'Coder' });
  await ds.getRepository('Agent').update({ id: managed.id }, { manager_agent_id: manager.id });
  const user = await createUser(app, getDataSourceToken, { name: 'Human Z' });

  const assigneeRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'assignee' } });
  const reporterRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'reporter' } });
  const reviewerRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'reviewer' } });
  assert.ok(assigneeRole && reporterRole && reviewerRole, 'builtin roles seeded on the workspace');

  const freshTicket = (title) => createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title,
  });
  const reload = (id) => ticketRepo.findOne({ where: { id } });

  // ── 1. Board default assignment — the reported bug ─────────────────────────
  await step('applyBoardDefaults backfills the flat assignee columns', async () => {
    const ticket = await freshTicket('board-default');
    assert.equal((await reload(ticket.id)).assignee_id, '', 'precondition: flat assignee_id empty');

    await svc.applyBoardDefaults(ticket.id, ws.id, { assignee: [{ agent_id: agentA.id }] });

    const after = await reload(ticket.id);
    assert.equal(after.assignee_id, agentA.id, 'flat assignee_id backfilled from board default');
    assert.equal(after.assignee, 'AgentA', 'flat assignee display name backfilled');

    // Parity with the normalized source of truth.
    const holder = await svc.getHolderBySlug(ticket.id, ws.id, 'assignee');
    assert.equal(holder.agent_id, agentA.id, 'role_assignments holds the same agent');

    // get_board_summary reads `t.assignee || 'unassigned'` — now non-empty.
    assert.notEqual(after.assignee || 'unassigned', 'unassigned', 'summary no longer reads unassigned');

    // get_my_tickets FILTERS its WHERE on assignee_id — the ticket is now
    // selectable by its own assignee (the dispatch-loss red herring).
    const visible = await ticketRepo.findOne({ where: { id: ticket.id, assignee_id: agentA.id } });
    assert.ok(visible, 'ticket is selectable by the get_my_tickets assignee_id filter');
  });

  // ── 2. Role change via setHolder ───────────────────────────────────────────
  await step('setHolder change re-projects the flat columns', async () => {
    const ticket = await freshTicket('role-change');
    await svc.setHolder(ticket.id, assigneeRole.id, { agent_id: agentA.id });
    assert.equal((await reload(ticket.id)).assignee_id, agentA.id);
    await svc.setHolder(ticket.id, assigneeRole.id, { agent_id: agentB.id });
    const after = await reload(ticket.id);
    assert.equal(after.assignee_id, agentB.id, 'flat id follows the reassignment');
    assert.equal(after.assignee, 'AgentB', 'flat name follows the reassignment');
  });

  // ── 3. Clearing the role blanks the flat columns ───────────────────────────
  await step('setHolder clear blanks the flat columns', async () => {
    const ticket = await freshTicket('clear');
    await svc.setHolder(ticket.id, assigneeRole.id, { agent_id: agentA.id });
    await svc.setHolder(ticket.id, assigneeRole.id, { agent_id: null, user_id: null });
    const after = await reload(ticket.id);
    assert.equal(after.assignee_id, '', 'flat id cleared');
    assert.equal(after.assignee, '', 'flat name cleared');
  });

  // ── 4. Multi-holder — flat mirrors the FIRST (earliest-created) holder ──────
  await step('multi-holder flat column tracks the first holder', async () => {
    const ticket = await freshTicket('multi-holder');
    await svc.setHolder(ticket.id, assigneeRole.id, { agent_id: agentA.id }); // first holder
    await svc.addHolder(ticket.id, assigneeRole.id, { agent_id: agentB.id }); // co-holder
    assert.equal((await reload(ticket.id)).assignee_id, agentA.id, 'flat mirrors earliest-created holder');
    // Removing the first holder promotes the co-holder into the flat column.
    await svc.removeHolder(ticket.id, assigneeRole.id, { agent_id: agentA.id });
    assert.equal((await reload(ticket.id)).assignee_id, agentB.id, 'flat promotes the new first holder');
  });

  // ── 5. Holder display — managed agent + user ───────────────────────────────
  await step('managed-agent and user holders resolve their canonical display', async () => {
    const ticket = await freshTicket('display');
    await svc.setHolder(ticket.id, assigneeRole.id, { agent_id: managed.id });
    assert.equal((await reload(ticket.id)).assignee, 'Mgr/Coder', 'managed agent → <Manager>/<Agent>');
    await svc.setHolder(ticket.id, reporterRole.id, { user_id: user.id });
    const after = await reload(ticket.id);
    assert.equal(after.reporter_id, user.id, 'reporter_id mirrors the user holder');
    assert.equal(after.reporter, user.name, 'reporter name → user name/email');
  });

  // ── 6. reviewer slug mirrors id only (no display-name column) ───────────────
  await step('reviewer slug mirrors id only', async () => {
    const ticket = await freshTicket('reviewer');
    await svc.setHolder(ticket.id, reviewerRole.id, { agent_id: agentA.id });
    assert.equal((await reload(ticket.id)).reviewer_id, agentA.id, 'reviewer_id mirrored');
  });

  // ── 7. Migration heals rows that diverged BEFORE the write-back fix ─────────
  await step('migration backfills flat columns from role_assignments', async () => {
    // Reproduce the pre-fix divergence: an assignment row present while the flat
    // columns stay empty (a board-default / role_assignments[] create path that
    // bypassed the flat columns). Insert straight into the assignment repo so
    // the service write-back does NOT run.
    const ticket = await freshTicket('diverged');
    await assignRepo.save(assignRepo.create({
      ticket_id: ticket.id, role_id: assigneeRole.id, agent_id: agentA.id, user_id: null,
      holder_key: `agent:${agentA.id}`,
    }));
    assert.equal((await reload(ticket.id)).assignee_id, '', 'precondition: divergence — flat empty, assignment present');

    const { BackfillTicketFlatAssigneeFromRoleAssignments1760000000051 } = await import(
      'file://' + path.join(DIST_ROOT, 'database', 'migrations', '1760000000051-BackfillTicketFlatAssigneeFromRoleAssignments.js')
    );
    const qr = ds.createQueryRunner();
    try {
      await new BackfillTicketFlatAssigneeFromRoleAssignments1760000000051().up(qr);
    } finally {
      await qr.release();
    }

    const after = await reload(ticket.id);
    assert.equal(after.assignee_id, agentA.id, 'migration backfilled flat assignee_id from the assignment row');
    assert.equal(after.assignee, 'AgentA', 'migration backfilled the flat display name');
  });
});

exitAfterTests();
