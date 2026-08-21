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
  const featureSectionsIndex = sidebarSource.indexOf('workspaceSections.map');
  const operationsIndex = sidebarSource.indexOf('<span id="sidebar-operations">Operations</span>');
  assert.ok(chatSectionIndex >= 0 && chatSectionIndex < featureSectionsIndex);
  assert.ok(featureSectionsIndex < operationsIndex);
});

test('sidebar nav is a single scroll container (no nested chat-room scroll area) with canonical room paths', () => {
  // 이중 스크롤 제거(티켓 0f3a0ec9) — Chat 방 목록은 더 이상 자체 maxHeight/overflowY 를
  // 갖지 않는다. <nav> 하나가 Chat 섹션 + Work/Automation/... 섹션을 함께 스크롤한다.
  assert.doesNotMatch(sidebarSource, /maxHeight:\s*220/);
  assert.match(sidebarSource, /aria-label="Primary navigation"[\s\S]*?overflowY:\s*'auto'/);
  assert.match(sidebarSource, /const roomPath = `\$\{workspaceBase\}\/chat\/\$\{room\.id\}`/);
  assert.match(sidebarSource, /aria-label="New chat"/);
  assert.match(sidebarSource, /`\$\{workspaceBase\}\/chat\?new=1`/);
  assert.match(appSource, /path="chat\/:roomId" element=\{<ChatPage \/>\}/);
  assert.match(chatPageSource, /navigate\(`\/ws\/\$\{wsId\}\/chat\/\$\{roomId\}`/);
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
    'workspace',
    'members',
    'roles',
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
});

test('desktop always keeps the primary sidebar visible', () => {
  assert.match(appLayoutSource, /const drawerMode = isMobile;/);
  assert.doesNotMatch(appLayoutSource, /const drawerMode = isMobile \|\| mode === 'chat'/);
});
