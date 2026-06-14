// One-shot SubagentManager dedup — the fallback path that runs when the
// persistent ticket-session path declines (cap_busy / spawn_failed / error).
//
// Covers ticket a5ab95ea scope ①, fallback half: `findDuplicateSpawn` must
// catch a second concurrent spawn for the same (ticket, role) even when the
// trigger carried an empty triggerId (field_changed-empty agent_trigger), so
// the one-shot fallback can't twin-spawn either. The pure helper is exercised
// directly so no CLI child is forked.
//
// Ticket 66bddd2e (VEG-R2-5 race) widened the (ticket, role) rule into a true
// single-flight guard: it now collapses a second spawn onto a live strand
// REGARDLESS of triggerId — two DISTINCT non-empty trigger ids for the same
// (ticket, role) seconds apart no longer twin-spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findDuplicateSpawn } from '../dist/lib/subagent-manager.js';

test('subagent dedup: unique trigger spawn is not a duplicate', () => {
  const records = [];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't1',
    ticketId: 'ticket-a',
    role: 'assignee',
  });
  assert.equal(res, false);
});

test('subagent dedup: same non-empty triggerId is duplicate_trigger', () => {
  const records = [{ trigger_id: 't1', ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't1',
    ticketId: 'ticket-a',
    role: 'assignee',
  });
  assert.equal(res, 'duplicate_trigger');
});

test('subagent dedup: catches an in-flight RESERVATION (identity-bearing) for same trigger', () => {
  // Reservation records now carry identity; the dedup scan must see them so a
  // concurrent spawn collapses during the spawn window, before the real
  // SubagentRecord lands.
  const records = [
    { trigger_id: 't9', chat_request_id: null, ticket_id: 'ticket-z', role: 'reviewer' },
  ];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't9',
    ticketId: 'ticket-z',
    role: 'reviewer',
  });
  assert.equal(res, 'duplicate_trigger');
});

test('subagent dedup: DISTINCT non-empty triggerId collapses on a live (ticket, role) strand', () => {
  // Ticket 66bddd2e (VEG-R2-5 race): two DIFFERENT non-empty trigger ids for
  // the same (ticket, role) arriving seconds apart must NOT twin-spawn while a
  // strand is alive. The live one-shot record carries trigger_id 't-old'; a
  // fresh trigger 't-new' for the same (ticket, role) is a single-flight
  // duplicate even though the ids differ (rule 1 would miss it).
  const records = [{ trigger_id: 't-old', ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't-new',
    ticketId: 'ticket-a',
    role: 'assignee',
  });
  assert.equal(res, 'duplicate_trigger', 'single-flight collapses distinct trigger id on live (ticket, role)');
});

test('subagent dedup: DISTINCT triggerId, DIFFERENT role still spawns (no false single-flight)', () => {
  // Single-flight is per (ticket, role): a reviewer trigger must still spawn
  // even while an assignee strand for the same ticket is alive.
  const records = [{ trigger_id: 't-old', ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: 't-new',
    ticketId: 'ticket-a',
    role: 'reviewer',
  });
  assert.equal(res, false, 'distinct role is a separate strand');
});

test('subagent dedup: EMPTY triggerId collapses on matching (ticket, role)', () => {
  const records = [{ trigger_id: null, ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: '', // field_changed-empty agent_trigger
    ticketId: 'ticket-a',
    role: 'assignee',
  });
  assert.equal(res, 'duplicate_trigger', 'fallback (ticket, role) dedup fires');
});

test('subagent dedup: EMPTY triggerId, DIFFERENT role does NOT collapse', () => {
  const records = [{ trigger_id: null, ticket_id: 'ticket-a', role: 'reviewer' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: '',
    ticketId: 'ticket-a',
    role: 'assignee', // different role → separate session, must spawn
  });
  assert.equal(res, false, 'role isolation preserved');
});

test('subagent dedup: EMPTY triggerId, DIFFERENT ticket does NOT collapse', () => {
  const records = [{ trigger_id: null, ticket_id: 'ticket-a', role: 'assignee' }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: '',
    ticketId: 'ticket-b',
    role: 'assignee',
  });
  assert.equal(res, false);
});

test('subagent dedup: (ticket, role) fallback does NOT apply to chat spawns', () => {
  // Chat spawns carry no role; an empty-key chat spawn must never merge onto a
  // ticket record sharing the same blank role.
  const records = [{ trigger_id: null, ticket_id: 'ticket-a', role: null }];
  const res = findDuplicateSpawn(records, {
    kind: 'chat',
    triggerId: '',
    ticketId: 'ticket-a',
    role: '',
  });
  assert.equal(res, false, 'chat kind is exempt from the ticket-role fallback');
});

test('subagent dedup: same chatRequestId is duplicate_chat', () => {
  const records = [{ chat_request_id: 'msg:u1:ts', ticket_id: null, role: null }];
  const res = findDuplicateSpawn(records, {
    kind: 'chat',
    chatRequestId: 'msg:u1:ts',
  });
  assert.equal(res, 'duplicate_chat');
});

test('subagent dedup: role compared as empty-vs-empty (null === "")', () => {
  // A record with role=null and a spec with role='' (both "no role") must be
  // treated as the same role for the empty-triggerId fallback.
  const records = [{ trigger_id: null, ticket_id: 'ticket-a', role: null }];
  const res = findDuplicateSpawn(records, {
    kind: 'trigger',
    triggerId: '',
    ticketId: 'ticket-a',
    role: '',
  });
  assert.equal(res, 'duplicate_trigger');
});
