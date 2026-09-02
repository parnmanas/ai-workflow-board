// 사이드바 WORK 계층 실렌더 회귀 테스트 (티켓 03ca8b5b).
//
// 소스 정규식이나 모델 단위 테스트(work-navigation.test.mjs)만으로는 "실제로 그려지고
// 클릭하면 이동하는가"를 고정하지 못한다 — 목록은 훅이 fetch 로 가져오고, 접기/펼치기와
// active 표시는 렌더 시점에 결정되기 때문이다. 그래서 진짜 Sidebar 를 프로덕션과 같은
// provider 스택(Router > Toast > Auth > BoardStream > Notification) 위에 마운트한다.
//
// 여기서 고정하는 계약:
//   1. WORK 에 Teams / Orchestrations / Boards 가 그 순서로, 단수 'Orchestration' 없이 보인다
//   2. 각 메뉴 아래 실제 팀/미션/보드가 서브메뉴로 뜨고, 클릭하면 기존 상세 경로로 이동한다
//   3. Teams 화면에서 Orchestrations 가 같이 active 로 보이지 않는다
//   4. 접기/펼치기가 세 메뉴 모두에서 같게 동작한다
//   5. 목록이 비면 메뉴별 empty state 가 뜬다
//   6. 이름이 길면 잘려도 title 툴팁으로 전체 이름을 볼 수 있다
//   7. 축소(드로어/overlay) 사이드바에서도 같은 탐색이 가능하고 이동 후 드로어가 닫힌다
//   8. 페이지가 쏘는 목록 변경 이벤트로 서브메뉴가 갱신된다
//   9. 접어둔 그룹이라도 그 영역으로 이동해 오면 다시 펴진다
//  10. 예전 /orchestration/teams 딥링크가 새 /teams 로 리다이렉트된다(딥링크 보존)
//
// 실행: node --import tsx --test --test-force-exit test/sidebar-work-hierarchy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, click, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource } from './helpers/boardStream.mjs';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { NotificationProvider } from '../src/contexts/NotificationContext.tsx';
import Sidebar from '../src/components/Sidebar.tsx';
import { MISSIONS_CHANGED_EVENT, TEAMS_CHANGED_EVENT } from '../src/components/workNavigation.ts';
import { LegacyOrchestrationTeamsRedirect } from '../src/App.tsx';

const h = React.createElement;

const WS_ID = 'ws-1';
const BASE = `/ws/${WS_ID}`;

const DEFAULT_TEAMS = [
  { id: 't1', name: 'Platform squad' },
  { id: 't2', name: 'Ops squad' },
];
const DEFAULT_MISSIONS = [
  { id: 'm1', title: 'Ship the nav' },
  { id: 'm2', title: 'Backfill telemetry' },
];
const DEFAULT_BOARDS = [
  { id: 'b1', name: 'AWB' },
  { id: 'b2', name: 'Dashboard' },
];

function team(overrides) {
  return {
    workspace_id: WS_ID,
    is_global: false,
    owner_workspace_id: WS_ID,
    allowed_workspace_ids: [],
    description: '',
    orchestrator_agent_id: 'agent-1',
    orchestrator_name: 'Orchestrator',
    orchestrator_online: true,
    orchestrator_prompt: '',
    max_parallel_steps: 3,
    max_open_missions: 1,
    enabled: true,
    members: [],
    active_mission_count: 0,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

function mission(overrides) {
  return {
    workspace_id: WS_ID,
    team_id: 't1',
    team_name: 'Platform squad',
    status: 'running',
    orchestrator_agent_id: 'agent-1',
    orchestrator_name: 'Orchestrator',
    plan_version: 1,
    counts: { total: 0, done: 0, failed: 0, inFlight: 0, pending: 0 },
    started_at: null,
    finished_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

/** URL 로 라우팅하는 fetch 스텁. 목록 응답은 호출 시점의 state 를 읽어 갱신을 재현한다. */
function installFetchStub(state) {
  const previous = globalThis.fetch;
  const json = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  globalThis.fetch = (url) => {
    const path = String(url);
    if (path.includes('/orchestration/teams')) return json(state.teams.map((t) => team(t)));
    if (path.includes('/orchestration/missions')) return json(state.missions.map((m) => mission(m)));
    if (path.includes('/auth/me')) {
      return json({
        id: 'u1',
        name: 'Tester',
        email: 't@example.com',
        role: 'member',
        status: 'active',
        permissions: [],
        workspaces: [{ id: WS_ID, name: 'Workspace', slug: null, relations: [] }],
      });
    }
    if (path.includes('/tickets/unread-counts')) {
      return json({ total: 0, perTicket: {}, perBoard: {}, ticketBoard: {} });
    }
    if (path.includes('/chat/unread-counts')) return json({ total: 0, perRoom: {} });
    if (path.includes('/mentions/unread')) return json({ count: 0, items: [] });
    return json({ count: 0, items: [] });
  };
  return () => {
    globalThis.fetch = previous;
  };
}

const probe = { pathname: null, search: null };

function LocationProbe() {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.search = location.search;
  return null;
}

async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountSidebar(t, options = {}) {
  const {
    entry = `${BASE}/boards`,
    teams = DEFAULT_TEAMS,
    missions = DEFAULT_MISSIONS,
    boards = DEFAULT_BOARDS,
    overlay = false,
  } = options;

  const dom = setupDom({ width: overlay ? 600 : 1280 });
  // ToastProvider 는 마운트 즉시 알림음 <audio> 를 만든다 — jsdom 에는 Audio 가
  // 없으므로 최소 스텁을 심는다(사이드바 계약과 무관한 부수 의존).
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
  const { uninstall } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');
  const state = { teams, missions };
  const restoreFetch = installFetchStub(state);
  const closed = { count: 0 };
  probe.pathname = null;
  probe.search = null;

  const view = mount(
    h(
      MemoryRouter,
      { initialEntries: [entry] },
      h(
        ToastProvider,
        null,
        h(
          AuthProvider,
          null,
          h(
            BoardStreamProvider,
            null,
            h(
              NotificationProvider,
              null,
              h(LocationProbe),
              h(Sidebar, {
                overlay,
                isOpen: overlay,
                onClose: () => {
                  closed.count += 1;
                },
                wsId: WS_ID,
                boards,
                rooms: [],
                roomsLoading: false,
              }),
            ),
          ),
        ),
      ),
    ),
  );

  await flush();

  t.after(() => {
    view.unmount();
    restoreFetch();
    uninstall();
    globalThis.Audio = previousAudio;
    dom.cleanup();
  });

  return { view, state, closed };
}

/** WORK 섹션(<section aria-labelledby="sidebar-work">) 안의 요소만 본다. */
function workSection(view) {
  const section = view.container.querySelector('section[aria-labelledby="sidebar-work"]');
  assert.ok(section, 'WORK 섹션이 렌더되지 않았다');
  return section;
}

function buttonsIn(root) {
  return [...root.querySelectorAll('button')];
}

/**
 * 버튼의 사람이 읽는 라벨. 아이콘 span 은 aria-hidden 이라 스크린리더가 읽지 않으므로
 * 여기서도 제외한다(제외하지 않으면 'TPlatform squad' 처럼 아이콘이 섞인다).
 */
function labelOf(button) {
  const span = [...button.querySelectorAll('span')].find((s) => s.getAttribute('aria-hidden') !== 'true');
  return (span ? span.textContent : button.textContent).trim();
}

function findByText(root, text) {
  return buttonsIn(root).find((b) => labelOf(b) === text) || null;
}

function groupRow(view, label) {
  const button = findByText(workSection(view), label);
  assert.ok(button, `WORK 에 '${label}' 메뉴가 없다`);
  return button;
}

function subList(view, label) {
  const list = workSection(view).querySelector(`div[aria-label="${label} list"]`);
  return list;
}

function subItemLabels(view, label) {
  const list = subList(view, label);
  if (!list) return null;
  return buttonsIn(list)
    .map(labelOf)
    .filter((text) => !text.startsWith('더보기') && text !== '접기');
}

test('① WORK 에 Teams / Orchestrations / Boards 가 그 순서로 보이고 단수 표기가 없다', async (t) => {
  const { view } = await mountSidebar(t);
  const section = workSection(view);
  const labels = buttonsIn(section)
    .map(labelOf)
    .filter((text) => ['Teams', 'Orchestrations', 'Boards', 'Orchestration'].includes(text));

  assert.deepEqual(labels, ['Teams', 'Orchestrations', 'Boards']);
  assert.ok(!section.textContent.includes('Orchestration '), '단수 Orchestration 표기가 남아 있다');
  assert.doesNotMatch(section.textContent, /Orchestration(?!s)/);
});

test('② 각 메뉴 아래 실제 팀/미션/보드가 서브메뉴로 뜬다', async (t) => {
  const { view } = await mountSidebar(t);

  assert.deepEqual(subItemLabels(view, 'Teams'), ['Platform squad', 'Ops squad']);
  assert.deepEqual(subItemLabels(view, 'Orchestrations'), ['Ship the nav', 'Backfill telemetry']);
  assert.deepEqual(subItemLabels(view, 'Boards'), ['AWB', 'Dashboard']);
});

test('③ 서브 항목을 누르면 기존 상세 화면 경로로 이동한다', async (t) => {
  const { view } = await mountSidebar(t);

  click(findByText(subList(view, 'Orchestrations'), 'Ship the nav'));
  assert.equal(probe.pathname, `${BASE}/orchestration/missions/m1`);

  click(findByText(subList(view, 'Boards'), 'Dashboard'));
  assert.equal(probe.pathname, `${BASE}/boards/b2`);

  click(findByText(subList(view, 'Teams'), 'Ops squad'));
  assert.equal(probe.pathname, `${BASE}/teams`);
  assert.equal(probe.search, '?team=t2');
});

test('④ 최상위 메뉴를 누르면 각자의 목록 화면으로 이동한다', async (t) => {
  const { view } = await mountSidebar(t);

  click(groupRow(view, 'Teams'));
  assert.equal(probe.pathname, `${BASE}/teams`);

  click(groupRow(view, 'Orchestrations'));
  assert.equal(probe.pathname, `${BASE}/orchestration`);

  click(groupRow(view, 'Boards'));
  assert.equal(probe.pathname, `${BASE}/boards`);
});

test('⑤ Teams 화면에서 Orchestrations 가 같이 active 로 보이지 않는다', async (t) => {
  const { view } = await mountSidebar(t, { entry: `${BASE}/teams?team=t1` });

  assert.equal(groupRow(view, 'Teams').getAttribute('aria-current'), 'page');
  assert.equal(groupRow(view, 'Orchestrations').getAttribute('aria-current'), null);
  assert.equal(groupRow(view, 'Boards').getAttribute('aria-current'), null);

  // 선택된 팀 서브 항목만 active.
  const teamButtons = buttonsIn(subList(view, 'Teams'));
  assert.deepEqual(
    teamButtons.map((b) => [labelOf(b), b.getAttribute('aria-current')]),
    [
      ['Platform squad', 'page'],
      ['Ops squad', null],
    ],
  );
});

test('⑥ 미션 상세 딥링크에서 Orchestrations 와 해당 미션만 active 다', async (t) => {
  const { view } = await mountSidebar(t, { entry: `${BASE}/orchestration/missions/m2` });

  assert.equal(groupRow(view, 'Orchestrations').getAttribute('aria-current'), 'page');
  assert.equal(groupRow(view, 'Teams').getAttribute('aria-current'), null);
  assert.deepEqual(
    buttonsIn(subList(view, 'Orchestrations')).map((b) => b.getAttribute('aria-current')),
    [null, 'page'],
  );
});

test('⑦ 접기/펼치기가 세 메뉴 모두에서 같게 동작한다', async (t) => {
  const { view } = await mountSidebar(t);

  for (const label of ['Teams', 'Orchestrations', 'Boards']) {
    const toggle = workSection(view).querySelector(`button[aria-label="Collapse ${label} list"]`);
    assert.ok(toggle, `${label} 에 접기 토글이 없다`);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(subList(view, label), `${label} 서브메뉴가 처음부터 접혀 있다`);

    click(toggle);
    assert.equal(subList(view, label), null, `${label} 서브메뉴가 접히지 않았다`);

    const expand = workSection(view).querySelector(`button[aria-label="Expand ${label} list"]`);
    assert.ok(expand, `${label} 에 펼치기 토글이 없다`);
    assert.equal(expand.getAttribute('aria-expanded'), 'false');

    click(expand);
    assert.ok(subList(view, label), `${label} 서브메뉴가 다시 펼쳐지지 않았다`);
  }
});

test('⑧ 목록이 비면 메뉴별 empty state 가 뜬다', async (t) => {
  const { view } = await mountSidebar(t, { teams: [], missions: [], boards: [] });

  assert.match(subList(view, 'Teams').textContent, /No teams yet/);
  assert.match(subList(view, 'Orchestrations').textContent, /No missions yet/);
  assert.match(subList(view, 'Boards').textContent, /No boards yet/);
});

test('⑨ 이름이 길어도 전체 이름을 title 툴팁으로 볼 수 있다', async (t) => {
  const longName = 'Extremely long orchestration mission title that will certainly be truncated';
  const { view } = await mountSidebar(t, { missions: [{ id: 'm9', title: longName }] });

  const item = buttonsIn(subList(view, 'Orchestrations'))[0];
  assert.equal(item.getAttribute('title'), longName);
  // 잘림 처리 자체도 유지돼야 한다 — 라벨 span 이 ellipsis 를 갖는다.
  const labelSpan = [...item.querySelectorAll('span')].find((sp) => sp.textContent.trim() === longName);
  assert.ok(labelSpan, '라벨 span 을 찾지 못했다');
  assert.equal(labelSpan.style.textOverflow, 'ellipsis');
  assert.equal(labelSpan.style.whiteSpace, 'nowrap');
});

test('⑩ 목록이 길면 더보기/접기로 점진 노출한다', async (t) => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, title: `Mission ${i}` }));
  const { view } = await mountSidebar(t, { missions: many });

  assert.equal(subItemLabels(view, 'Orchestrations').length, 5);
  const more = findByText(subList(view, 'Orchestrations'), '더보기 (4)');
  assert.ok(more, '더보기 버튼이 없다');

  click(more);
  assert.equal(subItemLabels(view, 'Orchestrations').length, 9);
  assert.ok(findByText(subList(view, 'Orchestrations'), '접기'), '접기 버튼이 없다');
});

test('⑪ 축소(드로어) 사이드바에서도 같은 탐색이 되고 이동 후 드로어가 닫힌다', async (t) => {
  const { view, closed } = await mountSidebar(t, { overlay: true });

  assert.deepEqual(subItemLabels(view, 'Teams'), ['Platform squad', 'Ops squad']);

  click(findByText(subList(view, 'Teams'), 'Platform squad'));
  assert.equal(probe.pathname, `${BASE}/teams`);
  assert.equal(probe.search, '?team=t1');
  assert.equal(closed.count, 1, '드로어에서 이동했는데 onClose 가 호출되지 않았다');

  click(groupRow(view, 'Orchestrations'));
  assert.equal(probe.pathname, `${BASE}/orchestration`);
  assert.equal(closed.count, 2);
});

test('⑫ 페이지가 쏘는 목록 변경 이벤트로 서브메뉴가 갱신된다', async (t) => {
  const { view, state } = await mountSidebar(t);

  state.teams = [...DEFAULT_TEAMS, { id: 't3', name: 'New squad' }];
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent(TEAMS_CHANGED_EVENT));
  });
  await flush();
  assert.deepEqual(subItemLabels(view, 'Teams'), ['Platform squad', 'Ops squad', 'New squad']);

  state.missions = [...DEFAULT_MISSIONS, { id: 'm3', title: 'Fresh mission' }];
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent(MISSIONS_CHANGED_EVENT));
  });
  await flush();
  assert.deepEqual(subItemLabels(view, 'Orchestrations'), [
    'Ship the nav',
    'Backfill telemetry',
    'Fresh mission',
  ]);
});

test('⑬ 접어둔 그룹이라도 그 영역으로 이동하면 다시 펴져 현재 위치가 보인다', async (t) => {
  const { view } = await mountSidebar(t);

  // Orchestrations 를 접어 둔다.
  click(workSection(view).querySelector('button[aria-label="Collapse Orchestrations list"]'));
  assert.equal(subList(view, 'Orchestrations'), null);

  // 그 상태에서 미션 상세로 이동하면 접힘이 풀려 활성 항목이 드러나야 한다.
  click(findByText(subList(view, 'Boards'), 'AWB'));
  assert.equal(probe.pathname, `${BASE}/boards/b1`);
  click(groupRow(view, 'Orchestrations'));
  assert.equal(probe.pathname, `${BASE}/orchestration`);

  const reopened = subList(view, 'Orchestrations');
  assert.ok(reopened, '이동해 왔는데도 Orchestrations 가 접힌 채로 남았다');
  assert.deepEqual(subItemLabels(view, 'Orchestrations'), ['Ship the nav', 'Backfill telemetry']);

  // 다른 그룹의 사용자 접힘은 그대로 유지된다.
  click(workSection(view).querySelector('button[aria-label="Collapse Teams list"]'));
  assert.equal(subList(view, 'Teams'), null);
  click(groupRow(view, 'Boards'));
  assert.equal(subList(view, 'Teams'), null, 'Teams 접힘이 임의로 풀렸다');
});

test('⑭ 예전 /orchestration/teams 딥링크는 새 /teams 로 리다이렉트된다', () => {
  // Teams 를 WORK 최상위로 승격하면서 정식 경로가 바뀌었다 — 북마크나 기존
  // 코멘트에 남은 예전 링크가 죽지 않아야 한다(App.tsx 에 등록된 실제 컴포넌트).
  const dom = setupDom({ width: 1280 });
  probe.pathname = null;
  try {
    const view = mount(
      h(
        MemoryRouter,
        { initialEntries: ['/ws/ws-1/orchestration/teams'] },
        h(
          Routes,
          null,
          h(Route, {
            path: '/ws/:wsId/orchestration/teams',
            element: h(LegacyOrchestrationTeamsRedirect),
          }),
          h(Route, { path: '/ws/:wsId/teams', element: h(LocationProbe) }),
        ),
      ),
    );
    assert.equal(probe.pathname, '/ws/ws-1/teams');
    view.unmount();
  } finally {
    dom.cleanup();
  }
});
