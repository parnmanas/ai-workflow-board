// 미션별 사용자 chat 옵션(`user_chat_mode`) — 티켓 9cfd8161.
//
// 이 옵션의 실패 형태는 "select 는 있는데 골라도 아무 일도 없는 죽은 컨트롤"이다. 그래서
// 값을 저장했는지가 아니라 **발화가 실제로 막히고 열리는지**를 진짜 sql.js DataSource 위에서
// 확인한다. 게이트는 방의 `open_join` 이 아니라 미션 행을 읽으므로, 스텁으로는 그 계약
// (단일 기준이 미션이라는 것)이 전혀 검증되지 않는다.
//
// 두 축을 본다:
//   1. 발화 게이트 — 모드별 허용/거부, 종료 미션, 사유의 구분(요구사항 C), 그리고
//      옵션 변경이 **실행 중인 방에 즉시** 반영되는가.
//   2. 백필 마이그레이션 — 기존 방 정렬과 소유자 등록, 그리고 재실행 시 중복 없음.
//
// 마이그레이션은 클래스를 직접 불러 실제 QueryRunner 로 돌린다. "재실행해도 중복 행이
// 생기지 않는다"는 성질은 up() 을 두 번 돌려야만 검증되고, 그것이 이 티켓의 명시적
// 완료 조건이다.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { ChatRoom } from '../dist/entities/ChatRoom.js';
import { ChatRoomParticipant } from '../dist/entities/ChatRoomParticipant.js';
import { ChatRoomMessage } from '../dist/entities/ChatRoomMessage.js';
import { User } from '../dist/entities/User.js';
import { Agent } from '../dist/entities/Agent.js';
import { OrchestrationMission } from '../dist/entities/OrchestrationMission.js';
import { OrchestrationStep } from '../dist/entities/OrchestrationStep.js';
import { OrchestrationEvent } from '../dist/entities/OrchestrationEvent.js';
import { OrchestrationTeam } from '../dist/entities/OrchestrationTeam.js';
import { OrchestrationTeamMember } from '../dist/entities/OrchestrationTeamMember.js';
import { RoomMembershipService } from '../dist/modules/chat-rooms/room-membership.service.js';
import { RoomMessagingService } from '../dist/modules/chat-rooms/room-messaging.service.js';
import { OrchestrationMissionService } from '../dist/modules/orchestration/orchestration-mission.service.js';
import { BackfillMissionRoomUserChat1760000000084 } from '../dist/database/migrations/1760000000084-BackfillMissionRoomUserChat.js';

const WS = '11111111-1111-4111-8111-111111111111';
/** MANAGE_ACTIONS 를 가진 운영자. 이 방에서 말할 자격이 있는 쪽. */
const ADMIN = '33333333-3333-4333-8333-333333333333';
/** 로그인은 돼 있지만 MANAGE_ACTIONS 가 없는 일반 사용자. */
const PLAIN = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

let dataSource;
let membership;
let messaging;
let missionService;

/** 미션 하나와 그 대화방을 만든다. 반환값은 {mission, room}. */
async function seedMission(missionOverrides = {}, roomOverrides = {}) {
  const missionRepo = dataSource.getRepository(OrchestrationMission);
  const roomRepo = dataSource.getRepository(ChatRoom);

  const mission = await missionRepo.save(missionRepo.create({
    workspace_id: WS,
    team_id: 'team-1',
    title: 'Ship the export',
    objective: 'Add a CSV export.',
    status: 'running',
    created_by_type: 'user',
    created_by: ADMIN,
    ...missionOverrides,
  }));

  const room = await roomRepo.save(roomRepo.create({
    workspace_id: WS,
    type: 'group',
    name: `Mission: ${mission.title}`,
    last_message_at: null,
    orchestration_mission_id: mission.id,
    orchestration_step_id: null,
    ...roomOverrides,
  }));

  mission.room_id = room.id;
  await missionRepo.save(mission);
  return { mission, room };
}

async function addParticipant(roomId, participantId, type = 'user') {
  const partRepo = dataSource.getRepository(ChatRoomParticipant);
  return partRepo.save(partRepo.create({
    room_id: roomId,
    participant_type: type,
    participant_id: participantId,
    last_read_at: null,
    left_at: null,
  }));
}

/** 유저로 발화를 시도한다. 성공하면 저장된 메시지, 실패하면 그대로 throw. */
const sendAsUser = (roomId, senderId) =>
  messaging.sendMessage(roomId, WS, 'user', senderId, 'Sender', 'hello');

/** (room, participant) 의 모든 행 — 탈퇴 행 포함. 중복 판정에 쓴다. */
function allParticipantRows(roomId, participantId) {
  return dataSource.getRepository(ChatRoomParticipant).find({
    where: { room_id: roomId, participant_id: participantId, participant_type: 'user' },
  });
}

async function runBackfill() {
  const queryRunner = dataSource.createQueryRunner();
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await new BackfillMissionRoomUserChat1760000000084().up(queryRunner);
  } finally {
    console.log = original;
    await queryRunner.release();
  }
  return lines.find((l) => l.includes('survey:')) ?? '';
}

before(async () => {
  dataSource = new DataSource({
    type: 'sqljs',
    entities: [
      ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Agent,
      OrchestrationMission, OrchestrationStep, OrchestrationEvent,
      OrchestrationTeam, OrchestrationTeamMember,
    ],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();

  const roomRepo = dataSource.getRepository(ChatRoom);
  const partRepo = dataSource.getRepository(ChatRoomParticipant);
  const msgRepo = dataSource.getRepository(ChatRoomMessage);
  const userRepo = dataSource.getRepository(User);
  const agentRepo = dataSource.getRepository(Agent);
  const missionRepo = dataSource.getRepository(OrchestrationMission);

  // 권한 축을 실제 users 행으로 만든다 — 게이트가 세션 스냅샷이 아니라 users 를 직접
  // 읽는 것이 티켓 f6a0de0e 의 계약이라, 스텁으로 대신하면 그 계약이 검증되지 않는다.
  await userRepo.save(userRepo.create({
    id: ADMIN, email: 'admin@x', name: 'Admin', password: 'x', role: 'admin', permissions: '[]',
  }));
  await userRepo.save(userRepo.create({
    id: PLAIN, email: 'plain@x', name: 'Plain', password: 'x', role: 'user', permissions: '[]',
  }));
  await agentRepo.save(agentRepo.create({ id: AGENT, name: 'Orchestrator', workspace_id: WS }));

  membership = new RoomMembershipService(roomRepo, partRepo, userRepo, agentRepo, dataSource, missionRepo);

  const empty = {};
  messaging = new RoomMessagingService(
    roomRepo, partRepo, msgRepo, agentRepo,
    empty, empty, empty,
    { async findOne() { return null; } },
    dataSource, noopLog, membership,
    { parseMentions: () => [], async resolveMentions() { return []; } },
    empty,
  );

  missionService = new OrchestrationMissionService(
    missionRepo,
    dataSource.getRepository(OrchestrationStep),
    dataSource.getRepository(OrchestrationEvent),
    dataSource.getRepository(OrchestrationTeam),
    dataSource.getRepository(OrchestrationTeamMember),
    agentRepo,
    dataSource,
    noopLog,
    roomRepo,
  );
});

after(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  // 방/미션/참여자/메시지를 매번 비운다 — 참여자 행이 남으면 "참여자가 아니면 막힌다"가
  // 조용히 통과해 버린다.
  await dataSource.getRepository(ChatRoomMessage).clear();
  await dataSource.getRepository(ChatRoomParticipant).clear();
  await dataSource.getRepository(ChatRoom).clear();
  await dataSource.getRepository(OrchestrationEvent).clear();
  await dataSource.getRepository(OrchestrationStep).clear();
  await dataSource.getRepository(OrchestrationMission).clear();
});

describe('미션 chat 옵션이 발화를 지배한다', () => {
  it("기본값(open)에서는 참여자가 아닌 운영자도 발화한다", async () => {
    const { room } = await seedMission({}, { open_join: true });
    const msg = await sendAsUser(room.id, ADMIN);
    assert.ok(msg?.id, '기본 모드는 참여자 등록 없이도 발화를 허용해야 한다');
  });

  it("빈 문자열로 남은 기존 행도 기본값으로 접혀 발화가 열린다", async () => {
    // DDL 없이 추가된 컬럼이라 기존 미션은 ''/NULL 로 남을 수 있다. 정규화가 빠지면
    // 어느 분기에도 걸리지 않아 기존 미션의 대화가 영영 닫힌다.
    const { room } = await seedMission({ user_chat_mode: '' }, { open_join: true });
    const msg = await sendAsUser(room.id, ADMIN);
    assert.ok(msg?.id, "user_chat_mode='' 는 기본값 open 으로 접혀야 한다");
  });

  it("off 는 참여자로 등록된 운영자의 발화까지 막는다", async () => {
    const { room } = await seedMission({ user_chat_mode: 'off' }, { open_join: false });
    await addParticipant(room.id, ADMIN);

    await assert.rejects(
      () => sendAsUser(room.id, ADMIN),
      (e) => e.status === 403 && /chat is turned off/i.test(e.message),
      'off 는 참여자 여부와 무관하게 사람의 발화를 닫아야 한다 — 참여자만 막으면 옵션이 아니라 참여자 게이트의 별칭일 뿐이다',
    );
  });

  it("off 여도 읽기는 그대로 열려 있다", async () => {
    const { room } = await seedMission({ user_chat_mode: 'off' }, { open_join: false });
    // 엔진이 남긴 기록이 있다고 가정하고 관전으로 읽는다.
    const rows = await messaging.getMessages(room.id, ADMIN, 50, undefined, { observer: true, workspaceId: WS });
    assert.ok(Array.isArray(rows), 'off 는 읽기 전용(관전)만 허용하는 모드다 — 읽기까지 막으면 요구를 넘어선다');
  });

  it("participants_only 는 참여자만 통과시킨다", async () => {
    const { room } = await seedMission({ user_chat_mode: 'participants_only' }, { open_join: false });

    await assert.rejects(
      () => sendAsUser(room.id, ADMIN),
      (e) => e.status === 403 && /not an active participant/i.test(e.message),
      '참여자가 아니면 자유 참여 완화가 걸리지 않아야 한다',
    );

    await addParticipant(room.id, ADMIN);
    const msg = await sendAsUser(room.id, ADMIN);
    assert.ok(msg?.id, '참여자로 등록되면 발화할 수 있어야 한다');
  });

  it("종료된 미션의 대화는 읽기 전용이다", async () => {
    const { room } = await seedMission({ status: 'completed' }, { open_join: true });
    await addParticipant(room.id, ADMIN);

    await assert.rejects(
      () => sendAsUser(room.id, ADMIN),
      (e) => e.status === 403 && /finished/i.test(e.message),
      'joinMissionConversation 이 이미 종료 미션 참여를 거부하고 화면도 입력창을 감춘다 — 발화 경로만 열려 있으면 REST 로 규칙이 샌다',
    );
  });

  it("권한 부족과 참여자 아님은 서로 다른 사유로 구분된다 (요구사항 C)", async () => {
    const { room } = await seedMission({}, { open_join: true });

    // 자유 참여가 열려 있어 "참여자인가"는 이미 통과한다. 그래도 막히는 이유는 권한이다.
    const permissionError = await sendAsUser(room.id, PLAIN).catch((e) => e);
    assert.equal(permissionError.status, 403);
    assert.match(
      permissionError.message,
      /not allowed to speak/i,
      '권한 부족은 권한 부족이라고 말해야 한다 — 화면이 이것을 "참여자가 아님"으로 뭉뚱그린 것이 이 티켓의 요구사항 C 다',
    );
    assert.doesNotMatch(
      permissionError.message,
      /not an active participant/i,
      '참여자 사유와 문구가 겹치면 화면이 둘을 구분할 근거가 사라진다',
    );

    // 같은 방에서 참여자 사유는 별도로 존재한다 — 두 메시지가 실제로 다름을 확인한다.
    const { room: closedRoom } = await seedMission(
      { user_chat_mode: 'participants_only' }, { open_join: false },
    );
    const participantError = await sendAsUser(closedRoom.id, ADMIN).catch((e) => e);
    assert.match(participantError.message, /not an active participant/i);
    assert.notEqual(permissionError.message, participantError.message);
  });

  it("옵션 변경이 실행 중인 미션 방에 즉시 반영된다", async () => {
    const { mission, room } = await seedMission({}, { open_join: true });
    assert.ok(await sendAsUser(room.id, ADMIN), '먼저 열려 있어야 한다');

    // 서비스 경로로 끈다 — running 미션이므로 draft 잠금(touchesBrief)에 걸리면 여기서 409 다.
    await missionService.updateMission(mission.id, WS, { user_chat_mode: 'off' });

    await assert.rejects(
      () => sendAsUser(room.id, ADMIN),
      (e) => e.status === 403 && /chat is turned off/i.test(e.message),
      '옵션을 끄면 재시작 없이 곧바로 막혀야 한다',
    );
    const offRoom = await dataSource.getRepository(ChatRoom).findOne({ where: { id: room.id } });
    assert.equal(offRoom.open_join, false, '방 플래그도 옵션을 따라 꺼져야 한다');

    // 다시 켜면 즉시 발화 가능해진다.
    await missionService.updateMission(mission.id, WS, { user_chat_mode: 'open' });
    assert.ok(await sendAsUser(room.id, ADMIN), '다시 켜면 곧바로 발화할 수 있어야 한다');
    const onRoom = await dataSource.getRepository(ChatRoom).findOne({ where: { id: room.id } });
    assert.equal(onRoom.open_join, true, '방 플래그가 옵션과 다시 일치해야 한다');
  });

  it("옵션은 running 미션에서도 편집 가능하다 — 브리핑 계약이 아니다", async () => {
    const { mission } = await seedMission({}, { open_join: true });
    // 같은 running 미션에서 브리핑 필드는 여전히 잠겨 있어야 한다. 이 대비가 없으면
    // "user_chat_mode 만 잠금에서 뺐다"가 아니라 "잠금 자체가 풀렸다"여도 통과한다.
    await assert.rejects(
      () => missionService.updateMission(mission.id, WS, { objective: 'something else' }),
      (e) => e.status === 409,
      '브리핑 필드의 draft 잠금은 그대로여야 한다',
    );
    const updated = await missionService.updateMission(mission.id, WS, { user_chat_mode: 'participants_only' });
    assert.equal(updated.user_chat_mode, 'participants_only');
  });

  it("에이전트와 엔진의 발화는 off 여도 막지 않는다", async () => {
    const { room } = await seedMission({ user_chat_mode: 'off' }, { open_join: false });
    await addParticipant(room.id, AGENT, 'agent');

    // 사람의 발화만 닫는 옵션이다. 여기서 에이전트/엔진까지 막으면 옵션을 끈 순간
    // orchestrator 브리핑과 wake 발화가 죽어 미션 자체가 멈춘다.
    const byAgent = await messaging.sendMessage(room.id, WS, 'agent', AGENT, 'Orchestrator', 'plan ready');
    assert.ok(byAgent?.id, '에이전트 발화는 이 옵션의 대상이 아니다');

    await addParticipant(room.id, 'system');
    const bySystem = await messaging.sendMessage(room.id, WS, 'user', 'system', 'System', 'mission briefing');
    assert.ok(bySystem?.id, '의사 user system(엔진 자신)의 발화도 막히면 안 된다');
  });

  it("step 방의 계약은 이 옵션이 바꾸지 않는다", async () => {
    // step 방에도 orchestration_mission_id 는 찍힌다. 그것만 보고 정책을 적용하면
    // 이 티켓이 들여다본 적 없는 에이전트 작업 채널의 동작까지 바뀐다.
    const { mission } = await seedMission({ user_chat_mode: 'off' }, { open_join: false });
    const roomRepo = dataSource.getRepository(ChatRoom);
    const stepRoom = await roomRepo.save(roomRepo.create({
      workspace_id: WS,
      type: 'group',
      name: 'Step: build',
      last_message_at: null,
      orchestration_mission_id: mission.id,
      orchestration_step_id: 'step-1',
    }));
    await addParticipant(stepRoom.id, ADMIN);

    const policy = await membership.resolveMissionChatPolicy(stepRoom);
    assert.equal(policy, null, 'step 방은 미션 chat 옵션의 대상이 아니다');

    const msg = await sendAsUser(stepRoom.id, ADMIN);
    assert.ok(msg?.id, 'off 가 step 방의 기존 계약(참여자 + MANAGE_ACTIONS)까지 바꾸면 안 된다');
  });
});

describe('백필 마이그레이션', () => {
  it("기존 방의 open_join 을 켜고 미션 소유자를 참여자로 등록한다", async () => {
    // 이 기능 이전에 시작된 미션의 실제 모습: 방은 닫혀 있고 사람 참여자 행이 없다.
    const { room } = await seedMission({ user_chat_mode: '' }, { open_join: false });
    assert.equal((await allParticipantRows(room.id, ADMIN)).length, 0, '사전 조건: 참여자 행이 없다');

    await runBackfill();

    const healed = await dataSource.getRepository(ChatRoom).findOne({ where: { id: room.id } });
    assert.equal(healed.open_join, true, '기본 모드로 접히는 기존 미션 방은 열려야 한다');
    assert.equal((await allParticipantRows(room.id, ADMIN)).length, 1, '미션 소유자가 참여자로 등록돼야 한다');
  });

  it("재실행해도 중복 참여자 행이 생기지 않는다", async () => {
    const { room } = await seedMission({ user_chat_mode: '' }, { open_join: false });

    await runBackfill();
    await runBackfill();
    await runBackfill();

    const rows = await allParticipantRows(room.id, ADMIN);
    assert.equal(rows.length, 1, '멱등하지 않으면 실행 횟수만큼 참여자 행이 쌓인다');
  });

  it("방을 나간 사람을 다시 끌어들이지 않는다", async () => {
    const { room } = await seedMission({ user_chat_mode: '' }, { open_join: false });
    const partRepo = dataSource.getRepository(ChatRoomParticipant);
    const row = await addParticipant(room.id, ADMIN);
    await partRepo.update(row.id, { left_at: new Date() });

    await runBackfill();

    const rows = await allParticipantRows(room.id, ADMIN);
    assert.equal(rows.length, 1, '탈퇴 행이 있으면 새 행을 만들지 않아야 한다');
    assert.ok(rows[0].left_at, '탈퇴 상태가 그대로 유지돼야 한다 — 활성 여부만 보면 나간 사람을 매 실행마다 되돌린다');
  });

  it("off 로 지정된 미션의 방은 열지 않는다", async () => {
    const { room } = await seedMission({ user_chat_mode: 'off' }, { open_join: false });
    await runBackfill();
    const after = await dataSource.getRepository(ChatRoom).findOne({ where: { id: room.id } });
    assert.equal(after.open_join, false, '백필은 옵션을 덮어쓰는 것이 아니라 옵션에 맞추는 것이다');
  });

  it("step 방은 건드리지 않는다", async () => {
    const { mission } = await seedMission({ user_chat_mode: '' }, { open_join: false });
    const roomRepo = dataSource.getRepository(ChatRoom);
    const stepRoom = await roomRepo.save(roomRepo.create({
      workspace_id: WS,
      type: 'group',
      name: 'Step: build',
      last_message_at: null,
      orchestration_mission_id: mission.id,
      orchestration_step_id: 'step-1',
      open_join: false,
    }));

    await runBackfill();

    const after = await roomRepo.findOne({ where: { id: stepRoom.id } });
    assert.equal(after.open_join, false, 'step 방의 자유 참여를 켜지 않는다는 기존 정책이 유지돼야 한다');
  });

  it("에이전트가 만든 미션에는 참여자를 만들지 않는다", async () => {
    const { room } = await seedMission(
      { user_chat_mode: '', created_by_type: 'agent', created_by: AGENT },
      { open_join: false },
    );

    await runBackfill();

    const healed = await dataSource.getRepository(ChatRoom).findOne({ where: { id: room.id } });
    assert.equal(healed.open_join, true, '방 정렬은 소유자 유무와 무관하다');
    assert.equal(
      (await allParticipantRows(room.id, AGENT)).length,
      0,
      'MCP 로 만든 미션에는 사람 소유자가 없다 — missionHumanOwner 와 같은 규칙이어야 한다',
    );
  });

  it("전수 조사 수치를 한 줄로 낸다 — 0건이어도 낸다", async () => {
    // 이 줄이 요구사항 B 의 "전수 조사" 산출물이다. 워크스페이스 전체 미션을 열어 주는
    // 표면이 에이전트 쪽에 없어(팀 스코프 도구뿐) 조사를 백필과 같은 순회에 얹었으므로,
    // 그 줄이 실제로 나오고 수치가 맞는지가 곧 요구사항의 검증이다.
    const empty = await runBackfill();
    assert.match(empty, /missions=0 /, '미션이 없어도 조사 결과(0건)는 나와야 한다');

    // running(open, 소유자 있음) · terminal(off) · draft(방 없음) 세 종류를 섞는다.
    await seedMission({ user_chat_mode: '' }, { open_join: false });
    await seedMission({ user_chat_mode: 'off', status: 'completed' }, { open_join: true });
    const missionRepo = dataSource.getRepository(OrchestrationMission);
    await missionRepo.save(missionRepo.create({
      workspace_id: WS, team_id: 'team-1', title: 'draft', objective: 'x',
      status: 'draft', created_by_type: 'user', created_by: ADMIN,
    }));

    const line = await runBackfill();
    assert.match(line, /missions=3 /, '미션 총수');
    assert.match(line, /started=2 /, 'draft(방 없음)는 시작된 것으로 세지 않는다');
    assert.match(line, /terminal=1 /, '종료 미션 수');
    assert.match(line, /mode\(open=2 participants_only=0 off=1\)/, '정규화된 모드 분포');
    // 1 이지 2 가 아니다: 세 번째 미션은 엔티티를 통해 만들어져 TypeORM 이 컬럼 default
    // 'open' 을 채운다. ''/NULL 로 남는 것은 **컬럼이 없던 시절에 만들어진 행**뿐이고,
    // 그 구분이 곧 "백필 대상"의 정의다.
    assert.match(line, /legacy_unset_mode=1 /, "''/NULL 로 남은 기존 행 수 — 백필 대상의 근거다");
    assert.match(line, /open_join_aligned=2 /, '실제로 정렬된 방 수(하나는 켜고 하나는 끈다)');
    assert.match(line, /owners_registered=2$/, '실제로 등록된 소유자 수');
  });
});
