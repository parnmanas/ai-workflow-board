import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { CatalogScope, Account } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';
import PageHeader from './PageHeader';
import FunctionManager from './admin/FunctionManager';
import CredentialManager from './admin/CredentialManager';
import ResourceManager from './admin/ResourceManager';
import ActionManager from './admin/ActionManager';
import QaManager from './admin/QaManager';
import SecurityManager from './admin/SecurityManager';
import AutomationSchedulesEditor from './AutomationSchedulesEditor';
import ClaudeBackendProfilesManager from './admin/ClaudeBackendProfilesManager';
import { PermissionNotice } from './common';

export type AccountManagementKind =
  | 'functions'
  | 'credentials'
  | 'resources'
  | 'actions'
  | 'qa'
  | 'security'
  | 'schedules'
  | 'claude-backend-profiles';

const PAGE_INFO: Record<AccountManagementKind, { title: string; description: string; scopedDefinition?: boolean }> = {
  functions: { title: 'Functions', description: 'Global and current Account function definitions.', scopedDefinition: true },
  credentials: { title: 'Credentials', description: 'Global and current Account credentials.', scopedDefinition: true },
  resources: { title: 'Resources', description: 'Global and current Account resources.', scopedDefinition: true },
  actions: { title: 'Actions', description: 'Actions across your accessible accounts.' },
  qa: { title: 'QA', description: 'QA scenarios and schedules across your accessible accounts.' },
  security: { title: 'Security', description: 'Security profiles and schedules across your accessible accounts.' },
  schedules: { title: 'Schedules', description: 'Scheduled agent tasks across your accessible accounts.' },
  'claude-backend-profiles': { title: 'Claude Backend Profiles', description: 'Instance-wide backend definitions. Profiles are global — every Account sees the same list.' },
};

export default function AccountManagementPage({ kind }: { kind: AccountManagementKind }) {
  const { currentAccountId } = useAuth();
  const wsId = currentAccountId || '';
  const { hasPermission } = useAuth();
  const [account, setAccount] = useState<Account | null>(null);
  const [createScope, setCreateScope] = useState<CatalogScope>('account');
  const info = PAGE_INFO[kind];

  useEffect(() => {
    if (!wsId) return;
    api.getAccount(wsId).then(setAccount).catch(() => setAccount(null));
  }, [wsId]);

  // Credentials are the one catalog kind whose server-side global writes sit
  // behind a dedicated permission (admin.global_credentials — see
  // credentials.controller.ts canManageGlobal); every other kind only checks
  // its own manage permission, so they keep the generic admin gate. Using
  // admin.access for credentials made the UI and the server disagree in both
  // directions: it offered Global to an admin-panel user the server would 403,
  // and hid it from a user granted admin.global_credentials alone.
  const canManageGlobalHere = kind === 'credentials'
    ? hasPermission('admin.global_credentials')
    : hasPermission('admin.access');

  const definitionProps = {
    accountId: wsId,
    catalogMode: true,
    createScope,
    allScopes: false,
    canManageGlobal: canManageGlobalHere,
  } as const;

  const manager = (() => {
    switch (kind) {
      case 'functions':
        return <FunctionManager {...definitionProps} />;
      case 'credentials':
        return <CredentialManager {...definitionProps} accountName={account?.name} />;
      case 'resources':
        return <ResourceManager {...definitionProps} />;
      case 'actions':
        return <ActionManager accountId={wsId} />;
      case 'qa':
        return <QaManager accountId={wsId} />;
      case 'security':
        return <SecurityManager accountId={wsId} />;
      case 'schedules':
        return <AutomationSchedulesEditor accountId={wsId} />;
      case 'claude-backend-profiles':
        // 프로필은 인스턴스 전역이라 Account 배정/기본값 UI 가 없다
        // (티켓 e616dbfc). 관리는 관리자 전용이므로 비관리자에게는 탭을
        // 숨기는 대신 다른 탭과 같은 방식으로 권한 안내를 렌더한다 — 탭만
        // 사라지면 이 화면에서 유일하게 동작이 달라진다.
        return hasPermission('admin.access')
          ? <ClaudeBackendProfilesManager accountId={wsId} />
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
            Account for new item
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
              {canManageGlobalHere && <option value="global">Not set (Global)</option>}
              <option value="account">{account?.name || 'Current Account'}</option>
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
