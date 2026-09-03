// QA flow: 사람이 orchestration mission 방에서 실제로 대화할 수 있는가 (티켓 f6a0de0e).
//
// 고치기 전의 증상: mission room 의 참여자가 orchestrator agent 와 의사 user `system`
// 둘뿐이라, 사람이 글을 쓰면 `requireActiveParticipant` 가 403 을 냈다. 앞 티켓
// (4d065f82)이 붙인 대화 UI 는 그래서 항상 관전 모드로 떨어졌다.
//
// 이 파일이 검증하는 것은 "코드에 그런 줄이 있다"가 아니라 **사용자가 실제로 보내지는가**
// 이므로, 메시지 전송과 참여는 전부 진짜 REST 엔드포인트를 세션 토큰으로 때린다 —
// 인증 · 권한 가드 · 워크스페이스 헤더 · 컨트롤러 배선이 전부 경로에 포함된다.
//
// 완료 기준 대응:
//   1. 생성자가 mission 시작 직후 바로 메시지를 보낼 수 있다(403 없음).
//   2. 그 전송이 orchestrator 를 깨우는 계약을 실제로 만족한다 — 디스패치 팬아웃에
//      orchestrator 가 들어가고, 엔진 자신의 wake 와 **같은 모양**의 이벤트가 나간다.
//   3. 참여자가 없는 과거/에이전트 생성 미션도 join 백필 뒤 대화가 된다.
//   4. 권한 없는 사용자는 여전히 막힌다(join 은 권한 가드, 발화는 참여자 게이트).
//   5. mission room 은 일반 채팅 목록에 나타나지 않는다.
//   6. step room 에는 사람이 참여자로 들어가지 않는다(설계 결정).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createUser, createWorkspace } from '../helpers/fixtures.mjs';

process.env.PORT = process.env.ORCHESTRATION_CONVERSATION_PORT || '7893';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

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
  const crud = await import(
    pathToFileURL(path.join(DIST, 'modules', 'chat-rooms', 'room-crud.service.js')).href
  );
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
    RoomCrudService: crud.RoomCrudService,
  };
}

/** 이 방의 active 참여자 (participant_type, participant_id) 쌍. */
async function activeParticipants(ds, roomId) {
  const rows = await ds
    .getRepository('ChatRoomParticipant')
    .find({ where: { room_id: roomId, left_at: null } });
  return rows.map((r) => `${r.participant_type}:${r.participant_id}`).sort();
}

test('사람이 mission 방에서 orchestrator 와 대화할 수 있다', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const services = await loadServices();
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);
  const rooms = app.get(services.RoomCrudService);
  const base = `http://127.0.0.1:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'mission-conversation');
  const lead = await createAgent(app, getDataSourceToken, ws.id, { name: 'lead' });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });

  // owner  = 미션을 만든 사람.        admin 이므로 MANAGE_ACTIONS 를 갖는다.
  // peer   = 미션을 만들지 않은 운영자. 역시 admin — join 으로 들어와야 한다.
  // outsider = role 'user'.           MANAGE_ACTIONS 가 없다(ROLE_PERMISSIONS 참고).
  const owner = await createUser(app, getDataSourceToken, { name: 'mission-owner' });
  const peer = await createUser(app, getDataSourceToken, { name: 'mission-peer' });
  const outsider = await createUser(app, getDataSourceToken, { name: 'outsider', role: 'user' });
  const auth = app.get(AuthService);
  const ownerToken = auth.createSession(owner.id);
  const peerToken = auth.createSession(peer.id);
  const outsiderToken = auth.createSession(outsider.id);

  const post = (url, token, body) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Workspace-Id': ws.id,
      },
      body: JSON.stringify(body ?? {}),
    });
  const say = (roomId, token, content) => post(`/api/chat-rooms/${roomId}/messages`, token, { content });
  const join = (missionId, token) =>
    post(`/api/orchestration/missions/${missionId}/join-conversation`, token, { workspace_id: ws.id });

  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Conversation squad',
    orchestrator_agent_id: lead.id,
    max_parallel_steps: 2,
    created_by: owner.id,
  });
  await teams.addMember(team.id, ws.id, { agent_id: worker.id, role_label: 'worker' });

  // ── 1. 생성자는 시작 직후 바로 말할 수 있다 ────────────────────────────────
  step('미션 생성자가 시작 직후 mission 방에 메시지를 보낸다');
  const created = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Ship the export',
    objective: 'Add a CSV export.',
    created_by_type: 'user',
    created_by: owner.id,
  });
  const started = await runner.startMission(created.id, ws.id, {
    type: 'user',
    id: owner.id,
    name: owner.name,
  });
  assert.ok(started.room_id, 'mission 방이 만들어졌다');

  assert.deepEqual(
    await activeParticipants(ds, started.room_id),
    [`agent:${lead.id}`, `user:${owner.id}`, 'user:system'].sort(),
    '생성자가 orchestrator · 의사 user system 과 함께 참여자로 등록된다',
  );

  // 사용자의 발화가 orchestrator 를 깨우는 것은 `chat_room_message` 이벤트로 일어난다 —
  // agent-manager 가 그 이벤트의 agent_member_ids 를 보고 subagent 를 띄운다. 그래서
  // "orchestrator 가 메시지를 받았다"의 검증 지점은 이 이벤트다.
  const frames = [];
  const onMessage = (payload) => frames.push(payload);
  activityEvents.on('chat_room_message', onMessage);
  t.after(() => activityEvents.off('chat_room_message', onMessage));

  const sent = await say(started.room_id, ownerToken, '수출 형식을 CSV 말고 XLSX 로 바꿔줘');
  assert.equal(sent.status, 201, `생성자의 전송이 403 없이 성공해야 한다 (${await sent.text()})`);

  const mine = frames.filter((f) => f.room_id === started.room_id && f.sender_id === owner.id);
  assert.equal(mine.length, 1, '전송 한 번에 이벤트 한 번');
  const frame = mine[0];
  assert.equal(frame.sender_type, 'user', 'agent-manager 는 user 발화에만 작업을 실행한다');
  assert.ok(
    frame.agent_member_ids.has(lead.id),
    'orchestrator 가 디스패치 후보에 들어가야 사용자의 지시가 실제로 깨운다',
  );
  assert.equal(
    frame.is_action_room,
    true,
    'mission 방 마커가 유지돼야 응답 subagent 가 "티켓을 만들라"가 아니라 "일하라"는 지시를 받는다',
  );
  assert.ok(
    !frame.dispatch_agent_ids,
    '@멘션 없는 발화는 방 전체 브로드캐스트 경로로 가야 한다 — 명시 대상이 박히면 orchestrator 가 빠질 수 있다',
  );

  step('엔진 자신의 wake 와 사용자 발화가 같은 모양의 이벤트를 낸다');
  frames.length = 0;
  await runner.nudgeOrchestrator(created.id, ws.id, { type: 'user', id: owner.id, name: owner.name }, '확인해줘');
  const nudgeFrame = frames.find((f) => f.room_id === started.room_id && f.sender_id === 'system');
  assert.ok(nudgeFrame, '기존 nudge 경로가 그대로 살아 있다');
  assert.equal(nudgeFrame.sender_type, frame.sender_type, 'sender_type 계약이 같다');
  assert.equal(nudgeFrame.is_action_room, frame.is_action_room, 'room 마커가 같다');
  assert.deepEqual(
    [...nudgeFrame.agent_member_ids].sort(),
    [...frame.agent_member_ids].sort(),
    '사람의 발화와 시스템 wake 가 같은 agent 집합에 도달한다 — 디스패치 계약이 갈리지 않는다',
  );

  // ── 2. 참여자 없는 미션 백필 ──────────────────────────────────────────────
  step('에이전트가 만든 미션(사람 참여자 없음)은 join 전에는 막히고 join 뒤에는 된다');
  const agentOwned = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Agent-authored mission',
    objective: 'Something an agent planned.',
    created_by_type: 'agent',
    created_by: lead.id,
  });
  const agentStarted = await runner.startMission(agentOwned.id, ws.id, {
    type: 'agent',
    id: lead.id,
    name: lead.name,
  });
  assert.deepEqual(
    await activeParticipants(ds, agentStarted.room_id),
    [`agent:${lead.id}`, 'user:system'].sort(),
    '사람 소유자가 없으면 아무 사람도 자동 등록되지 않는다',
  );

  const beforeJoin = await say(agentStarted.room_id, ownerToken, '들어가도 될까');
  assert.equal(beforeJoin.status, 403, '참여자가 아니면 여전히 403 이다');

  const joined = await join(agentOwned.id, ownerToken);
  // NestJS 의 @Post() 기본 상태 코드 — start/pause/nudge 등 이 컨트롤러의 다른 POST 와 같다.
  assert.equal(joined.status, 201, `join 이 성공해야 한다 (${await joined.clone().text()})`);
  assert.deepEqual(await joined.json(), { room_id: agentStarted.room_id, joined: true });

  const afterJoin = await say(agentStarted.room_id, ownerToken, '진행 상황 알려줘');
  assert.equal(afterJoin.status, 201, 'join 뒤에는 403 없이 보낼 수 있다');

  step('join 은 멱등하고 타임라인을 반복해서 더럽히지 않는다');
  const again = await join(agentOwned.id, ownerToken);
  assert.equal(again.status, 201);
  assert.deepEqual(await again.json(), { room_id: agentStarted.room_id, joined: false });
  const joinEvents = (await missions.getMissionDetail(agentOwned.id, ws.id)).events.filter(
    (e) => e.data?.reason === 'conversation_join',
  );
  assert.equal(joinEvents.length, 1, '두 번 눌러도 감사 기록은 한 줄이다');

  step('참여는 서버 재시작을 넘어 유지된다 — 메모리가 아니라 participant 행이다');
  const persisted = await ds.getRepository('ChatRoomParticipant').find({
    where: { room_id: agentStarted.room_id, participant_id: owner.id, left_at: null },
  });
  assert.equal(persisted.length, 1, 'DB 에 active 참여자 행으로 남는다');

  // ── 3. 생성자가 아닌 운영자 ───────────────────────────────────────────────
  step('생성자가 아닌 운영자도 같은 경로로 들어온다');
  const peerBefore = await say(started.room_id, peerToken, '나도 한마디');
  assert.equal(peerBefore.status, 403, '자동 등록 대상은 생성자뿐이다');
  assert.equal((await join(created.id, peerToken)).status, 201);
  assert.equal((await say(started.room_id, peerToken, '나도 한마디')).status, 201);

  // ── 4. 권한 없는 사용자는 여전히 차단 ─────────────────────────────────────
  step('MANAGE_ACTIONS 가 없는 사용자는 join 도 발화도 못 한다');
  const denied = await join(created.id, outsiderToken);
  assert.equal(denied.status, 403, 'join 은 nudge/cancel 과 같은 권한 관객으로 막힌다');
  assert.deepEqual(
    await activeParticipants(ds, started.room_id),
    [`agent:${lead.id}`, `user:${owner.id}`, `user:${peer.id}`, 'user:system'].sort(),
    '거부된 join 은 참여자를 남기지 않는다',
  );
  // 이 사용자는 CHAT_SEND 를 갖고 있다 — 그래도 막히는 이유가 참여자 게이트임을 못박는다.
  const deniedSay = await say(started.room_id, outsiderToken, '몰래 지시');
  assert.equal(deniedSay.status, 403, '참여자 게이트가 두 번째 방어선으로 남는다');

  // ── 5. 일반 채팅 목록 오염 없음 ───────────────────────────────────────────
  step('mission 방은 참여자가 생겨도 일반 채팅 목록에 나타나지 않는다');
  const listed = await rooms.listRooms(ws.id, owner.id);
  assert.equal(
    listed.some((r) => r.id === started.room_id || r.id === agentStarted.room_id),
    false,
    '참여자가 된 사용자의 방 목록에도 mission 방은 없다 — 사이드바가 미션으로 뒤덮이지 않는다',
  );
  const observed = await rooms.listAllWorkspaceRooms(ws.id);
  assert.equal(
    observed.some((r) => r.id === started.room_id),
    false,
    '워크스페이스 관전 목록에서도 제외된다',
  );

  // ── 6. step room 은 사람 참여 대상이 아니다 ───────────────────────────────
  step('step 방에는 사람이 참여자로 들어가지 않는다');
  await runner.submitPlan(created.id, lead.id, {
    summary: 'one step',
    steps: [
      {
        step_key: 'build',
        title: 'Build the export',
        instructions: 'Do it.',
        assignee_agent_id: worker.id,
      },
    ],
  });
  const stepRow = (await missions.listSteps(created.id)).find((s) => s.step_key === 'build');
  assert.ok(stepRow?.room_id, 'step 이 디스패치되어 자기 방을 가졌다');
  assert.deepEqual(
    await activeParticipants(ds, stepRow.room_id),
    [`agent:${worker.id}`, 'user:system'].sort(),
    'step 방은 assignee 와 의사 user system 뿐이다 — attempt 마다 방이 새로 열리므로 사람을 넣지 않는다',
  );
});

exitAfterTests();
