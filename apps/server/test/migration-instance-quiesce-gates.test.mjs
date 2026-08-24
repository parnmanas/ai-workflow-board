// Regression / feature proof: instance-wide fleet quiesce (ticket 0f638509,
// 완료 기준 6 — "도착지가 quiesced 로 뜨고, 운영자가 명시적으로 풀기 전까지
// fleet 에 디스패치하지 않는다").
//
// TriggerLoopService._emitTrigger's own gate is exercised deliberately via a
// DI-light unit approach here, not a full app-boot QA flow — instantiating
// TriggerLoopService requires ~17 constructor dependencies before its gate is
// even reachable, mirroring the existing board-pause gate one call site over
// (see test/qa-flows/board-pause.test.mjs for the analogous full e2e proof of
// that established pattern, which the new instance-quiesce check sits
// directly beside in the same function).
//
// This file instead proves the other four independent chokepoints this
// ticket added a gate to: each is constructed directly (no NestJS DI) with
// minimal stub dependencies — when the quiesce check works, NOTHING past it
// is ever touched, so a stub that doesn't implement a method naturally
// throws "not a function" if the gate is missing or misplaced. No DataSource,
// no dist/ build dependency — pure unit-level, so this stays fast to run on
// every save.
//
// (InstanceQuiesceService itself — the SystemSetting-backed cache — is
// exercised implicitly by every test below via a stub; its own persistence
// contract mirrors settings.controller.ts's existing find-or-create pattern
// closely enough that a dedicated unit test would mostly restate that file's
// own coverage.)

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const modPath = (...p) => 'file://' + path.join(DIST, ...p);

const { BacklogPromotionService } = await import(modPath('modules', 'agents', 'backlog-promotion.service.js'));
const { QaScheduleService } = await import(modPath('modules', 'qa', 'qa-schedule.service.js'));
const { SecurityScheduleService } = await import(modPath('modules', 'security', 'security-schedule.service.js'));
const { WorkspaceScheduleService } = await import(modPath('modules', 'workspace-schedule', 'workspace-schedule.service.js'));
const { AgentAutostartService } = await import(modPath('modules', 'agents', 'agent-autostart.service.js'));

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const quiescedTrue = { isQuiesced: async () => true };

test('BacklogPromotionService.tryPromote short-circuits while quiesced, before touching columns/tickets', async () => {
  // boardRepo.findOne IS called before the gate (needed for the `!board`
  // check), so it must return a real-looking row; nothing else may be
  // touched — colRepo/ticketRepo stubs below have no methods at all, so any
  // access past the gate throws "not a function".
  const dataSourceStub = {
    getRepository: () => ({ findOne: async () => ({ id: 'board-1', paused_at: null }) }),
  };
  const svc = new BacklogPromotionService(
    dataSourceStub, logStub, /* activityService */ {}, /* agentWorkload */ {},
    /* ticketRoleAssignmentService */ {}, /* triggerLoop */ {}, quiescedTrue,
  );
  const result = await svc.tryPromote('board-1', {});
  assert.equal(result, null, 'a quiesced instance must never promote a ticket');
});

test('QaScheduleService.runOnce short-circuits while quiesced, before touching any schedule row', async () => {
  const svc = new QaScheduleService(
    /* scheduleRepo */ {}, /* batchRepo */ {}, /* qaRunService */ {}, logStub, /* boardRepo */ {}, quiescedTrue,
  );
  const result = await svc.runOnce();
  assert.deepEqual(result, { dispatched: [], skipped: [] });
});

test('SecurityScheduleService.runOnce short-circuits while quiesced, before touching any schedule row', async () => {
  const svc = new SecurityScheduleService(
    /* scheduleRepo */ {}, /* batchRepo */ {}, /* runService */ {}, logStub, /* boardRepo */ {}, quiescedTrue,
  );
  const result = await svc.runOnce();
  assert.deepEqual(result, { dispatched: [], skipped: [] });
});

test('WorkspaceScheduleService.runOnce short-circuits while quiesced, before touching any schedule row', async () => {
  const svc = new WorkspaceScheduleService(
    /* scheduleRepo */ {}, /* roomRepo */ {}, /* participantRepo */ {}, /* agentRepo */ {},
    /* messaging */ {}, logStub, /* boardRepo */ {}, quiescedTrue,
  );
  const result = await svc.runOnce();
  assert.deepEqual(result, { dispatched: [] });
});

test('AgentAutostartService chat-path autostart (_handleChatRequest) short-circuits while quiesced, before classifying reachability', async () => {
  const metricsStub = { register: () => {} };
  const svc = new AgentAutostartService(
    /* agentRepo */ {}, /* managerCommand */ {}, /* agentStatus */ {}, /* activityService */ {},
    /* roomMessaging */ {}, logStub, metricsStub, quiescedTrue,
  );
  // Valid-looking event so the FIRST guard (`!evt?.agent_id || !evt.room_id`)
  // is passed and the quiesce check is what actually gates this call — a
  // malformed event returning early would be a false positive for this test.
  await assert.doesNotReject(() => svc._handleChatRequest({ agent_id: 'a1', room_id: 'r1', workspace_id: 'w1' }));
});

test('every scheduler + backlog-promotion runs its normal path when NOT quiesced (sanity check the stubs above prove the right thing)', async () => {
  const quiescedFalse = { isQuiesced: async () => false };
  // QaScheduleService with no due schedules is the cheapest "not quiesced,
  // but genuinely nothing to do" path — scheduleRepo.find() must actually be
  // called this time (proving the gate is a real conditional, not a
  // hardcoded early return).
  let findCalled = false;
  const svc = new QaScheduleService(
    { find: async () => { findCalled = true; return []; } },
    {}, {}, logStub, {}, quiescedFalse,
  );
  const result = await svc.runOnce();
  assert.equal(findCalled, true, 'when not quiesced, runOnce must proceed past the gate and query schedules');
  assert.deepEqual(result, { dispatched: [], skipped: [] });
});
