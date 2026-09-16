// Agent Session(CLI 직접 세션) 표면의 IA 계약 — 소스 텍스트 단언.
//   - 사이드바에서 Sessions 섹션이 Chat 섹션보다 위에 온다(주 작업 표면), 행은 Runtime Host × CLI.
//   - 세션 라우트(/sessions, /sessions/:managerId/:cli, /sessions/:managerId/:cli/:sessionId)가 등록돼 있다.
//   - chat 모드의 기본 랜딩이 sessions 다.
//   - SSE 컨텍스트가 agent_session_update / agent_session_event 를 구독한다.
//   - Sessions 는 ChatRoom API 를 재사용하지 않고, 세션 내용을 AWB 에 저장하는 API 가 없다.
// 실행: node --import tsx --test apps/client/test/sessions-navigation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');
const [sidebar, app, stream, viewMode, api, page] = await Promise.all([
  read('../src/components/Sidebar.tsx'),
  read('../src/App.tsx'),
  read('../src/contexts/BoardStreamContext.tsx'),
  read('../src/contexts/viewMode.ts'),
  read('../src/api.ts'),
  read('../src/components/sessions/SessionsPage.tsx'),
]);

test('sidebar puts Sessions above Chat, with host×CLI rows and its own New action', () => {
  const sessionsIndex = sidebar.indexOf('<section aria-labelledby="sidebar-sessions-heading"');
  const chatIndex = sidebar.indexOf('<section aria-labelledby="sidebar-chat-heading"');
  assert.ok(sessionsIndex >= 0, 'Sessions section exists');
  assert.ok(sessionsIndex < chatIndex, 'Sessions precedes Chat');
  assert.match(sidebar, /aria-label="New session"/);
  assert.match(sidebar, /`\$\{workspaceBase\}\/sessions\?new=1`/);
  assert.match(sidebar, /hostCliEntries\(sessionHosts, workspaceBase, runtimeLabel\)/, 'rows are Runtime Host × CLI');
  assert.match(sidebar, /aria-label="Runtime Hosts"/);
  assert.match(sidebar, /hasPermission\('agent_sessions\.use'\)/, 'section is permission-gated');
  assert.match(sidebar, /useAgentSessionsNav\(/);
});

test('routes: hosts index, host×cli list, and session detail render SessionsPage; chat mode lands on sessions', () => {
  assert.match(app, /path="sessions" element=\{<SessionsPage \/>\}/);
  assert.match(app, /path="sessions\/:managerId\/:cli" element=\{<SessionsPage \/>\}/);
  assert.match(app, /path="sessions\/:managerId\/:cli\/:sessionId" element=\{<SessionsPage \/>\}/);
  assert.match(app, /<Route path="sessions" element=\{<WorkspacedRedirect to="sessions" \/>\} \/>/);
  assert.match(viewMode, /return mode === 'chat' \? 'sessions' : 'boards';/);
  // Chat-first 홈은 사라지지 않는다 — Chat 섹션에서 여전히 도달 가능.
  assert.match(app, /path="assistant" element=\{<ChatFirstHome \/>\}/);
});

test('SSE context subscribes to both agent_session frames', () => {
  assert.match(stream, /addEventListener\('agent_session_update'/);
  assert.match(stream, /addEventListener\('agent_session_event'/);
  assert.match(stream, /\| 'agent_session_update'/);
  assert.match(stream, /\| 'agent_session_event'/);
});

test('Sessions is a separate, storage-free surface keyed by Runtime Host + CLI', () => {
  for (const name of ['listAgentSessionHosts', 'getHostCliSettings', 'setHostCliSettings', 'listHostSessions', 'openHostSession', 'getHostSession', 'promptHostSession', 'decideHostSessionPermission', 'cancelHostSession', 'setHostSessionMode', 'closeHostSession']) {
    assert.match(api, new RegExp(`${name}:`), `api.${name} exists`);
  }
  assert.match(api, /'\/agent-sessions\/hosts'/);
  assert.match(api, /\/agent-sessions\/hosts\/\$\{encodeURIComponent\(managerId\)\}\/\$\{encodeURIComponent\(cli\)\}\/sessions/);
  assert.doesNotMatch(api, /deleteAgentSession|renameAgentSession|listAgentSessionEvents/, 'no AWB-side session storage endpoints remain');
  assert.doesNotMatch(page, /chat-rooms|listChatRooms|sendChatRoomMessage|ChatRoomView|RoomDetailPanel/);
  assert.match(page, /SessionTranscript/);
  assert.match(page, /SessionComposer/);
  assert.match(page, /NewSessionModal/);
  assert.match(page, /getHostSession\(managerId, cli, sessionId\)/, 'detail reads the transcript from the host');
  assert.match(page, /<CliSettingsPanel/, 'host list page exposes CLI settings (credential binding)');
});
