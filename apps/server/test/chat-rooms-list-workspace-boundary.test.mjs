// list_chat_rooms 의 워크스페이스 경계 회귀 테스트 — 티켓 ced48818.
//
// 고치기 전에는 이 MCP 툴이 호출자의 워크스페이스를 해석하지 않고 **자신의 active
// 참여자 행만** 봤다. `chat_room_participants` 행은 한 번 생기면 남으므로 그것만으로는
// 경계가 지속되지 않는다 — 지난/다른 워크스페이스 방의 참여자 행을 들고 있는 에이전트
// 에게 그 방의 `name` 과 `last_message_at` 이 계속 실렸다. 방 이름은 set_chat_room_name
// 의 용도상 대화 주제를 담고, `last_message_at` 은 타 워크스페이스의 활동 시각이다.
//
// 같은 "내 방 목록"의 REST 형제 경로인 RoomCrudService.listRooms 는 이미
// `r.workspace_id = :wsId` 를 1급 조건으로 걸고 있었다 — MCP 쪽만 빠져 있어 같은
// 질문에 두 표면의 답이 갈렸다. 형제 툴 get_chat_room_messages(티켓 5a95315f)와 같은
// 결함 계급이다.
//
// 실제 sql.js DataSource 위에서 진짜 쿼리를 돌린다(chat-messages-workspace-boundary.
// test.mjs 선례). 검증 대상이 "조인된 방 행의 workspace_id 가 실제로 대조되는가" 자체
// 라 스텁으로는 아무것도 안 잡힌다 — 조건을 통째로 빼도 스텁 테스트는 통과한다.
//
// 공개 경로가 MCP 툴 하나뿐이라 **그 진입점에서** 돈다: 진짜 `registerChatTools` 가
// 등록한 `list_chat_rooms` 핸들러를, `sessionStore` 에 등록한 실제 caller 세션으로
// 호출한다. Nest 는 부팅하지 않는다.
//
// 이 읽기 경로는 트랜잭션을 열지 않으므로 `serializeSqljsTransactions()` 는 걸지
// 않는다(겹치는 transaction() 호출이 있는 스위트에만 필요하다).
//
// 실행: node --test --test-force-exit apps/server/test/chat-rooms-list-workspace-boundary.test.mjs
//   (dist/ 를 import 하므로 `npm run build -w server` 가 선행되어야 한다)

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ChatRoom } from '../dist/entities/ChatRoom.js';
import { ChatRoomParticipant } from '../dist/entities/ChatRoomParticipant.js';
import { Agent } from '../dist/entities/Agent.js';
import { registerChatTools } from '../dist/modules/mcp/tools/chat-tools.js';
import { sessionStore } from '../dist/modules/mcp/internal/session-store.js';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
/** WS 소속 에이전트 — 정상 목록과 타 워크스페이스 배제를 함께 본다. */
const BOT = '33333333-3333-4333-8333-333333333333';
/** workspace_id 가 없는(global) 에이전트 — 해석 실패 경로와 세션 스코프 판정용. */
const GLOBAL_BOT = '55555555-5555-4555-8555-555555555555';
/** 사람 참여자 — participant_type 이 실제로 걸러지는지 볼 때 쓴다. */
const ALICE = '66666666-6666-4666-8666-666666666666';

let dataSource;
let listTool;
/** MCP caller 세션 id → sessionStore 에서 정리해야 할 목록. */
const registeredSessions = [];

/** 방을 하나 만들고 주어진 참여자들을 넣는다(left_at 을 주면 나간 행이 된다). */
async function seedRoom(overrides = {}, participants = []) {
  const roomRepo = dataSource.getRepository(ChatRoom);
  const partRepo = dataSource.getRepository(ChatRoomParticipant);
  const room = await roomRepo.save(roomRepo.create({
    workspace_id: WS,
    type: 'group',
    name: '방',
    last_message_at: null,
    open_join: false,
    ...overrides,
  }));
  for (const p of participants) {
    await partRepo.save(partRepo.create({
      room_id: room.id,
      participant_type: p.type,
      participant_id: p.id,
      last_read_at: null,
      left_at: p.left_at ?? null,
    }));
  }
  return room;
}

/**
 * MCP `list_chat_rooms` 한 번. `sessionWorkspaceId` 는 caller 세션(= API key)이 들고
 * 있는 값이고, 비워 두면 에이전트 자신의 workspace_id 로 떨어지는 폴백을 탄다.
 */
async function mcpList(agentId, sessionWorkspaceId) {
  const sessionId = `session-${randomUUID()}`;
  sessionStore.register(sessionId, { close: async () => {} }, {}, {
    agentId,
    workspaceId: sessionWorkspaceId,
    scope: 'full',
    source: 'db',
  });
  registeredSessions.push(sessionId);
  const result = await listTool({}, { sessionId });
  return { isError: !!result.isError, payload: JSON.parse(result.content[0].text) };
}

/** 거부 응답이 방을 한 건도 흘리지 않았는지. */
function assertNoRoomsLeaked(res) {
  assert.equal(res.isError, true, '거부돼야 할 호출이 성공했다');
  assert.equal(Array.isArray(res.payload), false, '거부 응답이 방 목록을 돌려줬다');
  assert.deepEqual(Object.keys(res.payload), ['error'], '거부 응답에 error 외의 필드가 실렸다');
}

describe('list_chat_rooms 워크스페이스 경계 (티켓 ced48818)', () => {
  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [ChatRoom, ChatRoomParticipant, Agent],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();

    const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
    const tools = {};
    const fakeServer = {
      tool(name, _description, _schema, handler) { tools[name] = handler; },
    };
    // list_chat_rooms 가 쓰는 것은 dataSource 뿐이다. 나머지 ctx 는 같은 등록 함수가
    // 다른 툴을 위해 클로저로 잡아 둘 뿐이라 빈 대역으로 둔다.
    registerChatTools(fakeServer, {
      dataSource,
      logger: noopLog,
      roomCrudService: {},
      roomMembershipService: {},
      roomMessagingService: {},
    });
    listTool = tools['list_chat_rooms'];
    assert.ok(listTool, 'list_chat_rooms 핸들러가 등록되지 않았다');

    const agentRepo = dataSource.getRepository(Agent);
    await agentRepo.save([
      agentRepo.create({ id: BOT, name: 'Bot', type: 'claude', workspace_id: WS }),
      agentRepo.create({ id: GLOBAL_BOT, name: 'Global bot', type: 'claude', workspace_id: null }),
    ]);
  });

  after(async () => {
    for (const sessionId of registeredSessions) sessionStore.remove(sessionId);
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(ChatRoomParticipant).clear();
    await dataSource.getRepository(ChatRoom).clear();
  });

  // ── 경계 ──────────────────────────────────────────────────────────────────

  it('타 워크스페이스 방은 active 참여자 행이 있어도 목록에 실리지 않는다', async () => {
    // 이 티켓의 핵심 — 참여자 행을 들고 있어도 지금 바인딩된 워크스페이스가 아니면 뺀다.
    const mine = await seedRoom({ name: '우리 방' }, [{ type: 'agent', id: BOT }]);
    await seedRoom(
      { workspace_id: OTHER_WS, name: '남의 워크스페이스 배포 논의' },
      [{ type: 'agent', id: BOT }],
    );

    const res = await mcpList(BOT, WS);

    assert.equal(res.isError, false, '정상 목록이 거부됐다');
    assert.deepEqual(res.payload.map(r => r.room_id), [mine.id]);
    assert.equal(
      JSON.stringify(res.payload).includes('남의 워크스페이스 배포 논의'),
      false,
      '타 워크스페이스 방 이름이 응답에 실렸다',
    );
  });

  it('타 워크스페이스 방만 들고 있으면 빈 목록이 된다', async () => {
    // 부분 필터가 아니라 전량 배제인지 — 방 이름도 활동 시각도 나가면 안 된다.
    await seedRoom(
      { workspace_id: OTHER_WS, last_message_at: new Date('2026-01-01T00:00:00.000Z') },
      [{ type: 'agent', id: BOT }],
    );

    const res = await mcpList(BOT, WS);

    assert.equal(res.isError, false);
    assert.deepEqual(res.payload, []);
  });

  it('세션에 workspace 가 없으면 에이전트 자신의 workspace_id 로 판정한다', async () => {
    const mine = await seedRoom({}, [{ type: 'agent', id: BOT }]);
    await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'agent', id: BOT }]);

    const res = await mcpList(BOT, undefined);

    assert.equal(res.isError, false);
    assert.deepEqual(res.payload.map(r => r.room_id), [mine.id]);
  });

  it('workspace 를 해석할 수 없으면(전역 에이전트 + 스코프 없는 세션) 거부한다', async () => {
    // 전역 에이전트는 workspace_id 가 null 이라 폴백도 비고, 세션 키에도 스코프가 없다.
    await seedRoom({}, [{ type: 'agent', id: GLOBAL_BOT }]);

    const res = await mcpList(GLOBAL_BOT, undefined);

    assertNoRoomsLeaked(res);
  });

  it('전역 에이전트도 세션 키의 workspace 밖 방은 목록에서 빠진다', async () => {
    const mine = await seedRoom({}, [{ type: 'agent', id: GLOBAL_BOT }]);
    await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'agent', id: GLOBAL_BOT }]);

    const res = await mcpList(GLOBAL_BOT, WS);

    assert.equal(res.isError, false);
    assert.deepEqual(res.payload.map(r => r.room_id), [mine.id]);
  });

  // ── 같은 워크스페이스 무회귀 ────────────────────────────────────────────────

  it('같은 워크스페이스 방은 last_message_at 최신순이고 활동 없는 방이 뒤로 간다', async () => {
    // 경계 조건을 쿼리에 끼워 넣으면서 ORDER BY ... DESC NULLS LAST 가 깨지지 않았는지.
    const older = await seedRoom(
      { name: '오래된 방', last_message_at: new Date('2026-01-01T00:00:00.000Z') },
      [{ type: 'agent', id: BOT }],
    );
    const newer = await seedRoom(
      { name: '최근 방', last_message_at: new Date('2026-02-01T00:00:00.000Z') },
      [{ type: 'agent', id: BOT }],
    );
    const quiet = await seedRoom({ name: '조용한 방', last_message_at: null }, [
      { type: 'agent', id: BOT },
    ]);

    const res = await mcpList(BOT, WS);

    assert.equal(res.isError, false);
    assert.deepEqual(res.payload.map(r => r.room_id), [newer.id, older.id, quiet.id]);
    assert.equal(res.payload[2].last_message_at, null, '활동 없는 방의 last_message_at 이 null 이 아니다');
  });

  it('room_id · name · type · open_join 메타데이터가 그대로 실린다', async () => {
    const room = await seedRoom(
      {
        name: '자유 참여 방',
        type: 'dm',
        open_join: true,
        last_message_at: new Date('2026-03-01T00:00:00.000Z'),
      },
      [{ type: 'agent', id: BOT }],
    );

    const res = await mcpList(BOT, WS);

    assert.equal(res.isError, false);
    assert.deepEqual(res.payload, [{
      room_id: room.id,
      name: '자유 참여 방',
      type: 'dm',
      last_message_at: '2026-03-01T00:00:00.000Z',
      open_join: true,
    }]);
  });

  it('나간(left_at) 참여자 행은 여전히 제외된다', async () => {
    await seedRoom({ name: '나간 방' }, [
      { type: 'agent', id: BOT, left_at: new Date('2026-01-05T00:00:00.000Z') },
    ]);

    const res = await mcpList(BOT, WS);

    assert.equal(res.isError, false);
    assert.deepEqual(res.payload, []);
  });

  it('participant_type 이 user 인 행으로는 목록에 실리지 않는다', async () => {
    // 같은 id 를 user 참여자로 심어도 agent 목록에는 안 나와야 한다 — 경계 조건을
    // 추가하면서 participant_type 필터가 밀려나지 않았는지 고정한다.
    await seedRoom({ name: '사람만 있는 방' }, [
      { type: 'user', id: BOT },
      { type: 'user', id: ALICE },
    ]);

    const res = await mcpList(BOT, WS);

    assert.equal(res.isError, false);
    assert.deepEqual(res.payload, []);
  });
});
