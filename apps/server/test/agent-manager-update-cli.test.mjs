// 서버측 `update_cli` 경로 — 호스트에 설치된 CLI 자체를 올리는 verb.
//
// 매니저가 실제 `claude update` 를 돌리는 부분은 agent-manager 쪽 테스트가 덮는다.
// 여기서 보는 것은 서버가 책임지는 두 가지다:
//
//   1) 관리자용 command 엔드포인트가 새 verb 를 받아들인다(ALLOWED_COMMANDS 회귀
//      가드). 허용목록에 빠지면 UI 버튼은 400 "unknown command" 로 죽고, 그 실패는
//      매니저 쪽 로그에 흔적조차 남지 않는다.
//   2) 하트비트의 `cli_versions` 가 인스턴스 레지스트리에 실린다 — UI 가 "현재
//      버전" 과 업데이트 후 바뀐 버전을 읽는 유일한 경로.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  createUser,
  createWorkspace,
} from './helpers/fixtures.mjs';

process.env.PORT = process.env.UPDATE_CLI_PORT || '0';

const INSTANCE_ID = 'update-cli-instance';

function heartbeatBody(managerId, cliVersions) {
  return {
    instance_id: INSTANCE_ID,
    agent_id: managerId,
    mode: 'manager',
    hostname: 'update-cli-host',
    plugin_version: 'test',
    cli: 'mixed',
    cli_adapters: ['claude', 'codex'],
    pid: 7373,
    started_at: new Date().toISOString(),
    ...(cliVersions ? { cli_versions: cliVersions } : {}),
  };
}

test('update_cli 는 허용된 verb 이고, 하트비트의 cli_versions 가 레지스트리에 그대로 실린다', async (t) => {
  const { app, port, modules } = await bootApp({
    port: Number.parseInt(process.env.PORT, 10),
  });
  t.after(async () => {
    await app.close();
  });

  const { AuthService, getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'update-cli');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'update-cli-manager',
    type: 'manager',
  });
  const managerKey = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'update-cli-manager-key',
  });
  const admin = await createUser(app, getDataSourceToken, {
    name: 'update-cli-admin',
    role: 'admin',
  });
  const token = app.get(AuthService).createSession(admin.id);

  const readJson = async (resp, expectedStatus) => {
    const body = await resp.text();
    assert.equal(resp.status, expectedStatus, body);
    return body ? JSON.parse(body) : null;
  };

  const postHeartbeat = (cliVersions) =>
    fetch(`http://127.0.0.1:${port}/api/agent/instance-heartbeat`, {
      method: 'POST',
      headers: { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(heartbeatBody(manager.id, cliVersions)),
    });

  const versionsInRegistry = async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/instances`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rows = await readJson(resp, 200);
    return rows.find((row) => row.instance_id === INSTANCE_ID)?.cli_versions;
  };

  const sendCommand = (command, args) =>
    fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/instances/${INSTANCE_ID}/command`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, ...(args ? { args } : {}) }),
    });

  const readOutcome = (commandId) =>
    fetch(
      `http://127.0.0.1:${port}/api/admin/agent-manager/commands/${encodeURIComponent(commandId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ).then((resp) => readJson(resp, 200));

  // 부팅 시점 버전 — 매니저가 CLI 해석 probe 로 읽어 보고한다. gh/git 처럼 어댑터가
  // 없는 도구도 같은 맵으로 올 수 있고, 서버는 그대로 저장한다(필터는 UI 의 몫).
  await readJson(await postHeartbeat({ claude: '2.0.0', codex: '0.9.0', git: '2.43.0' }), 201);
  assert.deepEqual(await versionsInRegistry(), {
    claude: '2.0.0',
    codex: '0.9.0',
    git: '2.43.0',
  });

  // 운영자가 Update 를 누른 상황 — 허용목록을 통과해 command_id 가 발급된다.
  const dispatched = await readJson(await sendCommand('update_cli', { cli: 'claude' }), 202);
  assert.equal(dispatched.ok, true);
  assert.ok(dispatched.command_id);
  const pending = await readOutcome(dispatched.command_id);
  assert.equal(pending.state, 'pending', '디스패치만으로는 완료가 아니다');
  assert.equal(pending.command, 'update_cli');

  // 매니저가 업데이트를 마치고 새 버전을 실은 하트비트 + 같은 command_id 로 ack.
  await readJson(await postHeartbeat({ claude: '2.1.0', codex: '0.9.0', git: '2.43.0' }), 201);
  await readJson(
    await fetch(`http://127.0.0.1:${port}/api/agent-manager/command/ack`, {
      method: 'POST',
      headers: { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command_id: dispatched.command_id,
        status: 'ok',
        detail: 'update_cli ok: claude 2.0.0 → 2.1.0',
      }),
    }),
    201,
  );

  const acked = await readOutcome(dispatched.command_id);
  assert.equal(acked.state, 'ok');
  assert.match(acked.detail, /2\.0\.0 → 2\.1\.0/, 'UI 는 매니저가 보고한 before → after 를 그대로 보여준다');
  assert.deepEqual(
    await versionsInRegistry(),
    { claude: '2.1.0', codex: '0.9.0', git: '2.43.0' },
    '새 버전이 레지스트리를 교체해야 UI 의 "현재 버전" 이 따라간다',
  );

  // 버전 문자열이 아닌 값은 조용히 버리고 나머지는 살린다 — 하트비트는 best-effort 다.
  await readJson(await postHeartbeat({ claude: '2.1.0', codex: 42, gemini: '' }), 201);
  assert.deepEqual(await versionsInRegistry(), { claude: '2.1.0' });

  // 구버전 매니저(필드 자체가 없음)는 "버전 텔레메트리 없음" 으로 남는다.
  await readJson(await postHeartbeat(null), 201);
  assert.equal(await versionsInRegistry(), undefined);

  // 오타 verb 는 기존대로 거부된다.
  await readJson(await sendCommand('update_clis'), 400);
});

exitAfterTests();
