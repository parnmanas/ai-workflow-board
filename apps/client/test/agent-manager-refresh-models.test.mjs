// ticket 40110b64 — 매니저 재시작 없이 CLI 모델 목록을 갱신하는 UI 경로.
//
// 소스 정규식이 아니라 실제 컴포넌트를 마운트해 클릭까지 태운다. 검증 대상은
// 세 가지 사용자 관점 계약이다:
//
//   1) Runtime Hosts 화면의 "Refresh models" 가 **그 인스턴스**로
//      refresh_available_models 를 보낸다 (verb 오타 · 인스턴스 혼선 회귀 가드).
//   2) 완료 판정이 발급된 `command_id` 의 ack 에만 걸린다. 리뷰에서 지적된 회귀는
//      "인스턴스의 last_seen_at 이 바뀌면 완료" 로 본 것이었다 — 하트비트는 30초마다
//      알아서 도므로, 커맨드 처리 **전에** 무관한 정기 하트비트가 들어오기만 해도
//      조건이 충족돼 재열거 전 목록을 성공으로 오표시했다. 아래 테스트는 그 순서를
//      그대로 재현한다: unrelated heartbeat → 아직 완료 아님 → 같은 command_id 의
//      ack 도착 → 그때 비로소 완료 + 새 목록.
//   3) ack 의 detail(매니저가 보고한 CLI별 갱신 결과)이 화면에 노출된다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../src/api.ts';
import { React, act, click, mount, setupDom } from './helpers/jsdom.mjs';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';

const { InstanceDetail } = await import('../src/components/admin/AgentManagerPage.tsx');
const { default: ManagedAgentDialog } = await import(
  '../src/components/admin/ManagedAgentDialog.tsx'
);

const INSTANCE_ID = 'inst-refresh-1';
const MANAGER_AGENT_ID = 'mgr-refresh-1';
const COMMAND_ID = 'cmd-abcdef1234';
const ACK_DETAIL = 'refreshed 2 CLI(s): claude=3, codex=1';

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

/**
 * ToastProvider 로 감싸 실제 토스트가 DOM 에 렌더되게 한다 — ack detail 이 화면까지
 * 오는지를 문자열로 단언하기 위해서다. jsdom 에는 Audio 가 없어 provider 의 알림음
 * 초기화가 죽으므로 최소 스텁을 깐다(orchestration-confirm-panel.test.mjs 선례).
 */
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
 * ack 폴링을 흉내내는 스텁 팩토리.
 *
 * `pendingPolls` 회까지는 `pending` 을 돌려주고, 그 뒤부터 `ok` + detail 을
 * 돌려준다. 그 사이 인스턴스 목록은 **무관한 정기 하트비트**로 last_seen_at 만
 * 바뀐 옛 모델 목록을 계속 내놓는다 — 옛 코드라면 이 시점에 완료로 오판했다.
 */
function ackSequence({ pendingPolls }) {
  const state = { polls: 0, acked: false, listCalls: 0, commands: [], callOrder: [] };
  return {
    state,
    sendAgentManagerCommand: async (instanceId, body) => {
      state.callOrder.push('command');
      state.commands.push({ instanceId, body });
      return { ok: true, command_id: COMMAND_ID, issued_at: new Date().toISOString() };
    },
    getAgentManagerCommandOutcome: async (commandId) => {
      state.callOrder.push('outcome');
      assert.equal(commandId, COMMAND_ID, '발급된 command_id 로만 조회해야 한다');
      state.polls += 1;
      if (state.polls <= pendingPolls) {
        return { state: 'pending', command_id: commandId, detail: '', acked_at: null };
      }
      state.acked = true;
      return {
        state: 'ok',
        command_id: commandId,
        detail: ACK_DETAIL,
        acked_at: new Date().toISOString(),
      };
    },
    listAgentManagerInstances: async () => {
      state.listCalls += 1;
      state.callOrder.push('list');
      // ack 전에는 무관한 정기 하트비트가 last_seen_at 만 갱신한 옛 목록.
      return [
        instanceRow({
          lastSeenAt: `2026-09-05T00:00:${String(10 + state.listCalls).padStart(2, '0')}.000Z`,
          availableModels: state.acked
            ? { claude: ['opus', 'sonnet', 'haiku-4-5'], codex: ['gpt-5-codex'] }
            : { claude: ['opus'] },
        }),
      ];
    },
  };
}

test('Runtime Hosts 화면의 "Refresh models" 는 해당 인스턴스로 refresh_available_models 를 보내고, ack 를 받은 뒤에만 목록을 다시 읽는다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());

  const seq = ackSequence({ pendingPolls: 2 });
  stubApi(t, {
    getAgentManagerInstanceSubagents: async () => [],
    getAgentManagerInstanceLogs: async () => [],
    getAgent: async () => ({ id: MANAGER_AGENT_ID, name: 'manager', description: '' }),
    sendAgentManagerCommand: seq.sendAgentManagerCommand,
    getAgentManagerCommandOutcome: seq.getAgentManagerCommandOutcome,
    listAgentManagerInstances: seq.listAgentManagerInstances,
  });

  const view = mountWithToasts(
    t,
    React.createElement(InstanceDetail, {
      inst: instanceRow({
        lastSeenAt: '2026-09-05T00:00:10.000Z',
        availableModels: { claude: ['opus'] },
      }),
      workspaceAgents: [],
    }),
  );
  await act(async () => {});

  const button = findButton(view.container, 'Refresh models');
  assert.ok(button, 'manager 인스턴스에는 "Refresh models" 버튼이 있어야 한다');
  assert.equal(button.disabled, false);

  await act(async () => {
    click(button);
  });
  // 폴링 2회(pending) + 3회차(ok) + 그 뒤 목록 재조회까지 실제로 기다린다.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3200));
  });

  assert.equal(seq.state.commands.length, 1, '클릭 한 번에 커맨드 한 건');
  assert.equal(seq.state.commands[0].instanceId, INSTANCE_ID, '다른 인스턴스로 새면 안 된다');
  assert.deepEqual(seq.state.commands[0].body, { command: 'refresh_available_models' });

  // 핵심 회귀 가드: 인스턴스 목록 조회는 **ack 이후에만** 일어나야 한다.
  // 옛 구현은 커맨드 전에 기준값을 읽고, 그 뒤 last_seen_at 변화만으로 완료를
  // 판정하려고 목록을 반복 조회했다.
  const firstList = seq.state.callOrder.indexOf('list');
  const firstOutcome = seq.state.callOrder.indexOf('outcome');
  assert.equal(seq.state.callOrder[0], 'command', '먼저 커맨드를 보낸다');
  assert.ok(firstOutcome > 0, 'ack 를 조회한다');
  assert.ok(
    firstList > firstOutcome,
    'last_seen_at 변화가 아니라 ack 를 기다린 뒤에 목록을 읽어야 한다',
  );
  assert.equal(seq.state.listCalls, 1, '성공 ack 이후 정확히 한 번만 다시 읽는다');
  assert.equal(seq.state.polls, 3, 'pending 2회를 완료로 치지 않았다');

  // 매니저가 보고한 ack detail 이 그대로 화면에 노출된다 (티켓의 명시 요구).
  assert.ok(
    view.container.textContent.includes(ACK_DETAIL),
    `토스트에 ack detail 이 보여야 한다 — 실제: ${view.container.textContent}`,
  );
});

test('Agent 다이얼로그: 커맨드 처리 전 무관한 하트비트로는 갱신되지 않고, 같은 command_id 의 ack 이후에만 드롭다운이 바뀐다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());

  const seq = ackSequence({ pendingPolls: 2 });
  stubApi(t, {
    listCredentials: async () => [],
    listClaudeBackendProfiles: async () => ({ profiles: [] }),
    sendAgentManagerCommand: seq.sendAgentManagerCommand,
    getAgentManagerCommandOutcome: seq.getAgentManagerCommandOutcome,
    listAgentManagerInstances: seq.listAgentManagerInstances,
  });

  const view = mountWithToasts(
    t,
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
  await act(async () => {});

  const optionLabels = () =>
    [...view.container.querySelectorAll('option')].map((o) => o.textContent.trim());

  assert.ok(optionLabels().includes('opus'), '갱신 전에는 부팅 시점 목록만 보인다');
  assert.equal(
    optionLabels().includes('haiku-4-5'),
    false,
    '업그레이드로 생긴 새 모델은 아직 안 보이는 것이 이 티켓이 고치는 증상이다',
  );

  const button = findButton(view.container, '모델 목록 새로고침');
  assert.ok(button, '모델 필드 옆에 새로고침 버튼이 있어야 한다');

  // 다이얼로그는 마운트 시점에 인스턴스 목록을 한 번 읽어 관리 매니저를 찾는다.
  // 리프레시가 추가로 읽는지를 봐야 하므로 클릭 직전 값을 기준으로 잡는다.
  const listCallsAtClick = seq.state.listCalls;
  assert.ok(listCallsAtClick >= 1, '마운트 시 인스턴스 목록을 이미 한 번 읽었다');

  await act(async () => {
    click(button);
  });

  // ── ack 전 (pending 2회 = 약 1.6초). 이 동안 무관한 하트비트가 도는 상황이다.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1300));
  });
  assert.equal(seq.state.acked, false, '아직 ack 전이다');
  assert.equal(
    optionLabels().includes('haiku-4-5'),
    false,
    'ack 전에는 드롭다운이 바뀌면 안 된다 — 옛 구현은 여기서 이미 갱신됐다',
  );
  assert.equal(
    seq.state.listCalls,
    listCallsAtClick,
    'ack 전에는 목록을 다시 읽지도 않는다 (옛 구현은 여기서 폴링하며 반복 조회했다)',
  );

  // ── ack 후.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2200));
  });

  assert.equal(seq.state.commands.length, 1);
  assert.equal(seq.state.commands[0].instanceId, INSTANCE_ID);
  assert.deepEqual(seq.state.commands[0].body, { command: 'refresh_available_models' });
  assert.equal(seq.state.acked, true);
  assert.equal(
    seq.state.listCalls,
    listCallsAtClick + 1,
    '성공 ack 이후 정확히 한 번만 다시 읽는다',
  );
  assert.ok(
    optionLabels().includes('haiku-4-5'),
    '성공 ack 이후 재열거된 모델이 매니저 재시작 없이 드롭다운에 나타나야 한다',
  );
  assert.ok(
    view.container.textContent.includes(ACK_DETAIL),
    '이 화면에서도 ack detail 이 그대로 노출돼야 한다',
  );
});
