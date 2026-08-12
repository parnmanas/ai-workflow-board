import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { RuntimeSupervisor } from '../dist/lib/runtime/runtime-supervisor.js';
import { spawnFailureTracker } from '../dist/lib/spawn-failure-tracker.js';

// ticket a837879c 리뷰 지적 #1/#4: hermes-chat-dispatch-failure.test.mjs 는
// runtimeSupervisor 자체가 없는 fail-closed 경로만 검증한다(#dispatchHermes() 가
// throw 하는 경우). 여기서는 실제 RuntimeSupervisor 를 fake-acp-server.mjs 픽스처로
// 구동해 dispatch() 가 throw 없이 resolve 하는 두 경우를 각각 검증한다:
//
//  1. stopReason='end_turn' (정상 종료) — 실패 알림이 채팅방에 가면 안 되고,
//     spawnFailureTracker 의 degraded 신호가 있었다면 해소돼야 한다.
//  2. stopReason!=='end_turn' (예: 'refusal') — Hermes 가 응답을 위해 호출해야 하는
//     MCP 도구 자체가 permission_mode 로 인해 조용히 cancel 된 경우로, 리뷰가
//     "무응답인데 성공 처리됨"으로 지적한 바로 그 시나리오다. 실패와 동일하게
//     allowlist 코드가 채팅방에 남고 spawnFailureTracker 가 degraded 로 갱신돼야 한다.

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));
const AGENT = 'agent-hermes-success';

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

function context(permissionMode) {
  return {
    agent_id: AGENT,
    name: 'Hermes success agent',
    cli: 'hermes',
    working_dir: '/workspace',
    mcp_config_path: '/config/mcp.json',
    api_key: 'agent-api-key',
    cli_home_dir: '/cli-home',
    extra_env: {},
    credential_provider: null,
    model: null,
    runtime_config: { strategy: 'single', permission_mode: permissionMode, profile: 'coding' },
  };
}

async function harness(t, permissionMode) {
  const rootDir = await mkdtemp(join(tmpdir(), 'awb-hermes-chat-'));
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
    get: (id) => (id === AGENT ? context(permissionMode) : null),
    has: (id) => id === AGENT,
    list: () => [context(permissionMode)],
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

function chatRoomMessage(roomId) {
  return JSON.stringify({
    event_type: 'chat_room_message',
    timestamp: '2026-08-13T00:00:00.000Z',
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

test('Hermes chat room dispatch that ends cleanly (stop=end_turn) posts no failure notice and clears the degraded signal', async (t) => {
  const { dispatcher } = await harness(t, 'trusted');
  // Simulate a still-open degraded badge from an earlier failure — success must clear it.
  spawnFailureTracker.record({ cli: 'hermes', code: 'acp_timeout', message: 'prior failure' });

  await dispatcher.handleChatRoomMessage(chatRoomMessage('room-success'));

  assert.equal(chatMessagePosts.length, 0);
  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, null);
  assert.equal(snap.last_spawn_error, null);
});

test('Hermes chat room dispatch that resolves without a confirmed reply (stop=refusal) posts a visible allowlisted notice', async (t) => {
  const { dispatcher } = await harness(t, 'strict');

  await dispatcher.handleChatRoomMessage(chatRoomMessage('room-refusal'));

  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].url, 'http://127.0.0.1:0/api/agent/chat-rooms/room-refusal/messages');
  assert.equal(chatMessagePosts[0].body.agent_id, AGENT);
  assert.equal(
    chatMessagePosts[0].body.content,
    '⚠️ **Hermes 런타임 실행 실패** (`refusal`)\n\n' +
      '이 메시지에 응답하지 못했습니다. Agent Manager 로그를 확인한 뒤 다시 시도하세요.',
  );

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, 'hermes');
  assert.match(snap.last_spawn_error, /refusal/);
});
