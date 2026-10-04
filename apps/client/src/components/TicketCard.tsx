import React from 'react';
import { Draggable } from '@hello-pangea/dnd';
import type { TicketCard as TicketCardRow } from '../types';
import { TICKET_PRIORITY_LABELS, ticketStatusLabel, ticketStatusColor } from '../tickets/status';
import { tokens } from '../tokens';
import { Badge } from './common';
import { NavBadge } from './common/NavBadge';
import { ActivityDot } from './common/ActivityIndicator';
import { ticketActivity } from '../activity';
import { hasStaleOpenQuestion } from './comment-types';

interface TicketCardProps {
  // List-row ticket: `comments` is the narrow TicketCardComment projection.
  // Reading a dropped comment field (content/author/parent_id/…) here is a
  // compile error — that's the guard hardening ticket 24bbd0ad installs.
  ticket: TicketCardRow;
  index: number;
  onClick: () => void;
  onChildClick?: (ticket: TicketCardRow) => void;
  /** 담당자 표시 이름(`<Host>/<label>`, tickets/assignee.ts). 빈 문자열 = 미지정. */
  assigneeLabel?: string;
  /** 프로젝트 이름(project_id 를 페이지가 해석해 넘긴다). */
  projectName?: string;
  /** 이 티켓의 미읽음 코멘트 수 — 서브태스크까지 롤업된 값(ticketUnreadRollup
   *  의 sumUnread). "어느 티켓이 사이드바 뱃지 숫자를 만들었나" 드릴다운
   *  (티켓 628f4b39). undefined/0 이면 아무것도 렌더하지 않는다. */
  unreadCount?: number;
  /** 태그 칩 클릭 — 페이지가 그 태그로 필터를 건다. */
  onTagClick?: (tag: string) => void;
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

const MAX_CARD_TAGS = 3;

/** Sub-task rows on a card. Children have no assignee of their own (the parent's
 *  assignee works through them), so a row shows status + title + progress. */
export function SubtaskBoardRows({ children, onChildClick }: {
  children: TicketCardRow[];
  onChildClick?: (ticket: TicketCardRow) => void;
}) {
  return (
    <div data-testid="subtask-board-rows" style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 5 }}>
      {children.map(child => {
        const childDone = (child.children || []).filter(item => item.status === 'done').length;
        const childTotal = (child.children || []).length;
        return (
          <button
            key={child.id}
            data-subtask-id={child.id}
            type="button"
            onClick={(event) => { event.stopPropagation(); onChildClick?.(child); }}
            style={{ textAlign: 'left', padding: '7px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.accent}55`, background: `${tokens.colors.accent}12`, color: tokens.colors.textStrong, cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 10, color: tokens.colors.textMuted }}>
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: ticketStatusColor(child.status) }} />
              <span>{ticketStatusLabel(child.status)}</span>
              {childTotal > 0 && <span style={{ marginLeft: 'auto' }}>{childDone}/{childTotal}</span>}
            </div>
            <div style={{ marginTop: 3, fontSize: 12, fontWeight: 600 }}>{child.title}</div>
          </button>
        );
      })}
    </div>
  );
}

export default function TicketCard({ ticket, index, onClick, onChildClick, assigneeLabel, projectName, unreadCount, onTagClick }: TicketCardProps) {
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
  const tags = ticket.tags || [];

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
            // outline alone makes the card scannable from across the lanes.
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
                <span title={TICKET_PRIORITY_LABELS[ticket.priority] || ticket.priority}>{priorityLabels[ticket.priority] || ticket.priority}</span>
              </Badge>
              {/* 지금 돌고 있는 카드 — 세션 목록·미션 카드와 같은 색·같은 숨쉬기
                 (src/activity.ts). `live` 일 때만 찍는다: 사람을 기다리는 상태와
                 차단 상태는 아래 ⏸ USER / ⛓ 뱃지가 이미 더 크게 말하고 있다. */}
              {ticketActivity(ticket).live && <ActivityDot view={ticketActivity(ticket)} size={6} />}
              {/* Pending-user-action badge (ticket a57517be). High-visibility
                 pulsing label that says "this ticket is waiting on you" so a
                 user scanning the lanes sees the parked ticket immediately
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
                 comes from the list row's prerequisite_count. */}
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
              {ticket.pending_ci_wait && (
                <span
                  title="Waiting on a CI run — resumes automatically"
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    padding: '1px 6px',
                    borderRadius: tokens.radii.sm,
                    background: tokens.colors.surface,
                    color: tokens.colors.textSecondary,
                    border: `1px solid ${tokens.colors.border}`,
                    fontSize: '9px', fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}
                  aria-label="Waiting on CI"
                >CI</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {!!unreadCount && unreadCount > 0 && (
                <NavBadge
                  count={unreadCount}
                  size="sm"
                  label={`읽지 않은 코멘트 ${unreadCount}건`}
                />
              )}
              <span title={ticket.id} style={{ fontSize: '10px', color: tokens.colors.textMuted }}>#{ticket.id.slice(0, 8)}</span>
            </div>
          </div>

          {/* Title */}
          <h4 style={{
            fontSize: '13px',
            fontWeight: 600,
            color: tokens.colors.textStrong,
            lineHeight: 1.4,
            marginBottom: 8,
          }}>{ticket.title}</h4>

          {/* Project + tags — classification replaces the board a ticket lived on. */}
          {(projectName || tags.length > 0) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
              {projectName && (
                <span
                  title={`Project: ${projectName}`}
                  style={{
                    fontSize: '10px', padding: '1px 6px', borderRadius: tokens.radii.sm,
                    background: tokens.colors.surface, color: tokens.colors.textSecondary,
                    border: `1px solid ${tokens.colors.border}`, maxWidth: 140,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >{projectName}</span>
              )}
              {tags.slice(0, MAX_CARD_TAGS).map((tag) => (
                <span
                  key={tag}
                  role={onTagClick ? 'button' : undefined}
                  tabIndex={onTagClick ? 0 : undefined}
                  title={onTagClick ? `#${tag} 로 필터` : `#${tag}`}
                  onClick={onTagClick ? (e) => { e.stopPropagation(); onTagClick(tag); } : undefined}
                  onKeyDown={onTagClick ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onTagClick(tag); }
                  } : undefined}
                  style={{
                    fontSize: '10px', padding: '1px 6px', borderRadius: 10,
                    background: `${tokens.colors.accent}1F`, color: tokens.colors.accentSubtle,
                    cursor: onTagClick ? 'pointer' : 'default', maxWidth: 120,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >#{tag}</span>
              ))}
              {tags.length > MAX_CARD_TAGS && (
                <span title={tags.slice(MAX_CARD_TAGS).map((t) => `#${t}`).join(' ')} style={{ fontSize: '10px', color: tokens.colors.textMuted }}>
                  +{tags.length - MAX_CARD_TAGS}
                </span>
              )}
            </div>
          )}

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

            {/* Assignee — the one RuntimeSpec that does the ticket, rendered
                `<Host>/<label>` (docs/runbooks/agent-display-name.md). */}
            <span
              title={assigneeLabel ? `Assignee: ${assigneeLabel}` : '미지정 — 디스패치되지 않음'}
              style={{
                marginLeft: 'auto',
                fontSize: '10px',
                color: assigneeLabel ? tokens.colors.textSecondary : tokens.colors.textMuted,
                background: tokens.colors.surface,
                padding: '2px 8px',
                borderRadius: 10,
                maxWidth: 140,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontStyle: assigneeLabel ? 'normal' : 'italic',
              }}
            >
              {assigneeLabel || '미지정'}
            </span>
          </div>

          {/* Comments indicator */}
          {ticket.comments && ticket.comments.length > 0 && (
            <div style={{ marginTop: 6, fontSize: '10px', color: tokens.colors.textMuted }}>
              {ticket.comments.length} comment{ticket.comments.length > 1 ? 's' : ''}
            </div>
          )}
          {totalChildren > 0 && (
            <SubtaskBoardRows children={ticket.children || []} onChildClick={onChildClick} />
          )}
        </div>
      )}
    </Draggable>
  );
}
