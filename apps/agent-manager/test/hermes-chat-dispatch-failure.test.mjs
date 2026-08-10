import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';

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
