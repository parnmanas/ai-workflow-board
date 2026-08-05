// Regression — a ticket whose column/board rows predate workspace scoping must
// still load its full detail (and therefore its comments).
//
// Incident: the detail panel's Comments tab rendered EMPTY for every ticket on
// such a board. `Board.workspace_id` and `BoardColumn.workspace_id` are both
// nullable (default ''), so legacy rows carry '' while the ticket carries a
// real workspace id. The current-column resolution added in 7bb5f545 filtered
// the column lookup by `workspace_id: ticket.workspace_id` and then threw when
// the join came back empty — turning GET /api/tickets/:id into a 500. The
// client swallows that error and falls back to the board-card projection, whose
// `comments` is `[]` by construction (perf ticket b3812637) — so the tab showed
// nothing while the card still displayed a comment count.
//
// The fail-closed intent (never expose another workspace's column, never let a
// caller fall back to the legacy Ticket.status) is preserved: a GENUINE
// cross-workspace mismatch still throws — asserted at the bottom.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers/boot.mjs';
import { setupKanbanScene, createTicket, createWorkspace } from './helpers/fixtures.mjs';
import { loadTicketFull } from '../dist/modules/mcp/shared/ticket-parsing.js';

const { app, modules } = await bootApp({ port: 7921 });
after(async () => { await app.close(); });
const ds = app.get(modules.getDataSourceToken());

/** Strip workspace scoping off a column + its board, reproducing rows created
 *  before workspace_id existed. `boards.workspace_id` carries an FK, so the
 *  only unscoped value it can legally hold is NULL; the columns table has no
 *  such FK, which is why the entity's `default: ''` is reachable there. */
async function makeLegacyScoping(columnId, boardId, columnValue, boardValue = null) {
  await ds.getRepository('BoardColumn').update(columnId, { workspace_id: columnValue });
  await ds.getRepository('Board').update(boardId, { workspace_id: boardValue });
}

async function addComment(ticketId, content) {
  const repo = ds.getRepository('Comment');
  const row = repo.create({
    ticket_id: ticketId,
    author: 'tester',
    author_type: 'user',
    content,
    type: 'note',
  });
  return repo.save(row);
}

test('legacy empty-workspace column still resolves — detail keeps its comments', async () => {
  const { ws, board, columns } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'legacy-empty-ws',
  });
  const ticket = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'legacy board ticket',
  });
  await addComment(ticket.id, 'first comment');
  await addComment(ticket.id, 'second comment');

  await makeLegacyScoping(columns.todo.id, board.id, '');

  // Both modes the panel uses: bounded (REST detail) and full (MCP get_ticket).
  const bounded = await loadTicketFull(ds, ticket.id, { commentLimit: 50 });
  assert.ok(bounded, 'bounded detail load must not throw for a legacy column');
  assert.equal(bounded.comments.length, 2, 'comments survive the legacy scoping');
  assert.equal(bounded.current_column_id, columns.todo.id);
  assert.equal(bounded.current_column_name, columns.todo.name);

  const full = await loadTicketFull(ds, ticket.id);
  assert.equal(full.comments.length, 2);
  assert.equal(full.current_column_id, columns.todo.id);
});

test('NULL-workspace column (pre-migration rows) resolves the same way', async () => {
  const { ws, board, columns } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'legacy-null-ws',
  });
  const ticket = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'null-workspace board ticket',
  });
  await addComment(ticket.id, 'only comment');

  await makeLegacyScoping(columns.todo.id, board.id, null);

  const detail = await loadTicketFull(ds, ticket.id, { commentLimit: 50 });
  assert.equal(detail.comments.length, 1);
  assert.equal(detail.current_column_id, columns.todo.id);
});

test('a column scoped to a DIFFERENT workspace still fails closed', async () => {
  const { ws, board, columns } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'cross-ws-guard',
  });
  const other = await createWorkspace(app, modules.getDataSourceToken, 'cross-ws-guard-other');
  const ticket = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'cross-workspace ticket',
  });

  // Column + board genuinely belong to another workspace — the exact leak the
  // fail-closed guard exists to prevent. This must still throw.
  await makeLegacyScoping(columns.todo.id, board.id, other.id, other.id);

  await assert.rejects(
    () => loadTicketFull(ds, ticket.id, { commentLimit: 50 }),
    /no current column in workspace/,
    'cross-workspace column must still fail closed',
  );
});

test('a root ticket with no column at all still fails closed', async () => {
  const { ws, columns } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'missing-column-guard',
  });
  const ticket = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'orphan column ticket',
  });
  // Null out rather than repoint or delete: `tickets.column_id` carries an FK
  // (a bogus id can't be stored) and deleting the column cascades the ticket
  // away, which would make loadTicketFull return null instead of hitting the
  // guard. A root ticket with a NULL column is the representable failure.
  await ds.getRepository('Ticket').update(ticket.id, { column_id: null });

  await assert.rejects(
    () => loadTicketFull(ds, ticket.id, { commentLimit: 50 }),
    /no current column in workspace/,
    'a root ticket without a column is still an unresolvable workflow state',
  );
});
