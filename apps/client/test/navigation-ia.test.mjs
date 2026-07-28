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

test('chat rooms use a bounded scroll area and canonical room paths', () => {
  assert.match(sidebarSource, /aria-label="Chat rooms"[\s\S]*maxHeight:\s*220[\s\S]*overflowY:\s*'auto'/);
  assert.match(sidebarSource, /const roomPath = `\$\{workspaceBase\}\/chat\/\$\{room\.id\}`/);
  assert.match(sidebarSource, /aria-label="New chat"/);
  assert.match(sidebarSource, /`\$\{workspaceBase\}\/chat\?new=1`/);
  assert.match(appSource, /path="chat\/:roomId" element=\{<ChatPage \/>\}/);
  assert.match(chatPageSource, /navigate\(`\/ws\/\$\{wsId\}\/chat\/\$\{roomId\}`/);
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
