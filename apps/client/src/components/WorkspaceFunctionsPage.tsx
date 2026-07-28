import React from 'react';
import { useParams } from 'react-router-dom';
import PageHeader from './PageHeader';
import FunctionManager from './admin/FunctionManager';

export default function WorkspaceFunctionsPage() {
  const { wsId } = useParams<{ wsId: string }>();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Functions"
        description="Global Functions plus workspace-specific definitions and overrides"
      />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24 }}>
        <FunctionManager workspaceId={wsId} />
      </div>
    </div>
  );
}
