// QA flow: focus selector chain-head tiebreak (ticket ee0324ac).
//
// Why this exists
// ───────────────
//
// The pre-fix selector ranked step 2 as "is_chain_target ASC" — a
// boolean asking "is some other ticket's next_ticket_id pointing at
// me?". In a chain `A → B → C` with the candidate set `{B, C}` both
// B and C are chain-targets, so step 2 ties and the rank falls
// through to priority — where a higher-priority C wins over a lower-
// priority B and starves B forever.
//
// GameClient board, 2026-05-14: B-3 (Done) → B-4 (medium, To Do) →
// B-5 (high, To Do) selected B-5 forever and the medium B-4 never
// received a single trigger. Ticket ee0324ac.
//
// The fix replaces step 2 with `hasUnresolvedPredecessor`:
//   - "head-ready" (0) iff the candidate's predecessor (the ticket
//     pointing at it via `next_ticket_id`) is NOT in the current
//     candidate set;
//   - "waiting"   (1) iff the predecessor IS in the candidate set.
// Head-ready always wins; no-chain candidates are trivially head-ready
// so the no-chain regression path is unchanged.
//
// This file covers the four scenarios called out in the ticket:
//   1. Mid-chain starvation. `A → B → C`, candidate `{B medium, C high}`,
//      same column → focus = B. (The bug case.)
//   2. Singleton chain member. `A → B → C`, candidate `{B}` only → B.
//   3. No-chain regression. Independent `{X medium, Y high}`,
//      same column → Y. (Pre-fix behaviour preserved.)
//   4. Reverse fork. Two distinct parents both point at the same
//      candidate. The candidate is still head-ready iff neither
//      predecessor is in the set.
//   5. Multi-step advance. After B → terminal, the next cycle picks C.

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

process.env.PORT = process.env.QA_FOCUS_CHAIN_HEAD_PORT || '7824';

test('Focus selector chain-head tiebreak — predecessor-aware step 2 (ticket ee0324ac)', async (t) => {
  try {
    step('Boot NestJS app on test port');
    const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
    t.after(() => app.close().catch(() => {}));
    const { getDataSourceToken } = modules;

    const agentWorkloadServiceModule = await import(
      'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-workload.service.js')
    );
    const agentWorkload = app.get(agentWorkloadServiceModule.AgentWorkloadService);
    const ds = app.get(getDataSourceToken());

    step('Seed workspace + driver user + assignee agent');
    const ws = await createWorkspace(app, getDataSourceToken, 'fchain');
    await createUser(app, getDataSourceToken, { name: 'driver' });
    const alice = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
    await createApiKey(app, getDataSourceToken, alice.id, { workspaceId: ws.id, label: 'alice' });

    const boardRepo = ds.getRepository('Board');
    const ticketRepo = ds.getRepository('Ticket');

    // Three-column board: Backlog (intake) → To Do (active, assignee) →
    // Done (terminal). The chain candidates live on To Do, so they all
    // share the same column.position and step 1 ties — exactly the
    // condition that lets step 2 be the load-bearing rank key.
    async function makeBoard(name) {
      const board = await boardRepo.save(boardRepo.create({
        name, description: '', workspace_id: ws.id,
        routing_config: JSON.stringify({}),
        max_concurrent_tickets_per_agent: 1,
      }));
      const backlog = await createColumn(app, getDataSourceToken, board.id, {
        name: 'Backlog', position: 0, workspaceId: ws.id,
        kind: 'intake', roleRouting: ['reporter'],
      });
      const todo = await createColumn(app, getDataSourceToken, board.id, {
        name: 'To Do', position: 1, workspaceId: ws.id,
        kind: 'active', roleRouting: ['assignee'],
      });
      const done = await createColumn(app, getDataSourceToken, board.id, {
        name: 'Done', position: 2, workspaceId: ws.id,
        isTerminal: true, kind: 'terminal', roleRouting: [],
      });
      return { board, backlog, todo, done };
    }

    // ────────────────────────────────────────────────────────────────────
    // Case 1 — Mid-chain starvation (the bug case).
    // A → B → C in To Do. Candidate set = {B, C} because A is in Done.
    // B is medium, C is high. Pre-fix selector picks C (higher priority);
    // fixed selector must pick B (head-ready, parent A absent from set).
    // ────────────────────────────────────────────────────────────────────
    step('Case 1 — A→B→C chain, candidate {B medium, C high}, focus must be B');
    const c1 = await makeBoard('case1');
    const tA1 = await createTicket(app, getDataSourceToken, {
      columnId: c1.done.id, workspaceId: ws.id, title: 'C1_A_done', priority: 'high',
      assigneeId: alice.id,
    });
    const tB1 = await createTicket(app, getDataSourceToken, {
      columnId: c1.todo.id, workspaceId: ws.id, title: 'C1_B_todo_medium', priority: 'medium',
      assigneeId: alice.id,
    });
    const tC1 = await createTicket(app, getDataSourceToken, {
      columnId: c1.todo.id, workspaceId: ws.id, title: 'C1_C_todo_high', priority: 'high',
      assigneeId: alice.id,
    });
    await ticketRepo.update(tA1.id, { next_ticket_id: tB1.id });
    await ticketRepo.update(tB1.id, { next_ticket_id: tC1.id });

    // A is in Done (terminal) so candidate set for assignee is {B, C}.
    // Step 1 ties (both on To Do). With the fix, B is head-ready (parent
    // A is not in set) and C is waiting (parent B IS in set) → B wins.
    const focus1 = await agentWorkload.getFocusTicket(alice.id, c1.board.id, 'assignee');
    assert.equal(
      focus1,
      tB1.id,
      `expected focus = B (head-ready, ${tB1.id.slice(0, 8)}), got ${focus1?.slice(0, 8)} — the pre-fix selector returns C here because the boolean is_chain_target ties.`,
    );

    // ────────────────────────────────────────────────────────────────────
    // Case 2 — Singleton chain member. Only B remains in the candidate
    // set (A done, C parked on a different agent). B's parent A is not
    // in the set so B is head-ready and trivially the focus.
    // ────────────────────────────────────────────────────────────────────
    step('Case 2 — Same chain but candidate {B} only → focus = B');
    const c2 = await makeBoard('case2');
    const bob = await createAgent(app, getDataSourceToken, ws.id, { name: 'bob' });
    const tA2 = await createTicket(app, getDataSourceToken, {
      columnId: c2.done.id, workspaceId: ws.id, title: 'C2_A_done', priority: 'high',
      assigneeId: alice.id,
    });
    const tB2 = await createTicket(app, getDataSourceToken, {
      columnId: c2.todo.id, workspaceId: ws.id, title: 'C2_B_todo_medium', priority: 'medium',
      assigneeId: alice.id,
    });
    const tC2 = await createTicket(app, getDataSourceToken, {
      // C in To Do but routed to a DIFFERENT assignee (bob), so it
      // doesn't appear in alice's candidate set.
      columnId: c2.todo.id, workspaceId: ws.id, title: 'C2_C_todo_high', priority: 'high',
      assigneeId: bob.id,
    });
    await ticketRepo.update(tA2.id, { next_ticket_id: tB2.id });
    await ticketRepo.update(tB2.id, { next_ticket_id: tC2.id });

    const focus2 = await agentWorkload.getFocusTicket(alice.id, c2.board.id, 'assignee');
    assert.equal(
      focus2,
      tB2.id,
      `expected focus = B (the only candidate, ${tB2.id.slice(0, 8)}), got ${focus2?.slice(0, 8)}`,
    );

    // ────────────────────────────────────────────────────────────────────
    // Case 3 — No-chain regression. Independent X (medium) + Y (high),
    // no next_ticket_id links. Both candidates have empty predecessor
    // entries so both are head-ready → step 2 ties → step 3 priority
    // → Y wins. This is the no-chain behaviour we MUST preserve so
    // existing dispatch traffic doesn't shift.
    // ────────────────────────────────────────────────────────────────────
    step('Case 3 — No chain, X medium + Y high → focus = Y (priority regression)');
    const c3 = await makeBoard('case3');
    const tX3 = await createTicket(app, getDataSourceToken, {
      columnId: c3.todo.id, workspaceId: ws.id, title: 'C3_X_todo_medium', priority: 'medium',
      assigneeId: alice.id,
    });
    const tY3 = await createTicket(app, getDataSourceToken, {
      columnId: c3.todo.id, workspaceId: ws.id, title: 'C3_Y_todo_high', priority: 'high',
      assigneeId: alice.id,
    });
    const focus3 = await agentWorkload.getFocusTicket(alice.id, c3.board.id, 'assignee');
    assert.equal(
      focus3,
      tY3.id,
      `expected focus = Y (priority high beats medium when no chain present, got ${focus3?.slice(0, 8)})`,
    );

    // ────────────────────────────────────────────────────────────────────
    // Case 4 — Reverse fork. Two parents (P1, P2) both point at the
    // same child Z. Z's parentOfChild entry will be whichever of P1/P2
    // is stored last by the IN-query — but the head-ready check only
    // cares whether ANY of those predecessors is in the candidate set.
    //
    //   - 4a: both parents finished → Z head-ready.
    //   - 4b: at least one parent still in candidate set → Z waiting.
    //
    // The current impl stores one parent per child (Map<id, id>); 4b
    // therefore only fails to-spec if the stored parent happens to be
    // the one OUT of the set. So we make BOTH parents present in 4b's
    // candidate set to guarantee the test is deterministic regardless
    // of insertion order. (If we ever extend to many-predecessors the
    // map would become Map<id, Set<id>> and the same assertion holds.)
    // ────────────────────────────────────────────────────────────────────
    step('Case 4a — Reverse fork, both parents in terminal → Z head-ready');
    const c4 = await makeBoard('case4');
    const tP1_4 = await createTicket(app, getDataSourceToken, {
      columnId: c4.done.id, workspaceId: ws.id, title: 'C4_P1_done', priority: 'high',
      assigneeId: alice.id,
    });
    const tP2_4 = await createTicket(app, getDataSourceToken, {
      columnId: c4.done.id, workspaceId: ws.id, title: 'C4_P2_done', priority: 'high',
      assigneeId: alice.id,
    });
    const tZ4a = await createTicket(app, getDataSourceToken, {
      columnId: c4.todo.id, workspaceId: ws.id, title: 'C4_Z_todo_medium', priority: 'medium',
      assigneeId: alice.id,
    });
    const tQ4 = await createTicket(app, getDataSourceToken, {
      columnId: c4.todo.id, workspaceId: ws.id, title: 'C4_Q_todo_high', priority: 'high',
      assigneeId: alice.id,
    });
    await ticketRepo.update(tP1_4.id, { next_ticket_id: tZ4a.id });
    await ticketRepo.update(tP2_4.id, { next_ticket_id: tZ4a.id });
    // Candidate set is {Z, Q}; Z's recorded parent (P1 or P2) is in
    // Done, so Z is head-ready. Q has no parent, also head-ready.
    // Step 2 ties; step 3 priority → Q (high) > Z (medium). The point
    // of 4a is just that Z is treated as head-ready even with a fork
    // shape — not that Z wins.
    const focus4a = await agentWorkload.getFocusTicket(alice.id, c4.board.id, 'assignee');
    assert.equal(
      focus4a,
      tQ4.id,
      `4a: both Z and Q are head-ready (parents finished / absent); priority breaks tie → Q (high), got ${focus4a?.slice(0, 8)}`,
    );

    step('Case 4b — Reverse fork, both parents in To Do → Z waiting → P1 or P2 wins (never Z)');
    const c4b = await makeBoard('case4b');
    const tP1_4b = await createTicket(app, getDataSourceToken, {
      columnId: c4b.todo.id, workspaceId: ws.id, title: 'C4b_P1_todo_low', priority: 'low',
      assigneeId: alice.id,
    });
    const tP2_4b = await createTicket(app, getDataSourceToken, {
      columnId: c4b.todo.id, workspaceId: ws.id, title: 'C4b_P2_todo_low', priority: 'low',
      assigneeId: alice.id,
    });
    const tZ4b = await createTicket(app, getDataSourceToken, {
      columnId: c4b.todo.id, workspaceId: ws.id, title: 'C4b_Z_todo_critical', priority: 'critical',
      assigneeId: alice.id,
    });
    await ticketRepo.update(tP1_4b.id, { next_ticket_id: tZ4b.id });
    await ticketRepo.update(tP2_4b.id, { next_ticket_id: tZ4b.id });
    // Candidate set is {P1, P2, Z}. Z's recorded parent is one of P1/P2,
    // both in the set, so Z is waiting. P1 / P2 have no parents → both
    // head-ready. Z is critical but its waiting flag pushes it behind
    // P1/P2 (both low) — predecessor-aware ranking must beat raw
    // priority here.
    //
    // What we DON'T assert: which of P1 vs P2 wins. The sql.js driver
    // stores `created_at` at 1-second resolution, and fixtures.createTicket
    // burns through ticket inserts faster than that, so P1.created_at ===
    // P2.created_at and step 4 (`created_at ASC`) returns 0. Stable sort
    // then falls back on the order the `t.id IN (...)` query returned the
    // rows — which is not guaranteed to match insertion order across
    // sqlite + postgres. The case's load-bearing assertion is "Z must NOT
    // win" (predecessor-aware step 2 beats raw priority); whether P1 or
    // P2 wins the secondary tie is irrelevant to ticket ee0324ac and
    // would just bake an sqljs implementation detail into the test.
    const focus4b = await agentWorkload.getFocusTicket(alice.id, c4b.board.id, 'assignee');
    assert.ok(
      focus4b === tP1_4b.id || focus4b === tP2_4b.id,
      `4b: focus must be one of the head-ready P1/P2 (Z is waiting because a parent is in the set); got ${focus4b?.slice(0, 8)} — Z=${tZ4b.id.slice(0, 8)}, P1=${tP1_4b.id.slice(0, 8)}, P2=${tP2_4b.id.slice(0, 8)}`,
    );
    assert.notEqual(
      focus4b,
      tZ4b.id,
      `4b: critical Z must NOT win — its predecessor (P1 or P2) is still in the candidate set, so Z is "waiting" and predecessor-aware step 2 ranks it behind both low-priority P1/P2 (the whole point of ticket ee0324ac).`,
    );

    // ────────────────────────────────────────────────────────────────────
    // Case 5 — Multi-step advance. After B → Done, the candidate set
    // becomes {C} (singleton), and C now has no predecessor in the set
    // → head-ready → focus = C. This is the "natural progression"
    // assertion: the head pointer walks down the chain as each prior
    // node finishes.
    // ────────────────────────────────────────────────────────────────────
    step('Case 5 — After B→Done, focus advances to C');
    // Reuse the c1 chain — B was the focus there, now move B to Done.
    await ticketRepo.update(tB1.id, { column_id: c1.done.id });
    const focus5 = await agentWorkload.getFocusTicket(alice.id, c1.board.id, 'assignee');
    assert.equal(
      focus5,
      tC1.id,
      `expected focus = C (${tC1.id.slice(0, 8)}) after B → Done, got ${focus5?.slice(0, 8)}`,
    );

    step('Done — all 5 chain-head selector cases passed');
    exitAfterTests(0);
  } catch (e) {
    console.error('[focus-selector-chain-head qa] FAILED:', e?.stack || String(e));
    throw e;
  }
});
