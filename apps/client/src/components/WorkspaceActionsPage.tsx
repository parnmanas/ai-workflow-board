import React from 'react';
import { useParams } from 'react-router-dom';
import ActionManager from './admin/ActionManager';
import PageHeader from './PageHeader';

export default function WorkspaceActionsPage() {
  const { wsId } = useParams<{ wsId: string }>();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Actions" />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '24px' }}>
        <ActionManager workspaceId={wsId} boardId={null} />
      </div>
    </div>
  );
}
