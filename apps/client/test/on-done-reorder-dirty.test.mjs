// Regression guard for the Run-on-Done reorder save bug (ticket 59afc55a).
//
// on_done_action_ids is a SEQUENCE — its array order is the dispatch order —
// so a pure reorder (same id set, different positions) must register as a
// dirty ticket field, otherwise TicketPanel's Save button never enables and
// the new order is silently dropped (criterion b).
//
// The original code reused `channelIdsEqual`, which sorts both arrays before
// comparing and is therefore order-INSENSITIVE. This test pins the difference:
// the order-sensitive comparator must flag a reorder-only change as dirty,
// while the order-insensitive one masks it.
//
// These helpers mirror TicketPanel.tsx verbatim. Keep them in sync.

import test from 'node:test';
import assert from 'node:assert/strict';

// Order-INSENSITIVE — correct for channel_ids (a set), wrong for on_done order.
const channelIdsEqual = (a, b) => {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
};

// Order-SENSITIVE — what on_done_action_ids must use.
const idsEqualOrdered = (a, b) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// Mirrors the on_done_action_ids branch of TicketPanel's dirtyTicketFields.
const onDoneDirty = (draft, saved) => !idsEqualOrdered(draft, saved || []);

test('reorder-only change is flagged dirty (criterion b)', () => {
  const saved = ['a', 'b', 'c'];
  const reordered = ['c', 'a', 'b'];

  // The bug: the old sorted comparator treats a reorder as a no-op.
  assert.equal(channelIdsEqual(reordered, saved), true,
    'precondition: order-insensitive compare masks the reorder');

  // The fix: order-sensitive compare sees the change → field is dirty → Save enables.
  assert.equal(onDoneDirty(reordered, saved), true,
    'reorder-only must be dirty so update_ticket persists the new order');
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
