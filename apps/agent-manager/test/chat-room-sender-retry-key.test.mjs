// 단위 테스트 — 401/403 발생 시 chat-room 전송부가 매니저 키로 재시도하는지
// 검증 (ticket 7d8ea7c9 후속).
//
// chat 세션의 per-agent 키(_effectiveApiKey)는 spawn 시점에 한 번만 캡처되어
// 세션 수명 내내 재사용된다. 세션 도중 stale 해지거나 스코프를 벗어나면 AWB
// 서버의 AgentAuthGuard/workspace-scope 체크가 401 또는 403 으로 거부하는데,
// classifyHttpSendFailure 는 둘 다 'permanent' 로 분류해 이후 버퍼링/재시도를
// 하지 않는다 — 그 결과 session-status ping 과 턴 실패 fallback 메시지가
// 사용자에게 아무 설명도 없이 조용히 사라진다. AwbConfig.retryApiKey 는 이
// 두 전송 함수가 포기하기 전에 매니저 자체의 항상 유효하고 workspace 에
// 종속되지 않는 키로 한 번 더 재시도하게 한다.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// dist import 전에 AGENT_MANAGER_HOME 을 격리한다 (constants 가 import 시점에 값을 확정하므로).
process.env.AWB_AGENT_MANAGER_HOME = mkdtempSync(join(tmpdir(), 'awb-chat-retry-test-'));

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;

const { postChatRoomMessage, postChatRoomMessageRaw, postChatRoomSessionStatus } =
  await import('../dist/lib/rest.js');

const BASE = { url: 'http://awb.test:7701' };

function fetchSequence(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (_url, init) => {
      calls.push({ apiKey: init?.headers?.['X-Agent-Key'] });
      const next = responses[calls.length - 1];
      if (!next) throw new Error(`unexpected extra fetch call (#${calls.length})`);
      return new Response(next.body ?? '{}', { status: next.status, statusText: next.statusText ?? '' });
    },
  };
}

async function withFetch(fetchImpl, run) {
  const orig = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = orig;
  }
}

test('postChatRoomMessage retries with retryApiKey on a 403 from the session key', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }, { status: 201 }]);
  const ok = await withFetch(fetch, () => postChatRoomMessage(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
    'room-1', 'agent-1', 'hello',
  ));
  assert.equal(ok, true);
  assert.deepEqual(calls.map(c => c.apiKey), ['session-key', 'manager-key']);
});

test('postChatRoomMessage retries with retryApiKey on a 401 from the session key', async () => {
  const { calls, fetch } = fetchSequence([{ status: 401, statusText: 'Unauthorized' }, { status: 201 }]);
  const ok = await withFetch(fetch, () => postChatRoomMessage(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
    'room-1', 'agent-1', 'bye',
  ));
  assert.equal(ok, true);
  assert.deepEqual(calls.map(c => c.apiKey), ['session-key', 'manager-key']);
});

test('postChatRoomMessage does not retry a 403 when retryApiKey is unset', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }]);
  const ok = await withFetch(fetch, () => postChatRoomMessage(
    { ...BASE, apiKey: 'only-key' },
    'room-1', 'agent-1', 'no fallback configured',
  ));
  assert.equal(ok, false);
  assert.equal(calls.length, 1, 'no retryApiKey — single attempt, matches pre-fix behavior');
});

test('postChatRoomMessage does not retry when retryApiKey equals the key that just failed', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }]);
  const ok = await withFetch(fetch, () => postChatRoomMessage(
    { ...BASE, apiKey: 'same-key', retryApiKey: 'same-key' },
    'room-1', 'agent-1', 'identical fallback',
  ));
  assert.equal(ok, false);
  assert.equal(calls.length, 1, 'retrying with the identical key would fail identically');
});

test('postChatRoomMessageRaw does not credential-retry a 5xx (transport issue, stays outbox-retryable)', async () => {
  const { calls, fetch } = fetchSequence([{ status: 503, statusText: 'Unavailable' }]);
  const outcome = await withFetch(fetch, () => postChatRoomMessageRaw(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
    'room-1', 'agent-1', 'server hiccup',
  ));
  assert.equal(outcome, 'retryable');
  assert.equal(calls.length, 1, '5xx is not an auth failure — no credential swap, outbox handles the retry later');
});

test('postChatRoomMessageRaw gives up after the retryApiKey attempt also fails', async () => {
  const { calls, fetch } = fetchSequence([
    { status: 403, statusText: 'Forbidden' },
    { status: 403, statusText: 'Forbidden' },
  ]);
  const outcome = await withFetch(fetch, () => postChatRoomMessageRaw(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
    'room-1', 'agent-1', 'still broken',
  ));
  assert.equal(outcome, 'permanent');
  assert.equal(calls.length, 2, 'exactly one retry attempt — no infinite loop');
});

test('postChatRoomSessionStatus retries with retryApiKey on a 403', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }, { status: 200 }]);
  await withFetch(fetch, () => postChatRoomSessionStatus(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
    'room-1', 'agent-1', { keep_alive_until_ms: null, background_task_count: 0 },
  ));
  assert.deepEqual(calls.map(c => c.apiKey), ['session-key', 'manager-key']);
});

test('postChatRoomSessionStatus does not retry when no retryApiKey is configured', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }]);
  await withFetch(fetch, () => postChatRoomSessionStatus(
    { ...BASE, apiKey: 'only-key' },
    'room-1', 'agent-1', { keep_alive_until_ms: null, background_task_count: 0 },
  ));
  assert.equal(calls.length, 1);
});
