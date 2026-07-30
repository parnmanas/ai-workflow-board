import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseTicket, withTicketTreeArtifactRefs } from '../dist/modules/mcp/shared/ticket-parsing.js';

const rootId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';

test('get/create shared ticket projection names root and children with full UUID refs', () => {
  const result = withTicketTreeArtifactRefs({
    id: rootId,
    title: 'Root ticket',
    children: [{ id: childId, title: 'Child ticket', children: [] }],
  });
  assert.equal(result._ref, `#[ticket:${rootId}|Root ticket]`);
  assert.equal(result.children[0]._ref, `#[ticket:${childId}|Child ticket]`);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /#\[ticket:(?:11111111|22222222)\|/);
});

test('list projection uses the same named full-UUID ref contract', () => {
  const result = parseTicket({
    id: rootId,
    title: 'Listed ticket',
    labels: '[]',
    channel_ids: '[]',
    on_done_action_ids: '[]',
    handoff_spec: '',
  });
  assert.equal(result._ref, `#[ticket:${rootId}|Listed ticket]`);
  assert.doesNotMatch(result._ref, /#\[ticket:11111111\|/);
});

test('representative MCP get, create, and list paths use the canonical serializers', () => {
  const source = fs.readFileSync(new URL('../src/modules/mcp/tools/ticket-crud-tools.ts', import.meta.url), 'utf8');
  assert.match(source, /'get_ticket'[\s\S]*?loadTicketFull\(dataSource, ticket_id\)/);
  assert.match(source, /'create_ticket'[\s\S]*?const full = await loadTicketFull\(dataSource, ticket\.id\)/);
  assert.match(source, /return ok\(tickets\.map\(t =>[\s\S]*?\.\.\.parseTicket\(t\)/);
});
