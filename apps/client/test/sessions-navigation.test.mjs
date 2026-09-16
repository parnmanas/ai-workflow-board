// Agent Session(CLI 직접 세션) 표면의 IA 계약 — 소스 텍스트 단언.
//   - 사이드바에서 Sessions 섹션이 Chat 섹션보다 위에 온다(주 작업 표면).
//   - 세션 라우트(/ws/:wsId/sessions, /sessions/:sessionId)가 등록돼 있다.
//   - chat 모드의 기본 랜딩이 sessions 다.
//   - SSE 컨텍스트가 agent_session_update / agent_session_event 를 구독한다.
//   - Sessions 는 ChatRoom API 를 재사용하지 않는다(별개 표면).
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

test('sidebar puts Sessions above Chat with its own New action and canonical paths', () => {
  const sessionsIndex = sidebar.indexOf('<section aria-labelledby="sidebar-sessions-heading"');
  const chatIndex = sidebar.indexOf('<section aria-labelledby="sidebar-chat-heading"');
  assert.ok(sessionsIndex >= 0, 'Sessions section exists');
  assert.ok(sessionsIndex < chatIndex, 'Sessions precedes Chat');
  assert.match(sidebar, /aria-label="New session"/);
  assert.match(sidebar, /`\$\{workspaceBase\}\/sessions\?new=1`/);
  assert.match(sidebar, /const sessionPath = `\$\{workspaceBase\}\/sessions\/\$\{session\.id\}`/);
  assert.match(sidebar, /hasPermission\('agent_sessions\.use'\)/, 'section is permission-gated');
  assert.match(sidebar, /useAgentSessionsNav\(/);
});

test('routes: /ws/:wsId/sessions and /sessions/:sessionId render SessionsPage; chat mode lands on sessions', () => {
  assert.match(app, /path="sessions" element=\{<SessionsPage \/>\}/);
  assert.match(app, /path="sessions\/:sessionId" element=\{<SessionsPage \/>\}/);
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

test('Sessions is a separate surface: its own API namespace, no chat-room reuse', () => {
  for (const name of ['listAgentSessions', 'createAgentSession', 'promptAgentSession', 'decideAgentSessionPermission', 'cancelAgentSession', 'closeAgentSession', 'deleteAgentSession']) {
    assert.match(api, new RegExp(`${name}:`), `api.${name} exists`);
  }
  assert.match(api, /'\/agent-sessions'/);
  assert.doesNotMatch(page, /chat-rooms|listChatRooms|sendChatRoomMessage|ChatRoomView|RoomDetailPanel/);
  assert.match(page, /SessionTranscript/);
  assert.match(page, /SessionComposer/);
  assert.match(page, /NewSessionModal/);
});
