// QA flow: workflow-state per-agent cap (ticket e79eef92).
//
// What this proves
// ────────────────
//
// `BacklogPromotionService.tryPromote` gates on workflow state, not on
// `AgentStatusService.active_tasks` (i.e. "is the subagent process
// alive right now"). A ticket parked on a non-terminal & non-intake
// column counts as workflow load for its assignee, even if no subagent
// process is currently running on it.
//
// We cover the four acceptance cases verbatim from the ticket:
//
//   1. Reproducer — cap=1, agent A has one ticket parked in In Progress
//      and 5 fresh backlog tickets (all assigned to A). `tryPromote`
//      must return null. Moving the In Progress ticket to Merging
//      (kind=merging, still non-terminal & non-intake) → still null.
//      Moving it to Done (terminal) → one of the backlog tickets
//      promotes.
//
//   2. WAIT-only turn — agent A cycles setCurrentTask → comment →
//      clearCurrentTask without moving any ticket. The pre-fix cap
//      check would re-open on clearCurrentTask and promote another
//      ticket. With workflow-state the cap doesn't move because the
//      In Progress ticket is still parked there. Verify by running the
//      cycle and re-calling tryPromote → null.
//
//   3. Cross-board independence — same agent has a ticket parked on
//      Board X's In Progress, but Board Y is empty for that agent.
//      Board Y's tryPromote with 1 backlog ticket assigned to A
//      promotes successfully (cap is per-board).
//
//   4. Audit row — every workflow-load skip writes a
//      `backlog_promotion_skipped_workflow_load` ActivityLog row with
//      holder / current_count / ticket_ids in `new_value`.

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

process.env.PORT = process.env.QA_WORKFLOW_STATE_PORT || '7822';

test('BacklogPromotion workflow-state cap: parked tickets count, WAIT-only turns no-op, cross-board independent', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;

  const backlogPromotionServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'backlog-promotion.service.js')
  );
  const agentStatusServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-status.service.js')
  );
  const agentWorkloadServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-workload.service.js')
  );
  const backlogPromotion = app.get(backlogPromotionServiceModule.BacklogPromotionService);
  const agentStatus = app.get(agentStatusServiceModule.AgentStatusService);
  const agentWorkload = app.get(agentWorkloadServiceModule.AgentWorkloadService);
  const ds = app.get(getDataSourceToken());

  step('Seed workspace + assignee/reporter roles + driver user + one agent (Alice)');
  const ws = await createWorkspace(app, getDataSourceToken, 'wsc');
  await createUser(app, getDataSourceToken, { name: 'driver' });

  const roleRepo = ds.getRepository('WorkspaceRole');
  const assigneeRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'assignee' } });
  const reporterRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'reporter' } });
  assert.ok(assigneeRole, 'createWorkspace should seed assignee role');
  assert.ok(reporterRole, 'createWorkspace should seed reporter role');

  const alice = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
  await createApiKey(app, getDataSourceToken, alice.id, { workspaceId: ws.id, label: 'alice' });

  const boardRepo = ds.getRepository('Board');
  const colRepo = ds.getRepository('BoardColumn');
  const ticketRepo = ds.getRepository('Ticket');
  const activityLogRepo = ds.getRepository('ActivityLog');

  // Standard board layout: Backlog (intake) → To Do (active) → In Progress
  // (active) → Merging (merging) → Done (terminal). All active and
  // merging columns route assignee. cap=1 is the GameClient repro.
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
    const inProgress = await createColumn(app, getDataSourceToken, board.id, {
      name: 'In Progress', position: 2, workspaceId: ws.id,
    });
    const merging = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Merging', position: 3, workspaceId: ws.id,
    });
    const done = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Done', position: 4, workspaceId: ws.id, isTerminal: true,
    });
    await colRepo.update(backlog.id, { kind: 'intake', role_routing: JSON.stringify(['reporter']) });
    await colRepo.update(todo.id, { kind: 'active', role_routing: JSON.stringify(['assignee']) });
    await colRepo.update(inProgress.id, { kind: 'active', role_routing: JSON.stringify(['assignee']) });
    await colRepo.update(merging.id, { kind: 'merging', role_routing: JSON.stringify(['assignee']) });
    await colRepo.update(done.id, { kind: 'terminal', role_routing: JSON.stringify([]) });
    return { board, backlog, todo, inProgress, merging, done };
  }

  async function readSkipAudit(boardId) {
    const rows = await activityLogRepo.find({
      where: { action: 'backlog_promotion_skipped_workflow_load' },
      order: { created_at: 'ASC' },
    });
    return rows.filter((r) => (r.new_value || '').includes(`board=${boardId}`));
  }

  // ────────────────────────────────────────────────────────────────────
  // Case 1 — Reproducer: cap=1, 1 ticket in In Progress + 5 backlog →
  // tryPromote=null. Merging step still null. Done unlocks one promote.
  // ────────────────────────────────────────────────────────────────────
  step('Case 1 — cap=1, Alice has 1 ticket in In Progress + 5 backlog tickets');
  const c1 = await makeBoard('case1');

  // T_busy parked in In Progress, Alice as assignee → workflow load = 1.
  const tBusy = await createTicket(app, getDataSourceToken, {
    columnId: c1.inProgress.id, workspaceId: ws.id, title: 'T_busy', priority: 'high',
    assigneeId: alice.id,
  });
  // 5 fresh backlog tickets, all Alice's.
  const backlogIds = [];
  for (let i = 0; i < 5; i++) {
    const t = await createTicket(app, getDataSourceToken, {
      columnId: c1.backlog.id, workspaceId: ws.id, title: `T_backlog_${i + 1}`, priority: 'critical',
      assigneeId: alice.id,
    });
    backlogIds.push(t.id);
    // Pace created_at so sort is deterministic — sqlite's millisecond
    // resolution otherwise collides.
    await new Promise((r) => setTimeout(r, 5));
  }

  // Sanity — workflow load is exactly the parked ticket, regardless of
  // active_tasks state.
  const loadBefore = await agentWorkload.getWorkflowLoadTicketIds(alice.id, c1.board.id, 'assignee');
  assert.deepEqual(loadBefore, [tBusy.id], `workflow load must equal [T_busy] (got ${JSON.stringify(loadBefore)})`);

  step('  tryPromote → null (cap=1 closed by parked In Progress ticket)');
  const p1 = await backlogPromotion.tryPromote(c1.board.id);
  assert.equal(p1, null, `expected null (workflow-state cap), got ${p1?.slice(0, 8)}`);

  step('  5 more tryPromote attempts (simulating supervisor retries) — all null');
  for (let i = 0; i < 5; i++) {
    const r = await backlogPromotion.tryPromote(c1.board.id);
    assert.equal(r, null, `retry #${i + 1} must remain null`);
  }

  step('  audit rows: one backlog_promotion_skipped_workflow_load per attempt');
  const skip1 = await readSkipAudit(c1.board.id);
  assert.ok(skip1.length >= 6, `expected ≥6 skip audit rows for case1 (got ${skip1.length})`);
  for (const row of skip1) {
    assert.match(
      row.new_value || '',
      new RegExp(`holder=${alice.id}`),
      `audit row must record holder=${alice.id.slice(0, 8)} (got ${row.new_value})`,
    );
    assert.match(
      row.new_value || '',
      /current_count=1\/1/,
      `audit row must record current_count=1/1 (got ${row.new_value})`,
    );
    assert.match(
      row.new_value || '',
      new RegExp(`ticket_ids=.*${tBusy.id}`),
      `audit row must include T_busy in ticket_ids (got ${row.new_value})`,
    );
  }

  step('  move T_busy to Merging (kind=merging, non-terminal, non-intake) → tryPromote still null');
  await ticketRepo.update(tBusy.id, { column_id: c1.merging.id });
  const p1Merging = await backlogPromotion.tryPromote(c1.board.id);
  assert.equal(p1Merging, null, 'Merging column still counts toward workflow load');

  step('  move T_busy to Done (terminal) → tryPromote unlocks one promotion');
  await ticketRepo.update(tBusy.id, { column_id: c1.done.id });
  const p1Done = await backlogPromotion.tryPromote(c1.board.id);
  assert.ok(p1Done, `expected one of the 5 backlog tickets to promote, got null`);
  assert.ok(backlogIds.includes(p1Done), `promoted ticket must be one of the 5 backlog tickets (got ${p1Done?.slice(0, 8)})`);

  // ────────────────────────────────────────────────────────────────────
  // Case 2 — WAIT-only turn doesn't move the cap. setCurrentTask /
  // clearCurrentTask cycle without column moves leaves workflow load
  // unchanged, so promotion stays null.
  // ────────────────────────────────────────────────────────────────────
  step('Case 2 — WAIT-only turn (setCurrentTask → clearCurrentTask, no column move) ≠ cap re-open');
  const c2 = await makeBoard('case2');

  const tWait = await createTicket(app, getDataSourceToken, {
    columnId: c2.todo.id, workspaceId: ws.id, title: 'T_wait', priority: 'high',
    assigneeId: alice.id,
  });
  await createTicket(app, getDataSourceToken, {
    columnId: c2.backlog.id, workspaceId: ws.id, title: 'T_backlog_wait', priority: 'critical',
    assigneeId: alice.id,
  });

  // Pre-cycle: cap closed because T_wait is parked in To Do.
  const p2a = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(p2a, null, 'pre-cycle promotion must be null (T_wait parked in To Do)');

  // Simulate WAIT-only turn: alive → clear. No column move.
  await agentStatus.setCurrentTask(alice.id, tWait.id, 'assignee');
  agentStatus.clearCurrentTask(alice.id, tWait.id);

  // Post-cycle: cap STILL closed because workflow-state didn't change.
  // The pre-fix process-level cap check would now succeed because
  // active_tasks went 1 → 0.
  const p2b = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(
    p2b, null,
    'WAIT-only turn must not re-open the cap (workflow-state still has T_wait parked in To Do)',
  );

  // ────────────────────────────────────────────────────────────────────
  // Case 3 — Cross-board independence. Alice's load on board X doesn't
  // close the cap on board Y.
  // ────────────────────────────────────────────────────────────────────
  step('Case 3 — same agent, parallel boards: load on X ≠ blocked on Y');
  const cX = await makeBoard('xboard');
  const cY = await makeBoard('yboard');

  // Park 1 ticket on board X's In Progress, Alice as assignee.
  await createTicket(app, getDataSourceToken, {
    columnId: cX.inProgress.id, workspaceId: ws.id, title: 'T_xparked', priority: 'high',
    assigneeId: alice.id,
  });
  // 1 backlog ticket on board Y, also Alice's.
  const tYBacklog = await createTicket(app, getDataSourceToken, {
    columnId: cY.backlog.id, workspaceId: ws.id, title: 'T_ybacklog', priority: 'critical',
    assigneeId: alice.id,
  });

  // Workload helper must scope correctly.
  const loadX = await agentWorkload.getWorkflowLoadTicketIds(alice.id, cX.board.id, 'assignee');
  const loadY = await agentWorkload.getWorkflowLoadTicketIds(alice.id, cY.board.id, 'assignee');
  assert.equal(loadX.length, 1, `board X workflow load = 1 (got ${loadX.length})`);
  assert.equal(loadY.length, 0, `board Y workflow load = 0 (got ${loadY.length})`);

  // Board X promotion still null; board Y promotion succeeds.
  const pX = await backlogPromotion.tryPromote(cX.board.id);
  assert.equal(pX, null, 'board X cap still closed by parked X ticket');
  const pY = await backlogPromotion.tryPromote(cY.board.id);
  assert.equal(pY, tYBacklog.id, `board Y promotes its only backlog ticket (got ${pY?.slice(0, 8)})`);

  // Activity-log evidence: dump the skipped-workflow-load rows so a
  // reviewer reading the test log can read the audit trail directly.
  step('Activity-log evidence — backlog_promotion_skipped_workflow_load rows');
  const allSkips = await activityLogRepo.find({ where: { action: 'backlog_promotion_skipped_workflow_load' } });
  console.log(`  total skip rows across all boards: ${allSkips.length}`);
  for (const r of allSkips.slice(0, 12)) {
    console.log(`    ticket=${r.ticket_id.slice(0, 8)}  ${r.new_value}`);
  }

  exitAfterTests(0);
});
