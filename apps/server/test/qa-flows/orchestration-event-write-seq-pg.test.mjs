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
  try { if (ds?.isInitialized) await ds.destroy(); } catch { /* 종료 실패는 정리 단계라 무시한다 */ }
  if (IS_PG) {
    try {
      const { Client } = await import('pg');
      const c = new Client(pgConfig());
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await c.end();
    } catch { /* 스키마 정리 실패는 테스트 결과를 뒤집지 않으므로 무시한다 */ }
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
  booted.warned.length = 0;
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
  // fail-open 은 error 가 아니라 warn 으로 남는다(그게 계약이다 — 행은 남기고 degrade).
  // 그 경로가 실제로 돌았는지 단언하려면 warn 도 모아야 한다(티켓 7b679009).
  const warned = [];
  const logService = {
    error: (...args) => logged.push(args.join(' ')),
    warn: (...args) => warned.push(args.join(' ')),
    info() {}, debug() {},
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
    warned,
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
 * i 번째 픽스처 row 의 **마이크로초 꼬리**. 꼬리가 .000 이면 옛 등호가 우연히 성립해
 * 이 파일의 회귀가 통째로 공허해지므로, 반드시 0 이 아니어야 한다.
 *
 * 137 의 배수라 5건까지는 685 로 세 자리를 넘지 않는다 — 넘으면 다음 밀리초로 새어 나가
 * tied group 이 쪼개지므로, assertFixtureIsMicrosecondTied 가 그것도 잡는다.
 */
function microTail(i) {
  return String(137 * (i + 1)).padStart(3, '0');
}

/**
 * 한 row 의 created_at 을 **마이크로초까지 지정한 값**으로 직접 고정한다.
 *
 * 꼬리는 JS 에서 만들어 timestamp 로 명시 캐스트한다 — SQL 쪽 interval 산술은 연산자
 * 해석이 모호할 수 있고, 여기서 필요한 건 결정적인 µs 값뿐이다. JS Date 를 바인딩하면
 * 밀리초로 잘려 꼬리가 .000 이 되고 픽스처가 공허해진다.
 */
async function pinCreatedAt(dataSource, id, literal) {
  await dataSource.query(
    'UPDATE orchestration_events SET created_at = $2::timestamp WHERE id = $1::uuid',
    [id, literal],
  );
}

/**
 * 같은 **밀리초** 안에 서로 다른 **마이크로초** 꼬리를 갖는 tied group 을 만든다.
 *
 * 이게 프로덕션의 실제 모양이다: fan-out 한 번이면 수십 건이 같은 밀리초에 떨어지고,
 * 각각은 µs 꼬리로만 구분된다.
 */
async function forceTiedTimestamps(dataSource, ids, msLiteral) {
  for (let i = 0; i < ids.length; i += 1) {
    await pinCreatedAt(dataSource, ids[i], `${msLiteral}${microTail(i)}`);
  }
}

/** 픽스처가 정말로 "같은 ms + 0 아닌 µs 꼬리" 인지 확인한다 — 아니면 회귀가 통과해 버린다. */
async function assertFixtureIsMicrosecondTied(dataSource, ids, label) {
  const rows = await dataSource.query(
    // 밀리초는 **텍스트로** 뽑는다 — timestamp 로 받으면 pg 드라이버가 JS Date 로 바꾸고,
    // `String(date)` 는 밀리초를 빼고 초까지만 찍어 같은 초의 서로 다른 밀리초가 한 종류로
    // 뭉쳐 보인다. 그러면 "같은 밀리초냐" 를 묻는 이 가드가 조용히 무력해진다.
    `SELECT id,
            to_char(created_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS ms,
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

/**
 * `recordEvent()` 를 연속 호출하되, **매 호출 직후** 그 row 의 created_at 을 픽스처가 정한
 * 시각으로 고정한다.
 *
 * 왜 고정이 필요한가 — `nextEventWriteSeq()` 는 "이 미션의 가장 최근 created_at" 에서 tied
 * group 을 잡으므로, 고정하지 않으면 **연속 호출이 같은 밀리초에 떨어졌는지가 그때그때
 * CI/DB 속도로 정해진다.** 그러면 단언이 wall-clock 에 의존하게 된다. 고정하면 "같은
 * 밀리초냐 경계를 넘었느냐" 를 테스트가 직접 정하므로 두 배치 모두 결정적으로 검사할 수
 * 있고, 느린 러너에서 흔들리지 않는다.
 *
 * 고정이 seq 를 대신 계산해 주지는 않는다 — `write_seq` 는 production 의 `recordEvent` 가
 * INSERT 전에 스스로 유도한 값 그대로이고, 고정은 그 다음 호출이 볼 **입력**만 정한다.
 */
async function recordAndPin(missions, eventRepo, mission, messages, literalAt) {
  const ids = [];
  for (let i = 0; i < messages.length; i += 1) {
    await missions.recordEvent(mission, { type: 'note', message: messages[i] });
    const row = await eventRepo.findOne({ where: { mission_id: mission.id, message: messages[i] } });
    assert.ok(row, `"${messages[i]}" 이벤트가 저장돼야 한다`);
    await pinCreatedAt(ds, row.id, literalAt(i));
    ids.push(row.id);
  }
  return ids;
}

/** 미션의 이벤트를 저장 순서(created_at → write_seq 오름차순)로 읽는다. */
function readInOrder(eventRepo, missionId) {
  return eventRepo.find({
    where: { mission_id: missionId },
    order: { created_at: 'ASC', write_seq: 'ASC' },
  });
}

/** ids 가 실제로 몇 종류의 밀리초에 흩어져 있는지 센다 — 경계 케이스의 픽스처 검증용. */
async function countDistinctMilliseconds(dataSource, ids) {
  const [row] = await dataSource.query(
    `SELECT COUNT(DISTINCT date_trunc('milliseconds', created_at))::int AS n
       FROM orchestration_events
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return Number(row.n);
}

test('Postgres: 이벤트 write_seq 가 1 에 고정되지 않고 단조 증가한다', { skip: SKIP }, async () => {
  const { missions, logged, missionRepo, eventRepo } = await bootOnce();

  // ── 케이스 1a: 같은 밀리초 안의 연속 기록 — 결함의 직접 지문 ───────────
  // 등호 비교는 µs 꼬리 때문에 타임스탬프가 겹치든 말든 **항상** 0건이라, 평범한
  // 연속 기록만으로도 seq 가 전부 1 로 나온다. 라이브에서 관측된 바로 그 모양이다.
  //
  // 기록한 row 를 매번 같은 밀리초로 고정한다 — 그래야 "네 건이 같은 밀리초" 가 러너
  // 속도가 아니라 픽스처로 정해져, [1,2,3,4] 단언에 wall-clock 의존이 남지 않는다.
  {
    const mission = await newMission(missionRepo, '같은 밀리초 연속 기록');
    const ids = await recordAndPin(
      missions, eventRepo, mission,
      ['연속 1', '연속 2', '연속 3', '연속 4'],
      (i) => `2026-01-02 03:04:04.321${microTail(i)}`,
    );
    assert.deepEqual(logged, [], 'recordEvent 가 조용히 실패했다 — 서비스 배선이나 스키마 문제다');
    await assertFixtureIsMicrosecondTied(ds, ids, '케이스1a');

    const rows = await readInOrder(eventRepo, mission.id);
    assert.equal(rows.length, 4, '이벤트 4건이 모두 저장돼야 한다');
    assert.deepEqual(
      rows.map((e) => e.write_seq), [1, 2, 3, 4],
      `write_seq 가 ${JSON.stringify(rows.map((e) => e.write_seq))} 였다 — 전부 1 이면 tied-group 조회가 ` +
      '0건을 반환한다는 뜻이고, 그 상태에서는 커서의 타이브레이커가 통째로 사라진다.',
    );
  }

  // ── 케이스 1b: 밀리초 경계를 넘는 연속 기록 — 1 로 리셋되지 않는다 ──────
  // tied group 은 **직전 row 가 속한** 밀리초다. 새 이벤트가 다음 밀리초에 떨어져도 seq 는
  // 그 직전 그룹의 최댓값 + 1 이므로 1 로 되돌아가지 않는다 — 즉 write_seq 는 밀리초마다
  // 다시 매겨지는 값이 아니라 미션 단위로 단조 증가하는 값이다.
  //
  // 케이스 1a 가 러너 속도에 의존하지 않는 근거가 바로 이 성질이라, 가정으로 두지 않고
  // 경계를 **일부러 넘겨** 결정적으로 고정해 둔다. 이게 깨지면 커서가 과거 페이지에서
  // 같은 (created_at, write_seq) 쌍을 다시 만나므로 여기서 잡혀야 한다.
  {
    logged.length = 0;
    const mission = await newMission(missionRepo, '밀리초 경계 연속 기록');
    const ids = await recordAndPin(
      missions, eventRepo, mission,
      ['경계 1', '경계 2', '경계 3', '경계 4'],
      (i) => `2026-01-02 03:04:06.${600 + i * 100}${microTail(i)}`,
    );
    assert.deepEqual(logged, [], 'recordEvent 가 조용히 실패했다');
    assert.equal(
      await countDistinctMilliseconds(ds, ids), 4,
      '이 케이스는 네 건이 서로 다른 밀리초에 있어야 의미가 있다 — 픽스처가 경계를 넘기지 못했다',
    );

    const rows = await readInOrder(eventRepo, mission.id);
    assert.deepEqual(
      rows.map((e) => e.write_seq), [1, 2, 3, 4],
      `write_seq 가 ${JSON.stringify(rows.map((e) => e.write_seq))} 였다 — 밀리초 경계를 넘을 때마다 ` +
      '1 로 리셋되면 같은 미션 안에 (created_at, write_seq) 가 겹치는 구간이 생겨 커서가 어긋난다.',
    );
  }

  // ── 케이스 1c: 아무것도 고정하지 않은 자연 burst ────────────────────────
  // 위 두 케이스는 created_at 을 SQL 로 손본다. 그 손질 자체가 결과를 만들어 낸 것이
  // 아님을 보이려고, 픽스처 없이 production 경로만 그대로 네 번 태운다.
  //
  // 여기서는 [1,2,3,4] 를 단언하지 않는다 — 그 모양이 성립하는지는 이미 1a·1b 가
  // 결정적으로 고정했고, 이 케이스에 같은 단언을 또 두면 러너 속도 의존만 되살아난다.
  // 대신 어떤 타이밍에서도 참인 불변식만 본다: 첫 값은 1, 이후는 직전보다 반드시 크다.
  // 결함 상태의 [1,1,1,1] 은 이 단언에도 걸린다.
  {
    logged.length = 0;
    const mission = await newMission(missionRepo, '고정 없는 연속 기록');
    for (const n of [1, 2, 3, 4]) {
      await missions.recordEvent(mission, { type: 'note', message: `자연 ${n}` });
    }
    assert.deepEqual(logged, [], 'recordEvent 가 조용히 실패했다');

    const seqs = (await readInOrder(eventRepo, mission.id)).map((e) => e.write_seq);
    assert.equal(seqs.length, 4, '이벤트 4건이 모두 저장돼야 한다');
    assert.equal(seqs[0], 1, `첫 이벤트의 write_seq 가 ${seqs[0]} 였다 — 빈 미션의 첫 값은 1 이어야 한다`);
    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok(
        seqs[i] > seqs[i - 1],
        `write_seq 가 ${JSON.stringify(seqs)} 였다 — ${i + 1}번째가 직전보다 크지 않다. 전부 1 이면 ` +
        'tied-group 조회가 0건을 반환한다는 뜻이다.',
      );
    }
  }

  // ── 케이스 2: 이미 쌓인 tied group 위에 기록 — 최댓값 + 1 을 집는가 ────
  // 케이스 1 계열의 tied group 은 recordEvent 가 스스로 만든 것이라 seq 가 이미 순서대로다.
  // 여기서는 recordEvent 를 거치지 않은 row 로 seq 1..3 을 직접 심어 두고 그 위에 기록해,
  // "그룹을 전량 조회해 최댓값을 고른다" 는 부분만 따로 본다 — 새 이벤트가 1 이 아니라 4 다.
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

// ── 티켓 50031353: 동시 recordEvent 가 같은 write_seq 를 쓰지 않는다 ────────────
//
// 위 두 테스트는 **순차** 호출만 본다. 그런데 `write_seq` 는 "지금 DB 의 최댓값 + 1" 로
// 유도되므로, 그 읽기와 뒤이은 INSERT 사이에 다른 호출이 끼어들면 둘이 같은 최댓값을
// 읽고 **같은 seq 로 두 행**을 쓴다. 예전에는 그 구간에 잠금도 트랜잭션도 없었고
// `(mission_id, write_seq)` 유니크 제약도 없어서 아무것도 막지 않았다.
//
// 동시 진입은 이론이 아니다 — `recordEvent` 는 runner / reaper(setInterval 타이머) /
// confirm-notify / mission 네 서비스에서 불린다. 리퍼는 요청 흐름과 무관하게 독립적으로
// 돌기 때문에 같은 미션에 대해 REST·MCP 경로와 시간상 겹칠 수 있다.
//
// 왜 Postgres 전용인가 — sql.js 는 단일 WASM 인스턴스·단일 커넥션이고 `db.ts` 의
// `serializeSqljsTransactions()` 가 겹치는 트랜잭션을 FIFO 로 줄 세워 버린다. 즉 거기서는
// 이 레이스 자체가 재현되지 않으며, 그 green 을 Postgres 의 보장으로 간주하면 안 된다
// (보드 교훈). 진짜 커넥션 풀 위에서만 의미가 있다.
test('Postgres: 같은 미션에 동시 recordEvent 를 태워도 write_seq 가 중복되지 않는다', { skip: SKIP }, async () => {
  const { missions, logged, missionRepo, eventRepo } = await bootOnce();
  const mission = await newMission(missionRepo, '동시 기록');

  // 기본 pg 풀(max 10)보다 작게 잡는다 — 모든 호출이 트랜잭션을 열고 미션 row 잠금을
  // 기다리므로, 동시 수가 풀을 넘으면 커넥션을 못 얻어 대기하는 쪽이 생겨 무엇을 재는
  // 테스트인지 흐려진다. 8 이면 전부 동시에 잠금 경합까지 도달한다.
  const N = 8;
  const messages = Array.from({ length: N }, (_, i) => `동시-${i + 1}`);

  await Promise.all(messages.map((m) => missions.recordEvent(mission, { type: 'note', message: m })));

  assert.deepEqual(logged, [], 'recordEvent 가 조용히 실패했다 — 동시 경로에서 배선이나 잠금이 깨졌다');

  const rows = await readInOrder(eventRepo, mission.id);
  assert.equal(rows.length, N, `동시 기록 ${N} 건이 모두 저장돼야 한다 (관측 ${rows.length}건)`);

  const seqs = rows.map((e) => e.write_seq);

  // 핵심 단언: 미션 안에서 write_seq 가 서로 달라야 한다. 겹치면 (created_at, write_seq)
  // 가 전순서가 아니게 되고, 페이지 경계가 그 겹친 쌍 사이에 떨어질 때 한 건이 조용히
  // 사라진다 — write_seq 컬럼이 존재하는 이유가 바로 그 손실을 막는 것이다.
  const dupes = seqs.filter((v, i) => seqs.indexOf(v) !== i);
  assert.deepEqual(
    dupes, [],
    `동시 기록이 같은 write_seq 를 ${dupes.length}건 만들었다 (관측 ${JSON.stringify(seqs)}) — ` +
    '채번의 읽기-쓰기 구간이 직렬화되지 않았다는 뜻이다.',
  );

  // seq 0 은 "순서 미상" 폴백이다. 폴백으로 떨어지면 중복은 안 생겨도 타이브레이커가
  // 사라지므로, 중복 단언만으로는 잠금 경로가 실제로 동작했는지 구분되지 않는다.
  assert.deepEqual(
    seqs.filter((v) => !v), [],
    `write_seq 0(순서 미상 폴백) 이 ${seqs.filter((v) => !v).length}건 나왔다 — 직렬화 경로가 통째로 ` +
    '실패하고 폴백만 돌았다는 뜻이라, 중복이 없더라도 순서 보장은 얻지 못한 상태다.',
  );

  // 직렬화되면 각 호출은 직전 그룹의 최댓값 + 1 을 쓰므로, 겹쳤든 밀리초 경계를 넘었든
  // 결과는 1..N 이다. 집합이 정확히 1..N 이어야 "빠짐없이 한 줄씩 증가" 가 확인된다.
  assert.deepEqual(
    [...seqs].sort((a, b) => a - b),
    Array.from({ length: N }, (_, i) => i + 1),
    `write_seq 집합이 1..${N} 이 아니다 (관측 ${JSON.stringify([...seqs].sort((a, b) => a - b))})`,
  );

  // ── 커서 순회도 그 결과 위에서 누락·중복 0 이어야 한다 ───────────────────
  // 동시 기록이 실제로 같은 밀리초에 떨어졌는지는 러너 속도가 정하므로, 여기서만 픽스처로
  // 고정한다(이미 매겨진 write_seq 는 건드리지 않는다 — 고정은 커서가 볼 입력만 정한다).
  //
  // 여덟 건을 **똑같은 시각**으로 박는다. `forceTiedTimestamps` 처럼 µs 꼬리를 어긋나게
  // 주지 않는 이유가 있다 — 그러면 한 밀리초 안에서 created_at 순서와 write_seq 순서가
  // 서로 달라지는데, 그건 **프로덕션이 더는 만들지 않는 상태**다. recordEvent 가 잠금
  // 안에서 created_at 을 찍으므로 두 순서는 항상 일치하고, 같은 밀리초에 몰린 건들은
  // 실제로 시각이 같다. 어긋난 꼬리를 인위로 박으면 production 이 배제한 입력에 대고
  // 커서를 시험하는 셈이라, 고쳐야 할 대상이 아닌 것으로 red 가 난다.
  //
  // 시각이 전부 같으므로 정렬의 유일한 구분자가 write_seq 가 된다 — tie-break 절이
  // 최대로 load-bearing 해지는 배치다. µs 꼬리는 0 이 아닌 값으로 둬서, 옛 등호 결함이
  // 우연히 성립하는 배치가 되지 않게 한다.
  const TIED_AT = '2026-01-02 03:04:09.111137';
  for (const e of rows) await pinCreatedAt(ds, e.id, TIED_AT);
  await assertFixtureIsMicrosecondTied(ds, rows.map((e) => e.id), '동시 기록 tied group');

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const res = await missions.listMissionEvents(mission.id, WS, {
      limit: 3,
      before_at: cursor?.at,
      before_seq: cursor?.seq,
    });
    for (const e of res.events) seen.push(e.id);
    cursor = res.next_cursor;
    if (!res.has_more) break;
  }

  assert.equal(
    new Set(seen).size, seen.length,
    `커서가 같은 이벤트를 두 번 돌려줬다 (중복 ${seen.length - new Set(seen).size}건)`,
  );
  assert.deepEqual(
    [...seen].sort(), rows.map((e) => e.id).sort(),
    `커서 순회가 ${seen.length}/${N} 건만 덮었다 — 동시 기록 결과 위에서도 누락이 0 이어야 한다.`,
  );
});

// ── 티켓 7b679009: fail-open write_seq=0 이 두 번 나도 커서가 이벤트를 잃지 않는다 ──
//
// `recordEvent` 는 직렬화 트랜잭션이 실패하면 `write_seq: 0`("순서 미상")으로 행만 남기고
// 넘어간다. 한 미션에서 두 번 발동하면 tied group 안에 seq 동률 두 행이 생기고, 커서가
// 그 사이를 가리키면 tie-break 가 `0 < 0` 으로 거짓이 되어 나머지가 사라진다.
//
// **왜 Postgres 를 따로 봐야 하는가 — sqljs 에서는 드러나지 않는 축이 하나 더 있다.**
// fail-open 행의 `created_at` 은 잠금 안에서 찍히지 못하고 DB 기본값(`CURRENT_TIMESTAMP`,
// µs 정밀도)으로 들어온다. 즉 같은 밀리초 안에서도 두 행의 µs 가 **서로 다르다.** 그러면
// 정렬(µs 까지 보는 `created_at`)과 술어(tied group 을 한 덩어리로 보는 `[t, t+1ms)`)의
// granularity 가 어긋나, `id` 를 타이브레이커로 더해도 uuid 대소가 µs 대소와 반대인 절반의
// 경우에 여전히 행이 사라진다. sqljs 는 저장 포맷이 초 단위 문자열이라 이 어긋남 자체가
// 없어서, sqljs green 을 Postgres 의 보장으로 간주하면 안 된다(보드 교훈). 이 케이스가
// 정렬 granularity 까지 커서 정밀도에 맞췄는지를 진짜 µs 위에서 확인한다.
test('Postgres: 한 미션에서 fail-open 이 두 번 나도 커서가 전량을 덮는다', { skip: SKIP }, async () => {
  const { missions, logged, warned, missionRepo, eventRepo } = await bootOnce();
  const mission = await newMission(missionRepo, 'fail-open 두 번');

  // ── 정상 기록 3건 → seq 1..3, 한 밀리초 안에 µs 꼬리만 다르게 ──
  const beforeIds = await recordAndPin(
    missions, eventRepo, mission,
    ['정상 1', '정상 2', '정상 3'],
    (i) => `2026-01-02 03:04:11.111${microTail(i)}`,
  );

  // ── fail-open 2건: 직렬화 트랜잭션만 실패시켜 production 의 catch 경로를 태운다 ──
  const originalTransaction = ds.transaction;
  const failOpenMessages = ['fail-open A', 'fail-open B'];
  try {
    ds.transaction = async () => { throw new Error('injected: serialized event write failed'); };
    for (const m of failOpenMessages) await missions.recordEvent(mission, { type: 'note', message: m });
  } finally {
    ds.transaction = originalTransaction;
  }
  const failOpenRows = [];
  for (const m of failOpenMessages) {
    const row = await eventRepo.findOne({ where: { mission_id: mission.id, message: m } });
    assert.ok(row, `"${m}" 이벤트가 저장돼야 한다`);
    failOpenRows.push(row);
  }

  // 완료 조건 2: fail-open 은 기록 자체를 막지 않는다 — 행은 남고 값은 "순서 미상"인 0 이다.
  assert.deepEqual(
    failOpenRows.map((e) => e.write_seq), [0, 0],
    'fail-open 은 write_seq 0 으로라도 타임라인 행을 남겨야 한다 — 막히면 ' +
    '"타임라인 한 줄 때문에 dispatch 를 죽이지 않는다" 는 계약이 좁아진다',
  );
  assert.equal(
    warned.filter((l) => l.includes('retrying unordered')).length, 2,
    'fail-open 경로가 실제로 두 번 돌았어야 한다 — 로그가 없으면 트랜잭션이 그냥 성공한 것이고 픽스처가 공허하다',
  );
  assert.deepEqual(logged, [], '안쪽 폴백 INSERT 까지 실패하면 감사 행이 통째로 사라진다 — 그건 다른 결함이다');

  // fail-open 두 행을 같은 밀리초 + 서로 다른 µs 꼬리로 고정한다. DB 기본값이 만드는
  // 모양 그대로이고(잠금 밖이라 시각을 찍지 못한다), 러너 속도 의존만 걷어낸 것이다.
  const failOpenIds = failOpenRows.map((e) => e.id);
  await forceTiedTimestamps(ds, failOpenIds, '2026-01-02 03:04:11.222');
  await assertFixtureIsMicrosecondTied(ds, failOpenIds, 'fail-open tied group');

  // ── fail-open 뒤의 정상 기록 → 0 이 최댓값을 끌어내리지 않는다 ──
  const [resumedId] = await recordAndPin(
    missions, eventRepo, mission, ['정상 4'], () => '2026-01-02 03:04:11.333137',
  );
  const resumed = await eventRepo.findOne({ where: { id: resumedId } });
  assert.equal(resumed.write_seq, 4, 'seq 0 이 섞여도 다음 정상 기록은 MAX + 1 이어야 한다');

  // 픽스처의 핵심 — 두 fail-open 행의 µs 가 **서로 달라야** 정렬/술어 granularity 어긋남이
  // load-bearing 해진다. 같으면 이 케이스가 sqljs 케이스와 다를 게 없어져 공허하다.
  const tails = await ds.query(
    `SELECT (EXTRACT(MICROSECONDS FROM created_at)::bigint % 1000) AS us_tail
       FROM orchestration_events WHERE id = ANY($1::uuid[])`,
    [failOpenIds],
  );
  assert.equal(
    new Set(tails.map((r) => Number(r.us_tail))).size, 2,
    'fail-open 두 행의 µs 꼬리가 달라야 한다 — 같으면 정렬과 술어의 granularity 어긋남을 재현하지 못한다',
  );

  const all = [...beforeIds, ...failOpenIds, resumedId];

  /** 커서로 전량 순회한다. `withId=false` 는 고치기 전 (at, seq) 2단 커서 모양이다. */
  async function walk(limit, withId) {
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 30; page += 1) {
      const res = await missions.listMissionEvents(mission.id, WS, {
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

  // ── 비공허성: 옛 2단 커서는 실제로 잃는다 ──
  const legacy = await walk(1, false);
  assert.ok(
    legacy.length < all.length,
    '(at, seq) 2단 커서는 seq 동률 군집에서 행을 잃어야 한다 — 이 단언이 실패하면 픽스처가 ' +
    `결함을 재현하지 못한 것이다 (순회 ${legacy.length} / 전체 ${all.length})`,
  );

  // ── 제품 불변식: 3단 커서는 하나도 빠뜨리지 않는다 ──
  for (const limit of [1, 2, 3]) {
    const seen = await walk(limit, true);
    assert.equal(
      new Set(seen).size, seen.length,
      `limit=${limit}: 커서가 같은 이벤트를 두 번 돌려줬다 (중복 ${seen.length - new Set(seen).size}건)`,
    );
    assert.deepEqual(
      [...seen].sort(), [...all].sort(),
      `limit=${limit}: 커서 순회가 ${seen.length}/${all.length} 건만 덮었다 — 같은 밀리초 안에서 ` +
      'seq 가 동률이면 안정 키(id)로 가르고, 정렬도 같은 granularity 로 잘라야 손실이 0 이 된다',
    );
  }
});
