import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Workspace } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import PageHeader from './PageHeader';
import HarnessConfigEditor from './HarnessConfigEditor';
import WorkspaceSchedulesEditor from './WorkspaceSchedulesEditor';
import AssistantAgentSetting from './chat/AssistantAgentSetting';
import { PermissionNotice } from './common';
import { tokens } from '../tokens';

// Workspace Settings (ticket 7122600c). Currently hosts the workspace-wide
// default agent harness; boards override it per key from Board Settings →
// Agent Harness. Admin-gated — the default harness applies to every board's
// subagents, so edits belong to operators.
export default function WorkspaceSettingsPage() {
  const { wsId } = useParams<{ wsId: string }>();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    try {
      const ws = await api.getWorkspace(wsId);
      setWorkspace(ws);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load workspace', 'error');
    }
  }, [wsId, showToast]);

  useEffect(() => { load(); }, [load]);

  const pageStyle: React.CSSProperties = {
    padding: '24px',
    background: tokens.colors.surface,
    color: tokens.colors.textStrong,
    boxSizing: 'border-box',
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  };

  if (!hasPermission('admin.access')) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <PageHeader title="Workspace Settings" />
        <div style={pageStyle}>
          <PermissionNotice
            title="Admin access required"
            message="Admin access is required to edit workspace settings."
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Workspace Settings" description={workspace?.name} />
      <div style={pageStyle}>
        {!workspace ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            <AssistantAgentSetting workspace={workspace} onSaved={load} />
            <HarnessConfigEditor
              raw={workspace.harness_config}
              title="Agent Harness (workspace default)"
              description={
                <>
                  Default harness for subagents on <strong>every board</strong> in this workspace:
                  extra system prompt, tool allow/deny lists, model and permission mode. Boards can
                  override individual keys from Board Settings → Agent Harness. Leave everything
                  empty for the current (no-harness) behaviour.
                </>
              }
              onSave={async (config) => {
                try {
                  await api.updateWorkspace(workspace.id, { harness_config: config });
                  await load();
                  showToast(config === null ? 'Workspace default harness cleared' : 'Workspace default harness saved', 'success');
                } catch (err: any) {
                  // Server zod rejection (400) surfaces its message here.
                  showToast(err?.message || 'Failed to save harness', 'error');
                }
              }}
            />
            <WorkspaceSchedulesEditor workspaceId={workspace.id} />
          </>
        )}
      </div>
    </div>
  );
}
