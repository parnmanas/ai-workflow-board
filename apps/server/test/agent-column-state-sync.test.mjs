import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers/boot.mjs';
import { setupKanbanScene, createTicket } from './helpers/fixtures.mjs';
import { loadTicketFull } from '../dist/modules/mcp/shared/ticket-parsing.js';
import { EVENT_TYPES } from '../dist/modules/events/event-registry.js';

const { app, modules } = await bootApp({ port: 7896 });
after(() => { void app.close().catch(() => {}); });
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
