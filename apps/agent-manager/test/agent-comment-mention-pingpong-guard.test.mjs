import assert from 'node:assert/strict';
import test from 'node:test';
import { isAgentTerminalAcknowledgement } from '../dist/lib/terminal-ack-guard.js';
import { EventDispatcher, AGENT_CHAIN_DEPTH_CAP } from '../dist/lib/event-dispatcher.js';

test('manager suppresses only same-state terminal approval acknowledgements', () => {
  assert.equal(isAgentTerminalAcknowledgement({
    actor_type: 'agent', content: '89ac69f 승인 확인, blocker 없음',
  }), true);
  assert.equal(isAgentTerminalAcknowledgement({
    actor_type: 'agent', terminal_ack: true, content: 'receipt', metadata: { event_id: 'approval-1' },
  }), true);
  assert.equal(isAgentTerminalAcknowledgement({
    actor_type: 'agent', terminal_ack: true, content: 'receipt',
  }), false, 'identity-free structured events must not suppress a later approval cycle');
});

test('manager delivers real agent work mentions', () => {
  for (const content of [
    '89ac69f 승인 관련 질문이 있습니다?',
    '89ac69f 변경 요청: 테스트를 추가해 주세요',
    'agent handoff: 새 작업을 맡아 주세요',
    'consensus 합의가 필요합니다',
  ]) assert.equal(isAgentTerminalAcknowledgement({ actor_type: 'agent', content }), false);
  assert.equal(isAgentTerminalAcknowledgement({ actor_type: 'user', content: '89ac69f 승인, blocker 없음' }), false);
});

test('EventDispatcher suppresses terminal receipts before forward/defer/spawn but forwards questions', async () => {
  let forwards = 0;
  let spawns = 0;
  const dispatcher = new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test', delegation: { enabled: true, persistentTicketSessions: true } },
    {
      ticketSessionManager: { forwardCommentMention() { forwards++; return true; } },
      subagentManager: { canSpawn() { return true; }, async spawn() { spawns++; return { spawned: true }; } },
    },
  );
  const base = { ticket_id: 'T1', comment_id: 'C1', agent_id: 'A1', actor_id: 'A2', actor_type: 'agent' };
  await dispatcher.handleCommentMention(JSON.stringify({ ...base, content: '89ac69f 승인, blocker 없음' }));
  assert.deepEqual({ forwards, spawns }, { forwards: 0, spawns: 0 });
  await dispatcher.handleCommentMention(JSON.stringify({ ...base, comment_id: 'C2', content: '89ac69f 승인 관련 질문?' }));
  assert.deepEqual({ forwards, spawns }, { forwards: 1, spawns: 0 });
});

// ── agent_chain_depth cap on the ticket-comment mention path (ticket 07402c57) ──
//
// Ports the chat-room chain-depth loop guard to comment_mention: the server
// stamps agent_chain_depth on every comment_mention (see agent-chain-depth.ts /
// tickets.controller.ts / comment-tools.ts on the server side); once an
// agent-authored mention's depth reaches AGENT_CHAIN_DEPTH_CAP, delegation
// must stop the same way handleChatRoomMessage already stops for chat.

test('EventDispatcher suppresses delegation once agent_chain_depth reaches the cap', async () => {
  let forwards = 0;
  let spawns = 0;
  const dispatcher = new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test', delegation: { enabled: true, persistentTicketSessions: true } },
    {
      ticketSessionManager: { forwardCommentMention() { forwards++; return true; } },
      subagentManager: { canSpawn() { return true; }, async spawn() { spawns++; return { spawned: true }; } },
    },
  );
  const base = { ticket_id: 'T2', comment_id: 'C1', agent_id: 'A1', actor_id: 'A2', actor_type: 'agent', content: '질문 있습니다' };

  await dispatcher.handleCommentMention(JSON.stringify({ ...base, comment_id: 'C1', agent_chain_depth: AGENT_CHAIN_DEPTH_CAP - 1 }));
  assert.deepEqual({ forwards, spawns }, { forwards: 1, spawns: 0 }, 'below the cap still delegates');

  await dispatcher.handleCommentMention(JSON.stringify({ ...base, comment_id: 'C2', agent_chain_depth: AGENT_CHAIN_DEPTH_CAP }));
  assert.deepEqual({ forwards, spawns }, { forwards: 1, spawns: 0 }, 'at the cap, delegation is skipped');

  await dispatcher.handleCommentMention(JSON.stringify({ ...base, comment_id: 'C3', agent_chain_depth: AGENT_CHAIN_DEPTH_CAP + 5 }));
  assert.deepEqual({ forwards, spawns }, { forwards: 1, spawns: 0 }, 'above the cap, delegation stays skipped');
});

test('EventDispatcher only applies the chain-depth cap to agent-authored mentions', async () => {
  let forwards = 0;
  const dispatcher = new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test', delegation: { enabled: true, persistentTicketSessions: true } },
    {
      ticketSessionManager: { forwardCommentMention() { forwards++; return true; } },
      subagentManager: { canSpawn() { return true; }, async spawn() { return { spawned: true }; } },
    },
  );
  // A user-authored mention carries no real ping-pong risk even if some stale
  // depth value were attached — the cap must not fire for actor_type='user'.
  await dispatcher.handleCommentMention(JSON.stringify({
    ticket_id: 'T3', comment_id: 'C1', agent_id: 'A1', actor_id: 'U1', actor_type: 'user',
    content: '사람이 남긴 코멘트', agent_chain_depth: AGENT_CHAIN_DEPTH_CAP + 1,
  }));
  assert.equal(forwards, 1, 'user-authored mentions are never capped by agent_chain_depth');
});

test('EventDispatcher treats a missing agent_chain_depth as 0 (defaults to delegating)', async () => {
  let forwards = 0;
  const dispatcher = new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test', delegation: { enabled: true, persistentTicketSessions: true } },
    {
      ticketSessionManager: { forwardCommentMention() { forwards++; return true; } },
      subagentManager: { canSpawn() { return true; }, async spawn() { return { spawned: true }; } },
    },
  );
  await dispatcher.handleCommentMention(JSON.stringify({
    ticket_id: 'T4', comment_id: 'C1', agent_id: 'A1', actor_id: 'A2', actor_type: 'agent',
    content: '질문 있습니다',
  }));
  assert.equal(forwards, 1, 'an old server / replayed event without agent_chain_depth must not be treated as looping');
});
