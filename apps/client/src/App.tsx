import React, { useEffect, useRef, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { LoadingProvider } from './contexts/LoadingContext';
import { ConfirmProvider } from './contexts/ConfirmContext';
import LoginPage from './components/LoginPage';
import AppLayout from './components/AppLayout';
import { ChunkLoadErrorBoundary } from './components/common';
import { tokens } from './tokens';

// 라우트 단위 코드 스플리팅: 무거운 페이지 컴포넌트를 지연 로드해 초기 번들을
// 작게 유지한다 (티켓 33a8ccc4 — 1.18MB 단일 청크 경고 해소).
// Tickets — 워크스페이스 전체 티켓 풀(보드 없음, docs/tickets.md). Kanban/List 두 뷰.
const TicketsPage = lazy(() => import('./components/tickets/TicketsPage'));
// Projects — 저장소 + Host 별 메인 클론 폴더(repository Resource 를 대체).
const ProjectsPage = lazy(() => import('./components/projects/ProjectsPage'));
const AdminPage = lazy(() => import('./components/admin/AdminPage'));
const ChatPage = lazy(() => import('./components/ChatPage'));
const WorkspaceUsersPage = lazy(() => import('./components/WorkspaceUsersPage'));
const WorkspaceChannelsPage = lazy(() => import('./components/WorkspaceChannelsPage'));
const WorkspaceApiKeysPage = lazy(() => import('./components/WorkspaceApiKeysPage'));
const WorkspaceManagementPage = lazy(() => import('./components/WorkspaceManagementPage'));
const WorkspaceSettingsPage = lazy(() => import('./components/WorkspaceSettingsPage'));
const SettingsOverviewPage = lazy(() => import('./components/SettingsOverviewPage'));
const ChatFirstHome = lazy(() => import('./components/ChatFirstHome'));
// Agent Session(CLI 직접 세션) — Chat 과 나란한 별개 표면이자 기본 랜딩.
const SessionsPage = lazy(() => import('./components/sessions/SessionsPage'));
const HostsPage = lazy(() => import('./components/HostsPage'));
const TerminalsPage = lazy(() => import('./components/terminals/TerminalsPage'));
// 오케스트레이션 모드 — 칸반 보드와 같은 최상위 작업 표면.
const OrchestrationPage = lazy(() => import('./components/orchestration/OrchestrationPage'));
const OrchestrationTeamsPage = lazy(() => import('./components/orchestration/OrchestrationTeamsPage'));
const MissionDetailPage = lazy(() => import('./components/orchestration/MissionDetailPage'));
// Ontology Graph UI 셸(ticket d22b83b4) — 캔버스 없는 라우트/사이드바/배지.
const OntologyGraphPage = lazy(() => import('./components/ontology/OntologyGraphPage'));

// 지연 로드되는 라우트 청크를 가져오는 동안 보여줄 폴백.
function RouteFallback() {
  return (
    <div style={{
      minHeight: '60vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: tokens.colors.textMuted,
      fontSize: '13px',
    }}>
      Loading...
    </div>
  );
}

// Redirects the user to /ws/:currentWorkspaceId/:to, waiting for auth to resolve.
// Preserves the incoming query string so deep-link params (?ticket=&comment=)
// survive the redirect instead of being dropped on the floor (에픽 리뷰 MINOR-1).
export function WorkspacedRedirect({ to }: { to: string }) {
  const { currentWorkspaceId } = useAuth();
  const { search } = useLocation();
  if (!currentWorkspaceId) return null;
  return <Navigate to={`/ws/${currentWorkspaceId}/${to}${search}`} replace />;
}

// Redirects / to the workspace's default section (sessions — Agent Session 목록이
// 주 작업 표면). Carries the query string through
// so a bookmarked `/?ticket=<id>` deep-link reaches the shell (에픽 리뷰 MINOR-1).
export function WorkspaceDefaultRedirect() {
  const { currentWorkspaceId } = useAuth();
  const { search } = useLocation();
  if (!currentWorkspaceId) return null;
  return <Navigate to={`/ws/${currentWorkspaceId}/sessions${search}`} replace />;
}

// Redirects /ws/:wsId to the default section (sessions). Preserves the
// query string so `/ws/:wsId?ticket=<id>` keeps the deep-link param (MINOR-1).
export function WorkspaceSectionRedirect() {
  const { search } = useLocation();
  return <Navigate to={`sessions${search}`} replace />;
}

// Boards are gone (docs/tickets.md). Every old board URL — the index, a board,
// and its features/settings/archive/leaderboard sub-pages — lands on the
// workspace Tickets page. The query string is kept so a bookmarked or
// notification deep link (`/boards/<id>?ticket=<id>&comment=<id>`) still opens
// the ticket (and scrolls to the comment).
export function LegacyBoardsRedirect() {
  const { wsId } = useParams<{ wsId: string }>();
  const { search } = useLocation();
  return <Navigate to={`/ws/${wsId}/tickets${search}`} replace />;
}

function LegacyCatalogRedirect() {
  const { wsId } = useParams<{ wsId: string }>();
  return <Navigate to={`/ws/${wsId}/functions`} replace />;
}

// Teams 가 WORK 의 독립 최상위 메뉴로 승격되면서 정식 경로가 /ws/:wsId/teams 로
// 옮겨졌다(티켓 03ca8b5b). 예전 /ws/:wsId/orchestration/teams 딥링크(북마크,
// 기존 코멘트 링크)가 깨지지 않도록 절대 경로로 리다이렉트한다.
export function LegacyOrchestrationTeamsRedirect() {
  const { wsId } = useParams<{ wsId: string }>();
  return <Navigate to={`/ws/${wsId}/teams`} replace />;
}

function AppContent() {
  const { isAuthenticated, isLoading, serverUnavailable } = useAuth();
  const { showToast } = useToast();
  const wasAuthenticated = useRef(false);

  // Show toast when auth state transitions from authenticated → not authenticated
  useEffect(() => {
    if (isLoading) return;
    if (wasAuthenticated.current && !isAuthenticated) {
      showToast('Session expired. Please log in again.', 'error');
    }
    wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated, isLoading, showToast]);

  if (isLoading) {
    return (
      <div style={{
        minHeight: '100vh',
        background: tokens.colors.surface,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12,
            background: tokens.gradients.accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '24px', fontWeight: 700, color: 'white',
          }}>W</div>
          <div style={{ color: tokens.colors.textMuted, fontSize: '13px' }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (serverUnavailable) {
    return (
      <div style={{
        minHeight: '100vh',
        background: tokens.colors.surface,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
          maxWidth: 400,
          textAlign: 'center',
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12,
            background: tokens.colors.border,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '24px', fontWeight: 700, color: tokens.colors.textMuted,
          }}>W</div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: tokens.colors.textPrimary }}>
            Server Unavailable
          </div>
          <div style={{ fontSize: '13px', color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
            Unable to connect to the AWB server. Make sure the server is running and try again.
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 8,
              padding: '8px 20px',
              background: tokens.colors.accent,
              color: 'white',
              border: 'none',
              borderRadius: 6,
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <ChunkLoadErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route element={<AppLayout />}>
            {/* Legacy redirects */}
            <Route index element={<WorkspaceDefaultRedirect />} />
            {/* P4c-4: agents 표면 제거 — 세션으로 보낸다. */}
            <Route path="agents" element={<WorkspacedRedirect to="sessions" />} />
            <Route path="dashboard" element={<WorkspacedRedirect to="sessions" />} />
            <Route path="chat" element={<WorkspacedRedirect to="chat" />} />
            <Route path="sessions" element={<WorkspacedRedirect to="sessions" />} />
            <Route path="hosts" element={<WorkspacedRedirect to="hosts" />} />
            <Route path="terminals" element={<WorkspacedRedirect to="terminals" />} />
            <Route path="board/settings" element={<WorkspacedRedirect to="tickets" />} />
            <Route path="boards" element={<WorkspacedRedirect to="tickets" />} />
            <Route path="tickets" element={<WorkspacedRedirect to="tickets" />} />

            {/* Admin routes — all management pages live here */}
            <Route path="admin/*" element={<AdminPage />} />

            {/* Workspace-scoped routes */}
            <Route path="ws/:wsId">
              <Route index element={<WorkspaceSectionRedirect />} />
              <Route path="assistant" element={<ChatFirstHome />} />
              <Route path="hosts" element={<HostsPage />} />
              <Route path="sessions" element={<SessionsPage />} />
              <Route path="sessions/:managerId" element={<SessionsPage />} />
              <Route path="sessions/:managerId/:cli/:sessionId" element={<SessionsPage />} />
              {/* Terminal(Runtime Host 셸) — 세션과 같은 (호스트 → 목록 → 하나) 계층. */}
              <Route path="terminals" element={<TerminalsPage />} />
              <Route path="terminals/:managerId" element={<TerminalsPage />} />
              <Route path="terminals/:managerId/:terminalId" element={<TerminalsPage />} />
              <Route path="tickets" element={<TicketsPage />} />
              <Route path="boards/*" element={<LegacyBoardsRedirect />} />
              <Route path="teams" element={<OrchestrationTeamsPage />} />
              <Route path="orchestration" element={<OrchestrationPage />} />
              <Route path="orchestration/teams" element={<LegacyOrchestrationTeamsRedirect />} />
              <Route path="orchestration/missions/:missionId" element={<MissionDetailPage />} />
              <Route path="chat" element={<ChatPage />} />
              <Route path="chat/:roomId" element={<ChatPage />} />
              <Route path="users" element={<Navigate to="settings/members" replace />} />
              {/* P4c-4: agents 표면 제거 (Agent 테이블 삭제). */}
              <Route path="channels" element={<Navigate to="settings/channels" replace />} />
              <Route path="api-keys" element={<Navigate to="settings/api-keys" replace />} />
              <Route path="catalog" element={<LegacyCatalogRedirect />} />
              <Route path="projects" element={<ProjectsPage />} />
              <Route path="resources" element={<WorkspaceManagementPage kind="resources" />} />
              <Route path="ontology-graph" element={<OntologyGraphPage />} />
              <Route path="actions" element={<WorkspaceManagementPage kind="actions" />} />
              <Route path="functions" element={<WorkspaceManagementPage kind="functions" />} />
              <Route path="credentials" element={<Navigate to="settings/credentials" replace />} />
              <Route path="qa" element={<WorkspaceManagementPage kind="qa" />} />
              <Route path="security" element={<WorkspaceManagementPage kind="security" />} />
              <Route path="schedules" element={<WorkspaceManagementPage kind="schedules" />} />
              <Route path="settings" element={<SettingsOverviewPage />} />
              <Route path="settings/workspace" element={<WorkspaceSettingsPage />} />
              <Route path="settings/members" element={<WorkspaceUsersPage />} />
              <Route path="settings/credentials" element={<WorkspaceManagementPage kind="credentials" />} />
              <Route path="settings/channels" element={<WorkspaceChannelsPage />} />
              <Route path="settings/api-keys" element={<WorkspaceApiKeysPage />} />
              <Route path="settings/claude-profiles" element={<WorkspaceManagementPage kind="claude-backend-profiles" />} />
              <Route path="claude-backend-profiles" element={<Navigate to="settings/claude-profiles" replace />} />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </ChunkLoadErrorBoundary>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <LoadingProvider>
          <ConfirmProvider>
            <AppContent />
          </ConfirmProvider>
        </LoadingProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
