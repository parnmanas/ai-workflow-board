// 회귀 (티켓 dedff9a3): sentinel actor_id 가 쓴 활동의 board_update SSE 프레임이
// Postgres 에서 통째로 사라졌다.
//
// `ActivityLog.actor_id` 는 varchar 라 'system' / `rt-…` 같은 비-uuid 쓰기는 성공한다.
// 깨지던 쪽은 그 뒤 board_update 매핑의 actor 이름 보강이다:
// resolveAgentDisplayName() 이 가드 없이 uuid 컬럼(Postgres 에서 real uuid) 으로
// 조회를 쳐 `invalid input syntax for type uuid: "system"` 으로 throw 했고,
// events.controller 의 핸들러가 그 throw 를 catch 하면서 `eventSubject.next()` 를
// 건너뛰어 **프레임이 아예 발행되지 않았다**. 로그에만 남고 테스트는 green —
// 일회용 Postgres 16 로 `npm run test:qa:pg` 에서 43회, 같은 커밋 sqlite 는 0회.
//
// 보드 제거 후에도 `board_update` 는 티켓 변경 이벤트 이름으로 남는다
// (docs/tickets.md). 유실의 실질 피해는 agent-manager 의 `handleBoardUpdate` 다:
// 상태 이동(moved → done) 의 티켓 worktree 회수와 archived 의 QA/Security run
// workspace 회수가 이 프레임만 보고 돌고 대체 경로가 없다(10분 sweep 은 dirty
// 트리를 일부러 보존한다). 비-uuid actor 를 쓰는 대표 경로가 바로 그 둘이다 —
// ticket-archiver(archived, 'system'), 그리고 MCP move_ticket 으로 agent 가
// 직접 옮기는 상태 이동(callerActor → actor_id 가 런타임 identity 키 `rt-…`).
//
// 두 겹을 따로 검증한다. 가드(1)만 있으면 다른 종류의 조회 실패가 같은 방식으로
// 프레임을 죽이고, 2차 방어(2)만 있으면 Postgres 에 쓸모없는 쿼리를 계속 보낸다.
//   1) 레지스트리 — 실제 EVENT_TYPES 의 board_update map() 에 실제
//      resolveAgentDisplayName 을 꽂고, host 조회는 Postgres 처럼 비-uuid 에
//      **던지게** 한다. 가드를 되돌리면 map() 이 예외로 깨진다.
//   2) 컨트롤러 — 실제 EventsController 를 띄워 uuid 모양 actor_id + 항상
//      던지는 dataSource 로, 이름 보강 실패가 프레임을 죽이지 못함을 본다.
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
const WORKSPACE_ID = 'ws-1';
const PROJECT_ID = 'proj-1';
// MCP move_ticket 의 actor_id — callerActor() 가 caller.runtimeKey 를 쓴다.
const RUNTIME_KEY = 'rt-0123456789abcdef';

/** Postgres 의 uuid 컬럼을 모사한 scope — 비-uuid id 에 실제로 던진다.
 * P4c-4: Agent 행 없음 — AGENT_UUID 는 Host 행('Rolf')으로 해소된다. */
function pgLikeAgentRepo(calls) {
  const check = (id) => {
    calls.push(id);
    if (!UUID_SHAPE.test(String(id ?? ''))) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
  };
  const unwrap = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
  const hostFind = async (opts) => {
    const op = opts?.where?.id;
    const raw = unwrap(op);
    const ids = Array.isArray(raw) ? raw : [raw];
    // ApiKey OR 분기(where 배열)도 같은 엄격함으로 본다.
    const flat = Array.isArray(opts?.where)
      ? opts.where.flatMap((w) => [unwrap(w?.agent_id), unwrap(w?.host_id)])
      : ids;
    for (const id of flat) {
      if (id !== undefined) check(id);
    }
    return ids.filter((id) => id === AGENT_UUID).map((id) => ({ id, name: 'Rolf' }));
  };
  return {
    async findOne(opts) {
      check(opts?.where?.id);
      return null;
    },
    async find(opts) {
      return hostFind(opts);
    },
  };
}

/** P4c-4: resolveAgentDisplayName 은 scope(getRepository 보유)를 받는다. */
const asScope = (repo) => ({ getRepository: () => repo });

function boardUpdateDef() {
  const def = EVENT_TYPES.find((d) => d.eventType === 'board_update');
  assert.ok(def, 'EVENT_TYPES 에 board_update 정의가 있어야 한다');
  return def;
}

/** events.controller 의 mapCtx 와 같은 배선 — actor 해석만 실제 함수다. */
function mapCtx(agentRepo) {
  return {
    resolveTicketSnapshot: async () => ({
      root_id: TICKET_ID, workspace_id: WORKSPACE_ID, status: 'done', project_id: PROJECT_ID,
    }),
    resolveActorDisplayName: (actorId) => resolveAgentDisplayName(asScope(agentRepo), actorId),
  };
}

/** TicketService.move 와 ticket-archiver 가 실제로 쓰는 활동 모양. */
const sentinelActivity = (actorId, action) => ({
  ticket_id: TICKET_ID,
  entity_id: TICKET_ID,
  entity_type: 'ticket',
  action,
  field_changed: action === 'moved' ? 'status' : '',
  actor_id: actorId,
  actor_name: actorId,
  old_value: action === 'moved' ? 'in_progress' : '',
  new_value: action === 'moved' ? 'done' : '',
});

test('sentinel actor 의 board_update 프레임이 살아남고 저장된 actor_name 을 싣는다', async () => {
  const def = boardUpdateDef();
  // 비-uuid actor 들 — 각각 실제 쓰기 경로가 있다.
  const cases = [
    [RUNTIME_KEY, 'moved'],      // MCP move_ticket (ticket-workflow-tools.ts → callerActor)
    ['system', 'archived'],      // ticket-archiver.service.ts
    ['system', 'updated'],       // agent-api.controller.ts 의 silent-exit dedupe
    ['test-user', 'updated'],
  ];

  for (const [actorId, action] of cases) {
    const calls = [];
    const mapped = await def.map(sentinelActivity(actorId, action), mapCtx(pgLikeAgentRepo(calls)));

    assert.ok(mapped, `'${actorId}' / ${action} 의 프레임이 발행되어야 한다 (null 이면 유실)`);
    assert.equal(mapped.scope.workspace_id, WORKSPACE_ID);
    assert.equal(mapped.payload.actor_id, actorId);
    assert.equal(
      mapped.payload.actor_name, actorId,
      'Agent 가 아닌 actor 는 저장된 actor_name 을 그대로 쓴다',
    );
    assert.equal(mapped.payload.action, action);
    assert.deepEqual(calls, [], 'sentinel 은 agents 조회에 닿지 않는다');
  }
});

test('실제 agent actor 는 Host bare display 로 보강된다 (수정이 보강을 끄지 않았다)', async () => {
  const def = boardUpdateDef();
  const calls = [];
  const mapped = await def.map({
    ...sentinelActivity(AGENT_UUID, 'moved'),
    actor_name: 'Bob', // 쓰기 경로가 찍은 bare leaf 이름
  }, mapCtx(pgLikeAgentRepo(calls)));

  assert.ok(mapped);
  assert.equal(
    mapped.payload.actor_name, 'Rolf',
    'uuid actor 는 Host display 로 보강된다 (P4c-4: prefix 합성 없음)',
  );
  assert.ok(calls.includes(AGENT_UUID), 'uuid actor 는 조회에 닿아야 한다 (가드가 공허하면 안 된다)');
});

// ── 2차 방어: 이름 보강 실패가 프레임을 죽이지 못한다 ───────────────────────
// 1번 가드가 sentinel 을 막아도, uuid 모양 actor_id 로 들어온 조회가 다른 이유로
// 실패하면(연결 끊김, 권한, 또 다른 타입 불일치) 같은 방식으로 프레임이 사라진다.
// 그래서 events.controller 의 mapCtx 가 resolveAgentDisplayName 을 try/catch 로
// 감싼다 — 실패 시 warn 을 남기고 저장된 actor_name 으로 프레임을 내보낸다.

function alwaysThrowingDataSource() {
  // 컨트롤러의 resolveAgentDisplayName(this.dataSource, …) — getRepository 자체가 던진다.
  return {
    getRepository() { throw new Error('agents 조회 실패 (연결 끊김 모사)'); },
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
      return { id: TICKET_ID, status: 'done', parent_id: null, workspace_id: WORKSPACE_ID, project_id: PROJECT_ID };
    },
  };
  const emptyRepo = { async findOne() { return null; }, async find() { return []; }, async count() { return 0; } };
  const authService = {
    async getSessionUser(token) {
      return token === 'test-token' ? { id: 'u1', name: 'Tester', email: 't@example.com' } : null;
    },
  };

  const controller = new EventsController(
    ticketRepo, alwaysThrowingDataSource(),
    /* hostRepo */ emptyRepo, /* apiKeyRepo */ emptyRepo,
    authService,
    { async validateApiKey() { return { valid: false }; } },
    logService,
    { async register() {}, async unregister() {}, async touch() {}, async listForAgent() { return []; }, list() { return []; } },
    { noteConnected() {}, noteDisconnected() {}, isConnected() { return false; } },
    /* MemoryMetricsRegistry */ { register() {} },
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
  assert.equal(frame.data.workspace_id, WORKSPACE_ID);
  assert.equal(frame.data.action, 'moved');
  // 구버전 매니저의 terminal 회수가 읽는 컬럼 투영은 status 에서 파생된다.
  assert.equal(frame.data.status, 'done');
  assert.equal(frame.data.current_column_kind, 'terminal');
  assert.equal(frame.data.previous_column_name, 'In Progress');
  assert.equal(frame.data.new_column_name, 'Done');
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
