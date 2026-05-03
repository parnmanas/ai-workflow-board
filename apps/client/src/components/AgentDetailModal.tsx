import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import type { AgentDetail, ActivityRow, AgentLiveSession } from '../types';
import { tokens } from '../tokens';
import { formatAgentDisplayName } from '../utils/agentName';
import AgentFileBrowser from './AgentFileBrowser';
import AgentSubagentsPanel from './AgentSubagentsPanel';
import { useParams } from 'react-router-dom';

/**
 * AgentDetailModal — Phase 3 Plan 03-03 §Component Inventory #4.
 *
 * Per-agent detail surface opened from an AgentCard. Reuses the
 * TicketDetail.tsx backdrop + right-panel idiom verbatim. Fetches
 * GET /api/agents/:id and GET /api/agents/:id/activity in parallel
 * via Promise.allSettled on mount (and on agentId change).
 *
 * Role prompt visibility is driven by the server-side `redacted` flag
 * per D-44 — the client NEVER trusts a local permission check. When
 * `detail.redacted === true` the body renders the D-44 redaction
 * placeholder verbatim; admins see the prompt in a monospace scroll block.
 *
 * Live header subtitle: subscribes to agent_status envelopes via the
 * shared envelope bus and merges the payload when scope.agent_id
 * matches. RECENT ACTIVITY is seeded from a fetch on mount and kept live
 * via board_update SSE so users sitting on the page see new entries
 * appear without refreshing (route move in v0.32.x — used to be a
 * close+reopen-to-refresh modal).
 *
 * The reconnect contract grep must return 0 against this file.
 */

interface AgentDetailModalProps {
  agentId: string;
  onClose: () => void;
  // Called after a successful delete so the parent page can refresh its
  // snapshot. Optional so callers that don't care about deletions don't
  // have to pass a no-op.
  onDeleted?: (agentId: string) => void;
}

const ACTION_VERB: Record<string, string> = {
  ticket_created: 'created',
  ticket_moved: 'moved',
  ticket_updated: 'updated',
  comment_added: 'commented on',
  agent_trigger: 'claimed',
  trigger_claimed: 'claimed',
  agent_trigger_resolved: 'resolved',
  proxy_connected: 'proxy connected',
  proxy_disconnected: 'proxy disconnected',
};

function actionVerb(action: string): string {
  return ACTION_VERB[action] || 'updated';
}

/**
 * For proxy_connected / proxy_disconnected ActivityLog rows the server
 * stamps `new_value` with the SseSessionDetail JSON. Pull the session_id
 * out so the Recent Activity row can show which connection the event
 * corresponds to. Returns null on any non-matching row or parse failure.
 */
function extractProxySessionId(row: { action?: string; new_value?: string | null }): string | null {
  if (row.action !== 'proxy_connected' && row.action !== 'proxy_disconnected') return null;
  if (!row.new_value) return null;
  try {
    const parsed = JSON.parse(row.new_value);
    return typeof parsed?.session_id === 'string' ? parsed.session_id : null;
  } catch {
    return null;
  }
}

function formatClaimedTime(claimedAt: string): string {
  const d = new Date(claimedAt);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatElapsed(claimedAt: string): string {
  const d = new Date(claimedAt);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Math.max(0, Date.now() - d.getTime());
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just started';
  if (mins < 60) return `${mins}m elapsed`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

function formatRelative(timestamp: string | null): string {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Math.max(0, Date.now() - d.getTime());
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatActivityTimestamp(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Math.max(0, Date.now() - d.getTime());
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function AgentDetailModal({ agentId, onClose, onDeleted }: AgentDetailModalProps) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const handleDeleteAgent = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.deleteAgent(agentId);
      showToast('Agent deleted', 'success');
      onDeleted?.(agentId);
      onClose();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete agent', 'error');
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };
  const navigate = useNavigate();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [recentActivity, setRecentActivity] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'info' | 'files' | 'subagents'>('info');
  const { wsId } = useParams<{ wsId: string }>();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // Inline edit state for the basic agent fields exposed in the header /
  // INFO tab. Server-side `redacted: false` already implies the viewer has
  // MANAGE_AGENTS permission (see agents.controller.ts), so we let any non-
  // redacted viewer edit. The Save button issues a single PATCH and merges
  // the response back into `detail` so the header refreshes without a
  // round-trip GET.
  const canEdit = !!detail && !detail.redacted;
  const [editing, setEditing] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editAvatarUrl, setEditAvatarUrl] = useState('');

  const beginEdit = () => {
    if (!detail) return;
    setEditName(detail.name || '');
    setEditDescription(detail.description || '');
    setEditAvatarUrl(detail.avatar_url || '');
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const saveEdit = async () => {
    if (!detail || savingEdit) return;
    const trimmedName = editName.trim();
    if (!trimmedName) {
      showToast('Name cannot be empty', 'error');
      return;
    }
    setSavingEdit(true);
    try {
      const updated = await api.updateAgent(detail.id, {
        name: trimmedName,
        description: editDescription,
        avatar_url: editAvatarUrl,
      });
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              name: updated.name ?? trimmedName,
              description: updated.description ?? editDescription,
              avatar_url: updated.avatar_url ?? editAvatarUrl,
            }
          : prev,
      );
      setEditing(false);
      showToast('Agent updated', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Failed to update agent', 'error');
    } finally {
      setSavingEdit(false);
    }
  };

  const [liveSessions, setLiveSessions] = useState<AgentLiveSession[]>([]);
  // Total rows in the unified SESSIONS panel (proxy + manager-derived).
  const sessionCount = liveSessions.length;
  // Proxy-only count drives the routing-collision warning ("⚠ multiple")
  // and the main-pin selector — manager rows don't participate in
  // AGENT_ROUTED_EVENTS routing, so they don't contribute to that signal.
  const proxySessions = liveSessions.filter((s) => s.source === 'proxy');
  const proxyCount = proxySessions.length;
  // Disable buttons during a pin/clear round-trip so a fast double-click
  // can't flip the pinning between two sessions before the first POST settles.
  const [pinningSessionId, setPinningSessionId] = useState<string | null>(null);

  const refreshProxySessions = async () => {
    try {
      const map = await api.getActiveAgentSessions();
      setLiveSessions(map?.[agentId] ?? []);
    } catch {
      /* swallow — modal stays usable, surface label keeps last value */
    }
  };

  const handlePinMain = async (sessionId: string) => {
    if (pinningSessionId) return;
    setPinningSessionId(sessionId);
    try {
      const r = await api.setAgentMainSession(agentId, sessionId);
      if (r?.ok) {
        showToast('Main session updated', 'success');
        await refreshProxySessions();
      } else {
        showToast(r?.error || 'Failed to pin main session', 'error');
      }
    } catch (err: any) {
      showToast(err?.message || 'Failed to pin main session', 'error');
    } finally {
      setPinningSessionId(null);
    }
  };

  const handleClearMain = async () => {
    if (pinningSessionId) return;
    setPinningSessionId('__clear__');
    try {
      const r = await api.clearAgentMainSession(agentId);
      if (r?.ok) {
        showToast('Main session cleared (auto)', 'success');
        await refreshProxySessions();
      } else {
        showToast('Failed to clear main session', 'error');
      }
    } catch (err: any) {
      showToast(err?.message || 'Failed to clear main session', 'error');
    } finally {
      setPinningSessionId(null);
    }
  };

  const loadDetail = async () => {
    setLoading(true);
    setError(null);
    setDetail(null);
    setRecentActivity([]);
    const [a, b, c] = await Promise.allSettled([
      api.getAgent(agentId),
      api.getAgentActivity(agentId, { limit: 50 }),
      api.getActiveAgentSessions(),
    ]);
    if (a.status === 'fulfilled') setDetail(a.value);
    if (b.status === 'fulfilled') setRecentActivity(b.value || []);
    if (c.status === 'fulfilled') setLiveSessions(c.value?.[agentId] ?? []);
    if (a.status === 'rejected' || b.status === 'rejected') {
      setError('Could not load agent details. Retry.');
    }
    setLoading(false);
  };

  useEffect(() => {
    loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Move focus to the close button on mount for keyboard users.
  useEffect(() => {
    const t = setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Live header subtitle: merge agent_status updates for this agent.
  useBoardStreamEvent('agent_status', (envelope: any) => {
    const payload = envelope?.payload;
    if (!payload || payload.agent_id !== agentId) return;
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            is_online: !!payload.is_online,
            last_seen_at: payload.last_seen_at ?? prev.last_seen_at,
            current_task: payload.current_task,
          }
        : prev,
    );
  });

  // Live activity feed: prepend board_update events authored by this agent.
  // Page mode (route, not modal) means the user can sit on this view across
  // many ticket transitions, so a static snapshot quickly stales. Cap the
  // list at 50 entries to match the original page-load fetch limit.
  useBoardStreamEvent('board_update', (data: any) => {
    if (!data || !agentId) return;
    // board_update payload is flattened on the wire — actor identity lives
    // at the top level. Match by actor_id when present (most reliable);
    // fall back to actor_name when actor_id is missing on the wire.
    const matchesActor =
      (data.actor_id && data.actor_id === agentId) ||
      (data.actor_name && detail?.name && data.actor_name === detail.name);
    if (!matchesActor) return;
    const row: ActivityRow = {
      id: `live-${data.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      entity_type: data.entity_type,
      action: data.action,
      field_changed: data.field_changed || undefined,
      actor_id: data.actor_id || agentId,
      actor_name: data.actor_name || detail?.name || '',
      ticket_id: data.ticket_id || undefined,
      created_at: data.timestamp || new Date().toISOString(),
    };
    setRecentActivity((prev) => {
      const next = [row, ...prev];
      return next.length > 50 ? next.slice(0, 50) : next;
    });
  });

  // Escape key + body scroll lock.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const isOnline = !!detail?.is_online;
  const hasTask = !!detail?.current_task;
  const glyph = detail?.name?.[0]?.toUpperCase() || '?';
  const subtitleStatusColor = isOnline ? tokens.colors.success : tokens.colors.textMuted;
  const subtitleStatusLabel = isOnline ? 'ONLINE' : 'OFFLINE';
  const subtitleTail = detail?.last_seen_at
    ? ` · last seen ${formatRelative(detail.last_seen_at)}`
    : ' · never connected';
  // Surface live-session count (proxy + manager) so the user sees what's
  // keeping the agent online. The "⚠ multiple" warning still fires only on
  // 2+ proxy-source rows because that's the orphan-cleanup race scenario
  // that silently kills subagents mid-turn — manager-source rows don't
  // collide because they don't pin AGENT_ROUTED_EVENTS.
  const proxyTail = sessionCount > 0
    ? ` · ${sessionCount} session${sessionCount === 1 ? '' : 's'}${proxyCount > 1 ? ' ⚠ multiple proxies' : ''}`
    : '';

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: tokens.colors.textSecondary,
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
    marginBottom: 8,
  };

  const cardStyle: React.CSSProperties = {
    background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    padding: 16,
    color: tokens.colors.textStrong,
    fontSize: 13,
    lineHeight: 1.5,
  };

  const linkStyle: React.CSSProperties = {
    color: tokens.colors.accent,
    cursor: 'pointer',
    textDecoration: 'none',
    fontWeight: 400,
  };

  const handleTaskClick = (ticketId: string) => {
    navigate('/?ticket=' + encodeURIComponent(ticketId));
  };

  return (
    <>
      {/* Page mode (since v0.32.x): the agent detail used to render as a modal
         over the agents grid, but Refresh would close the panel and there
         wasn't enough horizontal room for the Subagents transcript. The
         component now sits inside AppLayout's content area as a full route
         (`/ws/:wsId/agents/:agentId`), so the wrapper is a flex column that
         fills its parent — no backdrop, no fixed positioning. */}
      <div
        role="region"
        aria-labelledby="agent-detail-title"
        style={{
          // height:100% snaps to .awb-content's flex-allocated height. flex:1
          // doesn't work here because .awb-content is display:block, not a
          // flex container — the wrapper grew to natural content size and
          // .awb-content's overflow-y:auto produced an outer scrollbar that
          // duplicated the inner RECENT ACTIVITY scroll.
          height: '100%',
          background: tokens.colors.surfaceCard,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 24px',
            borderBottom: `1px solid ${tokens.colors.border}`,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          {/* 48x48 avatar circle */}
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              background: tokens.gradients.accent,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontSize: 18,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {glyph}
          </div>
          {/* Title column */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {editing ? (
              <input
                aria-label="Agent name"
                id="agent-detail-title"
                value={editName}
                disabled={savingEdit}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
                  if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                }}
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  width: '100%',
                  background: tokens.colors.surface,
                  color: tokens.colors.textPrimary,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  padding: '4px 8px',
                  boxSizing: 'border-box',
                  fontFamily: 'inherit',
                }}
              />
            ) : (
              <div
                id="agent-detail-title"
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: tokens.colors.textPrimary,
                  lineHeight: 1.2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {detail ? formatAgentDisplayName(detail) : (loading ? 'Loading...' : 'Agent')}
              </div>
            )}
            <div
              style={{
                fontSize: 13,
                fontWeight: 400,
                color: tokens.colors.textSecondary,
                lineHeight: 1.5,
                marginTop: 2,
              }}
            >
              <span style={{ color: subtitleStatusColor, fontWeight: 600 }}>
                {subtitleStatusLabel}
              </span>
              <span>{subtitleTail}</span>
              {proxyTail && (
                <span style={{ color: proxyCount > 1 ? tokens.colors.warning : tokens.colors.textMuted, fontWeight: proxyCount > 1 ? 600 : 400 }}>
                  {proxyTail}
                </span>
              )}
            </div>
            {detail?.id && (
              <div
                title="Click to copy agent ID"
                onClick={() => { navigator.clipboard?.writeText(detail.id).catch(() => {}); }}
                style={{
                  fontSize: 11,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: tokens.colors.textMuted,
                  marginTop: 4,
                  cursor: 'pointer',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {detail.id}
              </div>
            )}
          </div>
          {/* Delete + close — delete is admin-only, and uses a two-click
              confirmation inline instead of a separate modal so we don't
              stack overlays. First click arms "Confirm delete", second
              click commits. Clicking away cancels via onBlur. */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            {canEdit && !editing && !confirmingDelete && (
              <button
                type="button"
                onClick={beginEdit}
                title="Edit agent details"
                style={{
                  background: 'transparent',
                  color: tokens.colors.textPrimary,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  padding: '4px 10px',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Edit
              </button>
            )}
            {editing && (
              <>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={savingEdit}
                  style={{
                    background: tokens.colors.accent,
                    color: '#fff',
                    border: 'none',
                    borderRadius: tokens.radii.md,
                    padding: '4px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: savingEdit ? 'not-allowed' : 'pointer',
                  }}
                >
                  {savingEdit ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={savingEdit}
                  style={{
                    background: 'transparent',
                    color: tokens.colors.textSecondary,
                    border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.md,
                    padding: '4px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </>
            )}
            {user?.role === 'admin' && (
              confirmingDelete ? (
                <>
                  <button
                    type="button"
                    onClick={handleDeleteAgent}
                    disabled={deleting}
                    style={{
                      background: tokens.colors.dangerMid,
                      color: '#fff',
                      border: 'none',
                      borderRadius: tokens.radii.md,
                      padding: '4px 12px',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: deleting ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {deleting ? 'Deleting...' : 'Confirm delete'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                    style={{
                      background: 'transparent',
                      color: tokens.colors.textSecondary,
                      border: `1px solid ${tokens.colors.border}`,
                      borderRadius: tokens.radii.md,
                      padding: '4px 10px',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  title="Delete this agent"
                  style={{
                    background: 'transparent',
                    color: tokens.colors.dangerLight,
                    border: `1px solid ${tokens.colors.dangerBg}`,
                    borderRadius: tokens.radii.md,
                    padding: '4px 10px',
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Delete
                </button>
              )
            )}
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              style={{
                background: tokens.colors.border,
                color: tokens.colors.textStrong,
                border: 'none',
                borderRadius: tokens.radii.md,
                padding: '4px 12px',
                fontSize: 16,
                cursor: 'pointer',
              }}
              aria-label="Close agent detail"
            >
              x
            </button>
          </div>
        </div>

        {/* Scroll body — outer scroll kicks in only when the viewport is
            shorter than the sum of every section's min-height. In tall
            viewports, RECENT ACTIVITY (INFO) and the FILES panel still
            flex-grow into remaining space and scroll *inside* themselves
            — single scrollbar, no duplicate. SUBAGENTS uses its own
            inner two-pane scroll and ignores the outer one because the
            tab content fits within the body height. */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
            minHeight: 0,
          }}
        >
          {/* Error banner */}
          {error && (
            <div
              style={{
                padding: '12px 16px',
                background: 'transparent',
                border: `1px solid ${tokens.colors.danger}`,
                borderRadius: tokens.radii.md,
                color: tokens.colors.danger,
                fontSize: 13,
                fontWeight: 400,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
              role="alert"
            >
              <span>{error}</span>
              <button
                type="button"
                onClick={loadDetail}
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

          {/* Tab bar — two tabs: Info (existing info/activity sections) and
             Files (fs-browser). Rendered above the content so the scroll
             body keeps its current spacing without an extra wrapper. Sticky
             positioning keeps the tabs visible even when the file browser's
             text preview grows past one viewport. */}
          <div
            role="tablist"
            style={{
              position: 'sticky',
              top: -24,
              background: tokens.colors.surface,
              display: 'flex',
              gap: 4,
              borderBottom: `1px solid ${tokens.colors.border}`,
              marginTop: -8,
              marginBottom: -8,
              zIndex: 1,
            }}
          >
            {(['info', 'files', 'subagents'] as const).map((tab) => {
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    background: 'transparent',
                    color: isActive ? tokens.colors.textPrimary : tokens.colors.textMuted,
                    border: 'none',
                    borderBottom: `2px solid ${isActive ? tokens.colors.accent : 'transparent'}`,
                    padding: '8px 14px',
                    fontSize: 12,
                    fontWeight: isActive ? 600 : 500,
                    textTransform: 'uppercase',
                    letterSpacing: 0.6,
                    cursor: 'pointer',
                  }}
                >
                  {tab === 'info' ? 'Info' : tab === 'files' ? 'Files' : 'Subagents'}
                </button>
              );
            })}
          </div>

          {activeTab === 'info' && (
          <>
          {/* DETAILS section — description + avatar URL. Editable inline by
             admins (gated server-side by the `redacted` flag). When not in
             edit mode the section is skipped if both fields are empty so the
             panel stays compact for users who haven't filled them in. */}
          {(editing || (detail && (detail.description || detail.avatar_url))) && (
            <section>
              <div style={sectionLabelStyle}>DETAILS</div>
              <div style={cardStyle}>
                {editing ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textSecondary, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                        Description
                      </span>
                      <textarea
                        value={editDescription}
                        disabled={savingEdit}
                        onChange={(e) => setEditDescription(e.target.value)}
                        rows={3}
                        style={{
                          background: tokens.colors.surfaceCard,
                          color: tokens.colors.textStrong,
                          border: `1px solid ${tokens.colors.border}`,
                          borderRadius: tokens.radii.md,
                          padding: '6px 10px',
                          fontSize: 13,
                          lineHeight: 1.5,
                          resize: 'vertical',
                          fontFamily: 'inherit',
                        }}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textSecondary, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                        Avatar URL
                      </span>
                      <input
                        type="text"
                        value={editAvatarUrl}
                        disabled={savingEdit}
                        onChange={(e) => setEditAvatarUrl(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
                          if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                        }}
                        placeholder="https://..."
                        style={{
                          background: tokens.colors.surfaceCard,
                          color: tokens.colors.textStrong,
                          border: `1px solid ${tokens.colors.border}`,
                          borderRadius: tokens.radii.md,
                          padding: '6px 10px',
                          fontSize: 13,
                          fontFamily: 'inherit',
                        }}
                      />
                    </label>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {detail?.description && (
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {detail.description}
                      </div>
                    )}
                    {detail?.avatar_url && (
                      <div
                        style={{
                          fontSize: 11,
                          color: tokens.colors.textMuted,
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          wordBreak: 'break-all',
                        }}
                      >
                        {detail.avatar_url}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* SESSIONS section — what's currently keeping this agent online.
              Two row sources unified into one panel:
                • 'proxy' — a real SSE connection from a proxy.mjs instance.
                  More than one means multiple proxies are concurrently
                  connected (multi-terminal, or a single Claude CLI opening
                  more than one stream). This is the orphan-cleanup race
                  scenario that silently kills subagents mid-turn, so when
                  proxyCount > 1 the user picks one as "MAIN" and the server
                  routes ticket triggers + chat events only to that session
                  (see events.controller.ts AGENT_ROUTED_EVENTS).
                • 'manager' — synthesized from the agent-manager
                  InstanceRegistry. Managed agents never open their own SSE,
                  so without this row the panel would always be empty for
                  them even while their manager is heartbeating. Manager rows
                  do not participate in main-pin routing. */}
          <section>
            <div style={{ ...sectionLabelStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                SESSIONS
                {sessionCount > 0 && (
                  <span style={{
                    marginLeft: 8,
                    color: proxyCount > 1 ? tokens.colors.warning : tokens.colors.textMuted,
                    fontWeight: proxyCount > 1 ? 700 : 500,
                  }}>
                    ({sessionCount}){proxyCount > 1 ? ' ⚠ multiple proxies' : ''}
                  </span>
                )}
              </div>
              {proxyCount > 1 && proxySessions.some((s) => s.main_pinned) && (
                <button
                  type="button"
                  onClick={handleClearMain}
                  disabled={!!pinningSessionId}
                  title="Clear pinned main; fall back to oldest-connected"
                  style={{
                    background: 'transparent',
                    color: tokens.colors.textSecondary,
                    border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.sm,
                    padding: '2px 8px',
                    fontSize: 10,
                    fontWeight: 500,
                    letterSpacing: 0.4,
                    textTransform: 'none',
                    cursor: pinningSessionId ? 'not-allowed' : 'pointer',
                  }}
                >
                  Clear pin (auto)
                </button>
              )}
            </div>
            <div style={{ ...cardStyle, maxHeight: 240, overflowY: 'auto' }}>
              {sessionCount === 0 ? (
                <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>
                  No live session.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {proxyCount > 1 && (
                    <div style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
                      Pick the proxy that should receive ticket triggers and chat messages. Other
                      proxy sessions stay connected for observability but won't spawn subagents.
                    </div>
                  )}
                  {liveSessions.map((s) => {
                    const isManager = s.source === 'manager';
                    // Main-pin selector + MAIN badge are routing-only signals;
                    // manager rows never participate in routing so they're
                    // hidden there. Selector also stays hidden when there's
                    // only one proxy to pick (no ambiguity to resolve).
                    const showSelector = !isManager && proxyCount > 1;
                    const isPinned = !isManager && s.main_pinned;
                    const isAutoMain = !isManager && s.is_main && !s.main_pinned;
                    const showMainBadge = !isManager && s.is_main;
                    const rowBusy = pinningSessionId === s.session_id;
                    return (
                      <div
                        key={s.session_id}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 6,
                          background: showMainBadge ? tokens.colors.surface : tokens.colors.surfaceSubtle,
                          border: `1px solid ${showMainBadge ? tokens.colors.accent : tokens.colors.border}`,
                          fontSize: 12,
                          lineHeight: 1.5,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {showSelector && (
                            <label
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                cursor: pinningSessionId ? 'not-allowed' : 'pointer',
                                userSelect: 'none',
                              }}
                              title={isPinned ? 'Pinned as main' : 'Set as main'}
                            >
                              <input
                                type="radio"
                                name={`proxy-main-${agentId}`}
                                checked={isPinned}
                                disabled={!!pinningSessionId}
                                onChange={() => { handlePinMain(s.session_id); }}
                              />
                              <span style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textSecondary, letterSpacing: 0.3 }}>
                                {rowBusy ? 'Pinning...' : 'Set as main'}
                              </span>
                            </label>
                          )}
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: '1px 6px',
                              borderRadius: tokens.radii.sm,
                              background: 'transparent',
                              color: isManager ? tokens.colors.textSecondary : tokens.colors.textMuted,
                              border: `1px solid ${isManager ? tokens.colors.textSecondary : tokens.colors.border}`,
                              textTransform: 'uppercase',
                              letterSpacing: 0.6,
                            }}
                            title={isManager ? 'Synthesized from agent-manager InstanceRegistry' : 'Live proxy.mjs SSE connection'}
                          >
                            {isManager ? 'Manager' : 'Proxy'}
                          </span>
                          {showMainBadge && (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                padding: '1px 6px',
                                borderRadius: tokens.radii.sm,
                                background: isPinned ? tokens.colors.accent : 'transparent',
                                color: isPinned ? '#fff' : tokens.colors.accent,
                                border: `1px solid ${tokens.colors.accent}`,
                                textTransform: 'uppercase',
                                letterSpacing: 0.6,
                              }}
                              title={isPinned ? 'User-pinned main session' : 'Auto-selected main (oldest connected)'}
                            >
                              {isAutoMain ? 'Main · auto' : 'Main'}
                            </span>
                          )}
                        </div>
                        {isManager ? (
                          <>
                            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
                              <span>
                                <span style={{ color: tokens.colors.textMuted }}>via: </span>
                                <span style={{ fontFamily: 'monospace' }}>
                                  {s.manager_name || (s.manager_agent_id ? s.manager_agent_id.slice(0, 8) : 'unknown')}
                                </span>
                              </span>
                              <span>
                                <span style={{ color: tokens.colors.textMuted }}>cli: </span>
                                <span style={{ fontFamily: 'monospace' }}>
                                  {s.cli || 'unknown'}
                                  {s.cli_adapters && s.cli_adapters.length > 0
                                    ? ` (+${s.cli_adapters.length})`
                                    : ''}
                                </span>
                              </span>
                              <span>
                                <span style={{ color: tokens.colors.textMuted }}>version: </span>
                                <span style={{ fontFamily: 'monospace', color: s.plugin_version === 'unknown' ? tokens.colors.warning : undefined }}>
                                  {s.plugin_version || 'unknown'}
                                </span>
                              </span>
                              <span>
                                <span style={{ color: tokens.colors.textMuted }}>host: </span>
                                <span style={{ fontFamily: 'monospace' }}>{s.hostname || 'unknown'}</span>
                              </span>
                              {typeof s.pid === 'number' && s.pid > 0 && (
                                <span>
                                  <span style={{ color: tokens.colors.textMuted }}>pid: </span>
                                  <span style={{ fontFamily: 'monospace' }}>{s.pid}</span>
                                </span>
                              )}
                              {s.started_at && (
                                <span>
                                  <span style={{ color: tokens.colors.textMuted }}>uptime: </span>
                                  {formatRelative(s.started_at)}
                                </span>
                              )}
                              {s.paired_at && (
                                <span>
                                  <span style={{ color: tokens.colors.textMuted }}>paired: </span>
                                  {formatRelative(s.paired_at)}
                                </span>
                              )}
                            </div>
                            {s.working_dir && (
                              <div style={{ marginTop: 4, color: tokens.colors.textMuted, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                                cwd: {s.working_dir}
                              </div>
                            )}
                            {s.instance_id && (
                              <div style={{ marginTop: 4, color: tokens.colors.textDisabled, fontFamily: 'monospace', fontSize: 11 }}>
                                instance: {s.instance_id}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: showSelector || showMainBadge ? 4 : 0 }}>
                              <span>
                                <span style={{ color: tokens.colors.textMuted }}>connected: </span>
                                {formatRelative(s.connected_at)}
                              </span>
                              <span>
                                <span style={{ color: tokens.colors.textMuted }}>ip: </span>
                                <span style={{ fontFamily: 'monospace', color: s.ip === 'unknown' ? tokens.colors.warning : undefined }}>
                                  {s.ip || 'unknown'}
                                </span>
                              </span>
                              <span>
                                <span style={{ color: tokens.colors.textMuted }}>plugin: </span>
                                <span style={{ fontFamily: 'monospace', color: s.plugin_version === 'unknown' ? tokens.colors.warning : undefined }}>
                                  {s.plugin_version || 'unknown'}
                                </span>
                              </span>
                              {s.board_id && (
                                <span>
                                  <span style={{ color: tokens.colors.textMuted }}>board: </span>
                                  <span style={{ fontFamily: 'monospace' }}>{s.board_id.slice(0, 8)}</span>
                                </span>
                              )}
                            </div>
                            {s.user_agent && (
                              <div style={{ marginTop: 4, color: tokens.colors.textMuted, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                                {s.user_agent}
                              </div>
                            )}
                            <div style={{ marginTop: 4, color: tokens.colors.textDisabled, fontFamily: 'monospace', fontSize: 11 }}>
                              session: {s.session_id}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          {/* CURRENT TASK section */}
          <section>
            <div style={sectionLabelStyle}>CURRENT TASK</div>
            <div style={cardStyle}>
              {hasTask && detail?.current_task ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <a
                      onClick={() =>
                        handleTaskClick(detail.current_task!.ticket_id)
                      }
                      style={linkStyle}
                    >
                      {detail.current_task.ticket_title}
                    </a>
                    {detail.current_task.role && (
                      <span
                        title={`Working as ${detail.current_task.role}`}
                        style={{
                          fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: tokens.radii.sm,
                          border: `1px solid ${tokens.colors.border}`, color: tokens.colors.accentLight,
                          textTransform: 'uppercase', letterSpacing: 0.4,
                        }}
                      >as {detail.current_task.role}</span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 400,
                      color: tokens.colors.textMuted,
                      marginTop: 4,
                    }}
                  >
                    since {formatClaimedTime(detail.current_task.claimed_at)} ·{' '}
                    {formatElapsed(detail.current_task.claimed_at)}
                  </div>
                </>
              ) : (
                <div style={{ color: tokens.colors.textMuted, fontSize: 13, fontWeight: 400 }}>
                  Idle
                </div>
              )}
            </div>
          </section>

          {/* ROLE PROMPT section */}
          <section>
            <div style={sectionLabelStyle}>ROLE PROMPT</div>
            {detail && detail.redacted ? (
              <div
                style={{
                  padding: 12,
                  color: tokens.colors.textMuted,
                  fontStyle: 'italic',
                  fontSize: 13,
                  lineHeight: 1.5,
                  background: tokens.colors.surface,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  minHeight: 60,
                }}
              >
                (role prompt hidden)
              </div>
            ) : detail && detail.role_prompt ? (
              <pre
                style={{
                  margin: 0,
                  padding: 12,
                  background: tokens.colors.surface,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  fontFamily: 'monospace',
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: tokens.colors.textStrong,
                  whiteSpace: 'pre-wrap',
                  minHeight: 120,
                  maxHeight: 320,
                  overflow: 'auto',
                  wordBreak: 'break-word',
                }}
              >
                {detail.role_prompt}
              </pre>
            ) : (
              <div
                style={{
                  padding: 12,
                  color: tokens.colors.textMuted,
                  fontStyle: 'italic',
                  fontSize: 13,
                  lineHeight: 1.5,
                  background: tokens.colors.surface,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  minHeight: 60,
                }}
              >
                {loading ? 'Loading role prompt...' : 'No role prompt set.'}
              </div>
            )}
          </section>

          {/* RECENT ACTIVITY section. minHeight keeps the feed usable on
             short viewports — once the sum of sections + this min exceeds
             the modal body, the body's outer scroll kicks in instead of
             squeezing this panel down to a 1-row sliver. */}
          <section style={{ flex: 1, minHeight: 320, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: tokens.colors.textSecondary,
                  letterSpacing: '0.5px',
                  textTransform: 'uppercase',
                }}
              >
                RECENT ACTIVITY
              </div>
              {recentActivity.length > 0 && (
                <div
                  style={{ fontSize: 11, fontWeight: 400, color: tokens.colors.textMuted }}
                >
                  last {Math.min(recentActivity.length, 50)}
                </div>
              )}
            </div>
            {recentActivity.length === 0 ? (
              <div
                style={{
                  ...cardStyle,
                  textAlign: 'center',
                  padding: 24,
                  color: tokens.colors.textSecondary,
                }}
              >
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: tokens.colors.textPrimary,
                    marginBottom: 8,
                    lineHeight: 1.3,
                  }}
                >
                  No recent activity
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 400,
                    color: tokens.colors.textSecondary,
                    lineHeight: 1.5,
                  }}
                >
                  This agent has not performed any actions yet.
                </div>
              </div>
            ) : (
              <div
                style={{
                  background: tokens.colors.surface,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  // flex:1 + minHeight:0 — parent <section> is flex:1 with
                  // minHeight:320, modal body is overflowY:auto + flex
                  // column. On tall viewports this inner scroll engages
                  // first and the body never scrolls; on short ones the
                  // body's outer scroll takes over so the panel can keep
                  // its minHeight without clipping the sections above.
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                }}
              >
                {recentActivity.map((row, idx) => {
                  const verb = actionVerb(row.action);
                  const ts = formatActivityTimestamp(row.created_at);
                  const targetTitle =
                    row.ticket_title ||
                    (row.action === 'ticket_moved' ? row.new_value : '') ||
                    '';
                  const newColumn =
                    row.action === 'ticket_moved' ? row.new_value || '' : '';
                  const proxySessionId = extractProxySessionId(row);
                  const isLast = idx === recentActivity.length - 1;
                  return (
                    <div
                      key={row.id || `${row.action}-${row.created_at}-${idx}`}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 12,
                        padding: '12px 16px',
                        minHeight: 48,
                        borderBottom: isLast ? 'none' : `1px solid ${tokens.colors.border}`,
                        boxSizing: 'border-box',
                      }}
                    >
                      <div
                        style={{
                          width: 56,
                          flexShrink: 0,
                          fontSize: 11,
                          fontWeight: 400,
                          color: tokens.colors.textMuted,
                          lineHeight: 1.5,
                          textAlign: 'right',
                          paddingTop: 2,
                        }}
                      >
                        {ts}
                      </div>
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          flexShrink: 0,
                          marginTop: 6,
                          background: tokens.colors.success,
                        }}
                      />
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 13,
                          fontWeight: 400,
                          color: tokens.colors.textStrong,
                          lineHeight: 1.5,
                          wordBreak: 'break-word',
                        }}
                      >
                        <span style={{ color: tokens.colors.textSecondary }}>{verb}</span>
                        {targetTitle && row.ticket_id ? (
                          <>
                            {' '}
                            <a
                              onClick={() => handleTaskClick(row.ticket_id!)}
                              style={linkStyle}
                            >
                              {targetTitle}
                            </a>
                            {row.action === 'ticket_moved' && newColumn ? (
                              <span style={{ color: tokens.colors.textSecondary }}>
                                {' → '}
                                {newColumn}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                        {proxySessionId ? (
                          <>
                            {' '}
                            <span style={{ color: tokens.colors.textMuted, fontFamily: 'monospace', fontSize: 11 }}>
                              {proxySessionId}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          </>
          )}

          {/* FILES tab — the tab bar above gates visibility. The component
             is mounted only while the tab is active so it skips the initial
             /fs/roots fetch until the user asks for it. flex:1 lets the file
             browser claim remaining vertical space; minHeight:320 keeps it
             usable on short viewports (header + crumbs + listing + viewer
             would otherwise collapse) and pairs with the body's outer
             overflowY:auto so the page scrolls instead of clipping. */}
          {activeTab === 'files' && detail && (
            <div style={{ flex: 1, minHeight: 320, display: 'flex', flexDirection: 'column' }}>
              <AgentFileBrowser agentId={detail.id} isOnline={isOnline} />
            </div>
          )}

          {/* SUBAGENTS tab — live transcript of every subagent this agent's
             plugin has spawned. Filtered by detail.id so users see only the
             selected agent's traffic. */}
          {activeTab === 'subagents' && detail && (
            // flex: 1 (no fixed height) so the panel claims all remaining
            // modal body height, then AgentSubagentsPanel's own internal
            // flex layout sets independent overflows on the list (left)
            // and transcript (right). minHeight:0 is required for the
            // inner overflow:auto's to actually clip — without it the
            // flex item grows to its content size and clipping never
            // triggers, which is what made the list and transcript scroll
            // in lockstep with the outer modal.
            <div style={{ flex: 1, minHeight: 480, display: 'flex', minWidth: 0 }}>
              <AgentSubagentsPanel wsId={wsId} agentId={detail.id} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
