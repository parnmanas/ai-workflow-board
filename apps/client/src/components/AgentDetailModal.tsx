import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import type { AgentDetail, ActivityRow } from '../types';
import { tokens } from '../tokens';
import AgentFileBrowser from './AgentFileBrowser';

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
 * matches. The RECENT ACTIVITY list is intentionally NOT live-updated
 * (per UI-SPEC §Lifecycle: snapshot at open time; close+reopen to
 * refresh).
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
};

function actionVerb(action: string): string {
  return ACTION_VERB[action] || 'updated';
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
  const [activeTab, setActiveTab] = useState<'info' | 'files'>('info');
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const loadDetail = async () => {
    setLoading(true);
    setError(null);
    setDetail(null);
    setRecentActivity([]);
    const [a, b] = await Promise.allSettled([
      api.getAgent(agentId),
      api.getAgentActivity(agentId, { limit: 50 }),
    ]);
    if (a.status === 'fulfilled') setDetail(a.value);
    if (b.status === 'fulfilled') setRecentActivity(b.value || []);
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
      {/* Backdrop — identical idiom to TicketDetail.tsx */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.4)',
          zIndex: 1000,
        }}
      />

      {/* Right panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-detail-title"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 640,
          maxWidth: '100vw',
          background: tokens.colors.surfaceCard,
          borderLeft: `1px solid ${tokens.colors.border}`,
          zIndex: 1001,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: tokens.shadows.panel,
          animation: 'slideInRight 0.2s ease-out',
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
              {detail?.name || (loading ? 'Loading...' : 'Agent')}
            </div>
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

        {/* Scroll body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
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
            {(['info', 'files'] as const).map((tab) => {
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
                  {tab === 'info' ? 'Info' : 'Files'}
                </button>
              );
            })}
          </div>

          {activeTab === 'info' && (
          <>
          {/* CURRENT TASK section */}
          <section>
            <div style={sectionLabelStyle}>CURRENT TASK</div>
            <div style={cardStyle}>
              {hasTask && detail?.current_task ? (
                <>
                  <div>
                    <a
                      onClick={() =>
                        handleTaskClick(detail.current_task!.ticket_id)
                      }
                      style={linkStyle}
                    >
                      {detail.current_task.ticket_title}
                    </a>
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

          {/* RECENT ACTIVITY section */}
          <section>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
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
                  overflow: 'hidden',
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
             /fs/roots fetch until the user asks for it. */}
          {activeTab === 'files' && detail && (
            <AgentFileBrowser agentId={detail.id} isOnline={isOnline} />
          )}
        </div>
      </div>
    </>
  );
}
