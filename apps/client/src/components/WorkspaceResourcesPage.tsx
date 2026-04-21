import React from 'react';
import { useParams } from 'react-router-dom';
import ResourceManager from './admin/ResourceManager';
import PageHeader from './PageHeader';

export default function WorkspaceResourcesPage() {
  const { wsId } = useParams<{ wsId: string }>();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Resources" />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '24px' }}>
        <ResourceManager workspaceId={wsId} boardId={null} />
      </div>
    </div>
  );
}
