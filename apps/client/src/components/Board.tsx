import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DragDropContext, Droppable, DragStart, DropResult } from '@hello-pangea/dnd';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Ticket } from '../types';
import { api } from '../api';
import { useBoard } from '../hooks/useBoard';
import { useDragToScroll } from '../hooks/useDragToScroll';
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

  const panelBoardScrollRef = useDragToScroll<HTMLDivElement>({ axis: 'x' });
  const fullBoardScrollRef = useDragToScroll<HTMLDivElement>({ axis: 'x' });

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
    board, users, agents, channels, workspaceRoles,
    loading: boardLoading, error, refresh,
    createTicket, updateTicket, moveTicket, reparentTicket, moveTicketToBoard, deleteTicket,
    createChildTicket, setTicketRoleAssignment, addComment, setCommentStatus,
    createColumn, updateColumn, deleteColumn,
    typingIndicators,
  } = useBoard(boardId ?? '');

  // Workspace's other boards — drives the drag-and-drop "move to board" strip
  // and is also passed (via TicketPanel) to the explicit board picker. Fetched
  // here rather than in TicketPanel so dragging a card without ever opening
  // the panel still has a populated drop strip.
  const [workspaceBoards, setWorkspaceBoards] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!wsId) { setWorkspaceBoards([]); return; }
    let cancelled = false;
    api.getBoards(wsId).then((rows) => {
      if (cancelled) return;
      setWorkspaceBoards(
        (rows || [])
          .filter((b: any) => !b.archived_at)
          .map((b: any) => ({ id: b.id, name: b.name })),
      );
    }).catch(() => { /* silent — drop strip just won't appear */ });
    return () => { cancelled = true; };
  }, [wsId, boardId]);

  const otherBoards = useMemo(
    () => workspaceBoards.filter(b => b.id !== boardId),
    [workspaceBoards, boardId],
  );

  // Drag tracking for the "move to other board" strip. We only show the
  // strip when a root ticket is being dragged — child tickets carry no
  // column_id and the cross-board endpoint rejects them anyway. The
  // dragged ticket id is tracked so we can resolve depth in onBeforeDragStart
  // without traversing the column tree on every drag-over.
  const [draggingRootTicket, setDraggingRootTicket] = useState(false);

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

  const handleDragStart = (start: DragStart) => {
    // Only show the cross-board drop strip when dragging a root ticket;
    // children can't be moved across boards (no column_id).
    if (!board) return;
    const ticketId = start.draggableId.replace('ticket-', '');
    const found = findTicketById(board, ticketId);
    setDraggingRootTicket(!!found && (found.depth ?? 0) === 0 && !found.parent_id);
  };

  const handleDragEnd = async (result: DropResult) => {
    setDraggingRootTicket(false);
    if (!result.destination || !board) return;

    const { source, destination, draggableId } = result;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;

    const ticketId = draggableId.replace('ticket-', '');

    // Subtask drop zone in the right-hand TicketPanel: droppableId is
    // `subtasks-<parentId>`. Re-parent the dragged ticket under the parent
    // instead of moving it across columns.
    if (destination.droppableId.startsWith('subtasks-')) {
      const parentId = destination.droppableId.replace('subtasks-', '');
      if (ticketId === parentId) return; // can't parent a ticket to itself
      try {
        await reparentTicket(ticketId, parentId, { targetPosition: destination.index });
      } catch (err: any) {
        showToast(err.message || 'Failed to add as subtask', 'error');
      }
      return;
    }

    // Cross-board drop strip: droppableId is `move-to-board-<boardId>`.
    // Drops on a strip entry move the ticket to that board's first column.
    // Column-precision moves still go through the explicit picker in the
    // ticket panel (drag&drop with only one drop target per board keeps the
    // strip readable when the workspace has many boards).
    if (destination.droppableId.startsWith('move-to-board-')) {
      const targetBoardId = destination.droppableId.replace('move-to-board-', '');
      if (targetBoardId === boardId) return;
      try {
        await moveTicketToBoard(ticketId, targetBoardId);
        const dest = workspaceBoards.find(b => b.id === targetBoardId);
        showToast(`Moved to ${dest?.name || 'board'}`, 'success');
        // Clear the panel if it was open on the moved ticket — it now lives
        // on a different board and findTicketById would return null next
        // render anyway.
        if (activePanelTicketId === ticketId) setActivePanelTicketId(null);
      } catch (err: any) {
        showToast(err.message || 'Failed to move to board', 'error');
      }
      return;
    }

    const targetColumnId = destination.droppableId.replace('column-', '');

    // moveTicket already does optimistic update + revert on error
    try {
      await moveTicket(ticketId, targetColumnId, destination.index);
    } catch (err: any) {
      showToast(err.message || 'Failed to move ticket', 'error');
    }
  };

  const handleMoveTicketToBoard = useCallback(async (
    ticketId: string,
    targetBoardId: string,
    opts?: { target_column_id?: string },
  ) => {
    await wrapAction(() => moveTicketToBoard(ticketId, targetBoardId, opts));
  }, [wrapAction, moveTicketToBoard]);

  const handleCreateTicket = useCallback(async (
    columnId: string,
    title: string,
    description: string,
    priority: string,
  ) => {
    await wrapAction(() => createTicket(columnId, title, description, priority), 'Ticket created');
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

  // Used by the "Link existing" picker in SubtaskList — drag-and-drop already
  // routes through handleDragEnd so this only fires for explicit picker clicks.
  const handleReparentChild = useCallback(async (parentId: string, childId: string) => {
    await wrapAction(() => reparentTicket(childId, parentId), 'Subtask linked');
  }, [wrapAction, reparentTicket]);

  const handleSetRoleAssignment = useCallback(async (
    ticketId: string,
    roleId: string,
    holder: { agent_id?: string | null; user_id?: string | null },
  ) => {
    await wrapAction(() => setTicketRoleAssignment(ticketId, roleId, holder));
  }, [wrapAction, setTicketRoleAssignment]);

  const handleAddComment = useCallback(async (
    ticketId: string,
    content: string,
    attachments?: { file_name: string; file_mimetype: string; file_data: string }[],
    options?: { type?: string; parent_id?: string | null; metadata?: Record<string, unknown> },
  ) => {
    await wrapAction(() => addComment(ticketId, content, attachments || [], options), 'Comment added');
  }, [wrapAction, addComment]);

  const handleSetCommentStatus = useCallback(async (ticketId: string, commentId: string, status: 'open' | 'resolved') => {
    await wrapAction(() => setCommentStatus(ticketId, commentId, status), status === 'resolved' ? 'Question resolved' : 'Question reopened');
  }, [wrapAction, setCommentStatus]);

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

  // Board-scoped action links (workspace-scoped URLs)
  const resourcesLink = wsId && boardId ? `/ws/${wsId}/boards/${boardId}/resources` : '#';
  const settingsLink = wsId && boardId ? `/ws/${wsId}/boards/${boardId}/settings` : '#';

  const headerActionStyle: React.CSSProperties = {
    padding: '6px 14px',
    borderRadius: 8,
    background: tokens.colors.surfaceCard,
    border: `1px solid ${tokens.colors.border}`,
    fontSize: '13px',
    color: tokens.colors.textSecondary,
    textDecoration: 'none',
    fontWeight: 500,
  };

  // Cross-board drop strip. Each board entry is a Droppable; handleDragEnd
  // routes `move-to-board-<id>` to the cross-board endpoint.
  //
  // CRITICAL: The Droppables are mounted whenever `otherBoards` has entries,
  // not just while a drag is in progress. hello-pangea/dnd does NOT support
  // mounting/unmounting Droppables mid-drag — doing so triggers Invariant
  // failures from internal `dragStopped`/`release` cleanup. The
  // `draggingRootTicket` flag only toggles visibility (max-height + opacity),
  // so the dnd registry sees a stable Droppable set across the whole drag
  // lifecycle.
  const stripVisible = draggingRootTicket && otherBoards.length > 0;
  const moveBoardStrip = otherBoards.length > 0 ? (
    <div
      aria-hidden={!stripVisible}
      style={{
        flexShrink: 0,
        maxHeight: stripVisible ? 80 : 0,
        opacity: stripVisible ? 1 : 0,
        overflow: 'hidden',
        borderBottom: stripVisible ? `1px solid ${tokens.colors.border}` : 'none',
        background: `${tokens.colors.accent}10`,
        transition: 'max-height 0.18s ease, opacity 0.15s ease',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '8px 16px',
          overflowX: 'auto',
          alignItems: 'center',
        }}
      >
        <span style={{
          fontSize: '11px',
          fontWeight: 700,
          color: tokens.colors.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          flexShrink: 0,
          marginRight: 4,
        }}>
          Move to →
        </span>
        {otherBoards.map(b => (
          <Droppable droppableId={`move-to-board-${b.id}`} key={b.id}>
            {(provided, snapshot) => (
              <div
                ref={provided.innerRef}
                {...provided.droppableProps}
                style={{
                  padding: '6px 14px',
                  borderRadius: tokens.radii.md,
                  border: `1px dashed ${snapshot.isDraggingOver ? tokens.colors.accent : tokens.colors.borderStrong}`,
                  background: snapshot.isDraggingOver
                    ? `${tokens.colors.accent}30`
                    : tokens.colors.surfaceCard,
                  fontSize: '12px',
                  fontWeight: 600,
                  color: snapshot.isDraggingOver ? tokens.colors.textStrong : tokens.colors.textSecondary,
                  whiteSpace: 'nowrap',
                  transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                  flexShrink: 0,
                  position: 'relative',
                }}
              >
                {b.name}
                {/* Library expects the placeholder to be rendered as a
                   sibling so it can measure dimensions. Drop-only zones
                   don't actually need any visible space, but skipping
                   the placeholder is unsupported — render it normally. */}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader
        title={board?.name || 'Board'}
        description={board?.description}
        actions={
          <>
            <Link to={resourcesLink} style={headerActionStyle}>
              📁 Resources
            </Link>
            <Link to={settingsLink} style={headerActionStyle}>
              ⚙ Settings
            </Link>
          </>
        }
      />

      {board ? (
        <>
          {activePanelTicket ? (
            <DragDropContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
              {moveBoardStrip}
              <Group orientation="horizontal" style={{ flex: 1, overflow: 'hidden' }}>
                <Panel minSize="40">
                  <div
                    ref={panelBoardScrollRef}
                    style={{
                      display: 'flex',
                      gap: 12,
                      padding: 16,
                      height: '100%',
                      overflowX: 'auto',
                      alignItems: 'flex-start',
                      cursor: 'grab',
                    }}
                  >
                    {board.columns.map(col => (
                      <Column key={col.id} column={col} onTicketClick={handleTicketClick} onCreateTicket={handleCreateTicket} />
                    ))}
                  </div>
                </Panel>
                <Separator style={{ width: 4, background: tokens.colors.border, cursor: 'col-resize', flexShrink: 0 }} />
                <Panel defaultSize="40" minSize="25" maxSize="70" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                  <TicketPanel
                    ticket={activePanelTicket}
                    columnName={board.columns.find(c => c.tickets.some(t => t.id === activePanelTicket.id))?.name || ''}
                    agents={agents}
                    users={users}
                    channels={channels}
                    workspaceRoles={workspaceRoles}
                    boardTickets={board.columns.flatMap(c => c.tickets)}
                    typingIndicators={typingIndicators}
                    onClose={handleCloseDetail}
                    onUpdate={handleUpdateTicket}
                    onDelete={(id) => { handleDeleteTicket(id); handleCloseDetail(); }}
                    onCreateChild={handleCreateChild}
                    onDeleteChild={handleDeleteChild}
                    onReparentChild={handleReparentChild}
                    onSetRoleAssignment={handleSetRoleAssignment}
                    onAddComment={handleAddComment}
                    onSetCommentStatus={handleSetCommentStatus}
                    onSelectTicket={setActivePanelTicketId}
                    currentBoardId={boardId}
                    workspaceId={wsId}
                    onMoveToBoard={handleMoveTicketToBoard}
                  />
                </Panel>
              </Group>
            </DragDropContext>
          ) : (
            <DragDropContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
              {moveBoardStrip}
              <div
                ref={fullBoardScrollRef}
                style={{
                  flex: 1,
                  display: 'flex',
                  gap: 12,
                  padding: 16,
                  overflowX: 'auto',
                  alignItems: 'flex-start',
                  cursor: 'grab',
                }}
              >
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
