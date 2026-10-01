// 회귀 (티켓 dedff9a3): sentinel actor_id 가 쓴 활동의 board_update SSE 프레임이
// Postgres 에서 통째로 사라졌다.
//
// `ActivityLog.actor_id` 는 varchar 라 'auto-advance'/'system' 쓰기는 성공한다.
// 깨지던 쪽은 그 뒤 board_update 매핑의 actor 이름 보강이다:
// resolveAgentDisplayName() 이 가드 없이 `Agent.id`(Postgres 에서 real uuid) 로
// findOne 을 쳐 `invalid input syntax for type uuid: "auto-advance"` 로 throw 했고,
// events.controller 의 핸들러가 그 throw 를 catch 하면서 `eventSubject.next()` 를
// 건너뛰어 **프레임이 아예 발행되지 않았다**. 로그에만 남고 테스트는 green —
// 일회용 Postgres 16 로 `npm run test:qa:pg` 에서 43회, 같은 커밋 sqlite 는 0회.
//
// 유실의 실질 피해는 agent-manager 의 `handleBoardUpdate` 다: moved 의 티켓
// worktree 회수와 archived 의 QA/Security run workspace 회수가 이 프레임만
// 보고 돌고 대체 경로가 없다(10분 sweep 은 dirty 트리를 일부러 보존한다).
// sentinel actor 를 쓰는 대표 경로가 바로 그 둘이다 — ticket-archiver(archived,
// 'system'), trigger-loop 의 auto-advance(moved), backlog-promotion(moved,
// 'system').
//
// 두 겹을 따로 검증한다. 가드(1)만 있으면 다른 종류의 조회 실패가 같은 방식으로
// 프레임을 죽이고, 2차 방어(2)만 있으면 Postgres 에 쓸모없는 쿼리를 계속 보낸다.
//   1) 레지스트리 — 실제 EVENT_TYPES 의 board_update map() 에 실제
//      resolveAgentDisplayName 을 꽂고, agentRepo 는 Postgres 처럼 비-uuid 에
//      **던지게** 한다. 가드를 되돌리면 map() 이 예외로 깨진다.
//   2) 컨트롤러 — 실제 EventsController 를 띄워 uuid 모양 actor_id + 항상
//      던지는 agentRepo 로, 이름 보강 실패가 프레임을 죽이지 못함을 본다.
//      이름 보강은 장식이고 프레임은 배선이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const { EVENT_TYPES } = await import(
  'file://' + path.join(DIST, 'modules', 'events', 'event-registry.js')
);
const { resolveAgentDisplayName } = await import(
  'file://' + path.join(DIST, 'utils', 'agent-name.js')
);
const { activityEvents } = await import(
  'file://' + path.join(DIST, 'services', 'activity.service.js')
);

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_UUID = '22222222-2222-4222-8222-222222222222';
const MANAGER_UUID = '33333333-3333-4333-8333-333333333333';
const TICKET_ID = '44444444-4444-4444-8444-444444444444';
const COLUMN_ID = 'column-done';
const BOARD_ID = 'board-1';

/** Postgres 의 uuid 컬럼을 모사한 agents repo — 비-uuid id 에 실제로 던진다. */
function pgLikeAgentRepo(calls) {
  return {
    async findOne(opts) {
      const id = opts?.where?.id;
      calls.push(id);
      if (!UUID_SHAPE.test(String(id ?? ''))) {
        throw new Error(`invalid input syntax for type uuid: "${id}"`);
      }
      return id === AGENT_UUID
        ? { id, name: 'Bob', manager_agent_id: MANAGER_UUID }
        : null;
    },
    async find(opts) {
      const op = opts?.where?.id;
      const raw = op && typeof op === 'object' && 'value' in op ? op.value : op;
      const ids = Array.isArray(raw) ? raw : [raw];
      return ids
        .filter((id) => id === MANAGER_UUID)
        .map((id) => ({ id, name: 'Rolf', manager_agent_id: null }));
    },
  };
}

function boardUpdateDef() {
  const def = EVENT_TYPES.find((d) => d.eventType === 'board_update');
  assert.ok(def, 'EVENT_TYPES 에 board_update 정의가 있어야 한다');
  return def;
}

/** events.controller 의 mapCtx 와 같은 배선 — actor 해석만 실제 함수다. */
function mapCtx(agentRepo) {
  return {
    resolveBoardId: async () => BOARD_ID,
    resolveTicketRepositoryResourceId: async () => '',
    resolveTicketColumnSnapshot: async () => ({ id: COLUMN_ID, name: 'Done', kind: 'done' }),
    resolveActorDisplayName: (actorId) => resolveAgentDisplayName(agentRepo, actorId),
  };
}

/** trigger-loop 의 auto-advance 와 ticket-archiver 가 실제로 쓰는 활동 모양. */
const sentinelActivity = (actorId, action) => ({
  ticket_id: TICKET_ID,
  entity_id: TICKET_ID,
  entity_type: 'ticket',
  action,
  field_changed: action === 'moved' ? 'column_id' : '',
  actor_id: actorId,
  actor_name: actorId,
  old_value: action === 'moved' ? 'In Progress' : '',
  new_value: action === 'moved' ? 'Done' : '',
});

test('sentinel actor 의 board_update 프레임이 살아남고 저장된 actor_name 을 싣는다', async () => {
  const def = boardUpdateDef();
  // 티켓에 실측으로 기록된 sentinel 들 — 각각 실제 쓰기 경로가 있다.
  const cases = [
    ['auto-advance', 'moved'],   // trigger-loop.service.ts 의 auto-advance
    ['system', 'archived'],      // ticket-archiver.service.ts
    ['system', 'moved'],         // backlog-promotion.service.ts
    ['test-user', 'updated'],
  ];

  for (const [actorId, action] of cases) {
    const calls = [];
    const mapped = await def.map(sentinelActivity(actorId, action), mapCtx(pgLikeAgentRepo(calls)));

    assert.ok(mapped, `'${actorId}' / ${action} 의 프레임이 발행되어야 한다 (null 이면 유실)`);
    assert.equal(mapped.scope.board_id, BOARD_ID);
    assert.equal(mapped.payload.actor_id, actorId);
    assert.equal(
      mapped.payload.actor_name, actorId,
      'Agent 가 아닌 actor 는 저장된 actor_name 을 그대로 쓴다',
    );
    assert.equal(mapped.payload.action, action);
    assert.deepEqual(calls, [], 'sentinel 은 agents 조회에 닿지 않는다');
  }
});

test('실제 agent actor 는 여전히 <Manager>/<Agent> 로 정규화된다 (수정이 보강을 끄지 않았다)', async () => {
  const def = boardUpdateDef();
  const calls = [];
  const mapped = await def.map({
    ...sentinelActivity(AGENT_UUID, 'moved'),
    actor_name: 'Bob', // 쓰기 경로가 찍은 bare leaf 이름
  }, mapCtx(pgLikeAgentRepo(calls)));

  assert.ok(mapped);
  assert.equal(
    mapped.payload.actor_name, 'Rolf/Bob',
    'uuid actor 는 manager prefix 까지 붙은 정규 표시로 보강된다',
  );
  assert.deepEqual(calls, [AGENT_UUID]);
});

// ── 2차 방어: 이름 보강 실패가 프레임을 죽이지 못한다 ───────────────────────
// 1번 가드가 sentinel 을 막아도, uuid 모양 actor_id 로 들어온 조회가 다른 이유로
// 실패하면(연결 끊김, 권한, 또 다른 타입 불일치) 같은 방식으로 프레임이 사라진다.
// 그래서 events.controller 의 mapCtx 가 resolveAgentDisplayName 을 try/catch 로
// 감싼다 — 실패 시 warn 을 남기고 저장된 actor_name 으로 프레임을 내보낸다.

function alwaysThrowingAgentRepo() {
  return {
    async findOne() { throw new Error('agents 조회 실패 (연결 끊김 모사)'); },
    async find() { throw new Error('agents 조회 실패 (연결 끊김 모사)'); },
  };
}

function fakeReq() {
  const socket = { on() {}, setTimeout() {}, setKeepAlive() {} };
  return { query: { token: 'test-token' }, headers: {}, socket, on() {}, get ip() { return '127.0.0.1'; } };
}

test('EventsController 는 actor 이름 보강이 던져도 board_update 를 발행한다', async () => {
  const { EventsController } = await import(
    'file://' + path.join(DIST, 'modules', 'events', 'events.controller.js')
  );

  const warns = [];
  const logService = {
    info() {}, debug() {},
    warn(cat, msg, meta) { warns.push({ cat, msg, meta }); },
    error(cat, msg) { warns.push({ cat, msg, error: true }); },
  };
  const ticketRepo = {
    async findOne() {
      return { id: TICKET_ID, column_id: COLUMN_ID, parent_id: null, workspace_id: 'ws-1', base_repo_resource_id: 'repo-1' };
    },
  };
  const colRepo = {
    async findOne() { return { id: COLUMN_ID, board_id: BOARD_ID, name: 'Done', kind: 'done' }; },
  };
  const emptyRepo = { async findOne() { return null; }, async find() { return []; }, async count() { return 0; } };
  const authService = {
    async getSessionUser(token) {
      return token === 'test-token' ? { id: 'u1', name: 'Tester', email: 't@example.com' } : null;
    },
  };

  const controller = new EventsController(
    ticketRepo, colRepo, emptyRepo, emptyRepo, alwaysThrowingAgentRepo(),
    authService,
    { async validateApiKey() { return { valid: false }; } },
    logService,
    { async register() {}, async unregister() {}, async touch() {}, async listForAgent() { return []; }, list() { return []; } },
    { noteConnected() {}, noteDisconnected() {}, isConnected() { return false; } },
    { register() {} },
  );

  const observable = await controller.stream(fakeReq());
  // @Sse 는 `{ type, data: JSON 문자열 }` 을 내보낸다 — 전선에 실제로 나가는 모양 그대로 본다.
  const received = [];
  const sub = observable.subscribe({
    next: (msg) => received.push({ type: msg?.type, data: JSON.parse(msg?.data ?? 'null') }),
    error() {},
  });

  try {
    // uuid 모양 actor_id — 1번 가드를 통과해 실제로 조회를 시도하고, 그 조회가 던진다.
    activityEvents.emit('activity', {
      ...sentinelActivity(AGENT_UUID, 'moved'),
      actor_name: 'Bob',
    });
    // 핸들러가 async 라 microtask 가 비워질 틈을 준다.
    for (let i = 0; i < 50 && !received.some((m) => m.type === 'board_update'); i += 1) {
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    sub.unsubscribe();
    await controller.onModuleDestroy();
  }

  const frame = received.find((m) => m.type === 'board_update');
  assert.ok(frame, 'agents 조회가 던져도 board_update 프레임은 발행되어야 한다');
  assert.equal(frame.data.ticket_id, TICKET_ID);
  assert.equal(frame.data.board_id, BOARD_ID);
  assert.equal(frame.data.action, 'moved');
  assert.equal(
    frame.data.actor_name, 'Bob',
    '보강에 실패하면 저장된 actor_name 으로 떨어진다 (빈 문자열이 아니다)',
  );

  const sseWarn = warns.find((w) => w.cat === 'SSE' && !w.error && /actor/i.test(w.msg));
  assert.ok(sseWarn, '보강 실패는 조용히 넘기지 않고 SSE warn 으로 남긴다');
  assert.equal(sseWarn.meta?.actor_id, AGENT_UUID, 'warn 이 어느 actor 였는지 지목한다');
  assert.equal(
    warns.some((w) => w.error),
    false,
    '핸들러 바깥 catch 까지 올라가지 않았다 (올라갔다면 프레임이 유실됐다는 뜻)',
  );
});
