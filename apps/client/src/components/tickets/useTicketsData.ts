import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import type { TicketCreateInput, TicketPatch } from '../../api';
import type { Channel, TicketCard, TicketTagCount, User } from '../../types';
import type { TicketStatus } from '../../tickets/status';
import { useBoardStream } from '../../contexts/BoardStreamContext';
import { filtersToQuery, filtersToSearch, type TicketFilters } from '../../tickets/ticketFilters';
import { applyMove } from '../../tickets/kanban';

/**
 * Tickets page data — the workspace pool for the current filters, kept live
 * from the `board_update` SSE event (the ticket-change event kept its name,
 * docs/tickets.md), plus the per-ticket typing indicators the detail panel
 * shows and the users/channels it needs for mentions and notifications.
 *
 * Local writes refetch themselves; while one is in flight the SSE echo of it
 * is ignored (same contract the board hook had) so the list doesn't refetch
 * twice per click.
 */
export function useTicketsData(wsId: string, filters: TicketFilters) {
  const [tickets, setTickets] = useState<TicketCard[]>([]);
  const [tagCounts, setTagCounts] = useState<TicketTagCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [typingIndicators, setTypingIndicators] = useState<Record<string, string | null>>({});
  // Bumped after every local write — the open detail panel refetches its full
  // ticket on change (SSE changes to the open ticket are handled by the page).
  const [changeNonce, setChangeNonce] = useState(0);

  const localActionCount = useRef(0);
  const requestSeq = useRef(0);
  const ticketsRef = useRef<TicketCard[]>(tickets);
  ticketsRef.current = tickets;

  const queryKey = filtersToSearch(filters).toString();
  const query = useMemo(() => filtersToQuery(filters), [queryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => {
    if (!wsId) { setTickets([]); setLoading(false); return; }
    const seq = ++requestSeq.current;
    try {
      const res = await api.listTickets(wsId, query);
      if (seq !== requestSeq.current) return; // a newer filter/refresh won
      setTickets(Array.isArray(res?.tickets) ? res.tickets : []);
      setTagCounts(Array.isArray(res?.tags) ? res.tags : []);
      setError(null);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      setError(err?.message || '티켓 목록을 불러오지 못했습니다');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [wsId, query]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!wsId) { setUsers([]); setChannels([]); return; }
    let cancelled = false;
    Promise.all([
      api.getUsers(wsId).catch(() => []),
      api.getChannels(wsId).catch(() => []),
    ]).then(([u, c]) => {
      if (cancelled) return;
      setUsers(u as User[]);
      setChannels(c as Channel[]);
    });
    return () => { cancelled = true; };
  }, [wsId]);

  const { subscribe } = useBoardStream();
  useEffect(() => {
    if (!wsId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubUpdate = subscribe('board_update', (data: any) => {
      // The stream is app-wide (one EventSource for every workspace).
      if (data?.workspace_id && data.workspace_id !== wsId) return;
      if (localActionCount.current > 0) return;
      // Coalesce bursts (an agent move + comment + field change arrive together).
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 300);
    });
    const unsubTyping = subscribe('agent_typing', (data: any) => {
      if (!data?.ticket_id) return;
      setTypingIndicators((prev) => ({
        ...prev,
        [data.ticket_id]: data.action === 'started' ? data.actor_name : null,
      }));
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubUpdate();
      unsubTyping();
    };
  }, [wsId, refresh, subscribe]);

  /** Run a local write, then refetch; the SSE echo is muted for a moment. */
  const withLocalAction = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    localActionCount.current += 1;
    try {
      const result = await fn();
      await refresh();
      setChangeNonce((n) => n + 1);
      return result;
    } finally {
      setTimeout(() => { localActionCount.current = Math.max(0, localActionCount.current - 1); }, 500);
    }
  }, [refresh]);

  /** Status/lane move with an optimistic local copy; rolls back on failure. */
  const moveTicket = useCallback(async (ticketId: string, status: TicketStatus, position?: number) => {
    const before = ticketsRef.current;
    setTickets(applyMove(before, ticketId, status, position));
    localActionCount.current += 1;
    try {
      await api.moveTicket(ticketId, status, position);
      await refresh();
      setChangeNonce((n) => n + 1);
    } catch (err) {
      setTickets(before);
      throw err;
    } finally {
      setTimeout(() => { localActionCount.current = Math.max(0, localActionCount.current - 1); }, 500);
    }
  }, [refresh]);

  const createTicket = useCallback(
    (body: TicketCreateInput) => withLocalAction(() => api.createTicket(wsId, body)),
    [withLocalAction, wsId],
  );
  const updateTicket = useCallback(
    (ticketId: string, data: TicketPatch | Record<string, any>) => withLocalAction(() => api.updateTicket(ticketId, data as TicketPatch)),
    [withLocalAction],
  );
  const deleteTicket = useCallback(
    (ticketId: string) => withLocalAction(() => api.deleteTicket(ticketId)),
    [withLocalAction],
  );
  const reparentTicket = useCallback(
    (ticketId: string, parentId: string | null) => withLocalAction(() => api.reparentTicket(ticketId, parentId)),
    [withLocalAction],
  );
  const createChildTicket = useCallback(
    (parentId: string, data: { title: string; description?: string; tags?: string[] }) =>
      withLocalAction(() => api.createChildTicket(parentId, data)),
    [withLocalAction],
  );
  const addComment = useCallback(
    (
      ticketId: string,
      content: string,
      attachments: { file_name: string; file_mimetype: string; file_data: string }[] = [],
      options?: { type?: string; parent_id?: string | null; metadata?: Record<string, unknown>; attachment_resource_ids?: string[] },
    ) => withLocalAction(() => api.addComment(ticketId, content, attachments, options)),
    [withLocalAction],
  );
  const setCommentStatus = useCallback(
    (ticketId: string, commentId: string, status: 'open' | 'resolved') =>
      withLocalAction(() => api.setCommentStatus(ticketId, commentId, status)),
    [withLocalAction],
  );

  return {
    tickets,
    tagCounts,
    loading,
    error,
    users,
    channels,
    typingIndicators,
    changeNonce,
    refresh,
    moveTicket,
    createTicket,
    updateTicket,
    deleteTicket,
    reparentTicket,
    createChildTicket,
    addComment,
    setCommentStatus,
  };
}
