import { useCallback, useEffect, useState } from 'react';
import { api, UserMentionItem } from '../api';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useNotifications, unwrapStreamEvent } from '../contexts/NotificationContext';

interface UseMentionsResult {
  /** Authoritative unread count — mirrors the sidebar badge exactly. */
  unreadCount: number;
  /** Newest-first unread rows for the inbox drop-down (server caps at 50). */
  unreadItems: UserMentionItem[];
  /** True when the server has more unread rows than the list carries. */
  hasMoreThanListed: boolean;
  refresh: () => Promise<void>;
  markRead: (mentionId: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

/**
 * Subscribes to `user_mention` SSE events + fetches the unread list for the
 * current workspace.
 *
 * The COUNT is not owned here — it comes from NotificationContext, which is
 * the single source of truth for every badge. This hook used to keep its own
 * counter fed by its own SSE subscription, so the inbox button and the rest
 * of the badge system could (and did) show different numbers for the same
 * inbox: the list is capped at 50 rows while the count is not, and the two
 * decremented on different events.
 */
export function useMentions(workspaceId: string | null): UseMentionsResult {
  const [unreadItems, setUnreadItems] = useState<UserMentionItem[]>([]);
  const notifications = useNotifications();
  const unreadCount = notifications.counts.mentions;

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setUnreadItems([]);
      return;
    }
    try {
      const data = await api.getUnreadMentions(workspaceId);
      setUnreadItems(data.items);
    } catch {
      // Tolerate transient failures — next SSE push will reconcile.
    }
  }, [workspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useBoardStreamEvent('user_mention', (raw: any) => {
    const data = unwrapStreamEvent(raw);
    if (!data) return;
    // A row with no id is unusable: it can't be marked read, it can't be
    // deduped (every such row collides), and it can't be navigated. Drop it
    // and let the next REST refresh supply the real row rather than putting a
    // "someone · Invalid Date · (no preview)" line in front of the user.
    if (!data.mention_id) return;
    // Ignore events for other workspaces (the server already filters by user,
    // but a user can belong to multiple workspaces).
    if (workspaceId && data.workspace_id && data.workspace_id !== workspaceId) return;

    const item: UserMentionItem = {
      id: data.mention_id,
      user_id: data.user_id,
      workspace_id: data.workspace_id,
      source_type: data.source_type,
      source_id: data.source_id,
      ticket_id: data.ticket_id ?? null,
      board_id: data.board_id ?? null,
      room_id: data.room_id ?? null,
      actor_id: data.actor_id,
      actor_type: data.actor_type,
      actor_name: data.actor_name,
      preview: data.preview,
      created_at: data.created_at,
      read_at: null,
    };
    setUnreadItems(prev => {
      if (prev.some(p => p.id === item.id)) return prev;
      return [item, ...prev];
    });
    // The count itself is bumped by NotificationContext's own subscription.
  });

  const markRead = useCallback(async (mentionId: string) => {
    const prevItems = unreadItems;
    setUnreadItems(prev => prev.filter(m => m.id !== mentionId));
    // Optimistic single-row decrement. The old code re-fetched all five
    // badge endpoints after every single mention click just to learn a
    // number it already knew.
    notifications.markRead('mentions', mentionId);
    try {
      await api.markMentionRead(mentionId);
    } catch {
      // Roll back both halves on failure so the list and the badge agree.
      setUnreadItems(prevItems);
      notifications.refresh();
    }
  }, [unreadItems, notifications]);

  const markAllRead = useCallback(async () => {
    if (!workspaceId) return;
    const prevItems = unreadItems;
    setUnreadItems([]);
    notifications.markRead('mentions');
    try {
      await api.markAllMentionsRead(workspaceId);
    } catch {
      setUnreadItems(prevItems);
      notifications.refresh();
    }
  }, [workspaceId, unreadItems, notifications]);

  return {
    unreadCount,
    unreadItems,
    hasMoreThanListed: unreadCount > unreadItems.length,
    refresh,
    markRead,
    markAllRead,
  };
}
