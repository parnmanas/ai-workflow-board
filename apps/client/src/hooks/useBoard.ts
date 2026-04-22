import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { Board, Workspace, User, Agent, Channel } from '../types';
import { useBoardStream } from '../contexts/BoardStreamContext';

export function useBoard(boardId: string = '') {
  const [board, setBoard] = useState<Board | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // typing indicator: map of ticketId -> agentId (or null when cleared)
  const [typingIndicators, setTypingIndicators] = useState<Record<string, string | null>>({});

  // Track how many local actions are in progress to avoid duplicate SSE refresh
  const localActionCount = useRef(0);

  const refresh = useCallback(async () => {
    if (!boardId) {
      setBoard(null);
      setLoading(false);
      return;
    }
    try {
      const boardData = await api.getBoard(boardId);
      setBoard(boardData);
      setError(null);

      const [usersData, agentsData, channelsData] = await Promise.all([
        api.getUsers().catch(() => []),
        api.getAgents().catch(() => []),
        api.getChannels().catch(() => []),
      ]);
      setUsers(usersData);
      setAgents(agentsData);
      setChannels(channelsData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  // SSE: Subscribe to real-time board updates via the AppLayout-level
  // BoardStreamContext. The actual EventSource lives in BoardStreamProvider
  // and persists across route changes (D-10). This hook only attaches
  // per-boardId handlers to the shared pub/sub bus — creating a new
  // EventSource here would defeat the purpose of hoisting the stream.
  const { subscribe } = useBoardStream();

  useEffect(() => {
    if (!boardId) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const unsubBoardUpdate = subscribe('board_update', (data: any) => {
      // Server filters board_update by boardId server-side ONLY when the
      // subscriber passed ?boardId=... . BoardStreamProvider opens a
      // workspace-agnostic stream, so we filter client-side here.
      if (data?.board_id && data.board_id !== boardId) return;

      // Skip if we're in the middle of a local action (it will refresh itself)
      if (localActionCount.current > 0) return;

      // Debounce rapid successive events (e.g., multiple field changes)
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        refresh();
      }, 300);
    });

    const unsubTyping = subscribe('agent_typing', (data: any) => {
      setTypingIndicators(prev => ({
        ...prev,
        [data.ticket_id]: data.action === 'started' ? data.actor_name : null,
      }));
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubBoardUpdate();
      unsubTyping();
    };
  }, [boardId, refresh, subscribe]);

  // Helper to wrap local actions so SSE doesn't trigger duplicate refresh
  const withLocalAction = async <T>(fn: () => Promise<T>): Promise<T> => {
    localActionCount.current++;
    try {
      const result = await fn();
      await refresh();
      return result;
    } finally {
      // Small delay before re-enabling SSE refresh to let the SSE event pass
      setTimeout(() => { localActionCount.current = Math.max(0, localActionCount.current - 1); }, 500);
    }
  };

  const createTicket = async (
    columnId: string,
    title: string,
    description: string,
    priority = 'medium',
  ) => {
    // Description is now required at create time (atomic modal flow). Keeping
    // it as a third positional param instead of an options bag because only
    // one caller exists; add a trailing options object here if that changes.
    await withLocalAction(() => api.createTicket(columnId, { title, description, priority }));
  };

  const updateTicket = async (ticketId: string, data: Record<string, any>) => {
    await withLocalAction(() => api.updateTicket(ticketId, data));
  };

  const moveTicket = async (ticketId: string, targetColumnId: string, targetPosition: number) => {
    const prevBoard = board;
    if (board) {
      setBoard(prev => {
        if (!prev) return prev;
        const cols = prev.columns.map(c => ({ ...c, tickets: [...c.tickets] }));
        const srcCol = cols.find(c => c.tickets.some(t => t.id === ticketId));
        const dstCol = cols.find(c => c.id === targetColumnId);
        if (!srcCol || !dstCol) return prev;
        const ticketIdx = srcCol.tickets.findIndex(t => t.id === ticketId);
        if (ticketIdx === -1) return prev;
        const [moved] = srcCol.tickets.splice(ticketIdx, 1);
        dstCol.tickets.splice(targetPosition, 0, moved);
        return { ...prev, columns: cols };
      });
    }

    localActionCount.current++;
    try {
      await api.moveTicket(ticketId, targetColumnId, targetPosition);
      await refresh();
    } catch (err) {
      setBoard(prevBoard);
      throw err;
    } finally {
      setTimeout(() => { localActionCount.current = Math.max(0, localActionCount.current - 1); }, 500);
    }
  };

  const deleteTicket = async (ticketId: string) => {
    await withLocalAction(() => api.deleteTicket(ticketId));
  };

  const createChildTicket = async (parentId: string, data: { title: string; description?: string; priority?: string; assignee?: string; reporter?: string }) => {
    await withLocalAction(() => api.createChildTicket(parentId, data));
  };

  const addComment = async (
    ticketId: string,
    content: string,
    attachments: { file_name: string; file_mimetype: string; file_data: string }[] = [],
    options?: { type?: string; parent_id?: string | null; metadata?: Record<string, unknown> },
  ) => {
    await withLocalAction(() => api.addComment(ticketId, content, attachments, options));
  };

  const setCommentStatus = async (ticketId: string, commentId: string, status: 'open' | 'resolved') => {
    await withLocalAction(() => api.setCommentStatus(ticketId, commentId, status));
  };

  const createColumn = async (boardId: string, name: string, color?: string) => {
    await withLocalAction(() => api.createColumn(boardId, { name, color }));
  };

  const updateColumn = async (columnId: string, data: { name?: string; color?: string; position?: number }) => {
    await withLocalAction(() => api.updateColumn(columnId, data));
  };

  const deleteColumn = async (columnId: string) => {
    await withLocalAction(() => api.deleteColumn(columnId));
  };

  return {
    board,
    users,
    agents,
    channels,
    loading,
    error,
    refresh,
    typingIndicators,
    createTicket,
    updateTicket,
    moveTicket,
    deleteTicket,
    createChildTicket,
    addComment,
    setCommentStatus,
    createColumn,
    updateColumn,
    deleteColumn,
  };
}

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<Workspace[]> => {
    try {
      const data = await api.getWorkspaces();
      setWorkspaces(data);
      setError(null);
      return data;
    } catch (err: any) {
      setError(err.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createWorkspace = async (name: string, description = '', boardName?: string) => {
    const ws = await api.createWorkspace({ name, description, board_name: boardName });
    await refresh();
    return ws;
  };

  const updateWorkspace = async (id: string, data: { name?: string; description?: string }) => {
    await api.updateWorkspace(id, data);
    await refresh();
  };

  const deleteWorkspace = async (id: string) => {
    await api.deleteWorkspace(id);
    await refresh();
  };

  return {
    workspaces,
    loading,
    error,
    refresh,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
  };
}
