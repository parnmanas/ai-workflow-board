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
const errorLogs = [];
const noopLog = { info() {}, warn: (...args) => warnLogs.push(args), error: (...args) => errorLogs.push(args), debug() {} };

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

const { ClaudeBackendProfile } = await import(
  'file://' + path.join(DIST_ROOT, 'entities', 'index.js')
);

const LOCAL_PROFILE = {
  id: 'local-anthropic',
  protocol: 'anthropic-compatible',
  base_url: 'http://127.0.0.1:9001',
  model: 'model-a',
};

/** 런타임 프로필 정의를 claude_backend_profiles 행 모양으로 옮긴다. */
function profileRow(runtime) {
  const { id, protocol, base_url: baseUrl, model, credential_ref: credentialRef, ...rest } = runtime;
  return {
    id, protocol, base_url: baseUrl, model,
    credential_ref: credentialRef ?? null,
    config: JSON.stringify(rest),
  };
}

// resolveClaudeBackendProfileForDispatch 용 최소 DataSource. 프로필은 인스턴스
// 전역이므로(티켓 e616dbfc) claude_backend_profiles 테이블이 유일한 소스다 —
// 예전처럼 workspace.cli_runtime_profiles 를 읽지 않는다. SystemSetting(전역
// 기본값)은 findOne() → null 로 "미설정"이 된다.
function makeDataSource(profiles = [LOCAL_PROFILE]) {
  const rows = profiles.map(profileRow);
  return {
    getRepository(entity) {
      if (entity === ClaudeBackendProfile) return { async find() { return rows; }, async findOne() { return null; } };
      return { async findOne() { return null; }, async find() { return []; } };
    },
  };
}

function makeSvc({ agent, workspace, profiles = [LOCAL_PROFILE] }) {
  const dataSource = makeDataSource(profiles);
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
    // 티켓 f6a0de0e — orchestration 룸은 발화 시점에도 권한을 다시 본다. 이 스텁의
    // 방은 mission 룸이 아니므로 no-op 이지만, 메서드가 없으면 sendMessage 가 터진다.
    async requireMissionRoomSpeaker() {},
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

const optedOutWs = { id: 'ws-1' };

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
  const guardedProfile = { ...LOCAL_PROFILE, id: 'needs-cred', credential_required: true, credential_ref: '11111111-1111-4111-8111-111111111111' };
  const agent = { id: 'agent-4', type: 'claude', role_prompt: '', cli_runtime_profile: 'needs-cred', credential_id: null };
  const svc = makeSvc({ agent, workspace: optedOutWs, profiles: [guardedProfile] });
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

test('DM profile 조회 실패는 profile 미지정으로 축약하지 않고 디스패치를 중단한다', async () => {
  const malformedProfile = { ...LOCAL_PROFILE, id: 'malformed', credential_required: true, credential_ref: '잘못된-id' };
  const agent = { id: 'agent-5', type: 'claude', role_prompt: '', cli_runtime_profile: 'malformed', credential_id: null };
  const svc = makeSvc({ agent, workspace: optedOutWs, profiles: [malformedProfile] });
  const capture = captureEmit();
  errorLogs.length = 0;
  try {
    // 검증하는 불변식은 "조용히 무프로필로 축약하지 않고 디스패치를 중단한다"
    // 이다. 프로필 파싱은 ClaudeBackendProfileSchema(zod)가 하므로 예외 문구는
    // 라이브러리 버전에 따라 달라진다 — 문구가 아니라 (1) 거부됐다 (2) 아무것도
    // emit 되지 않았다 (3) 오류가 기록됐다 는 관찰 가능한 사실만 단언한다.
    await assert.rejects(
      svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent'),
      (error) => error instanceof Error,
    );
    assert.equal(capture.get(), null, '해석에 실패했으면 chat_request 가 나가면 안 됩니다');
    assert.ok(errorLogs.length > 0);
  } finally {
    capture.off();
  }
});

// ── 그룹방 broadcast (review round 1): chat_room_message의 agent별
// cli_runtime_profiles 맵 ────────────────────────────────────────────────
// DM의 단일 chat_request와 달리, 그룹방의 chat_room_message는 모든
// 멤버에게 팬아웃된다 — RoomMessagingService는 (명시적 @mention/DM
// 대상뿐 아니라) Claude-type 멤버마다 맵 항목을 하나씩 해석해야, 각
// 매니저 인스턴스가 broadcast에서 자기 responder의 profile을 골라 쓸 수
// 있다.

function captureRoomMessageEmit() {
  let captured = null;
  const handler = (payload) => { captured = payload; };
  activityEvents.once('chat_room_message', handler);
  return {
    off: () => activityEvents.off('chat_room_message', handler),
    get: () => captured,
  };
}

function makeGroupSvc({ agents, workspace, onAgentFind, profiles = [LOCAL_PROFILE] }) {
  const dataSource = makeDataSource(profiles);
  const groupRoom = { id: 'room-1', type: 'group', name: '', action_id: null, orchestration_mission_id: null, run_kind: null };
  const roomRepo = {
    async findOne() { return groupRoom; },
    async update() {},
  };
  // markRead 자체의 participant/latest-message 조회 — 그룹 테스트는
  // read-marker 동작을 검증하지 않으므로 동작은 하되 아무 일도 안 하는
  // stub이면 충분하다(getOne() -> null이면 markRead가 participant 체크
  // 직후 바로 리턴한다, DM 테스트에서 허용한 markRead no-op과 동일).
  const participantRepo = { async findOne() { return { id: 'participant-1' }; } };
  const workspaceRepo = { async findOne() { return workspace; } };
  const messageRepo = {
    createQueryBuilder: () => ({ ...makeQueryBuilder(), async getOne() { return null; } }),
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
  const agentMemberIds = new Set(agents.map((a) => a.id));
  const membership = {
    async requireActiveParticipant() {},
    // 티켓 f6a0de0e — orchestration 룸은 발화 시점에도 권한을 다시 본다. 이 스텁의
    // 방은 mission 룸이 아니므로 no-op 이지만, 메서드가 없으면 sendMessage 가 터진다.
    async requireMissionRoomSpeaker() {},
    async getRoomMemberIds() { return new Set(['user-1', ...agentMemberIds]); },
    async getRoomAgentMemberIds() { return agentMemberIds; },
  };
  const mentionService = { parseMentions: () => [] }; // 평문 텍스트, @[...] 토큰 없음
  const agentRepo = {
    async findOne({ where }) { return agents.find((a) => a.id === where.id) || null; },
    // 느슨한 stub: 실제 TypeORM은 서버단에서 `id IN (:...ids) AND type =
    // 'claude'`로 필터링한다 — 이 fixture의 `agents` 목록은 이미 테스트
    // 대상 id만 담고 있으므로 `type`만 필터링해도 동일한 결과가 나온다.
    async find({ where }) {
      onAgentFind?.();
      return agents.filter((a) => a.type === (where.type ?? a.type));
    },
  };
  const connectivity = { isReachable: () => true };
  const svc = new RoomMessagingService(
    roomRepo, participantRepo, messageRepo, agentRepo, {}, {}, {},
    workspaceRepo, dataSource, noopLog, membership, mentionService, connectivity, undefined,
  );
  return svc;
}

test('Group room broadcast: cli_runtime_profiles carries only the Claude-type member with a resolvable profile', async () => {
  const claudeAgent = { id: 'agent-1', type: 'claude', role_prompt: '', cli_runtime_profile: 'local-anthropic', credential_id: null };
  const codexAgent = { id: 'agent-2', type: 'codex', role_prompt: '', cli_runtime_profile: 'local-anthropic', credential_id: null };
  const svc = makeGroupSvc({ agents: [claudeAgent, codexAgent], workspace: optedOutWs });
  const capture = captureRoomMessageEmit();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello room');
    const payload = capture.get();
    assert.ok(payload, 'chat_room_message should have been emitted');
    assert.ok(payload.cli_runtime_profiles, 'expected a cli_runtime_profiles map');
    assert.deepEqual(Object.keys(payload.cli_runtime_profiles), ['agent-1'], 'the non-Claude member must not appear in the map');
    for (const [key, value] of Object.entries(LOCAL_PROFILE)) {
      assert.equal(payload.cli_runtime_profiles['agent-1'][key], value, `cli_runtime_profiles['agent-1'].${key}`);
    }
  } finally {
    capture.off();
  }
});

test('Group room broadcast: cli_runtime_profiles is omitted entirely when no member resolves a profile', async () => {
  const claudeAgentNoProfile = { id: 'agent-3', type: 'claude', role_prompt: '', cli_runtime_profile: null, credential_id: null };
  const emptyWs = { id: 'ws-2' };
  const svc = makeGroupSvc({ agents: [claudeAgentNoProfile], workspace: emptyWs });
  const capture = captureRoomMessageEmit();
  try {
    await svc.sendMessage('room-1', 'ws-2', 'user', 'user-1', 'Alice', 'hello room');
    const payload = capture.get();
    assert.ok(payload);
    assert.equal('cli_runtime_profiles' in payload, false, 'no resolvable profile must not leave an empty map on the wire');
  } finally {
    capture.off();
  }
});

test('Group room broadcast: a progress heartbeat never triggers profile resolution (cli_runtime_profiles absent, agentRepo.find not called)', async () => {
  const claudeAgent = { id: 'agent-1', type: 'claude', role_prompt: '', cli_runtime_profile: 'local-anthropic', credential_id: null };
  // onAgentFind는 isRealMessage 게이트가 progress row에 대해 단순히 빈
  // 맵으로 해석되는 게 아니라 resolution 자체를 완전히 건너뛴다는 것을
  // 증명한다.
  let findCalls = 0;
  const svc = makeGroupSvc({ agents: [claudeAgent], workspace: optedOutWs, onAgentFind: () => { findCalls += 1; } });
  const capture = captureRoomMessageEmit();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'agent', 'manager-1', 'Manager', 'tool call narration', undefined, undefined, 'progress');
    const payload = capture.get();
    assert.ok(payload, 'chat_room_message should still be emitted for a progress row');
    assert.equal('cli_runtime_profiles' in payload, false, 'a progress heartbeat must never carry a profile map');
    assert.equal(findCalls, 0, 'progress rows must skip profile resolution entirely (isRealMessage gate)');
  } finally {
    capture.off();
  }
});
