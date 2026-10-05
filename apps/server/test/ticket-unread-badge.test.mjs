// 사이드바 티켓 뱃지(99+/36) 근거 불투명 — 티켓 628f4b39.
//
// GET /tickets/unread-counts (per-ticket 집계)와 POST /tickets/read-all
// (워크스페이스 단위 일괄 읽음)의 통합 회귀 테스트. tickets-leak.test.mjs 와
// 동일하게 컴파일된 dist/ 에서 NestJS 앱을 인프로세스로 부팅하고, 픽스처는
// TypeORM 레포로 직접 심어 (코멘트 생성 HTTP 경로의 멘션/디스패치 부수효과를
// 피하고) 엔드포인트만 실제 HTTP 로 구동한다.
//
// 보드가 없어진 뒤(docs/tickets.md) "관여" 티켓은 사용자가 만든 티켓 + 한 번이라도
// 읽은(TicketReadState 행이 있는) 티켓이다 — 티켓의 담당자는 agent 하나라 사람
// 역할 필드는 없다. 응답에서 perBoard/ticketBoard 는 사라졌다.
//
// 지키는 불변식:
//   1. perTicket/total 집계가 관여 티켓(생성 + 읽은 적 있음) 전체에 걸쳐 정확하다
//   2. 본인이 쓴 코멘트, 마지막 읽음 시각 이전 코멘트는 미읽음에 포함되지 않는다
//   3. 아카이브된 티켓은 생성자든 읽은 적이 있든 제외된다; 관여하지 않은 티켓도 제외
//   4. read-all 은 involved 티켓 전체(이미 읽은 것 포함)를 건드린다 —
//      TicketReadState 행이 실제로 그 user_id 로 upsert 된다
//   5. 마크 후 GET unread-counts 를 다시 부르면 뱃지가 정확히 0 이 된다
//      ("unread-counts 응답 → 뱃지 감소" 경로)
//   6. read-all 이 실제로 뭔가 지웠으면 SSE `ticket_reads_cleared` 를 정확한
//      { user_id, account_id, updated, read_at } 로 emit 한다(다른 탭/
//      기기 동기화 계약) — 지운 게 0건이면 emit 하지 않는다

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { apiRequest, makeBaseUrl } from './test-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
// Hermetic sql.js DB per file — see tickets-leak.test.mjs's identical note:
// without this, back-to-back files in the npm `test` chain share
// database/data.db and leak rows into each other's assertions.
process.env.SQLJS_DB_PATH =
  process.env.SQLJS_DB_PATH || path.join(os.tmpdir(), `awb-ticket-unread-badge-${Date.now()}-${process.pid}.db`);
process.env.PORT = process.env.TICKET_UNREAD_BADGE_PORT || '0';
process.env.NODE_ENV = 'test';
process.env.MCP_DEV_MODE = 'true';
process.env.AGENT_DEV_MODE = 'true';

// 요청 포트가 0(OS 배정)이라 listen 전에는 URL 을 만들 수 없다 — 이 파일은
// bootApp 을 쓰지 않고 NestJS 를 인라인으로 띄우므로, 바인딩된 뒤 실제 포트로
// 직접 채운다(ticket f2d82793).
let BASE_URL;

async function loadServerModules() {
  const distRoot = path.join(__dirname, '..', 'dist');
  try {
    const { NestFactory } = await import('@nestjs/core');
    const appModuleUrl = 'file://' + path.join(distRoot, 'app.module.js');
    const authServiceUrl = 'file://' + path.join(distRoot, 'services', 'auth.service.js');
    const rebacServiceUrl = 'file://' + path.join(distRoot, 'services', 'rebac.service.js');
    const activityServiceUrl = 'file://' + path.join(distRoot, 'services', 'activity.service.js');
    const { AppModule } = await import(appModuleUrl);
    const { AuthService } = await import(authServiceUrl);
    const { ReBACService } = await import(rebacServiceUrl);
    const { activityEvents } = await import(activityServiceUrl);
    const { getDataSourceToken } = await import('@nestjs/typeorm');
    return { NestFactory, AppModule, AuthService, ReBACService, activityEvents, getDataSourceToken };
  } catch (err) {
    throw new Error(
      'ticket-unread-badge test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' + err.message
    );
  }
}

// activityEvents 로부터 다음 'ticket_reads_cleared' emit 하나를 캡처한다
// (SSE 구독 없이도 emit 계약을 직접 고정 — event-registry.ts가 이 emitterEvent
// 를 그대로 구독해 웹 UI로 흘려보낸다).
function captureNextTicketReadsCleared(activityEvents) {
  return new Promise((resolve) => {
    activityEvents.once('ticket_reads_cleared', resolve);
  });
}

describe('ticket-unread-badge: unread-counts + read-all', async () => {
  let app;
  let userRepo;
  let readStateRepo;
  let activityEvents;
  let authService;
  let viewer;
  let viewerToken;
  let ws;
  let ownA, readB, ownC, ownArchived, readArchived, uninvolved;

  const OTHER_1 = { author_id: 'other-agent-1', author_type: 'agent', author: 'Other One' };
  const OTHER_2 = { author_id: 'other-agent-2', author_type: 'agent', author: 'Other Two' };

  before(async () => {
    const modules = await loadServerModules();
    const { NestFactory, AppModule, AuthService, ReBACService, getDataSourceToken } = modules;
    activityEvents = modules.activityEvents;

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(parseInt(process.env.PORT, 10), '0.0.0.0');
    BASE_URL = makeBaseUrl(app.getHttpServer().address().port);

    authService = app.get(AuthService);
    const rebacService = app.get(ReBACService);
    const ds = app.get(getDataSourceToken());
    userRepo = ds.getRepository('User');
    const wsRepo = ds.getRepository('Account');
    const ticketRepo = ds.getRepository('Ticket');
    const commentRepo = ds.getRepository('Comment');
    readStateRepo = ds.getRepository('TicketReadState');

    viewer = await userRepo.save(userRepo.create({
      name: 'Unread Badge Viewer',
      email: `unread-badge-viewer-${randomUUID()}@awb.local`,
      role: 'user',
      status: 'active',
    }));
    viewerToken = authService.createSession(viewer.id);

    ws = await wsRepo.save(wsRepo.create({ name: 'Unread Badge WS', description: 'ticket 628f4b39' }));
    await rebacService.grant({ type: 'user', id: viewer.id }, 'member', { type: 'account', id: ws.id });

    const mk = (title, extra = {}) => ticketRepo.save(ticketRepo.create({
      title, account_id: ws.id, status: 'todo', ...extra,
    }));
    // viewer is "involved" through both paths on purpose — the involvement
    // query unions created-by and read-state, and a bug narrowing it to just
    // one would silently under-count real users.
    ownA = await mk('A — viewer created it', { created_by_id: viewer.id });
    readB = await mk('B — viewer read it once', { created_by_id: 'someone-else' });
    ownC = await mk('C — viewer created it', { created_by_id: viewer.id, status: 'in_progress' });
    // Archived — must never appear in perTicket whichever path made the viewer
    // involved (invariant 3).
    ownArchived = await mk('archived, viewer created it', { created_by_id: viewer.id, archived_at: new Date() });
    readArchived = await mk('archived, viewer read it', { created_by_id: 'someone-else', archived_at: new Date() });
    uninvolved = await mk('not the viewer\'s ticket', { created_by_id: 'someone-else' });

    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    await readStateRepo.save([
      readStateRepo.create({ user_id: viewer.id, ticket_id: readB.id, account_id: ws.id, last_read_at: anHourAgo }),
      readStateRepo.create({ user_id: viewer.id, ticket_id: readArchived.id, account_id: ws.id, last_read_at: anHourAgo }),
    ]);

    const c = (ticket_id, extra) => commentRepo.create({ ticket_id, content: 'hi', ...extra });
    await commentRepo.save([
      c(ownA.id, OTHER_1), c(ownA.id, OTHER_1),
      // Own comment — must NOT count toward unread (invariant 2).
      c(ownA.id, { author_id: viewer.id, author_type: 'user', author: viewer.name }),
      c(readB.id, OTHER_1), c(readB.id, OTHER_1), c(readB.id, OTHER_1),
      c(ownC.id, OTHER_2), c(ownC.id, OTHER_2), c(ownC.id, OTHER_2), c(ownC.id, OTHER_2),
      c(ownArchived.id, OTHER_1), c(ownArchived.id, OTHER_1),
      c(readArchived.id, OTHER_1),
      c(uninvolved.id, OTHER_2),
    ]);
    // A comment the viewer already read (older than its read marker) — not unread.
    const oldComment = await commentRepo.save(c(readB.id, OTHER_2));
    await commentRepo.update(oldComment.id, { created_at: new Date(anHourAgo.getTime() - 60_000) });
  });

  after(async () => {
    if (app) {
      try { await app.close(); } catch { /* ignore */ }
    }
    // No process.exit — suite runs with --test-force-exit (see package.json).
  });

  it('unread-counts: rolls up per-ticket, excludes own/already-read comments, archived and uninvolved tickets', async () => {
    const res = await apiRequest(BASE_URL, '/tickets/unread-counts', { token: viewerToken, accountId: ws.id });
    assert.equal(res.status, 200);
    const { total, perTicket } = res.data;

    assert.equal(total, 9, '2 (A) + 3 (B) + 4 (C) — 본인 코멘트, 읽은 뒤의 코멘트만, 아카이브/비관여 티켓 전부 제외');
    assert.deepEqual(perTicket, { [ownA.id]: 2, [readB.id]: 3, [ownC.id]: 4 });
    assert.equal('perBoard' in res.data, false, '보드가 없으므로 perBoard 롤업도 없다');
    assert.equal('ticketBoard' in res.data, false);
  });

  it('read-all: clears every involved ticket workspace-wide, including already-read ones, and emits ticket_reads_cleared', async () => {
    const emitted = captureNextTicketReadsCleared(activityEvents);
    const res = await apiRequest(BASE_URL, '/tickets/read-all', {
      token: viewerToken, accountId: ws.id, method: 'POST', body: {},
    });
    // NestJS defaults POST handlers to 201 unless @HttpCode()/res.status()
    // overrides it — this controller's other @Res()-style POST endpoints
    // (e.g. tickets/:id/read) follow the same convention; api.ts's `request`
    // treats any res.ok (2xx) as success, so this is intentional, not a bug.
    assert.equal(res.status, 201);
    // Every involved ticket (A, B, C) — not just the ones still carrying
    // unread comments, matching mentions.markAllRead's "clear everything
    // you're subscribed to" semantics. Archived ones are not touched.
    assert.equal(res.data.updated, 3);

    const rows = await readStateRepo.find({ where: { user_id: viewer.id } });
    const byTicket = new Map(rows.map((r) => [r.ticket_id, r]));
    for (const id of [ownA.id, readB.id, ownC.id]) {
      assert.ok(byTicket.get(id)?.last_read_at, `involved ticket ${id} 의 last_read_at 이 upsert 되어야 한다`);
    }
    assert.ok(rows.every((r) => r.user_id === viewer.id), '다른 user_id 로 행이 생기면 안 된다 (스코프 누수)');
    assert.equal(byTicket.has(uninvolved.id), false, '관여하지 않은 티켓에 read-state 행을 만들면 안 된다');
    assert.equal(byTicket.has(ownArchived.id), false, '아카이브된 티켓은 read-all 대상이 아니다');

    const after = await apiRequest(BASE_URL, '/tickets/unread-counts', { token: viewerToken, accountId: ws.id });
    assert.equal(after.data.total, 0);
    assert.deepEqual(after.data.perTicket, {});

    // 다른 탭/기기 동기화 계약: read-all 이 SSE ticket_reads_cleared 를 emit
    // 해야 NotificationContext 가 재조회 없이 다른 세션의 뱃지를 수렴시킨다
    // (BroadcastChannel 은 같은 브라우저 프로필의 탭에만 닿는다).
    const payload = await emitted;
    assert.equal(payload.user_id, viewer.id);
    assert.equal(payload.account_id, ws.id);
    assert.equal(payload.updated, 3);
    assert.ok(payload.read_at, 'read_at 이 있어야 한다');
  });

  it('read-all: a user with 0 involved tickets is a no-op, not an error, and does not emit ticket_reads_cleared', async () => {
    const bystander = await userRepo.save(userRepo.create({
      name: 'Unread Badge Bystander',
      email: `unread-badge-bystander-${randomUUID()}@awb.local`,
      role: 'admin',
      status: 'active',
    }));
    const bystanderToken = authService.createSession(bystander.id);
    let sawEmit = false;
    const handler = () => { sawEmit = true; };
    activityEvents.on('ticket_reads_cleared', handler);
    try {
      const res = await apiRequest(BASE_URL, '/tickets/read-all', {
        token: bystanderToken, accountId: ws.id, method: 'POST', body: {},
      });
      assert.ok(res.status === 200 || res.status === 201, `read-all must succeed, got ${res.status}`);
      assert.equal(res.data.updated, 0);
      // 지울 게 없으면 다른 세션에 알릴 것도 없다 — no-op 요청까지 뱃지
      // 재조회를 유발하면 안 된다.
      assert.equal(sawEmit, false, '0건 read-all 은 ticket_reads_cleared 를 emit 하면 안 된다');
      assert.equal(await readStateRepo.count({ where: { user_id: bystander.id } }), 0);
    } finally {
      activityEvents.removeListener('ticket_reads_cleared', handler);
    }
  });
});
