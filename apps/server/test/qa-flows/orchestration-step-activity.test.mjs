// QA flow: 미션 화면이 step 카드마다 "지금 실제로 무슨 작업을 하고 있는지" 읽을 수 있는
// 데이터를 받는가 (운영 요청 2026-09-25, EmberDelve 후속).
//
// 왜 필요한가: step 의 `status` 만으로는 **일하고 있는 것**과 **떠서 즉시 죽은 것**이
// 구분되지 않는다. 2026-09-25 EmberDelve 에서 Windows 의 opencode 멤버는 디스패치마다
// 0초 만에 죽었는데도 화면은 100분 동안 `dispatched` 였고, 그 차이를 말해 주는 값이
// 페이로드에 아예 없었다.
//
// 이 파일이 고정하는 계약:
//   1. 진행 중 step 의 `activity` 는 그 step 방의 최신 CLI 하트비트를 **평문으로** 싣는다
//      (매니저가 씌운 이탤릭 wrapper + 마크다운 이스케이프를 벗긴다).
//   2. 에이전트 자신의 진행 보고가 더 새로우면 그것이 이긴다(`source: 'agent'`).
//   3. 종료된 step 은 `activity: null` — 결과가 이미 답이고, 카드 목록이 모든 step 의
//      방을 훑는 비용을 지지 않는다.
//   4. 신호가 하나도 없으면 `null` 이다 — UI 의 "디스패치 후 무신호" 경고가 실제 값에
//      근거한다.
//   5. 목록 페이로드(`live_steps`)는 무엇이 돌고 있고 마지막 신호가 언제인지 싣는다.
//   6. REST `steps/:id/activity` 는 최신순 기록을 돌려주고 워크스페이스 경계를 지킨다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step as logStep } from '../helpers/boot.mjs';
import { createUser, createWorkspace, createApiKey } from '../helpers/fixtures.mjs';
import { buildTeam } from '../helpers/orchestration-team.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_STEP_ACTIVITY_PORT || '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

const HUMAN = { type: 'user', id: 'human-activity', name: 'Operator' };

async function loadServices() {
  const team = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-team.service.js')).href
  );
  const mission = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')).href
  );
  const runner = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-runner.service.js')).href
  );
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
    plainProgressText: mission.plainProgressText,
  };
}

/**
 * 매니저가 만드는 하트비트와 **같은 모양**의 행을 step 방에 넣는다.
 *
 * 형식 계약의 출처는 `SubagentManager#formatChatProgressLine` 이다: 줄 전체를 `_..._` 로
 * 감싸고 안쪽의 `` ` `` · `_` · `*` 를 백슬래시로 이스케이프한다. 여기서 그 모양을 그대로
 * 재현하지 않으면 서버의 평문 변환이 실제 입력과 다른 것을 검증하게 된다.
 *
 * `created_at` 은 @CreateDateColumn 이라 insert 시점 값이 들어가므로, 순서를 확정하려면
 * 저장 후 명시적으로 덮어쓴다(@UpdateDateColumn 과 달리 update 가 이 값을 건드리지 않는다).
 */
async function putHeartbeat(ds, { roomId, workspaceId, senderId, content, at }) {
  const repo = ds.getRepository('ChatRoomMessage');
  const row = await repo.save(
    repo.create({
      room_id: roomId,
      workspace_id: workspaceId,
      sender_type: 'agent',
      sender_id: senderId,
      content,
      type: 'progress',
    }),
  );
  await repo.update(row.id, { created_at: at });
  return row.id;
}

async function roomOf(ds, stepId) {
  const rooms = await ds.getRepository('ChatRoom').find({ where: { orchestration_step_id: stepId } });
  rooms.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return rooms[0] ?? null;
}

const byKey = (detail) => Object.fromEntries(detail.steps.map((s) => [s.step_key, s]));

test('진행 중 step 의 활동 신호가 미션 페이로드와 REST 기록에 실린다', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => {
    void app.close().catch(() => {});
  });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const services = await loadServices();
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);
  const base = `http://127.0.0.1:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'step-activity');
  const other = await createWorkspace(app, getDataSourceToken, 'step-activity-other');
  const operator = await createUser(app, getDataSourceToken, { name: 'activity-operator' });
  const token = app.get(AuthService).createSession(operator.id);

  const squad = await buildTeam(app, getDataSourceToken, teams, {
    workspaceId: ws.id,
    name: 'Activity squad',
    team: { max_parallel_steps: 3, created_by: HUMAN.id },
    members: [{ role_label: 'builder' }],
  });
  const lead = squad.orchestrator;
  const worker = squad.member('builder');

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: squad.team.id,
    title: 'Activity mission',
    objective: 'ship it',
    created_by: HUMAN.id,
    step_timeout_minutes: 45,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);

  const leadKey = await createApiKey(app, getDataSourceToken, lead.id, { workspaceId: ws.id, label: 'lead' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, { workspaceId: ws.id, label: 'worker' });
  const leadMcp = new McpClient({ baseUrl: base, apiKey: leadKey.raw_key });
  const workerMcp = new McpClient({ baseUrl: base, apiKey: workerKey.raw_key });
  t.after(() => {
    void leadMcp.close().catch(() => {});
    void workerMcp.close().catch(() => {});
  });

  logStep('계획을 제출해 두 step 을 띄운다 (하나는 곧 끝낼 것)');
  await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [
      { step_key: 'build', title: 'Build it', instructions: 'build', assignee_agent_id: worker.id },
      { step_key: 'ship', title: 'Ship it', instructions: 'ship', assignee_agent_id: worker.id },
    ],
  });

  let detail = await missions.getMissionDetail(mission.id, ws.id);
  let steps = byKey(detail);
  assert.equal(steps.build.status, 'dispatched');
  assert.equal(
    steps.build.activity,
    null,
    '아직 하트비트가 없으면 null — UI 의 "디스패치 후 무신호" 경고가 이 값에 근거한다',
  );
  // 멤버 슬롯의 기본 동시 실행 수가 1 이라 두 step 중 하나만 뜬다 — 그래서 여기서
  // "진행 중인 것만" 과 "아직 안 뜬 것" 의 대조가 공짜로 생긴다.
  assert.deepEqual(
    detail.live_steps.map((s) => s.step_key),
    ['build'],
    '진행 중 step 만 목록 계약(live_steps)에 실린다',
  );
  assert.ok(detail.live_steps[0].last_signal_at, '마지막 신호 기준선(없으면 디스패치 시각)이 실린다');
  assert.equal(steps.ship.activity, null, '아직 뜨지 않은 step 은 활동 신호를 갖지 않는다');

  logStep('매니저 하트비트 두 줄을 step 방에 넣는다 — 최신 줄이 카드에 올라야 한다');
  const buildRoom = await roomOf(ds, steps.build.id);
  assert.ok(buildRoom, 'step 디스패치는 전용 방을 만든다');
  const now = Date.now();
  await putHeartbeat(ds, {
    roomId: buildRoom.id,
    workspaceId: ws.id,
    senderId: worker.id,
    content: '_💻 명령 · 첫 번째 명령_',
    at: new Date(now - 120_000),
  });
  await putHeartbeat(ds, {
    roomId: buildRoom.id,
    workspaceId: ws.id,
    senderId: worker.id,
    // 매니저가 실제로 쓰는 이스케이프를 포함한다: `\_` 두 개와 백틱.
    content: '_✅ 명령 완료 · $env:GIT\\_TERMINAL\\_PROMPT=0; git status \\`short\\`_',
    at: new Date(now - 5_000),
  });
  // 같은 방의 일반 메시지(work order)는 활동 신호가 아니다 — 섞이면 카드가 지시문을 읽는다.
  assert.ok(
    (await ds.getRepository('ChatRoomMessage').count({ where: { room_id: buildRoom.id, type: 'message' } })) > 0,
    'work order 가 message 타입으로 이미 방에 있다(대조군)',
  );

  detail = await missions.getMissionDetail(mission.id, ws.id);
  steps = byKey(detail);
  const activity = steps.build.activity;
  assert.ok(activity, '진행 중 step 에 활동 신호가 실린다');
  assert.equal(activity.source, 'cli');
  assert.match(activity.text, /명령 완료/, '최신 줄이 이긴다');
  assert.doesNotMatch(activity.text, /^_/, '이탤릭 wrapper 는 벗겨진다');
  assert.match(
    activity.text,
    /\$env:GIT_TERMINAL_PROMPT=0/,
    '마크다운 이스케이프도 벗겨진다 — 운영자가 백슬래시를 읽으면 안 된다',
  );
  assert.doesNotMatch(activity.text, /Build it|build$/, 'work order(message 타입)는 활동으로 새어 들어오지 않는다');

  logStep('에이전트 자신의 진행 보고가 더 새로우면 그것이 이긴다');
  const order = (await ds.getRepository('ChatRoomMessage').find({ where: { room_id: buildRoom.id } }))
    .map((r) => r.content || '')
    .join('\n');
  const lease = /lease_token`?:?\s*`?([0-9a-f-]{36})`?/i.exec(order)?.[1];
  assert.ok(lease, 'work order 에 lease token 이 실려 있다');
  await workerMcp.callTool('report_orchestration_progress', {
    step_id: steps.build.id,
    message: '빌드 40% — 셰이더 컴파일 중',
    lease_token: lease,
  });

  detail = await missions.getMissionDetail(mission.id, ws.id);
  steps = byKey(detail);
  assert.equal(steps.build.activity.source, 'agent', '더 새로운 쪽이 이긴다');
  assert.match(steps.build.activity.text, /셰이더 컴파일 중/);
  assert.ok(steps.build.last_heartbeat_at, '보고는 리퍼 기준선도 갱신한다');

  logStep('종료된 step 은 활동 신호를 싣지 않는다 (결과가 이미 답이다)');
  await workerMcp.callTool('report_orchestration_step', {
    step_id: steps.build.id,
    status: 'done',
    summary: '빌드 완료',
    lease_token: lease,
  });
  detail = await missions.getMissionDetail(mission.id, ws.id);
  steps = byKey(detail);
  assert.equal(steps.build.status, 'done');
  assert.equal(steps.build.activity, null, '끝난 step 은 null — 방을 다시 훑지 않는다');
  assert.ok(
    !detail.live_steps.some((s) => s.step_key === 'build'),
    '끝난 step 은 live_steps 에서도 빠진다',
  );

  logStep('REST 기록은 끝난 step 에 대해서도 최신순으로 읽힌다 (무엇을 하다 멈췄나)');
  const res = await fetch(
    `${base}/api/orchestration/steps/${steps.build.id}/activity?workspace_id=${ws.id}&limit=10`,
    { headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws.id } },
  );
  assert.equal(res.status, 200);
  const log = await res.json();
  assert.equal(log.step_key, 'build');
  assert.equal(log.items.length, 2, 'progress 행만 센다 — work order 는 제외');
  assert.match(log.items[0].text, /명령 완료/, '최신순');
  assert.match(log.items[1].text, /첫 번째 명령/);
  assert.ok(
    log.items.every((i) => i.source === 'cli' && !i.text.startsWith('_')),
    '전부 평문 CLI 신호다',
  );

  logStep('워크스페이스 경계를 지킨다');
  const wrong = await fetch(
    `${base}/api/orchestration/steps/${steps.build.id}/activity?workspace_id=${other.id}`,
    { headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': other.id } },
  );
  assert.equal(wrong.status, 404, '다른 워크스페이스에서는 step 자체가 보이지 않는다');

  const anon = await fetch(`${base}/api/orchestration/steps/${steps.build.id}/activity?workspace_id=${ws.id}`);
  assert.ok(anon.status === 401 || anon.status === 403, `인증 없이는 읽을 수 없다 (got ${anon.status})`);
});

test('plainProgressText — 매니저 포맷의 두 겹(이탤릭 wrapper + 이스케이프)을 벗긴다', async () => {
  const { plainProgressText } = await loadServices();
  assert.equal(plainProgressText('_🔧 작업_'), '🔧 작업');
  assert.equal(plainProgressText('_✅ 완료 · a\\_b \\`c\\` \\*d\\*_'), '✅ 완료 · a_b `c` *d*');
  assert.equal(plainProgressText('  _여러   공백   접기_  '), '여러 공백 접기');
  assert.equal(plainProgressText(''), '');
  assert.equal(plainProgressText(null), '');
  assert.equal(plainProgressText('_'), '_', '한 글자 밑줄은 wrapper 가 아니다');
  const long = `_${'x'.repeat(500)}_`;
  const clipped = plainProgressText(long);
  assert.ok(clipped.length <= 240, `카드 한 줄 상한을 넘지 않는다 (${clipped.length})`);
  assert.ok(clipped.endsWith('…'), '잘렸음을 표시한다');
});

exitAfterTests();
