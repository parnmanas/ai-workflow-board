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

// Write one JSONL line and let readline's async 'line' event + the POST
// microtask flush. Used by the fake-clock tests below, which advance time
// per-event so nothing is coalesced by the min-interval.
async function feedOne(child, obj) {
  child.stdout.write(JSON.stringify(obj) + '\n');
  await new Promise((r) => setTimeout(r, 8));
}

test('a failure surfaces even after the per-session cap is exhausted (spaced, non-coalesced events)', async () => {
  const mgr = new SubagentManager(makeConfig());
  const child = makeChild();
  mgr._wireStdioForTest(makeChatRecord(child));

  // Fake clock so 30 heartbeats can be spaced past the 1500ms min-interval
  // without a ~45s real-time wait — each is a genuine, non-coalesced emit.
  const realDateNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    // Exhaust the hard cap (CHAT_PROGRESS_MAX_PER_SESSION = 30) with 30 distinct
    // start heartbeats, each advancing the clock past the min-interval.
    for (let i = 0; i < 30; i++) {
      clock += 2000;
      await feedOne(child, {
        type: 'item.started',
        item: { type: 'command_execution', command: `cmd-${i}`, status: 'in_progress' },
      });
    }
    // The cap is now exhausted → a further *start* must be dropped …
    clock += 2000;
    await feedOne(child, {
      type: 'item.started',
      item: { type: 'command_execution', command: 'over-cap', status: 'in_progress' },
    });
    // … but the terminal 실패 must STILL surface (완료 기준: 실패가 명확히 구분).
    clock += 2000;
    child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'post-cap boom' } }) + '\n');
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    Date.now = realDateNow;
  }

  const progress = progressPosts.filter((p) => p.body.type === 'progress');
  const starts = progress.filter((p) => /💻/.test(p.body.content));
  const failures = progress.filter((p) => /실패/.test(p.body.content));

  assert.equal(starts.length, 30, 'exactly the cap worth of start heartbeats — the 31st start is dropped');
  assert.equal(failures.length, 1, 'the failure bypasses the exhausted cap and still surfaces');
  assert.match(failures[0].body.content, /post-cap boom/);
});

test('repeated failures after the cap flood do not — only one terminal 실패 slot per pid', async () => {
  const mgr = new SubagentManager(makeConfig());
  const child = makeChild();
  mgr._wireStdioForTest(makeChatRecord(child));

  const realDateNow = Date.now;
  let clock = 2_000_000;
  Date.now = () => clock;
  try {
    for (let i = 0; i < 30; i++) {
      clock += 2000;
      await feedOne(child, {
        type: 'item.started',
        item: { type: 'command_execution', command: `cmd-${i}`, status: 'in_progress' },
      });
    }
    // Three terminal failures after the cap — only the first may surface, the
    // reserved error slot dedupes the rest so a repeated-error stream can't
    // flood the room.
    for (const msg of ['boom-1', 'boom-2', 'boom-3']) {
      clock += 2000;
      await feedOne(child, { type: 'turn.failed', error: { message: msg } });
    }
  } finally {
    Date.now = realDateNow;
  }

  const progress = progressPosts.filter((p) => p.body.type === 'progress');
  const failures = progress.filter((p) => /실패/.test(p.body.content));
  assert.equal(failures.length, 1, 'the terminal error slot dedupes repeated failures');
  assert.match(failures[0].body.content, /boom-1/);
});
