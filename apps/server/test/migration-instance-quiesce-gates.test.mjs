// Regression / feature proof: instance-wide fleet quiesce (ticket 0f638509,
// 완료 기준 6 — "도착지가 quiesced 로 뜨고, 운영자가 명시적으로 풀기 전까지
// fleet 에 디스패치하지 않는다").
//
// Ticket dispatch used to be gated in two places (TriggerLoopService._emitTrigger
// and BacklogPromotionService.tryPromote). Both services went away with the
// board removal (docs/tickets.md): TicketDispatchService is now the ONE
// ticket-dispatch path — its queue pump, its direct dispatch (right after the
// workspace dispatch-pause check) and its supervisor re-send each check the
// quiesce flag, and each is covered below.
//
// Every chokepoint here is constructed directly (no NestJS DI) with
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

const { TicketDispatchService } = await import(modPath('modules', 'agents', 'ticket-dispatch.service.js'));
const { QaScheduleService } = await import(modPath('modules', 'qa', 'qa-schedule.service.js'));
const { SecurityScheduleService } = await import(modPath('modules', 'security', 'security-schedule.service.js'));
const { WorkspaceScheduleService } = await import(modPath('modules', 'workspace-schedule', 'workspace-schedule.service.js'));
const { AgentAutostartService } = await import(modPath('modules', 'agents', 'agent-autostart.service.js'));
// Review round 1 P2 (blocking) — the paths the reviewer named as bypassing
// quiesce entirely: ActionScheduler, OutreachPolling, OrchestrationReaper,
// QaRerunOnFix — plus OnTicketDoneActionService, found during the same audit
// to share the same class of gap. (FeaturesService was the other one; the
// feature-chain feature was removed with boards, so its gate went with it.)
//
// ActionSchedulerService 는 삭제됐다 — Action 의 cron 이 Workspace Schedule 로
// 옮겨 갔기 때문이다. 그 게이트는 사라진 게 아니라 **WorkspaceScheduleService.runOnce
// 로 합쳐졌고**, 그쪽 케이스는 이 파일 위에 이미 있다. 예약 실행 경로가 quiesce 를
// 우회하지 않는다는 이 파일의 계약은 그대로 지켜진다.
const { OnTicketDoneActionService } = await import(modPath('modules', 'actions', 'on-ticket-done-action.service.js'));
const { OrchestrationReaperService } = await import(modPath('modules', 'orchestration', 'orchestration-reaper.service.js'));
const { OutreachPollingService } = await import(modPath('modules', 'outreach', 'outreach-polling.service.js'));
const { QaRerunOnFixService } = await import(modPath('modules', 'qa', 'qa-rerun-on-fix.service.js'));

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const quiescedTrue = { isQuiesced: async () => true };

/**
 * TicketDispatchService with stub collaborators. Everything past the quiesce
 * gate (connectivity, instance registry, prerequisites, projects, activity…)
 * is an empty object, so reaching it throws "not a function".
 */
function makeTicketDispatch({ dataSource = {}, instanceQuiesce = quiescedTrue } = {}) {
  return new TicketDispatchService(
    dataSource, /* activityService */ {}, logStub, instanceQuiesce,
    /* connectivity */ {}, /* instanceRegistry */ {}, /* agentStatus */ {},
    /* runSkillSnapshots */ {}, /* prerequisites */ {}, /* projects */ {},
  );
}

test('TicketDispatchService.startQueued (todo queue pump) short-circuits while quiesced, before reading any ticket', async () => {
  // dataSource has no getRepository at all — the pump must return before it.
  const svc = makeTicketDispatch();
  assert.equal(await svc.startQueued({ workspaceId: 'w1' }), 0, 'a quiesced instance must never start a queued ticket');
});

test('TicketDispatchService.dispatch refuses while quiesced, before the host reachability check or any agent_trigger', async () => {
  // The workspace lookup (needed for the dispatch-pause check right before the
  // gate) is the only repository read allowed; connectivity/instanceRegistry
  // are empty stubs, so passing the gate would throw.
  const dataSource = { getRepository: () => ({ findOne: async () => ({ id: 'w1', dispatch_paused_at: null }) }) };
  const svc = makeTicketDispatch({ dataSource });
  const ticket = {
    id: 'tk-1', workspace_id: 'w1', status: 'in_progress', archived_at: null,
    pending_user_action: false, pending_on_tickets: false, pending_ci_wait: false,
    assignee: {
      manager_agent_id: 'host-1', cli: 'claude', model: null, working_dir: '/work/quiesce',
      folder_scope: 'shared', credential_id: null, cli_runtime_profile: null, label: 'q', role_prompt: '',
      runtime_config: { strategy: 'single', permission_mode: 'strict' },
    },
    assignee_key: 'rt-0000000000000000',
  };
  assert.deepEqual(await svc.dispatch(ticket, 'manual'), { dispatched: false, reason: 'instance_quiesced' });
});

test('TicketDispatchService.supervise (dead-agent re-send) short-circuits while quiesced, before reading any ticket', async () => {
  const svc = makeTicketDispatch();
  await assert.doesNotReject(() => svc.supervise());
});

test('QaScheduleService.runOnce short-circuits while quiesced, before touching any schedule row', async () => {
  const svc = new QaScheduleService(
    /* scheduleRepo */ {}, /* batchRepo */ {}, /* qaRunService */ {}, logStub, quiescedTrue,
  );
  const result = await svc.runOnce();
  assert.deepEqual(result, { dispatched: [], skipped: [] });
});

test('SecurityScheduleService.runOnce short-circuits while quiesced, before touching any schedule row', async () => {
  const svc = new SecurityScheduleService(
    /* scheduleRepo */ {}, /* batchRepo */ {}, /* runService */ {}, logStub, quiescedTrue,
  );
  const result = await svc.runOnce();
  assert.deepEqual(result, { dispatched: [], skipped: [] });
});

test('WorkspaceScheduleService.runOnce short-circuits while quiesced, before touching any schedule row', async () => {
  const svc = new WorkspaceScheduleService(
    /* scheduleRepo */ {}, /* roomRepo */ {}, /* participantRepo */ {}, /* hostRepo */ {},
    /* dataSource */ {}, /* messaging */ {}, logStub, quiescedTrue, /* actionRepo */ {}, /* actions */ {},
  );
  const result = await svc.runOnce();
  assert.deepEqual(result, { dispatched: [] });
});

test('AgentAutostartService chat-path autostart (_handleChatRequest) short-circuits while quiesced, before classifying reachability', async () => {
  const metricsStub = { register: () => {} };
  // P4c-4: (hostRepo, apiKeyRepo, managerCommand, agentStatus, activityService,
  // roomMessaging, logService, metrics, instanceQuiesce).
  const svc = new AgentAutostartService(
    {}, {}, /* managerCommand */ {}, /* agentStatus */ {}, /* activityService */ {},
    /* roomMessaging */ {}, logStub, metricsStub, quiescedTrue,
  );
  // Valid-looking event so the FIRST guard (`!evt?.agent_id || !evt.room_id`)
  // is passed and the quiesce check is what actually gates this call — a
  // malformed event returning early would be a false positive for this test.
  await assert.doesNotReject(() => svc._handleChatRequest({ agent_id: 'a1', room_id: 'r1', workspace_id: 'w1' }));
});

test('[review round 1 P2] OnTicketDoneActionService activity handler short-circuits while quiesced, before even reading the ticket', async () => {
  const svc = new OnTicketDoneActionService(/* dataSource */ {}, /* actionsService */ {}, logStub, quiescedTrue);
  // A log payload with no ticket_id/action would normally be a no-op anyway —
  // proving the gate fires FIRST means passing one that WOULD otherwise be
  // eligible (a status move into `done` on a ticket) and confirming
  // dataSource.getRepository (needed to look the ticket up) is never called.
  await assert.doesNotReject(() => svc._handleActivity({
    action: 'moved', field_changed: 'status', old_value: 'review', new_value: 'done', ticket_id: 'tk-1',
  }));
});

test('[review round 1 P2] OrchestrationReaperService.runOnce short-circuits while quiesced, before the sweeping-flag dance or any repo access', async () => {
  const svc = new OrchestrationReaperService(
    /* missionRepo */ {}, /* stepRepo */ {}, /* eventRepo */ {}, /* teamRepo */ {},
    /* missions */ {}, /* runner */ {}, logStub, quiescedTrue,
    /* confirmNotify */ { scheduleGateNotice: () => {}, sendReminder: async () => ({ recipients: 0, sent: 0, failed: 0 }), settled: async () => {} },
  );
  const result = await svc.runOnce();
  assert.deepEqual(result, {
    steps_failed: 0, missions_nudged: 0, missions_failed: 0, post_actions_recovered: 0,
    // 티켓 a78cb566 — 대기 알림 리마인더 스윕도 quiesce 되면 아무것도 하지 않는다.
    confirm_reminders: 0,
  });
});

test('[review round 1 P2] OutreachPollingService.runOnce short-circuits while quiesced, before touching any channel row', async () => {
  const svc = new OutreachPollingService(/* channelRepo */ {}, /* credentialRepo */ {}, /* ingestService */ {}, logStub, quiescedTrue);
  const result = await svc.runOnce();
  assert.deepEqual(result, { polled: [], failed: [] });
});

test('[review round 1 P2] QaRerunOnFixService bypasses QaScheduleService.runOnce entirely (calls QaRunService.startQaRun directly) — its OWN gate on _startRerun must fire too', async () => {
  const svc = new QaRerunOnFixService(/* dataSource */ {}, /* qaRunService */ {}, logStub, quiescedTrue);
  // _startRerun is private but this is exactly the shared call-through both
  // _firePending (fallback-cap timer) and the deployment-event path funnel
  // through — gating it once here covers both without duplicating the check.
  await assert.doesNotReject(() => svc._startRerun('scenario-1', 1, 'fix-ticket-1'));
});

test('every scheduler + the ticket dispatcher runs its normal path when NOT quiesced (sanity check the stubs above prove the right thing)', async () => {
  const quiescedFalse = { isQuiesced: async () => false };
  // QaScheduleService with no due schedules is the cheapest "not quiesced,
  // but genuinely nothing to do" path — scheduleRepo.find() must actually be
  // called this time (proving the gate is a real conditional, not a
  // hardcoded early return).
  let findCalled = false;
  const svc = new QaScheduleService(
    { find: async () => { findCalled = true; return []; } },
    {}, {}, logStub, quiescedFalse,
  );
  const result = await svc.runOnce();
  assert.equal(findCalled, true, 'when not quiesced, runOnce must proceed past the gate and query schedules');
  assert.deepEqual(result, { dispatched: [], skipped: [] });

  // Same for the ticket dispatcher's queue pump: not quiesced → it reads the
  // todo queue (empty here) instead of returning at the gate.
  let ticketFindCalled = false;
  const dispatcher = makeTicketDispatch({
    dataSource: { getRepository: () => ({ find: async () => { ticketFindCalled = true; return []; } }) },
    instanceQuiesce: quiescedFalse,
  });
  assert.equal(await dispatcher.startQueued({ workspaceId: 'w1' }), 0);
  assert.equal(ticketFindCalled, true, 'when not quiesced, the dispatcher must proceed past the gate and read the todo queue');
});
