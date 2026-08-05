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
// new safe column default when column_id/column_name are omitted, and (5)
// status stays in sync with the column across move_ticket in both directions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createTicket } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '7859';

test('terminal-column ticket create/move keeps status consistent with the column', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const ticketRepo = ds.getRepository('Ticket');

  const { ws, board, columns } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'terminal-status',
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
});

test.after(() => exitAfterTests());
