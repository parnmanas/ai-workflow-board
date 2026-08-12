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
// permission silently denied), or end on 'end_turn' without Hermes ever having called
// add_comment (the exact "silent success" this ticket exists to close). This mirrors
// hermes-chat-dispatch-success.test.mjs's stopReason-driven cases via the same real
// RuntimeSupervisor + fake-acp-server.mjs fixture, but for the comment-mention path's
// ticket-comment failure channel instead of the chat-room POST channel — and, since
// handleCommentMention doesn't accumulate replyText (Hermes answers via the add_comment
// MCP tool directly, not observed session deltas), the mocked ticket-fetch response
// below stands in for "did the agent's own add_comment call actually land" the same way
// permission_mode stands in for stopReason.
//
// Review round 1 caught that the first version of this file asserted 'end_turn' alone
// was success, without the fake ACP ever calling add_comment — codifying the exact bug
// this ticket fixes as a passing regression test. The fix (event-dispatcher.ts's
// #reportHermesMentionOutcome calling rest.ts's hasAgentCommentSince) re-checks the
// ticket's real comments after dispatch; these tests now drive that check explicitly via
// the mocked GET instead of asserting on stopReason alone.

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));
const AGENT = 'agent-hermes-mention-outcome';
const TICKET = 'ticket-hermes-mention-outcome';

let originalFetch;
let mcpToolCalls;
let addCommentContents;
let ticketGetCount;
/** 'never' — the mocked ticket GET never carries a reply from AGENT (simulates
 *  Hermes never calling add_comment). 'after_first_get' — only GETs after the
 *  first (i.e. the post-dispatch hasAgentCommentSince re-check; the first GET
 *  is handleCommentMention's own pre-dispatch prompt-composition fetch, which
 *  in any real sequence happens before Hermes could have replied) carry one —
 *  simulates a genuine add_comment call landing during the dispatch. */
let replyMode;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
  addCommentContents = [];
  ticketGetCount = 0;
  replyMode = 'never';
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
    if (target.includes('/api/agent/tickets/')) {
      ticketGetCount += 1;
      const includeReply = replyMode === 'after_first_get' && ticketGetCount > 1;
      return new Response(
        JSON.stringify({
          comments: includeReply
            ? [{ id: 'reply-1', author_id: AGENT, created_at: new Date().toISOString() }]
            : [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
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

test('case 1: stop=end_turn WITH a genuine reply comment from the agent → success, no failure comment, degraded signal clears', async (t) => {
  const { dispatcher } = await harness(t, 'trusted');
  replyMode = 'after_first_get';
  // Simulate a still-open degraded badge from an earlier failure — success must clear it.
  spawnFailureTracker.record({ cli: 'hermes', code: 'acp_timeout', message: 'prior failure' });

  await dispatcher.handleCommentMention(commentMentionEvent());

  assert.equal(countTool('add_comment'), 0, 'a genuinely-answered end_turn mention dispatch must not post a failure comment');
  assert.ok(ticketGetCount >= 2, 'expected both the pre-dispatch prompt fetch and the post-dispatch reply re-check');

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, null);
  assert.equal(snap.last_spawn_error, null);
});

test('case 2: stop=end_turn but the agent never actually replied → treated as failure, NOT success (the bug this ticket fixes)', async (t) => {
  const { dispatcher } = await harness(t, 'trusted');
  // replyMode stays 'never' — the fake ACP ends cleanly (end_turn) but, like a
  // real Hermes session whose add_comment call silently no-ops, never
  // produces a new ticket comment.

  await dispatcher.handleCommentMention(commentMentionEvent());

  assert.equal(countTool('add_comment'), 1, 'an unanswered end_turn mention dispatch must post exactly one failure comment');
  assert.match(addCommentContents[0], /Hermes 런타임 실행 실패/);
  assert.match(addCommentContents[0], /hermes_mention_no_reply/);

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, 'hermes');
  assert.match(snap.last_spawn_error || '', /hermes_mention_no_reply/);
});

test('case 3: stop=refusal (non-end_turn) → existing failure path, unaffected by the reply check', async (t) => {
  const { dispatcher } = await harness(t, 'strict');

  await dispatcher.handleCommentMention(commentMentionEvent());

  assert.equal(countTool('add_comment'), 1, 'a non-end_turn mention dispatch must post exactly one failure comment');
  assert.match(addCommentContents[0], /Hermes 런타임 실행 실패/);
  assert.match(addCommentContents[0], /refusal/);
  // The reply check must never run for a non-end_turn stop — only one ticket
  // GET (the pre-dispatch prompt-composition fetch) should have happened.
  assert.equal(ticketGetCount, 1);

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, 'hermes');
  assert.match(snap.last_spawn_error || '', /refusal/);
});
