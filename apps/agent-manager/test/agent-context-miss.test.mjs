import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';

// ticket c0c0b1e4: #resolveAgentContext(eventAgentId) / #resolveAgentContextFromMembers(...)
// returning undefined (e.g. a managed agent registered but not yet bootstrapped after a
// manager restart — rehydration miss) used to skip every downstream identity check
// (agentContext?.cli === 'hermes' etc.) and fall through to a "dropped (no delegation
// path)" log line with no signal beyond that one local log line. These tests pin the
// new behavior: a genuine registered-but-not-bootstrapped miss posts a visible chat-room
// notice, while a routine "not managed by this manager at all" miss stays silent (no
// notice spam for ordinary filtering).

const AGENT = 'agent-not-bootstrapped';
let originalFetch;
let chatMessagePosts;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  chatMessagePosts = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method || 'GET';
    if (target.includes('/api/agent/chat-rooms/') && target.endsWith('/messages') && method === 'POST') {
      chatMessagePosts.push({ url: target, body: JSON.parse(init?.body || '{}') });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Registered in the manager's registry (so #agentContextMissReason sees it as
// 'not_bootstrapped', not 'unmanaged') but missing working_dir — the same
// incompleteness #resolveAgentContext itself checks for, so it resolves undefined.
function brokenContext() {
  return {
    agent_id: AGENT,
    name: 'Not yet rehydrated',
    cli: 'claude',
    working_dir: '',
    mcp_config_path: '/config/mcp.json',
    api_key: 'agent-api-key',
    cli_home_dir: '/cli-home',
    extra_env: {},
    credential_provider: null,
    model: null,
  };
}

function harness(managedAgentContexts) {
  const dispatcher = new EventDispatcher(
    {
      url: 'http://127.0.0.1:0',
      apiKey: 'test-key',
      delegation: { enabled: true, persistentTicketSessions: false, persistentChatSessions: false },
    },
    { managedAgentContexts },
  );
  return { dispatcher };
}

function chatRequest(roomId) {
  return JSON.stringify({
    event_type: 'chat_request',
    timestamp: '2026-08-13T00:00:00.000Z',
    payload: {
      agent_id: AGENT,
      room_id: roomId,
      user_id: 'user-1',
      new_message: 'hello?',
    },
  });
}

function chatRoomMessage(roomId, memberIds) {
  return JSON.stringify({
    event_type: 'chat_room_message',
    timestamp: '2026-08-13T00:00:00.000Z',
    payload: {
      agent_member_ids: memberIds,
      room_id: roomId,
      sender_id: 'user-1',
      sender_name: 'user-1',
      sender_type: 'user',
      content: 'hello room?',
    },
  });
}

test('chat request against a registered-but-not-bootstrapped agent posts a visible notice', async () => {
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? brokenContext() : null),
    has: (id) => id === AGENT,
    list: () => [brokenContext()],
  };
  const { dispatcher } = harness(managedAgentContexts);

  await dispatcher.handleChatRequest(chatRequest('room-dm'));

  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].url, 'http://127.0.0.1:0/api/agent/chat-rooms/room-dm/messages');
  assert.equal(chatMessagePosts[0].body.agent_id, AGENT);
  assert.match(chatMessagePosts[0].body.content, /에이전트 실행 정보를 찾을 수 없습니다/);
});

test('chat room message against a registered-but-not-bootstrapped agent posts a visible notice', async () => {
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? brokenContext() : null),
    has: (id) => id === AGENT,
    list: () => [brokenContext()],
  };
  const { dispatcher } = harness(managedAgentContexts);

  await dispatcher.handleChatRoomMessage(chatRoomMessage('room-group', [AGENT]));

  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].url, 'http://127.0.0.1:0/api/agent/chat-rooms/room-group/messages');
  assert.equal(chatMessagePosts[0].body.agent_id, AGENT);
  assert.match(chatMessagePosts[0].body.content, /에이전트 실행 정보를 찾을 수 없습니다/);
});

test('chat request targeting an id this manager does not manage at all stays silent (no notice spam)', async () => {
  // Empty registry — payload.agent_id never matches anything, the routine
  // "not mine" case. Must NOT be treated the same as a rehydration miss.
  const managedAgentContexts = {
    get: () => null,
    has: () => false,
    list: () => [],
  };
  const { dispatcher } = harness(managedAgentContexts);

  await dispatcher.handleChatRequest(chatRequest('room-dm'));

  assert.equal(chatMessagePosts.length, 0);
});

test('chat room message with no managed member at all stays silent (manager-is-participant fallback, not a bug)', async () => {
  const managedAgentContexts = {
    get: () => null,
    has: () => false,
    list: () => [],
  };
  const { dispatcher } = harness(managedAgentContexts);

  await dispatcher.handleChatRoomMessage(chatRoomMessage('room-group', []));

  assert.equal(chatMessagePosts.length, 0);
});
