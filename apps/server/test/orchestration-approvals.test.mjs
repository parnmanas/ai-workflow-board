// 미션 실행 승인(docs/orchestration.md "실행 승인").
//
// 멤버의 CLI 가 `approve` 등급에서 도구 사용을 묻는다 → 매니저가 이 서비스에 올리고 long-poll 한다 →
// 신뢰된(trusted) 오케스트레이터가, 아니면 사용자가 답한다. 실패 형태는 둘이다:
//   - 답할 수 없는 쪽에게 묻는다(신뢰되지 않은 오케스트레이터가 승인한다, 자기 요청을 스스로 승인한다).
//   - 아무도 답하지 않는다(사용자에게 알리지 않는다, 오케스트레이터가 답하지 않으면 영원히 멈춘다,
//     멈춘 멤버를 리퍼가 타임아웃으로 죽인다).
// 그래서 진짜 sql.js DataSource 위에서 서비스를 그대로 돌리고, 방 메시지 · 알림 발송만 스텁으로 받는다.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { ChatRoom } from '../dist/entities/ChatRoom.js';
import { ChatRoomParticipant } from '../dist/entities/ChatRoomParticipant.js';
import { ChatRoomMessage } from '../dist/entities/ChatRoomMessage.js';
import { User } from '../dist/entities/User.js';
import { RuntimeHost } from '../dist/entities/RuntimeHost.js';
import { ApiKey } from '../dist/entities/ApiKey.js';
import { Account } from '../dist/entities/Account.js';
import { OrchestrationMission } from '../dist/entities/OrchestrationMission.js';
import { OrchestrationStep } from '../dist/entities/OrchestrationStep.js';
import { OrchestrationEvent } from '../dist/entities/OrchestrationEvent.js';
import { OrchestrationTeam } from '../dist/entities/OrchestrationTeam.js';
import { OrchestrationTeamMember } from '../dist/entities/OrchestrationTeamMember.js';
import { OrchestrationApproval } from '../dist/entities/OrchestrationApproval.js';
import { OrchestrationMissionService, countSteps } from '../dist/modules/orchestration/orchestration-mission.service.js';
import { OrchestrationApprovalService } from '../dist/modules/orchestration/orchestration-approval.service.js';
import {
  approvalHostProblem,
  approvalRouteFor,
  approvalWireView,
  MANAGER_CAPABILITY_MISSION_APPROVALS,
  orchestratorTrust,
  renderApprovalWakePrompt,
  summarizeApprovalInput,
  APPROVAL_INPUT_MAX_CHARS,
} from '../dist/modules/orchestration/orchestration-approval.js';
import { renderMissionPrompt } from '../dist/modules/orchestration/orchestration-prompt.js';
import { EVENT_TYPES } from '../dist/modules/events/event-registry.js';
import { activityEvents } from '../dist/services/activity.service.js';

const WS = '11111111-1111-4111-8111-111111111111';
const OWNER = '33333333-3333-4333-8333-333333333333';
const HOST = '55555555-5555-4555-8555-555555555555';
const OTHER_HOST = '66666666-6666-4666-8666-666666666666';
const ORCH = 'rt-0000000000000001';
const MEMBER = 'rt-0000000000000002';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

function spec(permission_mode) {
  return {
    manager_agent_id: HOST,
    cli: 'claude',
    model: null,
    credential_id: null,
    cli_runtime_profile: null,
    runtime_config: { strategy: 'single', permission_mode },
    working_dir: '/srv/repo',
    folder_scope: 'shared',
  };
}

let dataSource;
let missions;
let approvals;
let posted;
let notices;

const memberCaller = { accountId: WS, runtimeKey: MEMBER, hostId: HOST };
const orchCaller = { accountId: WS, runtimeKey: ORCH, hostId: HOST };

/** 실행 중 미션 + 미션 방 + 돌고 있는 step 하나와 그 attempt 방. */
async function seed({ orchestratorMode = 'trusted', stepStatus = 'running' } = {}) {
  const missionRepo = dataSource.getRepository(OrchestrationMission);
  const roomRepo = dataSource.getRepository(ChatRoom);
  const stepRepo = dataSource.getRepository(OrchestrationStep);
  const mission = await missionRepo.save(missionRepo.create({
    account_id: WS,
    team_id: 'team-1',
    title: 'Ship the export',
    objective: 'Add a CSV export.',
    status: 'running',
    created_by_type: 'user',
    created_by: OWNER,
    orchestrator_agent_id: ORCH,
    orchestrator_spec: spec(orchestratorMode),
  }));
  const missionRoom = await roomRepo.save(roomRepo.create({
    account_id: WS, type: 'group', name: 'Mission', orchestration_mission_id: mission.id, orchestration_step_id: null,
  }));
  mission.room_id = missionRoom.id;
  await missionRepo.save(mission);
  const step = await stepRepo.save(stepRepo.create({
    mission_id: mission.id,
    account_id: WS,
    team_id: 'team-1',
    step_key: 'build',
    title: 'Build the exporter',
    status: stepStatus,
    assignee_agent_id: MEMBER,
    assignee_spec: spec('approve'),
    attempt: 1,
  }));
  const stepRoom = await roomRepo.save(roomRepo.create({
    account_id: WS, type: 'group', name: 'Step', orchestration_mission_id: mission.id, orchestration_step_id: step.id,
  }));
  step.room_id = stepRoom.id;
  await stepRepo.save(step);
  return { mission, missionRoom, step, stepRoom };
}

function ask(stepRoom, key = 'req-1', extra = {}) {
  return approvals.request({
    room_id: stepRoom.id,
    agent_id: MEMBER,
    request_key: key,
    tool_name: 'Bash',
    title: 'Run the test suite',
    description: 'npm test',
    input: { command: 'npm test' },
    can_allow_session: true,
    ...extra,
  }, memberCaller);
}

async function eventTypes(missionId) {
  const rows = await dataSource.getRepository(OrchestrationEvent).find({ where: { mission_id: missionId } });
  return rows.map((r) => r.type);
}

before(async () => {
  dataSource = new DataSource({
    type: 'sqljs',
    entities: [
      ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, RuntimeHost, ApiKey, Account,
      OrchestrationMission, OrchestrationStep, OrchestrationEvent, OrchestrationTeam, OrchestrationTeamMember,
      OrchestrationApproval,
    ],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  missions = new OrchestrationMissionService(
    dataSource.getRepository(OrchestrationMission),
    dataSource.getRepository(OrchestrationStep),
    dataSource.getRepository(OrchestrationEvent),
    dataSource.getRepository(OrchestrationTeam),
    dataSource.getRepository(OrchestrationTeamMember),
    dataSource,
    noopLog,
  );
  const messaging = { async sendMessage(...args) { posted.push(args); return { id: `m${posted.length}` }; } };
  const dispatcher = { async dispatchForUser(uid, key, payload) { notices.push({ uid, key, payload }); return { sent: 1, failed: 0 }; } };
  approvals = new OrchestrationApprovalService(
    dataSource.getRepository(OrchestrationApproval),
    dataSource.getRepository(OrchestrationMission),
    dataSource.getRepository(OrchestrationStep),
    dataSource.getRepository(ChatRoom),
    dataSource,
    missions,
    messaging,
    dispatcher,
    noopLog,
  );
});

after(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  posted = [];
  notices = [];
  for (const entity of [OrchestrationApproval, OrchestrationEvent, OrchestrationStep, ChatRoom, OrchestrationMission]) {
    await dataSource.getRepository(entity).clear();
  }
});

describe('routing rules (pure)', () => {
  it('a member asks the trusted orchestrator, everyone else asks the user', () => {
    assert.deepEqual(approvalRouteFor({ requesterRole: 'member', orchestratorTrusted: true }), { route: 'orchestrator', reason: 'orchestrator_trusted' });
    assert.deepEqual(approvalRouteFor({ requesterRole: 'member', orchestratorTrusted: false }), { route: 'user', reason: 'orchestrator_not_trusted' });
    // 자기 요청을 스스로 승인하는 길은 없다 — 신뢰돼 있어도 사용자에게 간다.
    assert.deepEqual(approvalRouteFor({ requesterRole: 'orchestrator', orchestratorTrusted: true }), { route: 'user', reason: 'orchestrator_request' });
  });

  it('reads the orchestrator tier from the frozen spec, falling back to the roster', () => {
    assert.equal(orchestratorTrust({ orchestrator_spec: spec('trusted') }), 'trusted');
    assert.equal(orchestratorTrust({ orchestrator_spec: spec('approve') }), 'approve');
    assert.equal(
      orchestratorTrust({
        orchestrator_spec: null,
        runtime_roster: {
          version: 1, folder_scope: 'shared', members: [], runtimes: [],
          orchestrator: { slot_id: 'orchestrator', kind: 'orchestrator', name: 'host/claude', spec: spec('trusted') },
        },
      }),
      'trusted',
    );
    assert.equal(orchestratorTrust({ orchestrator_spec: null, runtime_roster: null }), null);
  });

  it('bounds the copied tool input and tells a denied agent why', () => {
    const long = summarizeApprovalInput({ blob: 'x'.repeat(APPROVAL_INPUT_MAX_CHARS * 2) });
    assert.ok(long.length < APPROVAL_INPUT_MAX_CHARS + 100);
    assert.match(long, /more characters/);
    const view = approvalWireView({ id: 'a', status: 'denied', route: 'user', decision: 'deny', decided_by_type: 'user', decided_by_name: 'Kim', decision_note: 'not in scope' });
    assert.equal(view.decision, 'deny');
    assert.match(view.message, /not in scope/);
    assert.match(view.message, /Do not retry/);
  });

  it('the wake prompt names the approval id and every answer the orchestrator can give', () => {
    const text = renderApprovalWakePrompt({
      approvalId: 'appr-1', memberName: 'host/claude', stepKey: 'build', stepTitle: 'Build', toolName: 'Bash',
      title: 'Run tests', description: 'npm test', inputText: '{"command":"npm test"}', canAllowSession: true, answerWindowMs: 600_000,
    });
    for (const needle of ['appr-1', 'decide_orchestration_approval', '`allow`', '`allow_session`', '`deny`', '`escalate`', 'npm test']) {
      assert.ok(text.includes(needle), `wake prompt is missing ${needle}`);
    }
  });

  it('an approve slot needs a host whose running manager relays approvals', () => {
    const approve = { runtime_config: { permission_mode: 'approve' } };
    const old = [{ plugin_version: '1.6.329', manager_capabilities: ['context_window_clamp', 'cli_memory'] }];
    const fresh = [{ plugin_version: '1.6.333', manager_capabilities: ['cli_memory', MANAGER_CAPABILITY_MISSION_APPROVALS] }];
    // 옛 매니저는 approve 실행을 거부하고 작업 지시를 버린다 — 보내기 전에 사유와 함께 막는다.
    const problem = approvalHostProblem(approve, 'ralf', old);
    assert.match(problem ?? '', /ralf runs agent-manager 1\.6\.329/);
    assert.match(problem ?? '', /update the agent-manager/);
    assert.equal(approvalHostProblem(approve, 'ralf', fresh), null);
    // 두 프로세스 중 하나라도 옛 빌드면 어느 쪽이 받을지 모른다.
    assert.ok(approvalHostProblem(approve, 'ralf', [...fresh, ...old]));
    // 연결된 매니저가 없으면 근거가 없다 — 막지 않는다(디스패치는 매니저가 붙을 때 다시 돈다).
    assert.equal(approvalHostProblem(approve, 'ralf', []), null);
    assert.equal(approvalHostProblem({ runtime_config: { permission_mode: 'trusted' } }, 'ralf', old), null);
    assert.equal(MANAGER_CAPABILITY_MISSION_APPROVALS, 'mission_approvals', 'must match the agent-manager flag');
  });

  it('only a trusted orchestrator is briefed that members will ask it', () => {
    const base = {
      teamName: 'T', teamPrompt: '', roster: [], projects: [], ownFolder: null, folderScope: 'shared',
    };
    const mission = { id: 'm1', title: 'M', objective: 'o', max_parallel_steps: 2, max_steps: 5, max_plan_versions: 3, graph_enabled: false };
    assert.match(renderMissionPrompt({ ...base, mission: { ...mission, orchestrator_spec: spec('trusted') } }), /Tool approvals from members/);
    assert.doesNotMatch(renderMissionPrompt({ ...base, mission: { ...mission, orchestrator_spec: spec('approve') } }), /Tool approvals from members/);
  });
});

describe('trusted orchestrator decides for its members', () => {
  it('wakes the orchestrator in the mission room, not the user', async () => {
    const { mission, missionRoom, stepRoom } = await seed();
    const view = await ask(stepRoom);
    assert.equal(view.status, 'pending');
    assert.equal(view.route, 'orchestrator');
    assert.equal(posted.length, 1, 'the request must reach the orchestrator as a room message');
    assert.equal(posted[0][0], missionRoom.id);
    assert.equal(posted[0][2], 'user', 'wakes go out as the system user — the manager only dispatches user-authored room messages');
    assert.ok(posted[0][5].includes(view.id), 'the wake message carries the approval id the orchestrator answers with');
    await approvals.settled();
    assert.equal(notices.length, 0, 'the user is not paged while the orchestrator decides');
    assert.ok((await eventTypes(mission.id)).includes('approval_requested'));
    // 사용자 수에는 들어가지 않는다 — 사이드바 점은 사람이 할 일이 있을 때만 켜진다.
    assert.equal((await missions.pendingUserApprovalCounts([mission.id])).get(mission.id) ?? 0, 0);
  });

  it('a re-sent request lands on the same row', async () => {
    const { stepRoom } = await seed();
    const first = await ask(stepRoom, 'same-key');
    const second = await ask(stepRoom, 'same-key');
    assert.equal(second.id, first.id);
    assert.equal(posted.length, 1);
  });

  it('the orchestrator answer reaches the waiting member', async () => {
    const { stepRoom } = await seed();
    const view = await ask(stepRoom);
    const waiting = approvals.wait(view.id, MEMBER, memberCaller, 5_000);
    const started = Date.now();
    const result = await approvals.decideAsOrchestrator(view.id, { agentId: ORCH, runtimeKey: ORCH }, 'allow_session', 'tests are in scope');
    assert.equal(result.approval.status, 'approved');
    const answered = await waiting;
    assert.ok(Date.now() - started < 2_000, 'the long-poll must wake on the decision, not on its timeout');
    assert.equal(answered.status, 'approved');
    assert.equal(answered.decision, 'allow_session');
  });

  it('nobody but the orchestrator may decide over MCP', async () => {
    const { stepRoom } = await seed();
    const view = await ask(stepRoom);
    await assert.rejects(
      () => approvals.decideAsOrchestrator(view.id, { agentId: MEMBER, runtimeKey: MEMBER }, 'allow', ''),
      (e) => e.status === 403,
    );
  });

  it('escalate hands it to the user and notifies them', async () => {
    const { mission, stepRoom } = await seed();
    const view = await ask(stepRoom);
    const result = await approvals.decideAsOrchestrator(view.id, { agentId: ORCH, runtimeKey: ORCH }, 'escalate', 'drops a table');
    assert.equal(result.approval.route, 'user');
    assert.equal(result.approval.route_reason, 'orchestrator_escalated');
    await approvals.settled();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].uid, OWNER);
    assert.equal(notices[0].key, 'notify_mention');
    assert.equal((await missions.pendingUserApprovalCounts([mission.id])).get(mission.id), 1);
    assert.ok((await eventTypes(mission.id)).includes('approval_notified'), 'the voice cue rides this timeline row');
    await assert.rejects(
      () => approvals.decideAsOrchestrator(view.id, { agentId: ORCH, runtimeKey: ORCH }, 'allow', ''),
      (e) => e.status === 409,
      'once escalated, the orchestrator can no longer answer',
    );
  });

  it('a user may answer first, and the orchestrator is then refused', async () => {
    const { stepRoom } = await seed();
    const view = await ask(stepRoom);
    await approvals.decideAsUser(view.id, WS, { id: OWNER, name: 'Owner' }, 'deny', 'not now');
    await assert.rejects(
      () => approvals.decideAsOrchestrator(view.id, { agentId: ORCH, runtimeKey: ORCH }, 'allow', ''),
      (e) => e.status === 409,
    );
    const again = await approvals.decideAsUser(view.id, WS, { id: OWNER, name: 'Owner' }, 'deny', '');
    assert.equal(again.already_decided, true);
  });

  it('an unanswered request moves to the user after the answer window', async () => {
    const { stepRoom } = await seed();
    const view = await ask(stepRoom);
    await dataSource.getRepository(OrchestrationApproval).update({ id: view.id }, { routed_at: new Date(Date.now() - 60 * 60_000) });
    const swept = await approvals.sweep(new Date());
    assert.equal(swept.escalated, 1);
    const row = await dataSource.getRepository(OrchestrationApproval).findOneBy({ id: view.id });
    assert.equal(row.route, 'user');
    assert.equal(row.route_reason, 'orchestrator_timeout');
  });
});

describe('untrusted orchestrator — the user decides', () => {
  it('goes straight to the user, who is notified, and the orchestrator cannot approve', async () => {
    const { mission, stepRoom } = await seed({ orchestratorMode: 'approve' });
    const view = await ask(stepRoom);
    assert.equal(view.route, 'user');
    assert.equal(posted.length, 0, 'the orchestrator is not woken for a request it may not answer');
    await approvals.settled();
    assert.equal(notices.length, 1);
    assert.equal((await missions.pendingUserApprovalCounts([mission.id])).get(mission.id), 1);
    assert.equal(countSteps([{ status: 'running' }], 1).awaitingApproval, 1);
    await assert.rejects(
      () => approvals.decideAsOrchestrator(view.id, { agentId: ORCH, runtimeKey: ORCH }, 'allow', ''),
      (e) => e.status === 403 && /not trusted/.test(e.message),
    );
    await approvals.decideAsUser(view.id, WS, { id: OWNER, name: 'Owner' }, 'deny', 'use the staging db');
    const answered = await approvals.wait(view.id, MEMBER, memberCaller, 0);
    assert.equal(answered.status, 'denied');
    assert.match(answered.message, /use the staging db/);
  });

  it("the orchestrator's own request goes to the user even when it is trusted", async () => {
    const { missionRoom } = await seed();
    const view = await approvals.request({
      room_id: missionRoom.id, agent_id: ORCH, request_key: 'o-1', tool_name: 'Bash',
    }, orchCaller);
    assert.equal(view.route, 'user');
    const row = await dataSource.getRepository(OrchestrationApproval).findOneBy({ id: view.id });
    assert.equal(row.requester_role, 'orchestrator');
    assert.equal(row.route_reason, 'orchestrator_request');
  });
});

describe('the sidebar dot is fed by the live frame', () => {
  it('orchestration_update carries the approval count all the way to the wire', async () => {
    const { mission, stepRoom } = await seed({ orchestratorMode: 'approve' });
    const frames = [];
    const listener = (e) => frames.push(e);
    activityEvents.on('orchestration_update', listener);
    try {
      await ask(stepRoom);
      await approvals.settled();
      for (let i = 0; i < 20 && !frames.some((f) => f.counts?.awaitingApproval === 1); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      activityEvents.off('orchestration_update', listener);
    }
    const frame = frames.find((f) => f.counts?.awaitingApproval === 1);
    assert.ok(frame, 'the mission frame must count the request waiting on the user');
    // event-registry 의 map() 은 counts 를 필드별로 다시 만든다 — 거기서 빠지면 사이드바는 영영 모른다.
    const def = EVENT_TYPES.find((d) => d.eventType === 'orchestration_update');
    const mapped = await def.map(frame, {});
    const wire = JSON.parse(JSON.stringify(def.flatten({ event_type: def.eventType, scope: mapped.scope, payload: mapped.payload, timestamp: 't' })));
    assert.equal(wire.mission_id, mission.id);
    assert.equal(wire.counts.awaitingApproval, 1);
    assert.equal(wire.counts.awaitingUser, 0);
  });
});

describe('the requester and its liveness', () => {
  it('a runtime key speaks only for itself; a host key only for its own host', async () => {
    const { stepRoom } = await seed();
    await assert.rejects(() => approvals.request({
      room_id: stepRoom.id, agent_id: MEMBER, request_key: 'x', tool_name: 'Bash',
    }, { accountId: WS, runtimeKey: ORCH, hostId: HOST }), (e) => e.status === 403);
    await assert.rejects(() => approvals.request({
      room_id: stepRoom.id, agent_id: MEMBER, request_key: 'y', tool_name: 'Bash',
    }, { accountId: WS, runtimeKey: null, hostId: OTHER_HOST }), (e) => e.status === 403);
    await assert.rejects(() => approvals.request({
      room_id: stepRoom.id, agent_id: MEMBER, request_key: 'z', tool_name: 'Bash',
    }, { accountId: '99999999-9999-4999-8999-999999999999', runtimeKey: MEMBER, hostId: HOST }), (e) => e.status === 403);
    const view = await approvals.request({
      room_id: stepRoom.id, agent_id: MEMBER, request_key: 'ok', tool_name: 'Bash',
    }, { accountId: WS, runtimeKey: null, hostId: HOST });
    assert.equal(view.status, 'pending');
  });

  it('polling keeps the waiting member step alive for the step reaper', async () => {
    const { step, stepRoom } = await seed();
    const stale = new Date(Date.now() - 2 * 60 * 60_000);
    await dataSource.getRepository(OrchestrationStep).update({ id: step.id }, { last_heartbeat_at: stale, lease_stale_since: stale });
    const view = await ask(stepRoom);
    await approvals.wait(view.id, MEMBER, memberCaller, 0);
    const fresh = await dataSource.getRepository(OrchestrationStep).findOneBy({ id: step.id });
    assert.ok(new Date(fresh.last_heartbeat_at).getTime() > stale.getTime() + 60 * 60_000);
    assert.equal(fresh.lease_stale_since, null);
  });

  it('a request is withdrawn when its step attempt ends or its requester stops polling', async () => {
    const { step, stepRoom } = await seed();
    const view = await ask(stepRoom);
    await dataSource.getRepository(OrchestrationStep).update({ id: step.id }, { status: 'done' });
    const settled = await approvals.wait(view.id, MEMBER, memberCaller, 0);
    assert.equal(settled.status, 'cancelled');

    await dataSource.getRepository(OrchestrationStep).update({ id: step.id }, { status: 'running' });
    const second = await ask(stepRoom, 'req-2');
    await dataSource.getRepository(OrchestrationApproval).update({ id: second.id }, { last_polled_at: new Date(Date.now() - 60 * 60_000) });
    const swept = await approvals.sweep(new Date());
    assert.equal(swept.cancelled, 1);
    assert.equal((await dataSource.getRepository(OrchestrationApproval).findOneBy({ id: second.id })).status, 'cancelled');
  });

  it('a finished mission refuses new requests outright', async () => {
    const { mission, stepRoom } = await seed();
    await dataSource.getRepository(OrchestrationMission).update({ id: mission.id }, { status: 'completed' });
    const view = await ask(stepRoom);
    assert.equal(view.id, null);
    assert.equal(view.status, 'cancelled');
  });

  it('the stall reaper can see which missions are waiting on an answer', async () => {
    const { mission, stepRoom } = await seed();
    await ask(stepRoom);
    const waiting = await approvals.missionsWithPendingRequests([mission.id, 'other']);
    assert.deepEqual([...waiting], [mission.id]);
  });
});
