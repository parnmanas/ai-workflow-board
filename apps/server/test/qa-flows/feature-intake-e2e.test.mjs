// Feature/Epic intake E2E (ticket aae7644c) — the one-stop automated development
// loop's ENTRY, end to end against a booted server with a real DB + the real
// FeaturesService / TicketPrerequisitesService / TriggerLoopService (NOT stubs).
//
// Proves DoD #1: one requirement → planning dispatch → structured chain proposal
// → 1-click approval → atomic ticket chain (prereq-wired, root auto-dispatched)
// → progress rollup flips to `done` when the chain finishes. And DoD #2's spawn
// shape: the planning round lands a real chat message on the planner agent (the
// same chat→agent route QA/Security/workspace-schedule dispatch rides).
//
// The chain deliverables are ORDINARY tickets — no new execution engine — so the
// test asserts on plain Ticket/prerequisite rows, exactly what the existing board
// loop consumes.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.FEATURE_INTAKE_E2E_PORT || '7846';

const REQUIREMENT = [
  '보드 카드에 마감일(due date)을 붙이고, 지난 카드를 빨갛게 표시하고,',
  '마감 임박 카드는 담당자에게 알림을 보낸다.',
].join('\n');

test('Feature intake E2E: 요구사항 → 기획 디스패치 → 구조화 제안 → 승인 → 체인 자동생성/배선 → 롤업 done', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { FeaturesService } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'features', 'features.service.js')
  );
  const svc = app.get(FeaturesService);
  const ds = app.get(getDataSourceToken());

  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'feature-intake-e2e' });
  // The planner the intake dispatches its planning round to.
  const planner = await createAgent(app, getDataSourceToken, ws.id, { name: 'planner-bot' });

  step('intake 생성 (auto_plan) → 상태 planning + 기획방 스폰 + 프롬프트 메시지 영속화');
  const created = await svc.create({
    workspace_id: ws.id,
    board_id: board.id,
    title: '카드 마감일 & 지연 알림',
    requirement: REQUIREMENT,
    planner_agent_id: planner.id,
    created_by: 'e2e',
    created_by_id: planner.id,
  });
  assert.equal(created.status, 'planning', 'auto_plan dispatched → status advanced to planning');
  assert.ok(created.planning_room_id, 'a planning room was opened');

  const roomSeats = (await ds.getRepository('ChatRoomParticipant').find({ where: { room_id: created.planning_room_id } }))
    .map((p) => `${p.participant_type}:${p.participant_id}`).sort();
  assert.deepEqual(roomSeats, [`agent:${planner.id}`, 'user:system'].sort(), 'planner + synthetic system user seated in the planning room');

  const planningMsgs = await ds.getRepository('ChatRoomMessage').find({ where: { room_id: created.planning_room_id } });
  const prompt = planningMsgs.find((m) => m.content.includes('propose_feature_chain'));
  assert.ok(prompt, 'planning prompt persisted and instructs the planner to call propose_feature_chain');
  assert.ok(prompt.content.includes(created.id), 'prompt carries the feature id for the callback');

  step('planner 가 구조화 체인 제안 제출 (t1→t2→t3 선형) → 상태 proposed');
  const proposed = await svc.proposeChain(created.id, {
    summary: '엔티티→표시→알림 3단계',
    tickets: [
      { key: 't1', title: 'Ticket 엔티티에 due_date 컬럼 + 마이그레이션', priority: 'high' },
      { key: 't2', title: '보드 카드에서 지난 마감 빨간 표시', priority: 'medium' },
      { key: 't3', title: '마감 임박 담당자 알림', priority: 'medium' },
    ],
    edges: [
      { from: 't1', to: 't2' },
      { from: 't2', to: 't3' },
    ],
  });
  assert.equal(proposed.status, 'proposed', 'proposal stored → awaiting approval');
  assert.equal(proposed.proposal.tickets.length, 3, 'three proposed tickets');
  assert.equal(proposed.proposal.edges.length, 2, 'two prerequisite edges');

  step('승인 (1클릭) → 3티켓 원자적 생성 + prereq 배선 + 루트 t1 자동 착수 + 상태 running');
  const { feature: approved, ticket_ids } = await svc.approve(created.id);
  assert.equal(approved.status, 'running', 'feature is running after approval');
  assert.equal(ticket_ids.length, 3, 'exactly three chain tickets created');
  assert.deepEqual(approved.generated_ticket_ids, ticket_ids, 'generated_ticket_ids persisted');

  const ticketRepo = ds.getRepository('Ticket');
  const byOrder = [];
  for (const id of ticket_ids) byOrder.push(await ticketRepo.findOne({ where: { id } }));
  const [t1, t2, t3] = byOrder;
  assert.ok(t1 && t2 && t3, 'all three tickets loaded');
  // Root (no incoming edge) is NOT blocked and sits on the routed active column.
  assert.equal(!!t1.pending_on_tickets, false, 't1 (root) is not blocked');
  assert.equal(t1.column_id, columns.inProgress.id, 't1 landed on the first routed active column (In Progress)');
  // Dependents are blocked until their prerequisite reaches a terminal column.
  assert.equal(!!t2.pending_on_tickets, true, 't2 blocked on t1');
  assert.equal(!!t3.pending_on_tickets, true, 't3 blocked on t2');
  // Every generated ticket is tagged for rollup/audit.
  for (const tk of byOrder) {
    const labels = JSON.parse(tk.labels || '[]');
    assert.ok(labels.includes('feature-chain'), `${tk.title} tagged feature-chain`);
    assert.ok(labels.includes(`feature:${created.id}`), `${tk.title} tagged feature:<id>`);
  }

  step('prereq 배선 실측: t2 의 선행조건 = [t1], t3 의 선행조건 = [t2]');
  const prereqRepo = ds.getRepository('TicketPrerequisite');
  const t2Prereqs = (await prereqRepo.find({ where: { ticket_id: t2.id } })).map((r) => r.prerequisite_ticket_id);
  const t3Prereqs = (await prereqRepo.find({ where: { ticket_id: t3.id } })).map((r) => r.prerequisite_ticket_id);
  assert.deepEqual(t2Prereqs, [t1.id], 't2 ← t1 prerequisite edge wired');
  assert.deepEqual(t3Prereqs, [t2.id], 't3 ← t2 prerequisite edge wired');

  step('rollup 진행률: 착수 시점 0/3 done');
  const roll0 = await svc.rollup(await svc.get(created.id));
  assert.equal(roll0.total, 3, 'rollup counts all three');
  assert.equal(roll0.done, 0, 'none done yet');

  step('체인 전부 terminal(Done) 도달 → rollup 이 Feature 를 done 으로 지연 전이');
  for (const tk of byOrder) {
    tk.column_id = columns.done.id;
    await ticketRepo.save(tk);
  }
  const rollDone = await svc.rollup(await svc.get(created.id));
  assert.equal(rollDone.done, 3, 'all three now terminal');
  assert.equal(rollDone.total, 3, 'total unchanged');
  const finalFeature = await svc.get(created.id);
  assert.equal(finalFeature.status, 'done', 'Feature lazily flipped to done once every ticket reached a terminal column');

  exitAfterTests(0);
});
