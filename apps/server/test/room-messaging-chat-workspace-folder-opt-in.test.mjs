// RoomMessagingService.sendMessage()의 chat_workspace_folder_enabled opt-in 처리
// (티켓 9fd27487 — 티켓이 아닌 실행 경로에는 애초에 폴더 규칙이 없었다).
//
// 일반 채팅/DM/@-멘션 디스패치에는 run_provision이 아예 없어서, agent-manager가
// working_dir 루트에서 그대로 실행했다(티켓 41e69c91이 티켓에 대해 고쳤던 것과
// 같은 반스프롤(sprawl) 버그). sendMessage는 이제 FALLBACK RunProvision
// (kind:'chat')을 계산해 emit되는 chat_room_message에 찍어 넣는다 — 단, 다음
// 조건을 모두 만족할 때만:
//   1. 호출자가 이미 하나를 넘기지 않았을 때(opts.runProvision — Action/QA/
//      security는 이 폴백과 무관하게 계속 자기 것을 넘긴다)
//   2. 메시지가 실제 턴일 때('progress' 하트비트가 아닐 때)
//   3. 방이 Action Run / Orchestration Mission 방이 아닐 때(그런 방들은 이미
//      자체 provision을 갖고 있거나 의도적으로 아예 없다)
//   4. 대상 WORKSPACE가 opt-in했을 때(chat_workspace_folder_enabled) — 기본값은
//      OFF이므로, opt-in하지 않은 워크스페이스의 chat_room_message wire 형태는
//      바이트 단위로 그대로 유지된다(run_provision 키 자체가 없다)
//
// 실제 컴파일된 sendMessage()를 그 repository/service들을 대신하는 가벼운
// 대역(stand-in)들로 구동하고(room-messaging-content-limit.test.mjs와 같은
// 기법) 실제로 emit된 activityEvents의 'chat_room_message' payload — 즉
// agent-manager가 SSE로 읽는 바로 그 객체 — 를 검증한다.

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

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

function makeQueryBuilder() {
  const qb = {
    select: () => qb,
    where: () => qb,
    andWhere: () => qb,
    orderBy: () => qb,
    addOrderBy: () => qb,
    limit: () => qb,
    async getMany() { return []; }, // 이력 없음 → agent_chain_depth 0
  };
  return qb;
}

// `room`/`workspace`는 테스트별로 변경 가능한 fixture다 — 각 테스트가 스텁
// 그래프 전체를 다시 배선하지 않고도 action_id / orchestration_mission_id /
// chat_workspace_folder_enabled 값만 바꿔치기할 수 있다.
function makeSvc({ room, workspace }) {
  const roomRepo = {
    async findOne() { return room; }, // _handleDmAgentRequest(room.type 체크)와 roomForName 양쪽에서 함께 쓰인다
    async update() {},
  };
  const workspaceRepo = {
    calls: 0,
    async findOne() { workspaceRepo.calls++; return workspace; },
  };
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
    async getRoomMemberIds() { return ['user-1']; },
    async getRoomAgentMemberIds() { return ['agent-1']; },
  };
  const mentionService = { parseMentions: () => [] }; // 순수 텍스트, @[...] 토큰 없음
  // resolveAgentDisplayName(agentRepo, senderId)는 senderType==='agent'일 때마다
  // 호출된다(아래 progress-heartbeat 테스트) — null은 정당한 "찾을 수 없음"
  // 결과이며, 표시 이름(display-name) 해석은 이 경우 그냥 sender 이름으로
  // degrade되므로, 실제 Agent row가 없어도 된다.
  const agentRepo = { async findOne() { return null; } };
  const svc = new RoomMessagingService(
    roomRepo, {}, messageRepo, agentRepo, {}, {}, {},
    // dataSource (티켓 7d8ea7c9): _resolveChatRuntimeProfile 전용이며, 이 파일의
    // 시나리오는 전부 group room(@mention 없음, DM 아님)이라 도달하지 않는다.
    workspaceRepo, {}, noopLog, membership, mentionService, {}, undefined,
  );
  return { svc, workspaceRepo };
}

function captureEmit() {
  let captured = null;
  const handler = (payload) => { captured = payload; };
  activityEvents.once('chat_room_message', handler);
  return {
    off: () => activityEvents.off('chat_room_message', handler),
    get: () => captured,
  };
}

const plainRoom = { id: 'room-1', name: '', type: 'group', action_id: null, orchestration_mission_id: null, run_kind: null };
const actionRoom = { id: 'room-1', name: 'Action: Deploy · abc12345', type: 'group', action_id: 'action-1', orchestration_mission_id: null, run_kind: null };
const missionRoom = { id: 'room-1', name: 'Mission step', type: 'group', action_id: null, orchestration_mission_id: 'mission-1', run_kind: null };
const qaRoom = { id: 'room-1', name: 'QA: Smoke · abc12345', type: 'group', action_id: null, orchestration_mission_id: null, run_kind: 'qa' };
const optedInWs = { id: 'ws-1', chat_workspace_folder_enabled: 1 };
const optedOutWs = { id: 'ws-1', chat_workspace_folder_enabled: 0 };

test('opted-in workspace + plain chat room: emitted chat_room_message carries a kind:"chat" run_provision', async () => {
  const { svc } = makeSvc({ room: plainRoom, workspace: optedInWs });
  const capture = captureEmit();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    const payload = capture.get();
    assert.ok(payload, 'chat_room_message must have been emitted');
    assert.ok(payload.run_provision, 'run_provision must be present');
    assert.equal(payload.run_provision.kind, 'chat');
    assert.equal(payload.run_provision.workspace_folder, '.awb/chat/room-1');
    assert.equal(payload.run_provision.repo, null, 'chat never carries a repo — no repo_ref knob on ChatRoom');
    assert.equal(payload.run_provision.checkout_mode, 'reuse');
  } finally {
    capture.off();
  }
});

test('NOT opted in (default): no run_provision at all — byte-identical to pre-ticket wire shape', async () => {
  const { svc, workspaceRepo } = makeSvc({ room: plainRoom, workspace: optedOutWs });
  const capture = captureEmit();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    const payload = capture.get();
    assert.ok(payload);
    assert.ok(!('run_provision' in payload), 'the key itself must be absent, not just falsy');
    assert.equal(workspaceRepo.calls, 1, 'the flag WAS looked up (opt-out is a real decision, not a skipped check)');
  } finally {
    capture.off();
  }
});

test('Action Run room: no fallback provision even when the workspace opted in (Actions supply their own via opts.runProvision)', async () => {
  const { svc, workspaceRepo } = makeSvc({ room: actionRoom, workspace: optedInWs });
  const capture = captureEmit();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    const payload = capture.get();
    assert.ok(!('run_provision' in payload), 'action_id room is excluded from the chat fallback');
    // is_action_room은 이 티켓과 무관하게 독립적으로 계속 동작한다(티켓 e6d32e9d).
    assert.equal(payload.is_action_room, true);
    assert.equal(workspaceRepo.calls, 0, 'the flag lookup itself is skipped for an action room — no wasted query');
  } finally {
    capture.off();
  }
});

test('QA run room: no fallback provision on a FOLLOW-UP message even when the workspace opted in (review follow-up — a later status update must not override the run\'s real .awb/qa/<scenario> provision with a bogus .awb/chat/<room> one)', async () => {
  const { svc, workspaceRepo } = makeSvc({ room: qaRoom, workspace: optedInWs });
  const capture = captureEmit();
  try {
    // 여기서는 opts.runProvision을 넘기지 않는다 — 방 안의 나중 메시지를
    // 시뮬레이션한 것이다(qa-run.service.ts가 명시적으로 찍어 넣는 것은 방을
    // 여는 전송 하나뿐이다).
    await svc.sendMessage('room-1', 'ws-1', 'agent', 'agent-1', 'QA Bot', 'checked step 3, moving to step 4');
    const payload = capture.get();
    assert.ok(!('run_provision' in payload), 'run_kind room is excluded from the chat fallback');
    assert.equal(workspaceRepo.calls, 0, 'the flag lookup itself is skipped for a run_kind room — no wasted query');
  } finally {
    capture.off();
  }
});

test('Orchestration Mission room: no fallback provision (Mission steps use the ticket worktree instead)', async () => {
  const { svc, workspaceRepo } = makeSvc({ room: missionRoom, workspace: optedInWs });
  const capture = captureEmit();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'user', 'user-1', 'Alice', 'hello agent');
    const payload = capture.get();
    assert.ok(!('run_provision' in payload));
    assert.equal(workspaceRepo.calls, 0);
  } finally {
    capture.off();
  }
});

test('caller-supplied runProvision (Action/QA/security dispatch) always wins — the chat fallback never overwrites it', async () => {
  const { svc, workspaceRepo } = makeSvc({ room: plainRoom, workspace: optedInWs });
  const capture = captureEmit();
  const callerProvision = {
    kind: 'qa', run_id: 'run-9', workspace_id: 'ws-1',
    workspace_folder: '.awb/qa/scenario1', checkout_mode: 'reuse', repo: null,
  };
  try {
    await svc.sendMessage(
      'room-1', 'ws-1', 'user', 'system', 'QA', 'run the scenario',
      undefined, undefined, 'message', { runProvision: callerProvision },
    );
    const payload = capture.get();
    assert.deepEqual(payload.run_provision, callerProvision);
    assert.equal(workspaceRepo.calls, 0, 'no flag lookup needed — the caller already decided');
  } finally {
    capture.off();
  }
});

test('progress heartbeat: no fallback provision, and the workspace flag is never looked up (hot-path cost guard)', async () => {
  const { svc, workspaceRepo } = makeSvc({ room: plainRoom, workspace: optedInWs });
  const capture = captureEmit();
  try {
    await svc.sendMessage('room-1', 'ws-1', 'agent', 'agent-1', 'Builder', 'reading files…', undefined, undefined, 'progress');
    const payload = capture.get();
    assert.ok(!('run_provision' in payload));
    assert.equal(workspaceRepo.calls, 0, 'progress heartbeats must never spend a Workspace lookup');
  } finally {
    capture.off();
  }
});
