import { t as translate } from '../i18n/core';
import { useLocale } from '../i18n/react';
import { useAuth } from '../contexts/AuthContext';
import React from 'react';
import ChannelManager from './admin/ChannelManager';
import PageHeader from './PageHeader';

export default function AccountChannelsPage() {
  useLocale();
  const { currentAccountId } = useAuth();
  const accountId = currentAccountId || '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title={translate('Channels')} />
      <ChannelManager accountId={accountId} />
    </div>
  );
}
