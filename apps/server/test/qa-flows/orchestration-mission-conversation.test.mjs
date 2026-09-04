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
//   4. 권한 없는 사용자는 여전히 막힌다(join 은 권한 가드, 발화는 권한 게이트).
//   5. mission room 은 일반 채팅 목록에 나타나지 않는다.
//   6. step room 에는 사람이 참여자로 들어가지 않는다(설계 결정).
//
// ── 티켓 995a9519 이후의 계약 변화 ──────────────────────────────────────────
//
// mission 방이 이제 `open_join: true` 로 만들어진다. 그래서 **참여자 게이트**는 mission
// 방에서 더 이상 두 번째 방어선이 아니다 — MANAGE_ACTIONS 를 가진 운영자는 join 을 먼저
// 누르지 않아도 바로 말할 수 있고, 그 발화 시점에 참여자로 auto-join 된다. 그것이 이
// 기능의 요청 자체다("mission 화면의 Chat 에 참여자가 아니어도 낄 수 있어야 한다").
//
// f6a0de0e 가 지키려던 불변식은 그대로 살아 있고 이 파일이 계속 단언한다:
//   - 권한 없는 사용자는 join 도 발화도 못 한다 (이제 유일한 방어선은 권한 게이트다).
//   - join 뒤 권한이 회수되면 participant 행이 남아 있어도 발화가 막힌다.
//   - join 은 멱등하고 타임라인을 한 줄만 남긴다.
//   - 종료된 미션에는 새로 참여할 수 없다.
//   - 같은 (room, user) 의 active 행은 최대 하나이고 언제나 떠날 수 있다.
//
// join 경로 자체도 그대로 필요하다: 이 옵션 **이전에** 만들어진 mission 방은
// open_join=false 이므로 여전히 join 으로만 들어간다. 아래 레거시 블록들은 그 상태를
// 방의 open_join 을 직접 꺼서 재현한다 — 그래야 진짜 과거 데이터의 경로를 검증한다.

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
  const membership = await import(
    pathToFileURL(path.join(DIST, 'modules', 'chat-rooms', 'room-membership.service.js')).href
  );
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
    RoomCrudService: crud.RoomCrudService,
    RoomMembershipService: membership.RoomMembershipService,
  };
}

/**
 * 이 방의 active 참여자 (participant_type, participant_id) 쌍.
 *
 * where 조건으로 left_at 을 거르지 않는다 — 이 스택에서 리터럴 null 조건은 IS NULL 로
 * 번역되지 않고 **조용히 빠져서** 이미 나간 참여자까지 세어 버린다(이 티켓에서 실측).
 * 전부 가져와 JS 로 거르면 ORM 동작에 기대지 않는다.
 */
async function activeParticipants(ds, roomId) {
  const rows = await ds.getRepository('ChatRoomParticipant').find({ where: { room_id: roomId } });
  return rows
    .filter((r) => r.left_at === null)
    .map((r) => `${r.participant_type}:${r.participant_id}`)
    .sort();
}

/** 이 방에서 이 사람의 active 참여자 행 (같은 이유로 JS 필터). */
async function activeRowsFor(ds, roomId, participantId) {
  const rows = await ds
    .getRepository('ChatRoomParticipant')
    .find({ where: { room_id: roomId, participant_id: participantId } });
  return rows.filter((r) => r.left_at === null);
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
  const membership = app.get(services.RoomMembershipService);
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

  // 티켓 995a9519 — mission 방은 자유 참여로 열린 채 만들어진다. 아래 3번 블록의
  // "참여자가 아닌 운영자가 바로 말할 수 있다"가 성립하는 근거가 이 값이다.
  assert.equal(
    (await ds.getRepository('ChatRoom').findOne({ where: { id: started.room_id } })).open_join,
    true,
    'mission 방은 open_join 이 켜진 채로 생성된다',
  );

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

  // ── 2a. 진짜 레거시 상태 백필 — 변경 전에 만들어진 user-owned 미션 ────────────
  //
  // 리뷰 라운드1 지적 3: 아래 2b 의 agent-owned 미션은 "사람 소유자가 없는" 새 기능
  // 경로일 뿐, **이 티켓 이전에 생성돼 사람 participant 가 통째로 빠진 데이터**를
  // 재현하지 않는다. 그 상태를 직접 만든다 — user-owned 미션을 시작한 뒤 생성자
  // participant 행을 지우면, 변경 전 코드가 남겨 놓았을 행 구성과 정확히 같아진다.
  step('변경 전에 만들어진 user-owned 미션(사람 participant 없음)도 join 하면 대화가 된다');
  const legacyMission = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Legacy user-owned mission',
    objective: 'Created before human participants existed.',
    created_by_type: 'user',
    created_by: owner.id,
  });
  const legacyStarted = await runner.startMission(legacyMission.id, ws.id, {
    type: 'user',
    id: owner.id,
    name: owner.name,
  });
  await ds.getRepository('ChatRoomParticipant').delete({
    room_id: legacyStarted.room_id,
    participant_id: owner.id,
    participant_type: 'user',
  });
  // 자유 참여(티켓 995a9519)도 함께 끈다. 그 옵션은 **이 티켓 이후에 만들어진** 방에만
  // 켜져 있으므로, 참여자 행만 지우는 것으로는 과거 데이터를 재현하지 못한다 — 옵션이
  // 켜진 채로 두면 참여자 게이트를 아예 통과해 버려서, 이 블록이 검증하려는 join 백필
  // 경로를 지나가지도 않는다.
  await ds.getRepository('ChatRoom').update({ id: legacyStarted.room_id }, { open_join: false });
  assert.deepEqual(
    await activeParticipants(ds, legacyStarted.room_id),
    [`agent:${lead.id}`, 'user:system'].sort(),
    '레거시 상태 재현 — 변경 전 코드가 남겼을 행 구성과 같다',
  );

  assert.equal(
    (await say(legacyStarted.room_id, ownerToken, '이 미션 어떻게 됐어')).status,
    403,
    '백필 전에는 생성자조차 막힌다 — 이것이 사용자가 겪던 증상이다',
  );
  assert.equal((await join(legacyMission.id, ownerToken)).status, 201);
  assert.equal(
    (await say(legacyStarted.room_id, ownerToken, '이 미션 어떻게 됐어')).status,
    201,
    '백필 뒤에는 대화가 된다',
  );

  // ── 2b. 참여자 없는 미션 백필 ──────────────────────────────────────────────
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
  // 위 레거시 블록과 같은 이유로 자유 참여를 끈다 — 이 블록이 고정하는 것은 명시적
  // join 백필 경로이고, 그 경로는 옵션이 꺼진 과거 방에서 여전히 유일한 입구다.
  await ds.getRepository('ChatRoom').update({ id: agentStarted.room_id }, { open_join: false });

  const beforeJoin = await say(agentStarted.room_id, ownerToken, '들어가도 될까');
  assert.equal(beforeJoin.status, 403, '자유 참여가 꺼진 방에서는 참여자가 아니면 여전히 403 이다');

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
  const persisted = await activeRowsFor(ds, agentStarted.room_id, owner.id);
  assert.equal(persisted.length, 1, 'DB 에 active 참여자 행으로 남는다');

  // ── 3. 생성자가 아닌 운영자 ───────────────────────────────────────────────
  //
  // 티켓 995a9519 로 이 블록의 계약이 바뀌었다. 예전에는 join 을 먼저 눌러야 했지만
  // (자동 등록 대상은 생성자뿐이었다), mission 방이 open_join 으로 열리면서 참여자가
  // 아닌 운영자도 **바로** 말할 수 있고 그 발화가 참여자 등록을 겸한다. 사용자의 원래
  // 요청("mission 화면의 Chat 에 참여자가 아니어도 낄 수 있어야 한다")이 정확히 이것이다.
  step('생성자가 아닌 운영자는 join 없이 바로 말할 수 있고, 그 발화로 참여자가 된다');
  assert.deepEqual(
    await activeRowsFor(ds, started.room_id, peer.id),
    [],
    '사전 조건 — peer 는 아직 이 방의 참여자가 아니다',
  );
  const peerFirstSay = await say(started.room_id, peerToken, '나도 한마디');
  assert.equal(
    peerFirstSay.status,
    201,
    `자유 참여 방에서는 참여자가 아니어도 발화가 된다 (${await peerFirstSay.clone().text()})`,
  );
  const peerRows = await activeRowsFor(ds, started.room_id, peer.id);
  assert.equal(peerRows.length, 1, '첫 발화 시점에 참여자 행이 정확히 하나 생긴다 (auto-join)');
  assert.ok(peerRows[0].last_read_at, '재입장 규약과 같이 last_read_at 이 찍힌다');

  // auto-join 은 멱등이다 — 계속 말해도 행이 늘지 않는다.
  assert.equal((await say(started.room_id, peerToken, '한마디 더')).status, 201);
  assert.equal(
    (await activeRowsFor(ds, started.room_id, peer.id)).length,
    1,
    '이어지는 발화가 참여자 행을 중복 생성하지 않는다',
  );

  // 명시적 join 경로도 그대로 살아 있다 — 이미 참여 중이므로 joined:false 로 응답한다.
  const peerJoinAfter = await join(created.id, peerToken);
  assert.equal(peerJoinAfter.status, 201);
  assert.deepEqual(
    await peerJoinAfter.json(),
    { room_id: started.room_id, joined: false },
    'auto-join 뒤의 명시적 join 은 아무것도 바꾸지 않는다',
  );

  // ── 4. 권한 없는 사용자는 여전히 차단 ─────────────────────────────────────
  step('MANAGE_ACTIONS 가 없는 사용자는 join 도 발화도 못 한다');
  const denied = await join(created.id, outsiderToken);
  assert.equal(denied.status, 403, 'join 은 nudge/cancel 과 같은 권한 관객으로 막힌다');
  assert.deepEqual(
    await activeParticipants(ds, started.room_id),
    [`agent:${lead.id}`, `user:${owner.id}`, `user:${peer.id}`, 'user:system'].sort(),
    '거부된 join 은 참여자를 남기지 않는다',
  );
  // 이 사용자는 CHAT_SEND 를 갖고 있다 — 그래도 막힌다. 티켓 995a9519 이후 이 방은
  // 자유 참여로 열려 있으므로 참여자 게이트는 더 이상 막아주지 않는다: 남은 방어선은
  // MANAGE_ACTIONS 를 보는 orchestration 발화 게이트 하나뿐이고, 그것으로 충분해야 한다.
  const deniedSay = await say(started.room_id, outsiderToken, '몰래 지시');
  assert.equal(deniedSay.status, 403, '권한 없는 사용자는 열린 mission 방에서도 발화가 막힌다');
  // 그리고 거부된 발화는 auto-join 도 남기지 않아야 한다 — 권한 게이트가 참여자 등록
  // **앞**에 있다는 뜻이다. 순서가 뒤집히면 403 을 받은 사용자가 참여자 명단에만 남는다.
  assert.deepEqual(
    await activeRowsFor(ds, started.room_id, outsider.id),
    [],
    '거부된 발화는 참여자 행을 만들지 않는다',
  );

  // ── 4a. 권한 경계는 join 순간이 아니라 발화 순간에도 유지된다 ────────────────
  //
  // 리뷰 라운드1 지적 1: participant 행은 한 번 생기면 남으므로, join 시점 검사만으로는
  // 권한 회수가 반영되지 않는다. 강등된 계정이 계속 orchestrator 를 깨울 수 있었다.
  step('join 뒤 권한이 회수되면 그 사용자는 더 이상 발화할 수 없다');
  const demoted = await createUser(app, getDataSourceToken, { name: 'to-be-demoted' });
  const demotedToken = auth.createSession(demoted.id);
  assert.equal((await join(created.id, demotedToken)).status, 201, '강등 전에는 참여할 수 있다');
  assert.equal(
    (await say(started.room_id, demotedToken, '아직 권한이 있을 때')).status,
    201,
    '강등 전에는 발화할 수 있다',
  );

  // 권한만 회수한다 — participant 행은 그대로 둔다. 그게 이 회귀의 핵심이다.
  await ds.getRepository('User').update({ id: demoted.id }, { role: 'user', permissions: '[]' });
  const stillParticipant = await activeRowsFor(ds, started.room_id, demoted.id);
  assert.equal(stillParticipant.length, 1, 'participant 행은 남아 있다 — 게이트가 권한을 본다는 증거');

  assert.equal(
    (await say(started.room_id, demotedToken, '강등된 뒤에도 지시')).status,
    403,
    '권한이 회수되면 participant 행이 남아 있어도 발화가 막혀야 한다',
  );

  step('권한 회수는 엔진 자신의 발화나 일반 채팅방에는 영향을 주지 않는다');
  frames.length = 0;
  await runner.nudgeOrchestrator(created.id, ws.id, { type: 'user', id: owner.id, name: owner.name }, '계속');
  assert.ok(
    frames.some((f) => f.room_id === started.room_id && f.sender_id === 'system'),
    '의사 user system 은 users 행이 없다 — 게이트가 엔진 wake 를 막으면 미션이 통째로 정지한다',
  );

  // ── 4b. 종료된 미션에는 새로 참여할 수 없다 ─────────────────────────────────
  //
  // 리뷰 라운드1 지적 3: 화면은 live=false 면 참여 버튼을 숨기는데 서버가 허용하면
  // REST 를 직접 부르는 경로로 규칙이 샌다. 두 쪽을 같은 규칙으로 맞춘다.
  step('종료된 미션의 join 은 거부된다 — 화면이 버튼을 숨기는 것과 같은 규칙');
  const closed = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Closed mission',
    objective: 'Already over.',
    created_by_type: 'user',
    created_by: owner.id,
  });
  const closedStarted = await runner.startMission(closed.id, ws.id, {
    type: 'user',
    id: owner.id,
    name: owner.name,
  });
  await runner.cancelMission(closed.id, ws.id, { type: 'user', id: owner.id, name: owner.name }, 'no longer needed');
  const closedJoin = await join(closed.id, peerToken);
  assert.equal(closedJoin.status, 409, '종료된 미션에는 참여시키지 않는다');
  assert.match((await closedJoin.json()).error, /cancelled/, '왜 거부됐는지 사유가 전달된다');
  assert.equal(
    (await activeParticipants(ds, closedStarted.room_id)).includes(`user:${peer.id}`),
    false,
    '거부된 join 은 참여자를 남기지 않는다',
  );

  // ── 4c. active membership 의 단일성 ─────────────────────────────────────────
  //
  // 리뷰 라운드1 지적 2. 여기서 고정하는 것은 락의 구현이 아니라 **제품 불변식**이다:
  // 같은 (room, user) 의 active 행은 언제나 최대 하나이고, 사용자는 언제나 방을 떠날 수
  // 있어야 한다. sql.js 는 트랜잭션 직렬화 큐가 있어 진짜 병렬을 재현하지 못하므로
  // (CLAUDE.md), 경합 자체가 아니라 그 경합이 만들 수 있었던 **고장 상태**를 직접 만들어
  // 검증한다 — 그래야 백엔드와 무관하게 유효하다.
  step('같은 사용자가 동시에 두 번 참여해도 active 행은 하나다');
  const racer = await createUser(app, getDataSourceToken, { name: 'racer' });
  const racerToken = auth.createSession(racer.id);
  const bothJoins = await Promise.all([join(created.id, racerToken), join(created.id, racerToken)]);
  const joinedFlags = await Promise.all(bothJoins.map((r) => r.json().then((b) => b.joined)));
  assert.equal(
    joinedFlags.filter(Boolean).length,
    1,
    '두 번 눌러도 실제로 넣은 것은 한 번이어야 한다',
  );
  const racerRows = await activeRowsFor(ds, started.room_id, racer.id);
  assert.equal(racerRows.length, 1, 'active 행이 둘이면 아래 leave 가 통째로 고장난다');

  step('중복 active 행이 이미 있어도 사용자는 방을 떠날 수 있다');
  // 예전 코드가 남겼을 수 있는 중복을 직접 심는다 — leaveRoom 이 findOne 이던 시절에는
  // 한 행만 정리돼 사용자가 영영 참여자로 남았다.
  const partRepo = ds.getRepository('ChatRoomParticipant');
  await partRepo.save(
    partRepo.create({
      room_id: started.room_id,
      participant_type: 'user',
      participant_id: racer.id,
      last_read_at: new Date(),
      left_at: null,
    }),
  );
  assert.equal(
    (await activeRowsFor(ds, started.room_id, racer.id)).length,
    2,
    '고장 상태를 재현했다',
  );
  await membership.leaveRoom(started.room_id, racer.id);
  assert.equal(
    (await activeRowsFor(ds, started.room_id, racer.id)).length,
    0,
    'leave 는 남은 active 행을 하나도 남기지 않아야 한다',
  );
  // 예전에는 이 자리에서 "떠난 뒤에는 발화가 403" 을 확인해 행이 정말 사라졌음을 간접
  // 재확인했다. 티켓 995a9519 이후 mission 방은 자유 참여로 열려 있어 그 간접 신호가
  // 성립하지 않는다 — 나갔던 사람이 다시 말하면 다시 들어오는 것이 이 옵션의 정의다.
  // 바로 위에서 active 행이 0 임을 **직접** 단언했으므로 원래 불변식은 이미 고정돼 있고,
  // 여기서는 그 재진입이 행을 정확히 하나만 만드는지까지 확인해 더 좁게 못박는다.
  assert.equal(
    (await say(started.room_id, racerToken, '떠났다가 다시 한마디')).status,
    201,
    '자유 참여 방은 떠난 사람이 다시 말하면 다시 들어온다',
  );
  assert.equal(
    (await activeRowsFor(ds, started.room_id, racer.id)).length,
    1,
    '재진입은 active 행을 정확히 하나만 만든다 — 옛 left 행이 되살아나지 않는다',
  );
  // 다음 블록이 "join 으로 재입장"을 검증하므로 상태를 다시 비워 둔다.
  await membership.leaveRoom(started.room_id, racer.id);
  assert.equal((await activeRowsFor(ds, started.room_id, racer.id)).length, 0);

  step('재입장한 사용자도 방을 떠날 수 있다 — 옛 left 행이 새 active 행을 가리지 않는다');
  assert.equal((await join(created.id, racerToken)).status, 201, '재입장은 새 행을 만든다');
  await membership.leaveRoom(started.room_id, racer.id);
  assert.equal(
    (await activeRowsFor(ds, started.room_id, racer.id)).length,
    0,
    '옛 left 행을 먼저 골라 400 을 내던 경로가 사라졌다',
  );

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
