import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  createWorkspace,
} from './helpers/fixtures.mjs';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';

process.env.PORT = process.env.RUNTIME_CAPABILITIES_HEARTBEAT_PORT || '7908';

test('Runtime Host heartbeat stores structured runtime health and capabilities', async (t) => {
  const { app, port, modules } = await bootApp({
    port: Number.parseInt(process.env.PORT, 10),
  });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'runtime-health');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'runtime-host',
    type: 'manager',
  });
  const key = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'runtime-health',
  });
  const runtimeCapabilities = {
    hermes: {
      installed: true,
      healthy: true,
      version: 'hermes-acp 0.3.0',
      reason: null,
      capabilities: {
        protocol: 'acp',
        session: 'resumable',
        native_mcp: true,
        native_approvals: true,
        steering: true,
        cancellation: true,
        usage: 'tokens',
        collaboration: ['delegated', 'swarm'],
        skill_delivery: ['filesystem', 'native'],
      },
    },
    codex: {
      installed: true,
      healthy: false,
      version: 'codex 1.2.3',
      reason: 'probe_failed',
      capabilities: {
        protocol: 'jsonl',
        session: 'oneshot',
        native_mcp: true,
        native_approvals: false,
        steering: false,
        cancellation: true,
        usage: 'tokens',
        collaboration: [],
        skill_delivery: ['prompt', 'filesystem'],
      },
    },
  };

  const response = await fetch(
    `http://127.0.0.1:${port}/api/agent/instance-heartbeat`,
    {
      method: 'POST',
      headers: {
        'X-Agent-Key': key.raw_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instance_id: 'runtime-host-test',
        agent_id: manager.id,
        workspace_id: workspace.id,
        mode: 'manager',
        hostname: 'test-host',
        plugin_version: 'test',
        cli: 'mixed',
        cli_adapters: ['codex', 'hermes'],
        runtime_capabilities: runtimeCapabilities,
        pid: 123,
        started_at: new Date().toISOString(),
      }),
    },
  );
  assert.equal(response.status, 201, await response.text());

  const record = app
    .get(InstanceRegistryService)
    .get('runtime-host-test');
  assert.deepEqual(record.runtime_capabilities, runtimeCapabilities);
  assert.equal(record.runtime_capabilities.hermes.healthy, true);
  assert.equal(record.runtime_capabilities.codex.healthy, false);
});

test('Runtime Host heartbeat carries hermes profiles through, sanitized', async (t) => {
  const { app, port, modules } = await bootApp({
    // 고정 포트를 산술로 파생(PORT+n)하지 않고 OS 가 고른 빈 포트를 쓴다 (ticket 5db0964a).
    // 파생 포트는 소스 grep 에도 포트 목록에도 잡히지 않는 데다, bootApp 이 부팅마다
    // process.env.PORT 를 실제 바인딩 포트로 덮어쓰기 때문에 두 번째 파생부터는 의도한
    // 번호에서 밀리기까지 했다. 실제 포트는 bootApp 의 반환값을 그대로 쓴다.
    port: 0,
  });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'runtime-health-profiles');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'runtime-host-profiles',
    type: 'manager',
  });
  const key = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'runtime-health-profiles',
  });
  const hermesCapabilities = {
    protocol: 'acp',
    session: 'resumable',
    native_mcp: true,
    native_approvals: true,
    steering: true,
    cancellation: true,
    usage: 'tokens',
    collaboration: ['delegated', 'swarm'],
    skill_delivery: ['filesystem', 'native'],
  };

  const response = await fetch(
    `http://127.0.0.1:${port}/api/agent/instance-heartbeat`,
    {
      method: 'POST',
      headers: {
        'X-Agent-Key': key.raw_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instance_id: 'runtime-host-test-profiles',
        agent_id: manager.id,
        workspace_id: workspace.id,
        mode: 'manager',
        hostname: 'test-host',
        plugin_version: 'test',
        cli: 'mixed',
        cli_adapters: ['hermes'],
        runtime_capabilities: {
          hermes: {
            installed: true,
            healthy: true,
            version: 'hermes 0.3.0',
            reason: null,
            capabilities: hermesCapabilities,
            // 유효/무효가 섞인 입력: 정상 이름은 통과하고, 문자열이 아닌 값,
            // Hermes 프로파일 이름 규칙(`[a-z0-9][a-z0-9_-]{0,63}`)을 벗어난
            // 값(길이 초과·허용되지 않은 문자), 중복 값은 heartbeat 전체를
            // 거부하지 않고 그 항목만 버린다 — slice로 잘라 새 이름을 만들어
            // 내지 않는다(잘린 이름은 Host가 보고한 적 없는 프로파일이 되어
            // 선택 시 Hermes 기동 실패로 이어질 수 있다).
            profiles: ['coder', 'reviewer', 'coder', 42, null, 'x'.repeat(200), 'Bad Profile!'],
          },
        },
        pid: 123,
        started_at: new Date().toISOString(),
      }),
    },
  );
  assert.equal(response.status, 201, await response.text());

  const record = app
    .get(InstanceRegistryService)
    .get('runtime-host-test-profiles');
  assert.deepEqual(record.runtime_capabilities.hermes.profiles, ['coder', 'reviewer']);
});

// ticket 5851e435 — 권한 등급별 표현력(permission_tiers)이 heartbeat 를 통해
// 운영자에게 보이는지. 로그만으로는 "이 런타임의 approve 는 승인 요청을 못
// 만든다"는 사실을 운영자가 알 수 없으므로 capabilities 로 명시한다.
test('Runtime Host heartbeat carries permission_tiers through, all-or-nothing', async (t) => {
  const { app, port, modules } = await bootApp({
    port: 0,
  });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'runtime-health-tiers');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'runtime-host-tiers',
    type: 'manager',
  });
  const key = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'runtime-health-tiers',
  });
  const base = {
    protocol: 'jsonl',
    session: 'oneshot',
    native_mcp: true,
    native_approvals: false,
    steering: false,
    cancellation: true,
    usage: 'tokens',
    collaboration: [],
    skill_delivery: ['prompt'],
  };
  const health = (capabilities) => ({
    installed: true, healthy: true, version: 'v1', reason: null, capabilities,
  });

  const response = await fetch(
    `http://127.0.0.1:${port}/api/agent/instance-heartbeat`,
    {
      method: 'POST',
      headers: { 'X-Agent-Key': key.raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: 'runtime-host-test-tiers',
        agent_id: manager.id,
        workspace_id: workspace.id,
        mode: 'manager',
        hostname: 'test-host',
        plugin_version: 'test',
        cli: 'mixed',
        cli_adapters: ['codex'],
        runtime_capabilities: {
          // 정상: 세 등급이 모두 알려진 support 값이다.
          codex: health({
            ...base,
            permission_tiers: { strict: 'native', approve: 'approximated', trusted: 'native' },
          }),
          // 일부만 온 경우: 빠진 등급이 "미보고"인지 "미지원"인지 구분할 수
          // 없으므로 필드째 버린다(부분 수용은 능력 선언을 애매하게 만든다).
          pi: health({ ...base, permission_tiers: { strict: 'native' } }),
          // 미지의 support 값이 섞인 경우도 마찬가지로 필드째 버린다.
          antigravity: health({
            ...base,
            permission_tiers: { strict: 'native', approve: 'sometimes', trusted: 'native' },
          }),
          // 아예 보고하지 않는 구버전 Host: 서버가 기본값을 지어내지 않는다.
          claude: health({ ...base }),
        },
        pid: 123,
        started_at: new Date().toISOString(),
      }),
    },
  );
  assert.equal(response.status, 201, await response.text());

  const caps = app.get(InstanceRegistryService).get('runtime-host-test-tiers').runtime_capabilities;
  assert.deepEqual(caps.codex.capabilities.permission_tiers, {
    strict: 'native', approve: 'approximated', trusted: 'native',
  });
  assert.equal(caps.pi.capabilities.permission_tiers, undefined, '부분 보고는 필드째 버린다');
  assert.equal(caps.antigravity.capabilities.permission_tiers, undefined, '미지의 support 값도 필드째 버린다');
  assert.equal(caps.claude.capabilities.permission_tiers, undefined, '미보고는 기본값을 지어내지 않는다');
  // 나머지 capability 는 permission_tiers 유무와 무관하게 그대로 통과한다.
  assert.equal(caps.pi.capabilities.protocol, 'jsonl');
  assert.equal(caps.pi.healthy, true);
});

exitAfterTests();
