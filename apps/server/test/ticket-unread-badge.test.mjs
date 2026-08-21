// 사이드바 보드 뱃지(99+/36) 근거 불투명 — 티켓 628f4b39.
//
// GET /tickets/unread-counts (per-ticket/per-board 집계)와
// POST /tickets/read-all (보드 단위 + 워크스페이스 단위 일괄 읽음)의
// 통합 회귀 테스트. tickets-leak.test.mjs 와 동일하게 컴파일된 dist/ 에서
// NestJS 앱을 인프로세스로 부팅하고, 픽스처는 TypeORM 레포로 직접 심어
// (코멘트 생성 HTTP 경로의 멘션/디스패치 부수효과를 피하고) 엔드포인트만
// 실제 HTTP 로 구동한다.
//
// 지키는 불변식:
//   1. perBoard/perTicket/ticketBoard 집계가 역할 보유 티켓 전체에 걸쳐 정확하다
//   2. 본인이 쓴 코멘트는 미읽음에 포함되지 않는다
//   3. 아카이브된 티켓은 role 보유 여부와 무관하게 제외된다
//   4. read-all(board_id) 은 해당 보드로 resolve 되는 티켓만 건드린다 — 다른
//      보드는 그대로 남는다
//   5. read-all(board_id 생략) 은 involved 티켓 전체(이미 읽은 것 포함)를
//      건드린다 — TicketReadState 행이 실제로 그 user_id 로 upsert 된다
//   6. 마크 후 GET unread-counts 를 다시 부르면 뱃지가 정확히 줄어든다
//      ("unread-counts 응답 → 뱃지 감소" 경로)
//   7. read-all 이 실제로 뭔가 지웠으면 SSE `ticket_reads_cleared` 를 정확한
//      { user_id, workspace_id, board_id, updated } 로 emit 한다(다른 탭/
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
process.env.PORT = process.env.TICKET_UNREAD_BADGE_PORT || '7798';
process.env.NODE_ENV = 'test';
process.env.MCP_DEV_MODE = 'true';
process.env.AGENT_DEV_MODE = 'true';

const BASE_URL = makeBaseUrl(parseInt(process.env.PORT, 10));

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
  let boardRepo;
  let readStateRepo;
  let activityEvents;
  let viewer;
  let viewerToken;
  let ws;
  let boardA, boardB;
  let ticketA1, ticketA2, ticketA3Archived, ticketB1;

  const OTHER_1 = { author_id: 'other-agent-1', author_type: 'agent', author: 'Other One' };
  const OTHER_2 = { author_id: 'other-agent-2', author_type: 'agent', author: 'Other Two' };

  before(async () => {
    const modules = await loadServerModules();
    const { NestFactory, AppModule, AuthService, ReBACService, getDataSourceToken } = modules;
    activityEvents = modules.activityEvents;

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(parseInt(process.env.PORT, 10), '0.0.0.0');

    const authService = app.get(AuthService);
    const rebacService = app.get(ReBACService);
    const ds = app.get(getDataSourceToken());
    const userRepo = ds.getRepository('User');
    const wsRepo = ds.getRepository('Workspace');
    boardRepo = ds.getRepository('Board');
    const colRepo = ds.getRepository('BoardColumn');
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
    await rebacService.grant({ type: 'user', id: viewer.id }, 'member', { type: 'workspace', id: ws.id });

    boardA = await boardRepo.save(boardRepo.create({ name: 'Board A', workspace_id: ws.id }));
    boardB = await boardRepo.save(boardRepo.create({ name: 'Board B', workspace_id: ws.id }));
    const columnA = await colRepo.save(colRepo.create({ name: 'To Do', board_id: boardA.id, position: 0, color: '#e2e8f0' }));
    const columnB = await colRepo.save(colRepo.create({ name: 'To Do', board_id: boardB.id, position: 0, color: '#e2e8f0' }));

    // viewer is "involved" via three different role fields on purpose — the
    // involvement query ORs all three, and a bug narrowing it to just one
    // role would silently under-count real users (most of whom hold mixed
    // roles across their tickets).
    ticketA1 = await ticketRepo.save(ticketRepo.create({
      title: 'A1 — viewer is reporter', workspace_id: ws.id, column_id: columnA.id, reporter_id: viewer.id,
    }));
    ticketA2 = await ticketRepo.save(ticketRepo.create({
      title: 'A2 — viewer is assignee', workspace_id: ws.id, column_id: columnA.id, assignee_id: viewer.id,
    }));
    ticketB1 = await ticketRepo.save(ticketRepo.create({
      title: 'B1 — viewer is reviewer', workspace_id: ws.id, column_id: columnB.id, reviewer_id: viewer.id,
    }));
    // Archived + role-linked — must never appear in perTicket/perBoard even
    // though viewer is its reporter (invariant 3).
    ticketA3Archived = await ticketRepo.save(ticketRepo.create({
      title: 'A3 — archived, viewer is reporter', workspace_id: ws.id, column_id: columnA.id,
      reporter_id: viewer.id, archived_at: new Date(),
    }));

    const c = (ticket_id, extra) => commentRepo.create({ ticket_id, content: 'hi', ...extra });
    await commentRepo.save([
      c(ticketA1.id, OTHER_1), c(ticketA1.id, OTHER_1),
      // Own comment — must NOT count toward unread (invariant 2).
      c(ticketA1.id, { author_id: viewer.id, author_type: 'user', author: viewer.name }),
      c(ticketA2.id, OTHER_1), c(ticketA2.id, OTHER_1), c(ticketA2.id, OTHER_1),
      c(ticketB1.id, OTHER_2), c(ticketB1.id, OTHER_2), c(ticketB1.id, OTHER_2), c(ticketB1.id, OTHER_2),
      c(ticketA3Archived.id, OTHER_1), c(ticketA3Archived.id, OTHER_1),
    ]);
  });

  after(async () => {
    if (app) {
      try { await app.close(); } catch { /* ignore */ }
    }
    // No process.exit — suite runs with --test-force-exit (see package.json).
  });

  it('unread-counts: rolls up per-ticket/per-board, excludes own comments and archived tickets', async () => {
    const res = await apiRequest(BASE_URL, '/tickets/unread-counts', { token: viewerToken, workspaceId: ws.id });
    assert.equal(res.status, 200);
    const { total, perTicket, perBoard, ticketBoard } = res.data;

    assert.equal(total, 9, '2 (A1) + 3 (A2) + 4 (B1) — A1의 본인 코멘트, A3(아카이브) 전부 제외');
    assert.deepEqual(perTicket, { [ticketA1.id]: 2, [ticketA2.id]: 3, [ticketB1.id]: 4 });
    assert.deepEqual(perBoard, { [boardA.id]: 5, [boardB.id]: 4 }, 'A1+A2 = 5 가 boardA로, B1의 4가 boardB로 롤업');
    assert.deepEqual(ticketBoard, {
      [ticketA1.id]: boardA.id, [ticketA2.id]: boardA.id, [ticketB1.id]: boardB.id,
    });
  });

  it('read-all(board_id=A): only tickets resolving to board A are marked read, and ticket_reads_cleared fires for cross-device sync', async () => {
    const emitted = captureNextTicketReadsCleared(activityEvents);
    const res = await apiRequest(BASE_URL, '/tickets/read-all', {
      token: viewerToken, workspaceId: ws.id, method: 'POST', body: { board_id: boardA.id },
    });
    // NestJS defaults POST handlers to 201 unless @HttpCode()/res.status()
    // overrides it — this controller's other @Res()-style POST endpoints
    // (e.g. tickets/:id/read) follow the same convention; api.ts's `request`
    // treats any res.ok (2xx) as success, so this is intentional, not a bug.
    assert.equal(res.status, 201);
    assert.equal(res.data.updated, 2, 'boardA 로 resolve 되는 involved 티켓은 A1/A2 둘뿐');

    const rows = await readStateRepo.find({ where: { user_id: viewer.id } });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.user_id === viewer.id), '다른 user_id 로 행이 생기면 안 된다 (스코프 누수)');
    assert.ok(rows.every((r) => r.last_read_at), 'last_read_at 이 upsert 되어야 한다');

    const after = await apiRequest(BASE_URL, '/tickets/unread-counts', { token: viewerToken, workspaceId: ws.id });
    assert.equal(after.data.total, 4, 'boardB(B1)의 4건만 남아야 한다');
    assert.deepEqual(after.data.perBoard, { [boardB.id]: 4 }, 'boardA 뱃지는 0(키 자체가 사라짐)이어야 한다');
    assert.deepEqual(after.data.perTicket, { [ticketB1.id]: 4 });

    // 다른 탭/기기 동기화 계약: read-all 이 SSE ticket_reads_cleared 를 emit
    // 해야 NotificationContext 가 재조회 없이 다른 세션의 뱃지를 수렴시킨다
    // (BroadcastChannel 은 같은 브라우저 프로필의 탭에만 닿는다).
    const payload = await emitted;
    assert.equal(payload.user_id, viewer.id);
    assert.equal(payload.workspace_id, ws.id);
    assert.equal(payload.board_id, boardA.id, '보드 스코프 read-all 은 board_id 를 실어야 한다');
    assert.equal(payload.updated, 2);
    assert.ok(payload.read_at, 'read_at 이 있어야 한다');
  });

  it('read-all(no board_id): clears every involved ticket workspace-wide, including already-read ones, and emits a workspace-wide ticket_reads_cleared', async () => {
    const emitted = captureNextTicketReadsCleared(activityEvents);
    const res = await apiRequest(BASE_URL, '/tickets/read-all', {
      token: viewerToken, workspaceId: ws.id, method: 'POST', body: {},
    });
    assert.equal(res.status, 201);
    // Workspace-wide clears EVERY involved ticket (A1, A2, B1) — not just the
    // ones still carrying unread comments. A1/A2 were already read in the
    // previous test, so re-touching them (monotonic — now() only moves
    // forward) is expected, matching mentions.markAllRead's "clear
    // everything you're subscribed to" semantics.
    assert.equal(res.data.updated, 3);

    const after = await apiRequest(BASE_URL, '/tickets/unread-counts', { token: viewerToken, workspaceId: ws.id });
    assert.equal(after.data.total, 0);
    assert.deepEqual(after.data.perTicket, {});
    assert.deepEqual(after.data.perBoard, {});

    const payload = await emitted;
    assert.equal(payload.user_id, viewer.id);
    assert.equal(payload.workspace_id, ws.id);
    assert.equal(payload.board_id, null, 'board_id 생략(워크스페이스 전체)이면 null 이어야 한다');
    assert.equal(payload.updated, 3);
  });

  it('read-all(board_id): 0 involved tickets in that board is a no-op, not an error, and does not emit ticket_reads_cleared', async () => {
    let sawEmit = false;
    const handler = () => { sawEmit = true; };
    activityEvents.on('ticket_reads_cleared', handler);
    try {
      const otherBoard = await boardRepo.save(boardRepo.create({ name: 'Empty Board', workspace_id: ws.id }));
      const res = await apiRequest(BASE_URL, '/tickets/read-all', {
        token: viewerToken, workspaceId: ws.id, method: 'POST', body: { board_id: otherBoard.id },
      });
      assert.equal(res.status, 201);
      assert.equal(res.data.updated, 0);
      // 지울 게 없으면 다른 세션에 알릴 것도 없다 — no-op 요청까지 뱃지
      // 재조회를 유발하면 안 된다.
      assert.equal(sawEmit, false, '0건 read-all 은 ticket_reads_cleared 를 emit 하면 안 된다');
    } finally {
      activityEvents.removeListener('ticket_reads_cleared', handler);
    }
  });
});
