import React, { useState } from 'react';
import type { DashboardAgent, AgentManagerInstance, AgentCurrentTask, AgentLifecycleState } from '../types';
import { tokens } from '../tokens';
import { Badge } from './common';
import { formatAgentDisplayName } from '../utils/agentName';
import AgentLifecycleControls from './AgentLifecycleControls';

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
  /** Owning manager's live instance (resolved by the parent from the agent's
   *  manager_agent_id). Present only for managed agents whose manager is
   *  heartbeating; drives the running/stopped badge + lifecycle dispatch. */
  managerInstance?: AgentManagerInstance | null;
  /** Lifecycle actions are admin-only (the server command endpoint is
   *  ADMIN_ACCESS-gated); non-admins never see the control row. */
  isAdmin?: boolean;
  /** Called after a lifecycle command dispatches so the parent can re-fetch
   *  manager instances (real state still arrives via the next heartbeat). */
  onLifecycleDispatched?: () => void;
}

// Card is a summary tile — cap the visible task rows and roll the rest into a
// "+N more" line. The full list lives in AgentDetailModal.
const CARD_TASK_PREVIEW_LIMIT = 3;

// 5-state lifecycle badge (ticket bfdd80b7). Maps the server's lifecycle_state to
// a Badge variant + label so the tile shows the auto-start gap (미시작/시작 중/
// 오류) instead of a flat ONLINE/OFFLINE.
const LIFECYCLE_BADGE: Record<
  AgentLifecycleState,
  { variant: 'success' | 'warning' | 'info' | 'neutral' | 'danger'; label: string }
> = {
  online: { variant: 'success', label: 'ONLINE' },
  starting: { variant: 'warning', label: '시작 중' },
  never_started: { variant: 'neutral', label: '미시작' },
  offline: { variant: 'neutral', label: 'OFFLINE' },
  error: { variant: 'danger', label: '오류' },
};

// Prefer the server's authoritative lifecycle_state; fall back to deriving from
// the binary online/seen signals so agents from an older server (no
// lifecycle_state) still render a sensible badge.
function resolveLifecycle(agent: DashboardAgent): AgentLifecycleState {
  if (agent.lifecycle_state) return agent.lifecycle_state;
  if (agent.is_online) return 'online';
  // Never connected AND never seen → treat as never-started; otherwise it has
  // been online at some point, so it's offline.
  if (!agent.last_seen_at && !agent.connected_at) return 'never_started';
  return 'offline';
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

export default function AgentCard({
  agent,
  onOpenDetail,
  managerInstance,
  isAdmin,
  onLifecycleDispatched,
}: AgentCardProps) {
  const [cardHover, setCardHover] = useState(false);
  const [btnHover, setBtnHover] = useState(false);

  const isOnline = agent.is_online === true;
  // 5-state lifecycle badge (ticket bfdd80b7) — drives both the avatar dot and
  // the status pill. The "last seen / never connected" subtext below still keys
  // off isOnline so its logic stays intact.
  const lifecycleState = resolveLifecycle(agent);
  const lifecycle = LIFECYCLE_BADGE[lifecycleState];
  // Concrete error reason (ticket 1f750878) — surfaced on the 오류 badge as both
  // a tooltip and a small danger-colored line so "구체 실패 사유" (manager offline
  // / no working dir / manager-side spawn-failure detail) is visible instead of
  // the badge silently flipping back to 미시작. Only meaningful for error state.
  const lifecycleDetail = lifecycleState === 'error' ? agent.lifecycle_detail : undefined;
  // Concurrency-N + QA rollup. Prefer the full active_tasks list (a board with
  // max_concurrent_tickets_per_agent > 1 puts several entries here, plus any
  // in-progress QA runs); fall back to the legacy singular current_task (older
  // server) as a one-item list so the card keeps rendering.
  const tasks: AgentCurrentTask[] =
    agent.active_tasks && agent.active_tasks.length
      ? agent.active_tasks
      : agent.current_task
        ? [agent.current_task]
        : [];
  const hasTask = tasks.length > 0;
  // Managed agents (spawned by an agent-manager) get the lifecycle control row.
  // Standalone / manager-identity agents have no owning manager to route
  // commands through, so the row is hidden for them.
  const isManaged = !!agent.manager_agent_id;
  const showLifecycle = isManaged && !!isAdmin;
  // Glyph stays bare-name first-char so two managed agents under different
  // managers don't both flash the manager's initial; the full
  // <manager>/<agent> rendering happens on the name line below.
  const glyph = (agent.name && agent.name[0] ? agent.name[0] : '?').toUpperCase();
  const displayName = formatAgentDisplayName(agent);

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

  // Error-reason line under the 오류 badge (ticket 1f750878). Danger-colored,
  // clamped to 2 lines so a long manager detail doesn't blow out the card.
  const lifecycleDetailStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 400,
    color: tokens.colors.dangerLight,
    lineHeight: 1.35,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    wordBreak: 'break-word',
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

  // Small leading pill on a QA-run task row (its title is a scenario name, not a
  // clickable board ticket).
  const qaBadgeStyle: React.CSSProperties = {
    display: 'inline-block',
    fontSize: 9,
    fontWeight: 700,
    padding: '0 4px',
    marginRight: 5,
    borderRadius: tokens.radii.sm,
    border: `1px solid ${tokens.colors.border}`,
    color: tokens.colors.accentLight,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    verticalAlign: 'middle',
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
      aria-label={`Agent ${displayName}, ${isOnline ? 'online' : 'offline'}`}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={avatarBlockStyle}>
          <div style={avatarCircleStyle}>{glyph}</div>
          <span style={dotWrapperStyle}>
            <Badge variant={lifecycle.variant} dot />
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
          <div style={nameStyle} title={displayName}>{displayName}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex' }} title={lifecycleDetail || undefined}>
              <Badge variant={lifecycle.variant}>{lifecycle.label}</Badge>
            </span>
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
          {lifecycleDetail && (
            <div style={lifecycleDetailStyle} title={lifecycleDetail}>
              {lifecycleDetail}
            </div>
          )}
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
        <div style={sectionLabelStyle}>
          {hasTask
            ? tasks.length > 1
              ? `CURRENT TASKS · ${tasks.length}`
              : 'CURRENT TASK'
            : 'STATUS'}
        </div>
        {hasTask ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tasks.slice(0, CARD_TASK_PREVIEW_LIMIT).map((t, i) => (
              <div key={`${t.ticket_id}-${i}`}>
                <div style={{ ...taskTitleStyle, WebkitLineClamp: tasks.length > 1 ? 1 : 2 }}>
                  {t.kind === 'qa' ? <span style={qaBadgeStyle}>QA</span> : null}
                  {t.ticket_title}
                </div>
                <div style={taskMetaStyle}>
                  {t.role ? (
                    <span style={{ textTransform: 'uppercase', letterSpacing: 0.4, marginRight: 6 }}>as {t.role} ·</span>
                  ) : null}
                  since {formatClaimedTime(t.claimed_at)} ·{' '}
                  {formatElapsed(t.claimed_at)}
                </div>
              </div>
            ))}
            {tasks.length > CARD_TASK_PREVIEW_LIMIT ? (
              <div style={taskMetaStyle}>+{tasks.length - CARD_TASK_PREVIEW_LIMIT} more</div>
            ) : null}
          </div>
        ) : (
          <div style={idleValueStyle}>Idle</div>
        )}
      </div>

      {/* Managed-agent lifecycle controls (admin-only). Rendered inside the
          navigate-on-click card; AgentLifecycleControls stops click
          propagation so a button press doesn't also open the detail page. */}
      {showLifecycle && (
        <div
          style={{
            borderTop: `1px solid ${tokens.colors.border}`,
            paddingTop: 10,
          }}
        >
          <AgentLifecycleControls
            agentId={agent.id}
            managerInstance={managerInstance}
            lifecycleState={agent.lifecycle_state}
            layout="compact"
            onDispatched={onLifecycleDispatched}
          />
        </div>
      )}

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
