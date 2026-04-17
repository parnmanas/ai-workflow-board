import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import PageHeader from '../PageHeader';
import UserManager from './UserManager';
import QaRunner from './QaRunner';
import LogViewer from './LogViewer';
import AgentLogViewer from './AgentLogViewer';
import SettingsManager from './SettingsManager';
import { tokens } from '../../tokens';

const pageTitles: Record<string, { title: string; description?: string }> = {
  users: { title: 'Users', description: 'Manage user accounts' },
  qa: { title: 'QA Tests', description: 'Run quality assurance tests' },
  logs: { title: 'Server Logs', description: 'View server logs' },
  'agent-logs': { title: 'Agent Logs', description: 'Per-agent plugin error reports' },
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

export default function AdminPage() {
  return (
    <Routes>
      <Route index element={<Navigate to="/admin/users" replace />} />
      <Route path="users" element={<AdminRoute page="users"><UserManager /></AdminRoute>} />
      <Route path="qa" element={<AdminRoute page="qa"><QaRunner /></AdminRoute>} />
      <Route path="logs" element={<AdminRoute page="logs"><LogViewer /></AdminRoute>} />
      <Route path="agent-logs" element={<AdminRoute page="agent-logs"><AgentLogViewer /></AdminRoute>} />
      <Route path="settings" element={<AdminRoute page="settings"><SettingsManager /></AdminRoute>} />
      <Route path="*" element={<Navigate to="/admin/users" replace />} />
    </Routes>
  );
}
