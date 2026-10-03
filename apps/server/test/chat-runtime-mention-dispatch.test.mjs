// P4c-4: group-room @-mention of a spec-direct (rt-) member dispatches a
// chat_request WITHOUT an Agent row — from the assignment snapshot in ticket
// rooms, from the participant snapshot in ticket-less rooms. Drives the
// compiled sendMessage() with stub repos, asserting on emitted activityEvents
// (same technique as room-messaging-manager-capability-gate.test.mjs).

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
const { Ticket, TicketRoleAssignment, ChatRoomParticipant } = entities;

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

function makeSvc({ room, ticket, assignmentRows, participantSpec, withRoleRef }) {
  const dataSource = {
    getRepository(entity) {
      if (entity === Ticket) return { async findOne() { return ticket; } };
      if (entity === TicketRoleAssignment) return { async find() { return assignmentRows; } };
      if (entity === ChatRoomParticipant) return { async find() { return []; } };
      return { async findOne() { return null; }, async find() { return []; } };
    },
  };
  const roomRepo = { async findOne() { return room; }, async update() {} };
  const participantRepo = {
    async findOne() {
      return {
        room_id: room.id, participant_type: 'agent', participant_id: RT,
        left_at: null, runtime_spec: participantSpec ?? null,
      };
    },
  };
  const workspaceRepo = { async findOne() { return { id: 'ws-1' }; } };
  const messageRepo = {
    createQueryBuilder: makeQueryBuilder,
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
  const mentionService = {
    // A role ref forces _processMentions to load room.ticket_id (ticket path);
    // without it ticket stays null and the participant fallback answers.
    parseMentions: () => withRoleRef
      ? [{ type: 'role', id: 'assignee' }, { type: 'agent', id: RT }]
      : [{ type: 'agent', id: RT }],
    resolveMentions: async () => [{ type: 'agent', id: RT }],
  };
  // P4c-4: agentRepo 인자 삭제 (no Agent row — the point of the test).
  const connectivity = { isReachable: () => true };
  return new RoomMessagingService(
    roomRepo, participantRepo, messageRepo, ticketRepo, {}, {},
    workspaceRepo, dataSource, noopLog, membership, mentionService, connectivity, undefined,
    { listForAgent: () => [] },
  );
}

function captureOnce(eventName) {
  let captured = null;
  const handler = (payload) => { captured = payload; };
  activityEvents.once(eventName, handler);
  return { off: () => activityEvents.off(eventName, handler), get: () => captured };
}

const TICKET = {
  id: 'ticket-1', column_id: 'col-1', workspace_id: 'ws-1',
  effort_preset: null, cli_runtime_profile: null,
};
const ASSIGNMENT_ROWS = [
  { agent_id: null, user_id: null, holder_key: 'runtime:' + RT, runtime_spec: { ...SPEC } },
];

test('ticket room @rt-mention emits chat_request from the assignment snapshot (no Agent row)', async () => {
  const room = { id: 'room-1', type: 'group', name: '', action_id: null, orchestration_mission_id: null, run_kind: null, workspace_id: 'ws-1', ticket_id: 'ticket-1' };
  const svc = makeSvc({ room, ticket: TICKET, assignmentRows: ASSIGNMENT_ROWS, participantSpec: null, withRoleRef: true });
  const chatRequest = captureOnce('chat_request');
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hey @[agent:' + RT + '] look');
  } finally {
    chatRequest.off();
  }
  const evt = chatRequest.get();
  assert.ok(evt, 'chat_request must be emitted for an rt- mention');
  assert.equal(evt.agent_id, RT);
  assert.equal(evt.runtime.manager_agent_id, 'host-1');
  assert.equal(evt.runtime.cli, 'opencode');
  assert.equal(evt.role_prompt, 'You are rt.');
});

test('ticket-less room @rt-mention emits chat_request from the participant snapshot', async () => {
  const room = { id: 'room-2', type: 'group', name: '', action_id: null, orchestration_mission_id: null, run_kind: null, workspace_id: 'ws-1', ticket_id: null };
  const svc = makeSvc({ room, ticket: null, assignmentRows: [], participantSpec: { ...SPEC } });
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
