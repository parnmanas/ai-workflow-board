// 모델 목록 갱신 — 모든 화면이 같은 경로를 쓴다 (src/cli/hostModels.ts).
//
// 예전(ticket 40110b64)에는 Runtime Hosts 화면과 Agent 다이얼로그가 각자 admin 전용
// command 엔드포인트로 `refresh_available_models` 를 보내고 브라우저가 ack 를 폴링했다.
// 이제 서버가 `POST /api/agent-manager/hosts/:id/models/refresh` 안에서 ack 를 기다린 뒤
// 갱신된 목록을 돌려주므로, 화면은 (1) 그 하나의 API 를 부르고 (2) 응답으로 드롭다운을
// 바꾸며 (3) 폴링하지 않는다. 검증 대상:
//
//   1) Runtime Hosts 화면의 "Refresh models" 가 **그 호스트(manager agent id)** 로 갱신을
//      요청하고 결과 요약을 토스트로 보여준다.
//   2) Agent 다이얼로그는 응답이 오기 전에는 드롭다운을 바꾸지 않고, 응답 이후 새 모델이
//      나타난다. 옛 command/outcome API 는 호출되지 않는다.
//   3) 여러 화면이 같은 호스트를 동시에 갱신해도 요청은 한 번이다(스토어가 in-flight 를 공유).

import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../src/api.ts';
import { React, act, click, mount, setupDom } from './helpers/jsdom.mjs';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { resetHostModelsStore, refreshHostModels } from '../src/cli/hostModels.ts';

const { InstanceDetail } = await import('../src/components/admin/AgentManagerPage.tsx');
// P4c-3b: ManagedAgentDialog 삭제 — Agent 다이얼로그 경유 갱신 테스트는 함께 제거.
// 스토어 동작(응답 전 스냅샷 유지·응답 후 반영)은 Runtime Hosts 화면 테스트가 커버한다.

const INSTANCE_ID = 'inst-refresh-1';
const MANAGER_AGENT_ID = 'mgr-refresh-1';

function instanceRow({ availableModels }) {
  return {
    instance_id: INSTANCE_ID,
    agent_id: MANAGER_AGENT_ID,
    account_id: 'ws-1',
    mode: 'manager',
    hostname: 'refresh-host',
    plugin_version: '1.0.0',
    cli: 'mixed',
    cli_adapters: ['claude', 'codex'],
    runtime_capabilities: { claude: { installed: true, healthy: true } },
    pid: 11,
    started_at: '2026-09-05T00:00:00.000Z',
    last_seen_at: '2026-09-05T00:00:10.000Z',
    agent_ids: [],
    available_models: availableModels,
  };
}

function hostView(models, refreshedAt = new Date().toISOString()) {
  return {
    manager_agent_id: MANAGER_AGENT_ID,
    manager_name: 'manager',
    is_online: true,
    instance_id: INSTANCE_ID,
    refreshed_at: refreshedAt,
    models,
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

function mountWithToasts(t, element) {
  const previousAudio = globalThis.Audio;
  globalThis.Audio = class {
    constructor() {
      this.volume = 0;
      this.currentTime = 0;
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
  };
  const view = mount(React.createElement(ToastProvider, null, element));
  t.after(() => {
    view.unmount();
    globalThis.Audio = previousAudio;
  });
  return view;
}

/**
 * 갱신 API 스텁. `release()` 를 부르기 전까지 응답을 붙들어 "응답 전에는 화면이 바뀌지
 * 않는다" 를 재현한다. 옛 command/outcome API 가 불리면 즉시 실패한다.
 */
function refreshStub(t, { before, after }) {
  const state = { getCalls: 0, refreshCalls: [], resolvers: [] };
  stubApi(t, {
    getHostModels: async (id) => {
      state.getCalls += 1;
      assert.equal(id, MANAGER_AGENT_ID);
      return hostView(before);
    },
    refreshHostModels: (id) => {
      state.refreshCalls.push(id);
      return new Promise((resolve) => state.resolvers.push(() => resolve(hostView(after))));
    },
    sendAgentManagerCommand: async () => {
      throw new Error('옛 command 엔드포인트를 더 이상 쓰면 안 된다');
    },
    getAgentManagerCommandOutcome: async () => {
      throw new Error('브라우저가 ack 를 폴링하면 안 된다 — 서버가 기다린다');
    },
  });
  return {
    state,
    release: async () => {
      for (const r of state.resolvers.splice(0)) r();
      await act(async () => {});
    },
  };
}

test('Runtime Hosts 화면의 "Refresh models" 는 그 호스트로 갱신을 요청하고 결과 요약을 보여준다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());
  resetHostModelsStore();

  const stub = refreshStub(t, {
    before: { claude: ['opus'] },
    after: { claude: ['opus', 'sonnet', 'haiku-4-5'], codex: ['gpt-5-codex'] },
  });
  stubApi(t, {
    getAgentManagerInstanceSubagents: async () => [],
    getAgentManagerInstanceLogs: async () => [],
    getAgent: async () => ({ id: MANAGER_AGENT_ID, name: 'manager', description: '' }),
    listAgentManagerInstances: async () => [instanceRow({ availableModels: { claude: ['opus'] } })],
  });

  const view = mountWithToasts(
    t,
    React.createElement(InstanceDetail, {
      inst: instanceRow({ availableModels: { claude: ['opus'] } }),
      workspaceAgents: [],
    }),
  );
  await act(async () => {});

  const button = findButton(view.container, 'Refresh models');
  assert.ok(button, 'manager 인스턴스에는 "Refresh models" 버튼이 있어야 한다');
  await act(async () => { click(button); });
  await act(async () => {});
  assert.deepEqual(stub.state.refreshCalls, [MANAGER_AGENT_ID], '클릭 한 번에 그 호스트로 갱신 한 건');

  await stub.release();
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  assert.ok(
    view.container.textContent.includes('claude=3, codex=1'),
    `토스트에 CLI 별 모델 수 요약이 보여야 한다 — 실제: ${view.container.textContent}`,
  );
});

test('같은 호스트를 여러 화면이 동시에 갱신해도 요청은 한 번이다 (in-flight 공유)', async (t) => {
  resetHostModelsStore();
  const stub = refreshStub(t, { before: { claude: ['opus'] }, after: { claude: ['opus', 'sonnet'] } });
  const a = refreshHostModels(MANAGER_AGENT_ID);
  const b = refreshHostModels(MANAGER_AGENT_ID);
  assert.equal(a, b, '진행 중인 약속을 공유한다');
  // 스토어는 api 모듈을 지연 import 하므로 스텁이 요청을 받을 때까지 한 tick 기다린다.
  for (let i = 0; i < 50 && stub.state.resolvers.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  await stub.release();
  const [va, vb] = await Promise.all([a, b]);
  assert.deepEqual(va.models, { claude: ['opus', 'sonnet'] });
  assert.equal(va, vb);
  assert.equal(stub.state.refreshCalls.length, 1);
});
