import React, { useState } from 'react';
import type { DashboardAgent } from '../types';
import { tokens } from '../tokens';
import { Badge } from './common';

/**
 * AgentCard — Phase 3 Plan 03-03 §Component Inventory #2.
 *
 * Single-agent tile in the dashboard grid. Read-only: shows avatar with
 * online/offline dot, name + status label, current task (or idle), and a
 * "View details" button that opens the AgentDetailModal via callback.
 *
 * This component is a pure presentation surface. It never opens a
 * real-time stream client and never imports the shared envelope bus —
 * live updates flow through the parent DashboardPage which merges
 * agent_status envelopes into its state and re-renders AgentCard.
 *
 * The reconnect contract grep must return 0 against this file.
 */

interface AgentCardProps {
  agent: DashboardAgent;
  onOpenDetail: (agentId: string) => void;
}

function formatClaimedTime(claimedAt: string | Date): string {
  const d = typeof claimedAt === 'string' ? new Date(claimedAt) : claimedAt;
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatElapsed(claimedAt: string | Date): string {
  const d = typeof claimedAt === 'string' ? new Date(claimedAt) : claimedAt;
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Math.max(0, Date.now() - d.getTime());
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just started';
  if (mins < 60) return `${mins}m elapsed`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function formatRelative(timestamp: string | Date | null): string {
  if (!timestamp) return '';
  const d = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
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

export default function AgentCard({ agent, onOpenDetail }: AgentCardProps) {
  const [cardHover, setCardHover] = useState(false);
  const [btnHover, setBtnHover] = useState(false);

  const isOnline = agent.is_online === true;
  const hasTask = !!agent.current_task;
  const glyph = (agent.name && agent.name[0] ? agent.name[0] : '?').toUpperCase();

  const handleOpen = () => onOpenDetail(agent.id);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOpen();
    }
  };

  const containerStyle: React.CSSProperties = {
    background: tokens.colors.surfaceCard,
    border: `1px solid ${cardHover ? tokens.colors.accent : tokens.colors.border}`,
    borderRadius: tokens.radii.lg,
    padding: tokens.spacing.md,
    minHeight: 136,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    cursor: 'pointer',
    transition: 'border-color 120ms ease-out, background 120ms ease-out',
    boxSizing: 'border-box',
  };

  const avatarBlockStyle: React.CSSProperties = {
    position: 'relative',
    width: 40,
    height: 40,
    flexShrink: 0,
  };

  const avatarCircleStyle: React.CSSProperties = {
    width: 40,
    height: 40,
    borderRadius: 20,
    background: tokens.gradients.accent,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'white',
    fontSize: 15,
    fontWeight: 700,
  };

  const dotWrapperStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: 0,
    right: 0,
    border: `2px solid ${tokens.colors.surfaceCard}`,
    borderRadius: tokens.radii.full,
    boxSizing: 'border-box',
    display: 'flex',
  };

  const nameStyle: React.CSSProperties = {
    fontSize: 15,
    fontWeight: 700,
    color: tokens.colors.textPrimary,
    lineHeight: 1.3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const subMetaStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 400,
    color: tokens.colors.textMuted,
  };

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: tokens.colors.textSecondary,
    letterSpacing: '0.3px',
    textTransform: 'uppercase',
  };

  const taskTitleStyle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 400,
    color: tokens.colors.textStrong,
    lineHeight: 1.5,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    wordBreak: 'break-word',
  };

  const taskMetaStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 400,
    color: tokens.colors.textMuted,
    marginTop: 2,
  };

  const idleValueStyle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 400,
    color: tokens.colors.textMuted,
  };

  const buttonStyle: React.CSSProperties = {
    width: '100%',
    height: 32,
    background: btnHover ? tokens.colors.accent : tokens.colors.border,
    color: btnHover ? 'white' : tokens.colors.textStrong,
    border: 'none',
    borderRadius: tokens.radii.md,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 120ms ease-out, color 120ms ease-out',
    marginTop: 'auto',
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setCardHover(true)}
      onMouseLeave={() => setCardHover(false)}
      onFocus={(e) => {
        (e.currentTarget as HTMLDivElement).style.outline = `2px solid ${tokens.colors.accent}`;
        (e.currentTarget as HTMLDivElement).style.outlineOffset = '-2px';
      }}
      onBlur={(e) => {
        (e.currentTarget as HTMLDivElement).style.outline = 'none';
      }}
      style={containerStyle}
      aria-label={`Agent ${agent.name}, ${isOnline ? 'online' : 'offline'}`}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={avatarBlockStyle}>
          <div style={avatarCircleStyle}>{glyph}</div>
          <span style={dotWrapperStyle}>
            <Badge variant={isOnline ? 'success' : 'neutral'} dot />
          </span>
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div style={nameStyle}>{agent.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Badge variant={isOnline ? 'success' : 'neutral'}>{isOnline ? 'ONLINE' : 'OFFLINE'}</Badge>
            {!isOnline && (
              <>
                <span style={subMetaStyle}>·</span>
                <span style={subMetaStyle}>
                  {agent.last_seen_at
                    ? `last seen ${formatRelative(agent.last_seen_at)}`
                    : 'never connected'}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Current task block / Idle */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          flex: 1,
          minWidth: 0,
        }}
      >
        <div style={sectionLabelStyle}>{hasTask ? 'CURRENT TASK' : 'STATUS'}</div>
        {hasTask && agent.current_task ? (
          <div>
            <div style={taskTitleStyle}>{agent.current_task.ticket_title}</div>
            <div style={taskMetaStyle}>
              since {formatClaimedTime(agent.current_task.claimed_at)} ·{' '}
              {formatElapsed(agent.current_task.claimed_at)}
            </div>
          </div>
        ) : (
          <div style={idleValueStyle}>Idle</div>
        )}
      </div>

      {/* Details CTA button */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleOpen();
        }}
        onMouseEnter={() => setBtnHover(true)}
        onMouseLeave={() => setBtnHover(false)}
        style={buttonStyle}
      >
        View details
      </button>
    </div>
  );
}
