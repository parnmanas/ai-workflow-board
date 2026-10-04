// 모델 목록의 단일 출처 — 같은 host×cli 는 **모든 화면에서 같은 목록**이어야 한다
// (운영 보고 2026-09-26: "모델 리스트가 mission 다르고, session/chat 다르고").
//
// 고치기 전에는 같은 사실을 세 곳이 각자 계산했다:
//   · Agent 다이얼로그 / Runtime Hosts  — HostModelsService (하트비트 그대로)
//   · Agent Session 설정 / 새 세션      — 하트비트를 직접 읽고 + 살아 있는 ACP 세션이
//     보고한 목록을 합침. 그 관측은 세션 화면 밖으로 나가지 않았다.
//   · 오케스트레이션 팀 슬롯(mission)   — 하트비트 + **기존 agent 행에 핀된 모델**을
//     합쳐 알파벳순으로 재정렬. 그래서 내용도 순서도 달랐다.
//
// 지금은 HostModelsService 하나가 답하고, 세션이 ACP 로 알게 된 목록은 그 출처로
// 흘러들어간다(`noteObservedModels`). 이 파일이 고정하는 것:
//   ① ACP 어댑터가 보고한 목록이 있으면 **그것만**, 없을 때만 하트비트 열거. 합치지 않는다
//      (운영 보고 2026-10-02 ragnar: 합집합이라 새 세션·팀 슬롯에는 하트비트 스캔의
//      `claude-sonnet-5-5` 가 있고 세션 안 드롭다운에는 없었다 — 세션 안은 어댑터 목록만 받을 수 있다).
//   ② 오케스트레이션 로스터 = HostModelsService 목록 (agent 행에 핀된 모델을 끼워넣지 않는다).
//   ③ 세션이 관측한 모델은 로스터·스냅샷 **양쪽**에 나타난다.
//   ④ 어느 화면도 자기만의 합집합을 갖지 않는다 — 세 경로의 결과가 글자 그대로 같다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createApiKey, createUser, createWorkspace } from './helpers/fixtures.mjs';

process.env.PORT = process.env.HOST_MODELS_SINGLE_SOURCE_PORT || '0';

const INSTANCE_ID = 'single-source-instance';
// 호스트가 열거한 순서. 알파벳순이 **아니다** — 재정렬을 잡아내기 위한 픽스처다.
const OPENCODE_MODELS = ['opencode/muse-spark-1.3-contributor-free', 'opencode/big-pickle', 'opencode/nemotron-3-ultra-free'];

test('한 호스트의 모델 목록은 mission / session / Agent 다이얼로그에서 동일하다', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => { await app.close(); });
  const base = `http://127.0.0.1:${port}`;
  const { AuthService, getDataSourceToken } = modules;

  const workspace = await createWorkspace(app, getDataSourceToken, 'single-source');
  const manager = await createAgent(app, getDataSourceToken, null, { name: 'rolf', type: 'manager' });
  const managerKey = await createApiKey(app, getDataSourceToken, manager.id, { workspaceId: workspace.id, label: 'rolf-key' });
  const admin = await createUser(app, getDataSourceToken, { name: 'admin', role: 'admin' });
  const token = app.get(AuthService).createSession(admin.id);
  const userHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const managerHeaders = { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' };

  // P4c-4: Agent 행 자체가 없다 — 끼워넣을 agent 행 model 이 존재할 수 없고,
  // 아래 ② 단언(목록에 없음)은 구조적으로 보장된다.

  const heartbeat = async () => {
    const resp = await fetch(`${base}/api/agent/instance-heartbeat`, {
      method: 'POST',
      headers: managerHeaders,
      body: JSON.stringify({
        instance_id: INSTANCE_ID, agent_id: manager.id, host_id: manager.id, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
        cli: 'mixed', cli_adapters: ['opencode'], pid: 1, started_at: new Date().toISOString(),
        available_models: { opencode: OPENCODE_MODELS },
        available_models_at: new Date().toISOString(),
      }),
    });
    assert.equal(resp.status, 201, await resp.text());
  };
  const json = async (url) => {
    const resp = await fetch(url, { headers: userHeaders });
    const text = await resp.text();
    assert.equal(resp.status, 200, text);
    return JSON.parse(text);
  };
  const rosterModels = async () => {
    const hosts = await json(`${base}/api/orchestration/runtime-hosts?workspace_id=${workspace.id}`);
    const row = hosts.find((h) => h.manager_agent_id === manager.id);
    assert.ok(row, '로스터에 이 호스트가 있어야 한다');
    return row.available_models.opencode ?? [];
  };
  const snapshotModels = async () =>
    (await json(`${base}/api/agent-manager/hosts/${manager.id}/models`)).models.opencode ?? [];

  await heartbeat();

  // ① ACP 보고가 없으면 하트비트 순서 그대로.
  assert.deepEqual(await snapshotModels(), OPENCODE_MODELS, '호스트가 준 순서를 바꾸지 않는다');

  // ② 로스터가 같은 목록을 준다 — agent 행에 핀된 모델을 끼워넣지 않는다.
  const roster = await rosterModels();
  assert.deepEqual(roster, OPENCODE_MODELS, 'mission 의 팀 슬롯도 같은 목록·같은 순서를 본다');
  assert.ok(
    !roster.includes('opencode/pinned-by-an-agent-row'),
    '기존 agent 행의 model 을 목록에 끼워넣으면 mission 만 다른 목록이 된다',
  );

  // ③ 살아 있는 세션이 ACP 로 알게 된 모델은 단일 출처로 흘러들어 모든 화면에 보인다.
  const hostModels = app.get((await import('../dist/modules/agent-manager/host-models.service.js')).HostModelsService);
  hostModels.noteObservedModels(manager.id, 'opencode', [
    'opencode/big-pickle',
    'opencode-go/glm-5.3',                 // 세션만 아는 것(provider 를 방금 로그인)
  ]);

  // 규칙: ACP 보고가 있으면 그것만 — 세션 안 드롭다운과 같은 목록. 하트비트에만 있는
  // muse-spark·nemotron 은 세션 안에서 고를 수 없으므로 다른 화면에도 나오지 않는다.
  const expected = ['opencode/big-pickle', 'opencode-go/glm-5.3'];
  assert.deepEqual(await snapshotModels(), expected, 'ACP 보고만 — 하트비트 스캔을 덧붙이지 않는다');
  assert.deepEqual(await rosterModels(), expected, 'mission 도 그 관측을 함께 본다');

  // ④ 세 경로의 결과가 글자 그대로 같다.
  const sessionFallback = hostModels.modelsFor(manager.id, 'opencode');
  assert.deepEqual(sessionFallback, expected, '세션 화면의 fallback 도 같은 함수를 쓴다');
  const distinct = new Set([
    (await snapshotModels()).join(','),
    (await rosterModels()).join(','),
    sessionFallback.join(','),
  ]);
  assert.equal(distinct.size, 1, `세 화면의 목록이 하나로 수렴해야 한다: ${[...distinct].join(' || ')}`);
});

exitAfterTests();

// ── ACP 가 보고한 목록(영속)이 모든 화면에 함께 보인다 ────────────────────────
//
// 실측(2026-09-27, 운영 DB): Ralf 의 opencode 는 ACP 가 108개(`opencode-go/*`)를 보고해
// `agent_session_cli_settings.known_config_options` 에 영속돼 있었고, 세션 화면은 그것을
// 보여줬다. 하트비트 열거(`opencode models`)는 다른(짧은) 목록이라 팀 슬롯(mission)은
// 그 짧은 목록만 봤다 — 앞선 수정이 라이브 세션 관측만 합쳤기 때문에, 세션을 이 프로세스
// 에서 한 번 열지 않으면 여전히 갈렸다. 영속된 보고를 단일 출처가 직접 읽어 해소한다.

test('세션이 예전에 보고해 영속된 ACP 모델 목록도 mission/Agent 다이얼로그에 함께 보인다', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => { await app.close(); });
  const base = `http://127.0.0.1:${port}`;
  const { AuthService, getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const workspace = await createWorkspace(app, getDataSourceToken, 'reported-models');
  const manager = await createAgent(app, getDataSourceToken, null, { name: 'ralf', type: 'manager' });
  const managerKey = await createApiKey(app, getDataSourceToken, manager.id, { workspaceId: workspace.id, label: 'ralf-key' });
  const admin = await createUser(app, getDataSourceToken, { name: 'admin2', role: 'admin' });
  const token = app.get(AuthService).createSession(admin.id);
  const userHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 같은 host×cli 의 **옛** 보고(다른 워크스페이스, 옛 어댑터) — 더 많이 알아도 최신 보고를 이기면 안 된다.
  const settingsRepo = ds.getRepository('AgentSessionCliSetting');
  const oldWorkspace = await createWorkspace(app, getDataSourceToken, 'reported-models-old');
  const oldRow = await settingsRepo.save(settingsRepo.create({
    workspace_id: oldWorkspace.id,
    manager_id: manager.id,
    cli: 'opencode',
    credential_id: null,
    default_config: '{}',
    known_config_options: JSON.stringify([
      { config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: null,
        options: ['opencode/old-1', 'opencode/old-2', 'opencode/old-3', 'opencode/old-4', 'opencode/old-5'].map((value) => ({ value, name: value })) },
    ]),
    updated_by: admin.id,
  }));
  await ds.query('UPDATE agent_session_cli_settings SET updated_at = ? WHERE id = ?', ['2026-01-01 00:00:00', oldRow.id]);

  // 하트비트는 zen 계열 2개만 열거한다(실측과 같은 모양: 접두사가 다르다).
  const HEARTBEAT = ['opencode/big-pickle', 'opencode/space-bunny-free'];
  // ACP 보고(영속) — 운영 DB 행과 같은 모양의 config option JSON.
  const REPORTED = ['opencode-go/glm-5.3', 'opencode-go/gpt-6-luna', 'opencode/big-pickle'];
  await settingsRepo.save(settingsRepo.create({
    workspace_id: workspace.id,
    manager_id: manager.id,
    cli: 'opencode',
    credential_id: null,
    default_config: '{}',
    known_config_options: JSON.stringify([
      { config_id: 'mode', name: 'Mode', category: 'mode', type: 'select', current_value: 'build', options: [{ value: 'build', name: 'Build' }] },
      { config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: REPORTED[0], options: REPORTED.map((value) => ({ value, name: value === 'opencode-go/glm-5.3' ? 'GLM 5.3' : value })) },
    ]),
    updated_by: admin.id,
  }));

  const resp = await fetch(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST',
    headers: { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: 'reported-models-instance', agent_id: manager.id, host_id: manager.id, mode: 'manager', hostname: 'ralf', plugin_version: 'test',
      cli: 'mixed', cli_adapters: ['opencode'], pid: 1, started_at: new Date().toISOString(),
      available_models: { opencode: HEARTBEAT }, available_models_at: new Date().toISOString(),
    }),
  });
  assert.equal(resp.status, 201, await resp.text());

  // 서버 재시작 뒤 첫 조회를 흉내낸다 — 라이브 세션 관측 없이 영속 목록만으로 답해야 한다.
  const hostModels = app.get((await import('../dist/modules/agent-manager/host-models.service.js')).HostModelsService);
  await hostModels.reloadReportedModels();

  const json = async (url, extraHeaders = {}) => {
    const r = await fetch(url, { headers: { ...userHeaders, ...extraHeaders } });
    const text = await r.text();
    assert.equal(r.status, 200, text);
    return JSON.parse(text);
  };
  // 가장 최근 ACP 보고만. 하트비트에만 있는 space-bunny-free 와 옛 보고(old-*)는 나오지 않는다.
  const expected = REPORTED;

  const view = await json(`${base}/api/agent-manager/hosts/${manager.id}/models`);
  assert.deepEqual(view.models.opencode, expected, 'Agent 다이얼로그·Runtime Hosts 가 보는 목록');
  // 이름도 같은 출처에서 온다 — 세션은 어댑터 이름(`GLM 5.3`)을, 팀 슬롯은 id 를 그려 같은 목록이
  // 다르게 보였다. 이름이 id 와 같은 항목은 싣지 않는다(화면은 id 로 떨어진다).
  assert.deepEqual(view.labels?.opencode, { 'opencode-go/glm-5.3': 'GLM 5.3' });

  const hosts = await json(`${base}/api/orchestration/runtime-hosts?workspace_id=${workspace.id}`);
  const roster = hosts.find((h) => h.manager_agent_id === manager.id)?.available_models.opencode;
  assert.deepEqual(roster, expected, 'mission 팀 슬롯이 보는 목록 — 세션 화면과 같아야 한다');

  // 세션 화면의 CLI 설정 응답도 같은 집합을 본다(순서 규칙이 ACP 먼저라 동일하다).
  const cliSettings = await json(
    `${base}/api/agent-sessions/hosts/${manager.id}/opencode/settings`,
    { 'X-Workspace-Id': workspace.id },
  );
  const sessionModels = (cliSettings.known_config_options ?? [])
    .filter((o) => o.category === 'model')
    .flatMap((o) => o.options.map((x) => x.value));
  assert.deepEqual(sessionModels, expected, '세션 화면도 같은 목록·같은 순서');
});

// ── 실측 재현(2026-10-02, ragnar claude) ──────────────────────────────────────
// 하트비트(바이너리 스캔) = alias + `claude-sonnet-5-5` 같은 구체 id. 어댑터 보고 = CLI 의 모델
// 선택지 5개. 합집합이던 동안 새 세션·팀 슬롯에는 `claude-sonnet-5-5` 가 있고 세션 안에는 없었다.

test('ragnar: 어댑터 보고가 있으면 새 세션·팀 슬롯·Agent 다이얼로그가 세션 안과 같은 목록을 본다', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => { await app.close(); });
  const base = `http://127.0.0.1:${port}`;
  const { AuthService, getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const workspace = await createWorkspace(app, getDataSourceToken, 'ragnar-claude');
  const manager = await createAgent(app, getDataSourceToken, null, { name: 'Ragnar', type: 'manager' });
  const managerKey = await createApiKey(app, getDataSourceToken, manager.id, { workspaceId: workspace.id, label: 'ragnar-key' });
  const admin = await createUser(app, getDataSourceToken, { name: 'admin3', role: 'admin' });
  const token = app.get(AuthService).createSession(admin.id);
  const userHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Workspace-Id': workspace.id };

  // 운영 DB 의 ragnar 행 그대로.
  const ADAPTER = [
    ['default', 'Default (recommended)'], ['sonnet', 'Sonnet 5.5'], ['claude-fable-5-1', 'Fable 5.1'],
    ['opus', 'Opus 5.5'], ['haiku', 'Haiku 4.5'],
  ];
  const settingsRepo = ds.getRepository('AgentSessionCliSetting');
  await settingsRepo.save(settingsRepo.create({
    workspace_id: workspace.id, manager_id: manager.id, cli: 'claude', credential_id: null, default_config: '{}',
    known_config_options: JSON.stringify([
      { config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: 'sonnet',
        options: ADAPTER.map(([value, name]) => ({ value, name })) },
    ]),
    updated_by: admin.id,
  }));
  const resp = await fetch(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST',
    headers: { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: 'ragnar-instance', agent_id: manager.id, host_id: manager.id, mode: 'manager', hostname: 'aitopatom-0561', plugin_version: 'test',
      cli: 'mixed', cli_adapters: ['claude'], pid: 1, started_at: new Date().toISOString(),
      available_models: { claude: ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'] },
      available_models_at: new Date().toISOString(),
    }),
  });
  assert.equal(resp.status, 201, await resp.text());
  const hostModels = app.get((await import('../dist/modules/agent-manager/host-models.service.js')).HostModelsService);
  await hostModels.reloadReportedModels();

  const json = async (url) => {
    const r = await fetch(url, { headers: userHeaders });
    const text = await r.text();
    assert.equal(r.status, 200, text);
    return JSON.parse(text);
  };
  const expected = ADAPTER.map(([value]) => value);

  const view = await json(`${base}/api/agent-manager/hosts/${manager.id}/models`);
  assert.deepEqual(view.models.claude, expected, '팀 슬롯·Agent 다이얼로그 — 세션 안 드롭다운과 같은 5개');
  assert.ok(!view.models.claude.includes('claude-sonnet-5-5'), '바이너리 스캔 id 가 새어 들어오면 세션 안과 달라진다');
  assert.equal(view.labels.claude.sonnet, 'Sonnet 5.5');

  const hosts = await json(`${base}/api/orchestration/runtime-hosts?workspace_id=${workspace.id}`);
  assert.deepEqual(hosts.find((h) => h.manager_agent_id === manager.id)?.available_models.claude, expected, 'mission 로스터');

  const settings = await json(`${base}/api/agent-sessions/hosts/${manager.id}/claude/settings`);
  const newSession = settings.known_config_options.find((o) => o.category === 'model').options;
  assert.deepEqual(newSession.map((o) => o.value), expected, '새 세션 모달 — 덧붙는 하트비트 id 가 없다');
  assert.deepEqual(newSession.map((o) => o.name), ADAPTER.map(([, name]) => name), '이름도 세션 안과 같다');
});

test('effort enumeration isolates models and CLIs, reads persisted ACP reports and replaces live choices', async () => {
  const { HostModelsService } = await import('../dist/modules/agent-manager/host-models.service.js');
  const { effortReportFromConfigOptions } = await import('../dist/modules/agent-manager/host-effort-options.js');
  const config = (model, levels) => [
    { category: 'model', type: 'select', current_value: model, options: [{ value: model, name: model }] },
    { category: 'thought_level', type: 'select', config_id: 'reasoning', options: levels.map(value => ({ value, name: value.toUpperCase() })) },
  ];
  const rows = [
    { manager_id: 'h', cli: 'cli', known_config_options: JSON.stringify(config('m1', ['high', 'medium', 'high'])) },
    { manager_id: 'h', cli: 'cli', known_config_options: JSON.stringify(config('m1', ['old'])) },
    { manager_id: 'h', cli: 'cli', known_config_options: JSON.stringify(config('m2', ['low'])) },
  ];
  const service = new HostModelsService({ findOne: async () => ({ id: 'h', name: 'Host' }) }, {}, { find: async () => rows }, { list: () => [] }, {}, {});
  await service.onModuleInit();
  const reports = (await service.snapshot('h')).effort_options.cli;
  assert.deepEqual(reports.map(r => [r.model, r.options.map(o => o.value)]), [['m1', ['high', 'medium']], ['m2', ['low']]]);
  assert.equal(reports[0].options[0].label, 'HIGH');
  service.noteObservedConfigOptions('h', 'cli', config('m1', ['max']));
  service.noteObservedConfigOptions('other-host', 'cli', config('m1', ['wrong-host']));
  service.noteObservedConfigOptions('h', 'other-cli', config('m1', ['different-cli']));
  assert.deepEqual((await service.snapshot('h')).effort_options.cli[0].options, [{ value: 'max', label: 'MAX' }]);
  service.noteObservedConfigOptions('h', 'cli', [config('m1', [])[0]]);
  assert.deepEqual((await service.snapshot('h')).effort_options.cli[0], { model: 'm1', config_id: null, options: [] });
  for (const bad of ['{', '{}', '[]', null]) assert.equal(effortReportFromConfigOptions(bad), null);
  assert.deepEqual(effortReportFromConfigOptions(config(null, ['low'])).model, null);
});
