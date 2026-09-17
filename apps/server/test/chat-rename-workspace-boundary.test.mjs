// renameRoom 의 워크스페이스 경계 회귀 테스트 — 티켓 de4d27e9.
//
// 고치기 전에는 `RoomCrudService.renameRoom` 이 방을 **id 로만** 찾고 호출자의
// 워크스페이스와 대조하지 않았다. `chat_room_participants` 행은 한 번 생기면 남으므로
// "이 방의 active 참여자인가"만으로는 경계가 지속되지 않는다 — 지난/다른 워크스페이스
// 방의 참여자 행을 들고 있는 호출자가 지금 바인딩된 스코프와 무관하게 그 방 이름을
// 바꿀 수 있었다(caller 등급과 workspace 권한이 분리되지 않은 사례).
//
// 실제 sql.js DataSource 위에서 진짜 쿼리를 돌린다(chat-open-join.test.mjs 와 같은
// 방식). 스텁으로는 아무것도 검증되지 않는다 — 워크스페이스 조건을 통째로 빼도
// 스텁 기반 테스트는 그대로 통과한다. 확인 대상이 "방 행의 workspace_id 와 호출자의
// workspace 가 실제로 대조되는가" 그 자체이기 때문이다.
//
// 두 공개 경로를 **각자의 진입점에서** 돈다 — 서비스 시그니처만 고치고 호출부가
// 워크스페이스를 안 넘기면 경계는 여전히 뚫려 있으므로, 서비스 직접 호출로는 그 결함이
// 잡히지 않는다.
//   - REST: 진짜 `ChatRoomsController` 를 만들어 `X-Workspace-Id` 헤더가 실린 fake req/res 로 호출
//   - MCP : 진짜 `registerChatTools` 가 등록한 `set_chat_room_name` 핸들러를 sessionStore 에
//           등록된 실제 caller 세션으로 호출
//
// 실행: node --test --test-force-exit apps/server/test/chat-rename-workspace-boundary.test.mjs
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
import { RoomCrudService } from '../dist/modules/chat-rooms/room-crud.service.js';
import { ChatRoomsController } from '../dist/modules/chat-rooms/chat-rooms.controller.js';
import { registerChatTools } from '../dist/modules/mcp/tools/chat-tools.js';
import { sessionStore } from '../dist/modules/mcp/internal/session-store.js';
import { serializeSqljsTransactions } from '../dist/db.js';
import { activityEvents } from '../dist/services/activity.service.js';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const ALICE = '33333333-3333-4333-8333-333333333333';
/** 같은 워크스페이스의 비참여자 — 경계를 고쳐도 참여자 게이트가 그대로인지 본다. */
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const BOT = '55555555-5555-4555-8555-555555555555';
/** workspace_id 가 없는(global) 에이전트 — 워크스페이스 해석 실패 경로용. */
const GLOBAL_BOT = '66666666-6666-4666-8666-666666666666';
/** 존재하지 않는 방 id — 타 워크스페이스 응답과 글자 단위로 대조할 기준값. */
const MISSING_ROOM = '77777777-7777-4777-8777-777777777777';

let dataSource;
let membership;
let crud;
let controller;
let renameTool;
/** 방금 발생한 chat_room_update SSE 를 모으는 자리 — 거부가 부수효과 0 인지 본다. */
let roomUpdates;
let onRoomUpdate;
/** MCP caller 세션 id → sessionStore 에서 정리해야 할 목록. */
const registeredSessions = [];

/** 방을 하나 만들고 주어진 참여자들을 active 로 넣는다. */
async function seedRoom(overrides = {}, participants = []) {
  const roomRepo = dataSource.getRepository(ChatRoom);
  const partRepo = dataSource.getRepository(ChatRoomParticipant);
  const room = await roomRepo.save(roomRepo.create({
    workspace_id: WS,
    type: 'group',
    name: '원래 이름',
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

const nameOf = async (roomId) => {
  const row = await dataSource.getRepository(ChatRoom).findOne({ where: { id: roomId } });
  return row ? row.name : null;
};

/** Express Response 의 최소 대역 — status/json 만 쓰는 컨트롤러에 맞춘다. */
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** `X-Workspace-Id` 헤더는 Express 가 소문자로 정규화해서 넘긴다. */
function fakeReq(userId, wsId) {
  const headers = {};
  if (wsId !== undefined) headers['x-workspace-id'] = wsId;
  return { currentUser: { id: userId }, headers, query: {} };
}

/** REST `PATCH /api/chat-rooms/:roomId/name` 한 번. */
async function restRename(roomId, userId, wsId, name = '바뀐 이름') {
  const res = fakeRes();
  await controller.renameRoom(fakeReq(userId, wsId), res, roomId, { name });
  return res;
}

/** MCP `set_chat_room_name` 한 번. agentWorkspaceId 는 caller 세션이 들고 있는 값. */
async function mcpRename(roomId, agentId, sessionWorkspaceId, name = '바뀐 이름') {
  const sessionId = `session-${randomUUID()}`;
  sessionStore.register(sessionId, { close: async () => {} }, {}, {
    agentId,
    workspaceId: sessionWorkspaceId,
    scope: 'full',
    source: 'db',
  });
  registeredSessions.push(sessionId);
  const result = await renameTool({ room_id: roomId, name }, { sessionId });
  return {
    isError: !!result.isError,
    payload: JSON.parse(result.content[0].text),
  };
}

describe('renameRoom 워크스페이스 경계 (티켓 de4d27e9)', () => {
  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Agent, OrchestrationMission],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    // raw sql.js DataSource 에는 진짜 커넥션 풀이 없어 겹치는 transaction() 호출이 같은
    // 커넥션을 공유한다. AppDataSource / DatabaseModule 이 생성 시점에 거는 직렬화 큐를
    // 여기서도 명시적으로 건다(chat-dm-promotion.test.mjs 와 같은 이유).
    serializeSqljsTransactions(dataSource);

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
    crud = new RoomCrudService(roomRepo, partRepo, msgRepo, userRepo, agentRepo, noopLog, membership);
    // rename 경로는 messaging / attachmentRepo 를 건드리지 않는다 — 이 스위트가 쓰지
    // 않는 의존성만 빈 객체로 둔다. crud 와 membership 은 전부 진짜다.
    controller = new ChatRoomsController(crud, membership, {}, {});

    const tools = {};
    const fakeServer = {
      tool(name, _description, _schema, handler) { tools[name] = handler; },
    };
    registerChatTools(fakeServer, {
      dataSource,
      logger: noopLog,
      roomCrudService: crud,
      roomMembershipService: membership,
      roomMessagingService: {},
    });
    renameTool = tools['set_chat_room_name'];
    assert.ok(renameTool, 'set_chat_room_name 핸들러가 등록되지 않았다');

    await userRepo.save([
      userRepo.create({ id: ALICE, name: 'Alice', email: 'alice@example.com' }),
      userRepo.create({ id: OUTSIDER, name: 'Outsider', email: 'out@example.com' }),
    ]);
    await agentRepo.save([
      agentRepo.create({ id: BOT, name: 'Bot', type: 'claude', workspace_id: WS }),
      agentRepo.create({ id: GLOBAL_BOT, name: 'Global bot', type: 'claude', workspace_id: null }),
    ]);

    roomUpdates = [];
    onRoomUpdate = (payload) => roomUpdates.push(payload);
    activityEvents.on('chat_room_update', onRoomUpdate);
  });

  after(async () => {
    if (onRoomUpdate) activityEvents.off('chat_room_update', onRoomUpdate);
    for (const sessionId of registeredSessions) sessionStore.remove(sessionId);
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    roomUpdates.length = 0;
    await dataSource.getRepository(ChatRoomParticipant).clear();
    await dataSource.getRepository(ChatRoom).clear();
  });

  // ── REST 경로 ─────────────────────────────────────────────────────────────

  it('REST: 타 워크스페이스 방은 active 참여자여도 404 이고 이름이 바뀌지 않는다', async () => {
    // 이 티켓의 핵심 — 참여자 행을 들고 있어도 지금 바인딩된 워크스페이스가 아니면 거부다.
    const room = await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'user', id: ALICE }]);

    const res = await restRename(room.id, ALICE, WS);

    assert.equal(res.statusCode, 404, '타 워크스페이스 room_id 가 통과했다');
    assert.equal(await nameOf(room.id), '원래 이름', '거부됐는데 이름이 바뀌었다');
    assert.equal(roomUpdates.length, 0, '거부 경로에서 chat_room_update 가 나갔다');
  });

  it('REST: 없는 방과 타 워크스페이스 방의 응답이 status·body 모두 같다', async () => {
    // 다르면 남의 워크스페이스 room_id 를 넣어보는 것만으로 방의 존재를 확인할 수 있다.
    const foreign = await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'user', id: ALICE }]);

    const foreignRes = await restRename(foreign.id, ALICE, WS);
    const missingRes = await restRename(MISSING_ROOM, ALICE, WS);

    assert.equal(foreignRes.statusCode, missingRes.statusCode, 'status 가 갈렸다');
    assert.deepEqual(foreignRes.body, missingRes.body, 'error 메시지가 갈렸다');
    assert.equal(foreignRes.statusCode, 404);
    assert.deepEqual(foreignRes.body, { error: 'Room not found' });
  });

  it('REST: X-Workspace-Id 가 없으면 400 이고 이름이 바뀌지 않는다', async () => {
    // setOpenJoin 엔드포인트와 같은 규약 — 헤더가 없으면 판정할 근거가 없으므로 거부한다.
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }]);

    const res = await restRename(room.id, ALICE, undefined);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Workspace ID required' });
    assert.equal(await nameOf(room.id), '원래 이름');
    assert.equal(roomUpdates.length, 0);
  });

  it('REST: 같은 워크스페이스의 정상 rename 은 그대로 동작한다 (무회귀)', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }]);

    const res = await restRename(room.id, ALICE, WS, '  새 제목  ');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(await nameOf(room.id), '새 제목', 'trim 된 이름으로 저장되지 않았다');
    assert.equal(roomUpdates.length, 1, 'renamed SSE 가 한 번 나가야 한다');
    assert.equal(roomUpdates[0].update_type, 'renamed');
    assert.equal(roomUpdates[0].new_name, '새 제목');
  });

  it('REST: 같은 워크스페이스라도 비참여자는 여전히 403 이다 (참여자 게이트 무회귀)', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }]);

    const res = await restRename(room.id, OUTSIDER, WS);

    assert.equal(res.statusCode, 403);
    assert.equal(await nameOf(room.id), '원래 이름');
  });

  it('REST: 1-100자 이름 검증이 워크스페이스 통과 뒤에도 그대로 산다 (무회귀)', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }]);

    const res = await restRename(room.id, ALICE, WS, 'x'.repeat(101));

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Room name must be 1-100 characters' });
    assert.equal(await nameOf(room.id), '원래 이름');
  });

  // ── MCP 경로 ──────────────────────────────────────────────────────────────

  it('MCP: 타 워크스페이스 방은 active 참여자여도 거부되고 이름이 바뀌지 않는다', async () => {
    const room = await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'agent', id: BOT }]);

    const res = await mcpRename(room.id, BOT, WS);

    assert.equal(res.isError, true, '타 워크스페이스 room_id 가 통과했다');
    assert.equal(res.payload.error, 'Room not found');
    assert.equal(await nameOf(room.id), '원래 이름', '거부됐는데 이름이 바뀌었다');
    assert.equal(roomUpdates.length, 0);
  });

  it('MCP: 없는 방과 타 워크스페이스 방의 응답이 완전히 같다', async () => {
    const foreign = await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'agent', id: BOT }]);

    const foreignRes = await mcpRename(foreign.id, BOT, WS);
    const missingRes = await mcpRename(MISSING_ROOM, BOT, WS);

    assert.equal(foreignRes.isError, missingRes.isError);
    assert.deepEqual(foreignRes.payload, missingRes.payload, 'error 메시지가 갈렸다');
    assert.equal(foreignRes.payload.error, 'Room not found');
  });

  it('MCP: 세션에 workspace 가 없어도 에이전트 자신의 workspace_id 로 판정한다', async () => {
    // caller.workspaceId 가 비면 normalizeAgentWorkspaceId(agent.workspace_id) 로 떨어진다.
    // BOT 은 WS 소속이므로 OTHER_WS 방은 여전히 거부돼야 한다.
    const foreign = await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'agent', id: BOT }]);
    const own = await seedRoom({}, [{ type: 'agent', id: BOT }]);

    const foreignRes = await mcpRename(foreign.id, BOT, undefined);
    assert.equal(foreignRes.isError, true, '세션 workspace 가 비자 경계가 풀렸다');
    assert.equal(await nameOf(foreign.id), '원래 이름');

    const ownRes = await mcpRename(own.id, BOT, undefined, '에이전트가 지은 제목');
    assert.equal(ownRes.isError, false, '자기 워크스페이스 방까지 막혔다');
    assert.equal(await nameOf(own.id), '에이전트가 지은 제목');
  });

  it('MCP: 워크스페이스를 해석할 수 없으면 거부하고 이름을 건드리지 않는다', async () => {
    // global agent(workspace_id null) + 키에도 workspace 가 없으면 판정 근거가 없다.
    // 같은 조건에서 send_chat_room_message 도 이미 거부하므로 rename 만 열어둘 이유가 없다.
    const room = await seedRoom({}, [{ type: 'agent', id: GLOBAL_BOT }]);

    const res = await mcpRename(room.id, GLOBAL_BOT, undefined);

    assert.equal(res.isError, true);
    assert.equal(res.payload.error, 'Could not resolve workspace from caller API key');
    assert.equal(await nameOf(room.id), '원래 이름');
    assert.equal(roomUpdates.length, 0);
  });

  it('MCP: 같은 워크스페이스의 정상 rename 은 그대로 동작한다 (무회귀)', async () => {
    const room = await seedRoom({ name: '' }, [{ type: 'agent', id: BOT }]);

    const res = await mcpRename(room.id, BOT, WS, '첫 턴에 지은 제목');

    assert.equal(res.isError, false);
    assert.deepEqual(res.payload, { room_id: room.id, name: '첫 턴에 지은 제목' });
    assert.equal(await nameOf(room.id), '첫 턴에 지은 제목');
    assert.equal(roomUpdates.length, 1);
    assert.equal(roomUpdates[0].update_type, 'renamed');
  });

  it('MCP: 같은 워크스페이스라도 비참여 에이전트는 여전히 403 이다 (참여자 게이트 무회귀)', async () => {
    const room = await seedRoom({}, [{ type: 'user', id: ALICE }]);

    const res = await mcpRename(room.id, BOT, WS);

    assert.equal(res.isError, true);
    assert.equal(res.payload.error, 'Not an active participant in this room');
    assert.equal(await nameOf(room.id), '원래 이름');
  });

  // ── 경계가 참여자 게이트보다 앞서는지 ────────────────────────────────────

  it('타 워크스페이스 방은 참여자가 아닐 때도 403 이 아니라 404 로 수렴한다', async () => {
    // 워크스페이스 검사가 참여자 검사보다 **뒤**에 있으면, 참여자 행 유무가 404/403 으로
    // 갈려 남의 워크스페이스 방의 참여자 구성이 드러난다. 두 경우 모두 404 여야 한다.
    const foreign = await seedRoom({ workspace_id: OTHER_WS }, [{ type: 'user', id: ALICE }]);

    const asMember = await restRename(foreign.id, ALICE, WS);
    const asStranger = await restRename(foreign.id, OUTSIDER, WS);

    assert.equal(asMember.statusCode, 404);
    assert.equal(asStranger.statusCode, 404, '참여자 여부가 status 로 새어 나갔다');
    assert.deepEqual(asMember.body, asStranger.body);
  });
});
