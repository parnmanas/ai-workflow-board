import React from 'react';
import { useParams } from 'react-router-dom';
import CredentialManager from './admin/CredentialManager';
import PageHeader from './PageHeader';

export default function WorkspaceCredentialsPage() {
  const { wsId } = useParams<{ wsId: string }>();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Credentials" />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '24px' }}>
        <CredentialManager workspaceId={wsId} />
      </div>
    </div>
  );
}
