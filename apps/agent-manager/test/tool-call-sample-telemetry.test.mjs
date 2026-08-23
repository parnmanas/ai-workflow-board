// 단위 테스트 — TicketSessionManager의 graph_ vs 네이티브(Grep/Read/Bash)
// 호출 표본 누적/flush (ticket d35b7b7d, Ontology Graph 6/7, 완료조건 4 —
// reporter 결정으로 이 브랜치에 흡수됨).
//
// moving-cue-resume.test.mjs와 같은 하네스: 실제 CLI 자식을 스폰하지 않고
// `_onStdoutParsed`를 합성 Claude stream-json ParseResult로 직접 구동한다.
// 네트워크 전송(postToolCallTelemetry)은 전역 fetch를 스텁해 가로챈다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TicketSessionManager } from '../dist/lib/ticket-session-manager.js';

function makeConfig() {
  return {
    url: 'http://awb.test:7701',
    apiKey: 'manager-key',
    silentExitVerifyDelayMs: 0,
    delegation: { enabled: true, maxConcurrent: 10, idleMinutes: 999, maxTurnsPerSession: 999 },
  };
}

function makeFakeSession(pid, overrides = {}) {
  const child = { pid, stdin: { write: () => true, end: () => {} }, once: () => {} };
  return {
    sessionKey: `ticket-x:assignee`,
    pid,
    agentId: 'agent-42',
    ticketId: 'd35b7b7d-84e1-49db-9c31-073410a38e0d',
    role: 'assignee',
    _effectiveApiKey: 'session-key',
    cli_type: 'claude',
    adapter: { cliType: 'claude', formatTurn: (s) => String(s), parseStdoutLine: () => ({ stage: null, isResult: false, raw: null }) },
    child,
    configPath: null,
    configPathIsTemp: false,
    pidPath: null,
    turnCount: 1,
    startedAt: Date.now(),
    lastTouchedAt: Date.now(),
    idleTimer: null,
    unrespondedTurnCount: 0,
    unrespondedSince: null,
    unhealthyKilled: false,
    tap: null,
    ...overrides,
  };
}

function toolUseLine(blocks) {
  return {
    stage: 'composing',
    isResult: false,
    isError: false,
    raw: { type: 'assistant', message: { content: blocks.map((b) => ({ type: 'tool_use', name: b.name, input: b.input ?? {} })) } },
  };
}

function resultLine() {
  return { stage: null, isResult: true, isError: false, raw: { type: 'result' } };
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

// _onStdoutParsed/_onChildExit도 같은 턴에서 output-liveness 하트비트(모든
// stage/isResult 이벤트)나 silent-exit fallback 코멘트(감사 트레일 없는
// _onChildExit) 같은 무관한 POST를 함께 fire-and-forget할 수 있다 — 이
// 스텁은 그런 호출도 전부 200으로 흡수하되(부수효과 자체가 실패로 로그를
// 어지럽히지 않게), 텔레메트리 엔드포인트로 온 것만 `calls`에 기록해
// 어써션이 무관한 호출과 섞이지 않게 한다.
function makeFetchCapture() {
  const calls = [];
  const fetch = async (url, init) => {
    if (url.includes('/api/agent-manager/tool-call-telemetry')) {
      calls.push({ url, body: JSON.parse(init.body) });
    }
    return new Response('{"ok":true}', { status: 200 });
  };
  return { calls, fetch };
}

function makeMgr() {
  return new TicketSessionManager(makeConfig());
}

test('graph_ + native 호출이 섞인 턴 종료 시 집계된 카운트 하나로 flush한다', async () => {
  const mgr = makeMgr();
  const sess = makeFakeSession(3001);
  const { calls, fetch } = makeFetchCapture();

  await withFetch(fetch, async () => {
    mgr._onStdoutParsed(sess, toolUseLine([
      { name: 'mcp__awb__graph_status', input: { workspace_id: 'w', resource_id: 'r' } },
      { name: 'Read', input: { file_path: '/x.ts' } },
      { name: 'Grep', input: { pattern: 'foo' } },
    ]), '');
    mgr._onStdoutParsed(sess, toolUseLine([
      { name: 'mcp__awb__graph_find_symbol', input: {} },
      { name: 'Bash', input: { command: 'ls' } },
    ]), '');
    mgr._onStdoutParsed(sess, resultLine(), '');
  });

  assert.equal(calls.length, 1, '턴 종료 시 정확히 한 번 flush');
  assert.equal(calls[0].url, 'http://awb.test:7701/api/agent-manager/tool-call-telemetry');
  assert.deepEqual(
    { graph: calls[0].body.graph_calls, native: calls[0].body.native_calls },
    { graph: 2, native: 3 },
    'graph_status+graph_find_symbol=2, Read+Grep+Bash=3',
  );
  assert.equal(calls[0].body.agent_id, 'agent-42');
  assert.equal(calls[0].body.ticket_id, sess.ticketId);
});

test('graph_/native 호출이 없는 턴(예: add_comment만)은 flush 자체를 생략한다', async () => {
  const mgr = makeMgr();
  const sess = makeFakeSession(3002);
  const { calls, fetch } = makeFetchCapture();

  await withFetch(fetch, async () => {
    mgr._onStdoutParsed(sess, toolUseLine([{ name: 'mcp__awb__add_comment', input: { content: 'note' } }]), '');
    mgr._onStdoutParsed(sess, resultLine(), '');
  });

  assert.equal(calls.length, 0, '표본이 비어있으면 불필요한 네트워크 호출 자체를 만들지 않는다');
});

test('턴 경계마다 리셋된다 — 이전 턴의 카운트가 다음 턴으로 새지 않는다', async () => {
  const mgr = makeMgr();
  const sess = makeFakeSession(3003);
  const { calls, fetch } = makeFetchCapture();

  await withFetch(fetch, async () => {
    mgr._onStdoutParsed(sess, toolUseLine([{ name: 'Read', input: {} }]), '');
    mgr._onStdoutParsed(sess, resultLine(), '');
    mgr._onStdoutParsed(sess, toolUseLine([{ name: 'mcp__awb__graph_status', input: {} }]), '');
    mgr._onStdoutParsed(sess, resultLine(), '');
  });

  assert.equal(calls.length, 2, '턴마다 각각 flush');
  assert.deepEqual({ graph: calls[0].body.graph_calls, native: calls[0].body.native_calls }, { graph: 0, native: 1 });
  assert.deepEqual({ graph: calls[1].body.graph_calls, native: calls[1].body.native_calls }, { graph: 1, native: 0 }, '1턴차 native 카운트가 2턴차로 새지 않아야 함');
});

test('graph_/native가 아닌 MCP 툴(get_ticket 등)은 어느 쪽으로도 집계되지 않는다', async () => {
  const mgr = makeMgr();
  const sess = makeFakeSession(3004);
  const { calls, fetch } = makeFetchCapture();

  await withFetch(fetch, async () => {
    mgr._onStdoutParsed(sess, toolUseLine([
      { name: 'mcp__awb__get_ticket', input: {} },
      { name: 'mcp__awb__move_ticket', input: {} },
      { name: 'Write', input: {} }, // 표본 대상 아님(Grep/Read/Bash만)
      { name: 'mcp__awb__graph_neighbors', input: {} },
    ]), '');
    mgr._onStdoutParsed(sess, resultLine(), '');
  });

  assert.equal(calls.length, 1);
  assert.deepEqual({ graph: calls[0].body.graph_calls, native: calls[0].body.native_calls }, { graph: 1, native: 0 });
});

test('agentId 또는 ticketId가 없으면 flush하지 않는다', async () => {
  const mgr = makeMgr();
  const sess = makeFakeSession(3005, { agentId: '' });
  const { calls, fetch } = makeFetchCapture();

  await withFetch(fetch, async () => {
    mgr._onStdoutParsed(sess, toolUseLine([{ name: 'Grep', input: {} }]), '');
    mgr._onStdoutParsed(sess, resultLine(), '');
  });

  assert.equal(calls.length, 0, 'agentId 없이는 (agent_id, ticket_id) 표본 귀속이 불가능하므로 전송하지 않는다');
});

test('_onChildExit이 누적 중이던 표본을 정리한다(다음 세션으로 새지 않음)', async () => {
  const mgr = makeMgr();
  const sess = makeFakeSession(3006);
  const { calls, fetch } = makeFetchCapture();

  await withFetch(fetch, async () => {
    // 턴 도중(isResult 전) exit — 아직 flush되지 않은 카운트가 쌓여 있다.
    mgr._onStdoutParsed(sess, toolUseLine([{ name: 'Bash', input: {} }, { name: 'Bash', input: {} }]), '');
    await mgr._onChildExit(sess, 0, null);

    // 같은 pid로 새 턴이 온다면(이론상), 정리되지 않았다면 이전 카운트가 새 것과 합산됐을 것.
    mgr._onStdoutParsed(sess, toolUseLine([{ name: 'Read', input: {} }]), '');
    mgr._onStdoutParsed(sess, resultLine(), '');
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.native_calls, 1, 'exit 이전의 Bash 2회가 새 턴으로 누수되지 않아야 한다(정확히 Read 1회만)');
});
