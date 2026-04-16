import React from 'react';
import { useParams } from 'react-router-dom';
import PromptTemplateManager from './admin/PromptTemplateManager';
import PageHeader from './PageHeader';

export default function WorkspacePromptTemplatesPage() {
  const { wsId } = useParams<{ wsId: string }>();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Prompt Templates" />
      <PromptTemplateManager workspaceId={wsId} />
    </div>
  );
}
