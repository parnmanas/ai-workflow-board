// Regression guard — the chat "All rooms" observer view must LOAD even when a
// workspace room carries the synthetic 'system' participant.
//
// Ticket 75a4c9f1 ("채팅 All rooms 보기 로드 실패"). Root cause: QaRunService
// .startQaRun seeds every QA-run room with a synthetic participant
// `('user', 'system')` (qa-run.service.ts:229-235; ActionsService does the same
// for scheduler runs). Those rooms have action_id IS NULL, so the observer view
// RoomCrudService.listAllWorkspaceRooms — unlike per-user listRooms — surfaces
// them regardless of membership. It then bulk-resolved participant names via
// `userRepo.findByIds([... , 'system'])`. users.id / agents.id are uuid columns,
// so on Postgres `WHERE id IN (..., 'system')` aborted the WHOLE query with
// `invalid input syntax for type uuid: "system"` → the endpoint 500'd and the
// client showed "Could not load chats". sql.js is permissive (no uuid cast), so
// dev never saw it — this is a Postgres-only crash, exactly like the sibling
// resolveParticipantName bug (see chat-system-sender-uuid-guard.test.mjs).
//
// The fix filters participant ids to well-formed uuids BEFORE findByIds and
// resolves the synthetic 'system' id by name ('System'). This test reproduces
// the Postgres cast behavior with a fake repo whose findByIds THROWS on any
// non-uuid id, so the regression is caught deterministically on any runtime.
// Imports the compiled service from dist/ (built by `npm run build`).

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
// the logic under test. The real uuid/varchar filtering happens in SQL, which
// is exactly the Postgres layer we mock via findByIds below.
function fakeQb(rows) {
  const o = {
    where: () => o,
    andWhere: () => o,
    orderBy: () => o,
    getMany: async () => rows,
  };
  return o;
}
const repoWithRows = (rows) => ({ createQueryBuilder: () => fakeQb(rows) });

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
  // A QA-run room's participants: the QA agent, a real user, and the synthetic
  // 'system' user that qa-run.service seeds.
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
  return new RoomCrudService(
    repoWithRows(rooms),
    repoWithRows(participants),
    repoWithRows(messages),
    userRepo,
    agentRepo,
    null,
    null,
  );
}

test('listAllWorkspaceRooms does not feed the synthetic "system" id to a uuid column', async () => {
  const calls = { user: [], agent: [] };
  const svc = makeService(calls);

  // Before the fix this awaited userRepo.findByIds([USER_UUID, 'system']) and
  // the pg-uuid mock threw — the whole observer view 500'd.
  const rooms = await svc.listAllWorkspaceRooms(WS);

  assert.equal(rooms.length, 1, 'the QA room must still be returned');
  const flatUserIds = calls.user.flat();
  assert.ok(flatUserIds.includes(USER_UUID), 'the real user id must still be resolved via findByIds');
  assert.ok(!flatUserIds.includes('system'), "the synthetic 'system' id must be filtered out before findByIds");
});

test("the synthetic 'system' participant + sender resolve to 'System', real members keep their names", async () => {
  const calls = { user: [], agent: [] };
  const svc = makeService(calls);
  const [room] = await svc.listAllWorkspaceRooms(WS);

  const names = room.participants.map((p) => p.name).sort();
  assert.deepEqual(names, ['Alice', 'BuildBot', 'System']);
  assert.equal(room.last_message.sender_name, 'System', "the 'system'-authored last message renders as System");
});
