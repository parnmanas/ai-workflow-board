import React from 'react';
import { useParams } from 'react-router-dom';
import ApiKeyManager from './admin/ApiKeyManager';
import PageHeader from './PageHeader';

export default function WorkspaceApiKeysPage() {
  const { wsId } = useParams<{ wsId: string }>();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="API Keys" />
      <ApiKeyManager workspaceId={wsId} />
    </div>
  );
}
