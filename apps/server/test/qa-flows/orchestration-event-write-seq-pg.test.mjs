// 회귀 테스트 (Postgres 전용): 오케스트레이션 이벤트 write_seq 의 created_at 정밀도 — 티켓 85efcb69.
//
// 무엇이 깨져 있었나
// ─────────────────
//
// `orchestration-mission.service.ts` 는 같은 시각에 몰린 이벤트의 순서를 `write_seq` 로
// 정한다. 그 값은 쓰기 시점에 "이 미션의 가장 최근 created_at 과 같은 시각인 row"(tied
// group)를 조회해 그 안의 최댓값 + 1 로 유도한다. 그런데 그 조회가 등호 하나였다.
//
//     .andWhere('e.created_at = :tiedAt', { tiedAt: sinceBoundaryParam(ds, mostRecent.created_at) })
//
// Postgres 의 `@CreateDateColumn()` 은 INSERT 시 CURRENT_TIMESTAMP 로 채워지고 `timestamp`
// 기본 정밀도는 마이크로초다. 그 row 를 엔티티로 읽으면 JS Date 라 밀리초까지만 남고,
// 그 값을 등호로 되돌리면 **자기 자신을 포함해 한 행도 일치하지 않는다.** tied 가 항상
// 비므로 max 는 늘 0, 즉 **write_seq 가 영원히 1** 이다. 같은 결함의 자매 지점인
// `add_comment` 쪽에서는 라이브 Postgres 실측으로 확인됐다(티켓 3건·코멘트 45건에서
// `_comment_write_seq` 최댓값이 전부 1).
//
// 같은 등호가 소비자인 `listMissionEvents()` 의 keyset 술어에도 있었다. 커서의 `at` 은
// `new Date(last.created_at).toISOString()` 이라 역시 밀리초까지만 남으므로, tie-break
// 분기가 Postgres 에서 한 번도 매칭되지 않는다. 그 결과 **커서와 같은 밀리초에 몰린
// 나머지 이벤트가 페이지 경계에서 통째로 사라진다** — write_seq 가 존재하는 이유가
// 바로 그 손실을 막는 것이므로, 두 곳을 함께 고쳐야 의미가 있다.
//
// 왜 Postgres 전용인가
// ───────────────────
//
// sqljs 는 저장 포맷이 초 단위 문자열이라 이 실패 모드 자체가 재현되지 않는다. sqljs 쪽
// 커서 완결성은 `qa-flows/orchestration-recovery.test.mjs` 의 "타임라인은 커서로 과거를
// 계속 가져올 수 있고 같은 초 burst 도 건너뛰지 않는다" 가 이미 고정하고 있지만, 그
// green 을 Postgres 의 보장으로 간주하면 안 된다(보드 교훈). 이 파일이 진짜 마이크로초
// 타임스탬프 위에서 같은 불변식을 다시 세운다.
//
// SKIP 규약: `DB_TYPE=postgres` 일 때만 실행된다(CI `test:qa:pg` 매트릭스). 기본 sqljs
// 실행에서는 사유를 남기고 자체 스킵하므로 어디서든 green 이다. 작성 환경(담당자
// 샌드박스)에는 Postgres 가 없으므로 **실제 green 은 pg 매트릭스에서 나온다** —
// qa-flows/orchestration-confirm-reminder-pg-cast.test.mjs 와 같은 규약이다.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

const SCHEMA = `qa_orchwriteseq_${process.pid}`;
const WS = 'ws-orch-write-seq';
const TEAM = 'team-orch-write-seq';

let ds;

function pgConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ai_workflow',
  };
}

after(async () => {
  try { if (ds?.isInitialized) await ds.destroy(); } catch { /* best-effort */ }
  if (IS_PG) {
    try {
      const { Client } = await import('pg');
      const c = new Client(pgConfig());
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await c.end();
    } catch { /* best-effort cleanup */ }
  }
});

let booted = null;

/**
 * 부팅은 파일 전체에서 한 번만 한다 — 테스트마다 다시 부팅하면 두 번째의
 * `DROP SCHEMA ... CASCADE` 가 첫 DataSource 의 열린 커넥션 아래에서 스키마를 날린다.
 * 테스트 간 격리는 각자 자기 미션을 만들어 mission_id 로 확보한다.
 */
async function bootOnce() {
  if (!booted) booted = await bootService();
  booted.logged.length = 0;
  return booted;
}

/**
 * 실서비스 그대로의 `OrchestrationMissionService` 를 진짜 Postgres DataSource 위에 세운다.
 *
 * 쿼리를 테스트가 다시 써서 단언하면 production 이 무엇을 보내는지는 검증되지 않는다 —
 * 생산자(`recordEvent`)와 소비자(`listMissionEvents`) 둘 다 공개 메서드를 그대로 호출한다.
 */
async function bootService() {
  if (!/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) throw new Error(`unsafe pg schema: ${SCHEMA}`);

  const { Client } = await import('pg');
  const admin = new Client(pgConfig());
  await admin.connect();
  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
  await admin.end();

  process.env.DB_SCHEMA = SCHEMA;

  const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
  const entities = await import('file://' + path.join(DIST, 'entities', 'index.js'));
  const { OrchestrationMissionService } = await import(
    'file://' + path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')
  );
  const { DataSource } = await import('typeorm');

  ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();

  assert.equal(
    ds.options.type, 'postgres',
    '이 파일은 진짜 Postgres 타임스탬프 정밀도에서만 의미가 있다 — 드라이버가 다르면 검증이 공허하다',
  );

  // recordEvent 는 실패를 삼키고 로그만 남기는 계약이다(타임라인 한 줄 때문에 dispatch 를
  // 죽이지 않기 위해). 그래서 서비스 배선이 틀리면 "이벤트가 0건" 으로만 보이고 원인이
  // 숨는다 — 에러를 모아 두었다가 각 케이스 끝에서 비어 있는지 단언한다.
  const logged = [];
  const logService = {
    error: (...args) => logged.push(args.join(' ')),
    warn() {}, info() {}, debug() {},
  };

  const missions = new OrchestrationMissionService(
    ds.getRepository(entities.OrchestrationMission),
    ds.getRepository(entities.OrchestrationStep),
    ds.getRepository(entities.OrchestrationEvent),
    ds.getRepository(entities.OrchestrationTeam),
    ds.getRepository(entities.OrchestrationTeamMember),
    ds.getRepository(entities.Agent),
    ds,
    logService,
  );

  return {
    missions,
    logged,
    missionRepo: ds.getRepository(entities.OrchestrationMission),
    eventRepo: ds.getRepository(entities.OrchestrationEvent),
  };
}

function newMission(missionRepo, title) {
  return missionRepo.save(missionRepo.create({
    workspace_id: WS, team_id: TEAM, title, status: 'running',
  }));
}

/**
 * 같은 **밀리초** 안에 서로 다른 **마이크로초** 꼬리를 갖는 tied group 을 만든다.
 *
 * 이게 프로덕션의 실제 모양이다: fan-out 한 번이면 수십 건이 같은 밀리초에 떨어지고,
 * 각각은 µs 꼬리로만 구분된다. 꼬리가 .000 이면 옛 등호가 우연히 성립해 이 테스트가
 * 공허해지므로, 꼬리가 반드시 0 이 아니도록 SQL 쪽에서 직접 만든다(JS Date 를 바인딩하면
 * 밀리초로 잘려 그 공허한 상태가 된다).
 *
 * 꼬리는 137 의 배수라 5건까지는 685 로 세 자리를 넘지 않는다 — 넘으면 다음 밀리초로
 * 새어 나가 tied group 이 쪼개지므로, assertFixtureIsMicrosecondTied 가 그것도 잡는다.
 */
async function forceTiedTimestamps(dataSource, ids, msLiteral) {
  for (let i = 0; i < ids.length; i += 1) {
    // 꼬리는 JS 에서 만들어 timestamp 로 명시 캐스트한다 — SQL 쪽 interval 산술은
    // 연산자 해석이 모호할 수 있고, 여기서 필요한 건 결정적인 µs 값뿐이다.
    const tail = String(137 * (i + 1)).padStart(3, '0');
    await dataSource.query(
      'UPDATE orchestration_events SET created_at = $2::timestamp WHERE id = $1::uuid',
      [ids[i], `${msLiteral}${tail}`],
    );
  }
}

/** 픽스처가 정말로 "같은 ms + 0 아닌 µs 꼬리" 인지 확인한다 — 아니면 회귀가 통과해 버린다. */
async function assertFixtureIsMicrosecondTied(dataSource, ids, label) {
  const rows = await dataSource.query(
    `SELECT id,
            date_trunc('milliseconds', created_at) AS ms,
            (EXTRACT(MICROSECONDS FROM created_at)::bigint % 1000) AS us_tail
       FROM orchestration_events
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  assert.equal(rows.length, ids.length, `${label}: 픽스처 row 를 전부 찾지 못했다`);

  const distinctMs = new Set(rows.map((r) => String(r.ms)));
  assert.equal(
    distinctMs.size, 1,
    `${label}: tied group 이 같은 밀리초에 있어야 tie-break 절이 load-bearing 해진다 (관측된 ms ${distinctMs.size}종)`,
  );
  const zeroTails = rows.filter((r) => Number(r.us_tail) === 0);
  assert.deepEqual(
    zeroTails.map((r) => r.id), [],
    `${label}: µs 꼬리가 0 인 row 가 있으면 옛 등호가 우연히 성립해 회귀가 통과한다 — 픽스처가 결함을 재현하지 못한다`,
  );
}

test('Postgres: 이벤트 write_seq 가 1 에 고정되지 않고 단조 증가한다', { skip: SKIP }, async () => {
  const { missions, logged, missionRepo, eventRepo } = await bootOnce();

  // ── 케이스 1: 연속 기록 — 결함의 직접 지문 ─────────────────────────────
  // 등호 비교는 µs 꼬리 때문에 타임스탬프가 겹치든 말든 **항상** 0건이라, 평범한
  // 연속 기록만으로도 seq 가 전부 1 로 나온다. 라이브에서 관측된 바로 그 모양이다.
  {
    const mission = await newMission(missionRepo, '연속 기록 단조성');
    for (const n of [1, 2, 3, 4]) {
      await missions.recordEvent(mission, { type: 'note', message: `연속 ${n}` });
    }
    assert.deepEqual(logged, [], 'recordEvent 가 조용히 실패했다 — 서비스 배선이나 스키마 문제다');

    const rows = await eventRepo.find({
      where: { mission_id: mission.id },
      order: { created_at: 'ASC', write_seq: 'ASC' },
    });
    assert.equal(rows.length, 4, '이벤트 4건이 모두 저장돼야 한다');
    assert.deepEqual(
      rows.map((e) => e.write_seq), [1, 2, 3, 4],
      `write_seq 가 ${JSON.stringify(rows.map((e) => e.write_seq))} 였다 — 전부 1 이면 tied-group 조회가 ` +
      '0건을 반환한다는 뜻이고, 그 상태에서는 커서의 타이브레이커가 통째로 사라진다.',
    );
  }

  // ── 케이스 2: 이미 쌓인 tied group 위에 기록 — 최댓값 + 1 을 집는가 ────
  // 케이스 1 은 매번 갓 만든 row 하나만 보므로, tied group 을 "전량 조회해 최댓값을
  // 고른다" 는 부분은 검증되지 않는다. 같은 ms 에 seq 1..3 을 미리 심어 두고 그 위에
  // 실제 recordEvent 를 태워, 새 이벤트가 1 이 아니라 4 를 받는지 본다.
  {
    const mission = await newMission(missionRepo, 'tied group 위에 기록');
    const seeded = [];
    for (const seq of [1, 2, 3]) {
      const row = await eventRepo.save(eventRepo.create({
        mission_id: mission.id, workspace_id: WS, type: 'note',
        actor_type: 'system', message: `심어둔 ${seq}`, write_seq: seq,
      }));
      seeded.push(row.id);
    }
    await forceTiedTimestamps(ds, seeded, '2026-01-02 03:04:05.678');
    await assertFixtureIsMicrosecondTied(ds, seeded, '케이스2');

    logged.length = 0;
    await missions.recordEvent(mission, { type: 'note', message: '새 이벤트' });
    assert.deepEqual(logged, [], 'recordEvent 가 조용히 실패했다');

    const fresh = await eventRepo.findOne({ where: { mission_id: mission.id, message: '새 이벤트' } });
    assert.ok(fresh, '새 이벤트가 저장돼야 한다');
    assert.equal(
      fresh.write_seq, 4,
      `새 이벤트의 write_seq 가 ${fresh.write_seq} 였다 — 1 이면 tied group 조회가 심어둔 3건을 ` +
      '하나도 집지 못했다는 뜻(등호 결함), 4 가 아니면 최댓값 선택이 틀린 것이다.',
    );
  }
});

test('Postgres: 커서 페이지네이션이 같은 밀리초 burst 를 건너뛰지 않는다', { skip: SKIP }, async () => {
  const { missions, missionRepo, eventRepo } = await bootOnce();
  const mission = await newMission(missionRepo, '커서 burst');

  // 같은 ms 에 5건(tie-break 가 유일한 구분자), 그보다 이른 ms 에 3건.
  // 페이지 경계를 tied group 한가운데에 떨어뜨리는 것이 이 테스트의 핵심이다.
  const tied = [];
  for (const seq of [1, 2, 3, 4, 5]) {
    const row = await eventRepo.save(eventRepo.create({
      mission_id: mission.id, workspace_id: WS, type: 'note',
      actor_type: 'system', message: `burst-${seq}`, write_seq: seq,
    }));
    tied.push(row.id);
  }
  const older = [];
  for (const seq of [1, 2, 3]) {
    const row = await eventRepo.save(eventRepo.create({
      mission_id: mission.id, workspace_id: WS, type: 'note',
      actor_type: 'system', message: `older-${seq}`, write_seq: seq,
    }));
    older.push(row.id);
  }
  await forceTiedTimestamps(ds, tied, '2026-01-02 03:04:05.678');
  await forceTiedTimestamps(ds, older, '2026-01-02 03:04:05.600');
  await assertFixtureIsMicrosecondTied(ds, tied, '커서 tied group');
  await assertFixtureIsMicrosecondTied(ds, older, '커서 older group');

  // limit 2 는 첫 페이지가 tied group 을 5건 중 2건만 먹고 끝나게 한다 — 즉 커서가
  // tied group **안쪽**을 가리키게 되고, 바로 그때 tie-break 절이 필요해진다.
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const res = await missions.listMissionEvents(mission.id, WS, {
      limit: 2,
      before_at: cursor?.at,
      before_seq: cursor?.seq,
    });
    for (const e of res.events) seen.push(e.id);
    cursor = res.next_cursor;
    if (!res.has_more) break;
  }

  const expected = [...tied, ...older];
  assert.equal(
    new Set(seen).size, seen.length,
    `커서가 같은 이벤트를 두 번 돌려줬다 (중복 ${seen.length - new Set(seen).size}건)`,
  );
  assert.deepEqual(
    [...seen].sort(), [...expected].sort(),
    `커서 순회가 ${seen.length}/${expected.length} 건만 덮었다 — 커서가 tied group 한가운데를 가리킬 때 ` +
    'tie-break 절이 Postgres 에서 매칭되지 않으면 같은 밀리초의 나머지가 통째로 사라진다.',
  );

  // 순서까지 본다: 최신 → 과거(DESC) 가 계약이고, 같은 ms 안에서는 write_seq 내림차순이다.
  const byId = new Map(
    (await eventRepo.find({ where: { mission_id: mission.id } })).map((e) => [e.id, e]),
  );
  const order = seen.map((id) => byId.get(id));
  for (let i = 1; i < order.length; i += 1) {
    const prev = order[i - 1];
    const cur = order[i];
    const prevAt = new Date(prev.created_at).getTime();
    const curAt = new Date(cur.created_at).getTime();
    assert.ok(
      curAt < prevAt || (curAt === prevAt && cur.write_seq < prev.write_seq),
      `커서 순회 결과가 (created_at, write_seq) 내림차순이 아니다: ` +
      `${prev.message}(seq ${prev.write_seq}) 다음에 ${cur.message}(seq ${cur.write_seq})`,
    );
  }
});
