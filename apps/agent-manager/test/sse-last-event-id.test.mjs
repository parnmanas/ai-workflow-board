// SSE field parser + Last-Event-ID tracking (ticket a5ab95ea scope ①).
//
// `feedSse` is the pure line algorithm behind EventStream.#readStream. These
// tests pin: (a) event/data extraction, (b) chunk-split reassembly, and
// (c) Last-Event-ID semantics — the id persists across events, only advances
// on a dispatched (non-empty data) event, and is what a reconnect replays.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { feedSse, newSseParseState } from '../dist/lib/event-stream.js';

test('feedSse: extracts event type + data for a complete event', () => {
  const st = newSseParseState();
  const events = feedSse(st, 'event: agent_trigger\ndata: {"ticket_id":"t1"}\n\n');
  assert.deepEqual(events, [{ eventType: 'agent_trigger', data: '{"ticket_id":"t1"}' }]);
});

test('feedSse: tracks Last-Event-ID and advances it only on dispatch', () => {
  const st = newSseParseState();
  feedSse(st, 'id: 42\nevent: board_update\ndata: {"x":1}\n\n');
  assert.equal(st.lastEventId, '42', 'id of dispatched event remembered');

  // A new event with no id: line inherits the persisted id (SSE semantics).
  feedSse(st, 'event: board_update\ndata: {"x":2}\n\n');
  assert.equal(st.lastEventId, '42', 'id persists across events until changed');

  // A new id advances it.
  feedSse(st, 'id: 43\nevent: agent_trigger\ndata: {"y":1}\n\n');
  assert.equal(st.lastEventId, '43');
});

test('feedSse: id with no leading space is parsed', () => {
  const st = newSseParseState();
  feedSse(st, 'id:99\nevent: x\ndata: {"a":1}\n\n');
  assert.equal(st.lastEventId, '99');
});

test('feedSse: empty id: line resets the current id (but lastEventId only moves on dispatch)', () => {
  const st = newSseParseState('7');
  // Reset current id, then dispatch — the dispatched event has an empty id.
  feedSse(st, 'id:\nevent: x\ndata: {"a":1}\n\n');
  assert.equal(st.lastEventId, '', 'reset id propagates to the dispatched event');
});

test('feedSse: keepalive/comment-less data without id keeps prior id', () => {
  const st = newSseParseState('5');
  // ping events carry data but the AWB server stamps no id — must not clobber.
  feedSse(st, 'event: ping\ndata: {"ts":123}\n\n');
  assert.equal(st.lastEventId, '5', 'no id line → keep the resume point');
});

test('feedSse: reassembles an event split across two chunks', () => {
  const st = newSseParseState();
  let events = feedSse(st, 'event: agent_trigger\ndata: {"tic');
  assert.equal(events.length, 0, 'partial event yields nothing yet');
  events = feedSse(st, 'ket_id":"t1"}\n\n');
  assert.deepEqual(events, [{ eventType: 'agent_trigger', data: '{"ticket_id":"t1"}' }]);
});

test('feedSse: blank data is not dispatched and does not advance the id', () => {
  const st = newSseParseState('3');
  const events = feedSse(st, 'id: 4\ndata: \n\n');
  assert.equal(events.length, 0, 'empty data line dispatches nothing');
  assert.equal(st.lastEventId, '3', 'id only advances on a real dispatch');
});

test('feedSse: multiple events in one chunk each dispatch; lastEventId ends on the last', () => {
  const st = newSseParseState();
  const events = feedSse(
    st,
    'id: 1\nevent: a\ndata: {"n":1}\n\nid: 2\nevent: b\ndata: {"n":2}\n\n',
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { eventType: 'a', data: '{"n":1}' });
  assert.deepEqual(events[1], { eventType: 'b', data: '{"n":2}' });
  assert.equal(st.lastEventId, '2');
});
