// 호스트에 설치된 CLI 를 AWB 화면에서 올리는 UI 경로 (`update_cli`).
//
// 실제 컴포넌트를 마운트해 확인 다이얼로그까지 클릭으로 태운다. 검증하는 계약:
//
//   1) Agent 상세의 LIFECYCLE 에 "Update <cli> (현재버전)" 이 뜨고, 클릭하면
//      **그 CLI 를 명시적으로 실어** update_cli 를 보낸다. cli 를 안 실으면
//      매니저는 에이전트 컨텍스트에 기대게 되고, 중지된 에이전트에서는 실패한다.
//   2) 완료 판정은 발급된 command_id 의 ack 로만 한다 — 업데이터는 수십 초가
//      걸리므로 "디스패치됨" 토스트로 끝내면 운영자는 결과를 영영 못 본다.
//      ack detail(`before → after`)이 화면에 그대로 노출된다.
//   3) 실제 CLI 가 아닌 type('custom' / 'manager')에는 버튼이 아예 없다 —
//      올릴 바이너리가 없는데 버튼을 주면 실패 토스트만 낳는다.
//   4) 이미 최신이면 버튼이 잠긴다. 잠그는 근거는 매니저가 보고한
//      `cli_latest_versions` 뿐이고, 그 값이 **없으면 잠그지 않는다** —
//      "최신을 모른다" 를 "최신이다" 로 읽으면 올릴 길이 사라진다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../src/api.ts';
import { React, act, click, mount, setupDom } from './helpers/jsdom.mjs';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { ConfirmProvider } from '../src/contexts/ConfirmContext.tsx';

const { default: AgentLifecycleControls } = await import(
  '../src/components/AgentLifecycleControls.tsx'
);

const INSTANCE_ID = 'inst-cli-update';
const AGENT_ID = 'agent-cli-update';
const COMMAND_ID = 'cmd-cliupdate01';
const ACK_DETAIL = 'update_cli ok: claude 2.0.0 → 2.1.0';

function managerInstance(cliVersions, cliLatestVersions) {
  return {
    instance_id: INSTANCE_ID,
    agent_id: 'mgr-1',
    workspace_id: 'ws-1',
    mode: 'manager',
    hostname: 'cli-update-host',
    plugin_version: '1.0.0',
    cli: 'mixed',
    cli_adapters: ['claude', 'codex'],
    pid: 12,
    started_at: '2026-09-20T00:00:00.000Z',
    last_seen_at: new Date().toISOString(),
    agent_ids: [AGENT_ID],
    ...(cliVersions ? { cli_versions: cliVersions } : {}),
    ...(cliLatestVersions ? { cli_latest_versions: cliLatestVersions } : {}),
  };
}

function stubApi(t, overrides) {
  const originals = {};
  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = api[key];
    api[key] = value;
  }
  t.after(() => Object.assign(api, originals));
}

function buttonWith(container, fragment) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent.includes(fragment),
  );
}

/** ToastProvider 는 알림음을 초기화하므로 jsdom 에 없는 Audio 를 스텁한다. */
function mountControls(t, props) {
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
  const view = mount(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(
        ConfirmProvider,
        null,
        React.createElement(AgentLifecycleControls, props),
      ),
    ),
  );
  t.after(() => {
    view.unmount();
    globalThis.Audio = previousAudio;
  });
  return view;
}

test('Update <cli> 는 그 CLI 를 명시적으로 실어 update_cli 를 보내고, ack 의 before → after 를 화면에 보여준다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());

  const sent = [];
  let polls = 0;
  stubApi(t, {
    sendAgentManagerCommand: async (instanceId, body) => {
      sent.push({ instanceId, body });
      return { ok: true, command_id: COMMAND_ID, issued_at: new Date().toISOString() };
    },
    getAgentManagerCommandOutcome: async (commandId) => {
      assert.equal(commandId, COMMAND_ID, '발급된 command_id 로만 조회해야 한다');
      polls += 1;
      if (polls === 1) return { state: 'pending', command_id: commandId, detail: '', acked_at: null };
      return {
        state: 'ok',
        command_id: commandId,
        detail: ACK_DETAIL,
        acked_at: new Date().toISOString(),
      };
    },
  });

  const view = mountControls(t, {
    agentId: AGENT_ID,
    cli: 'claude',
    managerInstance: managerInstance({ claude: '2.0.0', codex: '0.9.0' }),
    layout: 'full',
  });
  await act(async () => {});

  const button = buttonWith(view.container, 'Update claude');
  assert.ok(button, 'CLI 를 가진 에이전트에는 Update 버튼이 있어야 한다');
  assert.ok(
    button.textContent.includes('2.0.0'),
    `버튼에 현재 버전이 보여야 한다 — 실제: ${button.textContent}`,
  );

  await act(async () => {
    click(button);
  });

  // 확인 다이얼로그를 거쳐야만 나간다 — 장비 전역 영향이라 오클릭 방지.
  assert.equal(sent.length, 0, '확인 전에는 아무것도 보내지 않는다');
  const confirmButton = buttonWith(view.container, '업데이트');
  assert.ok(confirmButton, '확인 다이얼로그가 떠야 한다');
  await act(async () => {
    click(confirmButton);
  });
  // ack 폴링(2초 간격) 2회분을 실제로 기다린다.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 4400));
  });

  assert.equal(sent.length, 1, '확인 한 번에 커맨드 한 건');
  assert.equal(sent[0].instanceId, INSTANCE_ID);
  assert.equal(sent[0].body.command, 'update_cli');
  assert.equal(
    sent[0].body.args.cli,
    'claude',
    'cli 를 명시적으로 실어야 중지된 에이전트에서도 올릴 수 있다',
  );
  assert.ok(polls >= 2, 'pending 한 번을 완료로 치지 않았다');
  assert.ok(
    view.container.textContent.includes('2.0.0 → 2.1.0'),
    `ack detail 이 토스트로 보여야 한다 — 실제: ${view.container.textContent}`,
  );
});

test('실제 CLI 가 아닌 type 에는 Update 버튼이 없다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());
  stubApi(t, {
    sendAgentManagerCommand: async () => {
      throw new Error('보내면 안 된다');
    },
  });

  for (const type of ['custom', 'manager']) {
    const view = mountControls(t, {
      agentId: AGENT_ID,
      cli: type,
      managerInstance: managerInstance({ claude: '2.0.0' }),
      layout: 'full',
    });
    await act(async () => {});
    // `'Update '` 로 찾으면 기존 "Update plugins" 가 걸린다 — CLI 업데이트 버튼만
    // 정확히 겨냥한다(라벨은 `Update <cli>`).
    const cliUpdateButton = [...view.container.querySelectorAll('button')].find((button) =>
      new RegExp(`^Update ${type}\\b`).test(button.textContent.trim()),
    );
    assert.equal(cliUpdateButton ?? null, null, `${type} 에는 Update 버튼이 없어야 한다`);
    // 기존 유지보수 버튼은 그대로 있어야 한다 — 감춘 것이 이 버튼뿐임을 못 박는다.
    assert.ok(buttonWith(view.container, 'Update plugins'), 'update_plugins 는 그대로다');
  }
});

test('이미 최신이면 Update 버튼이 잠기고, 최신을 모르면 잠기지 않는다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());
  stubApi(t, {
    sendAgentManagerCommand: async () => {
      throw new Error('잠긴 버튼에서는 아무것도 나가면 안 된다');
    },
  });

  // 설치 == 최신. 신고된 증상: 올릴 게 없는데도 버튼이 계속 눌렸다.
  const upToDate = mountControls(t, {
    agentId: AGENT_ID,
    cli: 'claude',
    managerInstance: managerInstance(
      { claude: '2.1.281 (Claude Code)' },
      { claude: '2.1.281' },
    ),
    layout: 'full',
  });
  await act(async () => {});
  const lockedButton = [...upToDate.container.querySelectorAll('button')].find((button) =>
    button.textContent.includes('(최신)'),
  );
  assert.ok(lockedButton, `최신 표시가 버튼에 보여야 한다 — 실제: ${upToDate.container.textContent}`);
  assert.equal(lockedButton.disabled, true, '이미 최신이면 눌리지 않는다');
  // 눌러도 확인 다이얼로그조차 뜨지 않는다(disabled 를 우회하는 경로가 없다).
  await act(async () => {
    click(lockedButton);
  });
  assert.equal(buttonWith(upToDate.container, '업데이트') ?? null, null);

  // 최신을 **모르는** 경우(매니저가 npm 조회에 실패했거나 npm 배포가 아닌 CLI).
  const unknownLatest = mountControls(t, {
    agentId: AGENT_ID,
    cli: 'claude',
    managerInstance: managerInstance({ claude: '2.1.281 (Claude Code)' }),
    layout: 'full',
  });
  await act(async () => {});
  const openButton = buttonWith(unknownLatest.container, 'Update claude');
  assert.ok(openButton);
  assert.equal(openButton.disabled, false, '모른다는 이유로 잠그면 올릴 길이 사라진다');

  // 구버전이면 버튼에 목표 버전까지 보인다 — 눌러 보기 전에 뭐가 바뀌는지 안다.
  const outdated = mountControls(t, {
    agentId: AGENT_ID,
    cli: 'claude',
    managerInstance: managerInstance(
      { claude: '2.1.273 (Claude Code)' },
      { claude: '2.1.281' },
    ),
    layout: 'full',
  });
  await act(async () => {});
  const outdatedButton = buttonWith(outdated.container, 'Update claude');
  assert.ok(outdatedButton);
  assert.equal(outdatedButton.disabled, false);
  assert.ok(
    outdatedButton.textContent.includes('→ 2.1.281'),
    `목표 버전이 버튼에 보여야 한다 — 실제: ${outdatedButton.textContent}`,
  );
});
