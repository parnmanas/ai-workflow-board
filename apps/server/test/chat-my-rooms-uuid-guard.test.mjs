// Regression guard — the chat "My rooms" list (RoomCrudService.listRooms) must
// LOAD even when a room the caller can see also carries the synthetic 'system'
// participant / sender.
//
// Ticket 7fa0e6d7, follow-up of 75a4c9f1. listRooms is the twin of
// listAllWorkspaceRooms: it bulk-resolves participant + last-message-sender
// names via `userRepo.findByIds([...])` / `agentRepo.findByIds([...])`.
// participant_id / sender_id are plain varchar and can legitimately hold the
// synthetic 'system' author QA/Action dispatch seeds (qa-run.service.ts:229-235),
// but users.id / agents.id are uuid columns — so on Postgres a `WHERE id IN
// (..., 'system')` aborts the WHOLE query with `invalid input syntax for type
// uuid: "system"`, 500-ing "My rooms" exactly like the observer view did. sql.js
// is permissive (no uuid cast) so dev never saw it — a Postgres-only crash.
//
// Today this is LATENT for listRooms, not active: listRooms' innerJoin only
// surfaces rooms where the CALLER is a `user` participant, and a QA room's sole
// user participant is 'system' itself, so no real person can pull a 'system'
// room into their list. This test drives the future/defense-in-depth case a
// real person co-existing with 'system' in one room (multi-user chat is under
// active development) and pins the guard so the twin can't regress.
//
// Mirrors chat-observer-uuid-guard.test.mjs: a fake repo whose findByIds THROWS
// on any non-uuid id reproduces the Postgres cast deterministically on any
// runtime. Imports the compiled service from dist/ (built by `npm run build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomCrudService } from '../dist/modules/chat-rooms/room-crud.service.js';

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const WS = 'aaaaaaaa-1111-4111-8111-111111111111';
const ROOM_QA = 'bbbbbbbb-2222-4222-8222-222222222222';
const USER_UUID = 'cccccccc-3333-4333-8333-333333333333';
const AGENT_UUID = 'dddddddd-4444-4444-8444-444444444444';

// A no-op QueryBuilder that ignores the (SQL-level) filters and returns the
// seeded rows — the method does its own in-memory grouping by room_id, which is
// the logic under test. roomRepo needs getRawAndEntities (listRooms projects
// unread_count / cleared_at into raw); participant/message repos use getMany.
// The real uuid/varchar filtering happens in SQL, mocked via findByIds below.
function listQb(rows, raws) {
  const o = {
    innerJoin: () => o,
    leftJoin: () => o,
    where: () => o,
    andWhere: () => o,
    addSelect: () => o,
    orderBy: () => o,
    getMany: async () => rows,
    getRawAndEntities: async () => ({ entities: rows, raw: raws || rows.map(() => ({})) }),
  };
  return o;
}
const repoWithRows = (rows, raws) => ({ createQueryBuilder: () => listQb(rows, raws) });

// Mimic a Postgres uuid column: a non-uuid literal anywhere in `WHERE id IN (…)`
// aborts the whole query, exactly as PG does for `invalid input syntax for type
// uuid`. Records the ids it was asked for so a test can assert 'system' was
// filtered out before it ever reached the column.
function pgUuidRepo(rows, calls) {
  return {
    findByIds: async (ids) => {
      calls.push([...ids]);
      for (const id of ids) {
        if (id == null || !UUID_RE.test(String(id))) {
          throw new Error(`invalid input syntax for type uuid: "${id}"`);
        }
      }
      return rows.filter((r) => ids.includes(r.id));
    },
    // resolveAgentDisplayMap(agentRepo, list) calls agentRepo.find only when an
    // agent has a manager_agent_id; the seeded agent has none, so this is unused
    // — present defensively so a future manager-carrying fixture won't crash.
    find: async () => [],
  };
}

function makeService(calls) {
  const rooms = [
    { id: ROOM_QA, type: 'group', name: 'QA: probe · abcdef01', workspace_id: WS, action_id: null, last_message_at: new Date() },
  ];
  // The per-room raw projection listRooms reads: unread_count (COUNT string) and
  // cleared_at (null = no Clear cutoff, so the last-message preview survives).
  const raws = rooms.map(() => ({ unread_count: '0', cleared_at: null }));
  // A room the caller (USER_UUID) is a member of that ALSO carries the synthetic
  // 'system' user participant + a 'system'-authored last message — the future
  // co-existence case listRooms' innerJoin doesn't rule out for good.
  const participants = [
    { room_id: ROOM_QA, participant_type: 'agent', participant_id: AGENT_UUID, left_at: null },
    { room_id: ROOM_QA, participant_type: 'user', participant_id: USER_UUID, left_at: null },
    { room_id: ROOM_QA, participant_type: 'user', participant_id: 'system', left_at: null },
  ];
  const messages = [
    { room_id: ROOM_QA, sender_type: 'system', sender_id: 'system', content: 'QA dispatch', created_at: new Date() },
  ];
  const userRepo = pgUuidRepo([{ id: USER_UUID, name: 'Alice', email: 'a@x' }], calls.user);
  const agentRepo = pgUuidRepo([{ id: AGENT_UUID, name: 'BuildBot', manager_agent_id: null }], calls.agent);
  // ctor: (roomRepo, participantRepo, messageRepo, userRepo, agentRepo, logService, membership)
  // membership.toText is the only membership call listRooms makes (SQL dialect
  // helper) — stub it to pass the column expression through unchanged.
  return new RoomCrudService(
    repoWithRows(rooms, raws),
    repoWithRows(participants),
    repoWithRows(messages),
    userRepo,
    agentRepo,
    null,
    { toText: (c) => c },
  );
}

test('listRooms does not feed the synthetic "system" id to a uuid column', async () => {
  const calls = { user: [], agent: [] };
  const svc = makeService(calls);

  // Before the fix this awaited userRepo.findByIds([USER_UUID, 'system']) and
  // the pg-uuid mock threw — "My rooms" 500'd for the co-existing member.
  const rooms = await svc.listRooms(WS, USER_UUID);

  assert.equal(rooms.length, 1, 'the room must still be returned');
  const flatUserIds = calls.user.flat();
  assert.ok(flatUserIds.includes(USER_UUID), 'the real user id must still be resolved via findByIds');
  assert.ok(!flatUserIds.includes('system'), "the synthetic 'system' id must be filtered out before findByIds");
});

test("the synthetic 'system' participant + sender resolve to 'System', real members keep their names", async () => {
  const calls = { user: [], agent: [] };
  const svc = makeService(calls);
  const [room] = await svc.listRooms(WS, USER_UUID);

  const names = room.participants.map((p) => p.name).sort();
  assert.deepEqual(names, ['Alice', 'BuildBot', 'System']);
  assert.equal(
    room.last_message_preview,
    'System: QA dispatch',
    "the 'system'-authored last message preview renders the sender as System",
  );
});
