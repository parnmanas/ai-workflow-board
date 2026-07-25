import React from 'react';
import { useParams } from 'react-router-dom';
import PageHeader from './PageHeader';
import WorkspaceClaudeBackendProfilesEditor from './WorkspaceClaudeBackendProfilesEditor';
import { tokens } from '../tokens';

/** Workspace-owner surface; the server is authoritative for owner vs member. */
export default function WorkspaceClaudeBackendProfilesPage() {
  const { wsId } = useParams<{ wsId: string }>();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Claude Backend Profiles" description="Workspace assignment" />
      <div style={{ flex: 1, overflow: 'auto', padding: 24, background: tokens.colors.surface }}>
        {wsId && <WorkspaceClaudeBackendProfilesEditor workspaceId={wsId} />}
      </div>
    </div>
  );
}
