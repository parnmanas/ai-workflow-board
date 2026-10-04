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
    tags: '["ui"]',
    channel_ids: '[]',
    on_done_action_ids: '[]',
    assignee: null,
  });
  assert.equal(result._ref, `#[ticket:${rootId}|Listed ticket]`);
  assert.doesNotMatch(result._ref, /#\[ticket:11111111\|/);
  assert.deepEqual(result.tags, ['ui']);
});

const crudSource = fs.readFileSync(new URL('../src/modules/mcp/tools/ticket-crud-tools.ts', import.meta.url), 'utf8');

/** Body of one `server.tool('<name>', …)` registration, up to the next one. */
function toolBody(name) {
  const start = crudSource.indexOf(`'${name}',`);
  assert.ok(start >= 0, `${name} is registered`);
  const next = crudSource.indexOf('server.tool(', start);
  return crudSource.slice(start, next < 0 ? undefined : next);
}

test('representative MCP get and create paths use the canonical serializer', () => {
  assert.match(toolBody('get_ticket'), /loadTicketFull\(dataSource, ticket_id\)/);
  assert.match(toolBody('create_ticket'), /const full = await loadTicketFull\(dataSource, ticket\.id\)/);
});

test('MCP list paths give every row the canonical ticket ref', () => {
  for (const name of ['list_tickets', 'get_my_tickets']) {
    assert.match(toolBody(name), /withArtifactRef\('ticket'|parseTicket\(|withTicketTreeArtifactRefs\(/, `${name} rows carry _ref`);
  }
});
