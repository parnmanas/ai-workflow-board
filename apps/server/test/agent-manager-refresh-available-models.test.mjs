// ticket 40110b64 — 서버측 `refresh_available_models` 경로.
//
// 이 티켓 전까지 `available_models` 를 덮는 서버 테스트가 하나도 없었다. 여기서
// 두 가지를 실제 REST 로 검증한다:
//
//   1) 관리자용 제네릭 command 엔드포인트가 새 verb 를 받아들이고(ALLOWED_COMMANDS
//      허용목록 회귀 가드) 매니저 SSE 로 실어 보낸다. 허용목록에 빠지면 버튼은
//      400 "unknown command" 로 죽고, 그 실패는 매니저 쪽에선 보이지 않는다.
//   2) 갱신된 하트비트가 인스턴스 레지스트리의 available_models 를 실제로
//      교체한다 — Agent 생성/편집 다이얼로그의 모델 드롭다운이 읽는 값이 바로 이것이다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  createUser,
  createWorkspace,
} from './helpers/fixtures.mjs';

process.env.PORT = process.env.REFRESH_AVAILABLE_MODELS_PORT || '7951';

const INSTANCE_ID = 'refresh-models-instance';

function heartbeatBody(managerId, availableModels) {
  return {
    instance_id: INSTANCE_ID,
    agent_id: managerId,
    mode: 'manager',
    hostname: 'refresh-models-host',
    plugin_version: 'test',
    cli: 'mixed',
    cli_adapters: ['claude', 'codex'],
    pid: 4242,
    started_at: new Date().toISOString(),
    ...(availableModels ? { available_models: availableModels } : {}),
  };
}

test('refresh_available_models 는 관리자 command 엔드포인트로 디스패치되고, 뒤이은 하트비트가 모델 목록을 교체한다', async (t) => {
  const { app, port, modules } = await bootApp({
    port: Number.parseInt(process.env.PORT, 10),
  });
  t.after(async () => {
    await app.close();
  });

  const { AuthService, getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'refresh-available-models');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'refresh-models-manager',
    type: 'manager',
  });
  const managerKey = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'refresh-models-manager-key',
  });
  const admin = await createUser(app, getDataSourceToken, {
    name: 'refresh-models-admin',
    role: 'admin',
  });
  const token = app.get(AuthService).createSession(admin.id);

  const postHeartbeat = (availableModels) =>
    fetch(`http://127.0.0.1:${port}/api/agent/instance-heartbeat`, {
      method: 'POST',
      headers: {
        'X-Agent-Key': managerKey.raw_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(heartbeatBody(manager.id, availableModels)),
    });

  // 본문은 한 번만 읽을 수 있으므로 먼저 text 로 받고 나서 단언·파싱한다
  // (assert 의 message 인자로 `await resp.text()` 를 넘기면 통과하는 경우에도
  //  본문이 소비돼 뒤따르는 json() 이 "Body is unusable" 로 죽는다).
  const readJson = async (resp, expectedStatus) => {
    const body = await resp.text();
    assert.equal(resp.status, expectedStatus, body);
    return body ? JSON.parse(body) : null;
  };

  const listInstances = async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/instances`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return readJson(resp, 200);
  };

  const sendCommand = (command) =>
    fetch(
      `http://127.0.0.1:${port}/api/admin/agent-manager/instances/${INSTANCE_ID}/command`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      },
    );

  // 부팅 시점의 모델 목록 — 호스트의 codex 가 아직 구버전이라 모델이 2개다.
  await readJson(await postHeartbeat({ claude: ['opus', 'sonnet'], codex: ['gpt-5'] }), 201);

  const beforeRows = await listInstances();
  const before = beforeRows.find((row) => row.instance_id === INSTANCE_ID);
  assert.ok(before, '하트비트를 보낸 인스턴스가 관리자 목록에 보여야 한다');
  assert.deepEqual(before.available_models, {
    claude: ['opus', 'sonnet'],
    codex: ['gpt-5'],
  });

  // 운영자가 관리 화면에서 "Refresh models" 를 누른 상황.
  const dispatchBody = await readJson(await sendCommand('refresh_available_models'), 202);
  assert.equal(dispatchBody.ok, true);
  assert.ok(dispatchBody.command_id, '허용목록을 통과한 커맨드는 command_id 를 돌려준다');

  // 매니저가 재열거 직후 보내는 즉시 하트비트 — 정기 tick(30초)을 기다리지 않는다.
  await readJson(
    await postHeartbeat({
      claude: ['opus', 'sonnet', 'haiku'],
      codex: ['gpt-5', 'gpt-5-codex'],
    }),
    201,
  );

  const afterRows = await listInstances();
  const after = afterRows.find((row) => row.instance_id === INSTANCE_ID);
  assert.ok(after);
  assert.deepEqual(
    after.available_models,
    { claude: ['opus', 'sonnet', 'haiku'], codex: ['gpt-5', 'gpt-5-codex'] },
    '재열거된 목록이 레지스트리를 통째로 교체해야 한다 — 모델 드롭다운이 읽는 값이다',
  );

  // 매니저가 재열거 결과를 ack 하는 왕복. detail 에 CLI별 갱신 결과가 담긴다.
  const ackOnce = (commandId, detail) =>
    fetch(`http://127.0.0.1:${port}/api/agent-manager/command/ack`, {
      method: 'POST',
      headers: { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_id: commandId, status: 'ok', detail }),
    });

  // 이 컨트롤러의 @Post 핸들러는 명시적 status 를 주지 않으면 201 로 응답한다
  // (instance-heartbeat 도 동일) — 명시적으로 status 를 세팅하는 거부 경로만 4xx 다.
  const acked = await readJson(
    await ackOnce(dispatchBody.command_id, 'refreshed 2 CLI(s): claude=3, codex=2'),
    201,
  );
  assert.equal(acked.ok, true);

  // 같은 command_id 를 두 번째로 ack 하면 원장에서 이미 소비돼 410 이다 —
  // 만료된(혹은 알 수 없는) 커맨드의 기존 거부 경로가 새 verb 에서도 그대로다.
  await readJson(await ackOnce(dispatchBody.command_id, '중복 ack'), 410);

  // 오타/미등록 verb 에 대한 기존 거부 경로는 그대로여야 한다.
  const typo = await readJson(await sendCommand('refresh_avaliable_models'), 400);
  assert.match(typo.error, /unknown command/);

  // 알 수 없는 인스턴스에 대한 기존 404 경로도 그대로다.
  const unknownInstance = await fetch(
    `http://127.0.0.1:${port}/api/admin/agent-manager/instances/no-such-instance/command`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'refresh_available_models' }),
    },
  );
  await readJson(unknownInstance, 404);
});

exitAfterTests();
