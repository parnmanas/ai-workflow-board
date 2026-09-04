// 자유 참여(open join) 옵션의 동작 테스트 — 티켓 995a9519.
//
// 실제 sql.js DataSource 위에서 진짜 쿼리를 돌린다. 이 기능의 핵심이 **쿼리 모양**
// (listRooms 의 LEFT JOIN + open_join 조건)과 **참여자 행의 실제 생성**(auto-join)이라
// 스텁으로는 둘 다 검증되지 않는다 — 조인을 INNER 로 되돌리거나 auto-join 을 빼도
// 스텁 기반 테스트는 그대로 통과한다.
//
// RoomMessagingService 만 부분 스텁이다: messageRepo.manager.transaction 이 sentinel 을
// 던진다. auto-join 은 그 트랜잭션 **직전**에 일어나므로, sentinel 로 거부된 뒤에도
// 참여자 행이 실제로 DB 에 있는지 확인할 수 있다. 나머지(roomRepo / participantRepo /
// membership)는 전부 실제 리포지토리다.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { ChatRoom } from '../dist/entities/ChatRoom.js';
import { ChatRoomParticipant } from '../dist/entities/ChatRoomParticipant.js';
import { ChatRoomMessage } from '../dist/entities/ChatRoomMessage.js';
import { User } from '../dist/entities/User.js';
import { Agent } from '../dist/entities/Agent.js';
import { RoomMembershipService } from '../dist/modules/chat-rooms/room-membership.service.js';
import { RoomCrudService } from '../dist/modules/chat-rooms/room-crud.service.js';
import { RoomMessagingService } from '../dist/modules/chat-rooms/room-messaging.service.js';
import { activityEvents } from '../dist/services/activity.service.js';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';

const REACHED_TX = 'REACHED_TRANSACTION_SENTINEL';
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

let dataSource;
let membership;
let crud;
let messaging;

/** 방을 만들고 주어진 참여자들을 active 로 넣는다. */
async function seedRoom(overrides = {}, participants = []) {
  const roomRepo = dataSource.getRepository(ChatRoom);
  const partRepo = dataSource.getRepository(ChatRoomParticipant);
  const room = await roomRepo.save(roomRepo.create({
    workspace_id: WS,
    type: 'group',
    name: 'room',
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

/** 방의 active 참여자 행들. */
function activeRows(roomId, participantId) {
  return dataSource.getRepository(ChatRoomParticipant).find({
    where: { room_id: roomId, participant_id: participantId, left_at: null },
  });
}

/** sendMessage 를 유저 발신으로 호출한다. */
const sendAsUser = (roomId, workspaceId, senderId) =>
  messaging.sendMessage(roomId, workspaceId, 'user', senderId, 'Sender', 'hello');

describe('chat 방 자유 참여(open_join)', () => {
  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Agent],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();

    const roomRepo = dataSource.getRepository(ChatRoom);
    const partRepo = dataSource.getRepository(ChatRoomParticipant);
    const msgRepo = dataSource.getRepository(ChatRoomMessage);
    const userRepo = dataSource.getRepository(User);
    const agentRepo = dataSource.getRepository(Agent);

    membership = new RoomMembershipService(roomRepo, partRepo, userRepo, agentRepo, dataSource);
    crud = new RoomCrudService(roomRepo, partRepo, msgRepo, userRepo, agentRepo, noopLog, membership);

    // messageRepo 만 스텁 — 트랜잭션에 도달했다는 것이 "게이트를 전부 통과했다"는 신호다.
    const stubMessageRepo = {
      manager: { async transaction() { throw new Error(REACHED_TX); } },
      createQueryBuilder: () => msgRepo.createQueryBuilder('m'),
    };
    const empty = {};
    messaging = new RoomMessagingService(
      roomRepo,          // roomRepo
      partRepo,          // participantRepo
      stubMessageRepo,   // messageRepo
      agentRepo,         // agentRepo
      empty,             // ticketRepo
      empty,             // userMentionRepo
      empty,             // attachmentRepo
      empty,             // workspaceRepo
      dataSource,        // dataSource
      noopLog,           // logService
      membership,        // membership
      empty,             // mentionService
      empty,             // connectivity
    );
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(ChatRoomParticipant).clear();
    await dataSource.getRepository(ChatRoomMessage).clear();
    await dataSource.getRepository(ChatRoom).clear();
  });

  // ── 발화 게이트 ─────────────────────────────────────────────────────────

  it('옵션 ON: 비참여자 유저의 발언이 허용되고 참여자로 auto-join 된다', async () => {
    const room = await seedRoom({ open_join: true }, [{ type: 'user', id: MEMBER }]);

    assert.equal((await activeRows(room.id, OUTSIDER)).length, 0, '사전 조건: 아직 참여자가 아니다');

    await assert.rejects(
      () => sendAsUser(room.id, WS, OUTSIDER),
      new RegExp(REACHED_TX),
      '참여자 403 게이트를 통과해 저장 단계까지 도달해야 한다',
    );

    const rows = await activeRows(room.id, OUTSIDER);
    assert.equal(rows.length, 1, '발언 시점에 참여자 행이 정확히 하나 생긴다');
    assert.equal(rows[0].participant_type, 'user');
    assert.equal(rows[0].left_at, null, 'active 행이어야 한다');
    // 재입장 경로와 같은 규약: 참여 전 이력이 미읽음으로 쏟아지지 않게 last_read_at 을 찍는다.
    assert.ok(rows[0].last_read_at instanceof Date, 'last_read_at 이 세팅된다');
    assert.ok(rows[0].joined_at instanceof Date, 'joined_at 이 세팅된다');
  });

  it('옵션 OFF: 비참여자 유저는 기존대로 403 이고 참여자 행도 생기지 않는다', async () => {
    const room = await seedRoom({ open_join: false }, [{ type: 'user', id: MEMBER }]);

    await assert.rejects(
      () => sendAsUser(room.id, WS, OUTSIDER),
      (e) => e.status === 403 && /Not an active participant/.test(e.message),
      '옵션이 꺼진 방의 403 은 그대로 유지된다',
    );
    assert.equal((await activeRows(room.id, OUTSIDER)).length, 0, '거부된 발언은 참여자 행을 만들지 않는다');
  });

  it('옵션 ON: 에이전트 발신자는 완화되지 않는다 (유저 전용)', async () => {
    const room = await seedRoom({ open_join: true }, [{ type: 'user', id: MEMBER }]);

    await assert.rejects(
      () => messaging.sendMessage(room.id, WS, 'agent', AGENT, 'Bot', 'hi'),
      (e) => e.status === 403,
      '에이전트는 열린 방에도 참여자 행 없이는 들어갈 수 없다',
    );
    assert.equal((await activeRows(room.id, AGENT)).length, 0);
  });

  it('옵션 ON: 다른 워크스페이스의 호출은 완화되지 않는다', async () => {
    const room = await seedRoom({ open_join: true }, [{ type: 'user', id: MEMBER }]);

    await assert.rejects(
      () => sendAsUser(room.id, OTHER_WS, OUTSIDER),
      (e) => e.status === 403,
      '"모든 유저"는 같은 워크스페이스 안의 유저를 뜻한다',
    );
    assert.equal((await activeRows(room.id, OUTSIDER)).length, 0);
  });

  it('옵션 ON: workspaceId 를 알 수 없으면 완화하지 않는다 (모르면 닫는다)', async () => {
    const room = await seedRoom({ open_join: true }, [{ type: 'user', id: MEMBER }]);

    await assert.rejects(
      () => sendAsUser(room.id, '', OUTSIDER),
      (e) => e.status === 403,
      '워크스페이스 경계를 확인할 수 없으면 완화하지 않는다',
    );
  });

  it('옵션 ON: 이미 참여 중인 유저가 다시 보내도 참여자 행이 늘지 않는다 (멱등)', async () => {
    const room = await seedRoom({ open_join: true }, [{ type: 'user', id: MEMBER }]);

    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => sendAsUser(room.id, WS, MEMBER), new RegExp(REACHED_TX));
    }
    assert.equal((await activeRows(room.id, MEMBER)).length, 1, 'auto-join 은 멱등이어야 한다');
  });

  it('옵션 ON: 의사 user "system" 은 완화 대상이 아니다 (uuid 아닌 참여자 행을 만들지 않는다)', async () => {
    // system 은 자기 방(QA·orchestration)에 이미 참여자로 seed 되므로 완화가 필요 없고,
    // 완화 경로로 흘리면 uuid 아닌 participant 행이 새로 생긴다.
    const room = await seedRoom({ open_join: true }, [{ type: 'user', id: MEMBER }]);

    await assert.rejects(
      () => sendAsUser(room.id, WS, 'system'),
      (e) => e.status === 403,
      'uuid 가 아닌 발신자는 완화되지 않는다',
    );
    assert.equal((await activeRows(room.id, 'system')).length, 0);
  });

  // ── 읽기 게이트 ─────────────────────────────────────────────────────────

  it('옵션 ON: 비참여자도 메시지를 읽을 수 있고, OFF 면 403 이다', async () => {
    const open = await seedRoom({ open_join: true }, [{ type: 'user', id: MEMBER }]);
    const closed = await seedRoom({ open_join: false }, [{ type: 'user', id: MEMBER }]);

    const rows = await messaging.getMessages(open.id, OUTSIDER, 50, undefined, { workspaceId: WS });
    assert.deepEqual(rows, [], '열린 방은 비참여자도 읽을 수 있다 (아직 메시지는 없다)');

    await assert.rejects(
      () => messaging.getMessages(closed.id, OUTSIDER, 50, undefined, { workspaceId: WS }),
      (e) => e.status === 403,
      '닫힌 방의 읽기 403 은 그대로다',
    );
    await assert.rejects(
      () => messaging.getMessages(open.id, OUTSIDER, 50, undefined, { workspaceId: OTHER_WS }),
      (e) => e.status === 403,
      '열린 방이어도 워크스페이스가 다르면 읽을 수 없다',
    );
  });

  // ── 목록 노출 ───────────────────────────────────────────────────────────

  it('옵션 ON 방은 비참여자의 목록에 실리고 unread 는 0 이다', async () => {
    const open = await seedRoom({ open_join: true, name: 'open-room' }, [{ type: 'user', id: MEMBER }]);
    // 방에 메시지를 넣어 둔다 — 비참여자에게 이 이력이 미읽음으로 세어지면 안 된다.
    const msgRepo = dataSource.getRepository(ChatRoomMessage);
    for (let i = 0; i < 3; i++) {
      await msgRepo.save(msgRepo.create({
        room_id: open.id, workspace_id: WS, sender_type: 'user', sender_id: MEMBER,
        content: `m${i}`, type: 'message',
      }));
    }

    const rooms = await crud.listRooms(WS, OUTSIDER);
    const row = rooms.find(r => r.id === open.id);
    assert.ok(row, '자유 참여 방은 참여자가 아니어도 목록에 실린다');
    assert.equal(row.open_join, true, '옵션 값이 응답에 실린다');
    assert.equal(row.is_participant, false, '아직 참여자가 아님이 응답에 드러난다');
    assert.equal(row.unread_count, 0, '참여 전 이력은 미읽음으로 세지 않는다');
  });

  it('옵션 OFF 방은 비참여자의 목록에 실리지 않는다 (회귀 없음)', async () => {
    const closed = await seedRoom({ open_join: false, name: 'closed-room' }, [{ type: 'user', id: MEMBER }]);

    const outsiderRooms = await crud.listRooms(WS, OUTSIDER);
    assert.equal(outsiderRooms.find(r => r.id === closed.id), undefined, '닫힌 방은 여전히 안 보인다');

    const memberRooms = await crud.listRooms(WS, MEMBER);
    const mine = memberRooms.find(r => r.id === closed.id);
    assert.ok(mine, '참여자에게는 그대로 보인다');
    assert.equal(mine.is_participant, true);
    assert.equal(mine.open_join, false);
  });

  it('다른 워크스페이스의 자유 참여 방은 목록에 실리지 않는다', async () => {
    const foreign = await seedRoom({ workspace_id: OTHER_WS, open_join: true }, []);
    const rooms = await crud.listRooms(WS, OUTSIDER);
    assert.equal(rooms.find(r => r.id === foreign.id), undefined, '워크스페이스 경계는 옵션이 뚫지 않는다');
  });

  it('mission / Action Run 방은 옵션이 켜져 있어도 일반 목록에서 제외된다', async () => {
    const mission = await seedRoom({ open_join: true, orchestration_mission_id: 'mission-1' }, []);
    const action = await seedRoom({ open_join: true, action_id: 'action-1' }, []);

    const rooms = await crud.listRooms(WS, OUTSIDER);
    assert.equal(rooms.find(r => r.id === mission.id), undefined, 'mission 방은 Mission 화면에서만 열린다');
    assert.equal(rooms.find(r => r.id === action.id), undefined, 'Action Run 방은 Actions 화면에서만 열린다');
  });

  it('getRoomDetail 이 open_join 과 참여 여부를 실어 보낸다', async () => {
    const room = await seedRoom({ open_join: true }, [{ type: 'user', id: MEMBER }]);

    const asOutsider = await crud.getRoomDetail(room.id, OUTSIDER);
    assert.equal(asOutsider.open_join, true);
    assert.equal(asOutsider.is_participant, false);

    const asMember = await crud.getRoomDetail(room.id, MEMBER);
    assert.equal(asMember.is_participant, true);
  });

  // ── 옵션 변경 ───────────────────────────────────────────────────────────

  it('참여자는 옵션을 켜고 끌 수 있고, 변경이 SSE 로 전파된다', async () => {
    const room = await seedRoom({ open_join: false }, [{ type: 'user', id: MEMBER }]);
    const seen = [];
    const listener = (e) => seen.push(e);
    activityEvents.on('chat_room_update', listener);
    try {
      const on = await crud.setOpenJoin(room.id, WS, MEMBER, true);
      assert.equal(on.open_join, true);
      assert.equal(
        (await dataSource.getRepository(ChatRoom).findOne({ where: { id: room.id } })).open_join,
        true,
        '값이 실제로 저장된다',
      );

      const changes = seen.filter(e => e.room_id === room.id && e.update_type === 'open_join_changed');
      assert.equal(changes.length, 1, '변경 한 번에 이벤트 한 건');
      assert.equal(changes[0].open_join, true, '새 값이 이벤트에 실린다');
      assert.ok(changes[0].member_ids instanceof Set, '방 구성원 대상으로 팬아웃된다');

      // 같은 값으로 다시 부르면 이벤트를 더 내보내지 않는다.
      await crud.setOpenJoin(room.id, WS, MEMBER, true);
      assert.equal(
        seen.filter(e => e.room_id === room.id && e.update_type === 'open_join_changed').length,
        1,
        '값이 그대로면 변경 이벤트를 내지 않는다',
      );

      const off = await crud.setOpenJoin(room.id, WS, MEMBER, false);
      assert.equal(off.open_join, false, '되돌릴 수 있다');
    } finally {
      activityEvents.off('chat_room_update', listener);
    }
  });

  it('비참여자는 옵션을 바꿀 수 없다', async () => {
    const room = await seedRoom({ open_join: false }, [{ type: 'user', id: MEMBER }]);
    await assert.rejects(
      () => crud.setOpenJoin(room.id, WS, OUTSIDER, true),
      (e) => e.status === 403,
      '방 설정 변경은 rename 과 같은 규약 — active participant 여야 한다',
    );
  });

  it('DM 에는 옵션을 켤 수 없다', async () => {
    const dm = await seedRoom({ type: 'dm', open_join: false }, [
      { type: 'user', id: MEMBER },
      { type: 'user', id: OUTSIDER },
    ]);
    await assert.rejects(
      () => crud.setOpenJoin(dm.id, WS, MEMBER, true),
      (e) => e.status === 400 && /direct message/i.test(e.message),
      'DM 의 정확히 2인 불변식을 깨뜨릴 수 없다',
    );
    assert.equal(
      (await dataSource.getRepository(ChatRoom).findOne({ where: { id: dm.id } })).open_join,
      false,
      '거부된 요청은 값을 바꾸지 않는다',
    );
  });

  it('시스템이 소유한 방(mission / Action Run / QA run)의 옵션은 바꿀 수 없다', async () => {
    const cases = [
      ['mission', { orchestration_mission_id: 'mission-1', open_join: true }],
      ['action', { action_id: 'action-1', open_join: true }],
      ['qa-run', { run_kind: 'qa', open_join: false }],
    ];
    for (const [label, overrides] of cases) {
      const room = await seedRoom(overrides, [{ type: 'user', id: MEMBER }]);
      await assert.rejects(
        () => crud.setOpenJoin(room.id, WS, MEMBER, !overrides.open_join),
        (e) => e.status === 400 && /managed by the system/i.test(e.message),
        `${label} 방의 open_join 은 서버가 정하는 정책 값이다`,
      );
    }
  });

  it('다른 워크스페이스의 방은 존재를 알려주지 않는다 (404)', async () => {
    const foreign = await seedRoom({ workspace_id: OTHER_WS, open_join: false }, [{ type: 'user', id: MEMBER }]);
    await assert.rejects(
      () => crud.setOpenJoin(foreign.id, WS, MEMBER, true),
      (e) => e.status === 404,
      '워크스페이스 밖의 roomId 는 존재 확인조차 되면 안 된다',
    );
  });
});
