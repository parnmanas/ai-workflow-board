// Unit test — F-1 (ticket 24694916) mechanical ticket-action card capture.
//
// Proves the "누락 없이" capture math: given the CLI stream's tool_use + tool_result
// blocks, the right ticket ref is produced for every tracked action, the ticket id
// is resolved from the CORRECT source (result.id for creates, input ticket_id for
// existing-ticket actions — never a comment id), and reads/errors never emit a card.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bareToolName,
  trackedTicketTool,
  parseStreamToolResult,
  harvestTicketTitles,
  resolveTicketRef,
  formatTicketRefsContent,
} from '../dist/lib/ticket-ref-capture.js';

test('bareToolName strips the MCP server prefix, tolerating any prefix', () => {
  assert.equal(bareToolName('mcp__awb__create_ticket'), 'create_ticket');
  assert.equal(bareToolName('mcp__ai-workflow-board__move_ticket'), 'move_ticket');
  assert.equal(bareToolName('Bash'), 'Bash'); // no `__` → unchanged
});

test('trackedTicketTool: mutating ticket tools tracked, reads/other tools ignored', () => {
  const create = trackedTicketTool('mcp__awb__create_ticket', { title: 'New', priority: 'high' });
  assert.deepEqual(create, { action: 'create', fromResult: true, inputTicketId: undefined, inputTitle: 'New' });

  const move = trackedTicketTool('mcp__awb__move_ticket', { ticket_id: 'T-1', target_column_name: 'Review' });
  assert.deepEqual(move, { action: 'move', fromResult: false, inputTicketId: 'T-1', inputTitle: undefined });

  // Reads + non-ticket + the final reply tool must NOT be tracked (no card noise).
  assert.equal(trackedTicketTool('mcp__awb__get_ticket', { ticket_id: 'T-1' }), null);
  assert.equal(trackedTicketTool('mcp__awb__list_actions', {}), null);
  assert.equal(trackedTicketTool('mcp__awb__send_chat_room_message', { room_id: 'R' }), null);
  assert.equal(trackedTicketTool('mcp__awb__delete_ticket', { ticket_id: 'T-1' }), null); // excluded (would 404)
  assert.equal(trackedTicketTool('Bash', { command: 'ls' }), null);
  assert.equal(trackedTicketTool(undefined, {}), null);
});

test('parseStreamToolResult handles string, text-block array, and junk', () => {
  assert.deepEqual(parseStreamToolResult('{"id":"T-1","title":"X"}'), { id: 'T-1', title: 'X' });
  assert.deepEqual(
    parseStreamToolResult([{ type: 'text', text: '{"ticket_id":"T-2"}' }]),
    { ticket_id: 'T-2' },
  );
  assert.equal(parseStreamToolResult('not json'), null);
  assert.equal(parseStreamToolResult([{ type: 'image' }]), null);
  assert.equal(parseStreamToolResult(undefined), null);
});

test('harvestTicketTitles collects {id,title} from ticket / array / children shapes', () => {
  assert.deepEqual(harvestTicketTitles({ id: 'T-1', title: 'One', status: 'todo' }), [{ id: 'T-1', title: 'One' }]);
  assert.deepEqual(
    harvestTicketTitles([{ id: 'A', title: 'a' }, { id: 'B', title: 'b' }, { nope: 1 }]),
    [{ id: 'A', title: 'a' }, { id: 'B', title: 'b' }],
  );
  assert.deepEqual(
    harvestTicketTitles({ id: 'P', title: 'parent', children: [{ id: 'C', title: 'child' }] }),
    [{ id: 'P', title: 'parent' }, { id: 'C', title: 'child' }],
  );
  // A comment result ({id, ticket_id, content} — no title) must NOT pollute the cache.
  assert.deepEqual(harvestTicketTitles({ id: 'CMT-1', ticket_id: 'T-9', content: 'hi' }), []);
  assert.deepEqual(harvestTicketTitles('str'), []);
});

test('resolveTicketRef CREATE: ticket id + title come from the result object', () => {
  const ctx = trackedTicketTool('mcp__awb__create_ticket', { title: 'New One' });
  const ref = resolveTicketRef(ctx, { id: 'T-new', title: 'New One', status: 'todo' }, false);
  assert.deepEqual(ref, { action: 'create', ticket_id: 'T-new', title: 'New One' });
});

test('resolveTicketRef add_comment: uses INPUT ticket_id, never the comment result id', () => {
  const ctx = trackedTicketTool('mcp__awb__add_comment', { ticket_id: 'T-real', content: 'hi' });
  // add_comment returns the COMMENT (its own id + ticket_id, no title).
  const result = { id: 'CMT-xyz', ticket_id: 'T-real', content: 'hi', author: 'agent' };
  const ref = resolveTicketRef(ctx, result, false, (id) => (id === 'T-real' ? '실제 티켓' : undefined));
  // The card must point at the TICKET, not the comment id, and pull the title from the cache.
  assert.deepEqual(ref, { action: 'comment', ticket_id: 'T-real', title: '실제 티켓' });
});

test('resolveTicketRef move: input ticket_id authoritative, title from result', () => {
  const ctx = trackedTicketTool('mcp__awb__move_ticket', { ticket_id: 'T-7' });
  const ref = resolveTicketRef(ctx, { id: 'T-7', title: 'Moved', column_id: 'c' }, false);
  assert.deepEqual(ref, { action: 'move', ticket_id: 'T-7', title: 'Moved' });
});

test('resolveTicketRef title fallback: cache → inputTitle → undefined', () => {
  const ctx = trackedTicketTool('mcp__awb__claim_ticket', { ticket_id: 'T-8' });
  // claim result has no title; cache miss + no input title → title omitted, card still emitted.
  const noTitle = resolveTicketRef(ctx, { claimed: true, ticket_id: 'T-8' }, false);
  assert.deepEqual(noTitle, { action: 'claim', ticket_id: 'T-8' });
  // cache hit supplies the title.
  const cached = resolveTicketRef(ctx, { claimed: true, ticket_id: 'T-8' }, false, () => '캐시 제목');
  assert.deepEqual(cached, { action: 'claim', ticket_id: 'T-8', title: '캐시 제목' });
});

test('resolveTicketRef returns null on error result or unresolvable ticket id', () => {
  const move = trackedTicketTool('mcp__awb__move_ticket', { ticket_id: 'T-1' });
  assert.equal(resolveTicketRef(move, { id: 'T-1', title: 'X' }, true), null, 'errored action → no card');
  const create = trackedTicketTool('mcp__awb__create_ticket', { title: 'X' });
  assert.equal(resolveTicketRef(create, { message: 'no id here' }, false), null, 'create with no result id → no card');
  const orphanMove = trackedTicketTool('mcp__awb__update_ticket', {}); // no input ticket_id
  assert.equal(resolveTicketRef(orphanMove, { message: 'nope' }, false), null, 'existing action with no id → no card');
});

test('formatTicketRefsContent renders Korean action labels as the text fallback', () => {
  const content = formatTicketRefsContent([
    { action: 'create', ticket_id: 'T-1', title: '새 티켓' },
    { action: 'move', ticket_id: 'T-2', title: '옮긴 티켓' },
    { action: 'weird', ticket_id: 'T-3' }, // unknown action → raw code; no title → id
  ]);
  assert.equal(
    content,
    '📋 티켓 생성: 새 티켓\n📋 티켓 이동: 옮긴 티켓\n📋 티켓 weird: T-3',
  );
});
