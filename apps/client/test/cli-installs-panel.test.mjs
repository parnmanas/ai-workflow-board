// InstalledCliVersions — Runtime Host 화면의 "설치본 단위" CLI 목록.
//
// 한 호스트에 같은 CLI 가 여러 벌 깔려 있는 것은 정상 구성이다: ragnar 는 vLLM
// 백엔드용으로 claude 를 두 벌 두고 runtime profile 의 `claude_executable` 로
// 고른다. 그래서 행의 단위는 CLI 가 아니라 **설치본(경로)** 이고, Update 는 그
// 경로를 명시해 보낸다 — 눌렀을 때 어느 것이 올라갈지가 미리 정해져 있어야 한다.
//
// 검증하는 계약:
//   1) 설치본마다 한 줄, 각자 경로·설치 방법·버전. Update 는 `args.bin` 을 싣는다.
//   2) 이미 최신인 행만 잠긴다. 최신을 **모르는** 행은 잠기지 않는다.
//   3) 우리가 못 올리는 설치본(snap 등)은 방법만 보여주고 버튼이 없다.
//   4) 구버전 매니저(cli_installs 없음)는 예전처럼 cli_versions 로 접힌다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { React, act, click, mount, setupDom } from './helpers/jsdom.mjs';

const { InstalledCliVersions } = await import('../src/components/admin/AgentManagerPage.tsx');

const BASE = {
  instance_id: 'inst-1',
  agent_id: 'mgr-1',
  workspace_id: 'ws-1',
  mode: 'manager',
  hostname: 'ragnar',
  plugin_version: '1.0.0',
  cli: 'mixed',
  cli_adapters: ['claude', 'codex'],
  pid: 1,
  started_at: '2026-09-20T00:00:00.000Z',
  last_seen_at: '2026-09-24T00:00:00.000Z',
};

const STALE = '/home/parn/.local/bin/claude';
const FRESH = '/home/parn/.nvm/versions/node/v22.23.1/bin/claude';

function render(t, inst, onUpdate = () => {}) {
  const view = mount(
    React.createElement(InstalledCliVersions, { inst, pending: null, onUpdate }),
  );
  t.after(() => view.unmount());
  return view;
}

const buttons = (view) => [...view.container.querySelectorAll('button')];

test('같은 CLI 의 설치본마다 한 줄씩 나오고 Update 는 그 경로를 실어 보낸다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());

  const sent = [];
  const view = render(
    t,
    {
      ...BASE,
      cli_latest_versions: { claude: '2.1.281' },
      cli_installs: [
        {
          cli: 'claude',
          path: STALE,
          version: '2.1.273 (Claude Code)',
          method: 'npm --prefix /home/parn/.local',
          updatable: true,
          active: true,
        },
        {
          cli: 'claude',
          path: FRESH,
          version: '2.1.281 (Claude Code)',
          method: 'npm --prefix /home/parn/.nvm/versions/node/v22.23.1',
          updatable: true,
          active: false,
        },
      ],
    },
    (cli, bin) => sent.push([cli, bin]),
  );
  await act(async () => {});

  const text = view.container.textContent;
  assert.ok(text.includes(STALE), '여러 벌이면 경로를 짚어 준다');
  assert.ok(text.includes(FRESH));
  assert.ok(text.includes('npm --prefix /home/parn/.local'), '설치 방법이 보인다');
  assert.ok(text.includes('활성'), '지정 없이 spawn 되는 설치본이 표시된다');

  const enabled = buttons(view).filter((b) => !b.disabled);
  assert.equal(enabled.length, 1, '구버전 한 줄만 누를 수 있다');
  await act(async () => {
    click(enabled[0]);
  });
  assert.deepEqual(sent, [['claude', STALE]], '경로를 명시해 보낸다');
});

test('이미 최신인 설치본만 잠긴다 — 최신을 모르는 설치본은 잠기지 않는다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());

  const view = render(t, {
    ...BASE,
    // claude 만 최신을 안다. codex 는 조회 실패 → 키 없음 = "모름".
    cli_latest_versions: { claude: '2.1.281' },
    cli_installs: [
      {
        cli: 'claude',
        path: '/x/bin/claude',
        version: '2.1.281 (Claude Code)',
        method: 'npm --prefix /x',
        updatable: true,
        active: true,
      },
      {
        cli: 'codex',
        path: '/x/bin/codex',
        version: 'codex-cli 0.153.4',
        method: 'npm --prefix /x',
        updatable: true,
        active: true,
      },
    ],
  });
  await act(async () => {});

  assert.ok(view.container.textContent.includes('최신'), '최신 표시가 붙는다');
  const [claudeBtn, codexBtn] = buttons(view);
  assert.equal(claudeBtn.disabled, true, '이미 최신이면 잠근다');
  assert.equal(codexBtn.disabled, false, '모른다는 이유로 잠그면 올릴 길이 사라진다');
});

test('우리가 못 올리는 설치본은 방법만 보여주고 버튼이 없다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());

  const view = render(t, {
    ...BASE,
    cli_installs: [
      {
        cli: 'codex',
        path: '/snap/bin/codex',
        version: 'codex-cli 0.114.0',
        method: 'snap package (run: sudo snap refresh codex)',
        updatable: false,
        active: false,
      },
    ],
  });
  await act(async () => {});

  assert.equal(buttons(view).length, 0);
  assert.ok(
    view.container.textContent.includes('sudo snap refresh codex'),
    `직접 칠 명령이 보여야 한다 — 실제: ${view.container.textContent}`,
  );
});

test('구버전 매니저(cli_installs 없음)는 예전처럼 CLI 당 한 줄로 접힌다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());

  const sent = [];
  const view = render(
    t,
    {
      ...BASE,
      cli_versions: { claude: '2.1.273 (Claude Code)', git: '2.43.0' },
      cli_latest_versions: { claude: '2.1.281' },
    },
    (cli, bin) => sent.push([cli, bin]),
  );
  await act(async () => {});

  const text = view.container.textContent;
  assert.ok(text.includes('claude 2.1.273'));
  assert.ok(text.includes('git 2.43.0'), 'git 도 버전은 보인다');
  // 어댑터가 없는 git 에는 버튼이 없다.
  assert.equal(buttons(view).length, 1);
  await act(async () => {
    click(buttons(view)[0]);
  });
  assert.deepEqual(sent, [['claude', undefined]], '경로를 모르면 매니저가 고르게 둔다');
});
