import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { spawnFailureTracker } from '../dist/lib/spawn-failure-tracker.js';

// ticket d946862a: ticket a837879c 는 채팅(DM/그룹룸) 경로의 Hermes 디스패치
// 실패를 채팅방/spawnFailureTracker 에 노출하도록 고쳤지만, 같은 파일의 코멘트
// 멘션 경로(handleCommentMention)는 그대로 남아 #dispatchHermes() 실패가
// 로컬 log() 한 줄로만 끝났다 — 멘션한 사람도, 관리자 대시보드
// degraded 배지도 이 실패를 알 방법이 없었다. runtimeSupervisor 를 deps 에서
// 생략해 #dispatchHermes() 가 runtime_supervisor_unavailable 로 fail-closed
// 하도록 만든 뒤, (a) 티켓에 실패 코멘트가 실제로 달리는지, (b)
// spawnFailureTracker 가 degraded 로 갱신되는지를 검증한다.

const AGENT = 'agent-hermes-mention-guard';
const TICKET = 'ticket-hermes-mention';

let originalFetch;
let mcpToolCalls; // names of tools/call invoked over /mcp (add_comment, …)
let addCommentContents;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
  addCommentContents = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method || 'GET';
    if (target.endsWith('/mcp')) {
      if (method === 'DELETE') return new Response('{}', { status: 200 });
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'sid-test', 'content-type': 'application/json' },
        });
      }
      if (body.method === 'tools/call') {
        const name = body.params?.name;
        mcpToolCalls.push(name);
        if (name === 'add_comment') addCommentContents.push(body.params?.arguments?.content ?? '');
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 }); // notifications/initialized, etc.
    }
    // REST GETs (fetchTicketContext 등): ok with an empty body.
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function context() {
  return {
    agent_id: AGENT,
    name: 'Hermes mention guard agent',
    cli: 'hermes',
    working_dir: '/workspace',
    mcp_config_path: '/config/mcp.json',
    api_key: 'agent-api-key',
    cli_home_dir: '/cli-home',
    extra_env: {},
    credential_provider: null,
    model: null,
  };
}

function harness() {
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? context() : null),
    has: (id) => id === AGENT,
    list: () => [context()],
  };
  // runtimeSupervisor 를 의도적으로 생략 — #dispatchHermes() 가
  // 'runtime_supervisor_unavailable' 로 fail-closed 하는 경로를 재현한다
  // (hermes-chat-dispatch-failure.test.mjs 와 동일한 재현 방식).
  const dispatcher = new EventDispatcher(
    {
      url: 'http://127.0.0.1:0',
      apiKey: 'test-key',
      delegation: { enabled: true, persistentTicketSessions: false, persistentChatSessions: false },
    },
    { managedAgentContexts },
  );
  return { dispatcher };
}

function commentMentionEvent() {
  return JSON.stringify({
    event_type: 'comment_mention',
    ticket_id: TICKET,
    comment_id: 'comment-1',
    agent_id: AGENT,
    actor_name: 'some-user',
    actor_id: 'user-1',
    actor_type: 'user',
    content: '@Hermes please check this',
    mention_source: 'direct',
  });
}

const countTool = (name) => mcpToolCalls.filter((n) => n === name).length;

test('Hermes comment-mention dispatch failure posts a visible failure comment on the ticket', async () => {
  const { dispatcher } = harness();

  await dispatcher.handleCommentMention(commentMentionEvent());

  assert.equal(countTool('add_comment'), 1, 'the mention dispatch failure must post exactly one ticket comment');
  assert.match(addCommentContents[0], /Hermes 런타임 실행 실패/);
  assert.match(addCommentContents[0], /runtime_supervisor_unavailable/);
});

test('Hermes comment-mention dispatch failure records to spawnFailureTracker (admin dashboard degraded badge)', async () => {
  const { dispatcher } = harness();

  await dispatcher.handleCommentMention(commentMentionEvent());

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, 'hermes');
  assert.match(snap.last_spawn_error || '', /runtime_supervisor_unavailable/);
});
