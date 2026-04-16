import React from 'react';
import { useParams } from 'react-router-dom';
import ChannelManager from './admin/ChannelManager';
import PageHeader from './PageHeader';

export default function WorkspaceChannelsPage() {
  const { wsId } = useParams<{ wsId: string }>();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Channels" />
      <ChannelManager workspaceId={wsId} />
    </div>
  );
}
