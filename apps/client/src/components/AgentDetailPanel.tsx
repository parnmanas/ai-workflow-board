import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { AgentDetail, ActivityRow } from '../types';
import { tokens } from '../tokens';
import { formatAgentDisplayName } from '../utils/agentName';
import AgentFileBrowser from './AgentFileBrowser';

/**
 * AgentDetailPanel — Phase 6 Plan 06-05.
 *
 * Side panel rendered inside the react-resizable-panels right Panel.
 * Merges AgentDetailModal (view) + AgentManager (edit) into a single surface.
 *
 * Admin: editable role_prompt textarea + channel identities CRUD + Save button.
 * Non-admin: read-only view of role_prompt, channel identities, and activity feed.
 *
 * Activity feed is a snapshot at open time (close + reopen to refresh),
 * consistent with the AgentDetailModal contract.
 */

interface AgentDetailPanelProps {
  agent: any;
  isAdmin: boolean | undefined;
  onClose: () => void;
  onSave: (agentId: string, data: any) => Promise<void>;
  wsId: string | undefined;
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

export default function AgentDetailPanel({
  agent,
  isAdmin,
  onClose,
  onSave,
  wsId,
}: AgentDetailPanelProps) {
  const navigate = useNavigate();

  // Full agent detail (includes role_prompt, redacted flag)
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(true);

  // Edit state (admin only)
  const [rolePrompt, setRolePrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    if (!agent?.id) return;
    setLoadingDetail(true);
    setLoadError(null);
    const [a, b] = await Promise.allSettled([
      api.getAgent(agent.id),
      api.getAgentActivity(agent.id, { limit: 50 }),
    ]);
    if (a.status === 'fulfilled') {
      const d = a.value;
      setDetail(d);
      setRolePrompt(d.role_prompt || '');
    }
    if (b.status === 'fulfilled') {
      setActivity(b.value || []);
    }
    if (a.status === 'rejected') {
      setLoadError('Could not load agent details. Retry.');
    }
    setLoadingDetail(false);
  }, [agent?.id]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const handleSave = async () => {
    if (!detail) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(detail.id, {
        role_prompt: rolePrompt,
      });
    } catch (err: any) {
      setSaveError(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleTaskClick = (ticketId: string) => {
    if (wsId) {
      // Navigate to workspace boards index with ticket query param.
      // The /?ticket= pattern was removed in Phase 6 — use the workspace-scoped URL.
      navigate(`/ws/${wsId}/boards?ticket=${encodeURIComponent(ticketId)}`);
    } else {
      // wsId unavailable — suppress navigation rather than sending to a dead URL.
      console.warn('AgentDetailPanel: wsId is undefined, cannot navigate to ticket', ticketId);
    }
  };

  const isOnline = detail?.is_online ?? agent?.is_online ?? false;
  const agentName = formatAgentDisplayName(detail || agent || { name: 'Agent' });

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    color: tokens.colors.textSecondary,
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
    marginBottom: 8,
  };

  const inputStyle: React.CSSProperties = {
    background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    padding: '8px 10px',
    color: tokens.colors.textStrong,
    fontSize: 13,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };

  return (
    <div
      style={{
        background: tokens.colors.surfaceCard,
        borderLeft: `1px solid ${tokens.colors.border}`,
        padding: 16,
        height: '100%',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        boxSizing: 'border-box',
      }}
    >
      {/* ── Header ─────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {/* Avatar glyph */}
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              background: tokens.gradients.accent,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontSize: 14,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {agentName[0]?.toUpperCase() || '?'}
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: tokens.colors.textPrimary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {agentName}
            </div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: isOnline ? tokens.colors.success : tokens.colors.borderStrong,
                letterSpacing: '0.5px',
                textTransform: 'uppercase',
              }}
            >
              {isOnline ? 'ONLINE' : 'OFFLINE'}
            </div>
            {(detail?.id || agent?.id) && (
              <div
                title="Click to copy agent ID"
                onClick={() => {
                  const id = detail?.id || agent?.id || '';
                  navigator.clipboard?.writeText(id).catch(() => {});
                }}
                style={{
                  fontSize: 10,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: tokens.colors.textMuted,
                  marginTop: 2,
                  cursor: 'pointer',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 260,
                }}
              >
                {detail?.id || agent?.id}
              </div>
            )}
          </div>
        </div>
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          style={{
            background: tokens.colors.border,
            color: tokens.colors.textMuted,
            border: 'none',
            borderRadius: tokens.radii.sm,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: 16,
            flexShrink: 0,
          }}
          aria-label="Close panel"
        >
          x
        </button>
      </div>

      {/* Error banner */}
      {loadError && (
        <div
          style={{
            padding: '10px 12px',
            border: `1px solid ${tokens.colors.danger}`,
            borderRadius: tokens.radii.md,
            color: tokens.colors.danger,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
          role="alert"
        >
          <span>{loadError}</span>
          <button
            type="button"
            onClick={loadDetail}
            style={{
              background: 'transparent',
              color: tokens.colors.danger,
              border: `1px solid ${tokens.colors.danger}`,
              borderRadius: tokens.radii.sm,
              padding: '2px 8px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Role Prompt ─────────────────────────────────── */}
      <section>
        <div style={sectionLabelStyle}>Role Prompt</div>
        {isAdmin ? (
          <textarea
            value={rolePrompt}
            onChange={(e) => setRolePrompt(e.target.value)}
            placeholder="You are an agent responsible for..."
            style={{
              ...inputStyle,
              minHeight: 120,
              resize: 'vertical',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              lineHeight: 1.5,
            }}
          />
        ) : (
          <div
            style={{
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '10px 12px',
              color: detail?.redacted ? tokens.colors.textMuted : tokens.colors.textStrong,
              fontSize: 13,
              lineHeight: 1.5,
              minHeight: 60,
              fontStyle: detail?.redacted ? 'italic' : 'normal',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {loadingDetail
              ? 'Loading role prompt...'
              : detail?.redacted
              ? '(role prompt hidden)'
              : detail?.role_prompt || 'No role prompt set.'}
          </div>
        )}
      </section>

      {/* ── Activity Feed ────────────────────────────────── */}
      <section>
        <div style={sectionLabelStyle}>
          Activity
          {activity.length > 0 && (
            <span style={{ color: tokens.colors.textMuted, fontWeight: 400, marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>
              last {Math.min(activity.length, 50)}
            </span>
          )}
        </div>
        {loadingDetail ? (
          <div style={{ fontSize: 12, color: tokens.colors.borderStrong }}>Loading activity...</div>
        ) : activity.length === 0 ? (
          <div
            style={{
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '20px 16px',
              textAlign: 'center',
              color: tokens.colors.textMuted,
              fontSize: 13,
            }}
          >
            No recent activity for this agent.
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
            {activity.slice(0, 50).map((row, idx) => {
              const verb = actionVerb(row.action);
              const ts = formatActivityTimestamp(row.created_at);
              const targetTitle = row.ticket_title || (row.action === 'ticket_moved' ? row.new_value : '') || '';
              const newColumn = row.action === 'ticket_moved' ? row.new_value || '' : '';
              const isLast = idx === Math.min(activity.length, 50) - 1;
              return (
                <div
                  key={row.id || `${row.action}-${row.created_at}-${idx}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '10px 12px',
                    borderBottom: isLast ? 'none' : `1px solid ${tokens.colors.surfaceCard}`,
                  }}
                >
                  <div
                    style={{
                      width: 48,
                      flexShrink: 0,
                      fontSize: 11,
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
                      width: 6,
                      height: 6,
                      borderRadius: 2,
                      flexShrink: 0,
                      marginTop: 6,
                      background: tokens.colors.success,
                    }}
                  />
                  <div
                    style={{
                      flex: 1,
                      fontSize: 13,
                      color: tokens.colors.textStrong,
                      lineHeight: 1.5,
                      wordBreak: 'break-word',
                      minWidth: 0,
                    }}
                  >
                    <span style={{ color: tokens.colors.textSecondary }}>{verb}</span>
                    {targetTitle && row.ticket_id ? (
                      <>
                        {' '}
                        <a
                          onClick={() => handleTaskClick(row.ticket_id!)}
                          style={{ color: tokens.colors.accent, cursor: 'pointer', textDecoration: 'none' }}
                        >
                          {targetTitle}
                        </a>
                        {row.action === 'ticket_moved' && newColumn ? (
                          <span style={{ color: tokens.colors.textSecondary }}>{' → '}{newColumn}</span>
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

      {/* ── File browser (v0.31.0) ───────────────────────── */}
      <section style={{ marginTop: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: tokens.colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>
          Files
        </div>
        <AgentFileBrowser agentId={agent.id} isOnline={!!agent.is_online} />
      </section>

      {/* ── Save changes (admin only) ────────────────────── */}
      {isAdmin && (
        <div style={{ flexShrink: 0 }}>
          {saveError && (
            <div style={{ fontSize: 12, color: tokens.colors.danger, marginBottom: 6 }}>{saveError}</div>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            style={{
              background: tokens.colors.accent,
              color: 'white',
              border: 'none',
              borderRadius: tokens.radii.md,
              padding: '10px 20px',
              fontSize: 13,
              fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              width: '100%',
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
}
