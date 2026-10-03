// 회귀 (ticket a825872b): comment 작성자 이름 해석이 비-uuid author_id 를
// `User.id` 에 그대로 던지면 Postgres 가 `invalid input syntax for type uuid`
// 로 **throw** 해 MCP 호출 자체가 실패했다.
//
// 무엇이 깨져 있었나
// ─────────────────
// `author_type='user'` + `author` 미지정이면 add_comment 는 표시 이름을 얻으려
// `userRepo.findOne({ where: { id: author_id } })` 를 돌렸다. `User.id` 는
// `@PrimaryGeneratedColumn('uuid')`(entities/User.ts:5) 라 Postgres 에서 real
// uuid 컬럼이고, 'system' 같은 sentinel 이 들어오면 매칭 0건이 아니라 throw 다.
// sqlite 는 느슨한 타입이라 같은 입력이 "0건 → `User #system` 폴백" 으로 조용히
// 지나간다 — dedff9a3 이 Agent.id 에서 고친 것과 똑같은 백엔드 비대칭이다.
//
// 왜 sqlite 파일인가 (그리고 왜 이것만으로 충분하지 않은가)
// ─────────────────────────────────────────────────────
// 이 파일이 고정하는 계약은 "비-uuid id 로는 User 조회를 **시도하지 않는다**"
// 이고, 그건 드라이버와 무관한 호출 수 계약이라 sqlite 에서 셀 수 있다.
// ctx.dataSource 를 프록시로 감싸 `getRepository(User)` 만 래핑하고, 비-uuid
// id 가 findOne 에 닿으면 Postgres 와 같은 메시지로 throw 시켜 그 실패를
// 재현한다. 진짜 Postgres uuid 컬럼에서의 검증은
// test/qa-flows/comment-author-uuid-guard-pg.test.mjs 가 따로 한다 — 모사
// green 을 드라이버 보장으로 간주하지 않는다(보드 교훈).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-comment-user-uuid-guard-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'comment-user-uuid-guard-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
// comment-tools.js 가 보는 것과 **같은 클래스 객체**여야 프록시가 User 저장소를
// 식별할 수 있다 — 그래서 배럴(index.js) 이 아니라 같은 모듈 경로로 집는다.
const { User } = await import('file://' + path.join(DIST, 'entities', 'User.js'));
const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
const { registerCommentTools } = await import('file://' + path.join(DIST, 'modules', 'mcp', 'tools', 'comment-tools.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds, logStub);

const ticketRepo = ds.getRepository(Ticket);
const userRepo = ds.getRepository(User);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** findOne 에 닿은 id 들 — 가드가 "쿼리 없이 폴백" 하는지를 세기 위한 계측. */
let userFindOneIds = [];

/**
 * Postgres 의 uuid 컬럼을 sqlite 위에서 재현하는 DataSource 프록시.
 * `getRepository(User)` 만 래핑하고 나머지(transaction, driver, options …)는
 * 그대로 통과시킨다 — comment-tools 는 ctx.dataSource 를 한 번 구조분해해
 * `dataSource.getRepository(...)` 로만 쓰므로 이 한 지점이면 충분하다.
 */
function pgLikeUserDataSource() {
  const wrapRepo = (repo) => new Proxy(repo, {
    get(target, prop) {
      if (prop === 'findOne') {
        return async (options) => {
          const id = options?.where?.id;
          userFindOneIds.push(id);
          if (!UUID_RE.test(String(id ?? ''))) {
            throw new Error(`invalid input syntax for type uuid: "${id}"`);
          }
          return target.findOne(options);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return new Proxy(ds, {
    get(target, prop) {
      if (prop === 'getRepository') {
        return (entity) => {
          const repo = target.getRepository(entity);
          return entity === User ? wrapRepo(repo) : repo;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const proxiedDataSource = pgLikeUserDataSource();

function registerTools() {
  const handlers = new Map();
  const server = { tool(name, _description, _schema, handler) { handlers.set(name, handler); } };
  registerCommentTools(server, {
    dataSource: proxiedDataSource,
    activityService,
    mentionService: { parseMentions: () => [] },
    logger: logStub,
    ticketRoleAssignmentService: null,
    roomMessagingService: null,
    instanceQuiesceService: { isQuiesced: async () => false },
  });
  return handlers;
}

async function makeTicket(title = 'T') {
  return ticketRepo.save(ticketRepo.create({
    title, workspace_id: 'w1', pending_user_action: false,
  }));
}
function parse(res) {
  return JSON.parse(res.content[0].text);
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 대조군: 픽스처가 결함을 실제로 재현한다 ──────────────────────────────
// 이게 통과하지 않으면 아래 "throw 안 함" 단언들은 전부 공허하다.
test('픽스처 전제: 가드를 거치지 않는 raw findOne 은 비-uuid id 를 거부한다', async () => {
  userFindOneIds = [];
  await assert.rejects(
    () => proxiedDataSource.getRepository(User).findOne({ where: { id: 'system' } }),
    /invalid input syntax for type uuid/,
    '프록시가 Postgres 의 uuid 컬럼 거부를 재현해야 한다 — 아니면 이 파일은 아무것도 증명하지 못한다',
  );
  assert.deepEqual(userFindOneIds, ['system'], '계측이 실제 호출을 세고 있다');
});

test('add_comment: 비-uuid user author_id 는 User 조회 없이 폴백 이름으로 저장된다', async () => {
  const handlers = registerTools();
  const t = await makeTicket('비-uuid user author');
  userFindOneIds = [];

  const comment = parse(await handlers.get('add_comment')({
    ticket_id: t.id, content: 'sentinel 작성자가 남긴 코멘트',
    author_type: 'user', author_id: 'system',
  }, {}));

  assert.ok(comment.id, 'Postgres 에서 add_comment 가 통째로 실패하던 조합이다');
  assert.equal(comment.author, 'User #system', 'sqlite 와 같은 폴백 문자열을 유지한다');
  assert.deepEqual(userFindOneIds, [], '비-uuid id 로는 쿼리를 아예 보내지 않아야 한다');
});

test('ask_question(공유 resolveAuthor): 같은 가드가 적용된다', async () => {
  const handlers = registerTools();
  const t = await makeTicket('비-uuid user asker');
  userFindOneIds = [];

  const question = parse(await handlers.get('ask_question')({
    ticket_id: t.id, content: 'sentinel 작성자가 남긴 질문',
    author_type: 'user', author_id: 'auto-advance',
  }, {}));

  assert.ok(question.id);
  assert.equal(question.type, 'question');
  assert.equal(question.author, 'User #auto-advance');
  assert.deepEqual(userFindOneIds, [], 'resolveAuthor 를 공유하는 6개 툴이 같은 가드를 받는다');
});

// ── 대조군: 가드가 과차단하지 않는다 ─────────────────────────────────────
test('진짜 uuid user author_id 는 여전히 조회되고 이름이 해석된다', async () => {
  const handlers = registerTools();
  const t = await makeTicket('uuid user author');
  const user = await userRepo.save(userRepo.create({ name: '김담당', email: 'a@b.c' }));
  assert.match(user.id, UUID_RE, '픽스처 전제: 생성된 User.id 는 uuid 모양이다');
  userFindOneIds = [];

  const comment = parse(await handlers.get('add_comment')({
    ticket_id: t.id, content: '실존 사용자 코멘트',
    author_type: 'user', author_id: user.id,
  }, {}));

  assert.equal(comment.author, '김담당', '가드가 공허하지 않다 — uuid 경로는 그대로 조회된다');
  assert.deepEqual(userFindOneIds, [user.id], 'uuid 일 때는 findOne 이 정확히 1회 돈다');
});

test('author 를 명시하면 uuid 여부와 무관하게 조회 자체가 없다 (기존 동작)', async () => {
  const handlers = registerTools();
  const t = await makeTicket('명시 author');
  userFindOneIds = [];

  const comment = parse(await handlers.get('add_comment')({
    ticket_id: t.id, content: '이름을 직접 넘긴 코멘트',
    author_type: 'user', author_id: 'system', author: '운영자',
  }, {}));

  assert.equal(comment.author, '운영자');
  assert.deepEqual(userFindOneIds, [], '이름 해석이 필요 없으면 원래부터 조회하지 않는다');
});
