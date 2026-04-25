import React, { useEffect, useRef } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { LoadingProvider } from './contexts/LoadingContext';
import Board from './components/Board';
import LoginPage from './components/LoginPage';
import AdminPage from './components/admin/AdminPage';
import AppLayout from './components/AppLayout';
import ChatPage from './components/ChatPage';
import AgentsPage from './components/AgentsPage';
import BoardSettingsPage from './components/BoardSettingsPage';
import BoardsIndexPage from './components/BoardsIndexPage';
import WorkspaceUsersPage from './components/WorkspaceUsersPage';
import WorkspaceChannelsPage from './components/WorkspaceChannelsPage';
import WorkspaceApiKeysPage from './components/WorkspaceApiKeysPage';
import WorkspacePromptTemplatesPage from './components/WorkspacePromptTemplatesPage';
import WorkspaceResourcesPage from './components/WorkspaceResourcesPage';
import WorkspaceCredentialsPage from './components/WorkspaceCredentialsPage';
import WorkspaceRolesPage from './components/WorkspaceRolesPage';
import AgentDetailPage from './components/AgentDetailPage';
import { tokens } from './tokens';

// Redirects the user to /ws/:currentWorkspaceId/:to, waiting for auth to resolve.
function WorkspacedRedirect({ to }: { to: string }) {
  const { currentWorkspaceId } = useAuth();
  if (!currentWorkspaceId) return null;
  return <Navigate to={`/ws/${currentWorkspaceId}/${to}`} replace />;
}

// Redirects / to the workspace boards index once auth resolves.
function WorkspaceDefaultRedirect() {
  const { currentWorkspaceId } = useAuth();
  if (!currentWorkspaceId) return null;
  return <Navigate to={`/ws/${currentWorkspaceId}/boards`} replace />;
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
          <Route index element={<Navigate to="boards" replace />} />
          <Route path="boards" element={<BoardsIndexPage />} />
          <Route path="boards/:boardId" element={<Board />} />
          <Route path="boards/:boardId/settings" element={<BoardSettingsPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="users" element={<WorkspaceUsersPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:agentId" element={<AgentDetailPage />} />
          <Route path="channels" element={<WorkspaceChannelsPage />} />
          <Route path="api-keys" element={<WorkspaceApiKeysPage />} />
          <Route path="prompt-templates" element={<WorkspacePromptTemplatesPage />} />
          <Route path="resources" element={<WorkspaceResourcesPage />} />
          <Route path="credentials" element={<WorkspaceCredentialsPage />} />
          <Route path="roles" element={<WorkspaceRolesPage />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <LoadingProvider>
          <AppContent />
        </LoadingProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
