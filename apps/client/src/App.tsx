import React, { useEffect, useRef, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { canonicalWorkPath } from './utils/workRoutes';
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
const LibraryPage = lazy(() => import('./components/LibraryPage'));const AdminPage = lazy(() => import('./components/admin/AdminPage'));
const ChatPage = lazy(() => import('./components/ChatPage'));
const AccountUsersPage = lazy(() => import('./components/AccountUsersPage'));
const AccountChannelsPage = lazy(() => import('./components/AccountChannelsPage'));
const AccountApiKeysPage = lazy(() => import('./components/AccountApiKeysPage'));
const AccountManagementPage = lazy(() => import('./components/AccountManagementPage'));
const AccountSettingsPage = lazy(() => import('./components/AccountSettingsPage'));
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

// Old links keep their query and fragment while work uses stable routes.
export function GlobalRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={`/${to}${search}${hash}`} replace />;
}

export function DefaultRedirect() {
  return <GlobalRedirect to="sessions" />;
}

export function LegacyWorkspaceRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${canonicalWorkPath(pathname)}${search}${hash}`} replace />;
}

export function LegacyBoardsRedirect() {
  return <GlobalRedirect to="tickets" />;
}

export function LegacyOrchestrationTeamsRedirect() {
  return <GlobalRedirect to="teams" />;
}

function AppContent() {
  const { isAuthenticated, isLoading, serverUnavailable } = useAuth();
  const { showToast } = useToast();
  const wasAuthenticated = useRef(false);
  const navigate = useNavigate();

  // 네이티브 앱 딥링크(awb://sessions/…?say=…) — 백그라운드 wake 알림 탭이 여기로 온다.
  // 웹에서는 isNativeApp()이 false라 리스너를 달지 않는다.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void (async () => {
      const { isNativeApp, parseAwbDeepLink } = await import('./native/backgroundWake');
      if (!isNativeApp()) return;
      const { App } = await import('@capacitor/app');
      const sub = await App.addListener('appUrlOpen', (event) => {
        const path = parseAwbDeepLink(event.url);
        if (path) navigate(path);
      });
      cleanup = () => {
        void sub.remove().catch(() => undefined);
      };
    })().catch(() => undefined);
    return () => cleanup?.();
  }, [navigate]);

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
            <Route index element={<DefaultRedirect />} />
            <Route path="ws/:wsId/*" element={<LegacyWorkspaceRedirect />} />
            <Route path="agents/*" element={<GlobalRedirect to="sessions" />} />
            <Route path="dashboard" element={<DefaultRedirect />} />
            <Route path="assistant" element={<ChatFirstHome />} />
            <Route path="hosts" element={<HostsPage />} />
            <Route path="sessions" element={<SessionsPage />} />
            <Route path="sessions/:managerId" element={<SessionsPage />} />
            <Route path="sessions/:managerId/:cli/:sessionId" element={<SessionsPage />} />
            <Route path="terminals" element={<TerminalsPage />} />
            <Route path="terminals/:managerId" element={<TerminalsPage />} />
            <Route path="terminals/:managerId/:terminalId" element={<TerminalsPage />} />
            <Route path="tickets" element={<TicketsPage />} />
            <Route path="boards/*" element={<LegacyBoardsRedirect />} />
            <Route path="board/settings" element={<LegacyBoardsRedirect />} />
            <Route path="teams" element={<OrchestrationTeamsPage />} />
            <Route path="missions" element={<OrchestrationPage />} />
            <Route path="missions/:missionId" element={<MissionDetailPage />} />
            <Route path="orchestration/*" element={<LegacyWorkspaceRedirect />} />
            <Route path="chat" element={<ChatPage />} />
            <Route path="chat/:roomId" element={<ChatPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="resources" element={<AccountManagementPage kind="resources" />} />
            <Route path="library" element={<LibraryPage />} />
            <Route path="ontology-graph" element={<OntologyGraphPage />} />
            <Route path="actions" element={<AccountManagementPage kind="actions" />} />
            <Route path="functions" element={<AccountManagementPage kind="functions" />} />
            <Route path="qa" element={<AccountManagementPage kind="qa" />} />
            <Route path="security" element={<AccountManagementPage kind="security" />} />
            <Route path="schedules" element={<AccountManagementPage kind="schedules" />} />
            <Route path="settings" element={<SettingsOverviewPage />} />
            <Route path="settings/ownership" element={<AccountSettingsPage />} />
            <Route path="settings/workspace" element={<GlobalRedirect to="settings/ownership" />} />
            <Route path="settings/members" element={<AccountUsersPage />} />
            <Route path="settings/credentials" element={<AccountManagementPage kind="credentials" />} />
            <Route path="settings/channels" element={<AccountChannelsPage />} />
            <Route path="settings/api-keys" element={<AccountApiKeysPage />} />
            <Route path="settings/claude-profiles" element={<AccountManagementPage kind="claude-backend-profiles" />} />
            <Route path="users" element={<GlobalRedirect to="settings/members" />} />
            <Route path="channels" element={<GlobalRedirect to="settings/channels" />} />
            <Route path="api-keys" element={<GlobalRedirect to="settings/api-keys" />} />
            <Route path="credentials" element={<GlobalRedirect to="settings/credentials" />} />
            <Route path="catalog" element={<GlobalRedirect to="functions" />} />
            <Route path="claude-backend-profiles" element={<GlobalRedirect to="settings/claude-profiles" />} />
            <Route path="admin/*" element={<AdminPage />} />
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
