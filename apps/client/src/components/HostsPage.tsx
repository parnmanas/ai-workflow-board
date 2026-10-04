import React from 'react';
import { useSearchParams } from 'react-router-dom';
import AgentTemplatesPanel from './runtime/AgentTemplatesPanel';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';
import PageHeader from './PageHeader';
import PageTabs from './PageTabs';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { PermissionNotice } from './common';
import AgentManagerPage from './admin/AgentManagerPage';

export default function HostsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('admin.access');
  const [searchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') === 'templates' ? 'templates' : 'hosts';
  const isMobile = useMediaQuery('(max-width: 767px)');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="HOSTS"
        description="Agent 템플릿 등록과 Runtime Host 연결, 매니저 버전, CLI와 ACP 어댑터를 관리합니다."
      />
      {canManage && <PageTabs activeId={activeTab} tabs={[
        { id: 'hosts', label: 'Runtime Hosts', to: '?tab=hosts' },
        { id: 'templates', label: 'Agent 템플릿', to: '?tab=templates' },
      ]} />}
      <div role={canManage ? 'tabpanel' : undefined} aria-label={canManage ? (activeTab === 'hosts' ? 'Runtime Hosts' : 'Agent 템플릿') : undefined}
        style={{ flex: 1, minHeight: 0, overflow: activeTab === 'hosts' && canManage ? 'hidden' : 'auto', padding: isMobile ? 12 : 24, background: tokens.colors.surface }}>
        {canManage ? (
          activeTab === 'templates' ? <AgentTemplatesPanel /> : <AgentManagerPage />
        ) : (
          <PermissionNotice title="관리자 권한이 필요합니다" message="Runtime Host 관리에는 관리자 권한이 필요합니다." />
        )}
      </div>
    </div>
  );
}
