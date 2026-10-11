import React, { useEffect, useState } from 'react';
import { api } from '../api';
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
import {
  createOwnerOptions,
  ownerToSelectValue,
  resolveCreateOwner,
  selectValueToOwner,
  type OwnerAccount,
} from './admin/catalogOwner.logic';

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
  functions: { title: 'Functions', description: 'Global function definitions and those of every Account you can access.', scopedDefinition: true },
  credentials: { title: 'Credentials', description: 'Global credentials and those of every Account you can access.', scopedDefinition: true },
  resources: { title: 'Resources', description: 'Global resources and those of every Account you can access.', scopedDefinition: true },
  actions: { title: 'Actions', description: 'Actions across your accessible accounts.' },
  qa: { title: 'QA', description: 'QA scenarios and schedules across your accessible accounts.' },
  security: { title: 'Security', description: 'Security profiles and schedules across your accessible accounts.' },
  schedules: { title: 'Schedules', description: 'Scheduled agent tasks across your accessible accounts.' },
  'claude-backend-profiles': { title: 'Claude Backend Profiles', description: 'Instance-wide backend definitions. Profiles are global — every Account sees the same list.' },
};

export default function AccountManagementPage({ kind }: { kind: AccountManagementKind }) {
  // The creation default only feeds the kinds below that still take one
  // account. The catalog kinds (scopedDefinition) list every accessible
  // Account + Global and name the owner of a new item explicitly.
  const { currentAccountId, availableAccounts, hasPermission } = useAuth();
  const accountId = currentAccountId || '';
  const info = PAGE_INFO[kind];

  // Owner names come with the signed-in user's accounts; fetch them only when
  // that list arrived without names.
  const [fetchedAccounts, setFetchedAccounts] = useState<OwnerAccount[] | null>(null);
  const namesMissing = availableAccounts.length === 0 || availableAccounts.some((a) => !a.name);
  useEffect(() => {
    if (!info.scopedDefinition || !namesMissing) return;
    let cancelled = false;
    api.getAccounts()
      .then((rows) => { if (!cancelled) setFetchedAccounts((rows || []).map((a) => ({ id: a.id, name: a.name }))); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [info.scopedDefinition, namesMissing]);
  const ownerAccounts: OwnerAccount[] = namesMissing && fetchedAccounts ? fetchedAccounts : availableAccounts;

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

  // undefined = not picked yet → Global when permitted, else the first account.
  const [pickedOwner, setPickedOwner] = useState<string | null | undefined>(undefined);
  const createAccountId = resolveCreateOwner(pickedOwner, ownerAccounts, canManageGlobalHere);
  const ownerOptions = createOwnerOptions(ownerAccounts, canManageGlobalHere);

  const definitionProps = {
    catalogMode: true,
    createAccountId,
    accounts: ownerAccounts,
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
              value={ownerToSelectValue(createAccountId)}
              onChange={(event) => setPickedOwner(selectValueToOwner(event.target.value))}
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
              {/* Global only when canManageGlobalHere, then every accessible Account. */}
              {ownerOptions.map((option) => (
                <option key={ownerToSelectValue(option.accountId)} value={ownerToSelectValue(option.accountId)}>
                  {option.label}
                </option>
              ))}
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
