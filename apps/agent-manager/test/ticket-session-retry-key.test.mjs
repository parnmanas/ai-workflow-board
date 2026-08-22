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
      if (!next) throw new Error(`예상 밖의 추가 fetch 호출 (#${calls.length})`);
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
// 시그니처는 (config, apiKey, body) — `apiKey`가 1차 시도 키다(호출부의
// `sess._effectiveApiKey || this._config.apiKey`를 그대로 미러링). `config.retryApiKey`가
// 폴백 키로, 실제 ticket-session-manager 호출부 배선과 동일하다.

test('postOutputLiveness: 세션 키의 403에 retryApiKey로 재시도한다', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }, { status: 200 }]);
  await withFetch(fetch, () => postOutputLiveness(
    { ...BASE, apiKey: 'manager-key', retryApiKey: 'manager-key' },
    'session-key',
    { agent_id: 'agent-1', ticket_id: 'ticket-1', role: 'assignee' },
  ));
  assert.deepEqual(calls.map((c) => c.apiKey), ['session-key', 'manager-key']);
});

test('postOutputLiveness: 세션 키의 401에 retryApiKey로 재시도한다', async () => {
  const { calls, fetch } = fetchSequence([{ status: 401, statusText: 'Unauthorized' }, { status: 200 }]);
  await withFetch(fetch, () => postOutputLiveness(
    { ...BASE, apiKey: 'manager-key', retryApiKey: 'manager-key' },
    'session-key',
    { agent_id: 'agent-1', ticket_id: 'ticket-1', role: 'assignee' },
  ));
  assert.deepEqual(calls.map((c) => c.apiKey), ['session-key', 'manager-key']);
});

test('postOutputLiveness: retryApiKey 미설정 시 403을 재시도하지 않는다', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }]);
  await withFetch(fetch, () => postOutputLiveness(
    { ...BASE, apiKey: 'only-key' },
    'only-key',
    { agent_id: 'agent-1', ticket_id: 'ticket-1', role: 'assignee' },
  ));
  assert.equal(calls.length, 1, 'retryApiKey 없음 — 단일 시도, 수정 전 동작과 동일');
});

test('postOutputLiveness: retryApiKey가 방금 실패한 키와 같으면 재시도하지 않는다', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }]);
  await withFetch(fetch, () => postOutputLiveness(
    { ...BASE, apiKey: 'same-key', retryApiKey: 'same-key' },
    'same-key',
    { agent_id: 'agent-1', ticket_id: 'ticket-1', role: 'assignee' },
  ));
  assert.equal(calls.length, 1, '동일한 키로 재시도해도 똑같이 실패할 것');
});

test('postOutputLiveness: 1차 키가 바로 성공하면 단일 호출만 한다', async () => {
  const { calls, fetch } = fetchSequence([{ status: 200 }]);
  await withFetch(fetch, () => postOutputLiveness(
    { ...BASE, apiKey: 'manager-key', retryApiKey: 'manager-key' },
    'session-key',
    { agent_id: 'agent-1', ticket_id: 'ticket-1', role: 'assignee' },
  ));
  assert.deepEqual(calls.map((c) => c.apiKey), ['session-key']);
});

// ── postSilentExitSystemComment(Raw) ────────────────────────────────────────

test('postSilentExitSystemCommentRaw: 세션 키의 401에 retryApiKey로 재시도한다', async () => {
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

test('postSilentExitSystemCommentRaw: retryApiKey 미설정 시 403을 재시도하지 않는다', async () => {
  const { calls, fetch } = fetchSequence([{ status: 403, statusText: 'Forbidden' }]);
  const outcome = await withFetch(fetch, () => postSilentExitSystemCommentRaw(
    { ...BASE, apiKey: 'only-key' },
    'ticket-1',
    { content: 'no fallback configured', exit_code: 1 },
  ));
  assert.equal(outcome.outcome, 'permanent');
  assert.equal(outcome.result, 'failed');
  assert.equal(calls.length, 1, 'retryApiKey 없음 — 단일 시도, 수정 전 동작과 동일');
});

test('postSilentExitSystemCommentRaw: 5xx는 자격증명 재시도 대상이 아니다(outbox-retryable 유지)', async () => {
  const { calls, fetch } = fetchSequence([{ status: 503, statusText: 'Unavailable' }]);
  const outcome = await withFetch(fetch, () => postSilentExitSystemCommentRaw(
    { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
    'ticket-1',
    { content: 'server hiccup', exit_code: 1 },
  ));
  assert.equal(outcome.outcome, 'retryable');
  assert.equal(calls.length, 1, '5xx는 인증 실패가 아님 — 자격증명 교체 없음, 재시도는 outbox가 나중에 처리');
});

test('postSilentExitSystemCommentRaw: retryApiKey 시도도 실패하면 최종 포기한다', async () => {
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
  assert.equal(calls.length, 2, '정확히 1회만 재시도 — 무한루프 없음');
});

test('postSilentExitSystemComment(grace-delay 래퍼): 재시도 성공 결과를 그대로 전달한다', async () => {
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
// callMcpTool은 호출마다 새 MCP 세션을 연다(initialize → notifications/
// initialized → tools/call → DELETE) — 전부 핸드셰이크 시작 시 고정된 단일
// Bearer 토큰으로 인증한다. stale per-agent 키는 `initialize`에서 401/403으로
// 드러나며, 재시도 시 세션 id가 그 키에 종속되므로 `config.retryApiKey`로
// 핸드셰이크 전체를 다시 연다.

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
        /* JSON-RPC 형식이 아님 (여기선 발생하지 않아야 함) */
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
    throw new Error(`예상 밖의 fetch: ${method} ${rpcMethod}`);
  };
  return { calls, fetch };
}

test('callMcpTool: initialize가 403을 받으면 retryApiKey로 핸드셰이크 전체를 재시도한다', async () => {
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
    '핸드셰이크의 나머지(notify/call/delete)는 재시도로 성공한 키를 사용한다',
  );
});

test('callMcpTool: retryApiKey 미설정 시 재시도하지 않고 401에서 throw한다', async () => {
  const { calls, fetch } = makeMcpFetch({ initStatusByKey: { 'only-key': 401 } });
  await assert.rejects(
    () => withFetch(fetch, () => callMcpTool({ ...BASE, apiKey: 'only-key' }, 'add_comment', {})),
    /initialize HTTP 401/,
  );
  assert.equal(calls.length, 1, 'retryApiKey 없음 — initialize 단일 시도, 수정 전 동작과 동일');
});

test('callMcpTool: retryApiKey가 방금 실패한 키와 같으면 재시도하지 않는다', async () => {
  const { calls, fetch } = makeMcpFetch({ initStatusByKey: { 'same-key': 403 } });
  await assert.rejects(
    () => withFetch(fetch, () => callMcpTool(
      { ...BASE, apiKey: 'same-key', retryApiKey: 'same-key' },
      'add_comment',
      {},
    )),
    /initialize HTTP 403/,
  );
  assert.equal(calls.length, 1, '동일한 키로 재시도해도 똑같이 실패할 것');
});

test('callMcpTool: initialize의 5xx는 자격증명 재시도 대상이 아니다(인증 실패 아님)', async () => {
  const { calls, fetch } = makeMcpFetch({ initStatusByKey: { 'session-key': 503 } });
  await assert.rejects(
    () => withFetch(fetch, () => callMcpTool(
      { ...BASE, apiKey: 'session-key', retryApiKey: 'manager-key' },
      'add_comment',
      {},
    )),
    /initialize HTTP 503/,
  );
  assert.equal(calls.length, 1, '5xx는 인증 실패가 아님 — 자격증명 교체 없음');
});

test('callMcpTool: 1차 키가 바로 성공하면 initialize를 한 번만 호출한다', async () => {
  const { calls, fetch } = makeMcpFetch({ initStatusByKey: { 'good-key': 200 } });
  await withFetch(fetch, () => callMcpTool(
    { ...BASE, apiKey: 'good-key', retryApiKey: 'manager-key' },
    'add_comment',
    {},
  ));
  const initCalls = calls.filter((c) => c.rpcMethod === 'initialize');
  assert.deepEqual(initCalls.map((c) => c.apiKey), ['good-key']);
});

test('fireAndForgetTool: 두 키 모두 실패해도 throw 대신 실패를 삼킨다', async () => {
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
    '정확히 1회만 재시도 — 무한루프 없음',
  );
});
