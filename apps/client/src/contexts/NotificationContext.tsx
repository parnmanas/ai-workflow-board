import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../api';
import { useAuth } from './AuthContext';
import { useBoardStreamEvent } from './BoardStreamContext';

/**
 * NotificationContext — single source of truth for all sidebar badge counts.
 *
 * Why a context instead of per-component hooks:
 *   1. Sidebar is forbidden from importing BoardStreamContext directly
 *      (see its own header comment); a context sitting above it lets the
 *      sidebar stay a dumb reader while still getting live updates.
 *   2. One fetch of each `/…/unread-counts` endpoint per workspace switch
 *      instead of one per badge site.
 *   3. Cross-tab sync: a BroadcastChannel coordinates read-marker changes
 *      between tabs of the same browser so marking read in tab A
 *      immediately clears the badge in tab B without waiting for SSE.
 *   4. Browser Notification gating centralized here — the decision of
 *      "fire an OS notification for this event?" lives with badge state,
 *      not inside every component that happens to listen for SSE events.
 *
 * The provider MUST be mounted BELOW BoardStreamProvider (it uses
 * useBoardStreamEvent) and BELOW AuthProvider (it needs the current user
 * to scope mentions / admin counts). AppLayout.tsx does this.
 */

export type NotificationSource = 'mentions' | 'chat' | 'tickets' | 'pendingUsers' | 'agentErrors';

interface BadgeCounts {
  mentions: number;
  chat: { total: number; perRoom: Record<string, number> };
  tickets: { total: number; perTicket: Record<string, number>; perBoard: Record<string, number> };
  pendingUsers: number;
  agentErrors: number;
}

interface NotificationPrefs {
  // Per-source OS notification toggle. Default: all enabled.
  mentions: boolean;
  chat: boolean;
  tickets: boolean;
  admin: boolean;
  // Audio cue toggle (reused from the existing chat_notify_muted key shape
  // so the preference carries over for users who had it set).
  audio: boolean;
}

interface NotificationContextValue {
  counts: BadgeCounts;
  prefs: NotificationPrefs;
  setPref: (key: keyof NotificationPrefs, value: boolean) => void;
  /** Returned by Notification.permission. 'default' before the user has chosen. */
  notificationPermission: NotificationPermission;
  /** Ask the browser for permission. Safe to call multiple times. */
  requestNotificationPermission: () => Promise<NotificationPermission>;
  /** Force refresh of all counts — use after actions the SSE bus doesn't cover. */
  refresh: () => Promise<void>;
  /** Mark a specific source's counts as locally read (optimistic); tells other tabs. */
  markRead: (source: NotificationSource, key?: string) => void;
  /** Stamp agent-errors "last-seen" so the badge clears until new errors arrive. */
  markAgentErrorsSeen: () => void;
}

const empty: BadgeCounts = {
  mentions: 0,
  chat: { total: 0, perRoom: {} },
  tickets: { total: 0, perTicket: {}, perBoard: {} },
  pendingUsers: 0,
  agentErrors: 0,
};

const defaultPrefs: NotificationPrefs = {
  mentions: true,
  chat: true,
  tickets: true,
  admin: true,
  audio: true,
};

const NotificationContext = createContext<NotificationContextValue | null>(null);

// ─── Preferences persistence ──────────────────────────────────────────
const PREFS_KEY = 'awb.notifications.prefs';
const AGENT_ERRORS_LAST_SEEN_KEY = 'awb.notifications.agentErrorsLastSeen';
// Legacy key used by ToastContext audio toggle. Honoured on first read so
// returning users don't lose their preference, then migrated to PREFS_KEY.
const LEGACY_MUTE_KEY = 'chat_notify_muted';

function loadPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...defaultPrefs, ...parsed };
    }
    // First load — migrate legacy mute.
    const legacyMuted = localStorage.getItem(LEGACY_MUTE_KEY) === 'true';
    return { ...defaultPrefs, audio: !legacyMuted };
  } catch {
    return defaultPrefs;
  }
}

function savePrefs(p: NotificationPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* quota / private mode */
  }
}

// ─── Browser notification dispatcher ──────────────────────────────────
//
// The decision to fire an OS-level notification follows three gates:
//   1. Browser permission granted (Notification.permission === 'granted').
//   2. Per-source pref enabled.
//   3. The tab is actually hidden (document.hidden) — if the user is
//      already looking at the app, OS noti is just noise. The in-app
//      toast system already covers the visible case.
//
// `tag` ensures later notifications for the same target replace earlier
// ones instead of stacking (e.g. three chat messages in the same room
// should coalesce to one system notification).
interface NotiRequest {
  title: string;
  body: string;
  tag: string;
  onClick?: () => void;
}

function fireBrowserNotification(req: NotiRequest) {
  if (typeof window === 'undefined') return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  try {
    const n = new Notification(req.title, {
      body: req.body,
      tag: req.tag,
      icon: '/favicon.svg',
    });
    if (req.onClick) {
      n.onclick = () => {
        try {
          window.focus();
        } catch {
          /* ignore */
        }
        req.onClick?.();
        n.close();
      };
    }
  } catch {
    /* some browsers throw on missing service worker etc. — silent is fine */
  }
}

// ─── Provider ──────────────────────────────────────────────────────────

// Broadcast payload — kept trivially small since this channel is
// per-browser, not per-user, and every message runs on every tab.
type BroadcastMsg =
  | { type: 'mark-read'; source: NotificationSource; key?: string }
  | { type: 'refresh' };

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, currentWorkspaceId } = useAuth();
  const [counts, setCounts] = useState<BadgeCounts>(empty);
  const [prefs, setPrefs] = useState<NotificationPrefs>(loadPrefs);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() =>
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'denied',
  );

  // Used to skip OS notifications on the very first fetch-all so returning
  // users aren't spammed with "N unread" for everything accumulated since
  // last visit. Flipped to true after the initial load completes.
  const notiArmed = useRef(false);
  const bcRef = useRef<BroadcastChannel | null>(null);

  const isAdmin = user?.role === 'admin';

  // ─── Initial fetch + per-workspace refetch ──────────────────────────
  const refresh = useCallback(async () => {
    // Auth gate — endpoints 401 without token; guard against running
    // during the pre-auth flash.
    if (!user) {
      setCounts(empty);
      return;
    }
    const results = await Promise.allSettled([
      currentWorkspaceId ? api.getUnreadMentions(currentWorkspaceId) : Promise.resolve({ count: 0, items: [] }),
      currentWorkspaceId ? api.getChatUnreadCounts() : Promise.resolve({ total: 0, perRoom: {} }),
      currentWorkspaceId ? api.getTicketUnreadCounts() : Promise.resolve({ total: 0, perTicket: {}, perBoard: {} }),
      isAdmin ? api.getPendingUsersCount() : Promise.resolve({ count: 0 }),
      isAdmin
        ? api.getAgentErrorsUnseenCount(localStorage.getItem(AGENT_ERRORS_LAST_SEEN_KEY))
        : Promise.resolve({ count: 0 }),
    ]);
    const unwrap = <T,>(r: PromiseSettledResult<T>, fallback: T): T =>
      r.status === 'fulfilled' ? r.value : fallback;
    const mentions = unwrap(results[0], { count: 0, items: [] }) as { count: number };
    const chat = unwrap(results[1], { total: 0, perRoom: {} }) as { total: number; perRoom: Record<string, number> };
    const tickets = unwrap(results[2], { total: 0, perTicket: {}, perBoard: {} }) as { total: number; perTicket: Record<string, number>; perBoard: Record<string, number> };
    const pendingUsers = unwrap(results[3], { count: 0 }) as { count: number };
    const agentErrors = unwrap(results[4], { count: 0 }) as { count: number };
    setCounts({
      mentions: mentions.count,
      chat,
      tickets,
      pendingUsers: pendingUsers.count,
      agentErrors: agentErrors.count,
    });
    // First fetch of this session — arm OS notifications for future events.
    if (!notiArmed.current) {
      setTimeout(() => {
        notiArmed.current = true;
      }, 1500);
    }
  }, [user, currentWorkspaceId, isAdmin]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ─── BroadcastChannel cross-tab sync ────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    const bc = new BroadcastChannel('awb-notifications');
    bcRef.current = bc;
    bc.onmessage = (ev) => {
      const msg = ev.data as BroadcastMsg;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'refresh') {
        void refresh();
      } else if (msg.type === 'mark-read') {
        applyMarkRead(msg.source, msg.key);
      }
    };
    return () => {
      bc.close();
      bcRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const broadcast = useCallback((msg: BroadcastMsg) => {
    try {
      bcRef.current?.postMessage(msg);
    } catch {
      /* channel closed */
    }
  }, []);

  // Pure state mutation — shared between local mark-read and broadcast
  // receiver so both paths converge on the same shape.
  const applyMarkRead = useCallback((source: NotificationSource, key?: string) => {
    setCounts((prev) => {
      switch (source) {
        case 'mentions':
          return { ...prev, mentions: 0 };
        case 'chat':
          if (key) {
            const was = prev.chat.perRoom[key] || 0;
            const { [key]: _removed, ...rest } = prev.chat.perRoom;
            void _removed;
            return {
              ...prev,
              chat: { total: Math.max(0, prev.chat.total - was), perRoom: rest },
            };
          }
          return { ...prev, chat: { total: 0, perRoom: {} } };
        case 'tickets':
          if (key) {
            const was = prev.tickets.perTicket[key] || 0;
            const { [key]: _removed, ...rest } = prev.tickets.perTicket;
            void _removed;
            return {
              ...prev,
              tickets: { total: Math.max(0, prev.tickets.total - was), perTicket: rest, perBoard: prev.tickets.perBoard },
            };
          }
          return { ...prev, tickets: { total: 0, perTicket: {}, perBoard: {} } };
        case 'pendingUsers':
          return { ...prev, pendingUsers: 0 };
        case 'agentErrors':
          return { ...prev, agentErrors: 0 };
        default:
          return prev;
      }
    });
  }, []);

  const markRead = useCallback(
    (source: NotificationSource, key?: string) => {
      applyMarkRead(source, key);
      broadcast({ type: 'mark-read', source, key });
    },
    [applyMarkRead, broadcast],
  );

  const markAgentErrorsSeen = useCallback(() => {
    try {
      localStorage.setItem(AGENT_ERRORS_LAST_SEEN_KEY, new Date().toISOString());
    } catch {
      /* quota */
    }
    markRead('agentErrors');
  }, [markRead]);

  // ─── SSE-driven live updates ────────────────────────────────────────
  // user_mention (the existing hook useMentions also listens for this,
  // and MentionInboxBadge uses that hook; keeping both in sync is fine —
  // the badge count here is the authoritative one for the sidebar badges
  // section, MentionInboxBadge keeps its own list for the dropdown).
  useBoardStreamEvent('user_mention', (raw: any) => {
    if (!user) return;
    if (raw?.workspace_id && currentWorkspaceId && raw.workspace_id !== currentWorkspaceId) return;
    setCounts((prev) => ({ ...prev, mentions: prev.mentions + 1 }));
    if (notiArmed.current && prefs.mentions) {
      fireBrowserNotification({
        title: `@${raw?.actor_name || 'someone'} mentioned you`,
        body: raw?.preview || '',
        tag: `mention:${raw?.mention_id || Date.now()}`,
      });
    }
  });

  // chat_room_message — increment room unread if I'm a participant,
  // I'm not the sender, and I'm not currently viewing that room.
  useBoardStreamEvent('chat_room_message', (raw: any) => {
    if (!user) return;
    if (raw?.workspace_id && currentWorkspaceId && raw.workspace_id !== currentWorkspaceId) return;
    // Progress rows (tool-call heartbeats) never bump unread/badge/browser
    // notifications — only real chat turns count. Mirrors server-side unread
    // semantics and the active ChatPage handler.
    if (raw?.type === 'progress') return;
    const roomId: string | undefined = raw?.room_id;
    if (!roomId) return;
    const senderId: string | undefined = raw?.sender_id;
    const senderType: string | undefined = raw?.sender_type;
    // Skip self-echoes.
    if (senderType === 'user' && senderId === user.id) return;
    // Skip if the user is currently on that room's page (simple URL check).
    const active = isRoomActive(roomId);
    if (active) return;

    setCounts((prev) => {
      const next = { ...prev.chat.perRoom, [roomId]: (prev.chat.perRoom[roomId] || 0) + 1 };
      return { ...prev, chat: { total: prev.chat.total + 1, perRoom: next } };
    });
    if (notiArmed.current && prefs.chat) {
      fireBrowserNotification({
        title: `${raw?.sender_name || 'New message'}`,
        body: typeof raw?.content === 'string' ? raw.content.slice(0, 140) : '',
        tag: `chat:${roomId}`,
      });
    }
  });

  // chat_room_update with event=read propagates cross-device read state
  // — clear this room's unread if it's me.
  useBoardStreamEvent('chat_room_update', (raw: any) => {
    if (!user) return;
    if (raw?.event !== 'read') return;
    if (raw?.participant_type !== 'user' || raw?.participant_id !== user.id) return;
    const roomId: string | undefined = raw?.room_id;
    if (!roomId) return;
    applyMarkRead('chat', roomId);
  });

  // board_update carrying an 'activity' with entity_type='comment' and
  // action='created' → a new comment landed. If the ticket is one I'm
  // involved in and I'm not viewing it, treat as an unread bump.
  useBoardStreamEvent('board_update', (raw: any) => {
    if (!user) return;
    if (raw?.entity_type !== 'comment' || raw?.action !== 'created') return;
    const ticketId: string | undefined = raw?.ticket_id;
    if (!ticketId) return;
    if (raw?.actor_id === user.id) return;
    if (isTicketActive(ticketId)) return;
    // Only bump if the ticket is already in perTicket (meaning the user
    // had an existing unread) or if they're explicitly involved — without
    // a DB round-trip we conservatively only bump existing entries and
    // rely on the periodic refresh() to pick up new involvement.
    setCounts((prev) => {
      const had = prev.tickets.perTicket[ticketId];
      if (had === undefined) return prev;
      return {
        ...prev,
        tickets: {
          total: prev.tickets.total + 1,
          perTicket: { ...prev.tickets.perTicket, [ticketId]: had + 1 },
          perBoard: prev.tickets.perBoard,
        },
      };
    });
    if (notiArmed.current && prefs.tickets) {
      fireBrowserNotification({
        title: 'New comment',
        body: typeof raw?.content === 'string' ? raw.content.slice(0, 140) : 'A ticket you follow has a new comment',
        tag: `ticket-comment:${ticketId}`,
      });
    }
  });

  // ─── Periodic refresh ────────────────────────────────────────────────
  // Covers counters SSE doesn't pipe (pending users, agent errors without
  // a dedicated stream, and ticket involvements not yet in perTicket).
  // 60 s is conservative — the bulk of responsiveness comes from SSE.
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [user, refresh]);

  // Refetch when the tab becomes visible again — people leave the app
  // overnight and come back expecting accurate badges.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  // ─── Prefs + permission ─────────────────────────────────────────────
  const setPref = useCallback((key: keyof NotificationPrefs, value: boolean) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      savePrefs(next);
      return next;
    });
  }, []);

  const requestNotificationPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'denied' as NotificationPermission;
    try {
      const result = await Notification.requestPermission();
      setNotificationPermission(result);
      return result;
    } catch {
      return notificationPermission;
    }
  }, [notificationPermission]);

  const value = useMemo<NotificationContextValue>(
    () => ({
      counts,
      prefs,
      setPref,
      notificationPermission,
      requestNotificationPermission,
      refresh,
      markRead,
      markAgentErrorsSeen,
    }),
    [counts, prefs, setPref, notificationPermission, requestNotificationPermission, refresh, markRead, markAgentErrorsSeen],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within <NotificationProvider>');
  return ctx;
}

// Lightweight URL-matching helpers used to decide whether a new event
// should bump a badge. Kept out of React state because re-checking URL
// on every event is cheaper than subscribing to useLocation + re-deriving.
function isRoomActive(roomId: string): boolean {
  if (typeof window === 'undefined') return false;
  const p = window.location.pathname;
  // Chat page paths: /ws/:wsId/chat (rooms all on one page) OR
  // /ws/:wsId/chat/:roomId if per-room routes get added.
  if (!p.includes('/chat')) return false;
  // Per-room route check — best-effort, false-positives only mean we
  // skip a badge bump that the user would see on-screen anyway.
  if (p.includes(roomId)) return true;
  // On the generic chat page, check the query/hash for an active room id
  // so in-app navigation (e.g. ?room=xyz) still suppresses badge bumps.
  const qh = window.location.search + '#' + window.location.hash;
  return qh.includes(roomId);
}

function isTicketActive(ticketId: string): boolean {
  if (typeof window === 'undefined') return false;
  const p = window.location.pathname + window.location.search + window.location.hash;
  return p.includes(ticketId);
}
