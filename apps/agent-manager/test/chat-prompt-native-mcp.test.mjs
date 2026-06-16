// Unit test — chat prompt reply-channel instruction tracks adapter capability
// (ticket e668917b).
//
// Regression: chat subagents on a non-NATIVE_MCP CLI (codex / antigravity) are
// driven through the manager's stdout-capture path — the manager harvests their
// reply and posts it via REST. The prompt composers used to UNCONDITIONALLY
// tell every subagent to "Reply ONLY via the mcp__awb__send_chat_room_message
// MCP tool" and "Do NOT print your reply to stdout", which is doubly wrong for
// codex: it has no such tool, and suppressing stdout starves the exact channel
// the manager reads. The reply instruction must now flip on `usesNativeMcp`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeChatRoomPrompt, composeChatPrompt } from '../dist/lib/prompts.js';

const ROOM = '7577ec49-b479-4235-af71-0b2789951e06';
const MSG = { content: 'hello there', sender_name: 'GameClient', sender_id: 'u1' };

test('composeChatRoomPrompt native-MCP (claude) → MCP tool instruction with explicit room_id', () => {
  const p = composeChatRoomPrompt(ROOM, [], MSG, undefined, true);
  assert.ok(p.includes(`Room ID: ${ROOM}`), 'explicit Room ID line present');
  assert.ok(
    p.includes(`mcp__awb__send_chat_room_message MCP tool (room_id: "${ROOM}")`),
    'instructs MCP tool with the room id inline',
  );
  assert.ok(p.includes('Do NOT print your reply to stdout'), 'tells claude not to use stdout');
});

test('composeChatRoomPrompt non-native-MCP (codex) → stdout instruction, no MCP tool', () => {
  const p = composeChatRoomPrompt(ROOM, [], MSG, undefined, false);
  // Room id context is still surfaced for the model.
  assert.ok(p.includes(`Room ID: ${ROOM}`), 'Room ID line still present for context');
  // The reply CHANNEL must be plain stdout, not the MCP tool.
  assert.ok(
    p.includes('Reply with plain text as your final message'),
    'tells codex to emit a plain-text final answer',
  );
  assert.ok(
    !p.includes('Reply ONLY via the mcp__awb__send_chat_room_message MCP tool'),
    'must NOT instruct the (unavailable) MCP tool',
  );
  assert.ok(
    !p.includes('Do NOT print your reply to stdout'),
    'must NOT suppress stdout — that is the channel the manager harvests',
  );
});

test('composeChatRoomPrompt defaults to native-MCP behavior (back-compat)', () => {
  const p = composeChatRoomPrompt(ROOM, [], MSG);
  assert.ok(
    p.includes('mcp__awb__send_chat_room_message MCP tool'),
    'omitting the flag preserves prior claude behavior',
  );
});

test('composeChatPrompt (legacy) native-MCP → explicit Room ID line + MCP tool', () => {
  const p = composeChatPrompt('', [], 'hi', ROOM, true);
  assert.ok(p.includes(`Room ID: ${ROOM}`), 'legacy path now carries an explicit Room ID line');
  assert.ok(
    p.includes(`mcp__awb__send_chat_room_message MCP tool (room_id: "${ROOM}")`),
    'legacy native path names the tool with the room id (no vague "from the chat request context")',
  );
  assert.ok(
    !p.includes('pass the room_id from the chat request context'),
    'the legacy vague wording is gone',
  );
});

test('composeChatPrompt (legacy) non-native-MCP → stdout instruction, no MCP tool', () => {
  const p = composeChatPrompt('', [], 'hi', ROOM, false);
  assert.ok(p.includes('Reply with plain text as your final message'));
  assert.ok(!p.includes('Reply ONLY via the mcp__awb__send_chat_room_message MCP tool'));
  assert.ok(!p.includes('Do NOT print your reply to stdout'));
});

test('composeChatPrompt defaults preserve native-MCP behavior', () => {
  const p = composeChatPrompt('', [], 'hi');
  assert.ok(p.includes('mcp__awb__send_chat_room_message MCP tool'));
});
