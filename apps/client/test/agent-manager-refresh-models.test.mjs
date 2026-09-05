// ticket 40110b64 — 매니저 재시작 없이 CLI 모델 목록을 갱신하는 UI 경로.
//
// 소스 정규식이 아니라 실제 컴포넌트를 마운트해 클릭까지 태운다. 검증 대상은
// 두 가지 사용자 관점 계약이다:
//
//   1) Runtime Hosts 화면의 "Refresh models" 가 **그 인스턴스**로
//      refresh_available_models 를 보낸다 (verb 오타 · 인스턴스 혼선 회귀 가드).
//   2) Agent 생성/편집 다이얼로그의 모델 드롭다운이 갱신된 목록으로 실제로
//      바뀐다 — 티켓의 완료 기준 중 사용자가 눈으로 확인하는 항목.

import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../src/api.ts';
import { React, act, click, mount, setupDom } from './helpers/jsdom.mjs';

const { InstanceDetail } = await import('../src/components/admin/AgentManagerPage.tsx');
const { default: ManagedAgentDialog } = await import(
  '../src/components/admin/ManagedAgentDialog.tsx'
);

const INSTANCE_ID = 'inst-refresh-1';
const MANAGER_AGENT_ID = 'mgr-refresh-1';

function instanceRow({ lastSeenAt, availableModels }) {
  return {
    instance_id: INSTANCE_ID,
    agent_id: MANAGER_AGENT_ID,
    workspace_id: 'ws-1',
    mode: 'manager',
    hostname: 'refresh-host',
    plugin_version: '1.0.0',
    cli: 'mixed',
    cli_adapters: ['claude', 'codex'],
    runtime_capabilities: { claude: { installed: true, healthy: true } },
    pid: 11,
    started_at: '2026-09-05T00:00:00.000Z',
    last_seen_at: lastSeenAt,
    agent_ids: [],
    available_models: availableModels,
  };
}

/** api 를 스텁하고 원복 훅을 건다. */
function stubApi(t, overrides) {
  const originals = {};
  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = api[key];
    api[key] = value;
  }
  t.after(() => Object.assign(api, originals));
}

function findButton(container, label) {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent.trim() === label,
  );
}

test('Runtime Hosts 화면의 "Refresh models" 는 해당 인스턴스로 refresh_available_models 를 보낸다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());

  const commands = [];
  let listCalls = 0;
  stubApi(t, {
    getAgentManagerInstanceSubagents: async () => [],
    getAgentManagerInstanceLogs: async () => [],
    getAgent: async () => ({ id: MANAGER_AGENT_ID, name: 'manager', description: '' }),
    sendAgentManagerCommand: async (instanceId, body) => {
      commands.push({ instanceId, body });
      return { ok: true, command_id: 'cmd-abcdef12', issued_at: new Date().toISOString() };
    },
    listAgentManagerInstances: async () => {
      listCalls += 1;
      // 첫 조회는 커맨드 직후(아직 갱신 전), 이후부터 즉시 하트비트가 도착한 상태.
      return [
        instanceRow({
          lastSeenAt: listCalls === 1 ? '2026-09-05T00:00:10.000Z' : '2026-09-05T00:00:12.000Z',
          availableModels: { claude: ['opus', 'sonnet', 'haiku'], codex: ['gpt-5'] },
        }),
      ];
    },
  });

  const view = mount(
    React.createElement(InstanceDetail, {
      inst: instanceRow({
        lastSeenAt: '2026-09-05T00:00:10.000Z',
        availableModels: { claude: ['opus'] },
      }),
      workspaceAgents: [],
    }),
  );
  t.after(() => view.unmount());
  await act(async () => {});

  const button = findButton(view.container, 'Refresh models');
  assert.ok(button, 'manager 인스턴스에는 "Refresh models" 버튼이 있어야 한다');
  assert.equal(button.disabled, false);

  await act(async () => {
    click(button);
  });

  assert.equal(commands.length, 1, '클릭 한 번에 커맨드 한 건');
  assert.equal(commands[0].instanceId, INSTANCE_ID, '다른 인스턴스로 새면 안 된다');
  assert.deepEqual(commands[0].body, { command: 'refresh_available_models' });
});

test('Agent 다이얼로그의 "모델 목록 새로고침" 이 드롭다운 후보를 갱신된 목록으로 바꾼다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());

  const commands = [];
  let refreshed = false;
  stubApi(t, {
    listCredentials: async () => [],
    listClaudeBackendProfiles: async () => ({ profiles: [] }),
    sendAgentManagerCommand: async (instanceId, body) => {
      commands.push({ instanceId, body });
      refreshed = true;
      return { ok: true, command_id: 'cmd-99887766', issued_at: new Date().toISOString() };
    },
    listAgentManagerInstances: async () => [
      instanceRow({
        // 리프레시 전후로 last_seen_at 이 달라져야 폴링이 "새 하트비트 도착"으로 본다.
        lastSeenAt: refreshed ? '2026-09-05T00:00:12.000Z' : '2026-09-05T00:00:10.000Z',
        availableModels: refreshed
          ? { claude: ['opus', 'sonnet', 'haiku-4-5'] }
          : { claude: ['opus'] },
      }),
    ],
  });

  const view = mount(
    React.createElement(ManagedAgentDialog, {
      isOpen: true,
      onClose() {},
      managerAgentId: MANAGER_AGENT_ID,
      managerInstanceId: INSTANCE_ID,
      mode: 'edit',
      agent: {
        id: 'agent-1',
        name: 'Claude 작업자',
        type: 'claude',
        workspace_id: 'workspace-1',
        working_dir: '/workspace',
        runtime_config: { strategy: 'single', permission_mode: 'trusted' },
      },
      onSubmitted() {},
    }),
  );
  t.after(() => view.unmount());
  await act(async () => {});

  const optionLabels = () =>
    [...view.container.querySelectorAll('option')].map((o) => o.textContent.trim());

  assert.ok(
    optionLabels().includes('opus'),
    '갱신 전에는 부팅 시점 목록(opus 하나)만 보인다',
  );
  assert.equal(
    optionLabels().includes('haiku-4-5'),
    false,
    '업그레이드로 생긴 새 모델은 아직 안 보이는 것이 이 티켓이 고치는 증상이다',
  );

  const button = findButton(view.container, '모델 목록 새로고침');
  assert.ok(button, '모델 필드 옆에 새로고침 버튼이 있어야 한다');

  await act(async () => {
    click(button);
  });
  // waitForFreshHeartbeat 의 첫 폴링 간격(800ms)만큼 실제로 기다린다.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].instanceId, INSTANCE_ID);
  assert.deepEqual(commands[0].body, { command: 'refresh_available_models' });
  assert.ok(
    optionLabels().includes('haiku-4-5'),
    '재열거된 모델이 매니저 재시작 없이 드롭다운에 나타나야 한다',
  );
});
