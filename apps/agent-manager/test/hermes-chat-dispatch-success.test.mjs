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
// 구동해 dispatch() 가 throw 없이 resolve 하는 경우들을 검증한다:
//
//  1. stopReason='end_turn' (정상 종료) — ticket a837879c 재리뷰 지적 #1: end_turn
//     자체는 send_chat_room_message 호출이 실제로 성공했다는 증거가 아니므로,
//     Manager 가 세션 중 관측한 agent_message_chunk 델타(fixture 는 'hello' 고정)를
//     직접 postChatRoomMessage 로 방에 게시하고, 그 실제 응답 본문이 정말 POST
//     됐는지 + spawnFailureTracker 의 degraded 신호가 해소됐는지를 검증한다.
//  2. stopReason!=='end_turn' (예: 'refusal') — Hermes 가 응답을 위해 호출해야 하는
//     MCP 도구 자체가 permission_mode 로 인해 조용히 cancel 된 경우로, 리뷰가
//     "무응답인데 성공 처리됨"으로 지적한 바로 그 시나리오다. 실패와 동일하게
//     allowlist 코드가 채팅방에 남고 spawnFailureTracker 가 degraded 로 갱신돼야 한다.
//  3. stopReason='end_turn' 이지만 그 응답 POST 자체가 실패하는 경우 — 재리뷰
//     지적 #1 이 명시적으로 요구한 두 번째 단언: 응답 POST 실패도 실패/degraded
//     경로로 가야 한다.

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
    if (target.includes('/api/agent/ordinary-work-board-candidates')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
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

test('Hermes chat room dispatch that ends cleanly (stop=end_turn) posts the actual reply to the room and clears the degraded signal', async (t) => {
  const { dispatcher } = await harness(t, 'trusted');
  // Simulate a still-open degraded badge from an earlier failure — success must clear it.
  spawnFailureTracker.record({ cli: 'hermes', code: 'acp_timeout', message: 'prior failure' });

  await dispatcher.handleChatRoomMessage(chatRoomMessage('room-success'));

  // fake-acp-server.mjs streams exactly one agent_message_chunk with text
  // 'hello' per session/prompt turn — the manager must collect it and POST it
  // as the real reply, not infer success from stopReason alone.
  assert.equal(chatMessagePosts.length, 1);
  assert.equal(chatMessagePosts[0].url, 'http://127.0.0.1:0/api/agent/chat-rooms/room-success/messages');
  assert.equal(chatMessagePosts[0].body.agent_id, AGENT);
  assert.equal(chatMessagePosts[0].body.content, 'hello');

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, null);
  assert.equal(snap.last_spawn_error, null);
});

test('Hermes chat room dispatch that ends cleanly (stop=end_turn) but fails to POST the reply routes to the failure path', async (t) => {
  const { dispatcher } = await harness(t, 'trusted');

  // Let the reply POST (content: 'hello') fail while any other POST (e.g. the
  // failure notice that follows) still succeeds, so both messages are visible
  // for inspection regardless of outcome.
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method || 'GET';
    if (target.includes('/api/agent/ordinary-work-board-candidates')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.includes('/api/agent/chat-rooms/') && target.endsWith('/messages') && method === 'POST') {
      const body = JSON.parse(init?.body || '{}');
      chatMessagePosts.push({ url: target, body });
      if (body.content === 'hello') {
        return new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await dispatcher.handleChatRoomMessage(chatRoomMessage('room-post-fail'));

  assert.equal(chatMessagePosts.length, 2);
  assert.equal(chatMessagePosts[0].body.content, 'hello');
  assert.match(chatMessagePosts[1].body.content, /Hermes 런타임 실행 실패/);
  assert.match(chatMessagePosts[1].body.content, /hermes_reply_post_failed/);

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, 'hermes');
  assert.match(snap.last_spawn_error, /hermes_reply_post_failed/);
  assert.match(snap.last_spawn_error, /reply POST/);
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
