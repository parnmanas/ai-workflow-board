import { t as translate } from '../i18n/core';
import { useLocale } from '../i18n/react';
import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
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
import { defaultCreateOwner } from './admin/catalogOwner.logic';

export type AccountManagementKind =
  | 'functions'
  | 'credentials'
  | 'resources'
  | 'actions'
  | 'qa'
  | 'security'
  | 'schedules'
  | 'claude-backend-profiles';

const PAGE_INFO: Record<AccountManagementKind, { title: string; description: string }> = {
  functions: { get title() { return translate('Functions'); }, get description() { return translate('Reusable functions and execution history.'); } },
  credentials: { get title() { return translate('Credentials'); }, get description() { return translate('Manage API tokens and CLI logins.'); } },
  resources: { get title() { return translate('Resources'); }, get description() { return translate('Documents, files and links.'); } },
  actions: { get title() { return translate('Actions'); }, get description() { return translate('Manage automated actions.'); } },
  qa: { get title() { return translate('QA'); }, get description() { return translate('Manage QA scenarios and schedules.'); } },
  security: { get title() { return translate('Security'); }, get description() { return translate('Manage security profiles and schedules.'); } },
  schedules: { get title() { return translate('Schedules'); }, get description() { return translate('Manage scheduled agent tasks.'); } },
  'claude-backend-profiles': { get title() { return translate('Claude Backend Profiles'); }, get description() { return translate('Profiles are global. Manage CLI backend settings.'); } },
};

export default function AccountManagementPage({ kind }: { kind: AccountManagementKind }) {
  useLocale();
  const { currentAccountId, availableAccounts, hasPermission } = useAuth();
  const accountId = currentAccountId || '';
  const info = PAGE_INFO[kind];

  const [createGlobal, setCreateGlobal] = useState(false);
  useEffect(() => { setCreateGlobal(false); }, [kind, accountId]);

  // Global writes are explicit; the normal destination is the signed-in account.
  const canManageGlobalHere = kind === 'credentials'
    ? hasPermission('admin.global_credentials')
    : hasPermission('admin.access');

  const createAccountId = defaultCreateOwner(availableAccounts, canManageGlobalHere && createGlobal);

  const definitionProps = {
    catalogMode: true,
    createAccountId,
    allScopes: false,
    canManageGlobal: canManageGlobalHere,
  } as const;

  const manager = (() => {
    switch (kind) {
      case 'functions':
        return <FunctionManager {...definitionProps} />;
      case 'credentials':
        return <CredentialManager {...definitionProps} />;
      case 'resources':
        return <ResourceManager {...definitionProps} />;
      case 'actions':
        return <ActionManager accountId={accountId} />;
      case 'qa':
        return <QaManager accountId={accountId} />;
      case 'security':
        return <SecurityManager accountId={accountId} />;
      case 'schedules':
        return <AutomationSchedulesEditor accountId={accountId} />;
      case 'claude-backend-profiles':
        // 프로필은 인스턴스 전역이라 Account 배정/기본값 UI 가 없다
        // (티켓 e616dbfc). 관리는 관리자 전용이므로 비관리자에게는 탭을
        // 숨기는 대신 다른 탭과 같은 방식으로 권한 안내를 렌더한다 — 탭만
        // 사라지면 이 화면에서 유일하게 동작이 달라진다.
        return hasPermission('admin.access')
          ? <ClaudeBackendProfilesManager accountId={accountId} />
          : (
            <PermissionNotice
              title={translate('관리자 권한이 필요합니다')}
              message={translate('Claude backend 프로필은 인스턴스 전역 설정이라 관리자만 편집할 수 있습니다.')}
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
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24 }}>
        {canManageGlobalHere && ['functions', 'credentials', 'resources'].includes(kind) && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <input type="checkbox" checked={createGlobal} onChange={event => setCreateGlobal(event.target.checked)} />
            {translate('Create new items as Global (shared with all accounts)')}</label>
        )}
        {manager}
      </div>
    </div>
  );
}
