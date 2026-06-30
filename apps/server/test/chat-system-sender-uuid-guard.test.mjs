// Regression guard — QA-run / Action dispatch rooms must be READABLE, and the
// agent-manager must be able to fetch their history so a QA worker can spawn.
//
// Ticket fe297886 ("QA run dispatch has no executor"). Root cause: QaRunService
// .startQaRun (and ActionsService.dispatch for scheduler runs) author the run
// room's first message as the literal sender `('user', 'system')`. users.id is
// a uuid column, so on Postgres `resolveParticipantName` ran
// `userRepo.findOne({ where: { id: 'system' } })` → the whole SELECT aborted
// with `invalid input syntax for type uuid: "system"`.
//
// That single throw caused BOTH reported symptoms:
//   1. get_chat_room_messages / the room read 500'd outright.
//   2. The agent-manager fetches a room's history (the same getMessages →
//      resolveParticipantName path, via GET /api/agent/chat-rooms/:id/messages)
//      BEFORE spawning a worker for a chat dispatch. The throw dropped the
//      manager into its catch-and-drop branch, so NO QA executor ever spawned —
//      every GameClient run recorded 0 steps and got reaped.
//
// The fix short-circuits a non-uuid participant id in resolveParticipantName
// before any DB lookup. This test reproduces the Postgres cast behavior with a
// fake repo whose findOne THROWS on a non-uuid id — so the regression is caught
// deterministically on any DB (the real crash is Postgres-only; sql.js is
// permissive and would mask it). Imports the compiled service from dist/
// (built by `npm run build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomMembershipService } from '../dist/modules/chat-rooms/room-membership.service.js';

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Mimic a Postgres uuid column: a non-uuid literal in `WHERE id = $1` aborts
// the query, exactly as PG does for `invalid input syntax for type uuid`.
function pgUuidColumnRepo(rows = []) {
  return {
    async findOne({ where: { id } }) {
      if (id == null || !UUID_RE.test(String(id))) {
        throw new Error(`invalid input syntax for type uuid: "${id}"`);
      }
      return rows.find((r) => r.id === id) ?? null;
    },
  };
}

// RoomMembershipService ctor: (roomRepo, participantRepo, userRepo, agentRepo, dataSource)
function makeService({ users = [], agents = [] } = {}) {
  const userRepo = pgUuidColumnRepo(users);
  const agentRepo = pgUuidColumnRepo(agents);
  return new RoomMembershipService(null, null, userRepo, agentRepo, null);
}

const REAL_UUID = '11111111-2222-3333-4444-555555555555';

test("resolveParticipantName('user','system') resolves without the uuid cast throw", async () => {
  const svc = makeService();
  // Before the fix this awaited userRepo.findOne({ id: 'system' }) → threw.
  const name = await svc.resolveParticipantName('user', 'system');
  assert.equal(name, 'System');
});

test("resolveParticipantName('agent','system') also short-circuits (no agent lookup)", async () => {
  const svc = makeService();
  const name = await svc.resolveParticipantName('agent', 'system');
  assert.equal(name, 'System');
});

test('any other non-uuid id is treated as Unknown, never queried', async () => {
  const svc = makeService();
  assert.equal(await svc.resolveParticipantName('user', 'not-a-uuid'), 'Unknown');
  assert.equal(await svc.resolveParticipantName('user', ''), 'Unknown');
});

test('a real uuid user id still resolves through the DB lookup', async () => {
  const svc = makeService({ users: [{ id: REAL_UUID, name: 'Alice', email: 'a@x' }] });
  assert.equal(await svc.resolveParticipantName('user', REAL_UUID), 'Alice');
});

test('a real uuid that misses returns the Unknown-User fallback (lookup ran, no throw)', async () => {
  const svc = makeService();
  assert.equal(await svc.resolveParticipantName('user', REAL_UUID), 'Unknown User');
});
