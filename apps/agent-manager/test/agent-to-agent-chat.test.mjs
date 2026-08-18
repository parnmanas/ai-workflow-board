import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { RuntimeSupervisor } from '../dist/lib/runtime/runtime-supervisor.js';

// 같은 매니저가 호스팅하는 형제 에이전트끼리 채팅으로 서로를 깨울 수 있어야 한다.
//
// 예전 #senderIsSelf() 는 managedAgentContexts.has(senderId) 로 판정해서 "이 호스트가
// 관리하는 모든 에이전트"를 자기 자신으로 취급했고, 그 결과 Manager -> Hermes DM 이
// 런타임 spawn 도 없이 "Chat room message from self — skipping delegation" 으로
// 통째로 버려졌다. 루프 방지는 바로 아래 agent_chain_depth 캡이 이미 담당한다.
//
// 지금 계약: 발신자는 후보에서 제외하되(자기 메시지에 자기가 답하지 않음), 방의 다른
// 관리 대상 멤버가 있으면 그 에이전트로 위임한다. 다른 멤버가 없을 때만 드롭한다.

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));
const HERMES = 'agent-hermes-sibling';
const SIBLING = 'agent-manager-sibling';

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
    name: 'Hermes sibling',
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
  const rootDir = await mkdtemp(join(tmpdir(), 'awb-a2a-chat-'));
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
  // 두 에이전트 모두 이 매니저가 관리한다 — 예전 규칙이라면 둘 다 "self".
  // 단 형제(SIBLING)는 컨텍스트를 돌려주지 않아, 위임 대상으로 뽑히는 쪽은
  // 언제나 HERMES 하나뿐이다.
  const managedAgentContexts = {
    get: (id) => (id === HERMES ? hermesContext() : null),
    has: (id) => id === HERMES || id === SIBLING,
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

function agentMessage({ roomId, senderId, memberIds, depth }) {
  return JSON.stringify({
    event_type: 'chat_room_message',
    timestamp: '2026-08-18T00:00:00.000Z',
    payload: {
      agent_member_ids: memberIds,
      room_id: roomId,
      sender_id: senderId,
      sender_name: senderId,
      sender_type: 'agent',
      agent_chain_depth: depth ?? 0,
      content: 'ping from a sibling agent',
    },
  });
}

test('a message from a managed sibling is delegated to the other managed agent in the room', async (t) => {
  const { dispatcher } = await harness(t);

  await dispatcher.handleChatRoomMessage(
    agentMessage({ roomId: 'room-sibling', senderId: SIBLING, memberIds: [SIBLING, HERMES] }),
  );

  // fake-acp-server.mjs 는 턴당 'hello' 하나를 스트리밍한다. 이게 올라왔다는 것은
  // Hermes 런타임이 실제로 spawn 되어 응답을 돌려줬다는 뜻이다.
  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].url, 'http://127.0.0.1:0/api/agent/chat-rooms/room-sibling/messages');
  assert.equal(chatMessagePosts[0].body.agent_id, HERMES);
  assert.equal(chatMessagePosts[0].body.content, 'hello');
});

test('the sender is never picked as its own responder even when it is listed first', async (t) => {
  const { dispatcher } = await harness(t);

  await dispatcher.handleChatRoomMessage(
    agentMessage({ roomId: 'room-self-first', senderId: HERMES, memberIds: [HERMES, SIBLING] }),
  );

  // HERMES 가 발신자이므로 후보에서 빠지고, 남은 SIBLING 은 컨텍스트가 없다 →
  // 위임할 상대가 없으므로 아무것도 게시되지 않아야 한다 (자문자답 금지).
  assert.equal(chatMessagePosts.length, 0);
});

test('a lone managed sender in the room is still dropped', async (t) => {
  const { dispatcher } = await harness(t);

  await dispatcher.handleChatRoomMessage(
    agentMessage({ roomId: 'room-alone', senderId: HERMES, memberIds: [HERMES] }),
  );

  assert.equal(chatMessagePosts.length, 0);
});

test('the agent_chain_depth cap still stops a sibling conversation from running away', async (t) => {
  const { dispatcher } = await harness(t);

  await dispatcher.handleChatRoomMessage(
    agentMessage({ roomId: 'room-capped', senderId: SIBLING, memberIds: [SIBLING, HERMES], depth: 3 }),
  );

  assert.equal(chatMessagePosts.length, 0);
});
