import React from 'react';
import AgentTemplatesPanel from './runtime/AgentTemplatesPanel';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';
import PageHeader from './PageHeader';
import { PermissionNotice } from './common';
import AgentManagerPage from './admin/AgentManagerPage';

export default function HostsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('admin.access');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="HOSTS"
        description="Runtime Host 연결, 매니저 버전, CLI와 ACP 어댑터를 관리합니다."
      />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 24, background: tokens.colors.surface }}>
        {canManage ? (
          <><AgentTemplatesPanel /><AgentManagerPage /></>
        ) : (
          <PermissionNotice title="관리자 권한이 필요합니다" message="Runtime Host 관리에는 관리자 권한이 필요합니다." />
        )}
      </div>
    </div>
  );
}
