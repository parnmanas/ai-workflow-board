import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';

const AGENT_ID = 'agent-chat-idempotency';
const MESSAGE_ID = 'message-db-1';

function agentContext() {
  return {
    agent_id: AGENT_ID,
    name: 'Chat Agent',
    cli: 'codex',
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
  const spawns = [];
  const context = agentContext();
  const dispatcher = new EventDispatcher(
    {
      url: 'http://127.0.0.1:0',
      apiKey: 'test-key',
      delegation: {
        enabled: true,
        persistentChatSessions: false,
      },
    },
    {
      managedAgentContexts: {
        get: (id) => (id === AGENT_ID ? context : null),
        has: (id) => id === AGENT_ID,
        list: () => [context],
      },
      subagentManager: {
        canSpawn: () => true,
        async spawn(args) {
          spawns.push(args);
          return { spawned: true, pid: 41000 + spawns.length };
        },
      },
    },
  );
  return { dispatcher, spawns };
}

test('room-backed chat_request uses the persisted message id as its idempotency key', async () => {
  const { dispatcher, spawns } = harness();

  await dispatcher.handleChatRequest(JSON.stringify({
    event_type: 'chat_request',
    timestamp: '2026-07-30T04:36:17.137Z',
    payload: {
      agent_id: AGENT_ID,
      room_id: 'room-1',
      message_id: MESSAGE_ID,
      user_id: 'user-1',
      new_message: 'hello',
    },
  }));

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].chatRequestId, MESSAGE_ID);
});

test('chat_room_message does not execute again when chat_request is canonical for the message', async () => {
  const { dispatcher, spawns } = harness();

  await dispatcher.handleChatRequest(JSON.stringify({
    event_type: 'chat_request',
    timestamp: '2026-07-30T04:36:17.137Z',
    payload: {
      agent_id: AGENT_ID,
      room_id: 'room-1',
      message_id: MESSAGE_ID,
      user_id: 'user-1',
      new_message: 'hello',
    },
  }));
  await dispatcher.handleChatRoomMessage(JSON.stringify({
    event_type: 'chat_room_message',
    payload: {
      room_id: 'room-1',
      message_id: MESSAGE_ID,
      sender_type: 'user',
      sender_id: 'user-1',
      sender_name: 'Alice',
      content: 'hello',
      created_at: '2026-07-30T04:36:17.000Z',
      agent_member_ids: [AGENT_ID],
      dispatch_agent_ids: [AGENT_ID],
    },
  }));

  assert.equal(spawns.length, 1, 'one stored user message must start exactly one Codex subagent');
});
