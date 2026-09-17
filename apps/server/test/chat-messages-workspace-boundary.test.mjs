// get_chat_room_messages 의 워크스페이스 경계 회귀 테스트 — 티켓 5a95315f.
//
// 고치기 전에는 이 MCP 툴이 호출자의 워크스페이스를 해석하지 않고 **active 참여자
// 여부만** 봤다. `chat_room_participants` 행은 한 번 생기면 남으므로 그것만으로는
// 경계가 지속되지 않는다 — 지난/다른 워크스페이스 방의 참여자 행을 들고 있는
// 에이전트가 지금 API key 가 묶인 스코프와 무관하게 그 방의 **대화 내용 전체**를
// 읽을 수 있었다. `observer: true` 로 호출하므로 서비스 쪽 user-scoped 게이트와
// per-user `cleared_at` 컷까지 지나친다.
//
// 실제 sql.js DataSource 위에서 진짜 쿼리를 돌린다(chat-open-join.test.mjs 선례).
// 검증 대상이 "방 행의 workspace_id 와 호출자의 workspace 가 실제로 대조되는가"
// 자체라 스텁으로는 아무것도 안 잡힌다 — 조건을 통째로 빼도 스텁 테스트는 통과한다.
//
// 공개 경로가 MCP 툴 하나뿐이라 **그 진입점에서** 돈다: 진짜 `registerChatTools` 가
// 등록한 `get_chat_room_messages` 핸들러를, `sessionStore` 에 등록한 실제 caller
// 세션으로 호출한다. Nest 는 부팅하지 않는다.
//
// 이 읽기 경로는 트랜잭션을 열지 않으므로 `serializeSqljsTransactions()` 는 걸지
// 않는다(겹치는 transaction() 호출이 있는 스위트에만 필요하다 — ci-wait-resume 등).
//
// 실행: node --test --test-force-exit apps/server/test/chat-messages-workspace-boundary.test.mjs
//   (dist/ 를 import 하므로 `npm run build -w server` 가 선행되어야 한다)

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ChatRoom } from '../dist/entities/ChatRoom.js';
import { ChatRoomParticipant } from '../dist/entities/ChatRoomParticipant.js';
import { ChatRoomMessage } from '../dist/entities/ChatRoomMessage.js';
import { User } from '../dist/entities/User.js';
import { Agent } from '../dist/entities/Agent.js';
import { OrchestrationMission } from '../dist/entities/OrchestrationMission.js';
import { RoomMembershipService } from '../dist/modules/chat-rooms/room-membership.service.js';
import { RoomMessagingService } from '../dist/modules/chat-rooms/room-messaging.service.js';
import { registerChatTools } from '../dist/modules/mcp/tools/chat-tools.js';
import { sessionStore } from '../dist/modules/mcp/internal/session-store.js';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
/** WS 소속 에이전트 — 정상 경로와 타 워크스페이스 거부를 함께 본다. */
const BOT = '33333333-3333-4333-8333-333333333333';
/** 같은 워크스페이스의 비참여자 — 경계를 고쳐도 참여자 게이트가 그대로인지 본다. */
const OUTSIDER_BOT = '44444444-4444-4444-8444-444444444444';
/** workspace_id 가 없는(global) 에이전트 — 워크스페이스 해석 실패 경로용. */
const GLOBAL_BOT = '55555555-5555-4555-8555-555555555555';
/** 사람 발신자 — 방 대화에 섞여 있는 쪽이 실제 방에 가깝다. */
const ALICE = '66666666-6666-4666-8666-666666666666';
/** 존재하지 않는 방 id — 타 워크스페이스 응답과 글자 단위로 대조할 기준값. */
const MISSING_ROOM = '77777777-7777-4777-8777-777777777777';

let dataSource;
let membership;
let messaging;
let readTool;
/** MCP caller 세션 id → sessionStore 에서 정리해야 할 목록. */
const registeredSessions = [];

/** 방을 하나 만들고 주어진 참여자들을 active 로 넣는다. */
async function seedRoom(overrides = {}, participants = []) {
  const roomRepo = dataSource.getRepository(ChatRoom);
  const partRepo = dataSource.getRepository(ChatRoomParticipant);
  const room = await roomRepo.save(roomRepo.create({
    workspace_id: WS,
    type: 'group',
    name: '방',
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

/**
 * 메시지를 1초 간격으로 심는다. `(created_at, id)` 정렬이 결정적이어야 커서 경계
 * 단언이 같은 밀리초 동률로 흔들리지 않는다(qa-flows/chat-message-read 선례).
 */
async function seedMessages(room, rows) {
  const msgRepo = dataSource.getRepository(ChatRoomMessage);
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const saved = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    saved.push(await msgRepo.save(msgRepo.create({
      room_id: room.id,
      workspace_id: room.workspace_id,
      sender_type: r.sender_type || 'user',
      sender_id: r.sender_id || ALICE,
      type: r.type || 'message',
      content: r.content,
      images: '[]',
      created_at: new Date(base + i * 1000),
    })));
  }
  return saved;
}

/**
 * MCP `get_chat_room_messages` 한 번. `sessionWorkspaceId` 는 caller 세션(= API key)이
 * 들고 있는 값이고, 비워 두면 에이전트 자신의 workspace_id 로 떨어지는 폴백을 탄다.
 */
async function mcpRead(roomId, agentId, sessionWorkspaceId, args = {}) {
  const sessionId = `session-${randomUUID()}`;
  sessionStore.register(sessionId, { close: async () => {} }, {}, {
    agentId,
    workspaceId: sessionWorkspaceId,
    scope: 'full',
    source: 'db',
  });
  registeredSessions.push(sessionId);
  const result = await readTool({ room_id: roomId, ...args }, { sessionId });
  return {
    isError: !!result.isError,
    payload: JSON.parse(result.content[0].text),
  };
}

/** 거부 응답이 메시지를 한 건도 흘리지 않았는지. */
function assertNoMessagesLeaked(res) {
  assert.equal(res.isError, true, '거부돼야 할 호출이 성공했다');
  assert.deepEqual(Object.keys(res.payload), ['error'], '거부 응답에 error 외의 필드가 실렸다');
  assert.equal(res.payload.messages, undefined, '거부 응답에 messages 가 실렸다');
  assert.equal(res.payload.count, undefined, '거부 응답에 count 가 실렸다');
}

describe('get_chat_room_messages 워크스페이스 경계 (티켓 5a95315f)', () => {
  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Agent, OrchestrationMission],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();

    const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
    const roomRepo = dataSource.getRepository(ChatRoom);
    const partRepo = dataSource.getRepository(ChatRoomParticipant);
    const msgRepo = dataSource.getRepository(ChatRoomMessage);
    const userRepo = dataSource.getRepository(User);
    const agentRepo = dataSource.getRepository(Agent);

    membership = new RoomMembershipService(
      roomRepo, partRepo, userRepo, agentRepo, dataSource,
      dataSource.getRepository(OrchestrationMission),
    );
    // getMessages 가 실제로 쓰는 것은 messageRepo · attachmentRepo · membership 셋이다.
    // 나머지 위치 인자는 이 읽기 경로가 건드리지 않으므로 빈 대역으로 둔다(선례:
    // chat-open-join.test.mjs). attachmentRepo 만 "첨부 없음"으로 답하게 둔 것은
    // TicketAttachment 를 넣으면 Ticket 관계 그래프가 sql.js 스키마로 끌려 들어오는데,
    // 첨부는 이 경계와 무관하기 때문이다.
    const empty = {};
    messaging = new RoomMessagingService(
      roomRepo,                                   // roomRepo
      partRepo,                                   // participantRepo
      msgRepo,                                    // messageRepo
      agentRepo,                                  // agentRepo
      empty,                                      // ticketRepo
      empty,                                      // userMentionRepo
      { async find() { return []; } },            // attachmentRepo
      { async findOne() { return null; } },       // workspaceRepo
      dataSource,                                 // dataSource
      noopLog,                                    // logService
      membership,                                 // membership
      { parseMentions: () => [], async resolveMentions() { return []; } }, // mentionService
      empty,                                      // connectivity
    );

    const tools = {};
    const fakeServer = {
      tool(name, _description, _schema, handler) { tools[name] = handler; },
    };
    registerChatTools(fakeServer, {
      dataSource,
      logger: noopLog,
      roomCrudService: {},
      roomMembershipService: membership,
      roomMessagingService: messaging,
    });
    readTool = tools['get_chat_room_messages'];
    assert.ok(readTool, 'get_chat_room_messages 핸들러가 등록되지 않았다');

    await userRepo.save([
      userRepo.create({ id: ALICE, name: 'Alice', email: 'alice@example.com' }),
    ]);
    await agentRepo.save([
      agentRepo.create({ id: BOT, name: 'Bot', type: 'claude', workspace_id: WS }),
      agentRepo.create({ id: OUTSIDER_BOT, name: 'Outsider bot', type: 'claude', workspace_id: WS }),
      agentRepo.create({ id: GLOBAL_BOT, name: 'Global bot', type: 'claude', workspace_id: null }),
    ]);
  });

  after(async () => {
    for (const sessionId of registeredSessions) sessionStore.remove(sessionId);
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(ChatRoomMessage).clear();
    await dataSource.getRepository(ChatRoomParticipant).clear();
    await dataSource.getRepository(ChatRoom).clear();
  });

  // ── 경계 ──────────────────────────────────────────────────────────────────

  it('타 워크스페이스 방은 active 참여자여도 거부되고 메시지가 한 건도 나가지 않는다', async () => {
    // 이 티켓의 핵심 — 참여자 행을 들고 있어도 지금 바인딩된 워크스페이스가 아니면 거부다.
    const foreign = await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'agent', id: BOT }]);
    await seedMessages(foreign, [{ content: '남의 워크스페이스 대화' }]);

    const res = await mcpRead(foreign.id, BOT, WS);

    assertNoMessagesLeaked(res);
    assert.equal(res.payload.error, 'Chat room not found');
  });

  it('없는 방과 타 워크스페이스 방의 응답이 완전히 같다', async () => {
    // 다르면 남의 워크스페이스 room_id 를 넣어보는 것만으로 방의 존재를 확인할 수 있다.
    const foreign = await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'agent', id: BOT }]);
    await seedMessages(foreign, [{ content: '남의 워크스페이스 대화' }]);

    const foreignRes = await mcpRead(foreign.id, BOT, WS);
    const missingRes = await mcpRead(MISSING_ROOM, BOT, WS);

    assert.equal(foreignRes.isError, missingRes.isError);
    assert.deepEqual(foreignRes.payload, missingRes.payload, 'error 메시지가 갈렸다');
    assert.equal(foreignRes.payload.error, 'Chat room not found');
  });

  it('타 워크스페이스 방은 참여자 행 유무로도 응답이 갈리지 않는다', async () => {
    // 워크스페이스 대조를 참여자 게이트 **뒤에** 두면 참여자 행이 있을 때와 없을 때의
    // 에러가 갈려, 남의 워크스페이스 방의 참여자 구성이 응답만으로 드러난다.
    const joined = await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'agent', id: BOT }]);
    const notJoined = await seedRoom({ workspace_id: OTHER_WS }, []);

    const joinedRes = await mcpRead(joined.id, BOT, WS);
    const notJoinedRes = await mcpRead(notJoined.id, BOT, WS);

    assert.equal(joinedRes.isError, notJoinedRes.isError);
    assert.deepEqual(joinedRes.payload, notJoinedRes.payload, '참여자 행 유무가 응답으로 새어 나갔다');
  });

  it('세션에 workspace 가 없으면 에이전트 자신의 workspace_id 로 판정한다', async () => {
    // caller.workspaceId 가 비면 normalizeAgentWorkspaceId(agent.workspace_id) 로 떨어진다.
    // BOT 은 WS 소속이므로 OTHER_WS 방은 여전히 거부되고, 자기 WS 방은 읽힌다.
    const foreign = await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'agent', id: BOT }]);
    await seedMessages(foreign, [{ content: '남의 워크스페이스 대화' }]);
    const own = await seedRoom({}, [{ type: 'agent', id: BOT }]);
    await seedMessages(own, [{ content: '내 워크스페이스 대화' }]);

    const foreignRes = await mcpRead(foreign.id, BOT, undefined);
    const ownRes = await mcpRead(own.id, BOT, undefined);

    assertNoMessagesLeaked(foreignRes);
    assert.equal(foreignRes.payload.error, 'Chat room not found');
    assert.equal(ownRes.isError, false, '자기 워크스페이스 방 읽기가 폴백에서 막혔다');
    assert.deepEqual(ownRes.payload.messages.map(m => m.content), ['내 워크스페이스 대화']);
  });

  it('workspace 를 해석할 수 없으면(전역 에이전트 + 스코프 없는 세션) 거부한다', async () => {
    // 세션 키에도 workspace 가 없고 에이전트도 global 이면 대조할 기준이 없다 —
    // 이 파일의 다른 툴들과 같은 방식으로 fail-closed 한다.
    const room = await seedRoom({}, [{ type: 'agent', id: GLOBAL_BOT }]);
    await seedMessages(room, [{ content: '대화' }]);

    const res = await mcpRead(room.id, GLOBAL_BOT, undefined);

    assertNoMessagesLeaked(res);
    assert.equal(res.payload.error, 'Could not resolve workspace from caller API key');
  });

  it('전역 에이전트도 세션 키의 workspace 밖 방은 읽지 못한다', async () => {
    // global 이라고 전 워크스페이스가 열리지는 않는다 — 판정 기준은 어디까지나 지금
    // 바인딩된 스코프다. 같은 읽기의 형제 경로인 agent-api REST 도 키 스코프로 막는다.
    const foreign = await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'agent', id: GLOBAL_BOT }]);
    await seedMessages(foreign, [{ content: '남의 워크스페이스 대화' }]);
    const own = await seedRoom({}, [{ type: 'agent', id: GLOBAL_BOT }]);
    await seedMessages(own, [{ content: '내 워크스페이스 대화' }]);

    const foreignRes = await mcpRead(foreign.id, GLOBAL_BOT, WS);
    const ownRes = await mcpRead(own.id, GLOBAL_BOT, WS);

    assertNoMessagesLeaked(foreignRes);
    assert.equal(foreignRes.payload.error, 'Chat room not found');
    assert.equal(ownRes.isError, false, '세션 스코프 안의 방까지 막혔다');
    assert.deepEqual(ownRes.payload.messages.map(m => m.content), ['내 워크스페이스 대화']);
  });

  // ── 무회귀 ────────────────────────────────────────────────────────────────

  it('같은 워크스페이스 읽기는 시간순 전체 기록을 그대로 돌려준다', async () => {
    // 참여자 행이 agent 타입 하나뿐인데 읽히는 것이 곧 observer 모드 무회귀다 —
    // `observer: true` 를 빼면 서비스가 participant_type='user' 로 게이트를 다시 걸어
    // (에이전트에게는 없는 행이라) 403 이 된다.
    const room = await seedRoom({}, [{ type: 'agent', id: BOT }]);
    await seedMessages(room, [
      { content: '첫째' },
      { content: '둘째', sender_type: 'agent', sender_id: BOT },
      { content: '셋째' },
    ]);

    const res = await mcpRead(room.id, BOT, WS);

    assert.equal(res.isError, false);
    assert.equal(res.payload.room_id, room.id);
    assert.equal(res.payload.count, 3);
    assert.deepEqual(res.payload.messages.map(m => m.content), ['첫째', '둘째', '셋째']);
  });

  it('progress 메시지는 여전히 제외된다 (excludeProgress 무회귀)', async () => {
    // 매니저의 tool-call 내레이션이 섞여 들어가면 모델이 대화 대신 자기 내레이션을 읽는다.
    const room = await seedRoom({}, [{ type: 'agent', id: BOT }]);
    await seedMessages(room, [
      { content: '대화 1' },
      { content: 'tool-call 내레이션', sender_type: 'agent', sender_id: BOT, type: 'progress' },
      { content: '대화 2' },
    ]);

    const res = await mcpRead(room.id, BOT, WS);

    assert.equal(res.payload.count, 2, 'progress 행이 결과에 섞였다');
    assert.deepEqual(res.payload.messages.map(m => m.content), ['대화 1', '대화 2']);
  });

  it('before 커서와 limit 이 그대로 동작한다 (페이지네이션 무회귀)', async () => {
    const room = await seedRoom({}, [{ type: 'agent', id: BOT }]);
    await seedMessages(room, [{ content: '하나' }, { content: '둘' }, { content: '셋' }]);

    const all = await mcpRead(room.id, BOT, WS);
    const ids = all.payload.messages.map(m => m.id);
    const older = await mcpRead(room.id, BOT, WS, { before: ids[1] });
    const limited = await mcpRead(room.id, BOT, WS, { limit: 2 });

    assert.deepEqual(older.payload.messages.map(m => m.content), ['하나'], '커서보다 오래된 것만 나와야 한다');
    assert.deepEqual(limited.payload.messages.map(m => m.content), ['둘', '셋'], '최신 2건이 시간순으로 나와야 한다');
  });

  it('같은 워크스페이스라도 비참여자는 여전히 거부된다 (참여자 게이트 무회귀)', async () => {
    // 워크스페이스가 통과한 뒤에도 참여자 게이트는 그대로 살아 있어야 한다.
    const room = await seedRoom({}, [{ type: 'agent', id: BOT }]);
    await seedMessages(room, [{ content: '대화' }]);

    const res = await mcpRead(room.id, OUTSIDER_BOT, WS);

    assertNoMessagesLeaked(res);
    assert.equal(res.payload.error, 'Not an active participant in this room');
  });
});
