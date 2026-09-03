// 회귀 테스트 — Details 진입 일관화 + 실행 인자 섹션 (ticket 20fff298).
//
// 증상 1: Details 버튼이 일부 에이전트에만 보였다. 원인은 버튼이
// `onOpenAgent && dashboardAgent` 로 게이팅돼 있었던 것 — `dashboardAgent` 는
// **현재 워크스페이스 스냅샷**에서 찾은 행이라, 매니저가 보고했지만 그 목록에
// 없는 에이전트(다른 워크스페이스 소속 / 글로벌 / 스냅샷 지연)는 버튼이 통째로
// 사라졌다. 정작 Details 는 `/ws/:wsId/agents/:agentId` 라우트로 가고 그 화면이
// id 로 단건 조회하므로 스냅샷 행은 애초에 필요가 없었다.
//
// 증상 2: 실행 인자를 어디서도 볼 수 없었다.
//
// 두 증상 모두 **실제 컴포넌트를 마운트해** 검증한다. 소스 정규식은 게이팅이
// 다른 형태로 되살아나도 통과할 수 있어서 승인 근거가 못 된다.

import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';

import { ManagedAgentsSection, InstanceDetail } from '../src/components/admin/AgentManagerPage.tsx';
import AgentLaunchSpecSection from '../src/components/AgentLaunchSpecSection.tsx';

const MANAGER_ONLY_AGENT = {
  id: 'agent-not-in-snapshot',
  name: '다른 워크스페이스 소속 에이전트',
  type: 'claude',
  workspace_id: 'other-workspace',
  manager_agent_id: 'mgr-1',
};

const INSTANCE = {
  instance_id: 'inst-1',
  agent_id: 'mgr-1',
  workspace_id: 'ws-1',
  mode: 'manager',
  hostname: 'test-host',
  plugin_version: '1.0.0',
  cli: 'claude',
  cli_adapters: ['claude'],
  pid: 1,
  started_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
  agent_ids: ['agent-not-in-snapshot'],
};

/** jsdom + fetch 스텁을 세우고 정리 함수를 돌려준다. */
function setupDom(t, routes) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // api.ts 의 getAuthHeaders() 가 **전역** localStorage 를 직접 읽는다. 없으면
  // ReferenceError 가 나고, 그건 컴포넌트의 try/catch 에 삼켜져 "행이 0개"로
  // 보인다 — 게이팅 회귀와 구분이 안 되므로 반드시 세워 둔다.
  globalThis.localStorage = dom.window.localStorage;
  // globalThis.navigator 는 Node 24 에서 getter-only 라 덮어쓸 수 없고, 이
  // 테스트들이 쓰는 경로에도 필요 없다(클립보드는 SSR 단언 대상이 아니다).
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    for (const [needle, body] of Object.entries(routes)) {
      if (path.includes(needle)) {
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    delete globalThis.localStorage;
    dom.window.close();
  });
  return dom;
}

test('워크스페이스 스냅샷에 없는 에이전트에도 Details 진입 경로가 보인다', async (t) => {
  const dom = setupDom(t, {
    '/agents?scope=all': [MANAGER_ONLY_AGENT],
    '/workspaces': [{ id: 'ws-1', name: 'ws' }],
  });

  const opened = [];
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(ManagedAgentsSection, {
        inst: INSTANCE,
        // 스냅샷이 비어 있다 — 예전 게이팅이면 버튼이 전혀 렌더되지 않는 조건.
        workspaceAgents: [],
        onOpenAgent: (id) => opened.push(id),
      }),
    );
  });

  const detailsButtons = Array.from(document.querySelectorAll('button')).filter(
    (b) => b.textContent.trim() === 'Details',
  );
  assert.equal(detailsButtons.length, 1, '스냅샷에 없다는 이유로 Details 가 사라졌다');

  await act(async () => {
    detailsButtons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  // 진입은 agent id 로 이뤄져야 한다 — 목적지 화면이 그 id 로 단건 조회한다.
  assert.deepEqual(opened, ['agent-not-in-snapshot']);

  await act(async () => root.unmount());
});

test('스냅샷에 행이 있어도 Details 진입 동작은 동일하다 (회귀 방지)', async (t) => {
  const dom = setupDom(t, {
    '/agents?scope=all': [MANAGER_ONLY_AGENT],
    '/workspaces': [{ id: 'ws-1', name: 'ws' }],
  });

  const opened = [];
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(ManagedAgentsSection, {
        inst: INSTANCE,
        workspaceAgents: [{ ...MANAGER_ONLY_AGENT, workspace_id: 'ws-1' }],
        onOpenAgent: (id) => opened.push(id),
      }),
    );
  });
  const detailsButtons = Array.from(document.querySelectorAll('button')).filter(
    (b) => b.textContent.trim() === 'Details',
  );
  assert.equal(detailsButtons.length, 1);
  await act(async () => {
    detailsButtons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.deepEqual(opened, ['agent-not-in-snapshot']);
  await act(async () => root.unmount());
});

test('인스턴스 상세의 "Agent details" 도 스냅샷과 무관하게 렌더된다', async (t) => {
  const dom = setupDom(t, {
    '/agents/mgr-1': { id: 'mgr-1', name: 'manager', description: '' },
  });

  const opened = [];
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(InstanceDetail, {
        inst: INSTANCE,
        workspaceAgents: [],
        onOpenAgent: (id) => opened.push(id),
      }),
    );
  });

  const buttons = Array.from(document.querySelectorAll('button')).filter(
    (b) => b.textContent.trim() === 'Agent details',
  );
  assert.equal(buttons.length, 1, 'InstanceDetail 의 진입 버튼이 스냅샷 유무로 게이팅됐다');
  await act(async () => {
    buttons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.deepEqual(opened, ['mgr-1']);
  await act(async () => root.unmount());
});

// ── 실행 인자 섹션 ───────────────────────────────────────────────────────────

const SPEC = {
  agent_id: 'agent-1',
  cli: 'claude',
  bin: '/usr/local/bin/claude',
  bin_error: null,
  args: [
    { value: '--model', source: 'model' },
    { value: 'claude-opus-5', source: 'model' },
    { value: '--dangerously-skip-permissions', source: 'permission' },
    { value: '--settings', source: 'runtime_profile' },
    { value: '<역할 프롬프트: 디스패치 시 생성>', source: 'adapter', placeholder: true },
  ],
  cwd: '/srv/work',
  mcp_config_path: '/cfg/mcp.json',
  model: 'claude-opus-5',
  permission: { tier: 'trusted', source: 'agent_trust', harness_mode: null },
  runtime_profile: { id: 'vllm', protocol: 'openai-compatible', model: 'qwen3', arg_count: 2 },
  env: [
    { key: 'CLAUDE_CONFIG_DIR', value: '/home/a/cli-home', source: 'cli_home' },
    { key: 'ANTHROPIC_API_KEY', value: '<redacted>', source: 'credential' },
  ],
  varies_per_dispatch: ['보드·워크스페이스 harness (harness_config)'],
  computed_at: '2026-01-01T00:00:00.000Z',
};

const renderSection = (props) =>
  renderToStaticMarkup(React.createElement(AgentLaunchSpecSection, props));

test('실행 인자 섹션이 실효 argv 를 출처와 함께 복사 가능한 형태로 보여준다', () => {
  const html = renderSection({ spec: SPEC, managerFound: true, reported: true });

  // 복사용 한 줄에 실행 파일과 인자가 순서대로 들어간다.
  assert.match(html, /\/usr\/local\/bin\/claude --model claude-opus-5 --dangerously-skip-permissions/);
  // 인자별 출처가 드러난다 — 이게 요구사항 A 의 핵심이다.
  assert.match(html, /data-source="model"/);
  assert.match(html, /data-source="permission"/);
  assert.match(html, /data-source="runtime_profile"/);
  assert.match(html, /어댑터 기본값|모델 설정|trust·권한 설정|런타임 프로파일/);
  // 권한 등급과 그 출처를 함께 보여준다.
  assert.match(html, /에이전트 trust 설정/);
  // env 출처 라벨은 argv 출처 맵을 재사용하면 빈칸이 된다.
  assert.match(html, /CLI 홈 격리/);
  assert.match(html, /자격증명/);
  // 마스킹된 값은 마스킹된 그대로 통과한다 — 화면이 풀어 주지 않는다.
  assert.match(html, /&lt;redacted&gt;/);
  // 디스패치 시점 입력은 지어내지 않고 이름만 알린다.
  assert.match(html, /디스패치 시점에 정해져/);
});

test('구버전 매니저 · 매니저 부재 · 감독 안 함을 각각 다르게 설명한다', () => {
  // 구버전 매니저 — 필드 자체를 안 보낸다.
  const legacy = renderSection({ spec: null, managerFound: true, reported: false });
  assert.match(legacy, /실행 인자를 보고하지 않습니다/);
  assert.match(legacy, /업데이트하면 표시됩니다/);
  // 화면이 깨지지 않는다: 섹션은 그대로 있고 명령 블록만 없다.
  assert.match(legacy, /data-testid="launch-spec-section"/);
  assert.doesNotMatch(legacy, /data-testid="launch-spec-command"/);

  // 매니저를 못 찾음 — 위와 다른 원인이므로 다른 문구여야 한다.
  const noManager = renderSection({ spec: null, managerFound: false, reported: false });
  assert.match(noManager, /소유 매니저를 찾을 수 없어/);
  assert.doesNotMatch(noManager, /보고하지 않습니다/);

  // 보고는 했는데 이 에이전트 행이 없음 — 또 다른 원인.
  const notSupervised = renderSection({ spec: null, managerFound: true, reported: true });
  assert.match(notSupervised, /감독하고 있지 않을 수 있습니다/);
  assert.doesNotMatch(notSupervised, /업데이트하면 표시됩니다/);
});

test('값 없음과 해석 실패를 구분해서 표시한다', () => {
  const html = renderSection({
    spec: {
      ...SPEC,
      bin: null,
      bin_error: 'executable not found',
      model: null,
      cwd: null,
      runtime_profile: null,
      env: [],
      args: [],
    },
    managerFound: true,
    reported: true,
  });
  assert.match(html, /data-testid="launch-spec-bin-error"/);
  assert.match(html, /executable not found/);
  // 모델 미설정은 "값이 없다"가 아니라 "CLI 기본값을 쓴다"는 뜻이다.
  assert.match(html, /\(CLI 기본값\)/);
  assert.match(html, /\(설정 없음\)/);
  assert.match(html, /\(적용 안 됨\)/);
  assert.match(html, /추가 환경 변수가 없습니다/);
  // 실행 파일을 못 찾아도 명령 블록은 그리되 자리표시자를 쓴다.
  assert.match(html, /실행 파일 미해석/);
});
