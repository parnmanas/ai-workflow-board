// 회귀 (Postgres 전용, ticket a825872b): comment 작성자 이름 해석이 비-uuid
// `author_id` 를 `User.id` 에 그대로 던지면 Postgres 가
// `invalid input syntax for type uuid: "system"` 으로 **throw** 해 MCP 호출
// 자체가 실패했다 — add_comment 와, 공유 헬퍼 resolveAuthor 를 쓰는 6개 툴
// (ask_question · answer_question · record_decision · record_agreement ·
// propose_move · handoff_to_agent) 전부.
//
// 왜 기존 커버리지로 안 잡혔나: `User.id` 는 `@PrimaryGeneratedColumn('uuid')`
// 라서 Postgres 에서만 real `uuid` 컬럼이 되고, sqljs 는 느슨한 타입이라 같은
// 입력이 "매칭 0건 → `User #system` 폴백" 으로 조용히 지나간다. dedff9a3 이
// Agent.id 에서 고친 것과 똑같은 백엔드 비대칭이다. 그 티켓의 pg 실측 43회에도
// 이 조합(author_type='user' + author 미지정 + 비-uuid author_id)은 포함되지
// 않았다 — 그래서 이 파일이 그 한 칸을 메운다.
//
// 공허 통과 방지: 가드를 거치지 않는 **raw findOne** 이 실제로 reject 하는지를
// 먼저 단언한다. 그게 통과하지 않으면 픽스처가 결함을 재현하지 못한다는 뜻이고,
// 그 상태에서 "throw 안 함" 단언만으로는 아무것도 증명하지 못한다.
//
// SKIP 규약: DB_TYPE=postgres (`test:qa:pg` 매트릭스) 에서만 돌고 그 밖에서는
// self-skip — qa-flows/activity-actor-sentinel-pg.test.mjs 와 같은 규약이다.
// 호출 수 계약은 sqlite 위에서 test/comment-tools-user-author-uuid-guard.test.mjs
// 가 따로 고정한다.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

const SCHEMA = `qa_commentauthoruuid_${process.pid}`;

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

test('비-uuid user author_id 는 real Postgres 의 users.id(uuid) 조회에 닿지 않고 코멘트도 저장된다', { skip: SKIP }, async () => {
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
  const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
  const { registerCommentTools } = await import(
    'file://' + path.join(DIST, 'modules', 'mcp', 'tools', 'comment-tools.js')
  );
  const { DataSource } = await import('typeorm');

  ds = new DataSource(buildDataSourceOptions());
  // synchronize 가 users.id 를 real uuid 로 깐다 — 이 결함의 전제 그 자체다.
  await ds.initialize();

  assert.equal(
    ds.driver.options.type, 'postgres',
    '이 파일은 진짜 uuid 컬럼에서만 의미가 있다 — 드라이버가 postgres 가 아니면 검증이 공허하다',
  );

  const userRepo = ds.getRepository(entities.User);
  const ticketRepo = ds.getRepository(entities.Ticket);
  const commentRepo = ds.getRepository(entities.Comment);

  const idType = await ds.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'id'`,
    [SCHEMA],
  );
  assert.equal(
    idType[0]?.data_type, 'uuid',
    '픽스처가 uuid PK 를 재현해야 한다 — varchar 가 되면 이 테스트의 전제가 사라진다',
  );

  // ── 대조군: 가드를 거치지 않는 raw 조회는 실제로 거부된다 ───────────────
  // 결함의 재현 자체를 먼저 증명한다. 이게 통과하지 않으면 아래 단언들은 공허하다.
  for (const sentinel of ['system', 'auto-advance', 'u1']) {
    await assert.rejects(
      () => userRepo.findOne({ where: { id: sentinel } }),
      /invalid input syntax for type uuid/,
      `raw findOne 은 '${sentinel}' 를 Postgres 에서 여전히 거부한다 (결함 재현 확인)`,
    );
  }

  const logStub = { warn() {}, info() {}, error() {}, debug() {} };
  const handlers = new Map();
  registerCommentTools(
    { tool(name, _description, _schema, handler) { handlers.set(name, handler); } },
    {
      dataSource: ds,
      activityService: new ActivityService(
        ds.getRepository(entities.ActivityLog), ds.getRepository(entities.Agent), logStub,
      ),
      mentionService: { parseMentions: () => [] },
      logger: logStub,
      ticketRoleAssignmentService: null,
      roomMessagingService: null,
      instanceQuiesceService: { isQuiesced: async () => false },
    },
  );
  const parse = (res) => JSON.parse(res.content[0].text);
  const makeTicket = (title) => ticketRepo.save(ticketRepo.create({
    title, workspace_id: 'ws-comment-author-uuid', pending_user_action: false,
  }));

  // ── 가드 경로: add_comment ─────────────────────────────────────────────
  for (const sentinel of ['system', 'auto-advance']) {
    const ticket = await makeTicket(`add_comment / ${sentinel}`);
    const comment = parse(await handlers.get('add_comment')({
      ticket_id: ticket.id, content: `${sentinel} 이 남긴 코멘트`,
      author_type: 'user', author_id: sentinel,
    }, {}));

    assert.ok(comment.id, `'${sentinel}' 로는 add_comment 가 Postgres 에서 통째로 실패하던 조합이다`);
    assert.equal(
      comment.author, `User #${sentinel}`,
      'sqlite 와 같은 폴백 문자열로 수렴해야 한다 — 백엔드 비대칭을 없애는 것이 이 수정의 목적이다',
    );
    const reloaded = await commentRepo.findOne({ where: { id: comment.id } });
    assert.equal(reloaded?.author, `User #${sentinel}`, '실제로 커밋된 행에도 폴백 이름이 남는다');
  }

  // ── 가드 경로: 공유 resolveAuthor (ask_question) ────────────────────────
  {
    const ticket = await makeTicket('ask_question / system');
    const question = parse(await handlers.get('ask_question')({
      ticket_id: ticket.id, content: 'system 이 남긴 질문',
      author_type: 'user', author_id: 'system',
    }, {}));
    assert.equal(question.type, 'question');
    assert.equal(
      question.author, 'User #system',
      'resolveAuthor 를 공유하는 6개 툴이 같은 가드를 받는다',
    );
  }

  // ── 대조군: 진짜 uuid user 는 real Postgres 에서도 이름이 해석된다 ───────
  {
    const user = await userRepo.save(userRepo.create({ name: '김담당', email: 'kim@example.test' }));
    const ticket = await makeTicket('add_comment / 실존 uuid user');
    const comment = parse(await handlers.get('add_comment')({
      ticket_id: ticket.id, content: '실존 사용자 코멘트',
      author_type: 'user', author_id: user.id,
    }, {}));
    assert.equal(
      comment.author, '김담당',
      '가드가 공허하지 않다 — uuid 경로는 real Postgres 에서도 그대로 조회된다',
    );
  }
});
