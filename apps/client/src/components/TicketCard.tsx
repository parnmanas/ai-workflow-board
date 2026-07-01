import React from 'react';
import { Draggable } from '@hello-pangea/dnd';
import { BoardCardTicket } from '../types';
import { tokens } from '../tokens';
import { Badge } from './common';
import { hasStaleOpenQuestion } from './comment-types';

interface TicketCardProps {
  // Card-projection ticket: `comments` is the narrow BoardCardComment shape.
  // Reading a dropped comment field (content/author/parent_id/…) here is a
  // compile error — that's the guard hardening ticket 24bbd0ad installs.
  ticket: BoardCardTicket;
  index: number;
  onClick: () => void;
  focusHolders?: Array<{ agent_name: string; role: string }>;
}

const priorityVariants: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

const priorityLabels: Record<string, string> = {
  low: 'LOW',
  medium: 'MED',
  high: 'HIGH',
  critical: 'CRIT',
};

export default function TicketCard({ ticket, index, onClick, focusHolders }: TicketCardProps) {
  const doneChildren = (ticket.children || []).filter(c => c.status === 'done').length;
  const totalChildren = (ticket.children || []).length;
  const progress = totalChildren > 0 ? (doneChildren / totalChildren) * 100 : 0;
  const isPending = !!ticket.pending_user_action;
  // Blocked-by-tickets state (ticket 48d14fff) — distinct from the human
  // pending flag. Auto-resumes when prereqs finish, so it gets a calmer
  // info-coloured chain badge rather than the warning outline reserved for
  // human-blocked tickets.
  const isBlockedByTickets = !!ticket.pending_on_tickets;
  const prereqCount = ticket.prerequisite_count || 0;

  return (
    <Draggable draggableId={`ticket-${ticket.id}`} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={onClick}
          style={{
            // Pending tickets get a high-visibility warning outline + glow so
            // they jump out of the column without a user reading comments. The
            // PENDING badge below adds the explanatory pulse animation; the
            // outline alone makes the card scannable from across the board.
            background: snapshot.isDragging
              ? tokens.colors.border
              : (isPending ? tokens.colors.warningBg : tokens.colors.surfaceCard),
            borderRadius: tokens.radii.lg,
            padding: 12,
            border: `${isPending ? 2 : 1}px ${isPending ? 'dashed' : 'solid'} ${
              snapshot.isDragging
                ? tokens.colors.accent
                : (isPending ? tokens.colors.warning : tokens.colors.border)
            }`,
            cursor: 'pointer',
            transition: 'border-color 0.2s, box-shadow 0.2s',
            boxShadow: snapshot.isDragging
              ? tokens.shadows.card
              : (isPending ? `0 0 0 2px ${tokens.colors.warningBg}` : 'none'),
            ...provided.draggableProps.style,
          }}
        >
          {/* Priority + ID */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Badge variant={priorityVariants[ticket.priority] ?? 'neutral'}>
                {priorityLabels[ticket.priority]}
              </Badge>
              {/* Pending-user-action badge (ticket a57517be). High-visibility
                 pulsing label that says "this ticket is waiting on you" so a
                 user scanning the board sees the parked ticket immediately
                 without opening it. Tooltip carries the reason so a hover
                 is enough to triage. The animation styles ship from
                 styles/global.css (@keyframes awb-pending-pulse). */}
              {isPending && (
                <span
                  title={`Pending user action${ticket.pending_reason ? `: ${ticket.pending_reason}` : ''}`}
                  className="awb-pending-pulse"
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    padding: '1px 6px',
                    borderRadius: tokens.radii.sm,
                    background: tokens.colors.warning,
                    color: '#1a1a1a',
                    fontSize: '9px', fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}
                  aria-label="Pending user action"
                >⏸ USER</span>
              )}
              {/* Blocked-by-tickets badge (ticket 48d14fff). Info-coloured
                 chain link so it reads as "waiting, auto-resumes" rather than
                 the warning USER badge that means "a human must act". Count
                 comes from the board serializer's prerequisite_count. */}
              {isBlockedByTickets && (
                <span
                  title={`Blocked by ${prereqCount || 'prerequisite'} ticket${prereqCount === 1 ? '' : 's'} — resumes automatically when they finish`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 2,
                    padding: '1px 6px',
                    borderRadius: tokens.radii.sm,
                    background: tokens.colors.info,
                    color: '#0b1220',
                    fontSize: '9px', fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}
                  aria-label="Blocked by prerequisite tickets"
                >⛓{prereqCount > 0 ? ` ${prereqCount}` : ''}</span>
              )}
              {/* Tier-1 G stale-question badge — surfaces tickets blocked
                 on an answer for >24h so they don't quietly rot. Pure
                 derived from the ticket's already-loaded comments; no
                 extra round-trip. Tooltip explains the threshold so the
                 badge isn't a mystery. */}
              {hasStaleOpenQuestion(ticket.comments) && (
                <span
                  title="An open question on this ticket has been waiting >24h"
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 18, height: 18, borderRadius: '50%',
                    background: tokens.colors.warningBg, color: tokens.colors.warningLight,
                    fontSize: '11px', fontWeight: 700,
                    border: `1px solid ${tokens.colors.warning}`,
                  }}
                  aria-label="Stale open question"
                >?</span>
              )}
              {focusHolders && focusHolders.length > 0 && (
                <span
                  title={`Focus ticket for: ${focusHolders.map(h => `${h.agent_name} (${h.role})`).join(', ')}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    padding: '1px 5px',
                    borderRadius: tokens.radii.sm,
                    background: tokens.colors.accentLight,
                    color: tokens.colors.accent,
                    fontSize: '9px', fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}
                  aria-label="Focus ticket"
                >FOCUS</span>
              )}
            </div>
            <span style={{ fontSize: '10px', color: tokens.colors.textMuted }}>#{ticket.id}</span>
          </div>

          {/* Title */}
          <h4 style={{
            fontSize: '13px',
            fontWeight: 600,
            color: tokens.colors.textStrong,
            lineHeight: 1.4,
            marginBottom: 8,
          }}>{ticket.title}</h4>

          {/* Bottom row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {/* Subtask progress */}
            {totalChildren > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                <div style={{
                  flex: 1,
                  height: 3,
                  background: tokens.colors.border,
                  borderRadius: tokens.radii.xs,
                  maxWidth: 60,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    width: `${progress}%`,
                    background: progress === 100 ? tokens.colors.successLight : tokens.colors.accent,
                    borderRadius: tokens.radii.xs,
                  }} />
                </div>
                <span style={{ fontSize: '10px', color: tokens.colors.textMuted }}>
                  {doneChildren}/{totalChildren}
                </span>
              </div>
            )}

            {/* Assignee — multi-holder aware (T6 다중담당자). 1명이면 기존 이름
                pill 그대로(단일-홀더 시각 회귀 없음), ≥2명이면 겹친 아바타 스택
                + "+N" 오버플로. role_holders 프로젝션이 없으면(구 payload) 레거시
                assignee 문자열로 폴백. */}
            {(() => {
              const assigneeHolders = (ticket.role_holders || []).find(r => r.role_slug === 'assignee')?.holders || [];
              const holders = assigneeHolders.length > 0
                ? assigneeHolders
                : (ticket.assignee ? [{ type: 'agent' as const, id: '', name: ticket.assignee }] : []);
              if (holders.length === 0) return null;
              if (holders.length === 1) {
                return (
                  <span style={{
                    fontSize: '10px',
                    color: tokens.colors.textSecondary,
                    background: tokens.colors.surface,
                    padding: '2px 8px',
                    borderRadius: 10,
                    maxWidth: 80,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {holders[0].name}
                  </span>
                );
              }
              const MAX_AVATARS = 3;
              const shown = holders.slice(0, MAX_AVATARS);
              const overflow = holders.length - shown.length;
              return (
                <div
                  style={{ display: 'flex', alignItems: 'center' }}
                  title={holders.map(h => h.name).join(', ')}
                >
                  {shown.map((h, i) => (
                    <div
                      key={`${h.type}:${h.id}:${i}`}
                      style={{
                        width: 18, height: 18, borderRadius: '50%',
                        marginLeft: i > 0 ? -6 : 0,
                        background: h.type === 'agent' ? tokens.colors.accent : tokens.colors.info,
                        color: '#fff', fontSize: '9px', fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: `1.5px solid ${tokens.colors.surfaceCard}`,
                        flexShrink: 0,
                      }}
                    >
                      {(h.name || '?').charAt(0).toUpperCase()}
                    </div>
                  ))}
                  {overflow > 0 && (
                    <div style={{
                      marginLeft: -6, height: 18, minWidth: 18, padding: '0 4px',
                      borderRadius: 9, background: tokens.colors.surface,
                      color: tokens.colors.textSecondary, fontSize: '9px', fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: `1.5px solid ${tokens.colors.surfaceCard}`,
                    }}>
                      +{overflow}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Comments indicator */}
          {ticket.comments && ticket.comments.length > 0 && (
            <div style={{ marginTop: 6, fontSize: '10px', color: tokens.colors.textMuted }}>
              {ticket.comments.length} comment{ticket.comments.length > 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}
    </Draggable>
  );
}
