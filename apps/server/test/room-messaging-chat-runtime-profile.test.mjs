// RoomMessagingService의 chat_request 디스패치에 Claude backend profile을
// 실어 보내는지 검증 (티켓 7d8ea7c9). 근본 원인은 agent-manager 쪽 배선
// 결함이었지만(handleChatRequest가 payload.cli_runtime_profile을 읽어
// runtimeProfile을 만들지 않음), 애초에 서버가 chat_request 이벤트에
// cli_runtime_profile을 실어 보낸 적이 없었다 — trigger-loop.service.ts가
// ticket dispatch에 대해 하는 것과 동일한 agent > workspace 해석을 chat
// 경로(DM/@-멘션)에도 적용해야 한다.
//
// room-messaging-chat-workspace-folder-opt-in.test.mjs와 같은 기법(실제
// 컴파일된 sendMessage()를 가벼운 stub repo로 구동하고, emit된 activityEvents
// payload를 검증)을 DM 경로(_handleDmAgentRequest)에 적용한다:
//   • Claude 타입 agent + 해석 가능한 프로필 → chat_request에 cli_runtime_profile 포함
//   • 비-Claude(codex 등) agent                 → cli_runtime_profile 생략 (다른 CLI에는 보이면 안 됨)
//   • 프로필이 요구하는 credential을 agent가 갖고 있지 않음 → 생략 + warn 로그

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
    async getMany() { return []; }, // no history -> agent_chain_depth 0
  };
  return qb;
}

// Minimal DataSource stand-in for resolveClaudeBackendProfileForDispatch:
// every repo lookup misses (SystemSetting global default, and the
// registry-backed WorkspaceClaudeBackendProfile/ClaudeBackendProfile paths
// this test doesn't exercise — workspace.claude_backend_profiles_migrated
// stays falsy so resolution reads workspace.cli_runtime_profiles instead).
const dataSource = {
  getRepository() {
    return { async findOne() { return null; }, async find() { return []; } };
  },
};

const LOCAL_PROFILE = {
  id: 'local-anthropic',
  protocol: 'anthropic-compatible',
  base_url: 'http://127.0.0.1:9001',
  model: 'model-a',
};

function makeSvc({ agent, workspace }) {
  const dmRoom = { id: 'room-1', type: 'dm', name: '', action_id: null, orchestration_mission_id: null, run_kind: null };
  const roomRepo = {
    async findOne() { return dmRoom; },
    async update() {},
  };
  const participantRepo = {
    async findOne() { return { room_id: 'room-1', participant_type: 'agent', participant_id: agent.id, left_at: null }; },
  };
  const workspaceRepo = { async findOne() { return workspace; } };
  const messageRepo = {
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
  };
  const membership = {
    async requireActiveParticipant() {},
    async getRoomMemberIds() { return ['user-1', agent.id]; },
    async getRoomAgentMemberIds() { return [agent.id]; },
  };
  const mentionService = { parseMentions: () => [] }; // plain text, no @[...] tokens
  const agentRepo = { async findOne() { return agent; } };
  // connectivity (ticket bfdd80b7): _handleDmAgentRequest always calls
  // _flagUnreachableAgent, which calls connectivity.isReachable() as a
  // synchronous boolean pre-filter. Must stub true so it no-ops instead of
  // throwing — irrelevant to what this file actually tests.
  const connectivity = { isReachable: () => true };
  const svc = new RoomMessagingService(
    roomRepo, participantRepo, messageRepo, agentRepo, {}, {}, {},
    workspaceRepo, dataSource, noopLog, membership, mentionService, connectivity, undefined,
  );
  return svc;
}

function captureEmit() {
  let captured = null;
  const handler = (payload) => { captured = payload; };
  activityEvents.once('chat_request', handler);
  return {
    off: () => activityEvents.off('chat_request', handler),
    get: () => captured,
  };
}

const optedOutWs = { id: 'ws-1', claude_backend_profiles_migrated: 0, cli_runtime_profiles: JSON.stringify([LOCAL_PROFILE]) };

test('DM to a Claude agent with a resolvable profile: chat_request carries cli_runtime_profile', async () => {
  const agent = { id: 'agent-1', type: 'claude', role_prompt: '', cli_runtime_profile: 'local-anthropic', credential_id: null };
  const svc = makeSvc({ agent, workspace: optedOutWs });
  const capture = captureEmit();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    const payload = capture.get();
    assert.ok(payload, 'chat_request should have been emitted for the DM');
    // Not a full deepEqual: resolveClaudeBackendProfileForDispatch() parses the
    // stored profile through ClaudeBackendProfileSchema, which fills in zod
    // defaults (kind, credential_required, auth_env) that LOCAL_PROFILE never
    // set explicitly. Those defaults are legitimate — RuntimeProfileSpec
    // (agent-manager) declares them as optional fields too — so only assert
    // the source fields this test actually configured survive untouched.
    for (const [key, value] of Object.entries(LOCAL_PROFILE)) {
      assert.equal(payload.cli_runtime_profile[key], value, `cli_runtime_profile.${key}`);
    }
  } finally {
    capture.off();
  }
});

test('DM to a non-Claude agent: chat_request omits cli_runtime_profile even with a configured profile', async () => {
  const agent = { id: 'agent-2', type: 'codex', role_prompt: '', cli_runtime_profile: 'local-anthropic', credential_id: null };
  const svc = makeSvc({ agent, workspace: optedOutWs });
  const capture = captureEmit();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    const payload = capture.get();
    assert.ok(payload, 'chat_request should have been emitted for the DM');
    assert.equal('cli_runtime_profile' in payload, false, 'non-Claude CLIs must never see a backend profile');
  } finally {
    capture.off();
  }
});

test('DM to a Claude agent with no cli_runtime_profile configured: chat_request omits the key (byte-identical legacy wire shape)', async () => {
  const agent = { id: 'agent-3', type: 'claude', role_prompt: '', cli_runtime_profile: null, credential_id: null };
  const svc = makeSvc({ agent, workspace: optedOutWs });
  const capture = captureEmit();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    const payload = capture.get();
    assert.ok(payload);
    assert.equal('cli_runtime_profile' in payload, false);
  } finally {
    capture.off();
  }
});

test('DM to a Claude agent whose resolved profile requires a credential it does not have: omitted + warns instead of dispatching a broken profile', async () => {
  const guardedProfile = { ...LOCAL_PROFILE, id: 'needs-cred', credential_required: true, credential_ref: '11111111-1111-1111-1111-111111111111' };
  const ws = { id: 'ws-1', claude_backend_profiles_migrated: 0, cli_runtime_profiles: JSON.stringify([guardedProfile]) };
  const agent = { id: 'agent-4', type: 'claude', role_prompt: '', cli_runtime_profile: 'needs-cred', credential_id: null };
  const svc = makeSvc({ agent, workspace: ws });
  const capture = captureEmit();
  warnLogs.length = 0;
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    const payload = capture.get();
    assert.ok(payload);
    assert.equal('cli_runtime_profile' in payload, false, 'a profile the agent cannot authenticate to must not reach the wire');
    assert.ok(warnLogs.length > 0, 'the credential mismatch must be logged, not silent');
  } finally {
    capture.off();
  }
});
