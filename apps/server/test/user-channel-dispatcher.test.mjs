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
//
// Also covers `_handleActivity` (ticket f57dcfbc): it used to build a
// workspace-less `/?ticket=<id>` notification link — the same legacy
// pattern removed from the client's admin fallbacks — instead of the
// board-scoped shape `_buildDeepLink` already uses for mentions.

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
  const colRepo = { async findOne() { return null; } };
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
    colRepo,
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

function makeActivityService(UserChannelDispatcherService, { tickets, columns, assignments, sentPayloads }) {
  const ticketRepo = {
    async findOne({ where: { id } }) {
      return tickets[id] || null;
    },
  };
  const colRepo = {
    async findOne({ where: { id } }) {
      return columns[id] || null;
    },
  };
  const assignRepo = { async find() { return assignments; } };
  const userChannelRepo = {
    async find({ where: { user_id } }) {
      return [{ id: `uc-${user_id}`, user_id, is_active: 1, notify_ticket: 1, provider: 'stub', target: user_id, credentials: null }];
    },
  };
  const provider = {
    async send(target, creds, payload) {
      sentPayloads.push({ target, payload });
      return { ok: true };
    },
  };
  const registry = { get: () => provider };
  const logService = { info: () => {}, warn: () => {}, error: () => {} };
  return new UserChannelDispatcherService(
    userChannelRepo,
    ticketRepo,
    colRepo,
    assignRepo,
    registry,
    logService,
  );
}

test("_handleActivity links to the ticket's own board — not the legacy workspace-less /?ticket= fallback", async () => {
  const UserChannelDispatcherService = await loadDispatcher();
  const prevUrl = process.env.AWB_PUBLIC_URL;
  process.env.AWB_PUBLIC_URL = 'https://awb.example.com';
  try {
    const sentPayloads = [];
    const svc = makeActivityService(UserChannelDispatcherService, {
      tickets: { 'tk-1': { id: 'tk-1', workspace_id: 'ws-1', column_id: 'col-1', parent_id: null, title: 'Fix the thing' } },
      columns: { 'col-1': { id: 'col-1', board_id: 'board-1' } },
      assignments: [{ user_id: 'u-alice', ticket_id: 'tk-1' }],
      sentPayloads,
    });

    await svc._handleActivity({
      entity_type: 'ticket',
      entity_id: 'tk-1',
      action: 'moved',
      actor_id: 'u-other',
      actor_name: 'Other',
      field_changed: 'column',
      old_value: 'To Do',
      new_value: 'In Progress',
    });

    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].payload.url, 'https://awb.example.com/ws/ws-1/boards/board-1?ticket=tk-1');
  } finally {
    if (prevUrl === undefined) delete process.env.AWB_PUBLIC_URL;
    else process.env.AWB_PUBLIC_URL = prevUrl;
  }
});

test("_handleActivity omits the url when the ticket's board can't be resolved (no broken fallback link)", async () => {
  const UserChannelDispatcherService = await loadDispatcher();
  const prevUrl = process.env.AWB_PUBLIC_URL;
  process.env.AWB_PUBLIC_URL = 'https://awb.example.com';
  try {
    const sentPayloads = [];
    const svc = makeActivityService(UserChannelDispatcherService, {
      tickets: { 'tk-2': { id: 'tk-2', workspace_id: 'ws-1', column_id: null, parent_id: null, title: 'Orphan column ticket' } },
      columns: {},
      assignments: [{ user_id: 'u-alice', ticket_id: 'tk-2' }],
      sentPayloads,
    });

    await svc._handleActivity({
      entity_type: 'ticket',
      entity_id: 'tk-2',
      action: 'updated',
      actor_id: 'u-other',
      actor_name: 'Other',
      field_changed: '',
    });

    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].payload.url, undefined);
  } finally {
    if (prevUrl === undefined) delete process.env.AWB_PUBLIC_URL;
    else process.env.AWB_PUBLIC_URL = prevUrl;
  }
});
