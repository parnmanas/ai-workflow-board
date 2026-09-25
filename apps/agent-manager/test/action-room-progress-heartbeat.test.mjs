// Unit test — progress heartbeats in an ACTION room never stop (mission card
// activity, 2026-09-25).
//
// The AWB mission view renders the newest `type='progress'` line of a step's
// room as that step card's "what it is actually doing" indicator. The original
// rule dropped every heartbeat past 30 per spawn, so a 90-minute step froze on
// its first 30 tool calls and became indistinguishable on screen from one that
// died in its first seconds — which is exactly what the card is for.
//
// Past the cap, action rooms now stretch the interval (30s) instead of cutting
// the stream. Ordinary chat rooms keep the hard cap: a person reads those and a
// runaway agent must not flood them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SubagentManager, shouldEmitProgressHeartbeat } from '../dist/lib/subagent-manager.js';

const FAST_MS = 1_500; // CHAT_PROGRESS_MIN_INTERVAL_MS
const SLOW_MS = 30_000; // CHAT_PROGRESS_SLOW_INTERVAL_MS
const CAP = 30; // CHAT_PROGRESS_MAX_PER_SESSION

const gate = (over) => ({ count: 0, lastEmitMs: 0, now: 0, isActionRoom: false, ...over });

test('under the cap both room kinds use the fast interval and coalesce bursts', () => {
  for (const isActionRoom of [false, true]) {
    assert.equal(shouldEmitProgressHeartbeat(gate({ isActionRoom, count: 5, lastEmitMs: 0, now: FAST_MS })), true);
    assert.equal(
      shouldEmitProgressHeartbeat(gate({ isActionRoom, count: 5, lastEmitMs: 0, now: FAST_MS - 1 })),
      false,
      'a burst within the interval is coalesced',
    );
  }
});

test('past the cap an ordinary chat room goes silent (flood protection kept)', () => {
  assert.equal(shouldEmitProgressHeartbeat(gate({ count: CAP, lastEmitMs: 0, now: SLOW_MS * 100 })), false);
});

test('past the cap an action room keeps signalling, throttled to the slow interval', () => {
  const at = (now) => shouldEmitProgressHeartbeat(gate({ isActionRoom: true, count: CAP, lastEmitMs: 0, now }));
  assert.equal(at(SLOW_MS - 1), false, 'not yet — the slow interval must hold');
  assert.equal(at(SLOW_MS), true, 'one line per 30s keeps the card alive');
  assert.equal(at(60 * 60_000), true, 'still signalling an hour in — the stream is never cut');
  // 상한을 훌쩍 넘긴 뒤에도 규칙이 바뀌지 않는다: 90분짜리 step 이 얼어붙지 않는 근거.
  assert.equal(
    shouldEmitProgressHeartbeat(gate({ isActionRoom: true, count: 5_000, lastEmitMs: 0, now: SLOW_MS })),
    true,
  );
});

test('the stdout pipeline actually posts an action-room heartbeat as type=progress', async () => {
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/agent/chat-rooms/') && u.endsWith('/messages')) {
      posts.push(JSON.parse(init?.body || '{}'));
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const mgr = new SubagentManager({
      url: 'http://127.0.0.1:0',
      apiKey: 'test-key',
      delegation: { enabled: true, maxConcurrent: 10, ttlMinutes: 15 },
    });
    const record = {
      pid: 91001,
      kind: 'chat',
      cli_type: 'opencode',
      trigger_id: null,
      chat_request_id: 'msg-1',
      ticket_id: null,
      agent_id: 'agent-coder-muse',
      role: null,
      room_id: 'room-step',
      isActionRoom: true,
      started_at: Date.now(),
      config_path: null,
      config_path_is_temp: false,
      process_handle: null,
      captureOutput: false,
      outLines: [],
      tailLines: [],
      commentSent: false,
      tap: null,
    };
    // opencode `run --format json` tool_use — a completed bash call.
    mgr._maybeEmitChatProgress(
      record,
      JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'bash',
          state: { status: 'completed', title: 'git status --short', input: { command: 'git status --short' } },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(posts.length, 1, 'one heartbeat posted');
    assert.equal(posts[0].type, 'progress');
    assert.equal(posts[0].agent_id, 'agent-coder-muse');
    // 카드가 읽는 계약: 줄 전체가 `_..._` 이탤릭이고 안쪽 마크다운은 이스케이프된다.
    assert.match(posts[0].content, /^_.*_$/, 'the italic wrapper the server/card contract expects');
    assert.match(posts[0].content, /git status/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
