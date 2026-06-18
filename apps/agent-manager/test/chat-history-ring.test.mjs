// Regression test — mem-leak v2 (f500ee56): ChatSessionManager.#historyRing
// must stay bounded. The per-room array was always capped (#HISTORY_MAX), but
// the MAP itself grew one bucket per distinct room ever seen, forever. Two
// mechanisms bound it now:
//   (a) recordRoomMessage LRU-caps the map at #ROOMS_MAX (200), evicting the
//       least-recently-active room.
//   (b) _onChildExit evicts a room's bucket once no live session references it.
//
// We drive the real ChatSessionManager with a minimal config (no network — the
// paths exercised here never call REST) and assert through the `_historyRooms`
// test seam. `_onChildExit` is invoked with agentId undefined so it returns at
// the agent-id guard before any postChatRoomMessage fallback fires.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionManager } from '../dist/lib/chat-session-manager.js';

function makeManager() {
  // Minimal SessionAwareConfig — only stored, not dialed, on these code paths.
  return new ChatSessionManager({
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    delegation: {},
  });
}

function roomMsg(rid) {
  return { room_id: rid, type: 'message', sender_type: 'user', content: 'hi ' + rid };
}

test('recordRoomMessage caps the map at #ROOMS_MAX, evicting oldest rooms', () => {
  const mgr = makeManager();
  for (let i = 0; i < 250; i++) mgr.recordRoomMessage(roomMsg('r' + i));

  const rooms = mgr._historyRooms();
  assert.equal(rooms.length, 200, 'map bounded at 200 rooms');
  // The first 50 (oldest) were evicted; the most recent 200 remain.
  assert.ok(!rooms.includes('r0'), 'oldest room evicted');
  assert.ok(!rooms.includes('r49'), 'oldest rooms evicted');
  assert.ok(rooms.includes('r50'), 'room just inside the window kept');
  assert.ok(rooms.includes('r249'), 'most recent room kept');
});

test('a re-touched room survives eviction (LRU, not FIFO)', () => {
  const mgr = makeManager();
  for (let i = 0; i < 200; i++) mgr.recordRoomMessage(roomMsg('r' + i)); // exactly at cap
  assert.equal(mgr._historyRooms().length, 200);

  // Touch the oldest room — it should jump to most-recently-used.
  mgr.recordRoomMessage(roomMsg('r0'));
  // Insert one new room, forcing a single eviction.
  mgr.recordRoomMessage(roomMsg('r200'));

  const rooms = mgr._historyRooms();
  assert.equal(rooms.length, 200);
  assert.ok(rooms.includes('r0'), 'touched room survived (LRU)');
  assert.ok(!rooms.includes('r1'), 'the now-oldest room was evicted instead');
  assert.ok(rooms.includes('r200'), 'new room inserted');
});

test('_onChildExit evicts a room bucket when no live session references it', async () => {
  const mgr = makeManager();
  mgr.recordRoomMessage(roomMsg('room-A'));
  assert.deepEqual(mgr._historyRooms(), ['room-A']);

  // No session left in the room → bucket evicted. agentId undefined keeps the
  // hook from attempting a REST fallback post.
  await mgr._onChildExit({ pid: 1234, roomId: 'room-A' }, 0, null);
  assert.deepEqual(mgr._historyRooms(), [], 'bucket removed when the room session ends');
});

test('_onChildExit keeps the bucket while a sibling session shares the room', async () => {
  const mgr = makeManager();
  mgr.recordRoomMessage(roomMsg('room-A'));

  // A second managed agent still has a live session in the same room.
  mgr._sessions.set('room-A|other-agent', { roomId: 'room-A', agentId: 'other-agent', pid: 999 });

  // agentId omitted so the hook returns at the agent-id guard (no REST
  // fallback). The eviction check keys off roomId + session identity only.
  await mgr._onChildExit({ pid: 1234, roomId: 'room-A' }, 0, null);
  assert.deepEqual(
    mgr._historyRooms(),
    ['room-A'],
    'bucket retained for the still-live sibling session',
  );
});
