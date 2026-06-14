// QA flow: terminal-reopen guard on move_ticket (ticket ad0eb567).
//
// On a board where one agent holds assignee+reviewer+reporter, every column
// transition fires a fresh role-trigger to the SAME agent, so multiple strands
// run concurrently. The damaging race is a *backward move out of a terminal
// column*: a late strand reads the ticket as still in Review/Merging, but by
// the time its move_ticket lands a sibling strand has already merged it into
// Done. The stale call then re-opens a completed merge (observed on tickets
// e163c952 and 9f507f5c).
//
// This test reproduces that race against the real MCP move_ticket tool and
// asserts the server-side guard:
//
//   Strand A: Review → Done           (allowed; lands in terminal)
//   Strand B: Done   → In Progress    (rejected; ticket STAYS in Done)
//   Override: Done   → In Progress    with force=true  (allowed)
//
// Strand B is exactly the stale-snapshot reopen the guard exists to refuse.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createTicket,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_TERMINAL_REOPEN_PORT || '7842';

test('move_ticket rejects a backward move out of a terminal column unless force=true', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;

  step('Seed kanban scene (Done is is_terminal=true)');
  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'terminal-reopen',
  });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, {
    workspaceId: ws.id,
    label: 'worker',
  });

  step('Create ticket in Review, assigned to the worker');
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id,
    workspaceId: ws.id,
    title: 'Reopen-guard ticket',
    promptText: 'Merge me, then a stale strand tries to drag me back out of Done.',
    assigneeId: worker.id,
  });

  // VirtualAgent.start() initializes the MCP HTTP client; we drive move_ticket
  // directly through it (no trigger needed) to simulate the two strands.
  const va = new VirtualAgent({
    name: 'worker',
    agentId: worker.id,
    apiKey: workerKey.raw_key,
    port,
  });
  await va.start();
  t.after(() => va.stop());

  const ticketRepo = app.get(getDataSourceToken()).getRepository('Ticket');

  step('STRAND A: move Review → Done (into terminal) — should succeed');
  const moveToDone = await va.mcp.callTool('move_ticket', {
    ticket_id: ticket.id,
    target_column_name: 'Done',
    board_id: board.id,
  });
  assert.ok(!moveToDone?.isError, `Review → Done must succeed, got: ${JSON.stringify(moveToDone)}`);
  let row = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(row?.column_id, columns.done.id, 'Ticket is in Done after strand A');

  step('STRAND B (stale snapshot): move Done → In Progress — should be REJECTED');
  const reopen = await va.mcp.callTool('move_ticket', {
    ticket_id: ticket.id,
    target_column_name: 'In Progress',
    board_id: board.id,
  });
  assert.equal(reopen?.isError, true, 'Backward move out of terminal must be rejected');
  assert.match(
    JSON.stringify(reopen?.error ?? reopen),
    /terminal/i,
    'Rejection message names the terminal-reopen reason',
  );
  row = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(row?.column_id, columns.done.id, 'Ticket STAYS in Done — no reconciler needed');

  step('OVERRIDE: move Done → In Progress with force=true — should succeed');
  const forced = await va.mcp.callTool('move_ticket', {
    ticket_id: ticket.id,
    target_column_name: 'In Progress',
    board_id: board.id,
    force: true,
  });
  assert.ok(!forced?.isError, `force=true must allow the reopen, got: ${JSON.stringify(forced)}`);
  row = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(row?.column_id, columns.inProgress.id, 'force=true reopened the ticket into In Progress');

  step('SANITY: terminal → terminal reorder is NOT blocked (move Done → Done)');
  // Put it back in Done first (forward move into terminal is always allowed),
  // then a same-column move must not trip the guard (source==dest==terminal).
  await va.mcp.callTool('move_ticket', { ticket_id: ticket.id, target_column_name: 'Done', board_id: board.id });
  const reorder = await va.mcp.callTool('move_ticket', {
    ticket_id: ticket.id,
    target_column_name: 'Done',
    board_id: board.id,
  });
  assert.ok(!reorder?.isError, 'Reorder within the terminal column must not be blocked');

  exitAfterTests(0);
});
