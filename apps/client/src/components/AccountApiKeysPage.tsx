import { t as translate } from '../i18n/core';
import { useLocale } from '../i18n/react';
import { useAuth } from '../contexts/AuthContext';
import React from 'react';
import ApiKeyManager from './admin/ApiKeyManager';
import PageHeader from './PageHeader';

export default function AccountApiKeysPage() {
  useLocale();
  const { currentAccountId } = useAuth();
  const accountId = currentAccountId || '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title={translate('API Keys')} />
      <ApiKeyManager accountId={accountId} />
    </div>
  );
}
