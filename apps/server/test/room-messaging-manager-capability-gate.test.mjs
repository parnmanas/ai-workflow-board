// ticket c3b767c6 — chat-side dispatch-capability gate. This is the path the
// source incident (1af53029) actually hit: a DM to a Claude agent whose
// resolved profile opts into context_window clamping, dispatched to a manager
// that never learned the clamp exists. Same technique as
// room-messaging-chat-runtime-profile.test.mjs (drive the compiled
// sendMessage() with lightweight stub repos and assert on emitted
// activityEvents payloads), contrasting an old-shaped manager instance
// snapshot against a new one for the IDENTICAL profile/agent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { RoomMessagingService } = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'chat-rooms', 'room-messaging.service.js')
);
const { activityEvents } = await import(
  'file://' + path.join(DIST_ROOT, 'services', 'activity.service.js')
);

const warnLogs = [];
const noopLog = { info() {}, warn: (...args) => warnLogs.push(args), error() {}, debug() {} };

function makeQueryBuilder() {
  const qb = {
    select: () => qb,
    where: () => qb,
    andWhere: () => qb,
    orderBy: () => qb,
    addOrderBy: () => qb,
    limit: () => qb,
    async getMany() { return []; },
  };
  return qb;
}

const dataSource = {
  getRepository() {
    return { async findOne() { return null; }, async find() { return []; } };
  },
};

// vLLM-shaped profile — the exact field (context_window) that opts a profile
// into requiring MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP.
const VLLM_PROFILE = {
  id: 'vllm-qwen3-coder',
  protocol: 'anthropic-compatible',
  base_url: 'http://gpu-host:8000',
  model: 'qwen3-coder-next',
  context_window: 65536,
  safety_margin_tokens: 20000,
};

const OLD_MANAGER_INSTANCE = { plugin_version: '1.6.30' }; // predates capability reporting
const NEW_MANAGER_INSTANCE = { plugin_version: '1.6.94', manager_capabilities: ['context_window_clamp'] };

function makeSvc({ agent, workspace, instanceRegistry }) {
  const dmRoom = { id: 'room-1', type: 'dm', name: '', action_id: null, orchestration_mission_id: null, run_kind: null, workspace_id: 'ws-1' };
  const roomRepo = {
    async findOne() { return dmRoom; },
    async update() {},
  };
  const participantRepo = {
    async findOne() { return { room_id: 'room-1', participant_type: 'agent', participant_id: agent.id, left_at: null }; },
  };
  const workspaceRepo = { async findOne() { return workspace; } };
  const messageRepo = {
    // sendMessage()'s own transactional insert path.
    createQueryBuilder: makeQueryBuilder,
    manager: {
      async transaction(fn) {
        const em = {
          getRepository() {
            return {
              create: (fields) => ({ ...fields }),
              async save(row) { return { ...row, id: 'msg-1', created_at: new Date() }; },
            };
          },
        };
        return fn(em);
      },
    },
    // sendSystemMessage()'s direct (non-transactional) insert path — the
    // capability-mismatch branch posts through this, not the transaction above.
    create: (fields) => ({ ...fields }),
    async save(row) { return { ...row, id: 'sys-msg-1', created_at: new Date() }; },
  };
  const membership = {
    async requireActiveParticipant() {},
    async getRoomMemberIds() { return ['user-1', agent.id]; },
    async getRoomAgentMemberIds() { return [agent.id]; },
  };
  const mentionService = { parseMentions: () => [] };
  const agentRepo = {
    async findOne() { return agent; },
    async find() { return [agent]; }, // resolveAgentDisplayMap's manager-name lookup (unused: agent has no manager_agent_id here)
  };
  const connectivity = { isReachable: () => true };
  return new RoomMessagingService(
    roomRepo, participantRepo, messageRepo, agentRepo, {}, {}, {},
    workspaceRepo, dataSource, noopLog, membership, mentionService, connectivity, undefined,
    instanceRegistry,
  );
}

function captureOnce(eventName) {
  let captured = null;
  const handler = (payload) => { captured = payload; };
  activityEvents.once(eventName, handler);
  return {
    off: () => activityEvents.off(eventName, handler),
    get: () => captured,
  };
}

const wsWithVllmProfile = { id: 'ws-1', claude_backend_profiles_migrated: 0, cli_runtime_profiles: JSON.stringify([VLLM_PROFILE]) };

test('DM dispatch to an OLD manager (no manager_capabilities) for a context_window profile: chat_request is suppressed, a system message explains why', async () => {
  const agent = { id: 'agent-old', type: 'claude', role_prompt: '', cli_runtime_profile: 'vllm-qwen3-coder', credential_id: null };
  const instanceRegistry = { listForAgent: (id) => (id === agent.id ? [OLD_MANAGER_INSTANCE] : []) };
  const svc = makeSvc({ agent, workspace: wsWithVllmProfile, instanceRegistry });

  const chatRequest = captureOnce('chat_request');
  const roomMessage = captureOnce('chat_room_message');
  warnLogs.length = 0;
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    assert.equal(chatRequest.get(), null, 'an incompatible manager must never receive the chat_request — that IS the dispatch this ticket prevents');
    const sysMsg = roomMessage.get();
    assert.ok(sysMsg, 'a system message must explain the suppression instead of leaving the user with silence');
    assert.equal(sysMsg.sender_type, 'system');
    assert.match(sysMsg.content, /context_window_clamp/, 'the explanation must name the missing capability so an operator can act on it');
    assert.match(sysMsg.content, /1\.6\.30/, 'the explanation must name the incompatible manager version for fast diagnosis (this ticket\'s whole point)');
    assert.ok(warnLogs.length > 0, 'the mismatch must be logged, not silent');
  } finally {
    chatRequest.off();
    roomMessage.off();
  }
});

test('DM dispatch to a NEW manager (declares context_window_clamp) for the IDENTICAL profile: chat_request proceeds normally', async () => {
  const agent = { id: 'agent-new', type: 'claude', role_prompt: '', cli_runtime_profile: 'vllm-qwen3-coder', credential_id: null };
  const instanceRegistry = { listForAgent: (id) => (id === agent.id ? [NEW_MANAGER_INSTANCE] : []) };
  const svc = makeSvc({ agent, workspace: wsWithVllmProfile, instanceRegistry });

  const chatRequest = captureOnce('chat_request');
  const roomMessage = captureOnce('chat_room_message');
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    const payload = chatRequest.get();
    assert.ok(payload, 'a compatible manager must receive the chat_request');
    assert.equal(payload.cli_runtime_profile?.id, 'vllm-qwen3-coder');
    // sendMessage() always broadcasts the user's own message as a
    // chat_room_message too (unrelated to this gate); only a sender_type
    // 'system' one would mean a suppression notice was posted.
    const maybeSystemMsg = roomMessage.get();
    assert.notEqual(maybeSystemMsg?.sender_type, 'system', 'no suppression system message when the manager is compatible');
  } finally {
    chatRequest.off();
    roomMessage.off();
  }
});

test('DM dispatch with NO live manager telemetry at all: fails OPEN (dispatch proceeds) — cannot prove an incompatibility from silence', async () => {
  const agent = { id: 'agent-unknown', type: 'claude', role_prompt: '', cli_runtime_profile: 'vllm-qwen3-coder', credential_id: null };
  const instanceRegistry = { listForAgent: () => [] };
  const svc = makeSvc({ agent, workspace: wsWithVllmProfile, instanceRegistry });

  const chatRequest = captureOnce('chat_request');
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    assert.ok(chatRequest.get(), 'no live instance data must not block a dispatch — a fresh pairing or a TTL sweep looks identical to "no manager"');
  } finally {
    chatRequest.off();
  }
});

test('DM dispatch when instanceRegistry itself is undefined (hand-constructed caller that predates this ticket): fails OPEN, never throws', async () => {
  const agent = { id: 'agent-no-registry', type: 'claude', role_prompt: '', cli_runtime_profile: 'vllm-qwen3-coder', credential_id: null };
  const svc = makeSvc({ agent, workspace: wsWithVllmProfile, instanceRegistry: undefined });

  const chatRequest = captureOnce('chat_request');
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    assert.ok(chatRequest.get(), 'a missing registry dependency must degrade to fail-open, not crash the dispatch');
  } finally {
    chatRequest.off();
  }
});

test('DM dispatch for a profile WITHOUT context_window: never gates, even against an old manager', async () => {
  const plainProfile = { id: 'plain-anthropic', protocol: 'anthropic-compatible', base_url: 'http://127.0.0.1:9001', model: 'model-a' };
  const ws = { id: 'ws-1', claude_backend_profiles_migrated: 0, cli_runtime_profiles: JSON.stringify([plainProfile]) };
  const agent = { id: 'agent-plain', type: 'claude', role_prompt: '', cli_runtime_profile: 'plain-anthropic', credential_id: null };
  const instanceRegistry = { listForAgent: () => [OLD_MANAGER_INSTANCE] };
  const svc = makeSvc({ agent, workspace: ws, instanceRegistry });

  const chatRequest = captureOnce('chat_request');
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    assert.ok(chatRequest.get(), 'a profile with no context_window opts into nothing an old manager could get wrong — must never be gated');
  } finally {
    chatRequest.off();
  }
});
