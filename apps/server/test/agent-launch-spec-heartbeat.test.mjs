// 회귀 테스트 — 매니저가 보고한 실효 실행 사양의 서버측 수용 계약 (ticket 20fff298).
//
// 지키는 계약 세 가지:
//   1. 정상 사양은 손상 없이 레지스트리에 실려 REST 로 나간다.
//   2. **구버전 매니저(필드 미보고)는 `undefined` 로 보존된다.** 빈 배열로
//      접으면 UI 가 "보고 안 함"과 "보고했는데 대상 없음"을 구분할 수 없다 —
//      그 구분이 이 티켓 요구사항 C 의 핵심이다.
//   3. 신뢰할 수 없는 크기/모양은 조용히 좁혀지되 전체가 버려지지는 않는다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createApiKey, createWorkspace } from './helpers/fixtures.mjs';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';

process.env.PORT = process.env.AGENT_LAUNCH_SPEC_HEARTBEAT_PORT || '7942';

async function bootWithManager(t, port, label) {
  const { app, port: boundPort, modules } = await bootApp({ port });
  t.after(async () => { await app.close(); });
  const { getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, label);
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: label,
    type: 'manager',
  });
  const key = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label,
  });
  return { app, port: boundPort, workspace, manager, key };
}

function heartbeat(port, key, manager, workspace, instanceId, extra) {
  return fetch(`http://127.0.0.1:${port}/api/agent/instance-heartbeat`, {
    method: 'POST',
    headers: { 'X-Agent-Key': key.raw_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: instanceId,
      agent_id: manager.id,
      workspace_id: workspace.id,
      mode: 'manager',
      hostname: 'test-host',
      plugin_version: 'test',
      cli: 'claude',
      cli_adapters: ['claude'],
      pid: 123,
      started_at: new Date().toISOString(),
      ...extra,
    }),
  });
}

const VALID_SPEC = {
  agent_id: 'agent-1',
  cli: 'claude',
  bin: '/usr/local/bin/claude',
  bin_error: null,
  modes: [
    {
      mode: 'session',
      notes: ['MCP 설정은 spawn 마다 복사한 per-process 임시 경로입니다.'],
      args: [
        { value: '--session-id', source: 'session' },
        { value: '<세션 id: spawn 시 생성>', source: 'session', placeholder: true },
        { value: '--model', source: 'model' },
        { value: 'claude-opus-5', source: 'model' },
        { value: '--mcp-config', source: 'adapter' },
        { value: '<MCP 설정: spawn 시 생성>', source: 'mcp', placeholder: true },
        { value: '--dangerously-skip-permissions', source: 'permission' },
        { value: '<역할 프롬프트: 디스패치 시 생성>', source: 'adapter', placeholder: true },
      ],
    },
    { mode: 'oneshot', notes: [], args: [{ value: '--print', source: 'adapter' }] },
  ],
  cwd: '/srv/work',
  cwd_kind: 'base',
  mcp_config_path: '/cfg/mcp.json',
  model: 'claude-opus-5',
  permission: { tier: 'trusted', source: 'agent_trust', harness_mode: null },
  runtime_profile: null,
  env: [{ key: 'CLAUDE_CONFIG_DIR', value: '/home/a/cli-home', source: 'cli_home' }],
  // 실제 spawn 기록 — **기록 전용 출처**(harness/effort/prompt)가 포함된다.
  // 추정(`modes`)에는 나타날 수 없는 값들이라 여기서만 검증할 수 있다.
  last_spawn: {
    mode: 'session',
    bin: '/usr/local/bin/claude',
    args: [
      { value: '--session-id', source: 'session' },
      { value: 'sid-1', source: 'session' },
      { value: '--model', source: 'model' },
      { value: 'claude-opus-5', source: 'model' },
      { value: '--effort', source: 'effort' },
      { value: 'max', source: 'effort' },
      { value: '--disallowedTools', source: 'harness' },
      { value: '<8ch>', source: 'harness' },
      { value: '--append-system-prompt', source: 'adapter' },
      { value: '<프롬프트 본문: 표시하지 않음>', source: 'prompt', placeholder: true },
      { value: '--dangerously-skip-permissions', source: 'permission' },
      { value: '--settings', source: 'runtime_profile' },
    ],
    args_attributed: true,
    cwd: '/srv/work/.awb/wt/repo/20fff298',
    env: [{ key: 'ANTHROPIC_MODEL', value: '<12ch>', source: 'credential' }],
    context: {
      ticket_id: '20fff298-e752-4b9a-92d9-3f37b7e355ea',
      role: 'assignee',
      harness_keys: ['disallowed_tools', 'permission_mode'],
      effort: 'max',
      runtime_profile_id: 'vllm-local',
    },
    recorded_at: '2026-01-01T00:00:01.000Z',
  },
  varies_per_dispatch: ['보드·워크스페이스 harness (harness_config)'],
  computed_at: '2026-01-01T00:00:00.000Z',
};

test('실효 실행 사양이 손상 없이 레지스트리와 REST 응답에 실린다', async (t) => {
  const { app, port, workspace, manager, key } = await bootWithManager(
    t, Number.parseInt(process.env.PORT, 10), 'launch-spec-ok',
  );

  const res = await heartbeat(port, key, manager, workspace, 'launch-spec-ok', {
    agent_launch_specs: [VALID_SPEC],
  });
  assert.equal(res.status, 201, await res.text());

  const record = app.get(InstanceRegistryService).get('launch-spec-ok');
  assert.deepEqual(record.agent_launch_specs, [VALID_SPEC]);
  // placeholder 는 true 일 때만 실린다 — 나머지 인자에 붙으면 UI 가 실제 인자를
  // 자리표시자로 잘못 표시한다.
  assert.deepEqual(
    record.agent_launch_specs[0].modes[0].args.map((a) => a.placeholder),
    [undefined, true, undefined, undefined, undefined, true, undefined, true],
  );
  // 경로별 단서도 보존돼야 한다 — MCP 값이 왜 자리표시자인지의 유일한 설명이다.
  assert.deepEqual(
    record.agent_launch_specs[0].modes.map((m) => m.notes.length),
    [1, 0],
  );
  // 모드 순서는 보존되어야 한다 — 첫 항목이 "실제로 도는 경로"라는 뜻이라
  // 재배치되면 UI 가 기본 경로를 잘못 고른다.
  assert.deepEqual(record.agent_launch_specs[0].modes.map((m) => m.mode), ['session', 'oneshot']);

  // 기록 전용 출처가 살아 있어야 한다 (리뷰 3R) — 허용 집합에서 빠지면
  // unattributed 로 접히며 화면이 "출처 불명"을 줄줄이 그린다.
  const recorded = record.agent_launch_specs[0].last_spawn;
  assert.equal(recorded.args_attributed, true);
  assert.deepEqual(
    [...new Set(recorded.args.map((a) => a.source))].sort(),
    ['adapter', 'effort', 'harness', 'model', 'permission', 'prompt', 'runtime_profile', 'session'],
  );
});

test('구버전 매니저가 필드를 안 보내면 undefined 로 보존된다 (빈 배열로 접지 않는다)', async (t) => {
  const { app, port, workspace, manager, key } = await bootWithManager(
    // 고정 포트를 산술로 파생(PORT+n)하지 않고 OS 가 고른 빈 포트를 쓴다 (ticket 5db0964a).
    // 파생 포트는 소스 grep 에도 포트 목록에도 잡히지 않는 데다, bootApp 이 부팅마다
    // process.env.PORT 를 실제 바인딩 포트로 덮어쓰기 때문에 두 번째 파생부터는 의도한
    // 번호에서 밀리기까지 했다. 실제 포트는 bootApp 의 반환값을 그대로 쓴다.
    t, 0, 'launch-spec-legacy',
  );

  // 신규 필드를 전혀 모르는 매니저의 하트비트.
  const res = await heartbeat(port, key, manager, workspace, 'launch-spec-legacy', {});
  assert.equal(res.status, 201, await res.text());

  const registry = app.get(InstanceRegistryService);
  const record = registry.get('launch-spec-legacy');
  assert.equal(record.agent_launch_specs, undefined, '보고 안 함이 빈 배열로 뭉개졌다');
  // 클라이언트가 실제로 보는 형태로 확인한다 — REST 는 이 레코드를 그대로
  // JSON 직렬화하므로, 키 자체가 응답에서 빠져야 UI 의 "보고하지 않음" 분기가
  // 산다. in 연산자로 보면 컨트롤러의 객체 리터럴이 만든 undefined 키까지
  // 잡혀서 정작 중요한 wire 계약을 검증하지 못한다.
  assert.equal('agent_launch_specs' in JSON.parse(JSON.stringify(record)), false);

  // 반대쪽: 신규 매니저가 "대상 에이전트 없음"을 보고하면 빈 배열로 보존된다.
  // 이 둘이 구분되어야 UI 가 "보고하지 않음"과 "값 없음"을 다르게 그릴 수 있다.
  const res2 = await heartbeat(port, key, manager, workspace, 'launch-spec-empty', {
    agent_launch_specs: [],
  });
  assert.equal(res2.status, 201, await res2.text());
  assert.deepEqual(registry.get('launch-spec-empty').agent_launch_specs, []);
});

test('매니저가 다운그레이드되면 다음 하트비트에서 사양이 사라진다', async (t) => {
  const { app, port, workspace, manager, key } = await bootWithManager(
    t, 0, 'launch-spec-downgrade',
  );
  const registry = app.get(InstanceRegistryService);

  await heartbeat(port, key, manager, workspace, 'launch-spec-dg', {
    agent_launch_specs: [VALID_SPEC],
  });
  assert.equal(registry.get('launch-spec-dg').agent_launch_specs.length, 1);
  assert.equal(registry.get('launch-spec-dg').agent_launch_specs[0].modes.length, 2);

  // 같은 instance_id 로 필드 없는 하트비트가 오면(= 구버전으로 롤백) 옛 사양을
  // 계속 보여주면 안 된다 — 화면이 이미 존재하지 않는 실행 계획을 주장하게 된다.
  await heartbeat(port, key, manager, workspace, 'launch-spec-dg', {});
  assert.equal(registry.get('launch-spec-dg').agent_launch_specs, undefined);
});

test('신뢰할 수 없는 모양은 좁혀지되 전체가 버려지지는 않는다', async (t) => {
  const { app, port, workspace, manager, key } = await bootWithManager(
    t, 0, 'launch-spec-hostile',
  );

  const res = await heartbeat(port, key, manager, workspace, 'launch-spec-hostile', {
    agent_launch_specs: [
      // agent_id 없는 행은 통째로 버린다.
      { cli: 'claude', args: [] },
      {
        agent_id: 'agent-ok',
        cli: 12345,
        bin: null,
        bin_error: undefined,
        modes: [
          { mode: '모르는-모드', args: [{ value: '--x', source: 'adapter' }] },
          'not-an-object',
          {
            mode: 'oneshot',
            args: [
              { value: '--flag', source: '완전히-모르는-출처' },
              'not-an-object',
              { value: 'x'.repeat(2000), source: 'adapter' },
              ...Array.from({ length: 400 }, () => ({ value: '--pad', source: 'adapter' })),
            ],
          },
          ...Array.from({ length: 20 }, () => ({ mode: 'session', args: [], notes: [] })),
        ],
        permission: {},
        runtime_profile: { id: 'p', protocol: 'x', model: null, arg_count: -5 },
        last_spawn: {
          mode: 'session',
          bin: null,
          args: [{ value: '--x', source: '기록에만-있는-척하는-출처' }],
          // boolean 이 아닌 값은 false 로 접혀야 한다 — 귀속됐다고 잘못
          // 주장하는 쪽이 그 반대보다 나쁜 오표시다.
          args_attributed: 'yes',
          cwd: null,
          env: [],
          context: {},
          recorded_at: 0,
        },
        env: [{ key: 'K', value: '<redacted>', source: '이상한-출처' }, { value: 'no-key' }],
        notes: 'not-an-array',
        varies_per_dispatch: 'not-an-array',
        computed_at: 12345,
      },
    ],
  });
  assert.equal(res.status, 201, await res.text());

  const specs = app.get(InstanceRegistryService).get('launch-spec-hostile').agent_launch_specs;
  assert.equal(specs.length, 1, 'agent_id 없는 행만 버려져야 한다');
  const row = specs[0];
  assert.equal(row.agent_id, 'agent-ok');
  assert.equal(row.cli, 'unknown');
  // 모르는 mode 와 객체가 아닌 항목은 버려지고, 모드 개수도 상한으로 잘린다.
  assert.ok(row.modes.length <= 4);
  assert.equal(row.modes.some((m) => m.mode === '모르는-모드'), false);
  assert.equal(row.modes[0].mode, 'oneshot');
  const args = row.modes[0].args;
  // 모르는 출처는 지어내지 않고 unattributed 로 접는다.
  assert.equal(args[0].source, 'unattributed');
  // 객체가 아닌 항목은 버려지고, 과한 길이·개수는 상한으로 잘린다.
  assert.equal(args.some((a) => a.value.length > 500), false);
  assert.ok(args.length <= 200);
  assert.equal(row.permission.tier, 'unknown');
  assert.equal(row.runtime_profile.arg_count, 0);
  assert.deepEqual(row.env, [{ key: 'K', value: '<redacted>', source: 'credential' }]);
  assert.deepEqual(row.varies_per_dispatch, []);
  // notes 가 배열이 아니면 빈 배열로 접고, 과한 개수·길이는 상한으로 자른다.
  assert.deepEqual(row.modes[0].notes, []);
  // cwd_kind 는 모르는 값이면 보수적인 'base' 로 접는다 — 기준 경로를 실제
  // 프로세스 cwd 라고 주장하는 쪽이 그 반대보다 나쁜 오표시이기 때문이다.
  assert.equal(row.cwd_kind, 'base');
  // 기록도 같은 규칙으로 좁혀진다 — 모르는 출처는 unattributed, 참이 아닌
  // args_attributed 는 false.
  assert.equal(row.last_spawn.args_attributed, false);
  assert.equal(row.last_spawn.args[0].source, 'unattributed');
  assert.equal(row.last_spawn.context.harness_keys.length, 0);
});

exitAfterTests();
