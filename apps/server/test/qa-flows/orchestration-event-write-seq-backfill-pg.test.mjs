// 회귀 테스트 (Postgres 전용): 레거시 `write_seq` 백필의 정렬 정밀도 — 티켓 c17b5c2c.
//
// 왜 sqljs 테스트로는 부족한가
// ───────────────────────────
//
// 백필은 미션별로 `created_at` 순서에 따라 `write_seq` 를 1..N 으로 재부여한다. 그런데
// 커서가 실제로 요구하는 불변식은 "번호가 1..N 이다" 가 아니라 **한 밀리초 버킷 안에서
// `created_at` 의 마이크로초 순서와 `write_seq` 순서가 일치한다** 이다 — keyset 술어
// (`tiedCreatedAtWhere`)가 Postgres 에서 tied group 을 `[t, t+1ms)` 밀리초 단위로 묶는
// 반면 `ORDER BY` 는 마이크로초 전량으로 정렬하기 때문이다. 둘이 어긋나면 같은 밀리초
// 안의 행이 페이지 경계에서 누락되거나 중복된다.
//
// 이 구분은 **Postgres 에서만 존재한다.** sqljs 는 저장 포맷이 초 단위 문자열이라
// 마이크로초 자체가 없다. 그래서 "행을 JS 로 읽어 `created_at` 으로 정렬" 하는 구현
// (TypeORM 이 물려주는 JS `Date` 는 밀리초까지만 남으므로 같은 밀리초의 행이 전부 동률이
// 되어 2차 키인 `id` 로 갈린다)은 sqljs 테스트에서 100% green 이면서 라이브 Postgres 에서
// 정확히 고치러 온 불변식을 깨뜨린다. 이 파일이 그 갈림길을 고정한다.
//
// 어떻게 갈림길을 만드는가
// ──────────────────────
//
// 같은 밀리초(`.123`) 안에 마이크로초만 다른 6행을 심되, **`id` 오름차순이 시각
// 오름차순의 정확한 역순**이 되도록 uuid 를 직접 지정한다. 올바른 구현(DB 가
// `ORDER BY created_at ASC, id ASC` 로 정렬)은 시각 순서대로 1..6 을 붙이고, JS 쪽에서
// 정렬하는 구현은 밀리초가 모두 같아 `id` 로 갈리므로 **정확히 역순(6..1)** 을 붙인다.
// 단언 한 줄이 두 구현을 분리한다.
//
// SKIP 규약: `DB_TYPE=postgres` 일 때만 실행된다(CI `test:qa:pg` 매트릭스). 기본 sqljs
// 실행에서는 사유를 남기고 자체 스킵하므로 어디서든 green 이다. 담당자 샌드박스에는
// docker/psql/postgres 바이너리가 없고 로컬 5432 는 라이브 인프라라 건드리지 않는다 —
// **실제 green 은 pg 매트릭스에서 나온다**(orchestration-event-write-seq-pg.test.mjs /
// orchestration-team-nullable-migration-pg.test.mjs 와 동일 규약).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

const SCHEMA = `qa_orchseqbackfill_${process.pid}`;
const WS = '11111111-1111-4111-8111-111111111111';

/** 같은 밀리초 `.123` 안의 마이크로초 6개. 오름차순이 곧 진짜 시각 순서다. */
const TIED_MICROS = ['.123100', '.123200', '.123300', '.123400', '.123500', '.123600'];
const TIED_MS_BASE = '2026-09-02 22:51:50';
/** 다음 밀리초의 2행 — 밀리초 경계를 넘어도 번호가 이어지는지 본다. */
const NEXT_MS = ['2026-09-02 22:51:50.124100', '2026-09-02 22:51:50.124200'];

/** id 오름차순이 시각 오름차순의 역순이 되도록 고정 uuid 를 쓴다(헤더 참고). */
const uuidAt = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

test('백필은 같은 밀리초 안에서도 마이크로초 순서대로 write_seq 를 부여한다 (Postgres)', { skip: SKIP }, async () => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) throw new Error(`unsafe pg schema: ${SCHEMA}`);

  const { Client } = await import('pg');
  const admin = new Client(pgConfig());
  await admin.connect();
  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
  await admin.end();

  // schema 와 search_path 는 반드시 짝이어야 한다 — buildDataSourceOptions() 가 DB_SCHEMA
  // 로부터 둘을 함께 만들어 준다(다른 pg qa-flow 와 동일).
  process.env.DB_SCHEMA = SCHEMA;
  const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
  const entities = await import('file://' + path.join(DIST, 'entities', 'index.js'));
  const { OrchestrationMissionService } = await import(
    'file://' + path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')
  );
  const { BackfillOrchestrationEventWriteSeq1760000000086 } = await import(
    'file://' + path.join(DIST, 'database', 'migrations', '1760000000086-BackfillOrchestrationEventWriteSeq.js')
  );
  const { DataSource } = await import('typeorm');

  ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();
  assert.equal(
    ds.options.type, 'postgres',
    '이 파일은 진짜 Postgres 타임스탬프 정밀도에서만 의미가 있다 — 드라이버가 다르면 검증이 공허하다',
  );

  const missionRepo = ds.getRepository(entities.OrchestrationMission);
  const mission = await missionRepo.save(missionRepo.create({
    workspace_id: WS, team_id: 'team-1', title: 'µs backfill fixture',
    objective: 'backfill fixture', status: 'running',
    created_by_type: 'user', created_by: '33333333-3333-4333-8333-333333333333',
  }));

  // 시각 오름차순 목록. id 는 그 역순으로 붙인다 — 올바른 구현과 JS 정렬 구현이
  // 정확히 반대 결과를 내도록 만드는 장치다.
  const timesAsc = [...TIED_MICROS.map((us) => `${TIED_MS_BASE}${us}`), ...NEXT_MS];
  const idsByTime = timesAsc.map((_, i) => uuidAt(timesAsc.length - i));

  for (let i = 0; i < timesAsc.length; i += 1) {
    // 레거시 상태 재현: `write_seq` 는 컬럼 도입 이전 행처럼 전부 0 이다.
    await ds.query(
      `INSERT INTO "${SCHEMA}".orchestration_events
         (id, mission_id, workspace_id, step_id, type, actor_type, actor_id, actor_name, message, data, created_at, write_seq)
       VALUES ($1, $2, $3, NULL, 'note', 'system', '', '', $4, NULL, $5::timestamp, 0)`,
      [idsByTime[i], mission.id, WS, `evt-${i}`, timesAsc[i]],
    );
  }

  // 픽스처 자체가 갈림길을 만드는지 먼저 확인한다 — id 순서가 시각 순서의 역순이 아니면
  // 아래 단언이 두 구현을 구분하지 못한다.
  const byId = await ds.query(
    `SELECT id FROM "${SCHEMA}".orchestration_events WHERE mission_id = $1 ORDER BY id ASC`,
    [mission.id],
  );
  assert.deepEqual(
    byId.map((r) => r.id), [...idsByTime].reverse(),
    'id 오름차순은 시각 오름차순의 역순이어야 한다 — 그래야 JS 밀리초 정렬 구현과 갈린다',
  );

  // 비공허성: 백필 전에는 커서가 같은 밀리초 구간에서 실제로 이벤트를 잃는다.
  const missions = new OrchestrationMissionService(
    missionRepo,
    ds.getRepository(entities.OrchestrationStep),
    ds.getRepository(entities.OrchestrationEvent),
    ds.getRepository(entities.OrchestrationTeam),
    ds.getRepository(entities.OrchestrationTeamMember),
    ds.getRepository(entities.Agent),
    ds,
    { info() {}, warn() {}, error() {}, debug() {} },
  );
  const walk = async (limit) => {
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 50; page += 1) {
      const res = await missions.listMissionEvents(mission.id, WS, {
        limit, before_at: cursor?.at, before_seq: cursor?.seq,
      });
      for (const e of res.events) seen.push(e.id);
      cursor = res.next_cursor;
      if (!res.has_more) break;
    }
    return seen;
  };
  const walkedBefore = await walk(4);
  assert.ok(
    walkedBefore.length < timesAsc.length,
    `백필 전에는 커서 순회가 전체를 덮지 못해야 한다 — 이 단언이 실패하면 픽스처가 결함을 재현하지 못한 것이다 ` +
      `(순회 ${walkedBefore.length} / 전체 ${timesAsc.length})`,
  );

  const queryRunner = ds.createQueryRunner();
  try {
    await new BackfillOrchestrationEventWriteSeq1760000000086().up(queryRunner);
  } finally {
    await queryRunner.release();
  }

  // 핵심 단언 — 마이크로초 순서대로 1..N 이어야 한다. JS 쪽에서 밀리초 정밀도로 정렬하는
  // 구현은 여기서 같은 밀리초 6행에 정확히 역순(6,5,4,3,2,1)을 붙여 실패한다.
  const byTime = await ds.query(
    `SELECT id, write_seq FROM "${SCHEMA}".orchestration_events WHERE mission_id = $1 ORDER BY created_at ASC`,
    [mission.id],
  );
  assert.deepEqual(
    byTime.map((r) => r.write_seq), timesAsc.map((_, i) => i + 1),
    'write_seq 는 created_at 의 마이크로초 순서를 그대로 따라야 한다 — 밀리초로 잘린 순서를 쓰면 커서가 다시 이벤트를 잃는다',
  );
  assert.deepEqual(
    byTime.map((r) => r.id), idsByTime,
    '시각 순서로 읽은 행 순서가 픽스처의 시각 순서와 같아야 한다(단언이 우연히 성립하지 않았음을 확인)',
  );

  // 완료 조건: (mission_id, write_seq) 중복 0.
  const dupes = await ds.query(
    `SELECT mission_id, write_seq, COUNT(*) AS c FROM "${SCHEMA}".orchestration_events
      GROUP BY mission_id, write_seq HAVING COUNT(*) > 1`,
  );
  assert.deepEqual(dupes, [], `(mission_id, write_seq) 중복이 남으면 커서의 전순서 전제가 깨진다: ${JSON.stringify(dupes)}`);

  // 제품 불변식: 백필 후 커서가 전량을 덮고 중복이 없다.
  const walkedAfter = await walk(4);
  assert.equal(
    walkedAfter.length, timesAsc.length,
    `백필 후 커서 순회는 전체를 덮어야 한다 (순회 ${walkedAfter.length} / 전체 ${timesAsc.length})`,
  );
  assert.equal(new Set(walkedAfter).size, walkedAfter.length, '커서가 같은 이벤트를 두 번 돌려주면 안 된다');

  // 멱등 — 두 번째 실행은 값을 바꾸지 않는다.
  const before = await ds.query(
    `SELECT id, write_seq FROM "${SCHEMA}".orchestration_events WHERE mission_id = $1 ORDER BY id ASC`,
    [mission.id],
  );
  const qr2 = ds.createQueryRunner();
  try {
    await new BackfillOrchestrationEventWriteSeq1760000000086().up(qr2);
  } finally {
    await qr2.release();
  }
  const afterSecond = await ds.query(
    `SELECT id, write_seq FROM "${SCHEMA}".orchestration_events WHERE mission_id = $1 ORDER BY id ASC`,
    [mission.id],
  );
  assert.deepEqual(afterSecond, before, '백필은 멱등해야 한다 — 두 번째 실행이 값을 바꾸면 안 된다');
});
