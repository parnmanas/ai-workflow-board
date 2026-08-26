import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { spawnFailureTracker } from '../dist/lib/spawn-failure-tracker.js';

// ticket a837879c: Hermes 채팅 디스패치 실패가 로컬 로그로만 남고 사용자/채팅방에는
// 아무 신호도 가지 않아 "Hermes Agent가 온라인인데 응답이 없음"처럼 보였다.
// runtimeSupervisor 를 deps 에서 생략해 #dispatchHermes() 가 runtime_supervisor_unavailable
// 로 fail-closed 하도록 만든 뒤, 채팅방/DM 양쪽에 에러 메시지가 실제로 POST 되는지 검증한다.

const AGENT = 'agent-hermes-guard';
let originalFetch;
let chatMessagePosts;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  chatMessagePosts = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method || 'GET';
    if (target.includes('/api/agent/ordinary-work-board-candidates')) {
      return Response.json([]);
    }
    if (target.includes('/api/agent/chat-rooms/') && target.endsWith('/messages') && method === 'POST') {
      chatMessagePosts.push({ url: target, body: JSON.parse(init?.body || '{}') });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.endsWith('/api/agent-manager/dispatch/ack')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function context() {
  return {
    agent_id: AGENT,
    name: 'Hermes guard agent',
    cli: 'hermes',
    working_dir: '/workspace',
    mcp_config_path: '/config/mcp.json',
    api_key: 'agent-api-key',
    cli_home_dir: '/cli-home',
    extra_env: {},
    credential_provider: null,
    model: null,
  };
}

function harness() {
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? context() : null),
    has: (id) => id === AGENT,
    list: () => [context()],
  };
  // runtimeSupervisor 를 의도적으로 생략 — #dispatchHermes() 가
  // 'runtime_supervisor_unavailable' 로 fail-closed 하는 경로를 재현한다.
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
    timestamp: '2026-08-10T00:00:00.000Z',
    payload: {
      agent_id: AGENT,
      room_id: roomId,
      user_id: 'user-1',
      new_message: 'hello Hermes',
    },
  });
}

function chatRoomMessage(roomId) {
  return JSON.stringify({
    event_type: 'chat_room_message',
    timestamp: '2026-08-10T00:00:00.000Z',
    payload: {
      agent_member_ids: [AGENT],
      room_id: roomId,
      sender_id: 'user-1',
      sender_name: 'user-1',
      sender_type: 'user',
      content: 'hello Hermes room',
    },
  });
}

test('Hermes DM chat dispatch failure posts a visible error into the chat room', async () => {
  const { dispatcher } = harness();

  await dispatcher.handleChatRequest(chatRequest('room-dm'));

  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].url, 'http://127.0.0.1:0/api/agent/chat-rooms/room-dm/messages');
  assert.equal(chatMessagePosts[0].body.agent_id, AGENT);
  assert.match(chatMessagePosts[0].body.content, /Hermes 런타임 실행 실패/);
  assert.match(chatMessagePosts[0].body.content, /runtime_supervisor_unavailable/);
});

test('Hermes chat room dispatch failure posts a visible error into the chat room', async () => {
  const { dispatcher } = harness();

  await dispatcher.handleChatRoomMessage(chatRoomMessage('room-group'));

  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].url, 'http://127.0.0.1:0/api/agent/chat-rooms/room-group/messages');
  assert.equal(chatMessagePosts[0].body.agent_id, AGENT);
  assert.match(chatMessagePosts[0].body.content, /Hermes 런타임 실행 실패/);
  assert.match(chatMessagePosts[0].body.content, /runtime_supervisor_unavailable/);
});

// ticket 7a4b14b4: the two tests above only exercise the path where
// #dispatchHermes() itself throws because runtimeSupervisor is entirely absent
// (always the allowlisted 'runtime_supervisor_unavailable' code). The two tests
// below give #dispatchHermes() a working fake runtimeSupervisor so dispatch()
// can RESOLVE (not throw) with an empty reply, or throw a code that was never
// added to the allowlist — reproducing the two properties ticket a837879c's
// review explicitly required and that were previously unverified: (a) an
// empty/whitespace-only reply after end_turn is never recorded as success, and
// (b) any code outside #HERMES_CHAT_ERROR_CODES collapses to the safe
// 'runtime_dispatch_error' fallback with the raw code/message never reaching
// the chat room.

function harnessWithSupervisor(dispatchImpl) {
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? context() : null),
    has: (id) => id === AGENT,
    list: () => [context()],
  };
  const dispatcher = new EventDispatcher(
    {
      url: 'http://127.0.0.1:0',
      apiKey: 'test-key',
      delegation: { enabled: true, persistentTicketSessions: false, persistentChatSessions: false },
    },
    { managedAgentContexts, runtimeSupervisor: { dispatch: dispatchImpl } },
  );
  return { dispatcher };
}

test('Hermes dispatch resolving end_turn with a whitespace-only reply is NOT recorded as success (hermes_empty_reply, allowlisted)', async () => {
  const { dispatcher } = harnessWithSupervisor(async (args) => {
    args.onEvent?.({ type: 'message_delta', sessionId: 'session-empty', text: '   ' });
    return {
      sessionId: 'session-empty',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  });

  await dispatcher.handleChatRoomMessage(chatRoomMessage('room-empty-reply'));

  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].body.agent_id, AGENT);
  assert.equal(
    chatMessagePosts[0].body.content,
    '⚠️ **Hermes 런타임 실행 실패** (`hermes_empty_reply`)\n\n' +
      '이 메시지에 응답하지 못했습니다. Agent Manager 로그를 확인한 뒤 다시 시도하세요.',
  );

  // Not recorded as success — the degraded signal must reflect this failure.
  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, 'hermes');
  assert.match(snap.last_spawn_error, /hermes_empty_reply/);
});

test('Hermes dispatch failing with a code outside the allowlist is redacted to runtime_dispatch_error — raw code/message never reach the chat room', async () => {
  const { dispatcher } = harnessWithSupervisor(async () => {
    const err = new Error('internal path leak: /home/parn/.awb/secret-detail sensitive-stack-trace');
    err.code = 'some_never_allowlisted_internal_code';
    throw err;
  });

  await dispatcher.handleChatRoomMessage(chatRoomMessage('room-unlisted-code'));

  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].body.agent_id, AGENT);
  assert.match(chatMessagePosts[0].body.content, /Hermes 런타임 실행 실패/);
  assert.match(chatMessagePosts[0].body.content, /runtime_dispatch_error/);
  assert.doesNotMatch(chatMessagePosts[0].body.content, /some_never_allowlisted_internal_code/);
  assert.doesNotMatch(chatMessagePosts[0].body.content, /secret-detail/);
  assert.doesNotMatch(chatMessagePosts[0].body.content, /sensitive-stack-trace/);
});
