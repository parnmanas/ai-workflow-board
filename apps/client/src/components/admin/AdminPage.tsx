import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import PageHeader from '../PageHeader';
import UserManager from './UserManager';
import LogViewer from './LogViewer';
import AgentLogViewer from './AgentLogViewer';
import SettingsManager from './SettingsManager';
import MigrationManager from './MigrationManager';
import WorkflowHealthDashboard from './WorkflowHealthDashboard';
import SkillRegistryPage from './SkillRegistryPage';
import VoicePage from './VoicePage';
import { tokens } from '../../tokens';
import { useAuth } from '../../contexts/AuthContext';

const pageTitles: Record<string, { title: string; description?: string }> = {
  users: { get title() { return translate('Users'); }, get description() { return translate('Manage user accounts'); } },
  logs: { get title() { return translate('Server Logs'); }, get description() { return translate('View server logs'); } },
  'agent-logs': { get title() { return translate('Agent Logs'); }, get description() { return translate('Per-agent plugin error reports'); } },
  skills: { get title() { return translate('Skills'); }, get description() { return translate('Immutable skill versions, assignments, and runtime proposals'); } },
  'skill-registry': {
    get title() { return translate('Skill Registry'); },
    get description() { return translate('Global skills, the built-in pack, and external git taps'); },
  },
  'workflow-health': { get title() { return translate('Workflow Health'); }, get description() { return translate('Agent token usage and cost — recent window and all-time'); } },
  settings: { get title() { return translate('Settings'); }, get description() { return translate('System configuration'); } },
  voice: { get title() { return translate('Voice'); }, get description() { return translate('Speech engines for voice input, spoken replies and announcements — and the lab to choose them'); } },
  migration: { get title() { return translate('Live Import'); }, get description() { return translate('Pull this instance\'s data from a live source AWB server'); } },
};

function AdminRoute({ page, children }: { page: string; children: React.ReactNode }) {
  useLocale();
  const info = pageTitles[page] || { title: translate('Admin') };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: tokens.colors.surface, minHeight: 0 }}>
      <PageHeader title={info.title} description={info.description} />
      <div style={{ flex: 1, overflow: 'auto', padding: 24, minHeight: 0 }}>
        {children}
      </div>
    </div>
  );
}

function WorkRouteRedirect({ path }: { path: string }) {
  useLocale();
  return <Navigate to={`/${path}`} replace />;
}

export default function AdminPage() {
  useLocale();
  return (
    <Routes>
      <Route index element={<Navigate to="/admin/users" replace />} />
      <Route path="users" element={<AdminRoute page="users"><UserManager /></AdminRoute>} />
      <Route path="logs" element={<AdminRoute page="logs"><LogViewer /></AdminRoute>} />
      <Route path="agent-logs" element={<AdminRoute page="agent-logs"><AgentLogViewer /></AdminRoute>} />
      <Route path="agent-manager" element={<WorkRouteRedirect path="hosts" />} />
      {/* Skills 는 Knowledge 로 옮겼다(/skills) — 예전 링크는 그리로 보낸다. */}
      <Route path="skills" element={<WorkRouteRedirect path="skills" />} />
      <Route path="skill-registry" element={<AdminRoute page="skill-registry"><SkillRegistryPage /></AdminRoute>} />
      <Route path="workflow-health" element={<AdminRoute page="workflow-health"><WorkflowHealthDashboard /></AdminRoute>} />
      <Route path="global-credentials" element={<WorkRouteRedirect path="settings/credentials" />} />
      <Route path="claude-backend-profiles" element={<WorkRouteRedirect path="settings/claude-profiles" />} />
      <Route path="settings" element={<AdminRoute page="settings"><SettingsManager /></AdminRoute>} />
      <Route path="voice" element={<AdminRoute page="voice"><VoicePage /></AdminRoute>} />
      <Route path="migration" element={<AdminRoute page="migration"><MigrationManager /></AdminRoute>} />
      <Route path="functions" element={<WorkRouteRedirect path="functions" />} />
      <Route path="*" element={<Navigate to="/admin/users" replace />} />
    </Routes>
  );
}
