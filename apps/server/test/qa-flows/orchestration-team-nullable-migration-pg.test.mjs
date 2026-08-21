// Postgres 전용: OrchestrationTeam.workspace_id non-null → nullable 마이그레이션
// (티켓 1b62b437, 완료 조건 7).
//
// 이 티켓의 엔티티 변경은 기존 컬럼의 타입 전환이다(`workspace_id: string` →
// `string | null`) — additive 컬럼 추가가 아니다. SQLite/sql.js에서는 TypeORM의
// `synchronize`에 ALTER COLUMN이 없어서 `orchestration_teams` 테이블 전체를
// 재작성한다(새 테이블 생성, 행 복사, 기존 테이블 삭제, 이름 변경) — 복사 단계에서
// 컬럼이나 비-기본값이 하나라도 누락되면 실제 데이터 손실로 이어질 수 있는, 흔하지만
// 실재하는 위험이다. Postgres에서는 같은 변경이 테이블 재작성 없는 훨씬 좁은 범위의
// `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`이다 — 다만 "더 좁다"가 "위험
//없음"을 뜻하지는 않는다: 실제 카탈로그에 대해 한 번이라도 돌려보기 전까지는 여전히
// 미검증 경로다. 이 테스트는 LEGACY 엔티티 형태(이 티켓 이전, 커밋 b5a4a3d5의
// OrchestrationTeam을 그대로 반영)로 행을 하나 심고, CURRENT 엔티티로 `synchronize`를
// 재부팅한 뒤 그 행이 그대로 살아남는지, 신규 컬럼이 null 기본값으로 채워지는지,
// `workspace_id`가 카탈로그 레벨에서 실제로 nullable로 전환됐는지, 그리고 실제
// 글로벌 팀(workspace_id NULL)을 그 뒤에 insert할 수 있는지(마이그레이션 이전
// NOT NULL 제약이었다면 통째로 거절됐을 것)를 검증한다.
//
// `npm run test:qa:pg`(CI 잡 `postgres-dialect-matrix`) 아래에서 실행된다. 다른
// 백엔드에서는 뭔가를 잘못 단언하는 대신 self-skip한다 — prompt-audit-report-pg-cast.
// test.mjs / skill-global-scope-pg.test.mjs와 동일한 태도다. 이 샌드박스에는 로컬로
// 돌릴 docker/psql/postgres 바이너리가 없다 — 실제 Postgres green은 이 브랜치가
// CI pg 매트릭스에서 실행될 때 나온다.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataSource, EntitySchema } from 'typeorm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

// 이 테스트 프로세스 전용 격리 schema(helpers/boot.mjs / prompt-audit-report-pg-cast.
// test.mjs와 동일 패턴 반영). pid로 키잉해 재사용된 pid가 오래된 테이블을 물려받지
// 않게 한다.
const SCHEMA = `qa_orchteammig_${process.pid}`;

function pgClientOptions() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ai_workflow',
  };
}

// Legacy 형태(이 티켓 이전, 커밋 b5a4a3d5): workspace_id NOT NULL,
// owner_workspace_id / allowed_workspace_ids 컬럼 없음.
const LegacyOrchestrationTeam = new EntitySchema({
  name: 'OrchestrationTeam',
  tableName: 'orchestration_teams',
  columns: {
    id: { primary: true, type: 'uuid', generated: 'uuid' },
    workspace_id: { type: 'varchar', nullable: false },
    name: { type: 'varchar' },
    description: { type: 'text', default: '' },
    orchestrator_agent_id: { type: 'varchar', nullable: true, default: null },
    orchestrator_prompt: { type: 'text', default: '' },
    max_parallel_steps: { type: 'int', default: 3 },
    max_open_missions: { type: 'int', default: 1 },
    enabled: { type: 'int', default: 1 },
    created_by: { type: 'varchar', default: '' },
    created_at: { type: 'timestamp', createDate: true },
    updated_at: { type: 'timestamp', updateDate: true },
  },
});

let legacyDs;
let currentDs;

after(async () => {
  try { if (legacyDs?.isInitialized) await legacyDs.destroy(); } catch { /* 실패 무시 */ }
  try { if (currentDs?.isInitialized) await currentDs.destroy(); } catch { /* 실패 무시 */ }
  if (IS_PG) {
    try {
      const { Client } = await import('pg');
      const c = new Client(pgClientOptions());
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await c.end();
    } catch { /* 정리 실패는 무시 */ }
  }
});

test('OrchestrationTeam.workspace_id non-null → nullable synchronize preserves existing rows and unlocks global teams (Postgres)', { skip: SKIP }, async () => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) throw new Error(`unsafe pg schema: ${SCHEMA}`);

  const { Client } = await import('pg');
  const adminClient = new Client(pgClientOptions());
  await adminClient.connect();
  // TypeORM의 uuid 생성기는 uuid-ossp가 필요하다 — 이 disposable schema가 extension을
  // 좌초시키지 않도록 public에 고정한다(helpers/boot.mjs의 prepareIsolatedPgSchema /
  // prompt-audit-report-pg-cast와 동일 패턴).
  await adminClient.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  await adminClient.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await adminClient.query(`CREATE SCHEMA "${SCHEMA}"`);
  await adminClient.end();

  // schema와 search_path는 반드시 일치해야 한다(Board Lesson 3) — buildDataSourceOptions()가
  // 다른 모든 pg qa-flow와 마찬가지로 이미 DB_SCHEMA로부터 둘을 짝지어 준다.
  process.env.DB_SCHEMA = SCHEMA;
  const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
  const baseOptions = buildDataSourceOptions();

  // Step 1 — LEGACY(이 티켓 이전) 형태로 행을 하나 심는다: workspace_id NOT NULL,
  // owner_workspace_id / allowed_workspace_ids 없음.
  legacyDs = new DataSource({ ...baseOptions, entities: [LegacyOrchestrationTeam], synchronize: true });
  await legacyDs.initialize();
  const legacyRepo = legacyDs.getRepository('OrchestrationTeam');
  const seeded = await legacyRepo.save(legacyRepo.create({
    workspace_id: '11111111-1111-4111-8111-111111111111',
    name: 'Pre-migration team',
    orchestrator_agent_id: '22222222-2222-4222-8222-222222222222',
    max_parallel_steps: 5,
    max_open_missions: 2,
    enabled: 1,
    created_by: 'legacy-seed',
  }));
  await legacyDs.destroy();
  legacyDs = null;

  // Step 2 — CURRENT 엔티티(workspace_id nullable + 신규 컬럼)를 같은 schema/테이블
  // 대상으로 재부팅해 synchronize가 실제 ALTER를 실행하게 한다.
  const entities = await import('file://' + path.join(DIST, 'entities', 'index.js'));
  currentDs = new DataSource({ ...baseOptions, entities: [entities.OrchestrationTeam], synchronize: true });
  await currentDs.initialize();
  const repo = currentDs.getRepository(entities.OrchestrationTeam);

  const survived = await repo.findOne({ where: { id: seeded.id } });
  assert.ok(survived, 'the pre-migration row must survive ALTER COLUMN workspace_id DROP NOT NULL');
  assert.equal(survived.workspace_id, seeded.workspace_id, 'existing non-null workspace_id must be preserved verbatim');
  assert.equal(survived.name, 'Pre-migration team');
  assert.equal(survived.orchestrator_agent_id, seeded.orchestrator_agent_id);
  assert.equal(survived.max_parallel_steps, 5);
  assert.equal(survived.max_open_missions, 2);
  assert.equal(survived.owner_workspace_id, null, 'a new column must default to null on a pre-existing row');
  assert.equal(survived.allowed_workspace_ids, null, 'a new column must default to null on a pre-existing row');

  // Step 3 — 이 마이그레이션의 실제 요점: 진짜 글로벌 팀(workspace_id NULL)이 이제는
  // insert되어야 한다 — 이전 NOT NULL 제약이었다면 통째로 거절됐을 것이다.
  const global = await repo.save(repo.create({
    workspace_id: null,
    owner_workspace_id: '33333333-3333-4333-8333-333333333333',
    allowed_workspace_ids: ['33333333-3333-4333-8333-333333333333'],
    name: 'Global team post-migration',
    orchestrator_agent_id: null,
    created_by: 'post-migration',
  }));
  assert.equal(global.workspace_id, null);
  assert.deepEqual(global.allowed_workspace_ids, ['33333333-3333-4333-8333-333333333333']);

  const col = await currentDs.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'orchestration_teams' AND column_name = 'workspace_id'`,
    [SCHEMA],
  );
  assert.equal(col[0]?.is_nullable, 'YES', 'workspace_id must be nullable at the catalog level post-migration');
});
