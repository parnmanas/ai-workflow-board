import React from 'react';
import { useParams } from 'react-router-dom';
import { useBoard } from '../hooks/useBoard';
import ActionManager from './admin/ActionManager';
import PageHeader from './PageHeader';

export default function BoardActionsPage() {
  const { wsId, boardId } = useParams<{ wsId: string; boardId: string }>();
  const { board } = useBoard(boardId ?? '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Actions" description={board?.name} />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '24px' }}>
        <ActionManager workspaceId={wsId} boardId={boardId} />
      </div>
    </div>
  );
}
