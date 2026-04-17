import { useCallback, useEffect, useState } from 'react';
import { api, UserMentionItem } from '../api';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';

interface UseMentionsResult {
  unreadCount: number;
  unreadItems: UserMentionItem[];
  refresh: () => Promise<void>;
  markRead: (mentionId: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

/**
 * Subscribes to `user_mention` SSE events + fetches the unread list for the
 * current workspace. The fetched list stays in sync across tabs because every
 * mark-as-read path optimistically updates state and the server echoes nothing
 * back — that's intentional (we own the state, not the server).
 */
export function useMentions(workspaceId: string | null): UseMentionsResult {
  const [unreadItems, setUnreadItems] = useState<UserMentionItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setUnreadItems([]);
      setUnreadCount(0);
      return;
    }
    try {
      const data = await api.getUnreadMentions(workspaceId);
      setUnreadItems(data.items);
      setUnreadCount(data.count);
    } catch {
      // Tolerate transient failures — next SSE push will reconcile.
    }
  }, [workspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useBoardStreamEvent('user_mention', (data: any) => {
    if (!data) return;
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
    setUnreadCount(c => c + 1);
  });

  const markRead = useCallback(async (mentionId: string) => {
    setUnreadItems(prev => prev.filter(m => m.id !== mentionId));
    setUnreadCount(c => Math.max(0, c - 1));
    try {
      await api.markMentionRead(mentionId);
    } catch {
      // Roll back on failure — refetch will correct if the user keeps the panel open.
      refresh();
    }
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    if (!workspaceId) return;
    const prevItems = unreadItems;
    const prevCount = unreadCount;
    setUnreadItems([]);
    setUnreadCount(0);
    try {
      await api.markAllMentionsRead(workspaceId);
    } catch {
      setUnreadItems(prevItems);
      setUnreadCount(prevCount);
    }
  }, [workspaceId, unreadItems, unreadCount]);

  return { unreadCount, unreadItems, refresh, markRead, markAllRead };
}
