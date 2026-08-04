import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createColumn,
  createTicket,
} from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { loadTicketFull } from '../dist/modules/mcp/shared/ticket-parsing.js';
import { EVENT_TYPES } from '../dist/modules/events/event-registry.js';

const { app, modules, port } = await bootApp({ port: 7896 });
after(async () => { await app.close(); });
const ds = app.get(modules.getDataSourceToken());

test('get_ticket snapshot names the authoritative current column', async () => {
  const { ws, columns } = await setupKanbanScene(app, modules.getDataSourceToken, { workspaceName: 'column-state' });
  const ticket = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'column snapshot',
  });
  const full = await loadTicketFull(ds, ticket.id);
  assert.equal(full.current_column_id, columns.todo.id);
  assert.equal(full.current_column_name, columns.todo.name);
  assert.equal(full.current_column_kind, columns.todo.kind);
});

test('get_ticket root in Merging ignores legacy todo status', async () => {
  const { ws, board } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'column-state-merging',
  });
  const merging = await createColumn(app, modules.getDataSourceToken, board.id, {
    name: 'Merging',
    position: 5,
    workspaceId: ws.id,
    kind: 'merging',
    roleRouting: [],
  });
  const ticket = await createTicket(app, modules.getDataSourceToken, {
    columnId: merging.id,
    workspaceId: ws.id,
    title: 'legacy todo while merging',
  });
  assert.equal(ticket.status, 'todo', 'fixture preserves the incident legacy value');
  const child = await createTicket(app, modules.getDataSourceToken, {
    columnId: null,
    workspaceId: ws.id,
    parentId: ticket.id,
    depth: 1,
    title: 'completed child',
  });
  await ds.getRepository('Ticket').update(child.id, { status: 'done' });
  const agent = await createAgent(app, modules.getDataSourceToken, ws.id, {
    name: 'column-state-reader',
  });
  const key = await createApiKey(app, modules.getDataSourceToken, agent.id, {
    workspaceId: ws.id,
    scope: 'full',
  });
  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  await mcp.initialize();

  const response = await mcp.callTool('get_ticket', { ticket_id: ticket.id });
  assert.equal(response.column_id, merging.id);
  assert.equal(response.current_column_id, merging.id);
  assert.equal(response.current_column_name, 'Merging');
  assert.equal(response.current_column_kind, 'merging');
  assert.equal(response.legacy_status, 'todo');
  assert.equal(Object.hasOwn(response, 'status'), false);
  assert.equal(response.children.length, 1);
  assert.equal(response.children[0].id, child.id);
  assert.equal(response.children[0].status, 'done');
  assert.equal(Object.hasOwn(response.children[0], 'legacy_status'), false);
});

test('board_update maps and flattens current and previous column names', async () => {
  const def = EVENT_TYPES.find((entry) => entry.eventType === 'board_update');
  const mapped = await def.map({
    ticket_id: 'ticket-1', entity_id: 'ticket-1', entity_type: 'ticket', action: 'moved',
    field_changed: 'column_id', actor_name: 'Alice', old_value: 'In Progress', new_value: 'Review',
  }, {
    resolveBoardId: async () => 'board-1', resolveTicketRepositoryResourceId: async () => '',
    resolveActorDisplayName: async () => null,
    resolveTicketColumnSnapshot: async () => ({ id: 'column-review', name: 'Review', kind: 'review' }),
  });
  const flat = def.flatten({
    event_type: 'board_update', scope: mapped.scope, payload: mapped.payload,
    timestamp: '2026-08-03T00:00:00.000Z',
  });
  assert.equal(flat.current_column_id, 'column-review');
  assert.equal(flat.current_column_name, 'Review');
  assert.equal(flat.current_column_kind, 'review');
  assert.equal(flat.previous_column_name, 'In Progress');
  assert.equal(flat.new_column_name, 'Review');
});

test('agent_trigger maps and flattens authoritative current column fields', () => {
  const def = EVENT_TYPES.find((entry) => entry.eventType === 'agent_trigger');
  const mapped = def.map({
    trigger_id: 'trigger-1', ticket_id: 'ticket-1', agent_id: 'agent-1', role: 'reviewer',
    current_column_id: 'column-review', current_column_name: 'Review', current_column_kind: 'review',
  });
  const flat = def.flatten({
    event_type: 'agent_trigger', scope: mapped.scope, payload: mapped.payload,
    timestamp: '2026-08-03T00:00:00.000Z',
  });
  assert.equal(flat.current_column_id, 'column-review');
  assert.equal(flat.current_column_name, 'Review');
  assert.equal(flat.current_column_kind, 'review');
});
