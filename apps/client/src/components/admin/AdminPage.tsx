import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import PageHeader from '../PageHeader';
import UserManager from './UserManager';
import LogViewer from './LogViewer';
import AgentLogViewer from './AgentLogViewer';
import AgentManagerPage from './AgentManagerPage';
import SettingsManager from './SettingsManager';
import QaRunner from './QaRunner';
import ColumnPoliciesManager from './ColumnPoliciesManager';
import WorkflowHealthDashboard from './WorkflowHealthDashboard';
import { tokens } from '../../tokens';
import { useAuth } from '../../contexts/AuthContext';

const pageTitles: Record<string, { title: string; description?: string }> = {
  users: { title: 'Users', description: 'Manage user accounts' },
  qa: { title: 'QA Tests', description: 'Run system-level quality assurance tests' },
  logs: { title: 'Server Logs', description: 'View server logs' },
  'agent-logs': { title: 'Agent Logs', description: 'Per-agent plugin error reports' },
  'agent-manager': { title: 'Agent Manager', description: 'Live Agent Manager instances connected to this server' },
  'column-policies': { title: 'Column Policies', description: 'Declarative column role enforcement and stuck-ticket protection' },
  'workflow-health': { title: 'Workflow Health', description: 'Automation suppression, respawn storms, QA trends, and token usage' },
  settings: { title: 'Settings', description: 'System configuration' },
};

function AdminRoute({ page, children }: { page: string; children: React.ReactNode }) {
  const info = pageTitles[page] || { title: 'Admin' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: tokens.colors.surface, minHeight: 0 }}>
      <PageHeader title={info.title} description={info.description} />
      <div style={{ flex: 1, overflow: 'auto', padding: 24, minHeight: 0 }}>
        {children}
      </div>
    </div>
  );
}

function WorkspaceRouteRedirect({ path }: { path: string }) {
  const { currentWorkspaceId } = useAuth();
  if (!currentWorkspaceId) return null;
  return <Navigate to={`/ws/${currentWorkspaceId}/${path}`} replace />;
}

export default function AdminPage() {
  return (
    <Routes>
      <Route index element={<Navigate to="/admin/users" replace />} />
      <Route path="users" element={<AdminRoute page="users"><UserManager /></AdminRoute>} />
      <Route path="qa" element={<AdminRoute page="qa"><QaRunner /></AdminRoute>} />
      <Route path="logs" element={<AdminRoute page="logs"><LogViewer /></AdminRoute>} />
      <Route path="agent-logs" element={<AdminRoute page="agent-logs"><AgentLogViewer /></AdminRoute>} />
      <Route path="agent-manager" element={<AdminRoute page="agent-manager"><AgentManagerPage /></AdminRoute>} />
      <Route path="column-policies" element={<AdminRoute page="column-policies"><ColumnPoliciesManager /></AdminRoute>} />
      <Route path="workflow-health" element={<AdminRoute page="workflow-health"><WorkflowHealthDashboard /></AdminRoute>} />
      <Route path="global-credentials" element={<WorkspaceRouteRedirect path="credentials" />} />
      <Route path="claude-backend-profiles" element={<WorkspaceRouteRedirect path="claude-backend-profiles" />} />
      <Route path="settings" element={<AdminRoute page="settings"><SettingsManager /></AdminRoute>} />
      <Route path="functions" element={<WorkspaceRouteRedirect path="functions" />} />
      <Route path="*" element={<Navigate to="/admin/users" replace />} />
    </Routes>
  );
}
