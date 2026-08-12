import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { RuntimeSupervisor } from '../dist/lib/runtime/runtime-supervisor.js';
import { spawnFailureTracker } from '../dist/lib/spawn-failure-tracker.js';

// ticket e8105c84: hermes-mention-dispatch-failure.test.mjs (d946862a) only covers
// #dispatchHermes() throwing (runtime_supervisor_unavailable). It does not cover the
// success path — dispatch() resolving without throwing — where an ACP session/prompt
// can still end on a stopReason other than 'end_turn' (e.g. 'refusal', a tool-call
// permission silently denied). Before this ticket, handleCommentMention only logged
// that stopReason and never told spawnFailureTracker or the ticket, so a mention that
// got no reply looked identical to a successful one. This mirrors
// hermes-chat-dispatch-success.test.mjs's stopReason-driven cases, but for the
// comment-mention path's ticket-comment failure channel instead of the chat-room POST
// channel (handleCommentMention doesn't accumulate replyText — Hermes answers via the
// add_comment MCP tool directly, which this test does not need to observe beyond
// counting failure-notice comments).

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));
const AGENT = 'agent-hermes-mention-outcome';
const TICKET = 'ticket-hermes-mention-outcome';

let originalFetch;
let mcpToolCalls;
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

function context(permissionMode) {
  return {
    agent_id: AGENT,
    name: 'Hermes mention outcome agent',
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
  const rootDir = await mkdtemp(join(tmpdir(), 'awb-hermes-mention-outcome-'));
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

test('Hermes comment-mention dispatch that ends cleanly (stop=end_turn) posts no failure comment and clears the degraded signal', async (t) => {
  const { dispatcher } = await harness(t, 'trusted');
  // Simulate a still-open degraded badge from an earlier failure — success must clear it.
  spawnFailureTracker.record({ cli: 'hermes', code: 'acp_timeout', message: 'prior failure' });

  await dispatcher.handleCommentMention(commentMentionEvent());

  assert.equal(countTool('add_comment'), 0, 'a clean end_turn mention dispatch must not post a failure comment');

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, null);
  assert.equal(snap.last_spawn_error, null);
});

test('Hermes comment-mention dispatch that resolves without a confirmed reply (stop=refusal) posts a visible ticket comment and records degraded', async (t) => {
  const { dispatcher } = await harness(t, 'strict');

  await dispatcher.handleCommentMention(commentMentionEvent());

  assert.equal(countTool('add_comment'), 1, 'a non-end_turn mention dispatch must post exactly one failure comment');
  assert.match(addCommentContents[0], /Hermes 런타임 실행 실패/);
  assert.match(addCommentContents[0], /refusal/);

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, 'hermes');
  assert.match(snap.last_spawn_error || '', /refusal/);
});
