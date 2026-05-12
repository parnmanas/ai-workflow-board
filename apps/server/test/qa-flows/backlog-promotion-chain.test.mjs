// QA flow: BacklogPromotion chain-target sort prefix (ticket 8b3fa67e).
//
// What this proves
// ────────────────
//
// `BacklogPromotionService.tryPromote` sorts intake candidates by
//   [chain_target ASC, priority_index ASC, created_at ASC]
//
// The chain_target prefix is the v0.42 fix: an `A.next_ticket_id = B`
// chain where A has reached terminal but B is still in intake must
// promote B before any unrelated higher-priority candidate.  Without
// the prefix the legacy `(priority_index, created_at)` sort picks the
// critical-priority outsider, and the `_dispatchNextTicket` path can't
// compensate because B is still in an intake column routed to
// `reporter`, not the column the trio holders react to.
//
// We cover the three acceptance cases verbatim:
//
//   1. Chain wins over higher-priority outsider.
//      Parent A (high, terminal) → child B (low, intake), plus C
//      (critical, intake).  tryPromote → B.  Subsequent tryPromote
//      with B gone → C (the critical outsider is just delayed, not
//      starved).
//   2. No-chain regression.
//      Independent C (critical, intake) + D (medium, intake), no
//      next_ticket_id links anywhere.  tryPromote → C (matches the
//      pre-fix priority/created_at ordering exactly).
//   3. Multiple chain targets — priority preserved among them.
//      Two parents in terminal point at two intake children B1
//      (medium) + B2 (low).  Both are chain targets, so the prefix
//      ties; priority_index breaks the tie → B1 wins, B2 next cycle.
//
// We also assert the `backlog_promoted` activity row carries the
// `chain_target=true|false` token in `new_value` so dashboards /
// post-mortems can filter chain promotions from priority ones.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createApiKey,
  createColumn,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_BACKLOG_CHAIN_PORT || '7821';

test('BacklogPromotion chain prefix: chain target beats higher-priority outsider, audit row tagged, no-chain regression intact', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;

  const backlogPromotionServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'backlog-promotion.service.js')
  );
  const backlogPromotion = app.get(backlogPromotionServiceModule.BacklogPromotionService);
  const ds = app.get(getDataSourceToken());

  // ── Shared workspace + roles + driver user ──────────────────────────
  step('Seed workspace + assignee/reporter/reviewer roles + driver user');
  const ws = await createWorkspace(app, getDataSourceToken, 'chain');
  await createUser(app, getDataSourceToken, { name: 'driver' });

  const roleRepo = ds.getRepository('WorkspaceRole');
  const assigneeRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'assignee' } });
  const reporterRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'reporter' } });
  assert.ok(assigneeRole, 'createWorkspace should seed assignee role');
  assert.ok(reporterRole, 'createWorkspace should seed reporter role');

  // One agent holding all the assignee assignments — capacity is irrelevant
  // for this test (no other active tasks), so a single holder keeps the
  // eligibility check terse.  Reporter intake routing has no holder; that's
  // fine, BacklogPromotion only checks the *destination* role's holder.
  const aliceAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
  await createApiKey(app, getDataSourceToken, aliceAgent.id, { workspaceId: ws.id, label: 'alice' });

  const boardRepo = ds.getRepository('Board');
  const colRepo = ds.getRepository('BoardColumn');
  const ticketRepo = ds.getRepository('Ticket');
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  const activityLogRepo = ds.getRepository('ActivityLog');

  // Helper: full board + columns + intake/active/terminal kinds.
  async function makeBoard(name) {
    const board = await boardRepo.save(boardRepo.create({
      name, description: '', workspace_id: ws.id,
      routing_config: JSON.stringify({}),
      max_concurrent_tickets_per_agent: 1,
    }));
    const backlog = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Backlog', position: 0, workspaceId: ws.id,
    });
    const todo = await createColumn(app, getDataSourceToken, board.id, {
      name: 'To Do', position: 1, workspaceId: ws.id,
    });
    const done = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Done', position: 2, workspaceId: ws.id, isTerminal: true,
    });
    await colRepo.update(backlog.id, { kind: 'intake', role_routing: JSON.stringify(['reporter']) });
    await colRepo.update(todo.id, { kind: 'active', role_routing: JSON.stringify(['assignee']) });
    await colRepo.update(done.id, { kind: 'terminal', role_routing: JSON.stringify([]) });
    return { board, backlog, todo, done };
  }

  // createTicket already wires a TicketRoleAssignment for assigneeId via
  // its workspaceId path, so the fixtures below don't need an extra
  // `assignRepo.save(...)` call. The promotion eligibility check resolves
  // holders from those rows.

  // Audit-row reader: parses `chain_target=...` out of the new_value token
  // string. We keep this assertion-local rather than exporting a helper so
  // the contract is explicit at the call site.
  async function readPromotionAudit(ticketId) {
    const rows = await activityLogRepo.find({ where: { ticket_id: ticketId, action: 'backlog_promoted' } });
    return rows.map((r) => {
      const m = /chain_target=(true|false)/.exec(r.new_value || '');
      return { row: r, chain_target: m ? m[1] === 'true' : null };
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Case 1: chain target wins over higher-priority outsider
  // ────────────────────────────────────────────────────────────────────
  step('Case 1 — chain target B (low) beats outsider C (critical) when A→B chain exists');
  const c1 = await makeBoard('chain-case1');

  // A — landed in terminal already, parent of the chain.
  const tA = await createTicket(app, getDataSourceToken, {
    columnId: c1.done.id, workspaceId: ws.id, title: 'A-terminal-parent', priority: 'high',
    assigneeId: aliceAgent.id,
  });
  // B — chain target, low priority, sitting in backlog.
  const tB = await createTicket(app, getDataSourceToken, {
    columnId: c1.backlog.id, workspaceId: ws.id, title: 'B-chain-low', priority: 'low',
    assigneeId: aliceAgent.id,
  });
  // C — outsider, critical, sitting in backlog. Higher priority than B
  // but NOT a chain target, so it must lose to B.
  const tC = await createTicket(app, getDataSourceToken, {
    columnId: c1.backlog.id, workspaceId: ws.id, title: 'C-outsider-critical', priority: 'critical',
    assigneeId: aliceAgent.id,
  });
  // Link the chain. We bypass `Ticket` decorators by going through repo.update.
  await ticketRepo.update(tA.id, { next_ticket_id: tB.id });

  step('  call tryPromote — expect B (chain target) to be promoted, not C');
  const promoted1 = await backlogPromotion.tryPromote(c1.board.id);
  assert.equal(promoted1, tB.id,
    `expected chain target B (${tB.id.slice(0, 8)}) to win over critical outsider C (${tC.id.slice(0, 8)}), got ${promoted1?.slice(0, 8) || 'null'}`);

  step('  audit row for B has chain_target=true');
  const auditB = await readPromotionAudit(tB.id);
  assert.equal(auditB.length, 1, `expected exactly one backlog_promoted row for B (got ${auditB.length})`);
  assert.equal(auditB[0].chain_target, true,
    `B's audit row must record chain_target=true (new_value=${auditB[0].row.new_value})`);

  step('  next tryPromote cycle picks the critical outsider C');
  // B has been promoted into the active `To Do` column. In real flow B
  // would then be worked on and reach `done`, freeing alice's workflow
  // load. We simulate that terminal landing here — without it, the
  // workflow-state cap (board.max_concurrent_tickets_per_agent=1, landed
  // on main via ticket #A) would block C because alice already holds B
  // on a non-terminal/non-intake column. This ticket explicitly lists
  // that cap interaction under Non-Goals; the chain-prefix contract
  // being tested is independent of capacity gating.
  await ticketRepo.update(tB.id, { column_id: c1.done.id });
  const promoted1b = await backlogPromotion.tryPromote(c1.board.id);
  assert.equal(promoted1b, tC.id,
    'after B leaves intake the critical outsider C must promote next (no starvation)');
  const auditC = await readPromotionAudit(tC.id);
  assert.equal(auditC.length, 1, 'C should have exactly one backlog_promoted row');
  assert.equal(auditC[0].chain_target, false,
    `C's audit row must record chain_target=false (new_value=${auditC[0].row.new_value})`);

  // ────────────────────────────────────────────────────────────────────
  // Case 2: no-chain regression — priority/created_at order intact
  // ────────────────────────────────────────────────────────────────────
  step('Case 2 — no chain, critical + medium → critical promotes (no regression vs. pre-fix order)');
  const c2 = await makeBoard('chain-case2');
  // Create medium FIRST so created_at < critical's created_at — guarantees
  // that if priority ever stopped being the primary key, the medium would
  // (incorrectly) win on the older timestamp.
  const tD = await createTicket(app, getDataSourceToken, {
    columnId: c2.backlog.id, workspaceId: ws.id, title: 'D-medium-older', priority: 'medium',
    assigneeId: aliceAgent.id,
  });
  // Force a measurable created_at gap. Without this, sqlite's millisecond
  // timestamps can collide and the sort fall-through becomes ambiguous.
  await new Promise((r) => setTimeout(r, 10));
  const tCC = await createTicket(app, getDataSourceToken, {
    columnId: c2.backlog.id, workspaceId: ws.id, title: 'C2-critical-newer', priority: 'critical',
    assigneeId: aliceAgent.id,
  });

  const promoted2 = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(promoted2, tCC.id,
    `no-chain board must promote critical (${tCC.id.slice(0, 8)}) before medium (${tD.id.slice(0, 8)})`);
  const audit2 = await readPromotionAudit(tCC.id);
  assert.equal(audit2[0]?.chain_target, false,
    `no-chain promotion must record chain_target=false (got ${audit2[0]?.chain_target})`);

  // ────────────────────────────────────────────────────────────────────
  // Case 3: multiple chain targets — priority breaks the tie
  // ────────────────────────────────────────────────────────────────────
  step('Case 3 — two chain targets B1 (medium) + B2 (low); priority tiebreaks → B1 first');
  const c3 = await makeBoard('chain-case3');
  // Parents — both in terminal so they don't compete for promotion themselves.
  const tA1 = await createTicket(app, getDataSourceToken, {
    columnId: c3.done.id, workspaceId: ws.id, title: 'A1-parent-1', priority: 'high',
    assigneeId: aliceAgent.id,
  });
  const tA2 = await createTicket(app, getDataSourceToken, {
    columnId: c3.done.id, workspaceId: ws.id, title: 'A2-parent-2', priority: 'high',
    assigneeId: aliceAgent.id,
  });
  // Children — both chain targets, but different priority.
  const tB1 = await createTicket(app, getDataSourceToken, {
    columnId: c3.backlog.id, workspaceId: ws.id, title: 'B1-chain-medium', priority: 'medium',
    assigneeId: aliceAgent.id,
  });
  const tB2 = await createTicket(app, getDataSourceToken, {
    columnId: c3.backlog.id, workspaceId: ws.id, title: 'B2-chain-low', priority: 'low',
    assigneeId: aliceAgent.id,
  });
  await ticketRepo.update(tA1.id, { next_ticket_id: tB1.id });
  await ticketRepo.update(tA2.id, { next_ticket_id: tB2.id });

  const promoted3a = await backlogPromotion.tryPromote(c3.board.id);
  assert.equal(promoted3a, tB1.id,
    `among chain targets, higher priority (B1 medium) must beat lower (B2 low); got ${promoted3a?.slice(0, 8)}`);
  // Drain B1 to terminal before the second cycle — same reason as case 1:
  // the workflow-state cap (cap=1) would otherwise block B2 because alice
  // already holds B1 in `To Do`. Independent of the chain-prefix contract.
  await ticketRepo.update(tB1.id, { column_id: c3.done.id });
  const promoted3b = await backlogPromotion.tryPromote(c3.board.id);
  assert.equal(promoted3b, tB2.id,
    'after B1 leaves intake, B2 (still a chain target) should promote next');

  // Both audit rows should carry chain_target=true.
  const audit3 = [
    ...(await readPromotionAudit(tB1.id)),
    ...(await readPromotionAudit(tB2.id)),
  ];
  for (const a of audit3) {
    assert.equal(a.chain_target, true,
      `multi-chain audit row must record chain_target=true (new_value=${a.row.new_value})`);
  }

  // Print the audit evidence so the test log reads as documentation.
  step('Audit-log evidence — backlog_promoted rows with chain_target token');
  const promotedRows = await activityLogRepo.find({ where: { action: 'backlog_promoted' } });
  for (const r of promotedRows) {
    console.log(`  ticket=${r.ticket_id.slice(0, 8)}  ${r.new_value || ''}`);
  }

  exitAfterTests(0);
});
