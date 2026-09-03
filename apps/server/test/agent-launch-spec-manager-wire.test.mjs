// 회귀 테스트 — 매니저가 **실제로 계산한** 사양이 서버 수용 경로를 손실 없이
// 통과하는지 (ticket 20fff298).
//
// 왜 별도 파일인가: agent-launch-spec-heartbeat.test.mjs 는 손으로 만든 픽스처를
// 쓴다. 그 픽스처는 서버가 기대하는 모양을 그대로 적은 것이라, 매니저 쪽 실제
// 출력이 그 모양에서 벗어나도 잡지 못한다 — 두 앱은 타입을 공유하지 않고 각자
// 자기 인터페이스를 선언하므로, 스키마가 갈라져도 **양쪽 다 타입체크는 통과한다.**
// 여기서는 agent-manager 의 빌드 산출물을 직접 불러 계산시킨 결과를 그대로
// 하트비트로 보낸다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createApiKey, createWorkspace } from './helpers/fixtures.mjs';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';

process.env.PORT = process.env.AGENT_LAUNCH_SPEC_WIRE_PORT || '7946';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANAGER_DIST = join(REPO_ROOT, 'apps/agent-manager/dist/lib/launch-spec.js');

const SECRET = 'sk-ant-api03-WIRE-TEST-SECRET';

test('매니저의 실제 계산 결과가 서버 수용 경로를 손실 없이 통과한다', async (t) => {
  let computeAgentLaunchSpecs;
  try {
    ({ computeAgentLaunchSpecs } = await import(MANAGER_DIST));
  } catch (err) {
    // agent-manager 를 아직 빌드하지 않은 로컬 실행에서는 이 교차 검증을
    // 건너뛴다. CI 는 두 워크스페이스를 모두 빌드하므로 거기서는 항상 돈다.
    t.skip(`agent-manager dist 없음 — 먼저 빌드 필요: ${err?.message ?? err}`);
    return;
  }

  const specs = computeAgentLaunchSpecs([{
    agent_id: 'wire-agent', workspace_id: 'ws', name: 'T', cli: 'claude',
    working_dir: '/srv/work', mcp_config_path: '/cfg/mcp.json', api_key: SECRET,
    subagent_log_path: '/l', cli_home_dir: '/home/x/cli-home', model: 'claude-opus-5',
    runtime_config: { strategy: 'single', permission_mode: 'trusted' },
    extra_env: { ANTHROPIC_API_KEY: SECRET },
    registered_at: '2026-01-01T00:00:00.000Z',
  }]);
  assert.equal(specs.length, 1);

  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => { await app.close(); });
  const { getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'launch-spec-wire');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'launch-spec-wire', type: 'manager',
  });
  const key = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id, label: 'launch-spec-wire',
  });

  const res = await fetch(`http://127.0.0.1:${port}/api/agent/instance-heartbeat`, {
    method: 'POST',
    headers: { 'X-Agent-Key': key.raw_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: 'launch-spec-wire',
      agent_id: manager.id,
      workspace_id: workspace.id,
      mode: 'manager',
      hostname: 'test-host',
      plugin_version: 'test',
      cli: 'claude',
      cli_adapters: ['claude'],
      pid: 1,
      started_at: new Date().toISOString(),
      agent_launch_specs: specs,
    }),
  });
  assert.equal(res.status, 201, await res.text());

  const stored = app.get(InstanceRegistryService).get('launch-spec-wire').agent_launch_specs;
  // 손실 없음 — sanitize 가 매니저의 실제 출력을 깎아내지 않아야 한다. 스키마가
  // 갈라지면 여기서 필드가 사라지거나 unattributed 로 접히며 드러난다.
  assert.deepEqual(stored, JSON.parse(JSON.stringify(specs)));

  const row = stored[0];
  assert.deepEqual(row.modes.map((m) => m.mode), ['session', 'oneshot']);
  assert.equal(row.modes.some((m) => m.args.some((a) => a.source === 'unattributed')), false,
    '서버가 매니저의 출처 값을 인식하지 못했다 — 두 쪽 source 집합이 갈라졌다');
  // 실제 실행되는 경로의 모양이 그대로 보존됐는지.
  const session = row.modes[0].args.map((a) => a.value);
  assert.ok(session.includes('--session-id'));
  assert.ok(session.includes('--dangerously-skip-permissions'));
  assert.equal(session.includes('--print'), false);
  // 자격증명은 wire 어디에도 원문으로 오르지 않는다.
  assert.equal(JSON.stringify(stored).includes(SECRET), false);
});

exitAfterTests();
