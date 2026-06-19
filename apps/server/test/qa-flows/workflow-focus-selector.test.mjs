// QA flow: WorkflowFocusSelector (ticket 4a6cdfd7).
//
// What this proves
// ────────────────
//
// `AgentWorkloadService.getFocusTicket(agent, board, role)` picks one
// ticket per (agent, board, role) at a time. Both the trigger emit
// gate (`TriggerLoopService._emitTrigger`) and the backlog promotion
// gate (`BacklogPromotionService.tryPromote`) read from that single
// function. Non-focus emits are silent (no DB row, no SSE); focus-held
// promotions write a `backlog_promotion_skipped_focus_held` audit row.
//
// This file covers acceptance criteria #1 – #7 from the ticket:
//
//   1. Pile-clearing — Merging A + To Do×N (same agent) → only A emits.
//   2. WAIT-only turn — setCurrentTask + clearCurrentTask leaves focus
//      unchanged + no new promotion.
//   3. Chain wins — A.next_ticket_id = B in backlog beats unrelated C
//      (higher priority) in backlog.
//   4. Column rank beats priority — Review medium beats To Do critical.
//   5. Multi-agent isolation — X's focus doesn't block Y's emits.
//   6. Role isolation — same agent's assignee focus and reviewer focus
//      are independent.
//   7. Promotion gate — focus-holder is ineligible destination; each
//      backlog candidate writes a focus-held audit row.

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

process.env.PORT = process.env.QA_FOCUS_SELECTOR_PORT || '7823';

test('WorkflowFocusSelector — emit gate + promotion gate + ranking + isolation', async (t) => {
  // node:test's spec/tap reporters swallow inner assertion messages and
  // only print `'test failed'`. Wrap the whole body so the actual error
  // surfaces on stderr — invaluable when the QA harness invokes this
  // file outside the qa.controller trace path.
  try {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const backlogPromotionServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'backlog-promotion.service.js')
  );
  const triggerLoopServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'trigger-loop.service.js')
  );
  const agentStatusServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-status.service.js')
  );
  const agentWorkloadServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-workload.service.js')
  );
  const backlogPromotion = app.get(backlogPromotionServiceModule.BacklogPromotionService);
  const triggerLoop = app.get(triggerLoopServiceModule.TriggerLoopService);
  const agentStatus = app.get(agentStatusServiceModule.AgentStatusService);
  const agentWorkload = app.get(agentWorkloadServiceModule.AgentWorkloadService);
  const ds = app.get(getDataSourceToken());

  step('Seed workspace + driver user + agents');
  const ws = await createWorkspace(app, getDataSourceToken, 'wsfs');
  await createUser(app, getDataSourceToken, { name: 'driver' });
  const alice = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
  await createApiKey(app, getDataSourceToken, alice.id, { workspaceId: ws.id, label: 'alice' });

  const boardRepo = ds.getRepository('Board');
  const colRepo = ds.getRepository('BoardColumn');
  const ticketRepo = ds.getRepository('Ticket');
  const activityLogRepo = ds.getRepository('ActivityLog');

  // Five-column board with Backlog (intake) → To Do → In Progress →
  // Review → Merging → Done (terminal). Positions ascending so the
  // selector's `column.position DESC` rank picks Merging > Review >
  // In Progress > To Do for ties. All non-intake, non-terminal columns
  // route assignee (or reviewer for Review where noted).
  async function makeBoard(name, { reviewerRouting = false } = {}) {
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
    const review = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Review', position: 3, workspaceId: ws.id,
    });
    const merging = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Merging', position: 4, workspaceId: ws.id,
    });
    const done = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Done', position: 5, workspaceId: ws.id, isTerminal: true,
    });
    await colRepo.update(backlog.id, { kind: 'intake', role_routing: JSON.stringify(['reporter']) });
    await colRepo.update(todo.id, { kind: 'active', role_routing: JSON.stringify(['assignee']) });
    await colRepo.update(inProgress.id, { kind: 'active', role_routing: JSON.stringify(['assignee']) });
    await colRepo.update(review.id, {
      kind: 'review',
      role_routing: JSON.stringify(reviewerRouting ? ['reviewer'] : ['assignee']),
    });
    await colRepo.update(merging.id, { kind: 'merging', role_routing: JSON.stringify(['assignee']) });
    await colRepo.update(done.id, { kind: 'terminal', role_routing: JSON.stringify([]) });
    return { board, backlog, todo, inProgress, review, merging, done };
  }

  // Activity bookkeeping — every call to emitAgentTrigger either
  // writes a `trigger_emitted` row (emit landed) or writes nothing
  // (drop). Counting after each call is how we assert silent drops.
  async function countTriggerEmitted(ticketId) {
    const rows = await activityLogRepo.find({
      where: { action: 'trigger_emitted', ticket_id: ticketId },
    });
    return rows.length;
  }
  async function countSkipAudit(boardId) {
    const rows = await activityLogRepo.find({ where: { action: 'backlog_promotion_skipped_focus_held' } });
    return rows.filter((r) => (r.new_value || '').includes(`board=${boardId}`)).length;
  }

  // ────────────────────────────────────────────────────────────────────
  // Case 1 — Pile-clearing. Merging A + N parked To Do, all same agent.
  // Focus must be A; To Do emits drop silently. After A → Done, focus
  // rotates to the top-ranked To Do ticket.
  // ────────────────────────────────────────────────────────────────────
  step('Case 1 — Merging A + N To Do (all Alice) → focus = A, To Do emits silent');
  const c1 = await makeBoard('case1');

  // A in Merging (column.position = 4 — the highest non-terminal).
  const ticketA = await createTicket(app, getDataSourceToken, {
    columnId: c1.merging.id, workspaceId: ws.id, title: 'A_merging', priority: 'high',
    assigneeId: alice.id,
  });
  // 6 To Do tickets for Alice — small but enough to make a clear
  // distinction. All `critical` so they beat A on priority alone (so
  // column.position has to be the load-bearing ranking key).
  const todoTickets = [];
  for (let i = 0; i < 6; i++) {
    const t = await createTicket(app, getDataSourceToken, {
      columnId: c1.todo.id, workspaceId: ws.id, title: `T_todo_${i + 1}`, priority: 'critical',
      assigneeId: alice.id,
    });
    // sqljs's @CreateDateColumn stores at SECOND precision (TypeORM's
    // default DATETIME on sqlite truncates sub-second). A sub-second
    // sleep here would collide all 6 rows to the same created_at and
    // make the selector's created_at-ASC tiebreaker non-deterministic
    // — exactly what we're testing. Stamp distinct, monotonically
    // increasing seconds via an UPDATE so the assertion that
    // `todoTickets[0]` (oldest) becomes the new focus survives the
    // sqlite precision quirk without forcing 6× 1s real-time sleeps.
    const stampedAt = new Date(Date.now() - (6 - i) * 1000);
    await ticketRepo.update(t.id, { created_at: stampedAt });
    t.created_at = stampedAt;
    todoTickets.push(t);
  }

  step('  selector returns A (column.position 4 beats To Do position 1, despite priority)');
  const focusA = await agentWorkload.getFocusTicket(alice.id, c1.board.id, 'assignee');
  assert.equal(focusA, ticketA.id, `expected focus = A (${ticketA.id.slice(0,8)}), got ${focusA?.slice(0,8)}`);

  step('  emit on each To Do ticket returns "" (silent drop) — no trigger_emitted row');
  const beforeTotals = new Map();
  for (const t of todoTickets) beforeTotals.set(t.id, await countTriggerEmitted(t.id));
  for (const t of todoTickets) {
    const r = await triggerLoop.emitAgentTrigger(t, alice.id, 'assignee', 'column_move', 'system');
    assert.equal(r, '', `expected silent drop for ${t.id.slice(0,8)} (got ${String(r).slice(0,8)})`);
    const after = await countTriggerEmitted(t.id);
    assert.equal(after, beforeTotals.get(t.id), `no trigger_emitted row should be written for non-focus ticket ${t.id.slice(0,8)}`);
  }

  step('  emit on A returns trigger_id + writes one trigger_emitted row');
  const beforeA = await countTriggerEmitted(ticketA.id);
  const triggerIdA = await triggerLoop.emitAgentTrigger(ticketA, alice.id, 'assignee', 'column_move', 'system');
  assert.match(triggerIdA || '', /^[0-9a-f-]{36}$/, `expected uuid trigger_id for focus emit (got ${triggerIdA})`);
  const afterA = await countTriggerEmitted(ticketA.id);
  assert.equal(afterA, beforeA + 1, 'focus emit must write exactly one trigger_emitted row');

  step('  audit new_value records selector ranking inputs');
  const auditA = await activityLogRepo.findOne({
    where: { action: 'trigger_emitted', ticket_id: ticketA.id },
    order: { created_at: 'DESC' },
  });
  assert.ok(auditA, 'expected trigger_emitted audit row for A');
  // Column position 4 (Merging), chain_target=false, priority_index=1 (high),
  // some non-empty created_at.
  assert.match(auditA.new_value || '', /column_position=4/, `audit must include column_position=4 (got ${auditA.new_value})`);
  assert.match(auditA.new_value || '', /chain_target=false/, `audit must include chain_target=false (got ${auditA.new_value})`);
  assert.match(auditA.new_value || '', /priority_index=1/, `audit must include priority_index=1 (got ${auditA.new_value})`);
  assert.match(auditA.new_value || '', /created_at=2/, `audit must include a non-empty created_at (got ${auditA.new_value})`);

  step('  move A → Done. Focus rotates to the oldest To Do (created_at ASC tiebreaker)');
  await ticketRepo.update(ticketA.id, { column_id: c1.done.id });
  const focusAfterA = await agentWorkload.getFocusTicket(alice.id, c1.board.id, 'assignee');
  // All To Do tickets are equal on (column.position 1, chain 1, priority 0)
  // so created_at ASC wins → the first-inserted To Do ticket.
  assert.equal(focusAfterA, todoTickets[0].id, `after A→Done, focus must be oldest To Do (got ${focusAfterA?.slice(0,8)} expected ${todoTickets[0].id.slice(0,8)})`);

  step('  emit on the new focus ticket lands; emit on the other 5 still drops');
  const beforeNew = await countTriggerEmitted(todoTickets[0].id);
  const triggerIdNew = await triggerLoop.emitAgentTrigger(todoTickets[0], alice.id, 'assignee', 'column_move', 'system');
  assert.match(triggerIdNew || '', /^[0-9a-f-]{36}$/, 'new focus emit must return uuid');
  assert.equal(await countTriggerEmitted(todoTickets[0].id), beforeNew + 1);
  for (let i = 1; i < todoTickets.length; i++) {
    const t = todoTickets[i];
    const before = await countTriggerEmitted(t.id);
    const r = await triggerLoop.emitAgentTrigger(t, alice.id, 'assignee', 'column_move', 'system');
    assert.equal(r, '', `non-focus ticket #${i + 1} must still drop`);
    assert.equal(await countTriggerEmitted(t.id), before, 'no audit row for non-focus emit');
  }

  // ────────────────────────────────────────────────────────────────────
  // Case 2 — WAIT-only turn. Agent runs setCurrentTask + clearCurrentTask
  // without moving the ticket. Focus stays put, promotion still no-op.
  // ────────────────────────────────────────────────────────────────────
  step('Case 2 — WAIT-only turn: setCurrentTask + clearCurrentTask leaves focus unchanged');
  const c2 = await makeBoard('case2');
  const tWait = await createTicket(app, getDataSourceToken, {
    columnId: c2.inProgress.id, workspaceId: ws.id, title: 'T_wait', priority: 'high',
    assigneeId: alice.id,
  });
  await createTicket(app, getDataSourceToken, {
    columnId: c2.backlog.id, workspaceId: ws.id, title: 'T_backlog_wait', priority: 'critical',
    assigneeId: alice.id,
  });

  const focusBeforeWait = await agentWorkload.getFocusTicket(alice.id, c2.board.id, 'assignee');
  assert.equal(focusBeforeWait, tWait.id, 'pre-cycle focus must be T_wait');

  // Pre-cycle: tryPromote refuses (focus holder = Alice has T_wait).
  const beforeWaitSkips = await countSkipAudit(c2.board.id);
  const p2a = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(p2a, null, 'pre-cycle promotion must be null');
  assert.ok(
    (await countSkipAudit(c2.board.id)) > beforeWaitSkips,
    'pre-cycle skip must write a backlog_promotion_skipped_focus_held audit row',
  );

  // WAIT-only turn — process-state cycle, no column move.
  await agentStatus.setCurrentTask(alice.id, tWait.id, 'assignee');
  agentStatus.clearCurrentTask(alice.id, tWait.id);

  const focusAfterWait = await agentWorkload.getFocusTicket(alice.id, c2.board.id, 'assignee');
  assert.equal(focusAfterWait, tWait.id, 'WAIT-only turn must not change focus');
  const p2b = await backlogPromotion.tryPromote(c2.board.id);
  assert.equal(p2b, null, 'post-WAIT promotion must still be null');

  // ────────────────────────────────────────────────────────────────────
  // Case 3 — Chain wins. A → terminal, B in backlog (low priority), C
  // in backlog (critical, unrelated). B beats C on the chain prefix.
  // ────────────────────────────────────────────────────────────────────
  step('Case 3 — A.next_ticket_id = B beats unrelated higher-priority C');
  const c3 = await makeBoard('case3');
  const tA3 = await createTicket(app, getDataSourceToken, {
    columnId: c3.done.id, workspaceId: ws.id, title: 'C3_A', priority: 'high',
    assigneeId: alice.id,
  });
  const tB3 = await createTicket(app, getDataSourceToken, {
    columnId: c3.backlog.id, workspaceId: ws.id, title: 'C3_B', priority: 'low',
    assigneeId: alice.id,
  });
  const tC3 = await createTicket(app, getDataSourceToken, {
    columnId: c3.backlog.id, workspaceId: ws.id, title: 'C3_C', priority: 'critical',
    assigneeId: alice.id,
  });
  await ticketRepo.update(tA3.id, { next_ticket_id: tB3.id });

  const promoted3 = await backlogPromotion.tryPromote(c3.board.id);
  assert.equal(promoted3, tB3.id, `expected chain-target B to promote (got ${promoted3?.slice(0,8)})`);

  // After B promotes, Alice's focus = B. Trying to promote C must now
  // get a focus-held skip.
  const focusAfterB = await agentWorkload.getFocusTicket(alice.id, c3.board.id, 'assignee');
  assert.equal(focusAfterB, tB3.id, 'post-promote focus must be B');
  const beforeC3Skips = await countSkipAudit(c3.board.id);
  const promotedC3 = await backlogPromotion.tryPromote(c3.board.id);
  assert.equal(promotedC3, null, 'C must not promote — Alice already has B as focus');
  assert.ok(
    (await countSkipAudit(c3.board.id)) > beforeC3Skips,
    'C promotion attempt must write a focus-held audit row',
  );

  // Sanity — `tC3` is untouched.
  const c3State = await ticketRepo.findOne({ where: { id: tC3.id } });
  assert.equal(c3State.column_id, c3.backlog.id, 'C must still be in Backlog');

  // ────────────────────────────────────────────────────────────────────
  // Case 4 — Column rank beats priority. Agent holds T1 (To Do, critical)
  // AND T2 (Review, medium). Focus must be T2.
  // ────────────────────────────────────────────────────────────────────
  step('Case 4 — Review medium beats To Do critical (column.position DESC > priority_index ASC)');
  const c4 = await makeBoard('case4');
  await createTicket(app, getDataSourceToken, {
    columnId: c4.todo.id, workspaceId: ws.id, title: 'C4_T1_todo_critical', priority: 'critical',
    assigneeId: alice.id,
  });
  const tReview4 = await createTicket(app, getDataSourceToken, {
    columnId: c4.review.id, workspaceId: ws.id, title: 'C4_T2_review_medium', priority: 'medium',
    assigneeId: alice.id,
  });
  const focus4 = await agentWorkload.getFocusTicket(alice.id, c4.board.id, 'assignee');
  assert.equal(focus4, tReview4.id, `expected focus = Review/medium (got ${focus4?.slice(0,8)})`);

  // ────────────────────────────────────────────────────────────────────
  // Case 5 — Multi-agent isolation. X has a parked Review ticket; Y has
  // nothing. getFocusTicket per agent is independent; emits for Y's
  // candidate tickets are not blocked by X's focus.
  // ────────────────────────────────────────────────────────────────────
  step('Case 5 — Multi-agent isolation (X holds a ticket, Y is unblocked)');
  const c5 = await makeBoard('case5');
  const xAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'xagent' });
  const yAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'yagent' });
  const tX5 = await createTicket(app, getDataSourceToken, {
    columnId: c5.review.id, workspaceId: ws.id, title: 'C5_X_review', priority: 'high',
    assigneeId: xAgent.id,
  });
  // No ticket for Y on board c5.
  const fxFocus = await agentWorkload.getFocusTicket(xAgent.id, c5.board.id, 'assignee');
  const fyFocus = await agentWorkload.getFocusTicket(yAgent.id, c5.board.id, 'assignee');
  assert.equal(fxFocus, tX5.id, 'X focus = T_X');
  assert.equal(fyFocus, null, 'Y focus = null (no parked tickets)');

  // A backlog ticket for Y on board c5 must promote — X's focus has no
  // bearing on Y's eligibility.
  const tYBacklog = await createTicket(app, getDataSourceToken, {
    columnId: c5.backlog.id, workspaceId: ws.id, title: 'C5_Y_backlog', priority: 'critical',
    assigneeId: yAgent.id,
  });
  const promoted5 = await backlogPromotion.tryPromote(c5.board.id);
  assert.equal(promoted5, tYBacklog.id, `expected Y's backlog ticket to promote despite X's focus (got ${promoted5?.slice(0,8)})`);

  // ────────────────────────────────────────────────────────────────────
  // Case 6 — Role isolation. Same agent holds assignee on T1 (In Progress)
  // and reviewer on T2 (Review). Two separate slug-filtered focus calls
  // each return their own ticket. (Note: To use a reviewer slug we need
  // a board with `reviewer` routing on Review — we make one fresh with
  // reviewerRouting=true.)
  // ────────────────────────────────────────────────────────────────────
  step('Case 6 — Role isolation: assignee focus and reviewer focus are independent');
  const c6 = await makeBoard('case6', { reviewerRouting: true });
  const tAssignee6 = await createTicket(app, getDataSourceToken, {
    columnId: c6.inProgress.id, workspaceId: ws.id, title: 'C6_T_assignee', priority: 'high',
    assigneeId: alice.id,
  });
  const tReviewer6 = await createTicket(app, getDataSourceToken, {
    columnId: c6.review.id, workspaceId: ws.id, title: 'C6_T_reviewer', priority: 'medium',
    reviewerId: alice.id,
  });
  const focusAssignee6 = await agentWorkload.getFocusTicket(alice.id, c6.board.id, 'assignee');
  const focusReviewer6 = await agentWorkload.getFocusTicket(alice.id, c6.board.id, 'reviewer');
  assert.equal(focusAssignee6, tAssignee6.id, `assignee focus must be T_assignee (got ${focusAssignee6?.slice(0,8)})`);
  assert.equal(focusReviewer6, tReviewer6.id, `reviewer focus must be T_reviewer (got ${focusReviewer6?.slice(0,8)})`);

  // ────────────────────────────────────────────────────────────────────
  // Case 7 — Promotion gate writes one focus-held audit row per
  // backlog candidate. Cap is irrelevant: the selector's "focus is
  // held" check fires regardless of board.max_concurrent_tickets_per_agent.
  // ────────────────────────────────────────────────────────────────────
  step('Case 7 — Promotion gate: focus-held holder = ineligible, N backlog candidates = N audit rows');
  const c7 = await makeBoard('case7');
  const tParked7 = await createTicket(app, getDataSourceToken, {
    columnId: c7.todo.id, workspaceId: ws.id, title: 'C7_parked', priority: 'high',
    assigneeId: alice.id,
  });
  const backlogIds7 = [];
  for (let i = 0; i < 5; i++) {
    const t = await createTicket(app, getDataSourceToken, {
      columnId: c7.backlog.id, workspaceId: ws.id, title: `C7_backlog_${i + 1}`, priority: 'critical',
      assigneeId: alice.id,
    });
    backlogIds7.push(t.id);
    await new Promise((r) => setTimeout(r, 5));
  }

  const beforeSkips7 = await countSkipAudit(c7.board.id);
  // tryPromote walks the candidates in priority order, stops at the
  // first eligible one. Since Alice holds focus and is the only
  // assignee holder on all 5 candidates, every candidate is ineligible
  // → the loop walks every one of them and writes a skip per attempt.
  const promoted7 = await backlogPromotion.tryPromote(c7.board.id);
  assert.equal(promoted7, null, 'no candidate may promote while Alice holds focus on T_parked');
  const afterSkips7 = await countSkipAudit(c7.board.id);
  assert.equal(
    afterSkips7 - beforeSkips7, backlogIds7.length,
    `expected one focus-held audit row per candidate (got ${afterSkips7 - beforeSkips7} of ${backlogIds7.length})`,
  );

  // Each row must name Alice as the holder and T_parked as the focus.
  const c7Rows = await activityLogRepo.find({
    where: { action: 'backlog_promotion_skipped_focus_held' },
    order: { created_at: 'DESC' },
  });
  const recentBoardRows = c7Rows
    .filter((r) => (r.new_value || '').includes(`board=${c7.board.id}`))
    .slice(0, backlogIds7.length);
  for (const row of recentBoardRows) {
    assert.match(
      row.new_value || '',
      new RegExp(`holder=${alice.id}`),
      `row must record holder=${alice.id.slice(0, 8)} (got ${row.new_value})`,
    );
    assert.match(
      row.new_value || '',
      new RegExp(`focus_ticket_id=${tParked7.id}`),
      `row must record focus_ticket_id=${tParked7.id.slice(0, 8)} (got ${row.new_value})`,
    );
  }

  step('Done — all 7 acceptance cases passed');
  exitAfterTests(0);
  } catch (e) {
    // Surface the assertion so a developer running the file standalone
    // sees what broke without grepping through a trace file. We log
    // synchronously and then rethrow — node:test's process.exit happens
    // through `exitAfterTests` only on the success path so the test
    // framework's own failure reporting gets a chance to fire.
    console.error('[focus-selector qa] FAILED:', e?.stack || String(e));
    throw e;
  }
});
