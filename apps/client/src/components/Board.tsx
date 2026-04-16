import React, { useState, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DragDropContext, DropResult } from '@hello-pangea/dnd';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Ticket } from '../types';
import { useBoard } from '../hooks/useBoard';
import { useToast } from '../contexts/ToastContext';
import { useLoading } from '../contexts/LoadingContext';
import PageHeader from './PageHeader';
import Column from './Column';
import TicketPanel from './TicketPanel';
import { tokens } from '../tokens';

function findTicketById(board: { columns: { tickets: Ticket[] }[] }, id: string): Ticket | null {
  for (const col of board.columns) {
    for (const t of col.tickets) {
      if (t.id === id) return t;
      for (const child of (t.children || [])) {
        if (child.id === id) return child;
        for (const gc of (child.children || [])) {
          if (gc.id === id) return gc;
        }
      }
    }
  }
  return null;
}

export default function Board() {
  const { showToast } = useToast();
  const { withLoading } = useLoading();

  // Board and workspace identity come from the URL — no localStorage reads needed.
  const { wsId, boardId } = useParams<{ wsId: string; boardId: string }>();

  const [activePanelTicketId, setActivePanelTicketId] = useState<string | null>(null);

  // Helper: wrap any async action with loading bar + error toast
  const wrapAction = useCallback(async (action: () => Promise<any>, successMsg?: string) => {
    try {
      await withLoading(action);
      if (successMsg) showToast(successMsg, 'success');
    } catch (err: any) {
      showToast(err.message || 'Operation failed', 'error');
    }
  }, [showToast, withLoading]);

  const {
    board, users, agents, channels, loading: boardLoading, error, refresh,
    createTicket, updateTicket, moveTicket, deleteTicket,
    createChildTicket, addComment,
    createColumn, updateColumn, deleteColumn,
    typingIndicators,
  } = useBoard(boardId ?? '');

  // Derive activePanelTicket from board data (searches children + grandchildren)
  const activePanelTicket = activePanelTicketId && board
    ? findTicketById(board, activePanelTicketId)
    : null;

  useEffect(() => {
    if (activePanelTicketId && board && !activePanelTicket) {
      setActivePanelTicketId(null);
    }
  }, [activePanelTicketId, board, activePanelTicket]);

  // --- Wrapped action handlers ---

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination || !board) return;

    const { source, destination, draggableId } = result;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;

    const ticketId = draggableId.replace('ticket-', '');
    const targetColumnId = destination.droppableId.replace('column-', '');

    // moveTicket already does optimistic update + revert on error
    try {
      await moveTicket(ticketId, targetColumnId, destination.index);
    } catch (err: any) {
      showToast(err.message || 'Failed to move ticket', 'error');
    }
  };

  const handleCreateTicket = useCallback(async (columnId: string, title: string, priority: string) => {
    await wrapAction(() => createTicket(columnId, title, priority), 'Ticket created');
  }, [wrapAction, createTicket]);

  const handleUpdateTicket = useCallback(async (ticketId: string, data: Record<string, any>) => {
    await wrapAction(() => updateTicket(ticketId, data));
  }, [wrapAction, updateTicket]);

  const handleDeleteTicket = useCallback(async (ticketId: string) => {
    await wrapAction(() => deleteTicket(ticketId), 'Ticket deleted');
  }, [wrapAction, deleteTicket]);

  const handleCreateChild = useCallback(async (parentId: string, data: { title: string; description?: string; priority?: string; assignee?: string; reporter?: string }) => {
    await wrapAction(() => createChildTicket(parentId, data), 'Subtask created');
  }, [wrapAction, createChildTicket]);

  const handleDeleteChild = useCallback(async (childId: string) => {
    await wrapAction(() => deleteTicket(childId), 'Subtask deleted');
  }, [wrapAction, deleteTicket]);

  const handleAddComment = useCallback(async (ticketId: string, content: string, images?: { filename: string; mimetype: string; data: string }[]) => {
    await wrapAction(() => addComment(ticketId, content, images || []), 'Comment added');
  }, [wrapAction, addComment]);

  const handleCreateColumn = useCallback(async (boardId: string, name: string, color?: string) => {
    await wrapAction(() => createColumn(boardId, name, color), 'Column created');
  }, [wrapAction, createColumn]);

  const handleUpdateColumn = useCallback(async (columnId: string, data: { name?: string; color?: string; position?: number }) => {
    await wrapAction(() => updateColumn(columnId, data), 'Column updated');
  }, [wrapAction, updateColumn]);

  const handleDeleteColumn = useCallback(async (columnId: string) => {
    await wrapAction(() => deleteColumn(columnId), 'Column deleted');
  }, [wrapAction, deleteColumn]);

  const handleTicketClick = (ticket: Ticket) => {
    setActivePanelTicketId(ticket.id);
  };

  const handleCloseDetail = () => {
    setActivePanelTicketId(null);
  };

  // Board is loading if boardId is set but board data hasn't arrived yet
  const isLoading = !!boardId && boardLoading && !board;

  if (isLoading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', color: tokens.colors.textSecondary, fontSize: '16px',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12,
            background: tokens.gradients.accent,
            margin: '0 auto 16px',
            animation: 'pulse 1.5s infinite',
          }} />
          Loading board...
        </div>
      </div>
    );
  }

  if (error && boardId) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', color: tokens.colors.danger, fontSize: '16px',
      }}>
        Error: {error}
      </div>
    );
  }

  // Board settings link uses workspace-scoped URL
  const settingsLink = wsId && boardId ? `/ws/${wsId}/boards/${boardId}/settings` : '#';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader
        title={board?.name || 'Board'}
        description={board?.description}
        actions={
          <Link
            to={settingsLink}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              background: tokens.colors.surfaceCard,
              border: `1px solid ${tokens.colors.border}`,
              fontSize: '13px',
              color: tokens.colors.textSecondary,
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            ⚙ Board Settings
          </Link>
        }
      />

      {board ? (
        <>
          {activePanelTicket ? (
            <Group orientation="horizontal" style={{ flex: 1, overflow: 'hidden' }}>
              <Panel minSize="40" style={{ overflowX: 'auto' }}>
                <DragDropContext onDragEnd={handleDragEnd}>
                  <div style={{ display: 'flex', gap: 12, padding: 16, minHeight: '100%', alignItems: 'flex-start' }}>
                    {board.columns.map(col => (
                      <Column key={col.id} column={col} onTicketClick={handleTicketClick} onCreateTicket={handleCreateTicket} />
                    ))}
                  </div>
                </DragDropContext>
              </Panel>
              <Separator style={{ width: 4, background: tokens.colors.border, cursor: 'col-resize', flexShrink: 0 }} />
              <Panel defaultSize="40" minSize="25" maxSize="70" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <TicketPanel
                  ticket={activePanelTicket}
                  columnName={board.columns.find(c => c.tickets.some(t => t.id === activePanelTicket.id))?.name || ''}
                  agents={agents}
                  channels={channels}
                  typingIndicators={typingIndicators}
                  onClose={handleCloseDetail}
                  onUpdate={handleUpdateTicket}
                  onDelete={(id) => { handleDeleteTicket(id); handleCloseDetail(); }}
                  onCreateChild={handleCreateChild}
                  onDeleteChild={handleDeleteChild}
                  onAddComment={handleAddComment}
                  onSelectTicket={setActivePanelTicketId}
                />
              </Panel>
            </Group>
          ) : (
            <DragDropContext onDragEnd={handleDragEnd}>
              <div style={{ flex: 1, display: 'flex', gap: 12, padding: 16, overflowX: 'auto', alignItems: 'flex-start' }}>
                {board.columns.map(col => (
                  <Column key={col.id} column={col} onTicketClick={handleTicketClick} onCreateTicket={handleCreateTicket} />
                ))}
              </div>
            </DragDropContext>
          )}

        </>
      ) : null}

    </div>
  );
}
