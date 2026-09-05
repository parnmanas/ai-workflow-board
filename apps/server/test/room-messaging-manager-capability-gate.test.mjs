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
// 리뷰 지적(9e2fc33d): 그룹 broadcast 테스트가 RoomMessagingService의 내부
// emit 객체만 보고 끝나면, 실제 wire로 나가는 event-registry.ts의
// map()/filter()/flatten() 경로에서 원본(미필터) agent_member_ids를 쓰는
// 회귀나 delivery-scope 배선 실수를 잡지 못한다. EVENT_TYPES를 직접 가져와
// events.controller.ts가 실제로 하는 일을 그대로 재현한다.
const { EVENT_TYPES } = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'events', 'event-registry.js')
);

function findEventDef(eventType) {
  const def = EVENT_TYPES.find((d) => d.eventType === eventType);
  assert.ok(def, `EVENT_TYPES must include ${eventType}`);
  return def;
}

/**
 * events.controller.ts의 SSE map() 단계만 재현한다(event-registry-chat-runtime-profile-wire.test.mjs의
 * wireBytes()와 동일 기법) — def.map()이 만드는 scope/payload가 최종 wire의
 * 근원이다.
 */
async function mapEvent(eventType, rawEvent) {
  const def = findEventDef(eventType);
  const mapped = await def.map(rawEvent, {});
  assert.ok(mapped, `${eventType} map() unexpectedly returned null/undefined for this fixture`);
  return { def, mapped };
}

/**
 * events.controller.ts의 ST-6 managed-agent fan-out(라인 474-492 부근)을
 * 재현한다: 매니저 identity는 자신이 관리하는 agent 중 이 이벤트의
 * scope.agent_member_ids에 실제로 속한 것을 찾아 effectiveIdentity로
 * 승격시킨 뒤에만 def.filter()를 통과할 수 있다. 이 재현이 없으면
 * roomMemberFilter만으로는 "매니저가 room의 여러 managed agent 중 하나를
 * 호스팅"하는 실제 배선을 검증할 수 없다. 반환값은 그 managedAgentId
 * 하나만 관리하는 매니저 커넥션이 이 이벤트를 실제로 받는지(delivered)와,
 * 받는다면 최종 wire bytes다.
 */
async function deliverToManagedAgent(eventType, rawEvent, managedAgentId) {
  const { def, mapped } = await mapEvent(eventType, rawEvent);
  const envelope = {
    event_type: def.eventType,
    scope: mapped.scope,
    payload: mapped.payload,
    timestamp: mapped.timestamp || new Date(0).toISOString(),
  };
  const identity = { type: 'agent', name: 'manager-under-test', managedAgentIds: new Set([managedAgentId]) };
  let effectiveIdentity = identity;
  if (typeof envelope.scope.agent_id === 'string' && identity.managedAgentIds.has(envelope.scope.agent_id)) {
    effectiveIdentity = { ...identity, agentId: envelope.scope.agent_id };
  } else if (envelope.scope.agent_member_ids instanceof Set) {
    for (const memberId of envelope.scope.agent_member_ids) {
      if (identity.managedAgentIds.has(memberId)) {
        effectiveIdentity = { ...identity, agentId: memberId };
        break;
      }
    }
  }
  const delivered = !def.filter || def.filter(envelope, effectiveIdentity);
  if (!delivered) return { delivered: false, bytes: null };
  const dataObj = def.flatten ? def.flatten(envelope) : envelope;
  return { delivered: true, bytes: JSON.stringify(dataObj) };
}

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

const { ClaudeBackendProfile } = await import(
  'file://' + path.join(DIST_ROOT, 'entities', 'index.js')
);

/** 런타임 프로필 정의를 claude_backend_profiles 행 모양으로 옮긴다. */
function profileRow(runtime) {
  const { id, protocol, base_url: baseUrl, model, credential_ref: credentialRef, ...rest } = runtime;
  return {
    id, protocol, base_url: baseUrl, model,
    credential_ref: credentialRef ?? null,
    config: JSON.stringify(rest),
  };
}

// 프로필은 인스턴스 전역이라(티켓 e616dbfc) claude_backend_profiles 테이블이
// 유일한 소스다 — 예전처럼 workspace.cli_runtime_profiles 를 읽지 않는다.
function makeDataSource(profiles) {
  const rows = profiles.map(profileRow);
  return {
    getRepository(entity) {
      if (entity === ClaudeBackendProfile) return { async find() { return rows; }, async findOne() { return null; } };
      return { async findOne() { return null; }, async find() { return []; } };
    },
  };
}

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

function makeSvc({ agent, workspace, instanceRegistry, profiles = [VLLM_PROFILE] }) {
  const dataSource = makeDataSource(profiles);
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
    // 티켓 f6a0de0e — orchestration 룸은 발화 시점에도 권한을 다시 본다. 이 스텁의
    // 방은 mission 룸이 아니므로 no-op 이지만, 메서드가 없으면 sendMessage 가 터진다.
    async requireMissionRoomSpeaker() {},
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

const wsWithVllmProfile = { id: 'ws-1' };

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
  const ws = { id: 'ws-1' };
  const agent = { id: 'agent-plain', type: 'claude', role_prompt: '', cli_runtime_profile: 'plain-anthropic', credential_id: null };
  const instanceRegistry = { listForAgent: () => [OLD_MANAGER_INSTANCE] };
  const svc = makeSvc({ agent, workspace: ws, instanceRegistry, profiles: [plainProfile] });

  const chatRequest = captureOnce('chat_request');
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    assert.ok(chatRequest.get(), 'a profile with no context_window opts into nothing an old manager could get wrong — must never be gated');
  } finally {
    chatRequest.off();
  }
});

// ── 그룹방 broadcast (ticket 9e2fc33d) ──────────────────────────────────────
// DM/@mention은 단일 대상이라 dispatch 자체를 거부하면 끝나지만(위 테스트들),
// 그룹방의 chat_room_message는 방 전체에 팬아웃된다. cli_runtime_profiles
// 맵에서만 비호환 멤버의 profile을 빼고 agent_member_ids에는 그대로 두면, 그
// 매니저는 "이 agent는 원래 profile이 없다"는 정상 케이스와 구분하지 못한 채
// map-없음 폴백(agent-manager resolveRoomBroadcastRuntimeProfile)을 그대로 타
// profile 없이(=CLI 고정 기본 output budget으로) dispatch를 강행해버린다 —
// c3b767c6/1af53029가 막으려던 hang+500을 그대로 재현하는 셈이다. 그래서
// 비호환 멤버는 map과 agent_member_ids 양쪽에서 함께 빠져야 하고, 다른
// 멤버(호환 매니저 또는 애초에 profile이 없는 agent)와 사람 참가자는 전혀
// 영향받지 않아야 한다.

function captureRoomMessageOnce() {
  let captured = null;
  const handler = (payload) => { captured = payload; };
  activityEvents.once('chat_room_message', handler);
  return {
    off: () => activityEvents.off('chat_room_message', handler),
    get: () => captured,
  };
}

function makeGroupSvc({ agents, workspace, instanceRegistry, profiles = [VLLM_PROFILE] }) {
  const dataSource = makeDataSource(profiles);
  const groupRoom = { id: 'room-1', type: 'group', name: '', action_id: null, orchestration_mission_id: null, run_kind: null };
  const roomRepo = {
    async findOne() { return groupRoom; },
    async update() {},
  };
  // markRead 자체의 participant/latest-message 조회 — 이 그룹 테스트들은
  // read-marker 동작을 검증하지 않으므로, getOne() -> null로 참가자 체크
  // 직후 바로 리턴하게만 해두면 충분하다(room-messaging-chat-runtime-profile
  // 테스트의 동일 stub과 같은 이유).
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
  const mentionService = { parseMentions: () => [] };
  const agentRepo = {
    async findOne({ where }) { return agents.find((a) => a.id === where.id) || null; },
    // 느슨한 stub(room-messaging-chat-runtime-profile.test.mjs의 makeGroupSvc와
    // 동일): fixture의 agents가 이미 테스트 대상 id만 담고 있으므로 type만
    // 필터링해도 실제 TypeORM의 `id IN (:...) AND type = 'claude'`와 같은
    // 결과가 나온다.
    async find({ where }) { return agents.filter((a) => a.type === (where.type ?? a.type)); },
  };
  const connectivity = { isReachable: () => true };
  return new RoomMessagingService(
    roomRepo, participantRepo, messageRepo, agentRepo, {}, {}, {},
    workspaceRepo, dataSource, noopLog, membership, mentionService, connectivity, undefined,
    instanceRegistry,
  );
}

test('Group room broadcast with mixed old/new managers: the old-manager member is dropped from BOTH cli_runtime_profiles and agent_member_ids; the new-manager member and a no-profile member are untouched', async () => {
  const oldManagerAgent = { id: 'agent-old-group', type: 'claude', role_prompt: '', cli_runtime_profile: 'vllm-qwen3-coder', credential_id: null };
  const newManagerAgent = { id: 'agent-new-group', type: 'claude', role_prompt: '', cli_runtime_profile: 'vllm-qwen3-coder', credential_id: null };
  const plainAgent = { id: 'agent-plain-group', type: 'claude', role_prompt: '', cli_runtime_profile: null, credential_id: null };
  const instanceRegistry = {
    listForAgent: (id) => {
      if (id === oldManagerAgent.id) return [OLD_MANAGER_INSTANCE];
      if (id === newManagerAgent.id) return [NEW_MANAGER_INSTANCE];
      return [];
    },
  };
  const svc = makeGroupSvc({
    agents: [oldManagerAgent, newManagerAgent, plainAgent],
    workspace: wsWithVllmProfile,
    instanceRegistry,
  });

  const roomMessage = captureRoomMessageOnce();
  warnLogs.length = 0;
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello room');
    const payload = roomMessage.get();
    assert.ok(payload, 'chat_room_message should have been emitted');

    assert.deepEqual(
      Object.keys(payload.cli_runtime_profiles).sort(),
      ['agent-new-group'],
      'only the compatible, profile-carrying member may appear in the map',
    );

    assert.deepEqual(
      Array.from(payload.agent_member_ids).sort(),
      ['agent-new-group', 'agent-plain-group'],
      'the incompatible member must be excluded from the broadcast dispatch-candidate set entirely — ' +
        'leaving it there would let its manager fall back to dispatching it profile-less (CLI default ' +
        'output budget), reproducing the exact hang+500 this gate exists to prevent',
    );

    assert.ok(
      Array.from(payload.member_ids).includes(oldManagerAgent.id),
      'member_ids (message visibility for the whole room) must NOT be filtered — only dispatch-candidate eligibility is',
    );

    assert.ok(warnLogs.length > 0, 'the mismatch must be logged, not silent');
  } finally {
    roomMessage.off();
  }
});

test('Group room broadcast with NO live manager telemetry: fails OPEN — the member stays in both cli_runtime_profiles and agent_member_ids', async () => {
  const agent = { id: 'agent-unknown-group', type: 'claude', role_prompt: '', cli_runtime_profile: 'vllm-qwen3-coder', credential_id: null };
  const instanceRegistry = { listForAgent: () => [] };
  const svc = makeGroupSvc({ agents: [agent], workspace: wsWithVllmProfile, instanceRegistry });

  const roomMessage = captureRoomMessageOnce();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello room');
    const payload = roomMessage.get();
    assert.ok(
      payload.cli_runtime_profiles?.[agent.id],
      'no live instance data must not block a broadcast profile — a fresh pairing or a TTL sweep looks identical to "no manager"',
    );
    assert.ok(Array.from(payload.agent_member_ids).includes(agent.id));
  } finally {
    roomMessage.off();
  }
});

test('Group room broadcast when instanceRegistry itself is undefined: fails OPEN, never throws', async () => {
  const agent = { id: 'agent-no-registry-group', type: 'claude', role_prompt: '', cli_runtime_profile: 'vllm-qwen3-coder', credential_id: null };
  const svc = makeGroupSvc({ agents: [agent], workspace: wsWithVllmProfile, instanceRegistry: undefined });

  const roomMessage = captureRoomMessageOnce();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello room');
    const payload = roomMessage.get();
    assert.ok(payload.cli_runtime_profiles?.[agent.id]);
    assert.ok(Array.from(payload.agent_member_ids).includes(agent.id));
  } finally {
    roomMessage.off();
  }
});

test('Group room broadcast end-to-end through event-registry: final wire bytes exclude the incompatible agent, and a subscriber managing ONLY that agent never receives the event', async () => {
  const oldManagerAgent = { id: 'agent-old-wire', type: 'claude', role_prompt: '', cli_runtime_profile: 'vllm-qwen3-coder', credential_id: null };
  const newManagerAgent = { id: 'agent-new-wire', type: 'claude', role_prompt: '', cli_runtime_profile: 'vllm-qwen3-coder', credential_id: null };
  const instanceRegistry = {
    listForAgent: (id) => {
      if (id === oldManagerAgent.id) return [OLD_MANAGER_INSTANCE];
      if (id === newManagerAgent.id) return [NEW_MANAGER_INSTANCE];
      return [];
    },
  };
  const svc = makeGroupSvc({
    agents: [oldManagerAgent, newManagerAgent],
    workspace: wsWithVllmProfile,
    instanceRegistry,
  });

  // 1) RoomMessagingService.sendMessage()를 실제로 구동해, 그 결과로 emit된
  // 원본 이벤트 객체를 그대로 캡처한다 — 손으로 만든 fixture가 아니라 서비스가
  // 실제로 내보내는 객체를 아래 event-registry 파이프라인에 그대로 흘려보낸다.
  const roomMessage = captureRoomMessageOnce();
  let rawEvent;
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello room');
    rawEvent = roomMessage.get();
  } finally {
    roomMessage.off();
  }
  assert.ok(rawEvent, 'chat_room_message should have been emitted');

  // 2) event-registry.ts의 실제 map()을 통과시켜 wire payload/scope를 도출한다
  // (리뷰 지적: RoomMessagingService의 내부 객체만 보는 것으로는 Set→array
  // flatten이나 scope 배선에서 원본 미필터 집합을 쓰는 회귀를 잡지 못한다).
  const { mapped } = await mapEvent('chat_room_message', rawEvent);
  assert.deepEqual(
    Object.keys(mapped.payload.cli_runtime_profiles),
    [newManagerAgent.id],
    'wire cli_runtime_profiles must carry only the compatible agent',
  );
  assert.deepEqual(
    [...mapped.payload.agent_member_ids].sort(),
    [newManagerAgent.id],
    'wire agent_member_ids array must exclude the incompatible agent',
  );
  assert.ok(mapped.scope.agent_member_ids instanceof Set, 'scope.agent_member_ids must stay a Set for roomMemberFilter');
  assert.deepEqual(
    [...mapped.scope.agent_member_ids].sort(),
    [newManagerAgent.id],
    'delivery-scope agent_member_ids (used by roomMemberFilter) must exclude the incompatible agent too — ' +
      'if scope used a different, unfiltered copy of the set, the wire payload could look correct while ' +
      'delivery still reached the incompatible manager',
  );

  // 3) events.controller.ts의 managed-agent fan-out + roomMemberFilter를
  // 재현: 비호환 agent만 관리하는 매니저 커넥션은 이벤트를 아예 받지 못하고,
  // 호환 agent를 관리하는 매니저 커넥션은 정상 수신해야 한다.
  const oldOnly = await deliverToManagedAgent('chat_room_message', rawEvent, oldManagerAgent.id);
  assert.equal(
    oldOnly.delivered,
    false,
    'a manager hosting ONLY the incompatible agent must not receive the broadcast at all',
  );

  const newOnly = await deliverToManagedAgent('chat_room_message', rawEvent, newManagerAgent.id);
  assert.equal(newOnly.delivered, true, 'a manager hosting the compatible agent must receive the broadcast');
  assert.ok(newOnly.bytes.includes(newManagerAgent.id));
  assert.ok(
    !newOnly.bytes.includes(oldManagerAgent.id),
    'the incompatible agent must not appear anywhere in the final wire bytes (map key or member list)',
  );
});
