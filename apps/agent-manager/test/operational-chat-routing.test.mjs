import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CodexCliAdapter } from '../dist/lib/cli-adapters/codex.js';
import { ADAPTER_CAPABILITIES } from '../dist/lib/cli-adapters/base.js';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import {
  ensureOperationalFallbackTicket,
  ensureOrdinaryWorkFallbackTicket,
  parseOrdinaryWorkFallback,
  operationalDedupeKey,
  parseOperationalFallback,
} from '../dist/lib/operational-chat-fallback.js';
import { fetchOrdinaryWorkBoardCandidates } from '../dist/lib/rest.js';
import { composeChatRoomPrompt } from '../dist/lib/prompts.js';

const config = { url: 'https://awb.invalid', apiKey: 'key', workspace_id: 'workspace-1' };
const marker = (operation = 'deploy awb') =>
  `진행 수단을 확인했습니다.\nAWB_OPERATIONAL_FALLBACK: ${JSON.stringify({ operation, missing_capability: 'awb deploy mcp', original_request: 'AWB 올려줘' })}`;

test('persistent chat derives native MCP routing from the selected adapter', () => {
  assert.equal(new CodexCliAdapter().has(ADAPTER_CAPABILITIES.NATIVE_MCP), true);
});

test('non-native missing MCP output creates one capability ticket through REST boundary', async () => {
  const request = parseOperationalFallback(marker());
  assert.ok(request);
  const calls = [];
  const result = await ensureOperationalFallbackTicket(config, request, { room_id: 'room-1', message_id: 'msg-1' }, async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'ticket-1', title: '[운영 자동화] deploy awb', reused: false }), { status: 201 });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.room_id, 'room-1');
  assert.equal(result.id, 'ticket-1');
});

test('same and rephrased requests share the server dedupe key when normalized operation matches', () => {
  const first = parseOperationalFallback(marker('Deploy   AWB'));
  const rephrased = parseOperationalFallback(marker('deploy awb'));
  assert.ok(first && rephrased);
  assert.equal(operationalDedupeKey('workspace-1', first), operationalDedupeKey('workspace-1', rephrased));
});

test('fallback failure is observable to the caller', async () => {
  const request = parseOperationalFallback(marker());
  assert.ok(request);
  await assert.rejects(
    ensureOperationalFallbackTicket(config, request, { room_id: 'room-1', message_id: 'msg-1' }, async () =>
      new Response('database unavailable', { status: 503 })),
    /operational fallback ticket failed: 503 database unavailable/,
  );
});

test('manager posts a later Action execution result without creating another capability ticket', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'chat-answer' }), { status: 201 });
  };
  try {
    const manager = new SubagentManager({ ...config, delegation: { enabled: true, maxConcurrent: 2, ttlMinutes: 15 } });
    const actionResult = 'Action 재검색 결과 action-7을 찾았고 run-9를 1회 실행했습니다.';
    await manager._handleOneshotExit({
      pid: 99102, kind: 'chat', cli_type: 'codex', trigger_id: null,
      chat_request_id: 'msg-action', ticket_id: null, agent_id: 'agent-1', role: null,
      room_id: 'room-real', started_at: Date.now(), config_path: null,
      config_path_is_temp: false, captureOutput: true,
      outLines: [
        JSON.stringify({ type: 'thread.started' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: actionResult } }),
        JSON.stringify({ type: 'turn.completed' }),
      ],
      tailLines: [], commentSent: false, tap: null,
    }, 0);
    assert.equal(calls.filter(c => c.url.endsWith('/operational-capability-ticket')).length, 0);
    assert.equal(calls.filter(c => c.url.includes('/chat-rooms/')).length, 1);
    assert.equal(calls.find(c => c.url.includes('/chat-rooms/')).body.content, actionResult);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manager oneshot exit replaces the marker with the server ticket result at the real REST/chat boundary', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/agent/operational-capability-ticket')) {
      return new Response(JSON.stringify({ id: 'ticket-actual', title: 'capability 추가', reused: false }), { status: 201 });
    }
    return new Response(JSON.stringify({ id: 'chat-answer' }), { status: 201 });
  };
  try {
    const manager = new SubagentManager({
      ...config,
      delegation: { enabled: true, maxConcurrent: 2, ttlMinutes: 15 },
    });
    await manager._handleOneshotExit({
      pid: 99101, kind: 'chat', cli_type: 'codex', trigger_id: null,
      chat_request_id: 'msg-real', ticket_id: null, agent_id: 'agent-1', role: null,
      room_id: 'room-real', started_at: Date.now(), config_path: null,
      config_path_is_temp: false, captureOutput: true,
      outLines: [
        JSON.stringify({ type: 'thread.started' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: marker() } }),
        JSON.stringify({ type: 'turn.completed' }),
      ],
      tailLines: [], commentSent: false, tap: null,
    }, 0);
    assert.equal(calls.filter(c => c.url.endsWith('/operational-capability-ticket')).length, 1);
    const ticketCall = calls.find(c => c.url.endsWith('/operational-capability-ticket'));
    assert.equal(ticketCall.body.message_id, 'msg-real');
    const chatCall = calls.find(c => c.url.includes('/chat-rooms/'));
    assert.ok(chatCall, 'manager posted the replaced chat answer');
    assert.match(chatCall.body.content, /새 capability 티켓을 자동 생성.*ticket-actual/);
    assert.doesNotMatch(chatCall.body.content, /AWB_OPERATIONAL_FALLBACK/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-native one-shot ordinary code change creates one focused ticket linked to the source room', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/agent/ordinary-work-ticket')) {
      return new Response(JSON.stringify({ id: 'ticket-focused', title: '로그인 오류 수정', reused: false }), { status: 201 });
    }
    return new Response(JSON.stringify({ id: 'chat-answer' }), { status: 201 });
  };
  try {
    const output = `처리하겠습니다.\nAWB_ORDINARY_WORK_FALLBACK: ${JSON.stringify({
      board_id: 'board-suitable', title: '로그인 오류 수정',
      description: '재현 테스트를 추가하고 오류를 수정한다.', original_request: '로그인 오류를 고쳐줘',
    })}`;
    assert.ok(parseOrdinaryWorkFallback(output));
    const manager = new SubagentManager({ ...config, delegation: { enabled: true, maxConcurrent: 2, ttlMinutes: 15 } });
    await manager._handleOneshotExit({
      pid: 99103, kind: 'chat', cli_type: 'codex', trigger_id: null,
      chat_request_id: 'msg-code-change', ticket_id: null, agent_id: 'agent-1', role: null,
      room_id: 'room-source', started_at: Date.now(), config_path: null,
      config_path_is_temp: false, captureOutput: true,
      outLines: [
        JSON.stringify({ type: 'thread.started' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: output } }),
        JSON.stringify({ type: 'turn.completed' }),
      ],
      tailLines: [], commentSent: false, tap: null,
    }, 0);
    const ticketCalls = calls.filter(c => c.url.endsWith('/api/agent/ordinary-work-ticket'));
    assert.equal(ticketCalls.length, 1, 'focused ticket creation is requested exactly once');
    assert.equal(ticketCalls[0].body.board_id, 'board-suitable');
    assert.equal(ticketCalls[0].body.room_id, 'room-source');
    assert.equal(ticketCalls[0].body.message_id, 'msg-code-change');
    const chatCall = calls.find(c => c.url.includes('/chat-rooms/'));
    assert.match(chatCall.body.content, /작업 티켓을 자동 생성하고 워크플로에 연결.*ticket-focused/);
    assert.doesNotMatch(chatCall.body.content, /AWB_ORDINARY_WORK_FALLBACK/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-native prompt receives real existing board candidates before selecting a ticket destination', async () => {
  const boards = await fetchOrdinaryWorkBoardCandidates(config, async () =>
    new Response(JSON.stringify([{ id: 'board-real', name: '제품 개발', description: '제품 코드 변경' }]), { status: 200 }));
  const prompt = composeChatRoomPrompt(
    'room-1', [], { content: '로그인 오류를 고쳐줘', sender_name: '사용자', sender_id: 'user-1' },
    undefined, false, undefined, '', false, '', boards,
  );
  assert.match(prompt, /제품 개발 \| board-real \| 제품 코드 변경/);
  assert.match(prompt, /use only these UUIDs/);
});

test('ordinary-work board HTTP failure stops routing instead of becoming a direct-chat exception', async () => {
  await assert.rejects(
    fetchOrdinaryWorkBoardCandidates(config, async () =>
      new Response('일시적 서버 오류', { status: 500 })),
    /HTTP 500/,
  );
});

test('ordinary-work board timeout stops routing instead of producing a marker or direct execution', async () => {
  const timeout = new Error('요청 시간 초과');
  timeout.name = 'TimeoutError';
  await assert.rejects(
    fetchOrdinaryWorkBoardCandidates(config, async () => { throw timeout; }),
    error => error === timeout,
  );
});

test('only a successful empty board response enables the no-board direct-chat exception', async () => {
  const boards = await fetchOrdinaryWorkBoardCandidates(config, async () =>
    new Response(JSON.stringify([]), { status: 200 }));
  const prompt = composeChatRoomPrompt(
    'room-1', [], { content: '작업해줘', sender_name: '사용자', sender_id: 'user-1' },
    undefined, false, undefined, '', false, '', boards,
  );
  assert.match(prompt, /none; treat this as the no-suitable-existing-board direct-chat exception/);
});

test('ordinary fallback sends the selected pre-injected board exactly once', async () => {
  const calls = [];
  const request = { board_id: 'board-real', title: '로그인 오류 수정', description: '회귀 테스트 포함' };
  await ensureOrdinaryWorkFallbackTicket(config, request, { room_id: 'room-1', message_id: 'msg-1' }, async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'ticket-1', title: request.title, reused: false }), { status: 201 });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.board_id, 'board-real');
});
