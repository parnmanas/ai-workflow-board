import React from 'react';
import { useParams } from 'react-router-dom';
import { useBoard } from '../hooks/useBoard';
import FeatureManager from './admin/FeatureManager';
import PageHeader from './PageHeader';
import { HeaderAction } from './common';

/**
 * Board-level Feature/Epic intake page (ticket aae7644c) — the entry point of the
 * one-stop automated development loop. Reached from the board sub-menu ("Features")
 * and hosts the "New Feature" intake + proposal approval surface.
 */
export default function BoardFeaturesPage() {
  const { wsId, boardId } = useParams<{ wsId: string; boardId: string }>();
  const { board } = useBoard(boardId ?? '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Features"
        description={board?.name}
        actions={
          wsId && boardId ? (
            <HeaderAction icon="←" label="Back to Board" to={`/ws/${wsId}/boards/${boardId}`} />
          ) : undefined
        }
      />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '24px' }}>
        <FeatureManager workspaceId={wsId} boardId={boardId} />
      </div>
    </div>
  );
}
