// QA flow: focus lease 교착 — 중복/선행 티켓이 슬롯을 붙들어 backlog 승격이
// 멈추는 문제 (ticket 2cc54fde).
//
// 무엇을 증명하는가
// ─────────────────
//
// 이 코드베이스의 "focus lease" 는 저장된 락이 아니라 계산된 값이다:
// `AgentWorkloadService.getWorkflowLoadTicketIds` 후보 집합에 티켓이 들어
// 있으면 슬롯을 점유한 것이고, 빠지면 그 순간 해제된 것이다
// (`src/modules/agents/focus-eligibility.ts` 헤더 참조).
//
// 그런데 dispatch 경로는 `canonical_ticket_id` 가 붙은 중복 티켓의 트리거를
// 전부 버리면서도, focus 후보 쿼리는 그 티켓을 계속 점유자로 셌다. 중복
// 티켓이 절대 진행되지 않으면서 슬롯만 영구 점유했고, canonical/선행 티켓
// 승격은 `backlog_promotion_skipped_focus_held` 로 무한 차단됐다 — 수동
// archive 전까지 풀리지 않던 교착.
//
// 커버리지 (티켓 요구사항 5의 다섯 항목):
//
//   1. duplicate→canonical — 실제 `TicketDuplicateService.confirm()` 을 태운다.
//      confirm 은 `pending_user_action` 을 끄면서 `canonical_ticket_id` 를
//      붙이므로, 픽스 이전에는 중복 티켓이 그 순간 focus 자격을 **되찾아**
//      슬롯을 영구 점유했다(요구사항 2의 "이후 재획득 금지"가 가리키는 지점).
//   2. 재획득 금지 — 중복 티켓은 intake 에서도 다시 승격되지 않는다.
//   3. A→B prerequisite — 선행 등록으로 슬롯이 회수되고, 브로드캐스트를 타고
//      선행 티켓이 자동 재개(승격)된다. max_concurrent=1.
//   4. archive/supersede — 실제 archive 전이 경로 두 개(MCP `archive_ticket`,
//      REST `POST /api/tickets/:id/archive`)를 각각 태워 슬롯 회수 + 자동 재개
//      + 해제 사유 감사 기록을 확인한다.
//   5. 동시 승격 경합 — 두 패스가 같은 티켓을 이중 승격하지 않는다.
//
// 요구사항 6(운영 로그)은 각 케이스에서 `focus_lease_released` 감사 행의
// `reason=` 토큰을 직접 단언해 함께 검증한다.
//
// 검증 원칙: 자동 복구를 주장하는 단언은 `tryPromote()` 를 직접 부르지 않는다.
// 상태 전이는 실제 운영 경로(confirm / archive 도구 / add_ticket_prerequisites)
// 로 일으키고, 그 뒤 승격과 `trigger_emitted` 가 저절로 일어나기를 기다린다 —
// 직접 호출로 승격시키면 브로드캐스트 누락을 영영 잡지 못한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';
import {
  createWorkspace,
  createAgent,
  createApiKey,
  createColumn,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_FOCUS_LEASE_PORT || '7948';

test('focus lease 교착 — 중복/선행/archive 가 슬롯을 놓고 canonical·선행 티켓이 자동 복구된다', async (t) => {
  try {
    step('Boot NestJS app on test port');
    const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
    t.after(() => { void app.close().catch(() => {}); });
    const { getDataSourceToken } = modules;

    const backlogPromotionModule = await import(
      'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'backlog-promotion.service.js')
    );
    const agentWorkloadModule = await import(
      'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-workload.service.js')
    );
    const prerequisitesModule = await import(
      'file://' + path.join(DIST_ROOT, 'modules', 'tickets', 'ticket-prerequisites.service.js')
    );
    const duplicateModule = await import(
      'file://' + path.join(DIST_ROOT, 'modules', 'tickets', 'ticket-duplicate.service.js')
    );
    const duplicatePendingModule = await import(
      'file://' + path.join(DIST_ROOT, 'modules', 'tickets', 'ticket-duplicate-pending.js')
    );
    const authModule = await import(
      'file://' + path.join(DIST_ROOT, 'services', 'auth.service.js')
    );
    const backlogPromotion = app.get(backlogPromotionModule.BacklogPromotionService);
    const agentWorkload = app.get(agentWorkloadModule.AgentWorkloadService);
    const prerequisites = app.get(prerequisitesModule.TicketPrerequisitesService);
    const duplicates = app.get(duplicateModule.TicketDuplicateService);
    const ds = app.get(getDataSourceToken());

    step('Seed workspace + driver user + assignee agent');
    const ws = await createWorkspace(app, getDataSourceToken, 'focuslease');
    await createUser(app, getDataSourceToken, { name: 'driver' });
    const alice = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
    const aliceKey = await createApiKey(app, getDataSourceToken, alice.id, { workspaceId: ws.id, label: 'alice' });

    // Case 4 는 실제 archive 전이 경로 두 개를 그대로 태운다: MCP `archive_ticket`
    // 은 HTTP JSON-RPC 로, REST 아카이브는 로그인 세션 토큰으로 호출한다.
    const port = parseInt(process.env.PORT, 10);
    const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: aliceKey.raw_key });
    await mcp.initialize();
    const restUser = await createUser(app, getDataSourceToken, { name: 'archiver' });
    const restToken = app.get(authModule.AuthService).createSession(restUser.id);

    const boardRepo = ds.getRepository('Board');
    const colRepo = ds.getRepository('BoardColumn');
    const ticketRepo = ds.getRepository('Ticket');
    const activityLogRepo = ds.getRepository('ActivityLog');
    const resourceRepo = ds.getRepository('Resource');

    // ticket 8c3befa8 — base repo 가 없는 active 컬럼에 assignee 를 dispatch 하면
    // emit 이 '' 을 돌려주며 pend 된다. 케이스 1에서 "canonical 이 실제로
    // dispatch 됐다" 를 단언하려면 보드가 코드 저장소를 선언해야 한다.
    const repoResource = await resourceRepo.save(resourceRepo.create({
      workspace_id: ws.id, name: 'focus lease repo', type: 'repository',
      url: 'https://github.com/parnmanas/ai-workflow-board.git', default_branch: 'main',
    }));

    // Backlog(intake) → To Do(active, assignee 라우팅) → Done(terminal).
    // max_concurrent_tickets_per_agent = 1 — 요구사항 5의 "max_concurrent=1
    // 에서 슬롯 회수" 조건.
    async function makeBoard(name) {
      const board = await boardRepo.save(boardRepo.create({
        name, description: '', workspace_id: ws.id,
        routing_config: JSON.stringify({}),
        environment_config: JSON.stringify({ repositories: [{ resource_id: repoResource.id }] }),
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
      return { board, backlog, todo, done };
    }

    async function countAction(action, ticketId) {
      return (await activityLogRepo.find({ where: { action, ticket_id: ticketId } })).length;
    }
    async function releaseReasons(ticketId) {
      const rows = await activityLogRepo.find({
        where: { action: 'focus_lease_released', ticket_id: ticketId },
      });
      return rows.map(r => /reason=(\S+)/.exec(r.new_value || '')?.[1] || '');
    }
    // 브로드캐스트를 타고 도는 승격은 fire-and-forget 이라 즉시 관측되지
    // 않는다. 조건이 만족될 때까지 짧게 폴링한다(타임아웃이면 실패로 남는다).
    async function waitFor(label, predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await predicate();
        if (last) return last;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.fail(`timed out waiting for: ${label}`);
    }

    // ──────────────────────────────────────────────────────────────────
    // Case 1 — duplicate→canonical. 실제 `TicketDuplicateService.confirm()`.
    //
    // confirm 은 한 트랜잭션에서 `pending_user_action` 을 끄고
    // `canonical_ticket_id` 를 붙인다. 픽스 이전에는 그 순간 중복 티켓이
    // focus 자격을 **되찾아** 슬롯을 영구 점유했다 — dispatch 는 절대 되지
    // 않으므로 canonical 은 영원히 승격되지 못한다.
    // ──────────────────────────────────────────────────────────────────
    step('Case 1 — confirm() 이후 중복이 슬롯을 되찾지 않고 canonical 이 자동 복구된다');
    const c1 = await makeBoard('lease-case1');

    // D — active 컬럼에서 중복 판정을 기다리는 리포트. 실제 인테이크가 만드는
    // 상태 그대로다(`duplicate_decision_guard` 가 세운 pending).
    const tDup = await createTicket(app, getDataSourceToken, {
      columnId: c1.todo.id, workspaceId: ws.id, title: 'D-duplicate-report', priority: 'critical',
      assigneeId: alice.id,
    });
    // C — backlog 에서 승격을 기다리는 canonical 후보.
    const tCanonical = await createTicket(app, getDataSourceToken, {
      columnId: c1.backlog.id, workspaceId: ws.id, title: 'C-canonical', priority: 'medium',
      assigneeId: alice.id,
    });
    await ticketRepo.update(tDup.id, {
      pending_user_action: true,
      pending_reason: 'Confirm whether this report duplicates one of the suggested tickets.',
      pending_set_at: new Date(),
      pending_set_by: duplicatePendingModule.DUPLICATE_PENDING_SET_BY,
    });
    const decisionRepo = ds.getRepository('TicketDuplicateDecision');
    await decisionRepo.save(decisionRepo.create({
      workspace_id: ws.id,
      report_ticket_id: tDup.id,
      candidate_ticket_id: tCanonical.id,
      outcome: 'ambiguous_pending',
      confidence: 80,
      matched_signals: JSON.stringify(['title']),
      actor_name: 'qa-fixture',
    }));

    step('  기준선: 판정 대기 중인 D 는 아직 슬롯을 잡고 있지 않다');
    assert.equal(
      await agentWorkload.getFocusTicket(alice.id, c1.board.id, 'assignee'), null,
      'pending_user_action 인 동안에는 focus 를 점유하지 않아야 한다 (기존 a57517be 동작)',
    );

    step('  실제 confirm() 호출 — pending 이 풀리고 canonical 이 붙는다');
    const confirmed = await duplicates.confirm(tDup.id, tCanonical.id, 'qa-operator', restUser.id);
    assert.equal(confirmed.canonical_ticket_id, tCanonical.id, 'confirm 은 canonical 연결을 저장해야 한다');
    assert.equal(!!confirmed.pending_user_action, false, 'confirm 은 duplicate pending 을 해제해야 한다');

    step('  재획득 금지 — pending 이 풀렸어도 D 는 focus 를 되찾지 못한다');
    assert.equal(
      await agentWorkload.getFocusTicket(alice.id, c1.board.id, 'assignee'), null,
      'confirm 직후 중복 티켓이 focus 를 재획득하면 안 된다 (교착의 실제 진입점)',
    );
    assert.deepEqual(
      await agentWorkload.getAgentFocusTicketIds(alice.id, c1.board.id, 1), [],
      '중복 티켓은 max_concurrent focus 카운트에도 포함되면 안 된다',
    );

    step('  자동 복구 — tryPromote 직접 호출 없이 canonical 이 승격 + dispatch 된다');
    const canonicalAfter = await waitFor('canonical 이 first-active 컬럼으로 승격', async () => {
      const row = await ticketRepo.findOne({ where: { id: tCanonical.id } });
      return row?.column_id === c1.todo.id ? row : null;
    });
    assert.equal(canonicalAfter.column_id, c1.todo.id, 'canonical 은 first-active 컬럼으로 이동해야 한다');
    await waitFor('canonical 의 trigger_emitted 행', async () => (
      await countAction('trigger_emitted', tCanonical.id) === 1 ? true : null
    ));
    const dupAfter = await ticketRepo.findOne({ where: { id: tDup.id } });
    assert.equal(
      dupAfter.column_id, c1.todo.id,
      '중복 티켓 자체는 움직이지 않는다 (자동 archive 는 이 픽스의 범위가 아니다)',
    );

    step('  요구사항 6 — 해제 사유가 운영 감사에 남는다');
    await waitFor('D 의 focus_lease_released 감사 행', async () => {
      const reasons = await releaseReasons(tDup.id);
      return reasons.includes('duplicate_link') ? reasons : null;
    });
    const promotedRow = await activityLogRepo.findOne({
      where: { action: 'backlog_promoted', ticket_id: tCanonical.id },
    });
    assert.match(
      promotedRow?.new_value || '', /released_leases=\d+/,
      `승격 감사 행에 자동 복구 결과(released_leases)가 있어야 한다 (got ${promotedRow?.new_value})`,
    );

    step('  억제 확인 — 상태가 그대로면 반복 스윕이 감사 행을 도배하지 않는다');
    await backlogPromotion.tryPromote(c1.board.id);
    await backlogPromotion.tryPromote(c1.board.id);
    assert.equal(
      (await releaseReasons(tDup.id)).length, 1,
      '같은 (티켓, 사유) 조합은 상태가 바뀌기 전까지 한 번만 기록돼야 한다',
    );

    // ──────────────────────────────────────────────────────────────────
    // Case 2 — 재획득 금지. 중복 티켓은 intake 에서도 승격되지 않는다.
    // ──────────────────────────────────────────────────────────────────
    step('Case 2 — 중복 티켓은 intake 에서 다시 슬롯을 가져가지 못한다');
    const c2 = await makeBoard('lease-case2');
    const tCanon2 = await createTicket(app, getDataSourceToken, {
      columnId: c2.done.id, workspaceId: ws.id, title: 'C2-canonical', priority: 'medium',
      assigneeId: alice.id,
    });
    const tDupIntake = await createTicket(app, getDataSourceToken, {
      columnId: c2.backlog.id, workspaceId: ws.id, title: 'C2-duplicate-in-intake', priority: 'critical',
      assigneeId: alice.id,
    });
    await ticketRepo.update(tDupIntake.id, { canonical_ticket_id: tCanon2.id });

    const promoted2 = await backlogPromotion.tryPromote(c2.board.id);
    assert.equal(
      promoted2, null,
      `중복 티켓이 유일한 후보면 승격은 no-op 여야 한다 (got ${promoted2?.slice(0, 8) || 'null'})`,
    );
    const dupIntakeAfter = await ticketRepo.findOne({ where: { id: tDupIntake.id } });
    assert.equal(dupIntakeAfter.column_id, c2.backlog.id, '중복 티켓은 intake 에 그대로 남아야 한다');
    assert.equal(
      await countAction('backlog_promoted', tDupIntake.id), 0,
      '중복 티켓은 backlog_promoted 감사 행을 만들면 안 된다',
    );

    // ──────────────────────────────────────────────────────────────────
    // Case 3 — A→B prerequisite. 슬롯 회수 + 브로드캐스트 자동 재개.
    // ──────────────────────────────────────────────────────────────────
    step('Case 3 — 선행 등록으로 슬롯이 회수되고 선행 티켓이 자동 재개된다');
    const c3 = await makeBoard('lease-case3');
    // B — active 컬럼에서 focus 를 점유 중. 곧 A 를 선행으로 등록한다.
    const tB = await createTicket(app, getDataSourceToken, {
      columnId: c3.todo.id, workspaceId: ws.id, title: 'B-dependent', priority: 'high',
      assigneeId: alice.id,
    });
    // A — B 가 기다릴 선행 티켓. backlog 에 있다.
    const tA = await createTicket(app, getDataSourceToken, {
      columnId: c3.backlog.id, workspaceId: ws.id, title: 'A-prerequisite', priority: 'medium',
      assigneeId: alice.id,
    });

    assert.equal(
      await agentWorkload.getFocusTicket(alice.id, c3.board.id, 'assignee'), tB.id,
      'B 가 focus 를 점유한 상태에서 시작해야 한다',
    );
    assert.equal(
      await backlogPromotion.tryPromote(c3.board.id), null,
      '선행 등록 전에는 A 가 승격되지 않아야 한다 (기준선)',
    );

    step('  add_ticket_prerequisites(B ← A) — pending_on_tickets 가 켜진다');
    const addResult = await prerequisites.addPrerequisites(tB.id, [tA.id], {
      reason: 'A 가 끝나야 B 를 진행할 수 있음', actorName: 'qa-fixture',
    });
    assert.equal(addResult.pending_on_tickets, true, '미완료 선행이 있으면 pending_on_tickets 가 true 여야 한다');

    step('  B 는 focus 후보/카운트에서 즉시 빠진다');
    assert.equal(
      await agentWorkload.getFocusTicket(alice.id, c3.board.id, 'assignee'), null,
      '선행 대기 중인 티켓은 focus 를 점유하면 안 된다',
    );
    assert.deepEqual(
      await agentWorkload.getAgentFocusTicketIds(alice.id, c3.board.id, 1), [],
      '선행 대기 티켓은 max_concurrent focus 카운트에서 빠져야 한다',
    );

    step('  자동 재개 — tryPromote 를 직접 부르지 않아도 A 가 승격된다');
    const aPromoted = await waitFor('A 가 first-active 컬럼으로 승격', async () => {
      const row = await ticketRepo.findOne({ where: { id: tA.id } });
      return row?.column_id === c3.todo.id ? row : null;
    });
    assert.equal(aPromoted.column_id, c3.todo.id, '선행 티켓 A 가 수동 개입 없이 승격돼야 한다');
    assert.equal(
      await countAction('backlog_promoted', tA.id), 1,
      '자동 재개는 정확히 하나의 backlog_promoted 행을 남겨야 한다',
    );

    step('  선행 티켓 A 가 실제로 dispatch 됐다 (완료 기준: 수동 개입 없는 dispatch)');
    await waitFor('A 의 trigger_emitted 행', async () => (
      await countAction('trigger_emitted', tA.id) === 1 ? true : null
    ));

    step('  요구사항 6 — 해제 사유가 pending_on_tickets 로 기록된다');
    await waitFor('B 의 focus_lease_released 감사 행', async () => {
      const reasons = await releaseReasons(tB.id);
      return reasons.includes('pending_on_tickets') ? reasons : null;
    });

    // ──────────────────────────────────────────────────────────────────
    // Case 4 — archive/supersede 로 슬롯 회수. 실제 전이 경로 두 개를 각각
    // 태운다. DB 를 직접 갱신하고 `tryPromote()` 를 손으로 부르면 아카이브
    // 경로에 브로드캐스트가 없어도 테스트가 통과해 버린다 — 그래서 여기서는
    // 도구/엔드포인트를 그대로 호출하고 승격이 저절로 일어나기를 기다린다.
    // ──────────────────────────────────────────────────────────────────
    for (const variant of [
      {
        label: 'MCP archive_ticket',
        board: 'lease-case4-mcp',
        archive: async (ticketId) => {
          const res = await mcp.callTool('archive_ticket', { ticket_id: ticketId });
          assert.ok(!res?.isError, `archive_ticket 호출이 실패했다: ${JSON.stringify(res)}`);
        },
      },
      {
        label: 'REST POST /api/tickets/:id/archive',
        board: 'lease-case4-rest',
        archive: async (ticketId) => {
          const res = await fetch(`http://localhost:${port}/api/tickets/${ticketId}/archive`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${restToken}`, 'Content-Type': 'application/json' },
          });
          assert.ok(res.ok, `REST archive 가 2xx 여야 한다 (got ${res.status})`);
        },
      },
    ]) {
      step(`Case 4 — ${variant.label} 로 슬롯이 회수되고 다음 티켓이 자동 재개된다`);
      const c4 = await makeBoard(variant.board);
      const tSuperseded = await createTicket(app, getDataSourceToken, {
        columnId: c4.todo.id, workspaceId: ws.id, title: 'S-superseded', priority: 'high',
        assigneeId: alice.id,
      });
      const tNext = await createTicket(app, getDataSourceToken, {
        columnId: c4.backlog.id, workspaceId: ws.id, title: 'N-next-in-line', priority: 'medium',
        assigneeId: alice.id,
      });

      step('  기준선: S 가 슬롯을 점유 중이라 N 은 승격 대상이 아니다');
      assert.equal(
        await agentWorkload.getFocusTicket(alice.id, c4.board.id, 'assignee'), tSuperseded.id,
        'S 는 평범한 active 티켓이므로 focus 를 점유해야 한다',
      );
      assert.equal(
        (await ticketRepo.findOne({ where: { id: tNext.id } })).column_id, c4.backlog.id,
        'N 은 아직 intake 에 있어야 한다',
      );

      step(`  ${variant.label} 실행`);
      await variant.archive(tSuperseded.id);
      assert.ok(
        (await ticketRepo.findOne({ where: { id: tSuperseded.id } })).archived_at,
        'archive 경로가 실제로 archived_at 을 기록해야 한다',
      );

      step('  자동 재개 — tryPromote 직접 호출 없이 N 이 승격 + dispatch 된다');
      await waitFor(`${variant.label}: N 이 first-active 컬럼으로 승격`, async () => {
        const row = await ticketRepo.findOne({ where: { id: tNext.id } });
        return row?.column_id === c4.todo.id ? row : null;
      });
      await waitFor(`${variant.label}: N 의 trigger_emitted 행`, async () => (
        await countAction('trigger_emitted', tNext.id) === 1 ? true : null
      ));

      step('  요구사항 6 — 해제 사유가 archived 로 기록된다');
      await waitFor(`${variant.label}: S 의 focus_lease_released 감사 행`, async () => {
        const reasons = await releaseReasons(tSuperseded.id);
        return reasons.includes('archived') ? reasons : null;
      });
    }

    // ──────────────────────────────────────────────────────────────────
    // Case 5 — 동시 승격 경합. 같은 티켓이 두 번 승격되면 안 된다.
    // ──────────────────────────────────────────────────────────────────
    step('Case 5 — 동시 tryPromote 두 개가 같은 티켓을 이중 승격하지 않는다');
    const c5 = await makeBoard('lease-case5');
    const bob = await createAgent(app, getDataSourceToken, ws.id, { name: 'bob' });
    await createApiKey(app, getDataSourceToken, bob.id, { workspaceId: ws.id, label: 'bob' });
    // 담당자를 나눠 둔다 — 한쪽이 슬롯을 채워도 다른 후보가 여전히 적격이라
    // 두 패스가 실제로 같은 후보를 놓고 겹칠 여지가 남는다.
    const tRace1 = await createTicket(app, getDataSourceToken, {
      columnId: c5.backlog.id, workspaceId: ws.id, title: 'R1', priority: 'critical',
      assigneeId: alice.id,
    });
    const tRace2 = await createTicket(app, getDataSourceToken, {
      columnId: c5.backlog.id, workspaceId: ws.id, title: 'R2', priority: 'high',
      assigneeId: bob.id,
    });

    const [r1, r2] = await Promise.all([
      backlogPromotion.tryPromote(c5.board.id, { triggerAgentId: 'race-a' }),
      backlogPromotion.tryPromote(c5.board.id, { triggerAgentId: 'race-b' }),
    ]);
    const returned = [r1, r2].filter(Boolean);
    assert.equal(
      new Set(returned).size, returned.length,
      `동시 승격 두 패스가 같은 티켓 id 를 돌려주면 안 된다 (got ${JSON.stringify([r1, r2])})`,
    );
    for (const tid of [tRace1.id, tRace2.id]) {
      const n = await countAction('backlog_promoted', tid);
      assert.ok(n <= 1, `티켓 ${tid.slice(0, 8)} 은 backlog_promoted 행이 최대 1개여야 한다 (got ${n})`);
      const moved = await ticketRepo.findOne({ where: { id: tid } });
      if (n === 1) {
        assert.equal(moved.column_id, c5.todo.id, '승격 행이 있으면 실제로 이동해 있어야 한다');
      }
    }
    assert.ok(returned.length >= 1, '동시 경합이라도 최소 한 건은 승격돼야 한다 (양쪽 다 no-op 이면 회귀)');

    step('감사 근거 — 이번 실행에서 관측된 focus_lease_released 행');
    for (const r of await activityLogRepo.find({ where: { action: 'focus_lease_released' } })) {
      console.log(`  ticket=${(r.ticket_id || '').slice(0, 8)}  ${r.new_value || ''}`);
    }

    exitAfterTests(0);
  } catch (e) {
    console.error(e);
    throw e;
  }
});
