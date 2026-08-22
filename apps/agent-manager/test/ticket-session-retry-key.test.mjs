// 단위 테스트 — ticket-dispatch 세션의 output-liveness heartbeat / 세션-split
// 감사 코멘트(add_comment) / silent-exit fallback 코멘트 전송부가 401/403
// 발생 시 매니저 키로 재시도하는지 검증 (ticket 23253aeb, 7d8ea7c9 후속).
//
// ticket-dispatch 세션의 per-agent 키(sess._effectiveApiKey)도 chat 세션과
// 동일하게 spawn 시점에 한 번만 캡처되어 세션 수명 내내 재사용된다. 세션
// 도중 stale 해지거나 스코프를 벗어나면 AWB 서버가 401/403 으로 거부하는데,
// classifyHttpSendFailure 는 둘 다 'permanent' 로 분류해 이후 버퍼링/재시도를
// 하지 않는다 — 특히 postSilentExitSystemComment 가 조용히 실패하면 티켓에
// silent-exit 코멘트가 전혀 안 남고 dispatch loop만 계속 재시도하는 형태로
// 나타날 수 있다. AwbConfig.retryApiKey 는 이 함수들이 포기하기 전에 매니저
// 자체의 항상 유효하고 workspace 에 종속되지 않는 키로 한 번 더 재시도하게
// 한다.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// dist import 전에 AGENT_MANAGER_HOME 을 격리한다 (constants 가 import 시점에 값을 확정하므로).
process.env.AWB_AGENT_MANAGER_HOME = mkdtempSync(join(tmpdir(), 'awb-ticket-retry-test-'));

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;

const { postOutputLiveness, postSilentExitSystemComment, postSilentExitSystemCommentRaw } =
  await import('../dist/lib/rest.js');
const { callMcpTool, fireAndForgetTool } = await import('../dist/lib/mcp-client.js');

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

// ── postOutputLiveness ──────────────────────────────────────────────────────
// Signature is (config, apiKey, body) — `apiKey` is the primary key (mirrors
// `sess._effectiveApiKey || this._config.apiKey` at the call site) and
// `config.retryApiKey` is the fallback, matching the real ticket-session-manager
// call site wiring.

test('postOutputLiveness retries with retryApiKey on a 403 from the session key', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }, { status: 200 }]);
  await withFetch(fetch, () => postOutputLiveness(
    { ...BASE, apiKey: 'manager-key', retryApiKey: 'manager-key' },
    'session-key',
    { agent_id: 'agent-1', ticket_id: 'ticket-1', role: 'assignee' },
  ));
  assert.deepEqual(calls.map((c) => c.apiKey), ['session-key', 'manager-key']);
});

test('postOutputLiveness retries with retryApiKey on a 401 from the session key', async () => {
  const { calls, fetch } = fetchSequence([{ status: 401, statusText: 'Unauthorized' }, { status: 200 }]);
  await withFetch(fetch, () => postOutputLiveness(
    { ...BASE, apiKey: 'manager-key', retryApiKey: 'manager-key' },
    'session-key',
    { agent_id: 'agent-1', ticket_id: 'ticket-1', role: 'assignee' },
  ));
  assert.deepEqual(calls.map((c) => c.apiKey), ['session-key', 'manager-key']);
});

test('postOutputLiveness does not retry a 403 when retryApiKey is unset', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }]);
  await withFetch(fetch, () => postOutputLiveness(
    { ...BASE, apiKey: 'only-key' },
    'only-key',
    { agent_id: 'agent-1', ticket_id: 'ticket-1', role: 'assignee' },
  ));
  assert.equal(calls.length, 1, 'no retryApiKey — single attempt, matches pre-fix behavior');
});

test('postOutputLiveness does not retry when retryApiKey equals the key that just failed', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }]);
  await withFetch(fetch, () => postOutputLiveness(
    { ...BASE, apiKey: 'same-key', retryApiKey: 'same-key' },
    'same-key',
    { agent_id: 'agent-1', ticket_id: 'ticket-1', role: 'assignee' },
  ));
  assert.equal(calls.length, 1, 'retrying with the identical key would fail identically');
});

test('postOutputLiveness makes a single call when the primary key already succeeds', async () => {
  const { calls, fetch } = fetchSequence([{ status: 200 }]);
  await withFetch(fetch, () => postOutputLiveness(
    { ...BASE, apiKey: 'manager-key', retryApiKey: 'manager-key' },
    'session-key',
    { agent_id: 'agent-1', ticket_id: 'ticket-1', role: 'assignee' },
  ));
  assert.deepEqual(calls.map((c) => c.apiKey), ['session-key']);
});

// ── postSilentExitSystemComment(Raw) ────────────────────────────────────────

test('postSilentExitSystemCommentRaw retries with retryApiKey on a 401 from the session key', async () => {
  const { calls, fetch } = fetchSequence([{ status: 401, statusText: 'Unauthorized' }, { status: 201 }]);
  const outcome = await withFetch(fetch, () => postSilentExitSystemCommentRaw(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
    'ticket-1',
    { content: 'silent exit fallback body', exit_code: 0 },
  ));
  assert.equal(outcome.outcome, 'ok');
  assert.equal(outcome.result, 'created');
  assert.deepEqual(calls.map((c) => c.apiKey), ['session-key', 'manager-key']);
});

test('postSilentExitSystemCommentRaw does not retry a 403 when retryApiKey is unset', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }]);
  const outcome = await withFetch(fetch, () => postSilentExitSystemCommentRaw(
    { ...BASE, apiKey: 'only-key' },
    'ticket-1',
    { content: 'no fallback configured', exit_code: 1 },
  ));
  assert.equal(outcome.outcome, 'permanent');
  assert.equal(outcome.result, 'failed');
  assert.equal(calls.length, 1, 'no retryApiKey — single attempt, matches pre-fix behavior');
});

test('postSilentExitSystemCommentRaw does not credential-retry a 5xx (stays outbox-retryable)', async () => {
  const { calls, fetch } = fetchSequence([{ status: 503, statusText: 'Unavailable' }]);
  const outcome = await withFetch(fetch, () => postSilentExitSystemCommentRaw(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
    'ticket-1',
    { content: 'server hiccup', exit_code: 1 },
  ));
  assert.equal(outcome.outcome, 'retryable');
  assert.equal(calls.length, 1, '5xx is not an auth failure — no credential swap, outbox handles the retry later');
});

test('postSilentExitSystemCommentRaw gives up after the retryApiKey attempt also fails', async () => {
  const { calls, fetch } = fetchSequence([
    { status: 403, statusText: 'Forbidden' },
    { status: 403, statusText: 'Forbidden' },
  ]);
  const outcome = await withFetch(fetch, () => postSilentExitSystemCommentRaw(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
    'ticket-1',
    { content: 'still broken', exit_code: 1 },
  ));
  assert.equal(outcome.outcome, 'permanent');
  assert.equal(calls.length, 2, 'exactly one retry attempt — no infinite loop');
});

test('postSilentExitSystemComment (grace-delay wrapper) surfaces the retried success', async () => {
  const { calls, fetch } = fetchSequence([{ status: 401, statusText: 'Unauthorized' }, { status: 201 }]);
  const result = await withFetch(fetch, () => postSilentExitSystemComment(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key', silentExitVerifyDelayMs: 0 },
    'ticket-1',
    { content: 'silent exit fallback body', exit_code: 0 },
  ));
  assert.equal(result, 'created');
  assert.deepEqual(calls.map((c) => c.apiKey), ['session-key', 'manager-key']);
});

// ── callMcpTool / fireAndForgetTool (session-split add_comment) ─────────────
// callMcpTool opens a fresh MCP session per call (initialize → notifications/
// initialized → tools/call → DELETE), all authenticated via a single Bearer
// token baked in at handshake start. A stale per-agent key surfaces as a
// 401/403 on `initialize`; on retry the ENTIRE handshake re-runs with
// `config.retryApiKey` since the session id is tied to the key that opened it.

function makeMcpFetch({ initStatusByKey, toolResultText = '{"ok":true}' }) {
  const calls = [];
  const fetch = async (_url, init) => {
    const auth = init?.headers?.Authorization || '';
    const apiKey = auth.replace(/^Bearer\s+/, '');
    const method = init?.method || 'GET';
    let rpcMethod = null;
    if (init?.body) {
      try {
        rpcMethod = JSON.parse(init.body)?.method;
      } catch {
        /* not JSON-RPC (shouldn't happen here) */
      }
    }
    calls.push({ method, rpcMethod, apiKey });
    if (method === 'DELETE') {
      return new Response('{}', { status: 200 });
    }
    if (rpcMethod === 'initialize') {
      const status = initStatusByKey[apiKey] ?? 200;
      if (status !== 200) {
        return new Response('{}', { status, statusText: 'Unauthorized' });
      }
      return new Response('{}', { status: 200, headers: { 'mcp-session-id': 'sid-test-1' } });
    }
    if (rpcMethod === 'notifications/initialized') {
      return new Response('{}', { status: 200 });
    }
    if (rpcMethod === 'tools/call') {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: toolResultText }] },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${method} ${rpcMethod}`);
  };
  return { calls, fetch };
}

test('callMcpTool retries the whole handshake with retryApiKey when initialize gets 403', async () => {
  const { calls, fetch } = makeMcpFetch({ initStatusByKey: { 'session-key': 403, 'manager-key': 200 } });
  const result = await withFetch(fetch, () => callMcpTool(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
    'add_comment',
    { ticket_id: 't1', content: 'hi' },
  ));
  assert.equal(result?.result?.content?.[0]?.text, '{"ok":true}');
  const initCalls = calls.filter((c) => c.rpcMethod === 'initialize');
  assert.deepEqual(initCalls.map((c) => c.apiKey), ['session-key', 'manager-key']);
  assert.ok(
    calls.some((c) => c.rpcMethod === 'tools/call' && c.apiKey === 'manager-key'),
    'the rest of the handshake (notify/call/delete) uses the successful retry key',
  );
});

test('callMcpTool does not retry when retryApiKey is unset — throws on the 401', async () => {
  const { calls, fetch } = makeMcpFetch({ initStatusByKey: { 'only-key': 401 } });
  await assert.rejects(
    () => withFetch(fetch, () => callMcpTool({ ...BASE, apiKey: 'only-key' }, 'add_comment', {})),
    /initialize HTTP 401/,
  );
  assert.equal(calls.length, 1, 'no retryApiKey — single initialize attempt, matches pre-fix behavior');
});

test('callMcpTool does not retry when retryApiKey equals the key that just failed', async () => {
  const { calls, fetch } = makeMcpFetch({ initStatusByKey: { 'same-key': 403 } });
  await assert.rejects(
    () => withFetch(fetch, () => callMcpTool(
      { ...BASE, apiKey: 'same-key', retryApiKey: 'same-key' },
      'add_comment',
      {},
    )),
    /initialize HTTP 403/,
  );
  assert.equal(calls.length, 1, 'retrying with the identical key would fail identically');
});

test('callMcpTool does not credential-retry a 5xx from initialize (not an auth failure)', async () => {
  const { calls, fetch } = makeMcpFetch({ initStatusByKey: { 'session-key': 503 } });
  await assert.rejects(
    () => withFetch(fetch, () => callMcpTool(
      { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
      'add_comment',
      {},
    )),
    /initialize HTTP 503/,
  );
  assert.equal(calls.length, 1, '5xx is not an auth failure — no credential swap');
});

test('callMcpTool makes a single initialize call when the primary key already succeeds', async () => {
  const { calls, fetch } = makeMcpFetch({ initStatusByKey: { 'good-key': 200 } });
  await withFetch(fetch, () => callMcpTool(
    { ...BASE, apiKey: 'good-key', retryApiKey: 'manager-key' },
    'add_comment',
    {},
  ));
  const initCalls = calls.filter((c) => c.rpcMethod === 'initialize');
  assert.deepEqual(initCalls.map((c) => c.apiKey), ['good-key']);
});

test('fireAndForgetTool swallows the failure instead of throwing when both keys fail', async () => {
  const { calls, fetch } = makeMcpFetch({ initStatusByKey: { 'session-key': 403, 'manager-key': 403 } });
  await withFetch(fetch, () => fireAndForgetTool(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
    'add_comment',
    { ticket_id: 't1', content: 'still broken' },
  ));
  const initCalls = calls.filter((c) => c.rpcMethod === 'initialize');
  assert.deepEqual(
    initCalls.map((c) => c.apiKey),
    ['session-key', 'manager-key'],
    'exactly one retry attempt — no infinite loop',
  );
});
