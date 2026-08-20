import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { RuntimeSupervisor } from '../dist/lib/runtime/runtime-supervisor.js';

// 채팅 타이핑/상태 인디케이터는 "실제로 답하는 에이전트"의 agent_id 로 올라가야 한다.
//
// 예전 #setChatRoomTyping() 은 loadAgentInfo() — 즉 이 매니저 자신의 신원 — 만 썼다.
// 서버는 받은 agent_id 를 `<Manager>/<Agent>` 로 정규화하는데, 매니저 id 는 부모가
// 없으므로 prefix 없는 매니저 이름 하나로 풀린다. 그래서 UI 에 에이전트 full name 대신
// "<manager> is thinking" 만 떴다.
//
// 부수 효과가 하나 더 있었다: ChatPage 는 typing 인디케이터를 agent_id 로 키잉하고,
// 에이전트 메시지가 도착하면 sender_id 로 지운다. set 은 매니저 id, 메시지는 에이전트
// id 였으니 자동 clear 가 절대 매칭되지 않아 15초 안전 타임아웃까지 인디케이터가 남았다.
//
// 계약: set 이든 clear 든 모든 typing post 는 응답 에이전트의 id 를 실어야 한다.

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));
const HERMES = 'agent-hermes-typing';
const SENDER = 'agent-manager-typing';

let originalFetch;
let typingPosts;
let chatMessagePosts;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  typingPosts = [];
  chatMessagePosts = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method || 'GET';
    if (target.includes('/api/agent/chat-rooms/') && target.endsWith('/typing') && method === 'POST') {
      typingPosts.push(JSON.parse(init?.body || '{}'));
    }
    if (target.includes('/api/agent/chat-rooms/') && target.endsWith('/messages') && method === 'POST') {
      chatMessagePosts.push(JSON.parse(init?.body || '{}'));
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function hermesContext() {
  return {
    agent_id: HERMES,
    name: 'Hermes typing',
    cli: 'hermes',
    working_dir: '/workspace',
    mcp_config_path: '/config/mcp.json',
    api_key: 'agent-api-key',
    cli_home_dir: '/cli-home',
    extra_env: {},
    credential_provider: null,
    model: null,
    runtime_config: { strategy: 'single', permission_mode: 'trusted' },
  };
}

async function harness(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'awb-typing-attr-'));
  const runtimeSupervisor = new RuntimeSupervisor({
    rootDir,
    command: process.execPath,
    args: [fixture],
    awbUrl: 'http://127.0.0.1:0',
  });
  t.after(async () => {
    await runtimeSupervisor.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  });
  const managedAgentContexts = {
    get: (id) => (id === HERMES ? hermesContext() : null),
    has: (id) => id === HERMES || id === SENDER,
    list: () => [hermesContext()],
  };
  const dispatcher = new EventDispatcher(
    {
      url: 'http://127.0.0.1:0',
      apiKey: 'test-key',
      delegation: { enabled: true, persistentTicketSessions: false, persistentChatSessions: false },
    },
    { managedAgentContexts, runtimeSupervisor },
  );
  return { dispatcher };
}

function agentMessage({ roomId, senderId, memberIds }) {
  return JSON.stringify({
    event_type: 'chat_room_message',
    timestamp: '2026-08-18T00:00:00.000Z',
    payload: {
      agent_member_ids: memberIds,
      room_id: roomId,
      sender_id: senderId,
      sender_name: senderId,
      sender_type: 'agent',
      agent_chain_depth: 0,
      content: 'ping',
    },
  });
}

test('every typing post is attributed to the responding agent, never to the manager', async (t) => {
  const { dispatcher } = await harness(t);

  await dispatcher.handleChatRoomMessage(
    agentMessage({ roomId: 'room-typing', senderId: SENDER, memberIds: [SENDER, HERMES] }),
  );

  assert.ok(typingPosts.length > 0, 'the dispatch must raise at least one typing indicator');
  for (const post of typingPosts) {
    assert.equal(
      post.agent_id,
      HERMES,
      `typing must be attributed to the responder (${HERMES}), got "${post.agent_id}" — ` +
        'a manager id here renders as "<manager> is thinking" instead of "<manager>/<agent>"',
    );
  }

  // The reply and the indicator must agree on the id, or the client-side
  // auto-clear (keyed by sender_id) never fires.
  assert.equal(chatMessagePosts.length, 1, 'the responder must actually reply');
  assert.equal(chatMessagePosts[0].agent_id, HERMES);
  const ids = new Set(typingPosts.map((p) => p.agent_id));
  assert.deepEqual([...ids], [chatMessagePosts[0].agent_id],
    'set and clear must share the id the reply is posted under');
});

test('the caller-supplied agent_name is not a bare manager name for a delegated turn', async (t) => {
  const { dispatcher } = await harness(t);

  await dispatcher.handleChatRoomMessage(
    agentMessage({ roomId: 'room-typing-name', senderId: SENDER, memberIds: [SENDER, HERMES] }),
  );

  // The server re-resolves the display from agent_id; the hint is only used
  // when that lookup misses. Sending the manager's own name alongside another
  // agent's id is exactly the mismatch that produced the wrong label, so the
  // hint must be blank whenever the responder is not this manager.
  for (const post of typingPosts) {
    assert.equal(post.agent_name, '',
      `agent_name hint must be blank for a delegated responder, got "${post.agent_name}"`);
  }
});
