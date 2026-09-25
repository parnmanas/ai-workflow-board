// Unit test — NATIVE_MCP room one-shot failure notice (EmberDelve incident,
// 2026-09-25).
//
// An opencode team member on a Windows Runtime Host died with exit 1 in 0s
// (cmd.exe's 8191-char argv limit — the work order rode in argv). Because
// opencode is NATIVE_MCP, `captureOutput` is false and the exit handler's
// answer/fallback block never ran, so the orchestration room and the mission
// step stayed silent for ~100 minutes until the lease reaper noticed. These
// tests pin the room twin of the ticket silent-exit comment:
//   ① non-zero exit + no reply tool observed → one ⚠️ notice posted to the room
//      under the agent identity, carrying the CLI tail;
//   ② a completed send_chat_room_message / report_orchestration_step tool_use
//      (opencode JSONL shape) marks chatReplySent → post-hoc crash, no notice;
//   ③ exit 0 → no notice (a clean turn delivers over MCP; nothing to add);
//   ④ ticket one-shots are untouched — no room post, their own silent-exit
//      path handles them.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SubagentManager } from '../dist/lib/subagent-manager.js';

function makeConfig() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    silentExitVerifyDelayMs: 0,
    delegation: { enabled: true, maxConcurrent: 10, ttlMinutes: 15 },
  };
}

let pidSeq = 81000;
function makeRoomRecord(overrides = {}) {
  return {
    pid: ++pidSeq,
    kind: 'chat',
    cli_type: 'opencode',
    trigger_id: null,
    chat_request_id: 'msg-1',
    ticket_id: null,
    agent_id: 'agent-coder-muse',
    role: null,
    room_id: 'room-orch-step',
    started_at: Date.now(),
    config_path: null,
    config_path_is_temp: false,
    process_handle: null,
    captureOutput: false, // opencode is NATIVE_MCP → stdout is NOT aggregated
    outLines: [],
    tailLines: [],
    commentSent: false,
    tap: null,
    ...overrides,
  };
}

function opencodeToolUseLine(tool) {
  return JSON.stringify({
    type: 'tool_use',
    part: { tool, state: { status: 'completed', input: {}, output: '{}' } },
  });
}

let originalFetch;
let chatPosts;
let otherPosts;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  chatPosts = [];
  otherPosts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || 'GET';
    if (u.includes('/api/agent/chat-rooms/') && u.endsWith('/messages') && method === 'POST') {
      chatPosts.push({ url: u, body: JSON.parse(init?.body || '{}') });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('/mcp')) {
      if (method === 'DELETE') return new Response('{}', { status: 200 });
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'sid-test', 'content-type': 'application/json' },
        });
      }
      if (body.method === 'tools/call') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 });
    }
    otherPosts.push({ url: u, method });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('① NATIVE_MCP room one-shot exit 1 with no reply tool → one ⚠️ notice with the CLI tail', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeRoomRecord({
    tailLines: ['The command line is too long.'],
  });

  await mgr._handleOneshotExit(rec, 1);

  assert.equal(chatPosts.length, 1, 'exactly one room post');
  assert.equal(chatPosts[0].url, 'http://127.0.0.1:0/api/agent/chat-rooms/room-orch-step/messages');
  assert.equal(chatPosts[0].body.agent_id, 'agent-coder-muse');
  assert.match(chatPosts[0].body.content, /⚠️ Agent가 응답하지 못했습니다/);
  assert.match(chatPosts[0].body.content, /cli=opencode/);
  assert.match(chatPosts[0].body.content, /exit code 1/);
  assert.match(chatPosts[0].body.content, /The command line is too long\./);
});

test('① instant death with an empty tail still posts, and says the output was empty', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeRoomRecord();

  await mgr._handleOneshotExit(rec, 1);

  assert.equal(chatPosts.length, 1);
  assert.match(chatPosts[0].body.content, /exit code 1/);
  assert.match(chatPosts[0].body.content, /CLI 출력이 없습니다/);
});

test('① a signal death (code null) is reported as exit code unknown', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeRoomRecord();

  await mgr._handleOneshotExit(rec, null);

  assert.equal(chatPosts.length, 1);
  assert.match(chatPosts[0].body.content, /exit code unknown/);
});

test('② send_chat_room_message tool_use before a non-zero exit → post-hoc crash, no notice', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeRoomRecord();
  mgr._scanForCommentTool(rec, opencodeToolUseLine('awb_send_chat_room_message'));
  assert.equal(rec.chatReplySent, true);
  assert.equal(rec.commentSent, false, 'a room reply is not a ticket comment');

  await mgr._handleOneshotExit(rec, 1);

  assert.equal(chatPosts.length, 0);
});

test('② report_orchestration_step tool_use (mcp__awb__ prefix) also counts as a delivered reply', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeRoomRecord();
  mgr._scanForCommentTool(rec, opencodeToolUseLine('mcp__awb__report_orchestration_step'));
  assert.equal(rec.chatReplySent, true);

  await mgr._handleOneshotExit(rec, 137);

  assert.equal(chatPosts.length, 0);
});

test('② a FAILED reply tool_use does not count as delivered', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeRoomRecord();
  mgr._scanForCommentTool(
    rec,
    JSON.stringify({
      type: 'tool_use',
      part: { tool: 'awb_send_chat_room_message', state: { status: 'error', error: 'boom' } },
    }),
  );
  assert.equal(rec.chatReplySent, undefined);

  await mgr._handleOneshotExit(rec, 1);

  assert.equal(chatPosts.length, 1);
});

test('② the scanner still marks ticket comment tools independently (claude assistant shape)', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeRoomRecord();
  mgr._scanForCommentTool(
    rec,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'mcp__awb__add_comment', input: {} }] },
    }),
  );
  assert.equal(rec.commentSent, true);
  assert.equal(rec.chatReplySent, undefined);
  mgr._scanForCommentTool(
    rec,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'mcp__awb__send_chat_room_message', input: {} }] },
    }),
  );
  assert.equal(rec.chatReplySent, true, 'the scan keeps running after commentSent until both flags are set');
});

test('③ exit 0 without an observed reply tool → no notice', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeRoomRecord();

  await mgr._handleOneshotExit(rec, 0);

  assert.equal(chatPosts.length, 0);
});

test('④ ticket one-shot (ticket_id set) exit 1 → no room post; the ticket silent-exit path owns it', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeRoomRecord({
    kind: 'trigger',
    trigger_id: 'trig-1',
    ticket_id: 'ticket-1',
    role: 'assignee',
    room_id: null,
  });

  await mgr._handleOneshotExit(rec, 1);

  assert.equal(chatPosts.length, 0);
});

test('④ non-NATIVE_MCP room one-shot (captureOutput=true) keeps its existing captured-output fallback — no double post', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeRoomRecord({ cli_type: 'codex', captureOutput: true, outLines: [] });

  await mgr._handleOneshotExit(rec, 1);

  assert.equal(chatPosts.length, 1, 'only the captured-output fallback posts');
  assert.match(chatPosts[0].body.content, /exit code 1/);
});
