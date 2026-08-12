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
const UNMANAGED = 'agent-not-managed-by-this-manager';
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

// ticket c0c0b1e4 (리뷰 라운드2 지적 #1,#2): fallback managers that WOULD
// dispatch/spawn "successfully" if invoked — proves the not_bootstrapped
// short-circuit fires BEFORE any of them run, not merely when they're absent
// (the gap the round-1 review found: the old harness() above always has
// chatSessionManager/subagentManager/ticketSessionManager null, so it could
// only ever exercise the final-drop fallthrough, never a fallback that
// actually gets a chance to run under the wrong identity).
function fallbackManagers() {
  const chatSessionManager = {
    dispatchCalls: 0,
    dispatch: async () => {
      chatSessionManager.dispatchCalls++;
      return { dispatched: true, pid: 4242, firstTurn: true };
    },
    recordRoomMessage: () => {},
  };
  const subagentManager = {
    spawnCalls: 0,
    canSpawn: () => true,
    spawn: async () => {
      subagentManager.spawnCalls++;
      return { spawned: true, pid: 4343 };
    },
  };
  const ticketSessionManager = {
    forwardCalls: 0,
    forwardCommentMention: () => {
      ticketSessionManager.forwardCalls++;
      return true;
    },
  };
  return { chatSessionManager, subagentManager, ticketSessionManager };
}

function harnessWithFallback(managedAgentContexts) {
  const managers = fallbackManagers();
  const dispatcher = new EventDispatcher(
    {
      url: 'http://127.0.0.1:0',
      apiKey: 'test-key',
      delegation: { enabled: true, persistentTicketSessions: true, persistentChatSessions: true },
    },
    { managedAgentContexts, ...managers },
  );
  return { dispatcher, ...managers };
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

function commentMention(ticketId, agentId) {
  return JSON.stringify({
    event_type: 'comment_mention',
    ticket_id: ticketId,
    comment_id: 'comment-1',
    agent_id: agentId,
    actor_id: 'user-1',
    actor_type: 'user',
    content: '@mention hello',
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

test('chat request against a not-bootstrapped agent never reaches chatSessionManager/subagentManager even though they would succeed', async () => {
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? brokenContext() : null),
    has: (id) => id === AGENT,
    list: () => [brokenContext()],
  };
  const { dispatcher, chatSessionManager, subagentManager } = harnessWithFallback(managedAgentContexts);

  await dispatcher.handleChatRequest(chatRequest('room-dm'));

  assert.equal(chatSessionManager.dispatchCalls, 0, 'persistent chat session must not run under an unresolved identity');
  assert.equal(subagentManager.spawnCalls, 0, 'subagent spawn must not run under an unresolved identity');
  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].body.agent_id, AGENT);
  assert.match(chatMessagePosts[0].body.content, /에이전트 실행 정보를 찾을 수 없습니다/);
});

test('chat room message against a not-bootstrapped member never reaches chatSessionManager/subagentManager even though they would succeed', async () => {
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? brokenContext() : null),
    has: (id) => id === AGENT,
    list: () => [brokenContext()],
  };
  const { dispatcher, chatSessionManager, subagentManager } = harnessWithFallback(managedAgentContexts);

  await dispatcher.handleChatRoomMessage(chatRoomMessage('room-group', [AGENT]));

  assert.equal(chatSessionManager.dispatchCalls, 0, 'persistent chat session must not run under an unresolved identity');
  assert.equal(subagentManager.spawnCalls, 0, 'subagent spawn must not run under an unresolved identity');
  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].body.agent_id, AGENT);
});

test('chat room message notice names the actual broken managed member, not memberIds[0]', async () => {
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? brokenContext() : null),
    has: (id) => id === AGENT,
    list: () => [brokenContext()],
  };
  const { dispatcher } = harness(managedAgentContexts);

  // UNMANAGED is first in the member list (routine "not this manager's agent"
  // noise), AGENT (the genuinely broken one) is second — the notice must still
  // be attributed to AGENT, not to memberIds[0].
  await dispatcher.handleChatRoomMessage(chatRoomMessage('room-group', [UNMANAGED, AGENT]));

  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].body.agent_id, AGENT);
});

test('comment mention against a not-bootstrapped agent never reaches ticketSessionManager/subagentManager even though they would succeed', async () => {
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? brokenContext() : null),
    has: (id) => id === AGENT,
    list: () => [brokenContext()],
  };
  const { dispatcher, ticketSessionManager, subagentManager } = harnessWithFallback(managedAgentContexts);

  await dispatcher.handleCommentMention(commentMention('ticket-1', AGENT));

  assert.equal(ticketSessionManager.forwardCalls, 0, 'ticket session forward must not run under an unresolved identity');
  assert.equal(subagentManager.spawnCalls, 0, 'subagent spawn must not run under an unresolved identity');
});
