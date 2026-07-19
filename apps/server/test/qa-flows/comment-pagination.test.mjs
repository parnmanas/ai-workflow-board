// QA flow: 티켓 코멘트 동적 로딩(커서 페이지네이션).
//
// Ticket 04defc87 회귀 가드. detail GET 은 코멘트 트리 전체를 메모리에 올려
// 직렬화하던 OOM 경로였다. 이제:
//
//   • GET /api/tickets/:id          → root 코멘트는 최신 N개(기본 50)로 bounded,
//     comments_has_more 플래그를 함께 싣는다(트리 전체 로드 금지).
//   • GET /api/tickets/:id/comments → (created_at,id) 복합 커서로 더 오래된
//     페이지를 최신순(DESC) 반환. limit 기본 50/최대 200, `before`=코멘트 id.
//     동일 timestamp 행도 건너뛰지 않는다.
//
// detail GET 이 다시 전체 코멘트를 싣거나, 커서가 페이지를 빠뜨리거나/겹치면
// 이 테스트가 실패한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createTicket, createUser } from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_COMMENT_PAGINATION_PORT || '7814';

const TOTAL = 120;
const PAGE = 50; // DETAIL_COMMENT_PAGE 와 동일

test('comment dynamic loading: bounded detail GET + cursor pagination', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'comment-pagination',
  });
  const user = await createUser(app, getDataSourceToken, { name: 'reader' });
  const token = app.get(AuthService).createSession(user.id);
  const authHeaders = { Authorization: `Bearer ${token}` };

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'pagination ticket',
  });

  step(`Seed ${TOTAL} comments (created_at 1s apart, with a same-timestamp triple)`);
  const commentRepo = ds.getRepository('Comment');
  const base = new Date('2026-01-01T00:00:00.000Z').getTime();
  for (let i = 0; i < TOTAL; i++) {
    // 인덱스 60,61,62 를 동일 timestamp 로 → 커서가 동일 timestamp 를 건너뛰는지 검증
    let ms = base + i * 1000;
    if (i === 61 || i === 62) ms = base + 60 * 1000;
    await commentRepo.save(commentRepo.create({
      ticket_id: ticket.id, workspace_id: ws.id, author: 'U', author_type: 'user',
      author_id: 'u1', content: `c${i}`, type: 'note', status: null,
      attachment_resource_ids: '[]', metadata: '{}', created_at: new Date(ms),
    }));
  }

  step('GET /api/tickets/:id — bounded to newest page + comments_has_more');
  const detailRes = await fetch(`http://localhost:${port}/api/tickets/${ticket.id}`, { headers: authHeaders });
  assert.equal(detailRes.status, 200, 'detail GET should succeed');
  const detail = await detailRes.json();
  assert.equal(detail.comments.length, PAGE, `detail ships only newest ${PAGE} comments`);
  assert.equal(detail.comments_has_more, true, 'comments_has_more true when older exist');
  assert.equal(detail.comments[0].content, `c${TOTAL - 1}`, 'newest comment first (DESC)');
  // body/author 가 살아있어야 함(전체-thread 계약은 페이지 안에서 유지)
  assert.equal(detail.comments[0].author, 'U', 'comment body/author preserved');

  step('GET /api/tickets/:id/comments — first page matches detail page');
  const page1Res = await fetch(`http://localhost:${port}/api/tickets/${ticket.id}/comments`, { headers: authHeaders });
  assert.equal(page1Res.status, 200, 'comments endpoint should succeed');
  const page1 = await page1Res.json();
  assert.equal(page1.length, PAGE, `first page = ${PAGE}`);
  assert.equal(page1[0].content, `c${TOTAL - 1}`, 'first page newest-first');

  step('Cursor walk to exhaustion — no overlap, no skip, full coverage');
  const seen = new Map(); // id -> content
  for (const c of page1) seen.set(c.id, c.content);
  let cursor = page1[page1.length - 1].id;
  let guard = 0;
  while (guard++ < 10) {
    const res = await fetch(`http://localhost:${port}/api/tickets/${ticket.id}/comments?before=${cursor}`, { headers: authHeaders });
    assert.equal(res.status, 200, 'older page fetch should succeed');
    const pg = await res.json();
    if (pg.length === 0) break;
    for (const c of pg) {
      assert.equal(seen.has(c.id), false, `no overlap: ${c.content} appeared twice`);
      seen.set(c.id, c.content);
    }
    cursor = pg[pg.length - 1].id;
    if (pg.length < PAGE) break; // 소진
  }
  assert.equal(seen.size, TOTAL, `cursor walk covered all ${TOTAL} comments exactly once`);
  // 동일 timestamp 3개 모두 수집됐는지
  const collected = new Set([...seen.values()]);
  assert.ok(collected.has('c60') && collected.has('c61') && collected.has('c62'),
    'same-timestamp triple (c60,c61,c62) all collected — cursor never skips a tie');

  step('limit cap — request 9999 returns at most 200');
  const capRes = await fetch(`http://localhost:${port}/api/tickets/${ticket.id}/comments?limit=9999`, { headers: authHeaders });
  const capPage = await capRes.json();
  assert.ok(capPage.length <= 200, `limit capped at 200, got ${capPage.length}`);

  step('unknown ticket → 404');
  const missingTicketId = '00000000-0000-4000-8000-000000000000';
  const missingRes = await fetch(`http://localhost:${port}/api/tickets/${missingTicketId}/comments`, { headers: authHeaders });
  assert.equal(missingRes.status, 404, 'missing ticket returns 404');

  exitAfterTests(0);
});
