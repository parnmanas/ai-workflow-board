import React, { useState } from 'react';
import { Droppable } from '@hello-pangea/dnd';
import { BoardCardColumn, BoardCardTicket } from '../types';
import TicketCard from './TicketCard';
import CreateTicketForm from './CreateTicketForm';
import { useDragToScroll } from '../hooks/useDragToScroll';
import { tokens } from '../tokens';

interface ColumnProps {
  // Card-projection column: tickets carry the narrow BoardCardComment shape,
  // not the full thread (the detail panel fetches that via getTicket).
  column: BoardCardColumn;
  onTicketClick: (ticket: BoardCardTicket) => void;
  onCreateTicket: (columnId: string, title: string, description: string, priority: string) => void;
  focusTicketMap?: Record<string, Array<{ agent_name: string; role: string }>>;
}

export default function Column({ column, onTicketClick, onCreateTicket, focusTicketMap }: ColumnProps) {
  const [showForm, setShowForm] = useState(false);
  const columnScrollRef = useDragToScroll<HTMLDivElement>({ axis: 'y' });

  return (
    <div style={{
      minWidth: 280,
      maxWidth: 320,
      width: 300,
      background: tokens.colors.surface,
      borderRadius: 12,
      border: `1px solid ${tokens.colors.surfaceCard}`,
      display: 'flex',
      flexDirection: 'column',
      maxHeight: 'calc(100vh - 120px)',
      flexShrink: 0,
    }}>
      {/* Column header */}
      <div style={{
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: `1px solid ${tokens.colors.surfaceCard}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: column.color,
          }} />
          <span style={{ fontSize: '13px', fontWeight: 700, color: tokens.colors.textStrong }}>
            {column.name}
          </span>
          <span style={{
            fontSize: '11px',
            color: tokens.colors.textMuted,
            background: tokens.colors.surfaceCard,
            padding: '1px 6px',
            borderRadius: 10,
          }}>
            {column.tickets.length}
          </span>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
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
      </div>

      {/* Ticket list */}
      <Droppable droppableId={`column-${column.id}`}>
        {(provided, snapshot) => (
          <div
            ref={(node) => {
              columnScrollRef(node);
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
            {column.tickets.map((ticket, index) => (
              <TicketCard
                key={ticket.id}
                ticket={ticket}
                index={index}
                onClick={() => onTicketClick(ticket)}
                focusHolders={focusTicketMap?.[ticket.id]}
              />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>

      <CreateTicketForm
        isOpen={showForm}
        onSubmit={(title, description, priority) => {
          onCreateTicket(column.id, title, description, priority);
          setShowForm(false);
        }}
        onCancel={() => setShowForm(false)}
      />
    </div>
  );
}
