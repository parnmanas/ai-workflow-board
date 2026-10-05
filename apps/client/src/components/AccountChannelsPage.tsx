import { useAuth } from '../contexts/AuthContext';
import React from 'react';
import ChannelManager from './admin/ChannelManager';
import PageHeader from './PageHeader';

export default function AccountChannelsPage() {
  const { currentAccountId } = useAuth();
  const wsId = currentAccountId || '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Channels" />
      <ChannelManager accountId={wsId} />
    </div>
  );
}
