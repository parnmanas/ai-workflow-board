// Unit test — guards against the dispatcher bug where `_handleChat`
// crashed silently because `ev.member_ids` arrived as a `Set<string>`
// (returned by RoomMembershipService.getRoomMemberIds() and forwarded
// unchanged by RoomMessagingService) but the listener tried to call
// `.filter()` on it. The error was swallowed by the fire-and-forget
// `.catch()` wrapper in onModuleInit, so chat-room ambient delivery
// silently never fired.
//
// This test instantiates UserChannelDispatcherService with stub repos
// and a stub registry, then drives `_handleChat` directly with a real
// `Set<string>` for `member_ids`. Pre-fix: throws. Post-fix:
// `Array.from()` normalizes the Set so the listener proceeds and our
// stub `userChannelRepo.find` is consulted for each non-sender member.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadDispatcher() {
  const distRoot = path.join(__dirname, '..', 'dist');
  const dispatcherUrl = 'file://' + path.join(distRoot, 'services', 'notification-providers', 'dispatcher.service.js');
  try {
    const mod = await import(dispatcherUrl);
    return mod.UserChannelDispatcherService;
  } catch (err) {
    throw new Error(
      'Test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' + err.message
    );
  }
}

function makeService(UserChannelDispatcherService, { findCalls }) {
  const userChannelRepo = {
    async find(args) {
      findCalls.push(args);
      return [];
    },
  };
  const ticketRepo = { async findOne() { return null; } };
  const assignRepo = { async find() { return []; } };
  const registry = { get() { return null; } };
  const logService = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return new UserChannelDispatcherService(
    userChannelRepo,
    ticketRepo,
    assignRepo,
    registry,
    logService,
  );
}

test('_handleChat tolerates Set<string> member_ids and dispatches per non-sender member', async () => {
  const UserChannelDispatcherService = await loadDispatcher();
  const findCalls = [];
  const svc = makeService(UserChannelDispatcherService, { findCalls });

  const memberIds = new Set(['u-sender', 'u-alice', 'u-bob']);
  const ev = {
    room_id: 'room-1',
    workspace_id: 'ws-1',
    message_id: 'msg-1',
    sender_type: 'user',
    sender_id: 'u-sender',
    sender_name: 'Sender',
    content: 'hello world',
    member_ids: memberIds,
    created_at: new Date().toISOString(),
  };

  // Pre-fix this throws "ev.member_ids.filter is not a function".
  await svc._handleChat(ev);

  // Sender excluded; alice + bob each looked up via dispatchForUser → userChannelRepo.find.
  assert.equal(findCalls.length, 2, 'expected exactly two user-channel lookups (alice + bob)');
  const userIds = findCalls.map(c => c.where.user_id).sort();
  assert.deepEqual(userIds, ['u-alice', 'u-bob']);
  for (const c of findCalls) {
    assert.equal(c.where.is_active, 1);
  }
});

test('_handleChat accepts string[] member_ids (legacy interface shape)', async () => {
  const UserChannelDispatcherService = await loadDispatcher();
  const findCalls = [];
  const svc = makeService(UserChannelDispatcherService, { findCalls });

  await svc._handleChat({
    room_id: 'room-2',
    workspace_id: 'ws-1',
    message_id: 'msg-2',
    sender_type: 'user',
    sender_id: 'u-sender',
    sender_name: 'Sender',
    content: 'hi',
    member_ids: ['u-sender', 'u-alice'],
    created_at: new Date().toISOString(),
  });

  assert.equal(findCalls.length, 1);
  assert.equal(findCalls[0].where.user_id, 'u-alice');
});

test('_handleChat skips when content is only @-mentions (delegated to mention dispatcher)', async () => {
  const UserChannelDispatcherService = await loadDispatcher();
  const findCalls = [];
  const svc = makeService(UserChannelDispatcherService, { findCalls });

  await svc._handleChat({
    room_id: 'room-3',
    workspace_id: 'ws-1',
    message_id: 'msg-3',
    sender_type: 'user',
    sender_id: 'u-sender',
    sender_name: 'Sender',
    content: '@[user:u-alice|Alice]   ',
    member_ids: new Set(['u-alice']),
    created_at: new Date().toISOString(),
  });

  assert.equal(findCalls.length, 0, 'pure-mention message should not trigger ambient dispatch');
});
