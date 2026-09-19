// 회귀 테스트: `recordEvent` fail-open 이 한 미션에서 두 번 나도 타임라인 커서가
// 이벤트를 잃지 않는다 — 티켓 7b679009.
//
// 무엇이 깨져 있었나
// ─────────────────
//
// `recordEvent` 는 직렬화 트랜잭션(미션 row 잠금 + `MAX(write_seq) + 1`)이 실패하면
// `write_seq: 0`("순서 미상")으로 타임라인 행만 남기고 넘어간다. 이 fail-open 자체는
// 의도된 degrade 다 — 타임라인 한 줄 때문에 dispatch 를 죽이지 않는다는 계약이다.
//
// 문제는 **한 미션에서 두 번 이상** 발동했을 때다. `listMissionEvents` 의 keyset 술어는
// `(created_at < :beforeAt OR (tied AND write_seq < :beforeSeq))` 인데, 커서가 seq 0 행을
// 가리키면 tie-break 는 `0 < 0` 으로 항상 거짓이고 첫 분기는 같은 시각 그룹을 통째로
// 제외한다. 결과적으로 **같은 시각의 나머지 seq 0 행이 페이지 경계에서 조용히 사라진다**
// — write_seq 컬럼이 존재하는 이유였던 바로 그 손실이다(티켓 4d065f82).
//
// 고친 방식은 커서에 **안정 키(`id`)를 마지막 단으로** 더한 것이다. 생산자의 `write_seq: 0`
// 은 그대로 둔다 — 동률의 원인(fail-open, 백필 전 레거시 구간, 미래의 생산자 회귀)과
// 무관하게 소비자가 항상 전순서를 갖는 쪽이 보장이 강하기 때문이다.
//
// 왜 fail-open 을 진짜로 발동시키는가
// ──────────────────────────────────
//
// `write_seq = 0` 인 행을 직접 INSERT 해도 같은 데이터 모양은 만들 수 있지만, 그러면
// "fail-open 이 행을 남긴다" 는 계약(완료 조건 2)은 검증되지 않는다. 그래서 production 의
// `recordEvent` 를 그대로 부르되 `dataSource.transaction` 만 실패시켜 **실제 catch 경로**를
// 태운다. 로그와 저장된 행 둘 다로 그 경로가 돌았음을 확인한다.
//
// `created_at` 은 원시 UPDATE 로 고정한다
// ──────────────────────────────────────
//
// 두 fail-open 이 같은 tied group 에 들어가느냐가 러너 속도로 정해지면 단언이 wall-clock
// 에 의존한다. sqljs 의 `@CreateDateColumn` 자동 값은 `datetime('now')` 라 **소수점 없는
// 초 단위 문자열**이고 커서의 tied 판정도 같은 형식의 문자열 등호이므로, 행은 정상
// 저장한 뒤 `created_at` 만 그 형식 그대로 원시 UPDATE 한다(엔티티에 Date 를 박으면
// `'....000'` 이 되어 등호가 영영 빗나간다 — backfill 테스트 헤더와 같은 이유다).
//
// Postgres 쪽(마이크로초 정밀도에서 같은 불변식이 서는가)은 이 파일이 재현할 수 없어
// `qa-flows/orchestration-event-write-seq-pg.test.mjs` 에 같은 이름의 케이스로 있다.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { Agent } from '../dist/entities/Agent.js';
import { OrchestrationMission } from '../dist/entities/OrchestrationMission.js';
import { OrchestrationStep } from '../dist/entities/OrchestrationStep.js';
import { OrchestrationEvent } from '../dist/entities/OrchestrationEvent.js';
import { OrchestrationTeam } from '../dist/entities/OrchestrationTeam.js';
import { OrchestrationTeamMember } from '../dist/entities/OrchestrationTeamMember.js';
import { OrchestrationMissionService } from '../dist/modules/orchestration/orchestration-mission.service.js';

const WS = '11111111-1111-4111-8111-111111111111';

/** 초 단위, 소수점 없음 — sqljs 의 `datetime('now')` 와 같은 형식이어야 tied 등호가 선다. */
const SECOND_BEFORE = '2026-09-20 04:00:01';
const SECOND_FAIL_OPEN = '2026-09-20 04:00:02';
const SECOND_AFTER = '2026-09-20 04:00:03';

let dataSource;
let missionService;
let eventRepo;
let warned;

async function seedMission(title) {
  const missionRepo = dataSource.getRepository(OrchestrationMission);
  return missionRepo.save(missionRepo.create({
    workspace_id: WS,
    team_id: 'team-1',
    title,
    objective: 'fail-open cursor fixture',
    status: 'running',
    created_by_type: 'user',
    created_by: '33333333-3333-4333-8333-333333333333',
  }));
}

/** production 의 `recordEvent` 를 그대로 부르고 방금 쓴 행을 돌려준다. */
async function record(mission, message) {
  await missionService.recordEvent(mission, { type: 'note', message });
  const row = await eventRepo.findOne({ where: { mission_id: mission.id, message } });
  assert.ok(row, `"${message}" 이벤트가 저장돼야 한다`);
  return row;
}

/**
 * 직렬화 트랜잭션만 실패시켜 `recordEvent` 의 fail-open 경로를 태운다.
 *
 * 서비스는 주입된 DataSource 인스턴스를 그대로 들고 있으므로 메서드 하나만 바꿔 끼우면
 * 나머지(행 구성, 안쪽 `eventRepo.save`, 로그)는 전부 production 코드가 돈다.
 */
async function withBrokenTransaction(fn) {
  const original = dataSource.transaction;
  dataSource.transaction = async () => {
    throw new Error('injected: serialized event write failed');
  };
  try {
    return await fn();
  } finally {
    dataSource.transaction = original;
  }
}

/** 한 행의 `created_at` 만 픽스처가 정한 초로 고정한다(`write_seq` 는 건드리지 않는다). */
async function pinCreatedAt(id, literal) {
  await dataSource.query('UPDATE orchestration_events SET created_at = ? WHERE id = ?', [literal, id]);
}

/**
 * 커서로 타임라인을 끝까지 순회해 본 이벤트 id 를 순서대로 돌려준다.
 *
 * `withId=false` 는 **고치기 전 커서 모양**(at, seq 2단)이다. 같은 픽스처에서 둘을 모두
 * 돌려 "고치기 전에는 실제로 잃는다" 를 같은 실행 안에서 보인다 — 비공허성.
 */
async function walkTimeline(missionId, limit, withId) {
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const res = await missionService.listMissionEvents(missionId, WS, {
      limit,
      before_at: cursor?.at,
      before_seq: cursor?.seq,
      ...(withId ? { before_id: cursor?.id } : {}),
    });
    for (const e of res.events) seen.push(e.id);
    cursor = res.next_cursor;
    if (!res.has_more) break;
  }
  return seen;
}

before(async () => {
  dataSource = new DataSource({
    type: 'sqljs',
    entities: [Agent, OrchestrationMission, OrchestrationStep, OrchestrationEvent, OrchestrationTeam, OrchestrationTeamMember],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  eventRepo = dataSource.getRepository(OrchestrationEvent);

  warned = [];
  missionService = new OrchestrationMissionService(
    dataSource.getRepository(OrchestrationMission),
    dataSource.getRepository(OrchestrationStep),
    eventRepo,
    dataSource.getRepository(OrchestrationTeam),
    dataSource.getRepository(OrchestrationTeamMember),
    dataSource.getRepository(Agent),
    dataSource,
    {
      info() {}, debug() {}, error() {},
      warn: (...args) => warned.push(args.join(' ')),
    },
  );
});

after(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('fail-open write_seq=0 이 두 번 난 미션의 타임라인 커서', () => {
  it('fail-open 은 여전히 타임라인 행을 남기고, 커서는 전량을 덮는다', async () => {
    const mission = await seedMission('fail-open twice');

    // ── 정상 기록 3건 → seq 1..3 ──
    const before = [];
    for (const n of [1, 2, 3]) before.push(await record(mission, `before ${n}`));
    assert.deepEqual(
      before.map((e) => e.write_seq), [1, 2, 3],
      '정상 경로는 MAX(write_seq) + 1 로 단조 증가해야 한다 — 어긋나면 픽스처 전제가 깨진 것이다',
    );

    // ── fail-open 2건 ──
    const failOpen = await withBrokenTransaction(async () => [
      await record(mission, 'fail-open A'),
      await record(mission, 'fail-open B'),
    ]);

    // 완료 조건 2: 기록 자체가 막히지 않는다. 행이 남고, 값은 "순서 미상"인 0 이다.
    assert.deepEqual(
      failOpen.map((e) => e.write_seq), [0, 0],
      'fail-open 은 write_seq 0 으로라도 타임라인 행을 남겨야 한다 — 이게 막히면 ' +
        '"타임라인 한 줄 때문에 dispatch 를 죽이지 않는다" 는 계약이 좁아진다',
    );
    assert.equal(
      warned.filter((l) => l.includes('retrying unordered')).length, 2,
      'fail-open 경로가 실제로 두 번 돌았어야 한다 — 로그가 없으면 트랜잭션이 그냥 성공한 것이고 픽스처가 공허하다',
    );

    // ── fail-open 뒤의 정상 기록 → 0 이 최댓값을 끌어내리지 않는다 ──
    const resumed = await record(mission, 'after 1');
    assert.equal(resumed.write_seq, 4, 'seq 0 이 섞여도 다음 정상 기록은 MAX + 1 이어야 한다');

    // ── created_at 고정: fail-open 두 행만 같은 초에 둔다 ──
    for (const e of before) await pinCreatedAt(e.id, SECOND_BEFORE);
    for (const e of failOpen) await pinCreatedAt(e.id, SECOND_FAIL_OPEN);
    await pinCreatedAt(resumed.id, SECOND_AFTER);

    // 픽스처 가드: 두 fail-open 행이 정말 같은 tied group 에 있어야 tie-break 가 load-bearing 하다.
    const pinned = await dataSource.query(
      'SELECT created_at FROM orchestration_events WHERE id IN (?, ?)',
      [failOpen[0].id, failOpen[1].id],
    );
    assert.deepEqual(
      pinned.map((r) => String(r.created_at)), [SECOND_FAIL_OPEN, SECOND_FAIL_OPEN],
      'fail-open 두 행이 같은 초에 있어야 커서가 동률 군집 한가운데를 가리킨다',
    );

    const all = [...before, ...failOpen, resumed].map((e) => e.id);

    // ── 비공허성: 옛 (at, seq) 2단 커서는 실제로 잃는다 ──
    const walkedLegacy = await walkTimeline(mission.id, 1, false);
    assert.ok(
      walkedLegacy.length < all.length,
      '(at, seq) 2단 커서는 seq 동률 군집에서 행을 잃어야 한다 — 이 단언이 실패하면 ' +
        `픽스처가 결함을 재현하지 못한 것이다 (순회 ${walkedLegacy.length} / 전체 ${all.length})`,
    );

    // ── 제품 불변식: (at, seq, id) 3단 커서는 하나도 빠뜨리지 않는다 ──
    // limit 1 은 페이지 경계를 모든 행 사이에 한 번씩 놓아, 동률 군집 안쪽을 반드시 가리키게 한다.
    for (const limit of [1, 2, 3]) {
      const walked = await walkTimeline(mission.id, limit, true);
      assert.equal(
        new Set(walked).size, walked.length,
        `limit=${limit}: 커서가 같은 이벤트를 두 번 돌려줬다 (중복 ${walked.length - new Set(walked).size}건)`,
      );
      assert.deepEqual(
        [...walked].sort(), [...all].sort(),
        `limit=${limit}: 커서 순회가 ${walked.length}/${all.length} 건만 덮었다 — ` +
          'seq 동률 군집을 id 로 가르지 못하면 같은 시각의 나머지가 페이지 경계에서 사라진다',
      );
    }

    // ── 순서 계약: 최신 → 과거, 같은 시각 안에서는 seq 내림차순, seq 동률이면 id 내림차순 ──
    const byId = new Map((await eventRepo.find({ where: { mission_id: mission.id } })).map((e) => [e.id, e]));
    const order = (await walkTimeline(mission.id, 2, true)).map((id) => byId.get(id));
    for (let i = 1; i < order.length; i += 1) {
      const prev = order[i - 1];
      const cur = order[i];
      const prevAt = new Date(prev.created_at).getTime();
      const curAt = new Date(cur.created_at).getTime();
      const ordered = curAt < prevAt
        || (curAt === prevAt && cur.write_seq < prev.write_seq)
        || (curAt === prevAt && cur.write_seq === prev.write_seq && cur.id < prev.id);
      assert.ok(
        ordered,
        '커서 순회 결과가 (created_at, write_seq, id) 내림차순이 아니다: ' +
          `${prev.message}(seq ${prev.write_seq}) 다음에 ${cur.message}(seq ${cur.write_seq})`,
      );
    }
  });

  it('id 없는 옛 커서로 불러도 기록은 계속 읽힌다 — 구 클라이언트가 깨지지 않는다', async () => {
    // 동률이 없는 평범한 미션에서는 2단 커서와 3단 커서의 결과가 같아야 한다.
    // 이 단언이 없으면 "id 를 안 보내면 degrade" 가 "id 를 안 보내면 고장" 으로 바뀌어도 모른다.
    const mission = await seedMission('no ties');
    const ids = [];
    for (const n of [1, 2, 3, 4, 5]) ids.push((await record(mission, `plain ${n}`)).id);

    assert.deepEqual(
      (await walkTimeline(mission.id, 2, false)).sort(), [...ids].sort(),
      'seq 동률이 없으면 옛 2단 커서도 전량을 덮어야 한다',
    );
    assert.deepEqual(
      await walkTimeline(mission.id, 2, true), await walkTimeline(mission.id, 2, false),
      '동률이 없는 미션에서는 3단 커서가 2단 커서와 같은 순서를 돌려줘야 한다',
    );
  });
});
