import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import type { CatalogScope, Workspace } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';
import PageHeader from './PageHeader';
import FunctionManager from './admin/FunctionManager';
import CredentialManager from './admin/CredentialManager';
import ResourceManager from './admin/ResourceManager';
import PromptTemplateManager from './admin/PromptTemplateManager';
import ActionManager from './admin/ActionManager';
import QaManager from './admin/QaManager';
import SecurityManager from './admin/SecurityManager';
import WorkspaceSchedulesEditor from './WorkspaceSchedulesEditor';
import ClaudeBackendProfilesManager from './admin/ClaudeBackendProfilesManager';
import { PermissionNotice } from './common';

export type WorkspaceManagementKind =
  | 'functions'
  | 'credentials'
  | 'resources'
  | 'prompt-templates'
  | 'actions'
  | 'qa'
  | 'security'
  | 'schedules'
  | 'claude-backend-profiles';

const PAGE_INFO: Record<WorkspaceManagementKind, { title: string; description: string; scopedDefinition?: boolean }> = {
  functions: { title: 'Functions', description: 'Global and current Workspace function definitions.', scopedDefinition: true },
  credentials: { title: 'Credentials', description: 'Global and current Workspace credentials.', scopedDefinition: true },
  resources: { title: 'Resources', description: 'Global and current Workspace resources.', scopedDefinition: true },
  'prompt-templates': { title: 'Prompt Templates', description: 'Global and current Workspace prompt templates.', scopedDefinition: true },
  actions: { title: 'Actions', description: 'Actions owned by the current Workspace.' },
  qa: { title: 'QA', description: 'QA scenarios and schedules owned by the current Workspace.' },
  security: { title: 'Security', description: 'Security profiles and schedules owned by the current Workspace.' },
  schedules: { title: 'Schedules', description: 'Scheduled agent tasks owned by the current Workspace.' },
  'claude-backend-profiles': { title: 'Claude Backend Profiles', description: 'Instance-wide backend definitions. Profiles are global — every Workspace sees the same list.' },
};

export default function WorkspaceManagementPage({ kind }: { kind: WorkspaceManagementKind }) {
  const { wsId = '' } = useParams<{ wsId: string }>();
  const { hasPermission } = useAuth();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [createScope, setCreateScope] = useState<CatalogScope>('workspace');
  const info = PAGE_INFO[kind];

  useEffect(() => {
    if (!wsId) return;
    api.getWorkspace(wsId).then(setWorkspace).catch(() => setWorkspace(null));
  }, [wsId]);

  const definitionProps = {
    workspaceId: wsId,
    catalogMode: true,
    createScope,
    allScopes: false,
    canManageGlobal: hasPermission('admin.access'),
  } as const;

  const manager = (() => {
    switch (kind) {
      case 'functions':
        return <FunctionManager {...definitionProps} />;
      case 'credentials':
        return <CredentialManager {...definitionProps} />;
      case 'resources':
        return <ResourceManager {...definitionProps} />;
      case 'prompt-templates':
        return <PromptTemplateManager {...definitionProps} />;
      case 'actions':
        return <ActionManager workspaceId={wsId} />;
      case 'qa':
        return <QaManager workspaceId={wsId} />;
      case 'security':
        return <SecurityManager workspaceId={wsId} />;
      case 'schedules':
        return <WorkspaceSchedulesEditor workspaceId={wsId} />;
      case 'claude-backend-profiles':
        // 프로필은 인스턴스 전역이라 워크스페이스 배정/기본값 UI 가 없다
        // (티켓 e616dbfc). 관리는 관리자 전용이므로 비관리자에게는 탭을
        // 숨기는 대신 다른 탭과 같은 방식으로 권한 안내를 렌더한다 — 탭만
        // 사라지면 이 화면에서 유일하게 동작이 달라진다.
        return hasPermission('admin.access')
          ? <ClaudeBackendProfilesManager workspaceId={wsId} />
          : (
            <PermissionNotice
              title="관리자 권한이 필요합니다"
              message="Claude backend 프로필은 인스턴스 전역 설정이라 관리자만 편집할 수 있습니다."
            />
          );
    }
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title={info.title}
        description={info.description}
      />
      {info.scopedDefinition && (
        <div
          style={{
            padding: '14px 24px',
            borderBottom: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surfaceSubtle,
          }}
        >
          <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
            Workspace for new item
            <select
              value={createScope}
              onChange={(event) => setCreateScope(event.target.value as CatalogScope)}
              style={{
                display: 'block',
                minWidth: 280,
                marginTop: 5,
                padding: '8px 10px',
                borderRadius: 6,
                border: `1px solid ${tokens.colors.border}`,
                background: tokens.colors.surface,
                color: tokens.colors.textPrimary,
              }}
            >
              {hasPermission('admin.access') && <option value="global">Not set (Global)</option>}
              <option value="workspace">{workspace?.name || 'Current Workspace'}</option>
            </select>
          </label>
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24 }}>
        {manager}
      </div>
    </div>
  );
}
