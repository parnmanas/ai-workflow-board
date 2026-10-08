// P4c-4: group-room @-mention of a spec-direct (rt-) member dispatches a
// chat_request WITHOUT an Agent row — from the ticket's assignee RuntimeSpec in
// ticket rooms (docs/tickets.md: one assignee per ticket, `assignee_key` is its
// runtime identity), from the participant snapshot in ticket-less rooms. Drives
// the compiled sendMessage() with stub repos, asserting on emitted
// activityEvents (same technique as room-messaging-manager-capability-gate.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { RoomMessagingService } = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'chat-rooms', 'room-messaging.service.js')
);
const { activityEvents } = await import(
  'file://' + path.join(DIST_ROOT, 'services', 'activity.service.js')
);
const entities = await import('file://' + path.join(DIST_ROOT, 'entities', 'index.js'));
const { Ticket, ChatRoomParticipant } = entities;

const RT = 'rt-0123456789abcdef';
const SPEC = {
  manager_agent_id: 'host-1',
  cli: 'opencode',
  model: 'opencode/big-pickle',
  working_dir: '/tmp/wt',
  credential_id: null,
  label: 'rt-member',
  role_prompt: 'You are rt.',
};

function makeQueryBuilder() {
  const qb = {
    select() { return qb; },
    update() { return qb; },
    set() { return qb; },
    where() { return qb; },
    andWhere() { return qb; },
    orderBy() { return qb; },
    addOrderBy() { return qb; },
    limit() { return qb; },
    getMany() { return Promise.resolve([]); },
    getOne() { return Promise.resolve(null); },
    execute() { return Promise.resolve({ affected: 0 }); },
  };
  return qb;
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

function makeSvc({ room, ticket, participantSpec, mentionRefs, participantRows, recentMessages, extraParticipants }) {
  const dataSource = {
    getRepository(entity) {
      if (entity === Ticket) return { async findOne() { return ticket; } };
      if (entity === ChatRoomParticipant) return { async find() { return []; } };
      return { async findOne() { return null; }, async find() { return []; } };
    },
  };
  const roomRepo = { async findOne() { return room; }, async update() {} };
  // Where-aware participant table: RT (unless ABSENT) + explicit extras.
  // markRead looks the SENDER up the same way, so tests pass senders that
  // are either RT or listed in extraParticipants.
  const table = new Map();
  if (participantSpec !== 'ABSENT') table.set(RT, participantSpec ?? null);
  for (const [id, spec] of Object.entries(extraParticipants ?? {})) table.set(id, spec);
  const participantRepo = {
    async findOne({ where } = {}) {
      const id = where?.participant_id;
      if (id && table.has(id)) {
        return {
          room_id: room.id, participant_type: 'agent', participant_id: id,
          left_at: null, runtime_spec: table.get(id),
        };
      }
      return null;
    },
    async find() {
      return participantRows ?? [];
    },
  };
  const accountRepo = { async findOne() { return { id: 'ws-1' }; } };
  const messageRepo = {
    createQueryBuilder: () => {
      const qb = makeQueryBuilder();
      if (recentMessages) qb.getMany = () => Promise.resolve(recentMessages);
      return qb;
    },
    manager: {
      async transaction(fn) {
        const em = {
          getRepository() {
            return {
              create: (fields) => ({ ...fields }),
              async save(row) { return { ...row, id: 'msg-1', created_at: new Date() }; },
            };
          },
        };
        return fn(em);
      },
    },
    create: (fields) => ({ ...fields }),
    async save(row) { return { ...row, id: 'sys-msg-1', created_at: new Date() }; },
  };
  const ticketRepo = { async findOne() { return ticket; } };
  const membership = {
    async requireActiveParticipant() {},
    async requireMissionRoomSpeaker() {},
    async resolveMissionChatPolicy() { return null; },
    async getRoomMemberIds() { return ['user-1', RT]; },
    async getRoomAgentMemberIds() { return [RT]; },
    async getRoomAgentRuntimeSpecs() { return {}; },
  };
  const defaultRefs = [{ type: 'agent', id: RT }];
  const mentionService = {
    // mentionRefs override replaces the fixed refs. resolve honors
    // excludeActor exactly like the real MentionService.
    parseMentions: () => (mentionRefs ?? defaultRefs),
    resolveMentions: async (refs, _ticket, opts) => {
      const input = refs && refs.length > 0 ? refs : (mentionRefs ?? defaultRefs);
      const ex = opts?.excludeActor ?? null;
      return input.filter((r) => !(ex && ex.type === r.type && ex.id === r.id));
    },
  };
  // P4c-4: agentRepo 인자 삭제 (no Agent row — the point of the test).
  const connectivity = { isReachable: () => true };
  return new RoomMessagingService(
    roomRepo, participantRepo, messageRepo, ticketRepo, {}, {},
    accountRepo, dataSource, noopLog, membership, mentionService, connectivity, undefined,
    { listForAgent: () => [] },
  );
}

function captureOnce(eventName) {
  let captured = null;
  const handler = (payload) => { captured = payload; };
  activityEvents.once(eventName, handler);
  return { off: () => activityEvents.off(eventName, handler), get: () => captured };
}

// The mentioned rt- key is the ticket's assignee identity; the room has no
// participant snapshot for it, so only the assignee spec can answer. A stored
// assignee went through TicketService's RuntimeSpec normalisation, which
// requires runtime_config — parseRuntimeSpec rejects a spec without it.
const TICKET = {
  id: 'ticket-1', account_id: 'ws-1', status: 'in_progress',
  assignee: { ...SPEC, runtime_config: { strategy: 'single', permission_mode: 'strict' } },
  assignee_key: RT,
};

test('ticket room @rt-mention emits chat_request from the assignee spec (no Agent row)', async () => {
  const room = { id: 'room-1', type: 'group', name: '', action_id: null, orchestration_mission_id: null, run_kind: null, account_id: 'ws-1', ticket_id: 'ticket-1' };
  const svc = makeSvc({ room, ticket: TICKET, participantSpec: null });
  const chatRequest = captureOnce('chat_request');
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hey @[agent:' + RT + '] look');
  } finally {
    chatRequest.off();
  }
  const evt = chatRequest.get();
  assert.ok(evt, 'chat_request must be emitted for an rt- mention');
  assert.equal(evt.agent_id, RT);
  assert.equal(evt.ticket_id, 'ticket-1');
  assert.equal(evt.runtime.manager_agent_id, 'host-1');
  assert.equal(evt.runtime.cli, 'opencode');
  assert.equal(evt.role_prompt, 'You are rt.');
});

test('ticket-less room @rt-mention emits chat_request from the participant snapshot', async () => {
  const room = { id: 'room-2', type: 'group', name: '', action_id: null, orchestration_mission_id: null, run_kind: null, account_id: 'ws-1', ticket_id: null };
  const svc = makeSvc({ room, ticket: null, participantSpec: { ...SPEC } });
  const chatRequest = captureOnce('chat_request');
  try {
    await svc.sendMessage('room-2', 'ws-1', 'user', 'user-1', 'Alice', 'hey @[agent:' + RT + '] look');
  } finally {
    chatRequest.off();
  }
  const evt = chatRequest.get();
  assert.ok(evt, 'chat_request must be emitted for an rt- mention via participant snapshot');
  assert.equal(evt.agent_id, RT);
  assert.equal(evt.runtime.working_dir, '/tmp/wt');
});

// ─── Session-to-session: agent senders ─────────────────────────────────────
// An agent's `@[agent:<rt-key>]` wakes the mentioned participant exactly like
// a user's mention does — this is what lets two sessions talk to each other
// (the Ralf→Rolf case: an agent-authored mention used to die silently).

const RT_SENDER = 'rt-aaaaaaaaaaaaaaaa';
const RT_PEER = 'rt-bbbbbbbbbbbbbbbb';

function groupRoom(id) {
  return { id, type: 'group', name: '', action_id: null, orchestration_mission_id: null, run_kind: null, account_id: 'ws-1', ticket_id: null };
}

test('agent sender @rt-mention with snapshot emits chat_request + dispatch marker', async () => {
  const svc = makeSvc({ room: groupRoom('room-a1'), ticket: null, participantSpec: { ...SPEC } });
  const chatRequest = captureOnce('chat_request');
  const broadcast = captureOnce('chat_room_message');
  let ret;
  try {
    ret = await svc.sendMessage('room-a1', 'ws-1', 'agent', RT_SENDER, 'Ralf', 'hey @[agent:' + RT + '] look');
  } finally {
    chatRequest.off();
    broadcast.off();
  }
  const evt = chatRequest.get();
  assert.ok(evt, 'agent-authored rt- mention must emit chat_request');
  assert.equal(evt.agent_id, RT);
  assert.equal(evt.runtime.working_dir, '/tmp/wt');
  assert.equal(evt.room_id, 'room-a1');
  assert.deepEqual(broadcast.get()?.dispatch_agent_ids, [RT], 'broadcast must carry the dedup marker');
  assert.deepEqual(ret.warnings, [], 'no warnings when the mention dispatched');
});

test('agent sender @rt-mention of a snapshot-less participant emits a bare chat_request', async () => {
  // Legacy rooms have participant rows without runtime_spec snapshots. The
  // hosting manager resolves a bare rt-key from its live registry; managers
  // that do not host it ignore the event as unmanaged (no noise).
  const svc = makeSvc({ room: groupRoom('room-a2'), ticket: null, participantSpec: null });
  const chatRequest = captureOnce('chat_request');
  let ret;
  try {
    ret = await svc.sendMessage('room-a2', 'ws-1', 'agent', RT_SENDER, 'Ralf', 'hey @[agent:' + RT + '] look');
  } finally {
    chatRequest.off();
  }
  const evt = chatRequest.get();
  assert.ok(evt, 'known participant without a snapshot must still emit chat_request');
  assert.equal(evt.agent_id, RT);
  assert.ok(!('runtime' in evt), 'no runtime snapshot to attach');
  assert.deepEqual(ret.warnings, [], 'a bare dispatch is not a warning');
});

test('agent sender @uuid mention of a stranger warns', async () => {
  const svc = makeSvc({
    room: groupRoom('room-a3'), ticket: null, participantSpec: { ...SPEC },
    mentionRefs: [{ type: 'agent', id: 'd4d66e85-uuid-like' }],
  });
  const chatRequest = captureOnce('chat_request');
  let ret;
  try {
    ret = await svc.sendMessage('room-a3', 'ws-1', 'agent', RT_SENDER, 'Ralf', 'hey @[agent:d4d66e85-uuid-like|Rolf] look');
  } finally {
    chatRequest.off();
  }
  assert.equal(chatRequest.get(), null, 'unknown ids never dispatch');
  assert.equal(ret.warnings.length, 1);
  assert.match(ret.warnings[0], /not a participant/, 'warning names the membership problem');
});

test('agent sender @uuid mention of a known participant emits bare (best-effort)', async () => {
  // Legacy/host-UUID rooms (the Ralf→Rolf case): no spec to attach, but the
  // hosting manager resolves the bare id from its live registry.
  const HOST_UUID = '9a5c9625-aaaa-bbbb-cccc-ddeeff001122';
  const svc = makeSvc({
    room: groupRoom('room-a3b'), ticket: null, participantSpec: 'ABSENT',
    mentionRefs: [{ type: 'agent', id: HOST_UUID }],
    extraParticipants: { [HOST_UUID]: null },
  });
  const chatRequest = captureOnce('chat_request');
  let ret;
  try {
    ret = await svc.sendMessage('room-a3b', 'ws-1', 'agent', RT_SENDER, 'Ralf', 'hey @[agent:' + HOST_UUID + '|Rolf] look');
  } finally {
    chatRequest.off();
  }
  const evt = chatRequest.get();
  assert.ok(evt, 'known uuid participant must emit a bare chat_request');
  assert.equal(evt.agent_id, HOST_UUID);
  assert.ok(!('runtime' in evt), 'no snapshot to attach');
  assert.deepEqual(ret.warnings, []);
});

test('agent sender self-mention is dropped silently', async () => {
  const svc = makeSvc({
    room: groupRoom('room-a4'), ticket: null, participantSpec: { ...SPEC },
    mentionRefs: [{ type: 'agent', id: RT_SENDER }],
  });
  const chatRequest = captureOnce('chat_request');
  let ret;
  try {
    ret = await svc.sendMessage('room-a4', 'ws-1', 'agent', RT_SENDER, 'Ralf', 'note to self @[agent:' + RT_SENDER + ']');
  } finally {
    chatRequest.off();
  }
  // resolveMentions drops the sender; nothing left to warn about.
  assert.equal(chatRequest.get(), null, 'self-mentions must not wake yourself');
  assert.deepEqual(ret.warnings, []);
});

test('agent sender @rt-mention of a non-participant warns', async () => {
  const svc = makeSvc({
    room: groupRoom('room-a5'), ticket: null, participantSpec: 'ABSENT',
    mentionRefs: [{ type: 'agent', id: 'rt-cccccccccccccccc' }],
  });
  const chatRequest = captureOnce('chat_request');
  let ret;
  try {
    ret = await svc.sendMessage('room-a5', 'ws-1', 'agent', RT_SENDER, 'Ralf', 'hey @[agent:rt-cccccccccccccccc] look');
  } finally {
    chatRequest.off();
  }
  assert.equal(chatRequest.get(), null, 'outsiders must not dispatch');
  assert.equal(ret.warnings.length, 1);
  assert.match(ret.warnings[0], /not a participant/, 'warning names the membership problem');
});

test('agent sender DM message auto-routes to the peer agent', async () => {
  const room = { ...groupRoom('room-dm1'), type: 'dm' };
  const svc = makeSvc({
    room, ticket: null, participantSpec: null, mentionRefs: [],
    participantRows: [{
      room_id: room.id, participant_type: 'agent', participant_id: RT_PEER,
      left_at: null, runtime_spec: { ...SPEC },
    }],
  });
  const chatRequest = captureOnce('chat_request');
  let ret;
  try {
    ret = await svc.sendMessage(room.id, 'ws-1', 'agent', RT_SENDER, 'Ralf', 'please check the renderer, no mention needed');
  } finally {
    chatRequest.off();
  }
  const evt = chatRequest.get();
  assert.ok(evt, 'DM peer must be woken even without an explicit mention');
  assert.equal(evt.agent_id, RT_PEER);
  assert.equal(evt.runtime.working_dir, '/tmp/wt');
  assert.deepEqual(ret.warnings, []);
});

test('agent sender @user mention writes no UserMention row', async () => {
  const svc = makeSvc({
    room: groupRoom('room-a6'), ticket: null, participantSpec: { ...SPEC },
    mentionRefs: [{ type: 'user', id: 'user-9' }],
  });
  const chatRequest = captureOnce('chat_request');
  const userMention = captureOnce('user_mention');
  let ret;
  try {
    ret = await svc.sendMessage('room-a6', 'ws-1', 'agent', RT_SENDER, 'Ralf', 'hey @[user:user-9|Parn] look');
  } finally {
    chatRequest.off();
    userMention.off();
  }
  assert.equal(chatRequest.get(), null, 'user tokens never wake agents');
  assert.equal(userMention.get(), null, 'agents must not fill a human mention inbox');
  assert.deepEqual(ret.warnings, [], 'ignored user tokens are not warnings (quoting is normal)');
});

test('agent mention dispatch stops once the back-and-forth chain hits the cap', async () => {
  // Latest first: A, B, A = depth 3 = AGENT_DISPATCH_DEPTH_CAP → skip.
  const recent = [
    { sender_type: 'agent', sender_id: 'rt-x' },
    { sender_type: 'agent', sender_id: 'rt-y' },
    { sender_type: 'agent', sender_id: 'rt-x' },
  ];
  const svc = makeSvc({ room: groupRoom('room-a7'), ticket: null, participantSpec: { ...SPEC }, recentMessages: recent });
  const chatRequest = captureOnce('chat_request');
  try {
    await svc.sendMessage('room-a7', 'ws-1', 'agent', RT_SENDER, 'Ralf', 'hey @[agent:' + RT + '] look');
  } finally {
    chatRequest.off();
  }
  assert.equal(chatRequest.get(), null, 'mention dispatch must terminate with the chain-depth guard');
});
