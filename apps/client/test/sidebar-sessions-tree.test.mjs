// 사이드바 Sessions 트리 실렌더 회귀 테스트 (티켓 7957aedb).
//
// 이 계약은 원래 sessions-navigation.test.mjs 가 Sidebar.tsx 의 *소스 텍스트*를 정규식으로
// 뒤져서 지켰다 — `sidebar.indexOf('group.sessions.map((s)')` 처럼 특정 표현식이 파일에
// 남아 있는지를 봤다. 그래서 렌더 결과가 하나도 달라지지 않은 순수 리팩터에 두 번 깨졌다:
//   · 티켓 b421e5ba — 폴딩 리팩터가 'host×CLI' 행 표현식을 없앰
//   · 티켓 7957aedb — d4b34c2c 가 세션 행을 `displayed.map((s)` 로 바꿈(3일 지난 세션 접기)
// 두 번 다 제품은 멀쩡했고 테스트만 틀렸다. 그래서 계약을 표현식이 아니라 **그려진 트리**로
// 옮긴다: 소스에 어떤 식이 있든, 사용자가 보는 것이 호스트 > working directory > 세션의
// 3단이고 그 링크가 CLI 를 담고 있으면 통과한다. 실렌더 하네스는 프로덕션과 같은 provider
// 스택(Router > Toast > Auth > BoardStream > Notification)이며 sidebar-work-hierarchy.test.mjs
// 와 같은 관례를 쓴다.
//
// 여기서 고정하는 계약:
//   ① Sessions 섹션이 Chat 섹션보다 위에 그려지고, 자체 New session 액션을 갖는다
//   ② 호스트 > cwd > 세션 3단이 실제로 그려지고, CLI 는 트리 레벨이 아니라 세션의 속성이다
//   ③ 접기가 중첩을 증명한다 — 호스트를 접으면 cwd·세션이, cwd 를 접으면 세션만 사라진다
//   ④ 세션 행을 누르면 CLI 를 담은 세션 경로로 이동한다
//   ⑤ agent_sessions.use 권한이 없으면 섹션 자체가 없다
//   ⑥ 3일 넘은 세션은 "+N개 더 보기" 뒤로 접히고 눌러 펴면 드러난다 (d4b34c2c 의 동작)
//   ⑦ 전부 3일을 넘겨도 가장 최근 1개는 항상 보인다
//
// 실행: node --import tsx --test --test-force-exit --test-concurrency=1 test/sidebar-sessions-tree.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, click, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource } from './helpers/boardStream.mjs';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { NotificationProvider } from '../src/contexts/NotificationContext.tsx';
import Sidebar from '../src/components/Sidebar.tsx';

const h = React.createElement;

const WS_ID = 'ws-1';
const BASE = `/ws/${WS_ID}`;
const MANAGER_ID = 'mgr-1';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ago = (ms) => new Date(Date.now() - ms).toISOString();

const HOST = {
  manager_id: MANAGER_ID,
  instance_id: 'inst-1',
  hostname: 'rolf-box',
  name: 'Rolf',
  clis: ['claude', 'codex'],
  plugin_version: '1.0.0',
  last_seen_at: ago(0),
};
// 호스트 행의 title 은 name 과 hostname 이 다를 때 둘을 합쳐 보여준다.
const HOST_ROW_TITLE = `${HOST.name} (${HOST.hostname})`;

const AWB_CWD = '/srv/awb';
const LEGACY_CWD = '/srv/legacy';

function session(overrides) {
  return {
    cli: 'claude',
    session_id: 's-x',
    cwd: AWB_CWD,
    title: '세션',
    created_at: ago(DAY),
    updated_at: ago(DAY),
    source: 'cli',
    ...overrides,
  };
}

// 기본 픽스처. 한 cwd 에 CLI 두 개가 섞여 들어가고(= CLI 는 레벨이 아니다),
// 다른 cwd 에는 최근 1 + 3일 초과 2 가 들어간다(= 더보기 접기 대상).
const DEFAULT_SESSIONS_BY_CLI = {
  claude: [
    session({ session_id: 's-awb-claude', cli: 'claude', cwd: AWB_CWD, title: 'awb 리뷰', updated_at: ago(HOUR) }),
    session({ session_id: 's-legacy-recent', cli: 'claude', cwd: LEGACY_CWD, title: '최근 정리', updated_at: ago(DAY) }),
    session({ session_id: 's-legacy-old1', cli: 'claude', cwd: LEGACY_CWD, title: '묵은 세션 하나', updated_at: ago(5 * DAY) }),
  ],
  codex: [
    session({ session_id: 's-awb-codex', cli: 'codex', cwd: AWB_CWD, title: 'codex 실험', updated_at: ago(2 * HOUR) }),
    session({ session_id: 's-legacy-old2', cli: 'codex', cwd: LEGACY_CWD, title: '묵은 세션 둘', updated_at: ago(9 * DAY) }),
  ],
};

/** URL 로 라우팅하는 fetch 스텁. 세션 목록은 (호스트, CLI) 별 경로로 들어온다. */
function installFetchStub({ hosts, sessionsByCli, permissions }) {
  const previous = globalThis.fetch;
  const json = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  globalThis.fetch = (url) => {
    const path = String(url);
    const sessionList = /\/agent-sessions\/hosts\/([^/]+)\/([^/]+)\/sessions$/.exec(path);
    if (sessionList) return json(sessionsByCli[decodeURIComponent(sessionList[2])] ?? []);
    if (path.endsWith('/agent-sessions/hosts')) return json(hosts);
    if (path.includes('/auth/me')) {
      return json({
        id: 'u1',
        name: 'Tester',
        email: 't@example.com',
        role: 'member',
        status: 'active',
        permissions,
        resolved_permissions: permissions,
        workspaces: [{ id: WS_ID, name: 'Workspace', slug: null, relations: [] }],
      });
    }
    if (path.includes('/orchestration/teams') || path.includes('/orchestration/missions')) return json([]);
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

async function flush(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountSidebar(t, options = {}) {
  const {
    entry = `${BASE}/boards`,
    hosts = [HOST],
    sessionsByCli = DEFAULT_SESSIONS_BY_CLI,
    permissions = ['agent_sessions.use'],
  } = options;

  const dom = setupDom({ width: 1280 });
  // ToastProvider 는 마운트 즉시 알림음 <audio> 를 만든다 — jsdom 에 Audio 가 없어 최소 스텁.
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
  const restoreFetch = installFetchStub({ hosts, sessionsByCli, permissions });
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
                overlay: false,
                isOpen: false,
                onClose: () => {},
                wsId: WS_ID,
                boards: [],
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

  return { view };
}

const sessionsSection = (view) => view.container.querySelector('section[aria-labelledby="sidebar-sessions-heading"]');
const chatSection = (view) => view.container.querySelector('section[aria-labelledby="sidebar-chat-heading"]');
const hostsTree = (view) => view.container.querySelector('div[aria-label="Runtime Hosts"]');

/** 행을 title 툴팁(= 사용자가 보는 것)으로 찾는다. 소스 표현식이 아니라 렌더 결과다. */
const rowByTitle = (root, title) => root.querySelector(`button[title="${title}"]`);

/**
 * "그 행이 있는가" 는 반드시 boolean 으로 단언한다 — jsdom 노드를 assert 의 actual 로 넘기면
 * 실패했을 때 node:assert 가 그 노드를 util.inspect 로 펼치다가(element → document → window →
 * 전역 순환 그래프) 수십 초를 태우고 러너가 SIGKILL 로 죽는다. 회귀가 났을 때 읽을 수 있는
 * 한 줄 실패 대신 타임아웃이 나오면 이 테스트는 제 역할을 못 한다.
 */
const hasRow = (root, title) => Boolean(rowByTitle(root, title));

/** 세션 행 앞에 붙는 CLI 배지(CL/CO). CLI 가 트리 레벨이 아니라 행의 속성임을 보여준다. */
const cliBadgeOf = (row) => row.querySelector('span')?.textContent?.trim() ?? '';

const buttonByText = (root, text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text) || null;

test('① Sessions 섹션이 Chat 섹션보다 위에 그려지고 자체 New session 액션을 갖는다', async (t) => {
  const { view } = await mountSidebar(t);

  const sessions = sessionsSection(view);
  const chat = chatSection(view);
  assert.ok(sessions, 'Sessions 섹션이 그려지지 않았다');
  assert.ok(chat, 'Chat 섹션이 그려지지 않았다');
  assert.ok(
    sessions.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING,
    'Sessions 가 Chat 보다 먼저 와야 한다(주 작업 표면)',
  );

  const newSession = sessions.querySelector('button[aria-label="New session"]');
  assert.ok(newSession, 'Sessions 섹션에 New session 액션이 없다');
  click(newSession);
  assert.equal(probe.pathname, `${BASE}/sessions`);
  assert.equal(probe.search, '?new=1');
});

test('② 호스트 > cwd > 세션 3단이 그려지고, CLI 는 레벨이 아니라 세션의 속성이다', async (t) => {
  const { view } = await mountSidebar(t);
  const tree = hostsTree(view);
  assert.ok(tree, 'Runtime Hosts 트리가 없다');

  const hostRow = rowByTitle(tree, HOST_ROW_TITLE);
  const cwdRow = rowByTitle(tree, AWB_CWD);
  const claudeRow = rowByTitle(tree, 'awb 리뷰');
  const codexRow = rowByTitle(tree, 'codex 실험');
  assert.ok(hostRow, '호스트 행이 없다');
  assert.ok(cwdRow, 'cwd 그룹 행이 없다');
  assert.ok(claudeRow && codexRow, '세션 행이 없다');

  // 문서 순서가 곧 트리 순서다: 호스트 → cwd → 세션.
  assert.ok(hostRow.compareDocumentPosition(cwdRow) & Node.DOCUMENT_POSITION_FOLLOWING, 'cwd 는 호스트 아래에 온다');
  assert.ok(cwdRow.compareDocumentPosition(claudeRow) & Node.DOCUMENT_POSITION_FOLLOWING, '세션은 cwd 아래에 온다');

  // CLI 가 두 개인데 cwd 행은 cwd 당 하나다 — host×CLI 로 갈라지지 않는다.
  const cwdRows = [...tree.querySelectorAll('button[title^="/srv/"]')];
  assert.deepEqual(
    cwdRows.map((b) => b.getAttribute('title')).sort(),
    [AWB_CWD, LEGACY_CWD],
    'cwd 행은 working directory 당 하나여야 한다(CLI 당 하나가 아니다)',
  );
  assert.match(cwdRow.textContent, /2$/, 'cwd 행은 그 그룹의 세션 수를 보여준다');
  assert.equal(cliBadgeOf(claudeRow), 'CL');
  assert.equal(cliBadgeOf(codexRow), 'CO');
});

test('③ 호스트를 접으면 cwd·세션이, cwd 를 접으면 세션만 사라진다', async (t) => {
  const { view } = await mountSidebar(t);
  const tree = () => hostsTree(view);

  click(rowByTitle(tree(), AWB_CWD));
  assert.ok(rowByTitle(tree(), AWB_CWD), 'cwd 를 접어도 cwd 행 자체는 남는다');
  assert.equal(hasRow(tree(), 'awb 리뷰'), false, 'cwd 를 접으면 그 그룹의 세션이 사라진다');
  assert.ok(rowByTitle(tree(), '최근 정리'), '다른 cwd 그룹의 세션은 영향받지 않는다');
  click(rowByTitle(tree(), AWB_CWD));
  assert.ok(rowByTitle(tree(), 'awb 리뷰'), '다시 펴면 세션이 돌아온다');

  const collapseHost = tree().querySelector(`button[aria-label="Collapse ${HOST.name}"]`);
  assert.ok(collapseHost, '호스트 접기 버튼이 없다');
  click(collapseHost);
  assert.ok(rowByTitle(tree(), HOST_ROW_TITLE), '호스트를 접어도 호스트 행은 남는다');
  assert.equal(hasRow(tree(), AWB_CWD), false, '호스트를 접으면 cwd 행이 사라진다');
  assert.equal(hasRow(tree(), 'awb 리뷰'), false, '호스트를 접으면 세션 행도 사라진다');

  click(tree().querySelector(`button[aria-label="Expand ${HOST.name}"]`));
  assert.ok(rowByTitle(tree(), AWB_CWD) && rowByTitle(tree(), 'awb 리뷰'), '호스트를 다시 펴면 트리가 돌아온다');
});

test('④ 세션 행을 누르면 CLI 를 담은 세션 경로로 이동한다', async (t) => {
  const { view } = await mountSidebar(t);

  click(rowByTitle(hostsTree(view), 'codex 실험'));
  assert.equal(probe.pathname, `${BASE}/sessions/${MANAGER_ID}/codex/s-awb-codex`);

  click(rowByTitle(hostsTree(view), 'awb 리뷰'));
  assert.equal(probe.pathname, `${BASE}/sessions/${MANAGER_ID}/claude/s-awb-claude`);
});

test('⑤ agent_sessions.use 권한이 없으면 Sessions 섹션 자체가 없다', async (t) => {
  const { view } = await mountSidebar(t, { permissions: [] });

  assert.equal(Boolean(sessionsSection(view)), false, '권한 없는 사용자에게 Sessions 섹션이 보인다');
  assert.equal(Boolean(hostsTree(view)), false, 'Runtime Hosts 트리가 남아 있다');
  assert.ok(chatSection(view), 'Chat 섹션은 그대로 있어야 한다');
});

test('⑥ 3일 넘은 세션은 더보기 뒤로 접히고, 눌러 펴면 드러난다', async (t) => {
  const { view } = await mountSidebar(t);
  const tree = () => hostsTree(view);

  assert.ok(rowByTitle(tree(), '최근 정리'), '최근 세션은 바로 보인다');
  assert.equal(hasRow(tree(), '묵은 세션 하나'), false, '3일 넘은 세션은 기본 표시에서 빠진다');
  assert.equal(hasRow(tree(), '묵은 세션 둘'), false, '3일 넘은 세션은 기본 표시에서 빠진다');

  const more = buttonByText(tree(), '+2개 더 보기');
  assert.ok(more, '접힌 세션 수를 알려주는 더보기 버튼이 없다');
  click(more);
  assert.ok(rowByTitle(tree(), '묵은 세션 하나') && rowByTitle(tree(), '묵은 세션 둘'), '펴면 묵은 세션이 드러난다');

  const fold = buttonByText(tree(), '접기 ↑');
  assert.ok(fold, '펼친 뒤에는 접기 버튼이 나와야 한다');
  click(fold);
  assert.equal(hasRow(tree(), '묵은 세션 하나'), false, '다시 접으면 묵은 세션이 숨는다');
});

test('⑦ 세션이 전부 3일을 넘겨도 가장 최근 1개는 항상 보인다', async (t) => {
  const { view } = await mountSidebar(t, {
    sessionsByCli: {
      claude: [
        session({ session_id: 's-old-new', cli: 'claude', cwd: AWB_CWD, title: '덜 묵은 세션', updated_at: ago(10 * DAY) }),
        session({ session_id: 's-old-older', cli: 'claude', cwd: AWB_CWD, title: '제일 묵은 세션', updated_at: ago(20 * DAY) }),
      ],
      codex: [],
    },
  });
  const tree = hostsTree(view);

  assert.ok(rowByTitle(tree, '덜 묵은 세션'), '전부 오래돼도 가장 최근 1개는 보인다');
  assert.equal(hasRow(tree, '제일 묵은 세션'), false, '나머지는 더보기 뒤로 접힌다');
  assert.ok(buttonByText(tree, '+1개 더 보기'), '접힌 개수를 알려주는 더보기 버튼이 없다');
});
