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
          needs_sudo: false,
          active: true,
        },
        {
          cli: 'claude',
          path: FRESH,
          version: '2.1.281 (Claude Code)',
          method: 'npm --prefix /home/parn/.nvm/versions/node/v22.23.1',
          updatable: true,
          needs_sudo: false,
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
        needs_sudo: false,
        active: true,
      },
      {
        cli: 'codex',
        path: '/x/bin/codex',
        version: 'codex-cli 0.153.4',
        method: 'npm --prefix /x',
        updatable: true,
        needs_sudo: false,
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
        needs_sudo: true,
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

test('root 소유 설치본은 sudo 가 필요하다고 표시하고, Update 는 그 사실을 호출자에게 넘긴다', async (t) => {
  // 비밀번호를 묻는 결정은 이 패널이 하지 않는다 — 매니저가 보고한 needs_sudo 를
  // 그대로 위로 올려서, 필요 없는 설치본에 대고 비밀번호를 묻는 일이 없게 한다.
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
          path: '/usr/local/bin/claude',
          version: '2.1.92 (Claude Code)',
          method: 'npm --prefix /usr/local (needs sudo)',
          updatable: true,
          needs_sudo: true,
          active: false,
        },
        {
          cli: 'claude',
          path: '/home/parn/.npm-global/bin/claude',
          version: '2.1.273 (Claude Code)',
          method: 'npm --prefix /home/parn/.npm-global',
          updatable: true,
          needs_sudo: false,
          active: true,
        },
      ],
    },
    (cli, bin, needsSudo) => sent.push([cli, bin, needsSudo]),
  );
  await act(async () => {});

  assert.ok(view.container.textContent.includes('sudo'), 'root 소유임을 행에서 알 수 있어야 한다');

  const enabled = buttons(view).filter((b) => !b.disabled);
  assert.equal(enabled.length, 2, '둘 다 구버전이라 둘 다 누를 수 있다');
  for (const b of enabled) {
    await act(async () => {
      click(b);
    });
  }
  const bySudo = Object.fromEntries(sent.map(([, bin, needsSudo]) => [bin, needsSudo]));
  assert.equal(bySudo['/usr/local/bin/claude'], true, 'root 소유 설치본만 비밀번호를 묻게 한다');
  assert.equal(bySudo['/home/parn/.npm-global/bin/claude'], false);
});

test('다른 배포 채널의 설치본은 CLI 단위 npm latest 로 판정하지 않는다 (snap)', async (t) => {
  // rolf 실측: snap codex 는 제3자 패키지라 채널 최신이 0.114.0 이다. CLI 단위
  // npm latest(0.156.1)를 그 행에 들이대면 영원히 "→ 0.156.1" 이 뜨고 버튼이
  // 잠기지 않는다. 최신은 CLI 가 아니라 설치본에 속한다.
  const dom = setupDom();
  t.after(() => dom.cleanup());

  const view = render(t, {
    ...BASE,
    cli_latest_versions: { codex: '0.156.1' },
    cli_installs: [
      {
        cli: 'codex',
        path: '/snap/bin/codex',
        version: 'codex-cli 0.114.0',
        method: 'snap package (needs sudo)',
        updatable: true,
        needs_sudo: true,
        // 매니저가 "이 채널의 최신은 모른다" 고 명시한다.
        latest_version: null,
        active: false,
      },
      {
        cli: 'codex',
        path: '/home/parn/.npm-global/bin/codex',
        version: 'codex-cli 0.156.1',
        method: 'npm --prefix /home/parn/.npm-global',
        updatable: true,
        needs_sudo: false,
        latest_version: '0.156.1',
        active: true,
      },
    ],
  });
  await act(async () => {});

  const text = view.container.textContent;
  assert.equal(
    text.includes('→ 0.156.1'),
    false,
    `snap 행에 다른 채널의 목표 버전이 뜨면 안 된다 — 실제: ${text}`,
  );
  assert.ok(text.includes('최신'), 'npm 설치본은 최신으로 잠긴다');

  const enabled = buttons(view).filter((b) => !b.disabled);
  assert.equal(enabled.length, 1, '최신을 모르는 snap 행만 누를 수 있다');
});

test('같은 호스트에 더 새 설치본이 있으면 "최신" 이라고 쓰지 않는다', async (t) => {
  // rolf 실측: 죽은 채널의 snap codex(0.114.0)는 자기 채널로는 최신이다. 하지만
  // 바로 옆 줄에 공식 npm 0.156.1 이 있는데 "최신" 이라고 쓰면 말이 안 된다 —
  // 무엇 기준인지, 더 새 것이 어디 있는지를 함께 말해야 한다.
  const dom = setupDom();
  t.after(() => dom.cleanup());

  const view = render(t, {
    ...BASE,
    cli_installs: [
      {
        cli: 'codex',
        path: '/snap/bin/codex',
        version: 'codex-cli 0.114.0',
        method: 'snap package (needs sudo)',
        updatable: true,
        needs_sudo: true,
        latest_version: '0.114.0', // 추적 채널의 최신 = 설치 버전
        active: false,
      },
      {
        cli: 'codex',
        path: '/home/parn/.npm-global/bin/codex',
        version: 'codex-cli 0.156.1',
        method: 'npm --prefix /home/parn/.npm-global',
        updatable: true,
        needs_sudo: false,
        latest_version: '0.156.1',
        active: true,
      },
    ],
  });
  await act(async () => {});

  const text = view.container.textContent;
  assert.ok(text.includes('뒤처짐'), `더 새 설치본이 있음을 드러내야 한다 — 실제: ${text}`);

  // 두 행 모두 자기 채널로는 최신이라 누를 것이 없다.
  assert.equal(buttons(view).filter((b) => !b.disabled).length, 0);

  // 뒤처진 행의 설명에 더 새 설치본의 경로·버전이 들어 있어야 운영자가 다음 행동을
  // 정할 수 있다.
  const titles = [...view.container.querySelectorAll('[title]')].map((el) => el.getAttribute('title'));
  const hint = titles.find((t) => t && t.includes('더 새롭습니다'));
  assert.ok(hint, `더 새 설치본을 짚어 줘야 한다 — 실제 title 들: ${JSON.stringify(titles)}`);
  assert.ok(hint.includes('/home/parn/.npm-global/bin/codex'), hint);
  assert.ok(hint.includes('0.156.1'), hint);
  assert.ok(hint.includes('AWB 는 그쪽을 실행합니다'), `활성 설치본이라는 사실도 알려야 한다 — ${hint}`);
});

test('더 새 설치본이 없으면 그냥 최신이다 — 경고가 번지지 않는다', async (t) => {
  const dom = setupDom();
  t.after(() => dom.cleanup());
  const view = render(t, {
    ...BASE,
    cli_installs: [
      {
        cli: 'claude',
        path: '/home/parn/.npm-global/bin/claude',
        version: '2.1.281 (Claude Code)',
        method: 'npm --prefix /home/parn/.npm-global',
        updatable: true,
        needs_sudo: false,
        latest_version: '2.1.281',
        active: true,
      },
    ],
  });
  await act(async () => {});
  const text = view.container.textContent;
  assert.ok(text.includes('최신'));
  assert.equal(text.includes('뒤처짐'), false);
});
