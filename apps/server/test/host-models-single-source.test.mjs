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
//   ① ACP 가 보고한 목록이 앞, 하트비트가 아는 나머지가 뒤 — **순서까지 한 규칙**이다.
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

  // 이 호스트에 이미 살고 있는 agent 행 — 예전 로스터는 이 `model` 을 목록에 끼워넣었다.
  const agentRepo = app.get(getDataSourceToken()).getRepository('Agent');
  await agentRepo.save(agentRepo.create({
    name: 'oc-worker', description: 'pinned model row', type: 'opencode', is_active: 1, is_online: 0,
    workspace_id: workspace.id, role_prompt: '', manager_agent_id: manager.id,
    working_dir: '/srv/work', model: 'opencode/pinned-by-an-agent-row',
  }));

  const heartbeat = async () => {
    const resp = await fetch(`${base}/api/agent/instance-heartbeat`, {
      method: 'POST',
      headers: managerHeaders,
      body: JSON.stringify({
        instance_id: INSTANCE_ID, agent_id: manager.id, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
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
    'opencode/big-pickle',                 // 이미 아는 것은 중복되지 않는다
    'opencode-go/glm-5.3',                 // 세션만 아는 것(provider 를 방금 로그인)
  ]);

  // 규칙: ACP 보고(라이브 관측)가 앞, 하트비트의 나머지가 뒤 — 세션 화면의 순서와 같다.
  const expected = [
    'opencode/big-pickle',
    'opencode-go/glm-5.3',
    'opencode/muse-spark-1.3-contributor-free',
    'opencode/nemotron-3-ultra-free',
  ];
  assert.deepEqual(await snapshotModels(), expected, 'ACP 보고가 앞, 하트비트 나머지가 뒤 (중복 없이)');
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

  // 하트비트는 zen 계열 2개만 열거한다(실측과 같은 모양: 접두사가 다르다).
  const HEARTBEAT = ['opencode/big-pickle', 'opencode/space-bunny-free'];
  // ACP 보고(영속) — 운영 DB 행과 같은 모양의 config option JSON.
  const REPORTED = ['opencode-go/glm-5.3', 'opencode-go/gpt-6-luna', 'opencode/big-pickle'];
  const settingsRepo = ds.getRepository('AgentSessionCliSetting');
  await settingsRepo.save(settingsRepo.create({
    workspace_id: workspace.id,
    manager_id: manager.id,
    cli: 'opencode',
    credential_id: null,
    default_config: '{}',
    known_config_options: JSON.stringify([
      { config_id: 'mode', name: 'Mode', category: 'mode', type: 'select', current_value: 'build', options: [{ value: 'build', name: 'Build' }] },
      { config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: REPORTED[0], options: REPORTED.map((value) => ({ value, name: value })) },
    ]),
    updated_by: admin.id,
  }));

  const resp = await fetch(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST',
    headers: { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: 'reported-models-instance', agent_id: manager.id, mode: 'manager', hostname: 'ralf', plugin_version: 'test',
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
  // ACP 보고가 앞, 하트비트의 나머지가 뒤. 중복(`opencode/big-pickle`)은 한 번만.
  const expected = ['opencode-go/glm-5.3', 'opencode-go/gpt-6-luna', 'opencode/big-pickle', 'opencode/space-bunny-free'];

  const snapshot = (await json(`${base}/api/agent-manager/hosts/${manager.id}/models`)).models.opencode;
  assert.deepEqual(snapshot, expected, 'Agent 다이얼로그·Runtime Hosts 가 보는 목록');

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
