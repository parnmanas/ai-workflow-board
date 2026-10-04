// Regression guard for the Run-on-Done reorder save bug (ticket 59afc55a).
//
// on_done_action_ids is a SEQUENCE — its array order is the dispatch order —
// so a pure reorder (same id set, different positions) must register as a
// dirty ticket field, otherwise TicketPanel's Save button never enables and
// the new order is silently dropped (criterion b).
//
// The original code reused the channel-id comparator, which sorts both arrays
// before comparing and is therefore order-INSENSITIVE. This test pins the
// difference against the real helpers the panel uses
// (src/components/ticketPanel/ticketDraft.ts).
//
// 실행:  node --import tsx --test apps/client/test/on-done-reorder-dirty.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDirtyTicketFields,
  draftFromTicket,
  idsEqualOrdered,
  idsEqualUnordered,
  moveItem,
} from '../src/components/ticketPanel/ticketDraft.ts';

const ticket = (on_done_action_ids) => ({
  title: 'T',
  description: '',
  priority: 'medium',
  tags: [],
  project_id: null,
  base_branch: '',
  assignee: null,
  channel_ids: [],
  next_ticket_id: null,
  on_done_action_ids,
});

// Mirrors how the panel decides the field is dirty: the full draft diff.
const onDoneDirty = (draftIds, savedIds) => {
  const saved = ticket(savedIds);
  const draft = { ...draftFromTicket(saved), onDoneActionIds: draftIds };
  return 'on_done_action_ids' in computeDirtyTicketFields(draft, saved);
};

test('reorder-only change is flagged dirty (criterion b)', () => {
  const saved = ['a', 'b', 'c'];
  const reordered = ['c', 'a', 'b'];

  // The bug: the sorted comparator treats a reorder as a no-op.
  assert.equal(idsEqualUnordered(reordered, saved), true,
    'precondition: order-insensitive compare masks the reorder');
  assert.equal(idsEqualOrdered(reordered, saved), false);

  // The fix: order-sensitive compare sees the change → field is dirty → Save enables.
  assert.equal(onDoneDirty(reordered, saved), true,
    'reorder-only must be dirty so update_ticket persists the new order');
});

test('the ↑/↓ buttons produce a reorder the draft diff picks up', () => {
  const saved = ['a', 'b', 'c'];
  const movedDown = moveItem(saved, 0, 1);
  assert.deepEqual(movedDown, ['b', 'a', 'c']);
  assert.equal(onDoneDirty(movedDown, saved), true);
  // Out-of-range moves are no-ops (same array back).
  assert.equal(moveItem(saved, 0, -1), saved);
  assert.equal(moveItem(saved, 2, 3), saved);
});

test('identical order is NOT dirty (no spurious saves)', () => {
  assert.equal(onDoneDirty(['a', 'b', 'c'], ['a', 'b', 'c']), false);
});

test('add / remove / clear still register as dirty', () => {
  assert.equal(onDoneDirty(['a', 'b'], ['a']), true, 'append');
  assert.equal(onDoneDirty(['a'], ['a', 'b']), true, 'remove');
  assert.equal(onDoneDirty([], ['a', 'b']), true, 'clear');
});

test('null/undefined saved value is treated as empty', () => {
  assert.equal(onDoneDirty([], undefined), false);
  assert.equal(onDoneDirty(['a'], undefined), true);
});
