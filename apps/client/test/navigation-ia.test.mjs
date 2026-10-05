import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [sidebarSource, appSource, appLayoutSource, chatPageSource] = await Promise.all([
  readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/AppLayout.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/chat/ChatPage.tsx', import.meta.url), 'utf8'),
]);

test('sidebar keeps the chat-first category order', () => {
  const labels = ["title: 'Work'", "title: 'Automation'", "title: 'Knowledge'", "title: 'Quality'", "title: 'Settings'"];
  let previousIndex = -1;

  for (const label of labels) {
    const index = sidebarSource.indexOf(label);
    assert.ok(index > previousIndex, `${label} should follow the previous sidebar category`);
    previousIndex = index;
  }

  const chatSectionIndex = sidebarSource.indexOf('<section aria-labelledby="sidebar-chat-heading"');
  const featureSectionsIndex = sidebarSource.indexOf('featureSections.map');
  const operationsIndex = sidebarSource.indexOf('<span id="sidebar-operations">Operations</span>');
  assert.ok(chatSectionIndex >= 0 && chatSectionIndex < featureSectionsIndex);
  assert.ok(featureSectionsIndex < operationsIndex);
});

test('OPERATORS is a menu row at the level of HOSTS, with the registered operators nested under it', () => {
  // 섹션 머리(SESSIONS · CHAT 과 같은 모양)로 두면 그 아래 오는 HOSTS 줄까지 operator 묶음처럼 보였다.
  assert.ok(!sidebarSource.includes('sidebar-operators-heading'), 'OPERATORS is not a section header');
  const operatorsRow = sidebarSource.indexOf('aria-controls="sidebar-operators-list"');
  const operatorsList = sidebarSource.indexOf('id="sidebar-operators-list"');
  const hostsRow = sidebarSource.indexOf("key: 'hosts'");
  assert.ok(operatorsRow > 0 && operatorsRow < operatorsList && operatorsList < hostsRow, 'OPERATORS row, its list, then HOSTS');
  assert.match(sidebarSource.slice(operatorsList, hostsRow), /\}, true\);/, 'each operator renders as a nested row');
  assert.match(sidebarSource, /collapsedGroups\.operators/, 'the list folds like the WORK lists and the fold is saved with them');
});

test('sidebar nav is a single scroll container (no nested chat-room scroll area) with canonical room paths', () => {
  // 이중 스크롤 제거(티켓 0f3a0ec9) — Chat 방 목록은 더 이상 자체 maxHeight/overflowY 를
  // 갖지 않는다. <nav> 하나가 Chat 섹션 + Work/Automation/... 섹션을 함께 스크롤한다.
  assert.doesNotMatch(sidebarSource, /maxHeight:\s*220/);
  assert.match(sidebarSource, /aria-label="Primary navigation"[\s\S]*?overflowY:\s*'auto'/);
  assert.match(sidebarSource, /const roomPath = `\$\{basePath\}\/chat\/\$\{room\.id\}`/);
  assert.match(sidebarSource, /aria-label="New chat"/);
  assert.match(sidebarSource, /`\$\{basePath\}\/chat\?new=1`/);
  assert.match(appSource, /path="chat\/:roomId" element=\{<ChatPage \/>\}/);
  assert.match(chatPageSource, /navigate\(`\/chat\/\$\{roomId\}`/);
});

test('sidebar chat rooms paginate 5-at-a-time with a load-more/collapse toggle', () => {
  // 점진적 표시(티켓 0f3a0ec9) — 기본 5개, "더보기" 클릭마다 10개씩, 활성 방은
  // 강제 포함. 순수 로직 자체는 sidebar-rooms-paging.test.mjs 가 직접 검증한다.
  assert.match(sidebarSource, /displayRooms\.map/);
  assert.match(sidebarSource, /paginateSidebarRooms/);
  assert.match(sidebarSource, /handleToggleRoomsPager/);
  assert.match(sidebarSource, /aria-expanded=\{hiddenRooms\.length === 0\}/);
});

test('the main chat surface does not duplicate the sidebar room list', () => {
  assert.doesNotMatch(chatPageSource, /import ChatRoomListPanel/);
  assert.doesNotMatch(chatPageSource, /<ChatRoomListPanel/);
  assert.match(chatPageSource, /<ChatRoomView/);
});

test('settings remain one click away and own canonical nested routes', () => {
  for (const segment of [
    'ownership',
    'members',
    'credentials',
    'channels',
    'api-keys',
    'claude-profiles',
  ]) {
    assert.match(sidebarSource, new RegExp(`settings/${segment}`));
    assert.match(appSource, new RegExp(`path="settings/${segment}"`));
  }

  assert.match(sidebarSource, /label:\s*'User Administration'/);
  assert.match(sidebarSource, /label:\s*'System Settings'/);

  // Account roles 는 보드와 함께 없어졌다(docs/tickets.md) — 메뉴도 라우트도 없다.
  assert.doesNotMatch(sidebarSource, /settings\/roles/);
  assert.doesNotMatch(appSource, /path="settings\/roles"/);
  assert.doesNotMatch(appSource, /WorkspaceRolesPage/);
});

test('desktop always keeps the primary sidebar visible', () => {
  assert.match(appLayoutSource, /const drawerMode = isMobile;/);
  assert.doesNotMatch(appLayoutSource, /const drawerMode = isMobile \|\| mode === 'chat'/);
});

test('WORK 은 Tickets / Teams / Orchestrations 를 독립 라우트로 갖고 예전 경로는 리다이렉트로 남는다', () => {
  // 티켓 03ca8b5b — Teams 가 Orchestrations 하위에서 WORK 최상위로 승격됐다.
  // 렌더 계약은 sidebar-work-hierarchy.test.mjs 가 실제 마운트로 검증하고,
  // 여기서는 라우트 "등록" 자체(그 테스트가 볼 수 없는 부분)를 고정한다.
  assert.match(appSource, /path="teams" element=\{<OrchestrationTeamsPage \/>\}/);
  assert.match(appSource, /path="missions" element=\{<OrchestrationPage \/>\}/);
  assert.match(appSource, /path="orchestration\/\*" element=\{<LegacyWorkspaceRedirect \/>\}/);
  assert.match(appSource, /path="missions\/:missionId" element=\{<MissionDetailPage \/>\}/);

  // 사이드바에는 단수 'Orchestration' 라벨이 남지 않는다.
  assert.doesNotMatch(sidebarSource, /label: 'Orchestration'/);
});

test('보드가 없어졌다: /tickets · /projects 라우트가 있고 예전 /boards/* 는 Tickets 로 리다이렉트된다', () => {
  // docs/tickets.md — 워크스페이스 티켓 풀 하나 + 저장소는 Projects.
  assert.match(appSource, /path="tickets" element=\{<TicketsPage \/>\}/);
  assert.match(appSource, /path="projects" element=\{<ProjectsPage \/>\}/);
  assert.match(appSource, /path="boards\/\*" element=\{<LegacyBoardsRedirect \/>\}/);
  for (const gone of ['BoardsIndexPage', 'BoardSettingsPage', 'BoardArchivePage', 'BoardFeaturesPage', 'BenchmarkLeaderboardPage', 'prompt-templates']) {
    assert.doesNotMatch(appSource, new RegExp(gone), `${gone} 라우트가 남아 있다`);
  }
  // 사이드바: Knowledge 에 Projects, Prompt Templates 는 없다.
  assert.match(sidebarSource, /key: 'projects', path: `\$\{basePath\}\/projects`/);
  assert.doesNotMatch(sidebarSource, /Prompt Templates/);
  // 워크스페이스를 바꿀 때 섹션이 없으면 기본 랜딩(sessions)으로 간다 — 'boards' 가 아니다.
  assert.doesNotMatch(appLayoutSource, /\/boards/);
});
