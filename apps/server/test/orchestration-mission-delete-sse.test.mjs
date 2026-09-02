// 미션 삭제가 목록 화면까지 전파되는지 — producer 쪽 검증 (티켓 03ca8b5b, 리뷰 라운드 1).
//
// 리뷰 지적: 사이드바 WORK > Orchestrations 는 삭제된 미션을 계속 보여주고 클릭 시
// 사라진 상세로 보낸다. 삭제는 REST `DELETE /api/orchestration/missions/:id` 로만
// 일어나므로 브라우저 내 커스텀 이벤트로는 절대 알 수 없고, 서버가 프레임을 쏴야 한다.
//
// 이 파일은 **producer 쪽 실제 wire payload**를 고정한다:
//   1. 스텁이 아닌 실제 OrchestrationMissionService.deleteMission() 을 in-memory
//      fake repo 위에서 구동해, activityEvents 로 나가는 raw 이벤트를 잡는다.
//   2. 그 raw 이벤트를 events.controller.ts 가 하는 그대로
//      (def.map() → envelope → def.flatten() → JSON.stringify) 실제 event-registry
//      정의에 통과시켜 **최종 SSE 바이트**에 deleted=true 가 살아있는지 본다.
//      event-registry 의 map() 은 payload 를 필드별로 손으로 재구성하므로, 여기서
//      키를 빠뜨리면 타입체크·기존 테스트를 모두 통과하면서 wire 에서만 조용히
//      사라진다(event-registry-payload-parity-guard.test.mjs 헤더 참조).
//   3. 상태 변화 프레임(emitUpdate)에는 deleted 가 false 로 나가는지도 확인한다 —
//      false positive 면 살아있는 미션이 목록에서 지워진다.
//
// 소비자(사이드바) 쪽은 apps/client/test/sidebar-work-hierarchy.test.mjs 가
// 여기서 만든 것과 같은 wire payload 를 실제 SSE 경로로 흘려 검증한다.
//
// 실행: node --test --test-force-exit apps/server/test/orchestration-mission-delete-sse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const { OrchestrationMissionService } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')).href
);
const { activityEvents } = await import(
  pathToFileURL(path.join(DIST, 'services', 'activity.service.js')).href
);
const { EVENT_TYPES } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'events', 'event-registry.js')).href
);

const WS = 'ws-1';

function matches(row, where) {
  return Object.entries(where || {}).every(([key, cond]) => row[key] === cond);
}

/** deleteMission 이 실제로 건드리는 것만 진짜처럼 동작하는 in-memory repo. */
function makeRepo(rows) {
  return {
    rows,
    async find(opts = {}) {
      return rows.filter((r) => matches(r, opts.where));
    },
    async findOne({ where }) {
      return rows.find((r) => matches(r, where)) ?? null;
    },
    async save(row) {
      return row;
    },
    async delete(where) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], where)) rows.splice(i, 1);
      }
      return { affected: 1 };
    },
  };
}

function makeMission(overrides = {}) {
  return {
    id: 'mission-1',
    workspace_id: WS,
    team_id: 'team-1',
    title: 'Ship the nav',
    status: 'completed',
    plan_version: 3,
    ...overrides,
  };
}

const noopRepo = makeRepo([]);
const logService = { info() {}, warn() {}, error() {}, debug() {} };

function makeService({ missions, steps = [], events = [] }) {
  return new OrchestrationMissionService(
    makeRepo(missions),
    makeRepo(steps),
    makeRepo(events),
    noopRepo,
    noopRepo,
    noopRepo,
    {},
    logService,
  );
}

/** activityEvents 로 나가는 orchestration_update raw 이벤트를 모은다. */
async function captureFrames(fn) {
  const frames = [];
  const listener = (payload) => frames.push(payload);
  activityEvents.on('orchestration_update', listener);
  try {
    await fn();
    // emitUpdate 는 stepRepo 조회 후 .then 안에서 쏘므로 마이크로태스크를 비운다.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    activityEvents.off('orchestration_update', listener);
  }
  return frames;
}

/**
 * events.controller.ts 의 파이프라인을 그대로 재현해 최종 SSE 바이트를 만든다.
 * def.map() 만 보면 실제로 나가는 shape 가 아니다 — 컨트롤러가 envelope 로 감싸고
 * flatten() 을 거친 뒤 JSON.stringify 한 것이 진짜 wire 다.
 */
async function wireBytes(eventType, rawEvent) {
  const def = EVENT_TYPES.find((d) => d.eventType === eventType);
  assert.ok(def, `EVENT_TYPES must include ${eventType}`);
  const mapped = await def.map(rawEvent, {});
  assert.ok(mapped, `${eventType} map() returned nothing`);
  const envelope = {
    event_type: def.eventType,
    scope: mapped.scope,
    payload: mapped.payload,
    timestamp: mapped.timestamp || new Date(0).toISOString(),
  };
  return JSON.stringify(def.flatten ? def.flatten(envelope) : envelope);
}

test('deleteMission() 은 deleted=true 인 orchestration_update 를 실제로 쏜다', async () => {
  const mission = makeMission();
  const service = makeService({
    missions: [mission],
    steps: [{ id: 'step-1', mission_id: mission.id, status: 'done' }],
    events: [{ id: 'event-1', mission_id: mission.id }],
  });

  const frames = await captureFrames(() => service.deleteMission(mission.id, WS));

  assert.equal(frames.length, 1, '삭제 프레임이 정확히 한 번 나가야 한다');
  const frame = frames[0];
  assert.equal(frame.deleted, true);
  assert.equal(frame.mission_id, mission.id);
  assert.equal(frame.workspace_id, WS);
  // 소비자가 워크스페이스 필터에 쓰는 필드들이 삭제 프레임에도 실려야 한다.
  assert.equal(frame.team_id, 'team-1');
  assert.equal(typeof frame.timestamp, 'string');
});

test('삭제를 거부당하면(진행 중 미션) 프레임을 쏘지 않는다', async () => {
  const mission = makeMission({ status: 'running' });
  const service = makeService({ missions: [mission] });

  const frames = await captureFrames(async () => {
    await assert.rejects(() => service.deleteMission(mission.id, WS));
  });

  assert.deepEqual(frames, [], '삭제되지 않았는데 삭제 프레임이 나가면 목록에서 산 미션이 사라진다');
});

test('삭제 프레임의 최종 SSE 바이트에 deleted=true 가 살아남는다', async () => {
  const mission = makeMission();
  const service = makeService({ missions: [mission] });
  const [frame] = await captureFrames(() => service.deleteMission(mission.id, WS));

  const bytes = await wireBytes('orchestration_update', frame);
  const wire = JSON.parse(bytes);

  assert.equal(wire.event_type, 'orchestration_update');
  assert.equal(wire.deleted, true, 'event-registry map() 이 deleted 를 떨어뜨렸다');
  assert.equal(wire.mission_id, mission.id);
  assert.equal(wire.workspace_id, WS);
  // 소비자가 실제로 읽는 키들이 그대로 있어야 한다.
  assert.equal(typeof wire.title, 'string');
  assert.ok(wire.counts, 'counts 가 wire 에서 사라졌다');
});

test('상태 변화 프레임의 최종 SSE 바이트는 deleted=false 다', async () => {
  const mission = makeMission({ status: 'running' });
  const service = makeService({
    missions: [mission],
    steps: [{ id: 'step-1', mission_id: mission.id, status: 'done' }],
  });

  const [frame] = await captureFrames(async () => {
    service.emitUpdate(mission);
  });
  assert.ok(frame, 'emitUpdate 가 프레임을 쏘지 않았다');

  const wire = JSON.parse(await wireBytes('orchestration_update', frame));
  assert.equal(
    wire.deleted,
    false,
    'deleted 가 true 로 새면 살아있는 미션이 목록에서 지워진다',
  );
  assert.equal(wire.mission_id, mission.id);
});
