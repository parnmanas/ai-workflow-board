// Regression (Postgres 전용): (board, agent) 승격 슬롯 경합 — ticket 2cc54fde.
//
// 왜 sql.js 로는 증명이 안 되는가
// ──────────────────────────────
//
// 막아야 하는 결함은 write skew 다: 두 `tryPromote()` 가 **같은 담당자**의 서로
// 다른 backlog 후보를 고르면, 둘 다 "이 담당자의 focus window 는 비어 있다" 를
// 읽고 서로 다른 티켓 행을 CAS 해 각각 성공한다. 담당자는 cap 을 넘겨 두
// 티켓을 쥐게 된다.
//
// 이 인터리빙은 **진짜 동시 트랜잭션이 있어야만** 재현된다. sql.js 백엔드는
// 단일 WASM 커넥션이고 `db.ts` 의 `serializeSqljsTransactions()` 가 트랜잭션을
// FIFO 로 직렬화하므로, 한쪽의 이동이 다른 쪽에 즉시 보인다 — 두 번째 패스가
// 알아서 cap 포화를 보고 물러난다. 즉 sqljs 스위트
// (`focus-lease-deadlock.test.mjs` Case 5a)는 "cap 이 지켜진다" 는 불변식은
// 고정하지만, 픽스 이전 코드로도 통과하므로 이 경합의 회귀 테스트가 될 수
// 없다. 보드 교훈 그대로 — sql.js 통과를 PostgreSQL 병렬 보장으로 간주하지
// 않는다.
//
// Postgres 에서는 커넥션 풀이 있어 한 프로세스 안의 두 `tryPromote()` 도 실제로
// 병렬 트랜잭션이 된다. READ COMMITTED 에서 A 가 커밋하기 전 B 가 읽으면 B 는
// 여전히 빈 focus window 를 본다 — 서로 다른 행을 건드리므로 행 잠금도
// 만나지 않는다. 그래서 `BacklogPromotionService._lockBoardForPromotion()` 이
// 보드 행을 `FOR UPDATE` 로 잡아 두 패스를 같은 객체 위에 줄 세운다. 이 파일이
// 검증하는 것이 바로 그 직렬화다.
//
// SKIP 규약: `DB_TYPE=postgres` 일 때만 실행된다(CI `test:qa:pg` 매트릭스).
// 기본 sql.js 실행에서는 사유를 남기고 자체 스킵하므로 어디서든 green 이다.
// 작성 환경(담당자 샌드박스)에는 Postgres 가 없어 로컬에서는 로드 + 자체 스킵만
// 확인했고, 실제 green 은 pg 매트릭스에서 나와야 한다 —
// `dispatch-intent-pg-race.test.mjs` 가 세운 것과 같은 규약이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

process.env.PORT = process.env.QA_PG_SLOT_RACE_PORT || '7949';

test('Postgres: 같은 담당자의 두 후보를 동시에 승격해도 cap=1 이 지켜진다', { skip: SKIP }, async (t) => {
  const { bootApp, exitAfterTests, step } = await import('../helpers/boot.mjs');
  const {
    createWorkspace, createAgent, createApiKey, createColumn, createTicket, createUser,
  } = await import('../helpers/fixtures.mjs');

  step('Boot NestJS app on Postgres (isolated schema)');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const backlogPromotionModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'backlog-promotion.service.js')
  );
  const agentWorkloadModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-workload.service.js')
  );
  const backlogPromotion = app.get(backlogPromotionModule.BacklogPromotionService);
  const agentWorkload = app.get(agentWorkloadModule.AgentWorkloadService);
  const ds = app.get(getDataSourceToken());

  assert.equal(
    ds.driver.options.type, 'postgres',
    '이 파일은 진짜 Postgres 커넥션 풀에서만 의미가 있다 — 드라이버가 postgres 가 아니면 검증이 공허하다',
  );

  step('Seed workspace + 담당자 1명');
  const ws = await createWorkspace(app, getDataSourceToken, 'pgslot');
  await createUser(app, getDataSourceToken, { name: 'driver' });
  const alice = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
  await createApiKey(app, getDataSourceToken, alice.id, { workspaceId: ws.id, label: 'alice' });

  const boardRepo = ds.getRepository('Board');
  const colRepo = ds.getRepository('BoardColumn');
  const ticketRepo = ds.getRepository('Ticket');
  const activityLogRepo = ds.getRepository('ActivityLog');

  step('Backlog(intake) → To Do(active, assignee) 보드, max_concurrent=1');
  const board = await boardRepo.save(boardRepo.create({
    name: 'pg-slot-race', description: '', workspace_id: ws.id,
    routing_config: JSON.stringify({}),
    max_concurrent_tickets_per_agent: 1,
  }));
  const backlog = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Backlog', position: 0, workspaceId: ws.id,
  });
  const todo = await createColumn(app, getDataSourceToken, board.id, {
    name: 'To Do', position: 1, workspaceId: ws.id,
  });
  const done = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Done', position: 2, workspaceId: ws.id, isTerminal: true,
  });
  await colRepo.update(backlog.id, { kind: 'intake', role_routing: JSON.stringify(['reporter']) });
  await colRepo.update(todo.id, { kind: 'active', role_routing: JSON.stringify(['assignee']) });
  await colRepo.update(done.id, { kind: 'terminal', role_routing: JSON.stringify([]) });

  step('같은 담당자(alice)의 backlog 후보 2건');
  const t1 = await createTicket(app, getDataSourceToken, {
    columnId: backlog.id, workspaceId: ws.id, title: 'PG-R1', priority: 'critical',
    assigneeId: alice.id,
  });
  const t2 = await createTicket(app, getDataSourceToken, {
    columnId: backlog.id, workspaceId: ws.id, title: 'PG-R2', priority: 'high',
    assigneeId: alice.id,
  });

  step('두 tryPromote 를 병렬 실행 — Postgres 풀에서 실제 동시 트랜잭션이 된다');
  const [r1, r2] = await Promise.all([
    backlogPromotion.tryPromote(board.id, { triggerAgentId: 'pg-race-a' }),
    backlogPromotion.tryPromote(board.id, { triggerAgentId: 'pg-race-b' }),
  ]);

  const reported = [r1, r2].filter(Boolean);
  assert.equal(
    reported.length, 1,
    `cap=1 담당자에게 동시 승격은 정확히 한 건만 성공해야 한다 (got ${JSON.stringify([r1, r2])}) ` +
    '— 두 건이면 보드 행 잠금이 write skew 를 막지 못한 것이다',
  );

  step('실제 이동 / 감사 행 / focus 도 한 건인지 확인');
  const moved = [];
  for (const id of [t1.id, t2.id]) {
    const row = await ticketRepo.findOne({ where: { id } });
    if (row.column_id === todo.id) moved.push(id);
    const promotedRows = await activityLogRepo.find({
      where: { action: 'backlog_promoted', ticket_id: id },
    });
    assert.ok(
      promotedRows.length <= 1,
      `티켓 ${id.slice(0, 8)} 의 backlog_promoted 감사 행은 최대 1건이어야 한다 (got ${promotedRows.length})`,
    );
  }
  assert.deepEqual(
    moved, reported,
    `active 컬럼으로 이동한 티켓은 승격을 보고한 티켓과 일치해야 한다 ` +
    `(moved=${JSON.stringify(moved)} reported=${JSON.stringify(reported)})`,
  );

  const load = await agentWorkload.getWorkflowLoadTicketIds(alice.id, board.id);
  assert.equal(
    load.length, 1,
    `cap=1 보드에서 담당자가 active 로 들고 있는 티켓은 1건이어야 한다 (got ${load.length}: ${JSON.stringify(load)})`,
  );
  const focus = await agentWorkload.getAgentFocusTicketIds(alice.id, board.id, 1);
  assert.deepEqual(focus, reported, '담당자 focus window 는 승격된 한 건이어야 한다');

  step('남은 후보는 다음 패스에서도 cap 포화로 승격되지 않는다');
  const again = await backlogPromotion.tryPromote(board.id, { triggerAgentId: 'pg-race-c' });
  assert.equal(
    again, null,
    `슬롯이 여전히 차 있으므로 두 번째 후보는 승격되면 안 된다 (got ${again})`,
  );

  exitAfterTests(0);
});
