// QA flow: per-agent FOCUS collapse (ticket 3fb0005d).
//
// What this proves
// ────────────────
//
// The board FOCUS-badge endpoint `GET /boards/:id/focus-tickets` must
// show focus in the SAME unit as the agent-manager dispatch cap
// (`Board.max_concurrent_tickets_per_agent`, an AGENT-unit count). Before
// this fix the endpoint computed focus per (agent, role) pair, so a single
// agent holding two roles on a board (assignee + reviewer — 겸직) always
// got two FOCUS badges even though cap=1 lets the manager dispatch only one
// ticket. This collapses focus to the agent unit: top-N tickets per agent
// (N = the cap), ranked by the same focus selector.
//
// Cases (from the ticket's 검증 section):
//   (a) one agent holds assignee + reviewer, cap=1 → exactly 1 FOCUS ticket
//   (b) assignee and reviewer are DIFFERENT agents, cap=1 → 1 each
//       (non-겸직 regression guard — old behavior preserved)
//   (c) cap=2, 겸직 → top-2 tickets (the two highest-ranked, lower ones drop)
//
// Both the service entry point (`AgentWorkloadService.getAgentFocusTicketIds`)
// and the full HTTP endpoint output (via a direct controller call with a
// captured Response) are asserted, so the collapse is checked end-to-end
// including the per-ticket role labelling.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createColumn,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_FOCUS_COLLAPSE_PORT || '7864';

// Minimal Express Response stand-in: capture the JSON body the controller
// hands back. The focus-tickets handler only calls res.json(...), so this
// is all we need to inspect the full endpoint output without standing up
// the AuthGuard / HTTP stack.
function captureRes() {
  const cap = { body: null };
  cap.json = (b) => {
    cap.body = b;
    return cap;
  };
  cap.status = () => cap;
  return cap;
}

test('FOCUS collapse — 겸직 collapses to agent-unit top-N, 비겸직 unchanged', async (t) => {
  try {
    step('Boot NestJS app on test port');
    const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
    t.after(() => { void app.close().catch(() => {}); });
    const { getDataSourceToken } = modules;

    const agentWorkloadServiceModule = await import(
      'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-workload.service.js')
    );
    const boardsControllerModule = await import(
      'file://' + path.join(DIST_ROOT, 'modules', 'boards', 'boards.controller.js')
    );
    const agentWorkload = app.get(agentWorkloadServiceModule.AgentWorkloadService);
    const boardsController = app.get(boardsControllerModule.BoardsController);
    const ds = app.get(getDataSourceToken());

    step('Seed workspace + driver user + agents');
    const ws = await createWorkspace(app, getDataSourceToken, 'wscollapse');
    await createUser(app, getDataSourceToken, { name: 'driver' });
    const alice = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
    const bob = await createAgent(app, getDataSourceToken, ws.id, { name: 'bob' });

    const boardRepo = ds.getRepository('Board');

    // Six-column board: Backlog(intake,0) → To Do(1) → In Progress(3) →
    // Review(4) → Merging(5) → Done(terminal,6). Review routes reviewer so
    // 겸직 (assignee elsewhere + reviewer here) is realistic. Positions
    // ascending so the selector's column.position DESC rank picks
    // Review > In Progress > To Do.
    async function makeBoard(name, maxConcurrent) {
      const board = await boardRepo.save(boardRepo.create({
        name, description: '', workspace_id: ws.id,
        routing_config: JSON.stringify({}),
        max_concurrent_tickets_per_agent: maxConcurrent,
      }));
      const backlog = await createColumn(app, getDataSourceToken, board.id, {
        name: 'Backlog', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: ['reporter'],
      });
      const todo = await createColumn(app, getDataSourceToken, board.id, {
        name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
      });
      const inProgress = await createColumn(app, getDataSourceToken, board.id, {
        name: 'In Progress', position: 3, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
      });
      const review = await createColumn(app, getDataSourceToken, board.id, {
        name: 'Review', position: 4, workspaceId: ws.id, kind: 'review', roleRouting: ['reviewer'],
      });
      const merging = await createColumn(app, getDataSourceToken, board.id, {
        name: 'Merging', position: 5, workspaceId: ws.id, kind: 'merging', roleRouting: ['assignee'],
      });
      const done = await createColumn(app, getDataSourceToken, board.id, {
        name: 'Done', position: 6, workspaceId: ws.id, isTerminal: true, kind: 'terminal', roleRouting: [],
      });
      return { board, backlog, todo, inProgress, review, merging, done };
    }

    // Distinct ticket ids carrying a FOCUS badge in the endpoint output,
    // optionally scoped to one agent. The client keys the badge by
    // ticket_id, so the badge count is the number of distinct ticket ids.
    function focusTicketSet(body, agentId) {
      const rows = (body.focus_tickets || []).filter((f) => !agentId || f.agent_id === agentId);
      return new Set(rows.map((f) => f.ticket_id));
    }

    // ────────────────────────────────────────────────────────────────────
    // Case (a) — 겸직, cap=1 → exactly 1 FOCUS ticket.
    // Alice is assignee of X (In Progress, pos 3) and reviewer of Y
    // (Review, pos 4). Old: 2 badges (one per role). New: collapse to the
    // top-ranked one — Review(4) beats In Progress(3) — so only Y.
    // ────────────────────────────────────────────────────────────────────
    step('Case (a) — 겸직 cap=1 → 1 FOCUS ticket (collapse)');
    const a = await makeBoard('collapse_a', 1);
    const aX = await createTicket(app, getDataSourceToken, {
      columnId: a.inProgress.id, workspaceId: ws.id, title: 'A_X_inprogress', priority: 'high',
      assigneeId: alice.id,
    });
    const aY = await createTicket(app, getDataSourceToken, {
      columnId: a.review.id, workspaceId: ws.id, title: 'A_Y_review', priority: 'high',
      reviewerId: alice.id,
    });

    const aIds = await agentWorkload.getAgentFocusTicketIds(alice.id, a.board.id, 1);
    assert.deepEqual(aIds, [aY.id], `cap=1 겸직 must collapse to the single top ticket Y (got ${aIds.map(s => s.slice(0,8))})`);

    const aRes = captureRes();
    await boardsController.getFocusTickets(a.board.id, aRes);
    const aSet = focusTicketSet(aRes.body, alice.id);
    assert.equal(aSet.size, 1, `endpoint must show exactly 1 FOCUS ticket for 겸직 Alice (got ${aSet.size})`);
    assert.ok(aSet.has(aY.id), 'the surviving FOCUS ticket must be Y (Review beats In Progress on column.position)');
    // Sanity: X (the dropped role's ticket) must NOT carry a badge.
    assert.ok(!aSet.has(aX.id), 'X must lose its FOCUS badge under the collapse');

    // ────────────────────────────────────────────────────────────────────
    // Case (b) — non-겸직, cap=1 → 1 each (regression guard).
    // Alice assignee of X (In Progress); Bob reviewer of Y (Review).
    // Two different agents, one role each → still one focus per agent.
    // ────────────────────────────────────────────────────────────────────
    step('Case (b) — 비겸직 cap=1 → 1 FOCUS each (no regression)');
    const b = await makeBoard('collapse_b', 1);
    const bX = await createTicket(app, getDataSourceToken, {
      columnId: b.inProgress.id, workspaceId: ws.id, title: 'B_X_assignee', priority: 'high',
      assigneeId: alice.id,
    });
    const bY = await createTicket(app, getDataSourceToken, {
      columnId: b.review.id, workspaceId: ws.id, title: 'B_Y_reviewer', priority: 'high',
      reviewerId: bob.id,
    });

    const bAlice = await agentWorkload.getAgentFocusTicketIds(alice.id, b.board.id, 1);
    const bBob = await agentWorkload.getAgentFocusTicketIds(bob.id, b.board.id, 1);
    assert.deepEqual(bAlice, [bX.id], `Alice (assignee only) focus must be X (got ${bAlice.map(s => s.slice(0,8))})`);
    assert.deepEqual(bBob, [bY.id], `Bob (reviewer only) focus must be Y (got ${bBob.map(s => s.slice(0,8))})`);

    const bRes = captureRes();
    await boardsController.getFocusTickets(b.board.id, bRes);
    const bAliceSet = focusTicketSet(bRes.body, alice.id);
    const bBobSet = focusTicketSet(bRes.body, bob.id);
    assert.equal(bAliceSet.size, 1, 'Alice must keep exactly 1 FOCUS badge');
    assert.equal(bBobSet.size, 1, 'Bob must keep exactly 1 FOCUS badge');
    assert.ok(bAliceSet.has(bX.id) && bBobSet.has(bY.id), 'each agent badges their own ticket');
    // Role labels must survive: Alice→assignee, Bob→reviewer.
    const bRows = bRes.body.focus_tickets;
    assert.ok(
      bRows.some((r) => r.agent_id === alice.id && r.ticket_id === bX.id && r.role === 'assignee'),
      'Alice badge must be labelled assignee',
    );
    assert.ok(
      bRows.some((r) => r.agent_id === bob.id && r.ticket_id === bY.id && r.role === 'reviewer'),
      'Bob badge must be labelled reviewer',
    );

    // ────────────────────────────────────────────────────────────────────
    // Case (c) — 겸직, cap=2 → top-2.
    // Alice holds three tickets: Y (Review, pos 4, reviewer), X (In
    // Progress, pos 3, assignee), Z (To Do, pos 1, assignee). cap=2 keeps
    // the two highest-ranked by column.position (Y, X); Z drops.
    // ────────────────────────────────────────────────────────────────────
    step('Case (c) — 겸직 cap=2 → top-2 FOCUS tickets');
    const c = await makeBoard('collapse_c', 2);
    const cY = await createTicket(app, getDataSourceToken, {
      columnId: c.review.id, workspaceId: ws.id, title: 'C_Y_review', priority: 'high',
      reviewerId: alice.id,
    });
    const cX = await createTicket(app, getDataSourceToken, {
      columnId: c.inProgress.id, workspaceId: ws.id, title: 'C_X_inprogress', priority: 'high',
      assigneeId: alice.id,
    });
    const cZ = await createTicket(app, getDataSourceToken, {
      columnId: c.todo.id, workspaceId: ws.id, title: 'C_Z_todo', priority: 'high',
      assigneeId: alice.id,
    });

    const cIds = await agentWorkload.getAgentFocusTicketIds(alice.id, c.board.id, 2);
    assert.equal(cIds.length, 2, `cap=2 must keep exactly 2 focus tickets (got ${cIds.length})`);
    assert.deepEqual(
      cIds, [cY.id, cX.id],
      `cap=2 top-2 must be [Y(Review), X(In Progress)] in column-rank order (got ${cIds.map(s => s.slice(0,8))})`,
    );
    assert.ok(!cIds.includes(cZ.id), 'Z (To Do, lowest column) must drop out of the top-2');

    const cRes = captureRes();
    await boardsController.getFocusTickets(c.board.id, cRes);
    const cSet = focusTicketSet(cRes.body, alice.id);
    assert.equal(cSet.size, 2, `endpoint must show exactly 2 FOCUS tickets at cap=2 (got ${cSet.size})`);
    assert.ok(cSet.has(cY.id) && cSet.has(cX.id), 'the two FOCUS tickets must be Y and X');
    assert.ok(!cSet.has(cZ.id), 'Z must not carry a FOCUS badge at cap=2');

    step('Done — collapse cases (a)/(b)/(c) all passed');
    exitAfterTests(0);
  } catch (e) {
    console.error('[focus-collapse qa] FAILED:', e?.stack || String(e));
    throw e;
  }
});
