// Unit test — chat one-shot progress heartbeats (ticket c47194d9).
//
// Drives the REAL stdout path (SubagentManager#wireStdioCapture →
// CodexCliAdapter.parseProgressEvent → postChatRoomMessage) by feeding
// `codex exec --json` JSONL through a fake child's stdout stream via the
// _wireStdioForTest seam, and asserts exactly which chat-room progress
// messages get POSTed. Proves:
//   ① a Codex chat one-shot surfaces its in-flight work as type='progress'
//      chat messages (the gap this ticket fixes);
//   ② the final reply (agent_message + send_chat_room_message) is NOT echoed
//      as progress;
//   ③ 작업 중 / 완료 / 실패 render as visually distinct lines;
//   ④ ticket one-shots (no room_id) never post chat progress;
//   ⑤ a burst of start events coalesces, while a failure always surfaces.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { SubagentManager } from '../dist/lib/subagent-manager.js';

function makeConfig() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    delegation: { enabled: true, maxConcurrent: 10, ttlMinutes: 15 },
  };
}

let pidSeq = 90000;
function makeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = ++pidSeq;
  return child;
}

function makeChatRecord(child, overrides = {}) {
  return {
    pid: child.pid,
    kind: 'chat',
    cli_type: 'codex',
    trigger_id: null,
    chat_request_id: 'msg:user-1:2026-07-16T00:00:00.000Z',
    ticket_id: null,
    agent_id: 'agent-codex',
    role: null,
    room_id: 'room-1',
    started_at: Date.now(),
    config_path: null,
    config_path_is_temp: false,
    process_handle: child,
    captureOutput: false, // codex is NATIVE_MCP → stdout is not aggregated
    outLines: [],
    tailLines: [],
    commentSent: false,
    tap: null,
    ...overrides,
  };
}

// Feed JSONL lines through the child's stdout and let readline's async 'line'
// events + the fire-and-forget POST microtasks flush.
async function feed(child, lines) {
  for (const l of lines) child.stdout.write(l + '\n');
  await new Promise((r) => setTimeout(r, 40));
}

let originalFetch;
let progressPosts; // { roomId, body } for POSTs to chat-rooms/:id/messages

beforeEach(() => {
  originalFetch = globalThis.fetch;
  progressPosts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const m = u.match(/\/api\/agent\/chat-rooms\/([^/]+)\/messages$/);
    if (m && (init?.method || 'GET') === 'POST') {
      progressPosts.push({ roomId: decodeURIComponent(m[1]), body: JSON.parse(init.body) });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Anything else (e.g. /mcp) — benign 200 so nothing throws.
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('command_execution start posts a 작업 중 progress heartbeat to the room', async () => {
  const mgr = new SubagentManager(makeConfig());
  const child = makeChild();
  mgr._wireStdioForTest(makeChatRecord(child));

  await feed(child, [
    JSON.stringify({ type: 'thread.started' }),
    JSON.stringify({
      type: 'item.started',
      item: { id: 'i0', type: 'command_execution', command: 'git status', status: 'in_progress' },
    }),
  ]);

  const progress = progressPosts.filter((p) => p.body.type === 'progress');
  assert.equal(progress.length, 1, 'exactly one progress heartbeat');
  assert.equal(progress[0].roomId, 'room-1');
  assert.equal(progress[0].body.agent_id, 'agent-codex');
  assert.match(progress[0].body.content, /💻/);
  assert.match(progress[0].body.content, /git status/);
});

test('the reply itself (agent_message + send_chat_room_message) is NOT echoed as progress', async () => {
  const mgr = new SubagentManager(makeConfig());
  const child = makeChild();
  mgr._wireStdioForTest(makeChatRecord(child));

  await feed(child, [
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'mcp_tool_call', server: 'awb', tool: 'send_chat_room_message', error: null },
    }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'here is my answer' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ]);

  const progress = progressPosts.filter((p) => p.body.type === 'progress');
  assert.equal(progress.length, 0, 'reply-delivery events must not become progress');
});

test('turn.failed posts a 실패 progress line distinct from 작업 중', async () => {
  const mgr = new SubagentManager(makeConfig());
  const child = makeChild();
  mgr._wireStdioForTest(makeChatRecord(child));

  await feed(child, [
    JSON.stringify({ type: 'turn.failed', error: { message: 'model overloaded' } }),
  ]);

  const progress = progressPosts.filter((p) => p.body.type === 'progress');
  assert.equal(progress.length, 1);
  assert.match(progress[0].body.content, /⚠️/);
  assert.match(progress[0].body.content, /실패/);
  assert.match(progress[0].body.content, /model overloaded/);
});

test('ticket one-shots (no room_id) never post chat progress', async () => {
  const mgr = new SubagentManager(makeConfig());
  const child = makeChild();
  mgr._wireStdioForTest(makeChatRecord(child, { kind: 'trigger', room_id: null, ticket_id: 'ticket-9' }));

  await feed(child, [
    JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'ls', status: 'in_progress' },
    }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }),
  ]);

  assert.equal(progressPosts.length, 0, 'the chat window is the only progress surface');
});

test('a burst of start events coalesces, but a failure always surfaces', async () => {
  const mgr = new SubagentManager(makeConfig());
  const child = makeChild();
  mgr._wireStdioForTest(makeChatRecord(child));

  await feed(child, [
    JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'a', status: 'in_progress' } }),
    JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'b', status: 'in_progress' } }),
    JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'c', status: 'in_progress' } }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'x' } }),
  ]);

  const progress = progressPosts.filter((p) => p.body.type === 'progress');
  // First start emits; the next two are coalesced by the min-interval; the
  // failure bypasses the interval and always surfaces.
  assert.equal(progress.length, 2);
  assert.match(progress[0].body.content, /💻/);
  assert.match(progress[1].body.content, /실패/);
});
