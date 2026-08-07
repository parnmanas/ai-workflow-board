// Regression test — ticket e4f89f00.
//
// get_my_tickets(status='in_progress') filtered on the raw Ticket.status text
// column for every ticket, root and child alike. For ROOT tickets that column
// is derived purely from the destination column's terminal-ness
// (deriveRootTicketStatus in archive-helpers.ts) — it only ever writes 'todo'
// or 'done', NEVER 'in_progress'. So a root ticket genuinely sitting in an
// active-kind column (To Do / Plan / In Progress) could carry status='todo'
// forever, and status='in_progress' would never match it — the concurrent-
// work check in todo_workflow ("get_my_tickets status=in_progress to see
// everything you are currently working on") silently missed active work.
//
// This covers: (1) a root ticket in an active-kind column with a stale
// status='todo' row IS returned by status='in_progress' — the reported bug,
// (2) a root ticket in an intake-kind column (not yet promoted) is NOT
// returned, proving the fix matches column kind precisely rather than "any
// non-terminal column", (3) a root ticket in a terminal column is NOT
// returned either, (4) status='todo' filtering for root tickets is
// untouched (still the raw legacy status column), and (5) child ticket
// status filtering behavior is unchanged — get_my_tickets structurally
// excludes every child (column_id IS NULL never satisfies the `columns`
// innerJoin), status='in_progress' or otherwise.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createTicket } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '7930';

test('get_my_tickets status=in_progress resolves root tickets via column kind, not stale legacy status', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });

  const { ws, columns } = await setupKanbanScene(app, modules.getDataSourceToken, { workspaceName: 'my-tickets-status' });

  const agent = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'assignee' });
  const key = await createApiKey(app, modules.getDataSourceToken, agent.id, { workspaceId: ws.id });
  const mcp = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => mcp.close());

  // createTicket always writes status:'todo' regardless of column (the
  // raw-repo fixture bypasses deriveRootTicketStatus, which only runs on the
  // create_ticket/move_ticket MCP paths) — exactly the drifted-row shape the
  // reported bug depends on: an active-kind-column ticket with a
  // permanently stale 'todo' status.
  const activeTicket = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'active work', assigneeId: agent.id,
  });
  assert.equal(activeTicket.status, 'todo', 'precondition: stale legacy status, never synced to the column');

  const intakeTicket = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'not yet promoted', assigneeId: agent.id,
  });
  const terminalTicket = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.done.id, workspaceId: ws.id, title: 'already done', assigneeId: agent.id,
  });

  // 1 & 2 & 3 — status=in_progress matches the active-kind column placement
  // exactly, not "any non-terminal column" and not the stale status text.
  const inProgress = await mcp.callTool('get_my_tickets', {
    agent_id: agent.id, workspace_id: ws.id, status: 'in_progress',
  });
  assert.ok(Array.isArray(inProgress), JSON.stringify(inProgress));
  const inProgressIds = inProgress.map((r) => r.id);
  assert.ok(
    inProgressIds.includes(activeTicket.id),
    'a root ticket in an active-kind column must be returned even though its stored status is still "todo"',
  );
  assert.ok(
    !inProgressIds.includes(intakeTicket.id),
    'a root ticket in an intake-kind column (not yet promoted) must NOT be returned',
  );
  assert.ok(
    !inProgressIds.includes(terminalTicket.id),
    'a root ticket in a terminal column must NOT be returned',
  );

  // 4 — status='todo' for root tickets is untouched: still the raw legacy
  // status column, so both the active and intake tickets (both stored as
  // 'todo' by the fixture) still match it exactly as before this fix.
  const todoFiltered = await mcp.callTool('get_my_tickets', {
    agent_id: agent.id, workspace_id: ws.id, status: 'todo',
  });
  const todoIds = todoFiltered.map((r) => r.id);
  assert.ok(
    todoIds.includes(activeTicket.id) && todoIds.includes(intakeTicket.id),
    'status=todo filtering for root tickets keeps matching the raw legacy status column, unaffected by this fix',
  );

  // 5 — child ticket status filtering is unchanged: get_my_tickets never
  // surfaces a child ticket (column_id is always null for children, so a
  // child row never survives the tool's innerJoin to `columns`) — proven
  // here with a child explicitly set to status='in_progress' and assigned
  // to the same agent, which still does not appear.
  const child = await mcp.callTool('create_child_ticket', {
    parent_id: activeTicket.id, title: 'subtask', status: 'in_progress', assignee_id: agent.id,
  });
  assert.ok(child?.id, JSON.stringify(child));
  const inProgressAfterChild = await mcp.callTool('get_my_tickets', {
    agent_id: agent.id, workspace_id: ws.id, status: 'in_progress',
  });
  assert.ok(
    !inProgressAfterChild.map((r) => r.id).includes(child.id),
    'child ticket status filtering is unchanged — it still never appears in get_my_tickets results',
  );
});

test.after(() => exitAfterTests());
