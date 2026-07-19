import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CodexCliAdapter } from '../dist/lib/cli-adapters/codex.js';
import { ADAPTER_CAPABILITIES } from '../dist/lib/cli-adapters/base.js';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import {
  ensureOperationalFallbackTicket,
  operationalDedupeKey,
  parseOperationalFallback,
} from '../dist/lib/operational-chat-fallback.js';

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
