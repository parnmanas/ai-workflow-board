// DM → group 승격과 초대 멱등성의 동작 테스트 — 티켓 70e62a9d.
//
// 실제 sql.js DataSource 위에서 진짜 쿼리를 돌린다(chat-open-join.test.mjs 와 같은
// 방식). 이 기능의 핵심이 **한 트랜잭션 안의 상태 전이**(중복 걸러내기 → cap →
// insert → 조건부 type UPDATE → 자동 이름)라 스텁으로는 아무것도 검증되지 않는다 —
// 승격을 통째로 빼거나 중복 검사를 지워도 스텁 기반 테스트는 그대로 통과한다.
// 스텁은 logService 하나뿐이고, 그것도 승격 로그를 **실제로 남기는지** 보려고 값을
// 모으는 용도다.
//
// 실행: node --test --test-force-exit apps/server/test/chat-dm-promotion.test.mjs
//   (dist/ 를 import 하므로 `npm run build -w server` 가 선행되어야 한다)

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { ChatRoom } from '../dist/entities/ChatRoom.js';
import { ChatRoomParticipant } from '../dist/entities/ChatRoomParticipant.js';
import { ChatRoomMessage } from '../dist/entities/ChatRoomMessage.js';
import { User } from '../dist/entities/User.js';
import { Agent } from '../dist/entities/Agent.js';
import { OrchestrationMission } from '../dist/entities/OrchestrationMission.js';
import { RoomMembershipService } from '../dist/modules/chat-rooms/room-membership.service.js';
import { RoomCrudService } from '../dist/modules/chat-rooms/room-crud.service.js';
import { RoomMessagingService } from '../dist/modules/chat-rooms/room-messaging.service.js';
import { serializeSqljsTransactions } from '../dist/db.js';
import { activityEvents } from '../dist/services/activity.service.js';

const WS = '11111111-1111-4111-8111-111111111111';
const ALICE = '33333333-3333-4333-8333-333333333333';
const BOB = '44444444-4444-4444-8444-444444444444';
const CAROL = '66666666-6666-4666-8666-666666666666';
const OUTSIDER = '77777777-7777-4777-8777-777777777777';
const BOT = '55555555-5555-4555-8555-555555555555';
const HELPER = '88888888-8888-4888-8888-888888888888';
const MANAGER = '99999999-9999-4999-8999-999999999999';

let dataSource;
let membership;
let crud;
let messaging;
/** 승격 로그를 모으는 자리 — 되돌릴 수 없는 전이의 관측 수단이 실제로 남는지 본다. */
let logLines;

/** 방을 만들고 주어진 참여자들을 active 로 넣는다. */
async function seedRoom(overrides = {}, participants = []) {
  const roomRepo = dataSource.getRepository(ChatRoom);
  const partRepo = dataSource.getRepository(ChatRoomParticipant);
  const room = await roomRepo.save(roomRepo.create({
    workspace_id: WS,
    type: 'dm',
    name: '',
    last_message_at: null,
    ...overrides,
  }));
  for (const p of participants) {
    await partRepo.save(partRepo.create({
      room_id: room.id,
      participant_type: p.type,
      participant_id: p.id,
      last_read_at: null,
      left_at: null,
    }));
  }
  return room;
}

/** 방에 메시지 한 건을 남긴다(승격이 이력을 보존하는지 확인용). */
async function seedMessage(roomId, content = 'hello') {
  const msgRepo = dataSource.getRepository(ChatRoomMessage);
  const saved = await msgRepo.save(msgRepo.create({
    room_id: roomId,
    workspace_id: WS,
    sender_type: 'user',
    sender_id: ALICE,
    type: 'message',
    content,
    images: '[]',
    metadata: null,
  }));
  await dataSource.getRepository(ChatRoom).update(roomId, { last_message_at: new Date() });
  return saved;
}

const roomOf = (id) => dataSource.getRepository(ChatRoom).findOne({ where: { id } });

/** 방의 active 참여자 행들 (participantId 를 주면 그 대상만). */
function activeRows(roomId, participantId) {
  const where = { room_id: roomId, left_at: null };
  if (participantId) where.participant_id = participantId;
  return dataSource.getRepository(ChatRoomParticipant).find({ where });
}

/**
 * `chat_room_update` 이벤트를 모으는 리스너. 전역 emitter 라 테스트가 끝나면 반드시
 * `stop()` 으로 떼야 다음 테스트를 오염시키지 않는다.
 */
function captureRoomUpdates() {
  const seen = [];
  const listener = (e) => seen.push(e);
  activityEvents.on('chat_room_update', listener);
  seen.stop = () => activityEvents.off('chat_room_update', listener);
  return seen;
}

const invite = (roomId, callerId, participants, callerType = 'user') =>
  membership.addParticipants(roomId, { type: callerType, id: callerId }, participants);

const asUser = (id) => ({ participant_type: 'user', participant_id: id });
const asAgent = (id) => ({ participant_type: 'agent', participant_id: id });

describe('DM 초대 → group 승격 (티켓 70e62a9d)', () => {
  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Agent, OrchestrationMission],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    // 초대는 dataSource.manager.transaction() 을 연다. raw sql.js DataSource 에는
    // 진짜 커넥션 풀이 없어 겹치는 호출이 같은 커넥션을 공유하므로, AppDataSource /
    // DatabaseModule 이 생성 시점에 거는 직렬화 큐를 여기서도 명시적으로 건다
    // (ci-wait-resume.test.mjs 와 같은 이유).
    serializeSqljsTransactions(dataSource);

    logLines = [];
    const capturingLog = {
      info: (category, message) => logLines.push(`${category}: ${message}`),
      warn() {}, error() {}, debug() {},
    };

    const roomRepo = dataSource.getRepository(ChatRoom);
    const partRepo = dataSource.getRepository(ChatRoomParticipant);
    const msgRepo = dataSource.getRepository(ChatRoomMessage);
    const userRepo = dataSource.getRepository(User);
    const agentRepo = dataSource.getRepository(Agent);

    membership = new RoomMembershipService(
      roomRepo, partRepo, userRepo, agentRepo, dataSource,
      dataSource.getRepository(OrchestrationMission),
      capturingLog,
    );
    crud = new RoomCrudService(roomRepo, partRepo, msgRepo, userRepo, agentRepo, capturingLog, membership);

    // 요구사항 7(초대된 뒤 실제로 대화가 되는가)은 참여자 행만 봐서는 검증되지 않는다 —
    // 발화 게이트가 그 행을 실제로 통과시키는지 봐야 한다. 그래서 진짜 메시지 경로를
    // 구성한다. 이 스위트가 쓰지 않는 의존성(티켓/멘션/첨부)만 빈 객체로 둔다.
    const empty = {};
    messaging = new RoomMessagingService(
      roomRepo,          // roomRepo
      partRepo,          // participantRepo
      msgRepo,           // messageRepo
      agentRepo,         // agentRepo
      empty,             // ticketRepo
      empty,             // userMentionRepo
      empty,             // attachmentRepo
      // 성공 경로는 커밋 뒤 chat_workspace_folder_enabled 를 읽는다 — "설정 없음"으로 답한다.
      { async findOne() { return null; } }, // workspaceRepo
      dataSource,        // dataSource
      capturingLog,      // logService
      membership,        // membership
      // 본문에 @멘션이 없으므로 "찾은 것 없음"으로 답해 그 뒤 경로를 그대로 지나가게 한다.
      { parseMentions: () => [], async resolveMentions() { return []; } }, // mentionService
      empty,             // connectivity
    );

    // 이름 해석(자동 방 이름 / dm_partner_name)이 실제 행을 읽도록 시드한다.
    await userRepo.save([
      userRepo.create({ id: ALICE, name: 'Alice', email: 'alice@example.com' }),
      userRepo.create({ id: BOB, name: 'Bob', email: 'bob@example.com' }),
      userRepo.create({ id: CAROL, name: 'Carol', email: 'carol@example.com' }),
      userRepo.create({ id: OUTSIDER, name: 'Outsider', email: 'out@example.com' }),
    ]);
    await agentRepo.save([
      agentRepo.create({ id: BOT, name: 'Bot', type: 'claude' }),
      agentRepo.create({ id: HELPER, name: 'Helper', type: 'claude' }),
      // Agent Manager 는 chat 참가자가 될 수 없다 (티켓 941c72d3).
      agentRepo.create({ id: MANAGER, name: 'Mgr', type: 'manager' }),
    ]);
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    logLines.length = 0;
    await dataSource.getRepository(ChatRoomParticipant).clear();
    await dataSource.getRepository(ChatRoomMessage).clear();
    await dataSource.getRepository(ChatRoom).clear();
  });

  // ── 승격 ────────────────────────────────────────────────────────────────

  it('DM 에 사람을 초대하면 같은 room id 가 group 이 되고 이력이 그대로 남는다', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);
    const msg = await seedMessage(room.id, '승격 전에 남긴 말');

    await invite(room.id, ALICE, [asUser(BOB)]);

    const after = await roomOf(room.id);
    assert.equal(after.id, room.id, '새 방을 만들지 않고 같은 room id 를 유지해야 한다');
    assert.equal(after.type, 'group', 'DM 이 group 으로 승격되어야 한다');

    const rows = await activeRows(room.id);
    assert.equal(rows.length, 3, '기존 2인 + 초대 1인');

    const messages = await dataSource.getRepository(ChatRoomMessage).find({ where: { room_id: room.id } });
    assert.equal(messages.length, 1, '승격이 메시지를 잃어버리면 안 된다');
    assert.equal(messages[0].id, msg.id, '같은 메시지 행이 그대로 남아야 한다');

    assert.ok(
      logLines.some((l) => l.includes('promoted dm→group')),
      `되돌릴 수 없는 전이는 로그로 추적할 수 있어야 한다. 남은 로그: ${JSON.stringify(logLines)}`,
    );
  });

  it('이름 없던 DM 은 승격 시 group 자동 이름을 받는다 (Unnamed Group 방지)', async () => {
    const room = await seedRoom({ name: '' }, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    await invite(room.id, ALICE, [asUser(BOB)]);

    const after = await roomOf(room.id);
    // 이름 없는 DM 은 상대 이름(dm_partner_name)으로 표시돼 왔다. group 이 되면 그
    // 폴백이 사라지므로 createRoom 과 같은 규칙으로 승격 후 참여자 집합을 채운다.
    assert.equal(after.name, 'Alice, Bot, Bob');
  });

  it('이름이 있던 DM 은 승격 후에도 그 이름을 유지한다', async () => {
    const room = await seedRoom({ name: 'Roadmap' }, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    await invite(room.id, ALICE, [asUser(BOB)]);

    const after = await roomOf(room.id);
    assert.equal(after.type, 'group');
    assert.equal(after.name, 'Roadmap', '사용자가 붙여 둔 이름을 자동 이름이 덮어쓰면 안 된다');
  });

  it('DM 에 에이전트를 초대할 수도 있다 (유저·에이전트 모두 초대 대상)', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    await invite(room.id, ALICE, [asAgent(HELPER)]);

    const after = await roomOf(room.id);
    assert.equal(after.type, 'group');
    const rows = await activeRows(room.id, HELPER);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].participant_type, 'agent');
  });

  it('이미 group 인 방의 초대는 승격 없이 예전 그대로 동작한다', async () => {
    const room = await seedRoom(
      { type: 'group', name: 'Team' },
      [{ type: 'user', id: ALICE }, { type: 'user', id: BOB }, { type: 'agent', id: BOT }],
    );

    await invite(room.id, ALICE, [asUser(CAROL)]);

    const after = await roomOf(room.id);
    assert.equal(after.type, 'group');
    assert.equal(after.name, 'Team', 'group 방의 이름을 건드리면 안 된다');
    assert.equal((await activeRows(room.id)).length, 4);
    assert.equal(
      logLines.filter((l) => l.includes('promoted dm→group')).length,
      0,
      'group 방에서는 승격 로그가 나오면 안 된다',
    );
  });

  // ── 권한·상한 ───────────────────────────────────────────────────────────

  it('방의 참여자가 아니면 초대할 수 없다 (403)', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    await assert.rejects(
      () => invite(room.id, OUTSIDER, [asUser(BOB)]),
      (err) => err.status === 403 && /not an active participant/i.test(err.message),
    );

    const after = await roomOf(room.id);
    assert.equal(after.type, 'dm', '거부된 호출이 방을 승격시키면 안 된다');
    assert.equal((await activeRows(room.id)).length, 2);
  });

  it('50인 상한을 넘기는 초대는 400 이고 아무도 추가되지 않는다', async () => {
    const many = [{ type: 'user', id: ALICE }];
    for (let i = 1; i < 49; i++) {
      many.push({ type: 'user', id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}` });
    }
    const room = await seedRoom({ type: 'group', name: 'Big' }, many);
    assert.equal((await activeRows(room.id)).length, 49, '사전 조건: 49명');

    await assert.rejects(
      () => invite(room.id, ALICE, [asUser(BOB), asUser(CAROL)]),
      (err) => err.status === 400 && /50 participant limit/.test(err.message),
    );
    assert.equal((await activeRows(room.id)).length, 49, '상한 초과는 부분 추가도 남기지 않는다');
  });

  it('cap 은 실제 신규만 센다 — 49인 방에 중복 1 + 신규 1 은 통과한다', async () => {
    const many = [{ type: 'user', id: ALICE }];
    for (let i = 1; i < 49; i++) {
      many.push({ type: 'user', id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}` });
    }
    const room = await seedRoom({ type: 'group', name: 'Big' }, many);

    // ALICE 는 이미 방에 있다 — 예전처럼 요청 개수로 cap 을 세면 49+2 > 50 이라 400 이었다.
    await invite(room.id, ALICE, [asUser(ALICE), asUser(BOB)]);

    assert.equal((await activeRows(room.id)).length, 50);
    assert.equal((await activeRows(room.id, ALICE)).length, 1, '중복 초대가 두 번째 행을 만들면 안 된다');
  });

  // ── 멱등성 ──────────────────────────────────────────────────────────────

  it('같은 대상을 두 번 초대해도 active 행은 하나고 두 번째는 이벤트를 내지 않는다', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    await invite(room.id, ALICE, [asUser(BOB)]);

    const events = captureRoomUpdates();
    try {
      await invite(room.id, ALICE, [asUser(BOB)]);

      assert.equal((await activeRows(room.id, BOB)).length, 1, '중복 active 행은 방을 나갈 수 없게 만든다');
      assert.equal((await activeRows(room.id)).length, 3);
      assert.equal(
        events.length,
        0,
        '새로 들어온 사람이 없으면 알릴 변화도 없다 — 빈 이벤트는 모든 클라이언트의 목록 재조회만 유발한다',
      );
    } finally {
      events.stop();
    }
  });

  it('한 요청 안의 중복 지정도 한 번만 추가된다', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    await invite(room.id, ALICE, [asUser(BOB), asUser(BOB)]);

    assert.equal((await activeRows(room.id, BOB)).length, 1);
  });

  it('Agent Manager 만 초대하면 조용히 걸러지고 승격도 일어나지 않는다', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    const events = captureRoomUpdates();
    try {
      await invite(room.id, ALICE, [asAgent(MANAGER)]);
    } finally {
      events.stop();
    }

    assert.equal((await activeRows(room.id, MANAGER)).length, 0, 'manager 는 chat 참가자가 될 수 없다');
    const after = await roomOf(room.id);
    assert.equal(after.type, 'dm', '실제로 추가된 사람이 없으면 승격도 없다');
    assert.equal(events.length, 0);
  });

  it('manager 와 일반 대상을 함께 초대하면 일반 대상만 들어간다', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    await invite(room.id, ALICE, [asAgent(MANAGER), asAgent(HELPER)]);

    assert.equal((await activeRows(room.id, MANAGER)).length, 0);
    assert.equal((await activeRows(room.id, HELPER)).length, 1);
    assert.equal((await roomOf(room.id)).type, 'group');
  });

  it('겹쳐 들어온 두 초대가 중복 active 행을 만들지 않는다', async () => {
    // 주의: sql.js 는 단일 WASM 인스턴스라 이 두 호출은 직렬화 큐를 통해 순차 실행된다
    // — 여기서 검증하는 것은 "겹친 호출이 에러·중복 없이 끝난다"이지 Postgres 의 진짜
    //   병렬 트랜잭션 격리가 아니다. 그쪽은 advisory lock 으로 지키며 별도 검증 대상이다.
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    const events = captureRoomUpdates();
    try {
      await Promise.all([
        invite(room.id, ALICE, [asUser(BOB)]),
        invite(room.id, ALICE, [asUser(BOB)]),
      ]);

      assert.equal((await activeRows(room.id, BOB)).length, 1);
      assert.equal(events.length, 1, '실제로 추가한 쪽만 이벤트를 낸다');
    } finally {
      events.stop();
    }
    assert.equal(
      logLines.filter((l) => l.includes('promoted dm→group')).length,
      1,
      '조건부 UPDATE 라 두 번째 승격은 affected=0 으로 조용히 지나가야 한다',
    );
  });

  // ── 시스템 소유 방 ──────────────────────────────────────────────────────

  it('시스템이 소유한 DM 은 승격을 거부한다 (400)', async () => {
    for (const marker of [
      { run_kind: 'qa' },
      { action_id: 'aaaaaaaa-1111-4111-8111-111111111111' },
      { orchestration_mission_id: 'aaaaaaaa-2222-4222-8222-222222222222' },
      { orchestration_step_id: 'aaaaaaaa-3333-4333-8333-333333333333' },
    ]) {
      const room = await seedRoom(marker, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);
      await assert.rejects(
        () => invite(room.id, ALICE, [asUser(BOB)]),
        (err) => err.status === 400 && /system-managed/.test(err.message),
        `${JSON.stringify(marker)} 방이 승격을 허용했다`,
      );
      assert.equal((await roomOf(room.id)).type, 'dm');
    }
  });

  it('이미 group 인 시스템 방의 참여자 추가는 오늘 동작 그대로 성공한다', async () => {
    // mission 방에 사람을 넣는 기존 흐름(티켓 f6a0de0e)이 여기 걸리면 안 된다.
    const room = await seedRoom(
      { type: 'group', name: 'Mission', orchestration_mission_id: 'aaaaaaaa-2222-4222-8222-222222222222' },
      [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }, { type: 'agent', id: HELPER }],
    );

    await invite(room.id, ALICE, [asUser(BOB)]);

    assert.equal((await activeRows(room.id, BOB)).length, 1);
  });

  // ── SSE 수신자 스코프 ───────────────────────────────────────────────────

  it('participant_added 가 초대받은 유저·에이전트를 실제 수신자로 싣는다', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    const events = captureRoomUpdates();
    let event;
    try {
      await invite(room.id, ALICE, [asUser(BOB), asAgent(HELPER)]);
      assert.equal(events.length, 1);
      event = events[0];
    } finally {
      events.stop();
    }

    assert.equal(event.room_id, room.id);
    assert.equal(event.update_type, 'participant_added');
    assert.deepEqual([...event.participant_ids].sort(), [BOB, HELPER].sort());

    // roomMemberFilter 가 이 두 집합으로 수신 대상을 고른다 — 초대받은 본인이 빠지면
    // 새로고침 전까지 자기가 초대된 사실을 모른다.
    assert.ok(event.member_ids.has(BOB), '초대된 유저가 수신자에 없다');
    assert.ok(event.member_ids.has(ALICE), '기존 참여자도 계속 수신자다');
    assert.ok(event.agent_member_ids.has(HELPER), '초대된 에이전트가 수신자에 없다');
    assert.ok(event.agent_member_ids.has(BOT));
    assert.ok(!event.member_ids.has(OUTSIDER), '비참여자에게 새면 안 된다');
  });

  // ── 초대받은 쪽이 보는 것 ────────────────────────────────────────────────

  it('초대된 유저의 방 목록에 방이 뜨고 이전 히스토리가 미읽음으로 쏟아지지 않는다', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);
    await seedMessage(room.id, '초대 전에 오간 말');
    await seedMessage(room.id, '한 번 더');

    await invite(room.id, ALICE, [asUser(BOB)]);

    const rooms = await crud.listRooms(WS, BOB);
    const listed = rooms.find((r) => r.id === room.id);
    assert.ok(listed, '초대된 유저의 방 목록에 방이 나타나야 한다');
    assert.equal(listed.type, 'group');
    assert.equal(listed.unread_count, 0, 'last_read_at = now 정책이 유지되어야 한다');
    assert.equal(listed.is_participant, true);
  });

  // ── 초대 후 실제로 대화가 되는가 (요구사항 7) ────────────────────────────

  it('승격된 방에서 초대된 에이전트가 실제로 발화할 수 있다', async () => {
    // 참여자 행이 생겼다는 것만으로는 부족하다 — 발화 게이트가 그 행을 실제로
    // 통과시키는지 봐야 한다. 과거 회귀(티켓 f6a0de0e)가 정확히 이 지점이었다:
    // mission 방에 사람 참여자가 등록되지 않아 발화가 403 으로 막혔다.
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    await invite(room.id, ALICE, [asAgent(HELPER)]);

    const msg = await messaging.sendMessage(room.id, WS, 'agent', HELPER, 'Helper', '초대 고맙습니다');
    assert.ok(msg?.id, '초대된 에이전트의 발화가 저장되지 않았다');

    const stored = await dataSource.getRepository(ChatRoomMessage).find({ where: { room_id: room.id } });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].sender_id, HELPER);
  });

  it('승격된 방에서 초대된 유저도 발화할 수 있다', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    await invite(room.id, ALICE, [asUser(BOB)]);

    const msg = await messaging.sendMessage(room.id, WS, 'user', BOB, 'Bob', '안녕하세요');
    assert.ok(msg?.id);
  });

  it('초대되지 않은 에이전트는 승격 뒤에도 여전히 거부된다 (경계 유지)', async () => {
    // 승격이 방을 아무에게나 열어 주는 것이 아니라는 확인. 자유 참여(open_join)
    // 완화는 유저 전용이므로 에이전트는 참여자 행을 계속 요구한다.
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }, { type: 'agent', id: BOT }]);

    await invite(room.id, ALICE, [asUser(BOB)]);

    await assert.rejects(
      () => messaging.sendMessage(room.id, WS, 'agent', HELPER, 'Helper', '난입'),
      (err) => err.status === 403,
    );
  });
});
