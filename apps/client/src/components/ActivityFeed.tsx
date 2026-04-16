import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ActivityRow } from '../types';
import { tokens } from '../tokens';

/**
 * ActivityFeed — Phase 3 Plan 03-03 §Component Inventory #3.
 *
 * Scrollable list of workspace-wide activity. Pure presentation:
 * receives a pre-normalized ActivityRow[] from DashboardPage and renders
 * rows with timestamp, actor-type dot, actor name, action verb, and
 * optional target ticket link.
 *
 * Buffer cap (200 rows per D-47) is enforced by the parent. No real-time
 * stream here, no REST here, no state except per-link hover.
 *
 * The reconnect contract grep must return 0 against this file.
 */

interface ActivityFeedProps {
  rows: ActivityRow[];
  loading: boolean;
  maxHeight?: number | string;
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

function formatRowTimestamp(iso: string): string {
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

function getActorType(row: ActivityRow): 'agent' | 'user' | 'system' {
  const role = (row.role || '').toLowerCase();
  if (role === 'agent') return 'agent';
  if (role === 'user') return 'user';
  if (row.actor_id && row.actor_name) return 'user';
  return 'system';
}

interface ActivityRowItemProps {
  row: ActivityRow;
  isLast: boolean;
}

function ActivityRowItem({ row, isLast }: ActivityRowItemProps) {
  const navigate = useNavigate();
  const [rowHover, setRowHover] = useState(false);
  const [linkHover, setLinkHover] = useState(false);

  const actorType = getActorType(row);
  const dotBg = actorType === 'agent' ? tokens.colors.success : tokens.colors.accent;
  const verb = actionVerb(row.action);
  const timestamp = formatRowTimestamp(row.created_at);

  const targetTicketId = row.ticket_id || '';
  const targetTitle =
    row.ticket_title ||
    (row.action === 'ticket_moved' ? row.new_value : undefined) ||
    '';
  const newColumn =
    row.action === 'ticket_moved' ? row.new_value || '' : '';

  const handleLinkClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (targetTicketId) {
      navigate('/?ticket=' + encodeURIComponent(targetTicketId));
    }
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '12px 16px',
    minHeight: 48,
    background: rowHover ? tokens.colors.surfaceHover : 'transparent',
    borderBottom: isLast ? 'none' : `1px solid ${tokens.colors.border}`,
    transition: 'background 120ms ease-out',
    boxSizing: 'border-box',
  };

  const tsStyle: React.CSSProperties = {
    width: 56,
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 400,
    color: tokens.colors.textMuted,
    lineHeight: 1.5,
    textAlign: 'right',
    paddingTop: 2,
  };

  const actorDotStyle: React.CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: 2,
    flexShrink: 0,
    marginTop: 6,
    background: dotBg,
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: 400,
    color: tokens.colors.textSecondary,
    lineHeight: 1.5,
    wordBreak: 'break-word',
  };

  const linkStyle: React.CSSProperties = {
    color: linkHover ? tokens.colors.accentMid : tokens.colors.accent,
    cursor: 'pointer',
    textDecoration: 'none',
    fontWeight: 400,
  };

  return (
    <div
      style={rowStyle}
      onMouseEnter={() => setRowHover(true)}
      onMouseLeave={() => setRowHover(false)}
    >
      <div style={tsStyle}>{timestamp}</div>
      <div style={actorDotStyle} />
      <div style={contentStyle}>
        {row.actor_name ? (
          <>
            <span style={{ color: tokens.colors.textStrong, fontWeight: 600 }}>{row.actor_name}</span>{' '}
          </>
        ) : null}
        <span>{verb}</span>
        {targetTitle && targetTicketId ? (
          <>
            {' '}
            <a
              onClick={handleLinkClick}
              onMouseEnter={() => setLinkHover(true)}
              onMouseLeave={() => setLinkHover(false)}
              style={linkStyle}
            >
              {targetTitle}
            </a>
            {row.action === 'ticket_moved' && newColumn ? (
              <span> → {newColumn}</span>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function ActivityFeed({ rows, loading, maxHeight }: ActivityFeedProps) {
  const containerStyle: React.CSSProperties = {
    background: tokens.colors.surfaceCard,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.lg,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 320,
    maxHeight,
    boxSizing: 'border-box',
  };

  const scrollStyle: React.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
  };

  const isEmpty = rows.length === 0 && !loading;
  const isLoading = rows.length === 0 && loading;

  const emptyCardStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    textAlign: 'center',
    color: tokens.colors.textSecondary,
    minHeight: 280,
  };

  if (isEmpty) {
    return (
      <div style={containerStyle}>
        <div style={emptyCardStyle}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: tokens.colors.textPrimary,
              marginBottom: 8,
              lineHeight: 1.2,
            }}
          >
            No activity yet
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 400,
              color: tokens.colors.textSecondary,
              lineHeight: 1.5,
              maxWidth: 320,
            }}
          >
            Ticket moves, comments, and agent claims will appear here in real time.
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={containerStyle}>
        <div style={scrollStyle}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                padding: '12px 16px',
                minHeight: 48,
                borderBottom: i === 2 ? 'none' : `1px solid ${tokens.colors.border}`,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <div style={{ width: 56, height: 11, background: tokens.colors.border, borderRadius: 2 }} />
              <div style={{ width: 8, height: 8, background: tokens.colors.border, borderRadius: 2 }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ width: '60%', height: 13, background: tokens.colors.border, borderRadius: 2 }} />
                <div style={{ width: '40%', height: 11, background: tokens.colors.border, borderRadius: 2 }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={scrollStyle}>
        {rows.map((row, idx) => (
          <ActivityRowItem
            key={row.row_id || row.id || `${row.action}-${row.created_at}-${idx}`}
            row={row}
            isLast={idx === rows.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
