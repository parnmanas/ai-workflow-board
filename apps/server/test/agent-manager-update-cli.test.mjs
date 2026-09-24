// 서버측 `update_cli` 경로 — 호스트에 설치된 CLI 자체를 올리는 verb.
//
// 매니저가 실제 `claude update` 를 돌리는 부분은 agent-manager 쪽 테스트가 덮는다.
// 여기서 보는 것은 서버가 책임지는 두 가지다:
//
//   1) 관리자용 command 엔드포인트가 새 verb 를 받아들인다(ALLOWED_COMMANDS 회귀
//      가드). 허용목록에 빠지면 UI 버튼은 400 "unknown command" 로 죽고, 그 실패는
//      매니저 쪽 로그에 흔적조차 남지 않는다.
//   2) 하트비트의 `cli_versions` / `cli_latest_versions` 가 인스턴스 레지스트리에
//      실린다 — UI 가 "현재 버전" 과 "최신 버전" 을 읽는 유일한 경로. 뒤엣것이
//      없으면 Update 버튼은 최신 여부를 몰라 영원히 활성으로 남는다.

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

function heartbeatBody(managerId, cliVersions, cliLatestVersions, cliInstalls) {
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
    ...(cliLatestVersions ? { cli_latest_versions: cliLatestVersions } : {}),
    ...(cliInstalls ? { cli_installs: cliInstalls } : {}),
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

  const postHeartbeat = (cliVersions, cliLatestVersions, cliInstalls) =>
    fetch(`http://127.0.0.1:${port}/api/agent/instance-heartbeat`, {
      method: 'POST',
      headers: { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(heartbeatBody(manager.id, cliVersions, cliLatestVersions, cliInstalls)),
    });

  const instanceRow = async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/instances`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rows = await readJson(resp, 200);
    return rows.find((row) => row.instance_id === INSTANCE_ID);
  };
  const versionsInRegistry = async () => (await instanceRow())?.cli_versions;
  const latestInRegistry = async () => (await instanceRow())?.cli_latest_versions;
  const installsInRegistry = async () => (await instanceRow())?.cli_installs;

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
  await readJson(
    await postHeartbeat(
      { claude: '2.0.0', codex: '0.9.0', git: '2.43.0' },
      { claude: '2.1.0', codex: '0.9.0' },
    ),
    201,
  );
  assert.deepEqual(await versionsInRegistry(), {
    claude: '2.0.0',
    codex: '0.9.0',
    git: '2.43.0',
  });
  // 최신 버전은 npm 레지스트리에서 온다. git 처럼 물어볼 패키지가 없는 도구는
  // 키가 없고, UI 는 그것을 "최신" 이 아니라 "모름" 으로 읽는다.
  assert.deepEqual(await latestInRegistry(), { claude: '2.1.0', codex: '0.9.0' });

  // 운영자가 Update 를 누른 상황 — 허용목록을 통과해 command_id 가 발급된다.
  const dispatched = await readJson(await sendCommand('update_cli', { cli: 'claude' }), 202);
  assert.equal(dispatched.ok, true);
  assert.ok(dispatched.command_id);
  const pending = await readOutcome(dispatched.command_id);
  assert.equal(pending.state, 'pending', '디스패치만으로는 완료가 아니다');
  assert.equal(pending.command, 'update_cli');

  // 매니저가 업데이트를 마치고 새 버전을 실은 하트비트 + 같은 command_id 로 ack.
  await readJson(
    await postHeartbeat(
      { claude: '2.1.0', codex: '0.9.0', git: '2.43.0' },
      { claude: '2.1.0', codex: '0.9.0' },
    ),
    201,
  );
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
  await readJson(
    await postHeartbeat({ claude: '2.1.0', codex: 42, gemini: '' }, { claude: '2.1.0', codex: null }),
    201,
  );
  assert.deepEqual(await versionsInRegistry(), { claude: '2.1.0' });
  assert.deepEqual(await latestInRegistry(), { claude: '2.1.0' });

  // 구버전 매니저(필드 자체가 없음)는 "버전 텔레메트리 없음" 으로 남는다. 최신
  // 조회가 통째로 실패한 회차도 같은 모양으로 온다 — 화면은 버튼을 잠그지 않는다.
  await readJson(await postHeartbeat(null), 201);
  assert.equal(await versionsInRegistry(), undefined);
  assert.equal(await latestInRegistry(), undefined);

  // ── cli_installs — 설치본 단위 목록 ───────────────────────────────────────
  // 같은 CLI 가 여러 줄인 것은 정상이다(ragnar 의 vLLM 백엔드용 두 번째 claude).
  // 화면이 "어느 설치본을 올릴지" 를 고르려면 경로가 필요하므로 그대로 실어 나른다.
  const stale = '/home/parn/.local/bin/claude';
  const fresh = '/home/parn/.nvm/versions/node/v22.23.1/bin/claude';
  await readJson(
    await postHeartbeat({ claude: '2.1.273' }, { claude: '2.1.281' }, [
      {
        cli: 'claude',
        path: stale,
        version: '2.1.273 (Claude Code)',
        method: 'npm --prefix /home/parn/.local',
        updatable: true,
        active: true,
      },
      {
        cli: 'claude',
        path: fresh,
        version: '2.1.281 (Claude Code)',
        method: 'npm --prefix /home/parn/.nvm/versions/node/v22.23.1',
        updatable: true,
        active: false,
      },
      // 모양이 어긋난 행(path 없음)만 조용히 버리고 나머지는 살린다.
      { cli: 'codex', version: '0.156.1' },
    ]),
    201,
  );
  const installs = await installsInRegistry();
  assert.equal(installs.length, 2, 'path 없는 행은 버린다');
  assert.deepEqual(installs.map((row) => [row.path, row.active]), [[stale, true], [fresh, false]]);

  // update_cli 는 설치본 경로(args.bin)를 실은 채로 받아들여진다 — 어느 설치본인지가
  // 커맨드에 박혀야 "눌렀을 때 무엇이 올라갈지" 가 미리 정해진다. 그 경로가 실제로
  // 실행 가능한지는 매니저가 자기 열거 목록과 대조해 판정한다(서버의 몫이 아니다).
  const pinned = await readJson(await sendCommand('update_cli', { cli: 'claude', bin: fresh }), 202);
  assert.equal(pinned.ok, true);
  assert.equal((await readOutcome(pinned.command_id)).command, 'update_cli');

  // 오타 verb 는 기존대로 거부된다.
  await readJson(await sendCommand('update_clis'), 400);
});

exitAfterTests();
