import React from 'react';
import { useParams } from 'react-router-dom';
import { useBoard } from '../hooks/useBoard';
import QaManager from './admin/QaManager';
import PageHeader from './PageHeader';
import { HeaderAction } from './common';

export default function BoardQaPage() {
  const { wsId, boardId } = useParams<{ wsId: string; boardId: string }>();
  const { board } = useBoard(boardId ?? '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="QA"
        description={board?.name}
        actions={
          wsId && boardId ? (
            <HeaderAction icon="←" label="Back to Board" to={`/ws/${wsId}/boards/${boardId}`} />
          ) : undefined
        }
      />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '24px' }}>
        <QaManager workspaceId={wsId} boardId={boardId} />
      </div>
    </div>
  );
}
