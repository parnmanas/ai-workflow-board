import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import PageHeader from './PageHeader';
import AgentCard from './AgentCard';
import AgentDetailModal from './AgentDetailModal';
import { tokens } from '../tokens';
import { Button } from './common';
import type {
  DashboardAgent,
  AgentCurrentTask,
} from '../types';

/**
 * AgentsPage — card grid + modal layout matching BoardsIndexPage pattern.
 *
 * Card grid shows all workspace agents. Clicking a card opens AgentDetailModal
 * (right-panel slide-in). Real-time status via BoardStreamContext agent_status
 * envelopes (D-42/D-50). workspace sourced from URL params (wsId).
 */

interface StatusUpdate {
  agent_id: string;
  is_online: boolean;
  last_seen_at: string | null;
  current_task?: AgentCurrentTask;
}

function mergeAgentStatus(
  list: DashboardAgent[],
  update: StatusUpdate,
): DashboardAgent[] {
  const idx = list.findIndex((a) => a.id === update.agent_id);
  // Ignore status updates for agents not in this workspace
  if (idx === -1) return list;
  const next = list.slice();
  const existing = next[idx];
  next[idx] = {
    ...existing,
    is_online: !!update.is_online,
    last_seen_at: update.last_seen_at ?? existing.last_seen_at,
    current_task: update.current_task,
  };
  return next;
}

export default function AgentsPage() {
  const { wsId } = useParams<{ wsId: string }>();
  const { user } = useAuth();
  const { showToast } = useToast();

  const [agents, setAgents] = useState<DashboardAgent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '', type: 'custom' });

  const pendingStatusRef = useRef<StatusUpdate[]>([]);
  const agentsReadyRef = useRef(false);

  // ─── Initial snapshot ─────────────────────────────────────────
  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setSnapshotError(null);
    agentsReadyRef.current = false;

    const result = await Promise.allSettled([
      api.getAgentDashboard(wsId || ''),
    ]);

    const agentsResult = result[0];

    if (agentsResult.status === 'fulfilled') {
      const base = agentsResult.value || [];
      const buffered = pendingStatusRef.current;
      pendingStatusRef.current = [];
      const merged = buffered.reduce(
        (acc, update) => mergeAgentStatus(acc, update),
        base,
      );
      setAgents(merged);
      agentsReadyRef.current = true;
    } else {
      setSnapshotError('Could not load agents. Retry.');
      setAgents((prev) => prev || []);
    }

    setLoading(false);
  }, [wsId]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  // ─── Live envelopes via BoardStreamContext ────────────────────
  useBoardStreamEvent('agent_status', (envelope: any) => {
    const payload = envelope?.payload;
    if (!payload || !payload.agent_id) return;
    const update: StatusUpdate = {
      agent_id: payload.agent_id,
      is_online: !!payload.is_online,
      last_seen_at: payload.last_seen_at ?? null,
      current_task: payload.current_task,
    };
    if (!agentsReadyRef.current) {
      pendingStatusRef.current.push(update);
      return;
    }
    setAgents((prev) => (prev ? mergeAgentStatus(prev, update) : prev));
  });

  // ─── Handlers ─────────────────────────────────────────────────
  // Track in-flight state so double-clicks on Create don't spawn parallel
  // POSTs, and so the button can disable + show "Creating..." feedback.
  const [creating, setCreating] = useState(false);
  const handleCreateAgent = useCallback(async () => {
    if (!createForm.name.trim() || creating) return;
    setCreating(true);
    try {
      // Pass the URL wsId explicitly so the request always lands in the
      // workspace the user is looking at, regardless of whether
      // localStorage.currentWorkspaceId has drifted.
      await api.createAgent({
        name: createForm.name.trim(),
        description: createForm.description.trim() || undefined,
        type: createForm.type,
        workspaceId: wsId,
      });
      setCreateForm({ name: '', description: '', type: 'custom' });
      setShowCreateModal(false);
      await loadSnapshot();
      showToast('Agent created', 'success');
    } catch (err: any) {
      // Surface the failure — prior silent-catch made "New Agent" appear to
      // do nothing when the POST was rejected (403 from WorkspaceGuard,
      // auth expiry, etc.). Keep the modal open so the user can retry.
      showToast(err?.message || 'Failed to create agent', 'error');
    } finally {
      setCreating(false);
    }
  }, [createForm, creating, loadSnapshot, wsId, showToast]);

  // ─── Render ───────────────────────────────────────────────────
  const agentsList = agents || [];
  const agentCount = agentsList.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title="AI Agents"
        description="Live agent status"
        actions={
          user?.role === 'admin' ? (
            <Button variant="primary" size="md" onClick={() => setShowCreateModal(true)}>+ New Agent</Button>
          ) : undefined
        }
      />

      {/* Snapshot error banner */}
      {snapshotError && (
        <div
          style={{
            margin: '0 24px 0 24px',
            padding: '12px 16px',
            background: 'transparent',
            border: `1px solid ${tokens.colors.danger}`,
            borderRadius: tokens.radii.md,
            color: tokens.colors.danger,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexShrink: 0,
          }}
          role="alert"
        >
          <span>{snapshotError}</span>
          <button
            type="button"
            onClick={loadSnapshot}
            style={{
              background: 'transparent',
              color: tokens.colors.danger,
              border: `1px solid ${tokens.colors.danger}`,
              borderRadius: tokens.radii.md,
              padding: '4px 12px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {/* Loading skeleton */}
        {agents === null ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 16,
            }}
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  background: tokens.colors.surfaceCard,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.lg,
                  padding: 16,
                  minHeight: 136,
                }}
              >
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{ width: 40, height: 40, borderRadius: 20, background: tokens.colors.border }} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ height: 15, background: tokens.colors.border, borderRadius: 2, width: '60%' }} />
                    <div style={{ height: 11, background: tokens.colors.border, borderRadius: 2, width: '40%' }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : agentCount === 0 ? (
          /* Empty state */
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '48px 24px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>
              No agents in this workspace
            </div>
            <div style={{ fontSize: 13, color: tokens.colors.textSecondary, lineHeight: 1.5, maxWidth: 400, marginTop: 8 }}>
              Add an agent from the Admin panel to get started.
            </div>
          </div>
        ) : (
          /* Card grid */
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 16,
              alignItems: 'stretch',
            }}
          >
            {agentsList.map((agent) => (
              <div
                key={agent.id}
                onClick={() => setDetailAgentId(agent.id)}
                style={{
                  cursor: 'pointer',
                  borderRadius: tokens.radii.lg,
                }}
              >
                <AgentCard
                  agent={agent}
                  onOpenDetail={() => setDetailAgentId(agent.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Agent detail modal */}
      {detailAgentId && (
        <AgentDetailModal
          agentId={detailAgentId}
          onClose={() => setDetailAgentId(null)}
          onDeleted={(deletedId) => {
            // Optimistic removal so the card disappears instantly; the
            // subsequent loadSnapshot() is the authoritative truth.
            setAgents((prev) => (prev ? prev.filter((a) => a.id !== deletedId) : prev));
            setDetailAgentId(null);
            loadSnapshot();
          }}
        />
      )}

      {/* Create Agent modal */}
      {showCreateModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setShowCreateModal(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: tokens.colors.surfaceCard, borderRadius: tokens.radii.xl, padding: 24, width: 440,
            border: `1px solid ${tokens.colors.border}`,
          }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 16 }}>
              New AI Agent
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Name *</label>
                <input
                  value={createForm.name}
                  onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Agent name"
                  autoFocus
                  style={{
                    width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                    padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px', outline: 'none', boxSizing: 'border-box',
                  }}
                  onKeyDown={e => { if (e.key === 'Enter' && createForm.name.trim()) handleCreateAgent(); }}
                />
              </div>
              <div>
                <label style={{ fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Description</label>
                <input
                  value={createForm.description}
                  onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="What does this agent do?"
                  style={{
                    width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                    padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px', outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Type</label>
                <select
                  value={createForm.type}
                  onChange={e => setCreateForm(f => ({ ...f, type: e.target.value }))}
                  style={{
                    width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                    padding: '8px 10px', color: tokens.colors.textStrong, fontSize: '13px', boxSizing: 'border-box',
                  }}
                >
                  <option value="claude">Claude</option>
                  <option value="gpt">GPT</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setShowCreateModal(false)} style={{
                background: 'transparent', color: tokens.colors.textSecondary, border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md, padding: '6px 14px', fontSize: '12px', cursor: 'pointer',
              }}>Cancel</button>
              <button
                onClick={handleCreateAgent}
                disabled={!createForm.name.trim() || creating}
                style={{
                  background: createForm.name.trim() && !creating ? tokens.colors.accent : tokens.colors.border, color: 'white',
                  border: 'none', borderRadius: tokens.radii.md, padding: '6px 14px', fontSize: '12px',
                  fontWeight: 600, cursor: createForm.name.trim() && !creating ? 'pointer' : 'not-allowed',
                }}
              >{creating ? 'Creating...' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
