// Unit test — chat prompt reply-channel instruction tracks adapter capability
// (ticket e668917b).
//
// Regression: chat subagents on a non-NATIVE_MCP CLI (antigravity) are
// driven through the manager's stdout-capture path — the manager harvests their
// reply and posts it via REST. The prompt composers used to UNCONDITIONALLY
// tell every subagent to "Reply ONLY via the mcp__awb__send_chat_room_message
// MCP tool" and "Do NOT print your reply to stdout", which is doubly wrong for
// codex: it has no such tool, and suppressing stdout starves the exact channel
// the manager reads. Codex now exercises the native path above; the reply
// instruction must continue to flip on `usesNativeMcp` for both cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeChatRoomPrompt, composeChatPrompt } from '../dist/lib/prompts.js';
import { CodexCliAdapter } from '../dist/lib/cli-adapters/codex.js';
import { ADAPTER_CAPABILITIES } from '../dist/lib/cli-adapters/base.js';

const ROOM = '7577ec49-b479-4235-af71-0b2789951e06';
const MSG = { content: 'hello there', sender_name: 'GameClient', sender_id: 'u1' };

test('Codex capability selects the native-MCP chat reply path', () => {
  const adapter = new CodexCliAdapter();
  const usesNativeMcp = adapter.has(ADAPTER_CAPABILITIES.NATIVE_MCP);
  const p = composeChatRoomPrompt(ROOM, [], MSG, undefined, usesNativeMcp);
  assert.ok(p.includes('mcp__awb__send_chat_room_message MCP tool'));
  assert.ok(p.includes('Do NOT print your reply to stdout'));
});

test('composeChatRoomPrompt native-MCP (claude) → MCP tool instruction with explicit room_id', () => {
  const p = composeChatRoomPrompt(ROOM, [], MSG, undefined, true);
  assert.ok(p.includes(`Room ID: ${ROOM}`), 'explicit Room ID line present');
  assert.ok(
    p.includes(`mcp__awb__send_chat_room_message MCP tool (room_id: "${ROOM}")`),
    'instructs MCP tool with the room id inline',
  );
  assert.ok(p.includes('Do NOT print your reply to stdout'), 'tells claude not to use stdout');
});

test('composeChatRoomPrompt non-native-MCP (antigravity) → stdout instruction, no MCP tool', () => {
  const p = composeChatRoomPrompt(ROOM, [], MSG, undefined, false);
  // Room id context is still surfaced for the model.
  assert.ok(p.includes(`Room ID: ${ROOM}`), 'Room ID line still present for context');
  // The reply CHANNEL must be plain stdout, not the MCP tool.
  assert.ok(
    p.includes('Reply with plain text as your final message'),
    'tells a non-native adapter to emit a plain-text final answer',
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

// ── Action Run branch (ticket e6d32e9d) ──────────────────────────────────────
// Action Runs reuse the chat-room pipeline but must tell the subagent to DO the
// work directly, not file a ticket. The `isActionRoom` flag (8th positional arg)
// swaps the work-policy instruction and suppresses the auto-title prompt.
const ACTION_MSG = { content: 'Bump all deps then run the build', sender_name: 'Scheduler', sender_id: 'system' };

test('composeChatRoomPrompt Action room (native) → do-the-work-directly, no create_ticket', () => {
  const p = composeChatRoomPrompt(ROOM, [], ACTION_MSG, undefined, true, undefined, '', true);
  assert.ok(p.includes('This is an ACTION run'), 'work-policy line frames it as an Action run');
  assert.ok(p.includes('carry it out DIRECTLY'), 'tells the agent to perform the task directly');
  assert.ok(
    !p.includes('create an AWB ticket with mcp__awb__create_ticket'),
    'must NOT tell an Action Run to file a ticket — that is the exact bug',
  );
  assert.ok(
    !p.includes('This is a CHAT channel, NOT a work channel'),
    'the chat work-policy rule is dropped for Action rooms',
  );
  // Reply CHANNEL is unchanged — still native-MCP send_chat_room_message.
  assert.ok(
    p.includes(`mcp__awb__send_chat_room_message MCP tool (room_id: "${ROOM}")`),
    'reply channel instruction unchanged for Action rooms',
  );
  // Auto-title instruction is suppressed even though roomName is empty.
  assert.ok(
    !p.includes('This chat room has no title yet'),
    'no auto-title prompt for Action rooms (they are already named)',
  );
});

test('composeChatRoomPrompt Action room (non-native / antigravity) → direct work via plain stdout', () => {
  const p = composeChatRoomPrompt(ROOM, [], ACTION_MSG, undefined, false, undefined, '', true);
  assert.ok(p.includes('This is an ACTION run'), 'Action framing present on the stdout path too');
  assert.ok(p.includes('Write your result'), 'result reported as the final message');
  assert.ok(
    p.includes('Reply with plain text as your final message'),
    'stdout reply channel preserved for a non-native adapter',
  );
  assert.ok(
    !p.includes('filed as an AWB ticket'),
    'the chat ticket-defer rule is dropped for Action rooms',
  );
});

test('composeChatRoomPrompt ordinary chat still files a ticket (regression — flag defaults false)', () => {
  const p = composeChatRoomPrompt(ROOM, [], MSG, undefined, true);
  assert.ok(
    p.includes('This is a CHAT channel, NOT a work channel'),
    'chat work-policy rule intact when isActionRoom is omitted',
  );
  assert.ok(
    p.includes('create an AWB ticket with mcp__awb__create_ticket'),
    'ordinary chat still creates a ticket for dev work',
  );
  assert.ok(!p.includes('This is an ACTION run'), 'Action framing never leaks into ordinary chat');
});
