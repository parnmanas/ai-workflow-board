// 회귀 테스트 (Postgres 전용): 같은 dedupe_key 자동 알림의 중복 방지 — 티켓 62407d4e.
//
// 무엇이 깨져 있었나
// ─────────────────
//
// `add_comment` 의 합치기(dedupe merge)는 "이 티켓의 마지막 코멘트"를 찾아 작성자·type·
// dedupe_key 가 같으면 그 행의 repeat_count 를 올린다. 그 "마지막 코멘트" 판정이
// 티켓의 최신 created_at 을 읽어 **그와 같은 시각의 행**을 다시 조회하는 방식인데,
// 조회 조건이 등호(=) 하나였다.
//
// Postgres 의 `@CreateDateColumn()` 은 INSERT 시 CURRENT_TIMESTAMP 로 채워지고
// `timestamp` 기본 정밀도는 마이크로초다(05:11:20.689432). 그 행을 엔티티로 읽으면
// JS Date 라 밀리초까지만 남고(05:11:20.689), 그 값을 등호로 되돌리면 **자기 자신을
// 포함해 한 행도 일치하지 않는다.** 결과적으로 lastComment 가 항상 null 이라
// 합치기 분기에 영영 진입하지 못했고, `_comment_write_seq` 도 전부 1 에 고정됐다.
// 라이브 Postgres 실측(티켓 3건·코멘트 45건)에서 seq 최댓값이 1, repeat_count 가
// 찍힌 행 0건이었다. 그 사이 Done 진입 Git 정리 알림은 같은 dedupe_key 로 중복
// 발행됐다.
//
// 왜 Postgres 전용인가
// ───────────────────
//
// sqljs 는 저장 정밀도가 초 단위 문자열이라 이 결함 자체가 재현되지 않는다 —
// test/comment-tools-dedupe.test.mjs 가 그 드라이버에서 계약을 고정하지만, 그 green 을
// Postgres 의 보장으로 간주하면 안 된다(보드 교훈). 원자성(겹치는 호출) 역시 sqljs 는
// db.ts 의 serializeSqljsTransactions() 가 트랜잭션을 FIFO 로 직렬화해 버려 진짜 경합이
// 되지 않는다. 그래서 두 축 모두 이 파일이 진짜 커넥션 풀 위에서 검증한다.
//
// SKIP 규약: `DB_TYPE=postgres` 일 때만 실행된다(CI `test:qa:pg` 매트릭스). 기본 sqljs
// 실행에서는 사유를 남기고 자체 스킵하므로 어디서든 green 이다. 작성 환경(담당자
// 샌드박스)에는 Postgres 가 없으므로 **실제 green 은 pg 매트릭스에서 나온다** —
// chat-dm-promotion-pg-race.test.mjs 가 세운 것과 같은 규약이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

process.env.PORT = process.env.QA_PG_COMMENT_DEDUPE_PORT || '0';

const AUTHOR = { author_type: 'agent', author_id: 'manager-agent-1', author: 'Rolf' };
const DEDUPE_KEY = 'terminal-git-cleanup-held:2026-09-17T05:11:17.924Z';

function parse(res) {
  return JSON.parse(res.content[0].text);
}

function writeSeq(metadata) {
  const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata ?? {});
  return parsed._comment_write_seq;
}

test('Postgres: 같은 dedupe_key 자동 알림은 순차·동시 어느 쪽으로 와도 한 행으로 합쳐진다', { skip: SKIP }, async (t) => {
  const { bootApp, step } = await import('../helpers/boot.mjs');
  const { setupKanbanScene, createTicket } = await import('../helpers/fixtures.mjs');

  step('Boot NestJS app on Postgres (isolated schema)');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  assert.equal(
    ds.driver.options.type, 'postgres',
    '이 파일은 진짜 Postgres 타임스탬프 정밀도와 커넥션 풀에서만 의미가 있다 — 드라이버가 postgres 가 아니면 검증이 공허하다',
  );

  const { ActivityService } = await import('file://' + path.join(DIST_ROOT, 'services', 'activity.service.js'));
  const { registerCommentTools } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'mcp', 'tools', 'comment-tools.js')
  );

  const logStub = { warn() {}, info() {}, error() {}, debug() {} };
  const handlers = new Map();
  registerCommentTools(
    { tool(name, _description, _schema, handler) { handlers.set(name, handler); } },
    {
      dataSource: ds,
      activityService: new ActivityService(ds.getRepository('ActivityLog'), ds.getRepository('Agent'), logStub),
      mentionService: { parseMentions: () => [] },
      logger: logStub,
      ticketRoleAssignmentService: null,
      roomMessagingService: null,
      instanceQuiesceService: { isQuiesced: async () => false },
    },
  );
  const addComment = handlers.get('add_comment');
  // 부팅된 앱의 DataSource 를 그대로 쓰므로 엔티티는 등록된 이름으로 집는다.
  const commentRepo = ds.getRepository('Comment');

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'pgdedupe' });
  const makeTicket = (title) => createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title,
  });
  const notice = (ticketId, attempt) => addComment({
    ...AUTHOR,
    ticket_id: ticketId,
    content: `⚠️ Git 자동 정리를 보류했습니다 (attempt ${attempt})`,
    metadata: { dedupe_key: DEDUPE_KEY },
  }, {});

  // ── 케이스 1: 순차 재발행 — 원래 사건 그대로 ────────────────────────────
  step('같은 dedupe_key 로 연속 발행 — 한 행으로 합쳐져야 한다');
  {
    const ticket = await makeTicket('순차 중복 알림');
    const first = parse(await notice(ticket.id, 1));
    const second = parse(await notice(ticket.id, 2));

    assert.equal(
      second.id, first.id,
      '두 번째 알림이 새 행이 됐다 — Postgres 타임스탬프 정밀도 때문에 "마지막 코멘트" 조회가 0건이면 이렇게 된다(원래 결함).',
    );
    assert.equal(second.repeat_count, 2);
    assert.match(second.content, /attempt 2/, '합쳐진 행의 본문은 최신 발행으로 갱신된다');
    assert.equal(await commentRepo.count({ where: { ticket_id: ticket.id } }), 1);
  }

  // ── 케이스 2: 겹치는 발행 — 원자성 ─────────────────────────────────────
  step('같은 dedupe_key 로 동시 발행 — 직렬화돼 역시 한 행이어야 한다');
  {
    const ticket = await makeTicket('동시 중복 알림');
    const results = await Promise.allSettled([notice(ticket.id, 'A'), notice(ticket.id, 'B')]);
    assert.deepEqual(
      results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message), [],
      '양쪽 모두 성공해야 한다 — 한쪽은 insert, 다른 쪽은 그 행의 bump',
    );

    const rows = await commentRepo.find({ where: { ticket_id: ticket.id } });
    assert.equal(
      rows.length, 1,
      `동시 발행이 ${rows.length}개 행을 만들었다 — 티켓 행 잠금이 읽기-수정-쓰기를 직렬화하지 못했다는 뜻이다.`,
    );
    assert.equal(rows[0].repeat_count, 2, '한쪽이 다른 쪽의 행을 실제로 bump 했어야 한다');
  }

  // ── 케이스 3: write-seq 단조성 — 결함의 직접 지문 ────────────────────────
  step('dedupe_key 없는 코멘트의 _comment_write_seq 는 티켓 안에서 단조 증가한다');
  {
    const ticket = await makeTicket('write-seq 단조성');
    const seqs = [];
    for (const n of [1, 2, 3]) {
      const saved = parse(await addComment({
        ...AUTHOR, ticket_id: ticket.id, content: `일반 코멘트 ${n}`,
      }, {}));
      seqs.push(writeSeq(saved.metadata));
    }
    assert.deepEqual(
      seqs, [1, 2, 3],
      `write-seq 가 ${JSON.stringify(seqs)} 였다 — 전부 1 이면 tied-group 조회가 0건을 반환한다는 뜻이고, ` +
      '그 상태에서는 어떤 dedupe_key 도 합쳐지지 않는다(라이브 Postgres 에서 관측된 지문).',
    );
  }
});
