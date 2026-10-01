// 회귀 (Postgres 전용, 티켓 dedff9a3): `resolveAgentDisplayName()` 이 sentinel
// actor id 를 `Agent.id` 에 그대로 던지면 Postgres 가
// `invalid input syntax for type uuid: "auto-advance"` 로 **throw** 한다.
// board_update SSE 매핑이 그 throw 를 먹어 프레임을 통째로 유실했다.
//
// 왜 기존 커버리지로 안 잡혔나: `Agent.id` 는 `@PrimaryGeneratedColumn('uuid')`
// 라서 Postgres 에서만 real `uuid` 컬럼이 되고, sqljs 는 느슨한 타입이라 같은
// 입력이 "매칭 0건 → null" 로 조용히 지나간다. 실측도 그 비대칭 그대로였다 —
// 일회용 Postgres 16 로 `npm run test:qa:pg` 43회 vs 같은 커밋 sqlite 0회.
// fake repo 로는 재현할 수 없고(모사일 뿐이다) 진짜 Postgres 만 재현한다.
//
// 공허 통과 방지: 가드를 거치지 않는 **raw findOne** 이 실제로 reject 하는지를
// 먼저 단언한다. 그게 통과하지 않으면 이 픽스처가 결함을 재현하지 못한다는
// 뜻이므로, "throw 안 함" 단언만으로는 아무것도 증명하지 못한다.
//
// SKIP 규약: DB_TYPE=postgres (`test:qa:pg` 매트릭스) 에서만 돌고 그 밖에서는
// self-skip — qa-flows/orchestration-confirm-reminder-pg-cast.test.mjs 와 같다.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

const SCHEMA = `qa_actorsentinel_${process.pid}`;

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

test('sentinel actor id 는 real Postgres 의 agents.id(uuid) 조회에 닿지 않고 board_update 프레임도 산다', { skip: SKIP }, async () => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) throw new Error(`unsafe pg schema: ${SCHEMA}`);

  const { Client } = await import('pg');
  const admin = new Client(pgConfig());
  await admin.connect();
  // uuid-ossp 는 public 에 고정해 이 일회용 스키마가 그것을 데려가지 않게 한다.
  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
  await admin.end();

  process.env.DB_SCHEMA = SCHEMA;

  const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
  const entities = await import('file://' + path.join(DIST, 'entities', 'index.js'));
  const { resolveAgentDisplayName } = await import('file://' + path.join(DIST, 'utils', 'agent-name.js'));
  const { EVENT_TYPES } = await import('file://' + path.join(DIST, 'modules', 'events', 'event-registry.js'));
  const { DataSource } = await import('typeorm');

  ds = new DataSource(buildDataSourceOptions());
  // synchronize 가 agents.id 를 real uuid 로 깐다 — 이 결함의 전제 그 자체다.
  await ds.initialize();

  const agentRepo = ds.getRepository(entities.Agent);

  const idType = await ds.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'agents' AND column_name = 'id'`,
    [SCHEMA],
  );
  assert.equal(
    idType[0]?.data_type, 'uuid',
    '픽스처가 uuid PK 를 재현해야 한다 — varchar 가 되면 이 테스트의 전제가 사라진다',
  );

  // ── 대조군: 가드를 거치지 않는 raw 조회는 실제로 거부된다 ───────────────
  // 결함의 재현 자체를 먼저 증명한다. 이게 통과하지 않으면 아래 단언들은 공허하다.
  await assert.rejects(
    () => agentRepo.findOne({ where: { id: 'auto-advance' } }),
    /invalid input syntax for type uuid/,
    'raw findOne 은 Postgres 에서 여전히 거부한다 (결함 재현 확인)',
  );

  // ── 가드 경로: 세 sentinel 모두 throw 없이 null ─────────────────────────
  for (const sentinel of ['auto-advance', 'system', 'test-user']) {
    assert.equal(
      await resolveAgentDisplayName(agentRepo, sentinel), null,
      `'${sentinel}' 는 real Postgres 에서도 throw 없이 null 이어야 한다`,
    );
  }

  // ── 대조군: 실제 agent 는 real Postgres 에서도 정규 표시로 해석된다 ──────
  const manager = await agentRepo.save(agentRepo.create({
    name: 'Rolf', workspace_id: 'ws-actor-sentinel', type: 'manager',
  }));
  const agent = await agentRepo.save(agentRepo.create({
    name: 'Programmer', workspace_id: 'ws-actor-sentinel', type: 'subagent',
    manager_agent_id: manager.id,
  }));
  assert.equal(
    await resolveAgentDisplayName(agentRepo, agent.id), 'Rolf/Programmer',
    '가드가 공허하지 않다 — 진짜 uuid 는 여전히 조회되고 manager prefix 가 붙는다',
  );

  // ── 프레임 생존: 실제 EVENT_TYPES 의 board_update map() 을 real pg repo 로 ──
  const def = EVENT_TYPES.find((d) => d.eventType === 'board_update');
  assert.ok(def, 'EVENT_TYPES 에 board_update 정의가 있어야 한다');
  const ctx = {
    resolveBoardId: async () => 'board-1',
    resolveTicketRepositoryResourceId: async () => '',
    resolveTicketColumnSnapshot: async () => ({ id: 'col-done', name: 'Done', kind: 'done' }),
    resolveActorDisplayName: (actorId) => resolveAgentDisplayName(agentRepo, actorId),
  };

  // trigger-loop 의 auto-advance(moved) 와 ticket-archiver(archived, 'system') —
  // agent-manager 의 worktree/workspace 회수가 이 두 프레임만 보고 돈다.
  for (const [actorId, action] of [['auto-advance', 'moved'], ['system', 'archived']]) {
    const mapped = await def.map({
      ticket_id: '44444444-4444-4444-8444-444444444444',
      entity_id: '44444444-4444-4444-8444-444444444444',
      entity_type: 'ticket', action, field_changed: action === 'moved' ? 'column_id' : '',
      actor_id: actorId, actor_name: actorId,
      old_value: 'In Progress', new_value: 'Done',
    }, ctx);
    assert.ok(mapped, `'${actorId}' / ${action} 프레임이 real Postgres 에서 발행되어야 한다`);
    assert.equal(mapped.payload.actor_name, actorId, '저장된 actor_name 이 그대로 실린다');
    assert.equal(mapped.payload.actor_id, actorId);
  }
});
