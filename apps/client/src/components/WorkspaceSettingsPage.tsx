import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Workspace } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import PageHeader from './PageHeader';
import HarnessConfigEditor from './HarnessConfigEditor';
import ClonePolicyEditor from './ClonePolicyEditor';
import AssistantAgentSetting from './chat/AssistantAgentSetting';
import { PermissionNotice } from './common';
import { tokens } from '../tokens';

// Workspace Settings (ticket 7122600c). Hosts the workspace-wide defaults that
// narrower scopes override per key: the agent harness (boards override it from
// Board Settings → Agent Harness) and the repo clone policy (a repository
// Resource overrides it from Resources → the repo's Clone Policy, ticket
// bddb63ee). Admin-gated — these defaults apply to every board's subagents and
// every repo checkout, so edits belong to operators.
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
            <div id="assistant-agent">
              <AssistantAgentSetting workspace={workspace} onSaved={load} />
            </div>
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
            <ClonePolicyEditor
              raw={workspace.clone_policy}
              title="Repository Clone Policy (workspace default)"
              description={
                <>
                  Default clone budget and strategy for <strong>every repository</strong> checked out
                  in this workspace: wall-clock timeout, idle-stall timeout, and the
                  shallow / partial / single-branch flags. A repository Resource overrides
                  individual keys from its own Clone Policy. Leave everything empty for the system
                  defaults (clone timeout 3600s, idle timeout off, full clone).
                </>
              }
              onSave={async (policy) => {
                try {
                  await api.updateWorkspace(workspace.id, { clone_policy: policy });
                  await load();
                  showToast(policy === null ? 'Workspace clone policy cleared' : 'Workspace clone policy saved', 'success');
                } catch (err: any) {
                  // 서버 zod 거부(400) 메시지가 여기로 올라온다.
                  showToast(err?.message || 'Failed to save clone policy', 'error');
                }
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
