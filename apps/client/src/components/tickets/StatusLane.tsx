import React, { useState } from 'react';
import { Droppable } from '@hello-pangea/dnd';
import type { TicketCard as TicketCardRow } from '../../types';
import { TICKET_STATUS_LABELS, ticketStatusColor, type TicketStatus } from '../../tickets/status';
import TicketCard from '../TicketCard';
import { useDragToScroll } from '../../hooks/useDragToScroll';
import { tokens } from '../../tokens';

export const LANE_DROPPABLE_PREFIX = 'lane-';

interface StatusLaneProps {
  status: TicketStatus;
  tickets: TicketCardRow[];
  onTicketClick(ticket: TicketCardRow): void;
  /** Title-only quick add straight into this lane. Resolves when created. */
  onQuickAdd?(title: string, status: TicketStatus): Promise<void>;
  unreadFor(ticket: TicketCardRow): number;
  assigneeLabelFor(ticket: TicketCardRow): string;
  projectNameFor(ticket: TicketCardRow): string;
  onTagClick?(tag: string): void;
}

/** One status lane of the Kanban view (replaces a board column). */
export default function StatusLane({
  status,
  tickets,
  onTicketClick,
  onQuickAdd,
  unreadFor,
  assigneeLabelFor,
  projectNameFor,
  onTagClick,
}: StatusLaneProps) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useDragToScroll<HTMLDivElement>({ axis: 'y' });
  const color = ticketStatusColor(status);
  const label = TICKET_STATUS_LABELS[status];

  const submit = async () => {
    const t = title.trim();
    if (!t || !onQuickAdd || busy) return;
    setBusy(true);
    try {
      await onQuickAdd(t, status);
      setTitle('');
    } catch {
      /* the page toasts; keep the text so it can be retried */
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={`${label} lane`}
      data-status-lane={status}
      style={{
        minWidth: 270,
        maxWidth: 320,
        width: 290,
        background: tokens.colors.surface,
        borderRadius: 12,
        border: `1px solid ${tokens.colors.surfaceCard}`,
        display: 'flex',
        flexDirection: 'column',
        maxHeight: '100%',
        flexShrink: 0,
      }}
    >
      <div style={{
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: `1px solid ${tokens.colors.surfaceCard}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
          <span style={{ fontSize: '13px', fontWeight: 700, color: tokens.colors.textStrong }}>{label}</span>
          <span style={{
            fontSize: '11px',
            color: tokens.colors.textMuted,
            background: tokens.colors.surfaceCard,
            padding: '1px 6px',
            borderRadius: 10,
          }}>
            {tickets.length}
          </span>
        </div>
        {onQuickAdd && (
          <button
            type="button"
            aria-label={`${label} 에 티켓 빠르게 추가`}
            aria-expanded={adding}
            onClick={() => setAdding((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: tokens.colors.textMuted,
              cursor: 'pointer',
              fontSize: '18px',
              lineHeight: 1,
              padding: '0 4px',
            }}
          >+</button>
        )}
      </div>

      {adding && onQuickAdd && (
        <form
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
          style={{ padding: 8, borderBottom: `1px solid ${tokens.colors.surfaceCard}`, display: 'flex', gap: 6 }}
        >
          <input
            autoFocus
            aria-label={`${label} 새 티켓 제목`}
            value={title}
            disabled={busy}
            placeholder="제목 입력 후 Enter"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setAdding(false); setTitle(''); } }}
            style={{
              flex: 1,
              background: tokens.colors.surfaceCard,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              color: tokens.colors.textStrong,
              fontSize: 12,
              padding: '6px 8px',
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={busy || !title.trim()}
            style={{
              border: 'none',
              borderRadius: tokens.radii.md,
              background: tokens.colors.accent,
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              padding: '0 10px',
              cursor: busy || !title.trim() ? 'default' : 'pointer',
              opacity: busy || !title.trim() ? 0.6 : 1,
            }}
          >추가</button>
        </form>
      )}

      <Droppable droppableId={`${LANE_DROPPABLE_PREFIX}${status}`}>
        {(provided, snapshot) => (
          <div
            ref={(node) => {
              scrollRef(node);
              provided.innerRef(node);
            }}
            {...provided.droppableProps}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              background: snapshot.isDraggingOver ? `${tokens.colors.surfaceCard}40` : 'transparent',
              borderRadius: 8,
              transition: 'background 0.2s',
              minHeight: 60,
              cursor: 'grab',
            }}
          >
            {tickets.map((ticket, index) => (
              <TicketCard
                key={ticket.id}
                ticket={ticket}
                index={index}
                onClick={() => onTicketClick(ticket)}
                onChildClick={onTicketClick}
                unreadCount={unreadFor(ticket)}
                assigneeLabel={assigneeLabelFor(ticket)}
                projectName={projectNameFor(ticket)}
                onTagClick={onTagClick}
              />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </section>
  );
}
