// QA flow: 미션의 검증 증거(스크린샷·동영상)가 올라가고 화면이 읽을 수 있는가 (운영 요청
// 2026-09-25: "검증 결과를 스크린샷이나 동영상으로 올리고 이를 보여주는 기능").
//
// 설계는 새 저장소를 만들지 않는다. 담당 agent 가 자기 step 방에 파일을 올리는 경로
// (`add_chat_message_attachment` → `send_chat_room_message(attachment_ids)`)가 이미 있으므로,
// **그 방의 이미지·동영상이 곧 증거**다. 이 파일이 고정하는 계약:
//   1. work order 가 담당자에게 증거 올리는 법과 **이 step 방의 id** 를 알려준다.
//   2. agent 가 진짜 MCP 경로로 PNG 와 WebM 을 올려 메시지에 묶으면, step 세션 항목에
//      첨부 메타가 실린다(바이트는 실리지 않는다 — 전사 한 페이지가 수십 MB 가 되면 안 된다).
//   3. 바이트는 `steps/:id/attachments/:attId` 로 읽는다. 채팅 경로는 참여자 게이트라 step
//      방에서는 사람이 못 읽는다. 다른 step 의 id 로는 404(방 앵커), 다른 워크스페이스도 404.
//   4. 미션 증거 갤러리(`missions/:id/evidence`)는 미디어만, step_key 와 함께, 최신순으로.
//   5. 미션 상세의 step 에 `evidence_count` 가 실린다(레일 배지).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step as logStep } from '../helpers/boot.mjs';
import { createUser, createWorkspace, createApiKey } from '../helpers/fixtures.mjs';
import { buildTeam } from '../helpers/orchestration-team.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_STEP_EVIDENCE_PORT || '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');
const HUMAN = { type: 'user', id: 'human-evidence', name: 'Operator' };

// 1x1 PNG — 매직 바이트가 진짜라야 서버 sniffer 를 통과한다.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// WebM 은 sniffer 가 모르는 형식이라 호출자의 mime 을 믿는다 — 임의 바이트로 충분하다.
const WEBM_STUB = Buffer.from('\x1aE\xdf\xa3webm-stub-bytes-for-test').toString('base64');

async function loadServices() {
  const team = await import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-team.service.js')).href);
  const mission = await import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')).href);
  const runner = await import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-runner.service.js')).href);
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
  };
}

/** McpClient.callTool 은 JSON 텍스트를 이미 객체로 돌려준다; 툴 에러는 `{ error, isError }`. */
function unwrap(result, what) {
  assert.ok(result && !result.isError, `${what} failed: ${JSON.stringify(result)}`);
  return result;
}

const byKey = (detail) => Object.fromEntries(detail.steps.map((s) => [s.step_key, s]));

test('담당 agent 가 올린 스크린샷·녹화가 step 세션과 미션 증거 갤러리에 실린다', async (t) => {
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

  const ws = await createWorkspace(app, getDataSourceToken, 'step-evidence');
  const other = await createWorkspace(app, getDataSourceToken, 'step-evidence-other');
  const operator = await createUser(app, getDataSourceToken, { name: 'evidence-operator' });
  const token = app.get(AuthService).createSession(operator.id);
  const H = { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws.id };

  const squad = await buildTeam(app, getDataSourceToken, teams, {
    workspaceId: ws.id,
    name: 'Evidence squad',
    team: { max_parallel_steps: 3, created_by: HUMAN.id },
    members: [{ role_label: 'builder', max_concurrent: 2 }],
  });
  const lead = squad.orchestrator;
  const worker = squad.member('builder');

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: squad.team.id,
    title: 'Evidence mission',
    objective: 'ship it with proof',
    created_by: HUMAN.id,
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

  await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [
      { step_key: 'build', title: 'Build it', instructions: 'build', assignee_agent_id: worker.id },
      { step_key: 'other', title: 'Other thing', instructions: 'other', assignee_agent_id: worker.id },
    ],
  });
  let detail = await missions.getMissionDetail(mission.id, ws.id);
  let steps = byKey(detail);
  assert.equal(steps.build.status, 'dispatched');
  assert.equal(steps.other.status, 'dispatched', 'max_concurrent 2 라 둘 다 뜬다 — 교차 검증용');
  assert.equal(steps.build.evidence_count, 0, '아직 증거 없음');

  logStep('work order 가 증거 올리는 법과 이 step 방의 id 를 알려준다');
  const rooms = await ds.getRepository('ChatRoom').find({ where: { orchestration_step_id: steps.build.id } });
  const buildRoom = rooms[0];
  assert.ok(buildRoom);
  const order = (await ds.getRepository('ChatRoomMessage').find({ where: { room_id: buildRoom.id } }))
    .map((r) => r.content || '')
    .join('\n');
  assert.match(order, /## Evidence \(screenshots \/ recordings\)/, '증거 섹션이 work order 에 있다');
  assert.ok(order.includes(`room_id: \`${buildRoom.id}\``), 'step 방 id 를 그대로 적어 준다');
  assert.match(order, /add_chat_message_attachment/);
  assert.match(order, /send_chat_room_message/);
  assert.match(order, /10 MB/, '용량 한도를 말해 준다');
  const lease = /lease_token`?:?\s*`?([0-9a-f-]{36})`?/i.exec(order)?.[1];
  assert.ok(lease);

  logStep('agent 가 진짜 MCP 경로로 PNG 와 WebM 을 올리고 한 메시지에 묶는다');
  const png = unwrap(
    await workerMcp.callTool('add_chat_message_attachment', {
      room_id: buildRoom.id,
      file_name: 'result.png',
      file_data: PNG_1PX,
      file_mimetype: 'image/png',
    }),
    'png upload',
  );
  const webm = unwrap(
    await workerMcp.callTool('add_chat_message_attachment', {
      room_id: buildRoom.id,
      file_name: 'playtest.webm',
      file_data: WEBM_STUB,
      file_mimetype: 'video/webm',
    }),
    'webm upload',
  );
  const pngId = png.attachment_id || png.id;
  const webmId = webm.attachment_id || webm.id;
  assert.ok(pngId && webmId, `업로드가 id 를 돌려준다 (${JSON.stringify(png)} / ${JSON.stringify(webm)})`);
  await workerMcp.callTool('send_chat_room_message', {
    room_id: buildRoom.id,
    content: '빌드 결과 화면과 플레이 녹화입니다.',
    attachment_ids: [pngId, webmId],
  });
  // 미디어가 아닌 파일도 하나 — 갤러리에는 안 나오고 세션에는 파일 카드로 나와야 한다.
  const log = unwrap(
    await workerMcp.callTool('add_chat_message_attachment', {
      room_id: buildRoom.id,
      file_name: 'build.log',
      file_data: Buffer.from('ok\n').toString('base64'),
      file_mimetype: 'text/plain',
    }),
    'log upload',
  );
  await workerMcp.callTool('send_chat_room_message', {
    room_id: buildRoom.id,
    content: '빌드 로그',
    attachment_ids: [log.attachment_id || log.id],
  });

  logStep('step 세션 항목에 첨부 메타가 실리고 바이트는 실리지 않는다');
  const session = await fetch(`${base}/api/orchestration/steps/${steps.build.id}/session?workspace_id=${ws.id}`, { headers: H }).then((r) => r.json());
  const withMedia = session.items.find((i) => (i.attachments ?? []).some((a) => a.file_name === 'result.png'));
  assert.ok(withMedia, '스크린샷이 묶인 메시지가 세션에 있다');
  assert.equal(withMedia.kind, 'agent');
  assert.deepEqual(
    withMedia.attachments.map((a) => [a.file_name, a.mime_type, a.is_media]).sort(),
    [['playtest.webm', 'video/webm', true], ['result.png', 'image/png', true]],
  );
  assert.ok(withMedia.attachments.every((a) => !('file_data' in a)), '메타만 — 바이트는 별도 경로');
  const withLog = session.items.find((i) => (i.attachments ?? []).some((a) => a.file_name === 'build.log'));
  assert.equal(withLog.attachments[0].is_media, false, '로그 파일은 미디어가 아니다');

  logStep('바이트는 step 첨부 경로로만 읽히고, 방 앵커와 워크스페이스 경계를 지킨다');
  const bytes = await fetch(`${base}/api/orchestration/steps/${steps.build.id}/attachments/${pngId}?workspace_id=${ws.id}`, { headers: H });
  assert.equal(bytes.status, 200);
  const body = await bytes.json();
  assert.equal(body.file_data, PNG_1PX, '올린 바이트가 그대로 돌아온다');
  assert.equal(body.mime_type, 'image/png');
  assert.equal(body.is_media, true);

  const crossStep = await fetch(`${base}/api/orchestration/steps/${steps.other.id}/attachments/${pngId}?workspace_id=${ws.id}`, { headers: H });
  assert.equal(crossStep.status, 404, '다른 step 의 id 로는 못 읽는다 — 첨부는 자기 방에 앵커된다');
  const crossWs = await fetch(`${base}/api/orchestration/steps/${steps.build.id}/attachments/${pngId}?workspace_id=${other.id}`, {
    headers: { ...H, 'X-Workspace-Id': other.id },
  });
  assert.equal(crossWs.status, 404);
  const anon = await fetch(`${base}/api/orchestration/steps/${steps.build.id}/attachments/${pngId}?workspace_id=${ws.id}`);
  assert.ok(anon.status === 401 || anon.status === 403);
  const viaChat = await fetch(`${base}/api/chat-rooms/${buildRoom.id}/attachments/${pngId}`, { headers: H });
  assert.ok(viaChat.status === 403 || viaChat.status === 404, `채팅 경로는 참여자 게이트라 사람이 못 읽는다 (got ${viaChat.status}) — 그래서 step 경로가 필요하다`);

  logStep('미션 증거 갤러리는 미디어만 step_key 와 함께 최신순으로');
  const gallery = await fetch(`${base}/api/orchestration/missions/${mission.id}/evidence?workspace_id=${ws.id}`, { headers: H }).then((r) => r.json());
  assert.equal(gallery.mission_id, mission.id);
  assert.deepEqual(gallery.items.map((i) => i.file_name).sort(), ['playtest.webm', 'result.png'], '로그 파일은 갤러리에 없다');
  assert.ok(gallery.items.every((i) => i.step_id === steps.build.id && i.step_key === 'build'), '어느 step 의 증거인지 알 수 있다');
  assert.ok(gallery.items.every((i) => i.uploaded_by_type === 'agent' && i.uploaded_by.includes('/')), '올린 agent 는 <Manager>/<Agent> 표시명이다');
  assert.ok(gallery.items.every((i) => !('file_data' in i)), '갤러리 목록도 메타만');

  logStep('미션 상세의 step 에 evidence_count 가 실린다 (레일 배지)');
  detail = await missions.getMissionDetail(mission.id, ws.id);
  steps = byKey(detail);
  assert.equal(steps.build.evidence_count, 2, '이미지 1 + 동영상 1');
  assert.equal(steps.other.evidence_count, 0);
  assert.equal(detail.mission_evidence_count, 0, '미션 방에는 아직 없다');

  logStep('증거를 올린 뒤 정상 보고 — 증거가 보고 경로를 방해하지 않는다');
  await workerMcp.callTool('report_orchestration_step', { step_id: steps.build.id, status: 'done', summary: '완료. result.png / playtest.webm 첨부.', lease_token: lease });
  detail = await missions.getMissionDetail(mission.id, ws.id);
  assert.equal(byKey(detail).build.status, 'done');
  assert.equal(byKey(detail).build.evidence_count, 2, '끝난 step 의 증거도 그대로 센다');
});

exitAfterTests();
