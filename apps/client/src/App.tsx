import { t as translate } from './i18n/core';
import { useLocale } from './i18n/react';
import React, { useEffect, useRef, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { canonicalWorkPath } from './utils/workRoutes';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { LoadingProvider } from './contexts/LoadingContext';
import { ConfirmProvider } from './contexts/ConfirmContext';
import LoginPage from './components/LoginPage';
import AppLayout from './components/AppLayout';
import { ChunkLoadErrorBoundary } from './components/common';
import { tokens } from './tokens';
import ServerConfigField from './components/ServerConfigField';

// 라우트 단위 코드 스플리팅: 무거운 페이지 컴포넌트를 지연 로드해 초기 번들을
// 작게 유지한다 (티켓 33a8ccc4 — 1.18MB 단일 청크 경고 해소).
// Tickets — 접근 가능한 계정을 합친 티켓 풀(보드 없음, docs/tickets.md). Kanban/List 두 뷰.
const TicketsPage = lazy(() => import('./components/tickets/TicketsPage'));
// Projects — 저장소 + Host 별 메인 클론 폴더(repository Resource 를 대체).
const ProjectsPage = lazy(() => import('./components/projects/ProjectsPage'));
const LibraryPage = lazy(() => import('./components/LibraryPage'));const AdminPage = lazy(() => import('./components/admin/AdminPage'));
const ChatPage = lazy(() => import('./components/ChatPage'));
const UsersPage = lazy(() => import('./components/UsersPage'));
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
// CLI Memory — Runtime Host 의 LLM CLI 메모리 파일(docs/cli-memory.md).
const MemoryPage = lazy(() => import('./components/memory/MemoryPage'));
// Skills — Knowledge 아래 범위별 배정(docs/skills.md).
const SkillsKnowledgePage = lazy(() => import('./components/knowledge/SkillsKnowledgePage'));
// 오케스트레이션 모드 — 칸반 보드와 같은 최상위 작업 표면.
const OrchestrationPage = lazy(() => import('./components/orchestration/OrchestrationPage'));
const OrchestrationTeamsPage = lazy(() => import('./components/orchestration/OrchestrationTeamsPage'));
const MissionDetailPage = lazy(() => import('./components/orchestration/MissionDetailPage'));
// Ontology Graph UI 셸(ticket d22b83b4) — 캔버스 없는 라우트/사이드바/배지.
const OntologyGraphPage = lazy(() => import('./components/ontology/OntologyGraphPage'));
// Marketing — 에이전트가 돌리는 제품 마케팅 캠페인과 사람의 승인함(docs/marketing.md).
const MarketingPage = lazy(() => import('./components/marketing/MarketingPage'));
const BusinessLayout = lazy(() => import('./components/business/BusinessLayout'));
const BusinessMailPage = lazy(() => import('./components/business/BusinessMailPage'));
const BusinessPage = lazy(() => import('./components/business/BusinessPage'));
const MarketingCampaignPage = lazy(() => import('./components/marketing/MarketingCampaignPage'));
const MarketingContactsPage = lazy(() => import('./components/marketing/MarketingContactsPage'));

// 지연 로드되는 라우트 청크를 가져오는 동안 보여줄 폴백.
function RouteFallback() {
  useLocale();
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
  useLocale();
  const { search, hash } = useLocation();
  return <Navigate to={`/${to}${search}${hash}`} replace />;
}

export function DefaultRedirect() {
  useLocale();
  return <GlobalRedirect to="sessions" />;
}

export function LegacyPathRedirect() {
  useLocale();
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${canonicalWorkPath(pathname)}${search}${hash}`} replace />;
}

export function LegacyBoardsRedirect() {
  useLocale();
  return <GlobalRedirect to="tickets" />;
}

export function LegacyOrchestrationTeamsRedirect() {
  useLocale();
  return <GlobalRedirect to="teams" />;
}

function AppContent() {
  useLocale();
  const { isAuthenticated, isLoading, serverUnavailable } = useAuth();
  const { showToast } = useToast();
  const wasAuthenticated = useRef(false);

  // Show toast when auth state transitions from authenticated → not authenticated
  useEffect(() => {
    if (isLoading) return;
    if (wasAuthenticated.current && !isAuthenticated) {
      showToast(translate('Session expired. Please log in again.'), 'error');
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
            {translate('Server Unavailable')}</div>
          <div style={{ fontSize: '13px', color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
            {translate('Unable to connect to the AWB server. Make sure the server is running and try again.')}</div>
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
            {translate('Retry')}</button>
          {/* 막다른 해소: 서버에 못 닿아 로그인 화면조차 안 뜰 때 여기서 주소를 바꾼다
              (Android 앱에서는 앱의 연결 화면을 연다). */}
          <div style={{
            width: '100%', marginTop: 8, paddingTop: 16,
            borderTop: `1px solid ${tokens.colors.border}`, textAlign: 'left',
          }}>
            <ServerConfigField />
          </div>
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
            <Route path="ws/:wsId/*" element={<LegacyPathRedirect />} />
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
            <Route path="memory" element={<MemoryPage />} />
            <Route path="memory/:managerId" element={<MemoryPage />} />
            <Route path="skills" element={<SkillsKnowledgePage />} />
            <Route path="tickets" element={<TicketsPage />} />
            <Route path="boards/*" element={<LegacyBoardsRedirect />} />
            <Route path="board/settings" element={<LegacyBoardsRedirect />} />
            <Route path="teams" element={<OrchestrationTeamsPage />} />
            <Route path="missions" element={<OrchestrationPage />} />
            <Route path="missions/:missionId" element={<MissionDetailPage />} />
            <Route element={<BusinessLayout />}>
              <Route path="business" element={<BusinessPage view="overview" />} />
              <Route path="business/operations" element={<BusinessPage view="operations" />} />
              <Route path="business/mail" element={<BusinessMailPage />} />
              <Route path="business/connectors" element={<BusinessPage view="connectors" />} />
              <Route path="marketing" element={<MarketingPage />} />
              <Route path="marketing/contacts" element={<MarketingContactsPage />} />
              <Route path="marketing/:campaignId" element={<MarketingCampaignPage />} />
            </Route>
            <Route path="orchestration/*" element={<LegacyPathRedirect />} />
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
            <Route path="settings/defaults" element={<AccountSettingsPage />} />
            <Route path="settings/users" element={<UsersPage />} />
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
  useLocale();
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
