// QA flow: Agent Manager(type='manager') 는 절대 작업하지 않는다 (ticket 941c72d3).
//
// Manager 에이전트는 supervisor 로서 agent 를 spawn/stop 할 뿐, 티켓의 role
// holder / 트리거 대상 / chat 참가자가 되어서는 안 된다. 이 플로우는 그 구조적
// 차단을 서버 chokepoint 단위로 검증한다:
//   1. TicketRoleAssignmentService.setHolders  — manager 를 strip(무시)
//   2. TicketRoleAssignmentService.setHolder    — manager 지정은 무시하되 기존 holder 를 wipe 하지 않음
//   3. validateBoardDefaults                    — manager default holder 거부
//   4. applyBoardDefaults                       — manager default 는 write 되지 않음
//   5. TriggerLoopService._resolveRoleHolders   — 이미 배정된 manager holder 도 트리거 대상에서 제외
//   6. RoomMembershipService.filterOutManagerParticipants — chat 참가자에서 manager agent 만 제거
//
// 정상 agent(worker) 흐름은 모든 단계에서 그대로 살아남아야 한다(회귀 가드).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createTicket,
  addRoleHolder,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

const BASE_PORT = parseInt(process.env.QA_MANAGER_NOOP_PORT || '7899', 10);
process.env.PORT = String(BASE_PORT);

test('manager agent is never a role holder / trigger target / chat participant', async (t) => {
  const { app, modules } = await bootApp({ port: BASE_PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const roleAssignModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'workspace-roles', 'ticket-role-assignment.service.js'),
  );
  const triggerLoopModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'trigger-loop.service.js'),
  );
  const membershipModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'chat-rooms', 'room-membership.service.js'),
  );
  const roleSvc = app.get(roleAssignModule.TicketRoleAssignmentService);
  const triggerLoop = app.get(triggerLoopModule.TriggerLoopService);
  const membership = app.get(membershipModule.RoomMembershipService);

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'mgr-noop' });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker', type: 'claude' });
  const manager = await createAgent(app, getDataSourceToken, ws.id, { name: 'boss', type: 'manager' });

  const roleRepo = ds.getRepository('WorkspaceRole');
  const assigneeRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'assignee' } });
  const reviewerRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'reviewer' } });

  // Ticket with NO holders yet — role writes go through the service under test.
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id,
    workspaceId: ws.id,
    title: 'mgr-noop',
  });

  step('setHolders([worker, manager]) → manager stripped, worker persisted');
  {
    const rows = await roleSvc.setHolders(ticket.id, assigneeRole.id, [
      { agent_id: worker.id },
      { agent_id: manager.id },
    ]);
    const ids = rows.map((r) => r.agent_id);
    assert.ok(ids.includes(worker.id), 'worker persisted as holder');
    assert.ok(!ids.includes(manager.id), 'manager was stripped from the holder set');
  }

  step('setHolder(manager) is ignored and must NOT wipe the existing worker holder');
  {
    const res = await roleSvc.setHolder(ticket.id, assigneeRole.id, { agent_id: manager.id });
    const after = await roleSvc.getOne(ticket.id, assigneeRole.id);
    assert.equal(after?.agent_id, worker.id, 'worker holder preserved (not wiped by manager set)');
    assert.equal(res?.agent_id, worker.id, 'setHolder returns the preserved worker holder');
  }

  step('validateBoardDefaults: worker default OK, manager default rejected');
  {
    const ok = await roleSvc.validateBoardDefaults(ws.id, { assignee: [{ agent_id: worker.id }] });
    assert.equal(ok.ok, true, 'a worker default holder validates');
    const bad = await roleSvc.validateBoardDefaults(ws.id, { assignee: [{ agent_id: manager.id }] });
    assert.equal(bad.ok, false, 'a manager default holder is rejected');
  }

  step('applyBoardDefaults never writes a manager holder into a vacant role');
  {
    const summary = await roleSvc.applyBoardDefaults(ticket.id, ws.id, {
      reviewer: [{ agent_id: manager.id }],
    });
    const held = await roleSvc.getAll(ticket.id, reviewerRole.id);
    assert.equal(held.length, 0, 'manager default did not populate the vacant reviewer role');
    assert.ok(!summary.some((s) => s.slug === 'reviewer'), 'no reviewer entry in the applied summary');
  }

  step('_resolveRoleHolders excludes an already-assigned manager holder');
  {
    // Seed a raw manager holder next to the worker (defends pre-existing rows,
    // bypassing the service guard the way a legacy assignment would have).
    await addRoleHolder(app, getDataSourceToken, {
      ticketId: ticket.id,
      workspaceId: ws.id,
      agentId: manager.id,
      slug: 'assignee',
    });
    const resolved = await triggerLoop._resolveRoleHolders(ticket, 'assignee');
    assert.ok(resolved, 'assignee slug resolves');
    assert.ok(resolved.agentIds.includes(worker.id), 'worker remains a trigger target');
    assert.ok(!resolved.agentIds.includes(manager.id), 'manager excluded from trigger targets');
  }

  step('chat filterOutManagerParticipants removes manager agents only');
  {
    const filtered = await membership.filterOutManagerParticipants([
      { participant_type: 'agent', participant_id: worker.id },
      { participant_type: 'agent', participant_id: manager.id },
      { participant_type: 'user', participant_id: '11111111-1111-1111-1111-111111111111' },
    ]);
    const ids = filtered.map((p) => p.participant_id);
    assert.ok(ids.includes(worker.id), 'worker agent kept as participant');
    assert.ok(ids.includes('11111111-1111-1111-1111-111111111111'), 'user participant kept');
    assert.ok(!ids.includes(manager.id), 'manager agent stripped from participants');
  }
});

exitAfterTests();
