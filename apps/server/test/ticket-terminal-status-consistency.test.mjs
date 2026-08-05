// Regression test — ticket 35b43ee9.
//
// A follow-up/correction ticket (related_ticket_id set) created directly in a
// terminal column landed with status still 'todo': column said "done", status
// said "not done", and the ticket was invisible to every dispatch path (push
// trigger, focus-ticket polling, reconciler seed all exclude terminal columns
// by design) — it never started. Root cause: create_ticket (MCP + REST +
// legacy agent-api) trusted the caller-supplied destination column with no
// terminal-aware validation, and Ticket.status was never derived from the
// column's terminal/non-terminal meaning at create OR move time.
//
// This covers: (1) the unsafe combination is rejected at create time, (2) the
// pre-existing legitimate direct-to-terminal create (no related_ticket_id)
// still works and now gets a consistent status, (3) the everyday
// related_ticket_id-into-a-non-terminal-column case is unaffected, (4) the
// new safe column default when column_id/column_name are omitted, (5) status
// stays in sync with the column across move_ticket in both directions, (6) a
// move that does NOT cross the terminal boundary (reorder within Done) still
// re-derives status — closing the gap a review pass found in the first
// version of this fix, (7) the one-time migration heals rows that drifted
// out of sync before any of this shipped, and (8) a ticket created into a
// non-terminal column is actually live for dispatch — not just
// database-consistent — via the real TriggerLoopService.dispatchCurrentColumn
// producer→dispatcher path (not just column_id/status inspection).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createTicket } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { TriggerLoopService } from '../dist/modules/agents/trigger-loop.service.js';
import { BackfillRootTicketStatusFromColumn1760000000075 } from '../dist/database/migrations/1760000000075-BackfillRootTicketStatusFromColumn.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '7859';

test('terminal-column ticket create/move keeps status consistent with the column', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const ticketRepo = ds.getRepository('Ticket');
  const activityLogRepo = ds.getRepository('ActivityLog');

  // envRepo: true — scenario 8 dispatches an assignee onto an 'active' column,
  // which the base-repo-binding guard (ticket 8c3befa8) pends closed unless
  // the board declares a resolvable repository.
  const { ws, board, columns } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'terminal-status', envRepo: true,
  });
  const agent = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'assignee' });
  const key = await createApiKey(app, modules.getDataSourceToken, agent.id, { workspaceId: ws.id });
  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => mcp.close());

  const related = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'original ticket being corrected',
  });

  // 1. The exact repro: a follow-up ticket (related_ticket_id set) explicitly
  // targeting the terminal column must be rejected, not silently created.
  const rejected = await mcp.callTool('create_ticket', {
    title: 'follow-up correction', board_id: board.id, column_name: 'Done',
    related_ticket_id: related.id,
  });
  assert.equal(rejected?.isError, true, JSON.stringify(rejected));
  assert.match(rejected.error?.error || '', /terminal column/);
  assert.equal(
    await ticketRepo.count({ where: { title: 'follow-up correction' } }),
    0,
    'the rejected follow-up must not be persisted',
  );

  // 2. Regression guard: legitimate direct-to-terminal creation WITHOUT
  // related_ticket_id (e.g. an operator filing a retroactive/already-done
  // record) must keep working, now with a status that matches the column.
  const retroactive = await mcp.callTool('create_ticket', {
    title: 'retroactive record', board_id: board.id, column_name: 'Done',
  });
  assert.ok(retroactive?.id, JSON.stringify(retroactive));
  const retroactiveRow = await ticketRepo.findOneByOrFail({ id: retroactive.id });
  assert.equal(retroactiveRow.column_id, columns.done.id);
  assert.equal(retroactiveRow.status, 'done');
  assert.ok(retroactiveRow.terminal_entered_at, 'terminal_entered_at must still be stamped');

  // 3. Regression guard: the everyday case — a follow-up ticket into a
  // non-terminal column — is unaffected by the new guard.
  const normalFollowUp = await mcp.callTool('create_ticket', {
    title: 'normal follow-up', board_id: board.id, column_name: 'Todo',
    related_ticket_id: related.id,
  });
  assert.ok(normalFollowUp?.id, JSON.stringify(normalFollowUp));
  const normalFollowUpRow = await ticketRepo.findOneByOrFail({ id: normalFollowUp.id });
  assert.equal(normalFollowUpRow.column_id, columns.todo.id);
  assert.equal(normalFollowUpRow.status, 'todo');

  // 4. New safe default: omitting column_id/column_name (board_id alone)
  // lands on the board's first non-terminal column instead of erroring.
  const defaulted = await mcp.callTool('create_ticket', {
    title: 'no column specified', board_id: board.id,
  });
  assert.ok(defaulted?.id, JSON.stringify(defaulted));
  const defaultedRow = await ticketRepo.findOneByOrFail({ id: defaulted.id });
  assert.equal(defaultedRow.column_id, columns.todo.id);
  assert.equal(defaultedRow.status, 'todo');

  // 5. move_ticket keeps status in sync across the terminal boundary in both
  // directions — not just at creation.
  const lifecycle = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'lifecycle status sync',
  });
  const movedIn = await mcp.callTool('move_ticket', { ticket_id: lifecycle.id, target_column_id: columns.done.id });
  assert.ok(!movedIn?.isError, JSON.stringify(movedIn));
  assert.equal((await ticketRepo.findOneByOrFail({ id: lifecycle.id })).status, 'done');

  const movedOut = await mcp.callTool('move_ticket', {
    ticket_id: lifecycle.id, target_column_id: columns.todo.id, force: true,
  });
  assert.ok(!movedOut?.isError, JSON.stringify(movedOut));
  assert.equal((await ticketRepo.findOneByOrFail({ id: lifecycle.id })).status, 'todo');

  // 6. Review follow-up: a move that does NOT cross the terminal boundary
  // (reorder within Done) must still re-derive status. Before this fix,
  // `applyTerminalEnteredAtForMove` short-circuited on `wasTerminal ===
  // isTerminal` and skipped the status write entirely — a row that was
  // ALREADY drifted (terminal column, stale non-terminal status — exactly
  // the reported repro's residual state) stayed wrong forever unless it
  // happened to cross the boundary again. Force that drift directly (bypass
  // every guarded write path, the same way real pre-fix data would have
  // gotten here), then reorder within Done and confirm it self-heals.
  const staleInDone = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.done.id, workspaceId: ws.id, title: 'drifted status pre-existing in Done',
  });
  await ticketRepo.update(staleInDone.id, { status: 'todo' });
  assert.equal(
    (await ticketRepo.findOneByOrFail({ id: staleInDone.id })).status, 'todo',
    'precondition: simulated pre-fix drift — terminal column, stale non-terminal status',
  );
  const reordered = await mcp.callTool('move_ticket', {
    ticket_id: staleInDone.id, target_column_id: columns.done.id, position: 0,
  });
  assert.ok(!reordered?.isError, JSON.stringify(reordered));
  assert.equal(
    (await ticketRepo.findOneByOrFail({ id: staleInDone.id })).status, 'done',
    'reorder within the SAME terminal column (no boundary crossing) must still re-derive status',
  );

  // 7. The one-time migration heals rows that drifted out of sync before any
  // of this shipped and never move again (so #6's self-heal-on-next-move
  // never reaches them) — e.g. the ticket that originally surfaced this bug.
  // Reproduce that residual state directly (status drifted, no further move)
  // in both directions, then run the migration's up() and confirm both heal.
  const staleDoneForMigration = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.done.id, workspaceId: ws.id, title: 'migration: stale todo in terminal column',
  });
  await ticketRepo.update(staleDoneForMigration.id, { status: 'todo' });
  const staleTodoForMigration = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'migration: stale done in non-terminal column',
  });
  await ticketRepo.update(staleTodoForMigration.id, { status: 'done' });

  const qr = ds.createQueryRunner();
  try {
    await new BackfillRootTicketStatusFromColumn1760000000075().up(qr);
  } finally {
    await qr.release();
  }

  assert.equal(
    (await ticketRepo.findOneByOrFail({ id: staleDoneForMigration.id })).status, 'done',
    'migration must heal a terminal-column row stuck on status=todo',
  );
  assert.equal(
    (await ticketRepo.findOneByOrFail({ id: staleTodoForMigration.id })).status, 'todo',
    'migration must heal a non-terminal-column row stuck on status=done',
  );

  // 8. Completion criterion 3 — "non-terminal 생성 직후 trigger/dispatch가 정상
  // 발생한다" — must be proven through the real producer→dispatcher path
  // (TriggerLoopService.dispatchCurrentColumn), not just by inspecting
  // column_id/status. Before this ticket's fix, the reported repro's ticket
  // never dispatched because it landed in a TERMINAL column (dispatch
  // excludes terminal columns by design); this proves the opposite case now
  // holds — a ticket created into a routed NON-terminal column is immediately
  // live for dispatch, and a trigger_emitted audit row lands for it.
  const triggerLoop = app.get(TriggerLoopService);
  const dispatchable = await mcp.callTool('create_ticket', {
    title: 'dispatch-eligible non-terminal create', board_id: board.id, column_name: 'In Progress',
    assignee_id: agent.id,
  });
  assert.ok(dispatchable?.id, JSON.stringify(dispatchable));
  const dispatchResult = await triggerLoop.dispatchCurrentColumn(dispatchable.id, 'test', agent.id);
  assert.ok(dispatchResult.emitted >= 1, `expected a live dispatch, got emitted=${dispatchResult.emitted}`);
  const triggerRow = await activityLogRepo.findOne({
    where: { action: 'trigger_emitted', ticket_id: dispatchable.id },
  });
  assert.ok(triggerRow, 'expected a trigger_emitted audit row for the non-terminal create');

  // Contrast: the SAME dispatch call against a terminal-column ticket
  // (scenario 2's `retroactive`, already status='done') is correctly
  // excluded — proving #8 isn't just "dispatchCurrentColumn always emits".
  const terminalDispatch = await triggerLoop.dispatchCurrentColumn(retroactive.id, 'test', agent.id);
  assert.equal(terminalDispatch.emitted, 0, 'a terminal-column ticket must stay excluded from dispatch');
});

test.after(() => exitAfterTests());
