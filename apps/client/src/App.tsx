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
import { ViewModeProvider, useViewMode, defaultSectionForMode } from './contexts/ViewModeContext';

// 라우트 단위 코드 스플리팅: 무거운 페이지 컴포넌트를 지연 로드해 초기 번들을
// 작게 유지한다 (티켓 33a8ccc4 — 1.18MB 단일 청크 경고 해소).
const Board = lazy(() => import('./components/Board'));
const AdminPage = lazy(() => import('./components/admin/AdminPage'));
const ChatPage = lazy(() => import('./components/ChatPage'));
const AgentsPage = lazy(() => import('./components/AgentsPage'));
const BoardSettingsPage = lazy(() => import('./components/BoardSettingsPage'));
const BoardArchivePage = lazy(() => import('./components/BoardArchivePage'));
const BoardFeaturesPage = lazy(() => import('./components/BoardFeaturesPage'));
const BenchmarkLeaderboardPage = lazy(() => import('./components/BenchmarkLeaderboardPage'));
const BoardsIndexPage = lazy(() => import('./components/BoardsIndexPage'));
const WorkspaceUsersPage = lazy(() => import('./components/WorkspaceUsersPage'));
const WorkspaceChannelsPage = lazy(() => import('./components/WorkspaceChannelsPage'));
const WorkspaceApiKeysPage = lazy(() => import('./components/WorkspaceApiKeysPage'));
const WorkspaceManagementPage = lazy(() => import('./components/WorkspaceManagementPage'));
const WorkspaceRolesPage = lazy(() => import('./components/WorkspaceRolesPage'));
const WorkspaceSettingsPage = lazy(() => import('./components/WorkspaceSettingsPage'));
const SettingsOverviewPage = lazy(() => import('./components/SettingsOverviewPage'));
const AgentDetailPage = lazy(() => import('./components/AgentDetailPage'));
const ChatFirstHome = lazy(() => import('./components/ChatFirstHome'));
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

// Redirects / to the workspace's mode-aware default section once auth resolves
// (Chat-first → assistant, Advanced → boards). Carries the query string through
// so a bookmarked `/?ticket=<id>` deep-link reaches the shell (에픽 리뷰 MINOR-1).
export function WorkspaceDefaultRedirect() {
  const { currentWorkspaceId } = useAuth();
  const { mode } = useViewMode();
  const { search } = useLocation();
  if (!currentWorkspaceId) return null;
  return <Navigate to={`/ws/${currentWorkspaceId}/${defaultSectionForMode(mode)}${search}`} replace />;
}

// Redirects /ws/:wsId to the mode-aware default section (relative). Preserves the
// query string so `/ws/:wsId?ticket=<id>` keeps the deep-link param (MINOR-1).
export function WorkspaceSectionRedirect() {
  const { mode } = useViewMode();
  const { search } = useLocation();
  return <Navigate to={`${defaultSectionForMode(mode)}${search}`} replace />;
}

function LegacyCatalogRedirect() {
  const { wsId } = useParams<{ wsId: string }>();
  return <Navigate to={`/ws/${wsId}/functions`} replace />;
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
            <Route path="agents" element={<WorkspacedRedirect to="agents" />} />
            <Route path="dashboard" element={<WorkspacedRedirect to="agents" />} />
            <Route path="chat" element={<WorkspacedRedirect to="chat" />} />
            <Route path="board/settings" element={<WorkspacedRedirect to="boards" />} />

            {/* Admin routes — all management pages live here */}
            <Route path="admin/*" element={<AdminPage />} />

            {/* Workspace-scoped routes */}
            <Route path="ws/:wsId">
              <Route index element={<WorkspaceSectionRedirect />} />
              <Route path="assistant" element={<ChatFirstHome />} />
              <Route path="boards" element={<BoardsIndexPage />} />
              <Route path="boards/:boardId" element={<Board />} />
              <Route path="boards/:boardId/features" element={<BoardFeaturesPage />} />
              <Route path="boards/:boardId/settings" element={<BoardSettingsPage />} />
              <Route path="boards/:boardId/archive" element={<BoardArchivePage />} />
              <Route path="boards/:boardId/leaderboard" element={<BenchmarkLeaderboardPage />} />
              <Route path="orchestration" element={<OrchestrationPage />} />
              <Route path="orchestration/teams" element={<OrchestrationTeamsPage />} />
              <Route path="orchestration/missions/:missionId" element={<MissionDetailPage />} />
              <Route path="chat" element={<ChatPage />} />
              <Route path="chat/:roomId" element={<ChatPage />} />
              <Route path="users" element={<Navigate to="settings/members" replace />} />
              <Route path="agents" element={<AgentsPage />} />
              <Route path="agents/:agentId" element={<AgentDetailPage />} />
              <Route path="channels" element={<Navigate to="settings/channels" replace />} />
              <Route path="api-keys" element={<Navigate to="settings/api-keys" replace />} />
              <Route path="catalog" element={<LegacyCatalogRedirect />} />
              <Route path="prompt-templates" element={<WorkspaceManagementPage kind="prompt-templates" />} />
              <Route path="resources" element={<WorkspaceManagementPage kind="resources" />} />
              <Route path="ontology-graph" element={<OntologyGraphPage />} />
              <Route path="actions" element={<WorkspaceManagementPage kind="actions" />} />
              <Route path="functions" element={<WorkspaceManagementPage kind="functions" />} />
              <Route path="credentials" element={<Navigate to="settings/credentials" replace />} />
              <Route path="qa" element={<WorkspaceManagementPage kind="qa" />} />
              <Route path="security" element={<WorkspaceManagementPage kind="security" />} />
              <Route path="schedules" element={<WorkspaceManagementPage kind="schedules" />} />
              <Route path="roles" element={<Navigate to="settings/roles" replace />} />
              <Route path="settings" element={<SettingsOverviewPage />} />
              <Route path="settings/workspace" element={<WorkspaceSettingsPage />} />
              <Route path="settings/members" element={<WorkspaceUsersPage />} />
              <Route path="settings/roles" element={<WorkspaceRolesPage />} />
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
            <ViewModeProvider>
              <AppContent />
            </ViewModeProvider>
          </ConfirmProvider>
        </LoadingProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
