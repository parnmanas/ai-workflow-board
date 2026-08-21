import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';
import { useBoardStreamEvent } from './BoardStreamContext';
import { renderMentionPreview } from '../utils/mentionPreview';
import {
  getNotificationPrefs,
  setNotificationPref,
  subscribeNotificationPrefs,
  type NotificationPrefs,
} from './notificationPrefs';

/**
 * NotificationContext — single source of truth for badge counts AND for the
 * user-facing notification surfaces they summarize (in-app toast, OS
 * notification, tab-title counter).
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
 *   4. One place decides "does this event deserve a notification?", so a
 *      chat message announces itself identically whether the user happens
 *      to be on the chat page or on a board. Announcing used to live inside
 *      ChatPage, which meant the same event was loud on one route and
 *      silent on every other one.
 *
 * Every notification this provider raises is *navigable*: toast click and OS
 * notification click both route to the thing being announced. A notification
 * you cannot follow is worse than no notification.
 *
 * The provider MUST be mounted BELOW BoardStreamProvider (it uses
 * useBoardStreamEvent), BELOW AuthProvider (it needs the current user
 * to scope mentions / admin counts), and inside the Router (it navigates).
 * AppLayout.tsx does this.
 */

export type NotificationSource = 'mentions' | 'chat' | 'tickets' | 'pendingUsers' | 'agentErrors';

interface BadgeCounts {
  mentions: number;
  chat: { total: number; perRoom: Record<string, number> };
  tickets: {
    total: number;
    perTicket: Record<string, number>;
    perBoard: Record<string, number>;
    /** ticketId → boardId, so marking one ticket read decrements the right board. */
    ticketBoard: Record<string, string>;
  };
  pendingUsers: number;
  agentErrors: number;
}

interface NotificationContextValue {
  counts: BadgeCounts;
  /**
   * False until the first successful count fetch for the current workspace.
   * Consumers that also hold a local snapshot (e.g. the sidebar room list)
   * use it to know whether an absent entry means "server says zero" or
   * "not loaded yet" — otherwise a zero-by-omission looks like a real zero
   * and reads as a badge that flickers off and back on at mount.
   */
  countsLoaded: boolean;
  /** Sum of the counts that represent "something is waiting for me". */
  totalUnread: number;
  prefs: NotificationPrefs;
  setPref: (key: keyof NotificationPrefs, value: boolean) => void;
  /** Returned by Notification.permission. 'default' before the user has chosen. */
  notificationPermission: NotificationPermission;
  /** Ask the browser for permission. Safe to call multiple times. */
  requestNotificationPermission: () => Promise<NotificationPermission>;
  /** Force refresh of all counts — use after actions the SSE bus doesn't cover. */
  refresh: () => Promise<void>;
  /**
   * Mark a source's counts as locally read (optimistic); tells other tabs.
   * With a `key`: that room / ticket / mention only. Without: the whole source.
   */
  markRead: (source: NotificationSource, key?: string) => void;
  /**
   * 한 보드로 롤업되는 모든 티켓-코멘트 뱃지를 0으로 만든다(사이드바/보드
   * 페이지의 "모두 읽음" 액션) — optimistic, 다른 탭에도 알린다.
   * `boardId` 를 생략하면 모든 보드를 지운다(워크스페이스 전체 "모두 읽음").
   */
  markTicketsReadForBoard: (boardId?: string) => void;
  /**
   * Drop `count` mentions from the badge because the server cleared them as a
   * side effect of the caller reading their source (a ticket thread or a chat
   * room). Pass the `mentions_cleared` the read endpoint returned; 0 is a
   * no-op, so callers can hand the response straight through.
   */
  noteMentionsCleared: (count: number) => void;
  /** Stamp agent-errors "last-seen" so the badge clears until new errors arrive. */
  markAgentErrorsSeen: () => void;
}

const empty: BadgeCounts = {
  mentions: 0,
  chat: { total: 0, perRoom: {} },
  tickets: { total: 0, perTicket: {}, perBoard: {}, ticketBoard: {} },
  pendingUsers: 0,
  agentErrors: 0,
};

const NotificationContext = createContext<NotificationContextValue | null>(null);

const AGENT_ERRORS_LAST_SEEN_KEY = 'awb.notifications.agentErrorsLastSeen';

// Base document title. The unread counter is prefixed onto this and removed
// again when everything is read, so the tab never keeps a stale "(1)".
const BASE_TITLE = 'AWB';

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
  | { type: 'mark-tickets-read-for-board'; boardId?: string }
  | { type: 'mentions-cleared'; count: number }
  | { type: 'refresh' };

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, currentWorkspaceId, hasPermission } = useAuth();
  const navigate = useNavigate();
  const { showToast, playNotifySound } = useToast();
  const [counts, setCounts] = useState<BadgeCounts>(empty);
  const [countsLoaded, setCountsLoaded] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPrefs>(getNotificationPrefs);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() =>
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'denied',
  );

  // Used to skip OS notifications on the very first fetch-all so returning
  // users aren't spammed with "N unread" for everything accumulated since
  // last visit. Flipped to true after the initial load completes.
  const notiArmed = useRef(false);
  const bcRef = useRef<BroadcastChannel | null>(null);

  // SSE handlers are registered once and would otherwise close over a stale
  // `prefs` / `currentWorkspaceId`. Refs keep the gate decisions current
  // without re-subscribing on every preference flip.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const wsIdRef = useRef(currentWorkspaceId);
  wsIdRef.current = currentWorkspaceId;

  // Mirror of `counts` readable synchronously inside an event handler. A
  // setCounts updater is NOT guaranteed to run at dispatch time, so a handler
  // that needs to branch on the current counts (e.g. "do I already track this
  // ticket?") cannot learn that from inside the updater. Every write goes
  // through mutateCounts so the mirror can never drift.
  const countsRef = useRef(counts);
  const mutateCounts = useCallback((fn: (prev: BadgeCounts) => BadgeCounts) => {
    setCounts((prev) => {
      const next = fn(prev);
      countsRef.current = next;
      return next;
    });
  }, []);
  const replaceCounts = useCallback((next: BadgeCounts) => {
    countsRef.current = next;
    setCounts(next);
  }, []);

  useEffect(() => subscribeNotificationPrefs(setPrefs), []);

  // The sidebar shows the admin rows to anyone holding `admin.access`, so the
  // counts behind those rows must be fetched on the same test. Gating the
  // fetch on `role === 'admin'` left permission-based admins looking at rows
  // whose badge was hard-wired to zero.
  const isAdmin = hasPermission('admin.access');

  // ─── Initial fetch + per-workspace refetch ──────────────────────────
  const refresh = useCallback(async () => {
    // Auth gate — endpoints 401 without token; guard against running
    // during the pre-auth flash.
    if (!user) {
      replaceCounts(empty);
      setCountsLoaded(false);
      return;
    }
    const results = await Promise.allSettled([
      currentWorkspaceId ? api.getUnreadMentions(currentWorkspaceId) : Promise.resolve({ count: 0, items: [] }),
      currentWorkspaceId ? api.getChatUnreadCounts() : Promise.resolve({ total: 0, perRoom: {} }),
      currentWorkspaceId
        ? api.getTicketUnreadCounts()
        : Promise.resolve({ total: 0, perTicket: {}, perBoard: {}, ticketBoard: {} }),
      isAdmin ? api.getPendingUsersCount() : Promise.resolve({ count: 0 }),
      isAdmin
        ? api.getAgentErrorsUnseenCount(localStorage.getItem(AGENT_ERRORS_LAST_SEEN_KEY))
        : Promise.resolve({ count: 0 }),
    ]);
    const unwrap = <T,>(r: PromiseSettledResult<T>, fallback: T): T =>
      r.status === 'fulfilled' ? r.value : fallback;
    const mentions = unwrap(results[0], { count: 0, items: [] }) as { count: number };
    const chat = unwrap(results[1], { total: 0, perRoom: {} }) as { total: number; perRoom: Record<string, number> };
    const tickets = unwrap(results[2], { total: 0, perTicket: {}, perBoard: {}, ticketBoard: {} }) as {
      total: number;
      perTicket: Record<string, number>;
      perBoard: Record<string, number>;
      ticketBoard?: Record<string, string>;
    };
    const pendingUsers = unwrap(results[3], { count: 0 }) as { count: number };
    const agentErrors = unwrap(results[4], { count: 0 }) as { count: number };
    replaceCounts({
      mentions: mentions.count,
      chat,
      tickets: {
        total: tickets.total,
        perTicket: tickets.perTicket || {},
        perBoard: tickets.perBoard || {},
        ticketBoard: tickets.ticketBoard || {},
      },
      pendingUsers: pendingUsers.count,
      agentErrors: agentErrors.count,
    });
    setCountsLoaded(true);
    // First fetch of this session — arm OS notifications for future events.
    if (!notiArmed.current) {
      setTimeout(() => {
        notiArmed.current = true;
      }, 1500);
    }
  }, [user, currentWorkspaceId, isAdmin, replaceCounts]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A workspace switch invalidates every workspace-scoped count. Clear them
  // eagerly so the previous workspace's numbers don't linger on screen for
  // the duration of the refetch.
  useEffect(() => {
    setCountsLoaded(false);
    mutateCounts((prev) => ({
      ...prev,
      mentions: 0,
      chat: { total: 0, perRoom: {} },
      tickets: { total: 0, perTicket: {}, perBoard: {}, ticketBoard: {} },
    }));
  }, [currentWorkspaceId, mutateCounts]);

  // Pure state mutation — shared between local mark-read and broadcast
  // receiver so both paths converge on the same shape.
  const applyMarkRead = useCallback((source: NotificationSource, key?: string) => {
    mutateCounts((prev) => {
      switch (source) {
        case 'mentions':
          // With a key this is "one mention read", not "inbox emptied" —
          // zeroing the whole badge on a single read made the number jump to
          // 0 and then snap back to the real remainder on the next refresh.
          if (key) return { ...prev, mentions: Math.max(0, prev.mentions - 1) };
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
            if (was === 0) return prev;
            const { [key]: _removed, ...rest } = prev.tickets.perTicket;
            void _removed;
            // Keep the board roll-up honest: without this the board badge
            // held the old number while the ticket's own count was gone.
            const boardId = prev.tickets.ticketBoard[key];
            const perBoard = { ...prev.tickets.perBoard };
            if (boardId && perBoard[boardId] !== undefined) {
              const next = Math.max(0, perBoard[boardId] - was);
              if (next === 0) delete perBoard[boardId];
              else perBoard[boardId] = next;
            }
            return {
              ...prev,
              tickets: {
                total: Math.max(0, prev.tickets.total - was),
                perTicket: rest,
                perBoard,
                ticketBoard: prev.tickets.ticketBoard,
              },
            };
          }
          return { ...prev, tickets: { total: 0, perTicket: {}, perBoard: {}, ticketBoard: {} } };
        case 'agentErrors':
          return { ...prev, agentErrors: 0 };
        case 'pendingUsers':
          // Deliberately NOT clearable: unlike the others this is not a
          // read-marker but a live server count of accounts still awaiting
          // approval. Zeroing it on "I looked at the page" made the badge
          // vanish and then reappear on the next poll while the queue was
          // still full. It clears when the queue actually empties.
          return prev;
        default:
          return prev;
      }
    });
  }, [mutateCounts]);

  // Pure state mutation for "the server already cleared N mentions because
  // their source was read". Declared above the BroadcastChannel effect that
  // depends on it — a `const` referenced in a dep array further up the
  // component body would hit the temporal dead zone on the first render.
  const applyMentionsCleared = useCallback((count: number) => {
    if (!Number.isFinite(count) || count <= 0) return;
    mutateCounts((prev) => ({ ...prev, mentions: Math.max(0, prev.mentions - count) }));
  }, [mutateCounts]);

  // 보드 스코프(또는 boardId 생략 시 워크스페이스 전체) "모두 읽음" 액션을
  // 위한 순수 상태 변경. 티켓 하나만 지우는 applyMarkRead('tickets', key)
  // 와 달리, ticketBoard 를 훑어 주어진 보드로 롤업되는 모든 티켓을 한 번에
  // 지운다 — 그래야 보드 뱃지와 그 보드의 모든 TicketCard 뱃지가 N번의
  // 개별 클리어에 뒤처지지 않고 함께 0으로 떨어진다.
  const applyMarkTicketsReadForBoard = useCallback((boardId?: string) => {
    mutateCounts((prev) => {
      if (!boardId) {
        return { ...prev, tickets: { total: 0, perTicket: {}, perBoard: {}, ticketBoard: {} } };
      }
      const perTicket = { ...prev.tickets.perTicket };
      const ticketBoard = { ...prev.tickets.ticketBoard };
      let removed = 0;
      for (const [ticketId, tBoardId] of Object.entries(prev.tickets.ticketBoard)) {
        if (tBoardId !== boardId) continue;
        removed += perTicket[ticketId] || 0;
        delete perTicket[ticketId];
        delete ticketBoard[ticketId];
      }
      if (removed === 0) return prev;
      const perBoard = { ...prev.tickets.perBoard };
      delete perBoard[boardId];
      return {
        ...prev,
        tickets: { total: Math.max(0, prev.tickets.total - removed), perTicket, perBoard, ticketBoard },
      };
    });
  }, [mutateCounts]);

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
      } else if (msg.type === 'mark-tickets-read-for-board') {
        applyMarkTicketsReadForBoard(msg.boardId);
      } else if (msg.type === 'mentions-cleared') {
        applyMentionsCleared(msg.count);
      }
    };
    return () => {
      bc.close();
      bcRef.current = null;
    };
  }, [refresh, applyMarkRead, applyMarkTicketsReadForBoard, applyMentionsCleared]);

  const broadcast = useCallback((msg: BroadcastMsg) => {
    try {
      bcRef.current?.postMessage(msg);
    } catch {
      /* channel closed */
    }
  }, []);

  const markRead = useCallback(
    (source: NotificationSource, key?: string) => {
      applyMarkRead(source, key);
      broadcast({ type: 'mark-read', source, key });
    },
    [applyMarkRead, broadcast],
  );

  const markTicketsReadForBoard = useCallback(
    (boardId?: string) => {
      applyMarkTicketsReadForBoard(boardId);
      broadcast({ type: 'mark-tickets-read-for-board', boardId });
    },
    [applyMarkTicketsReadForBoard, broadcast],
  );

  const noteMentionsCleared = useCallback(
    (count: number) => {
      if (!Number.isFinite(count) || count <= 0) return;
      applyMentionsCleared(count);
      broadcast({ type: 'mentions-cleared', count });
    },
    [applyMentionsCleared, broadcast],
  );

  const markAgentErrorsSeen = useCallback(() => {
    try {
      localStorage.setItem(AGENT_ERRORS_LAST_SEEN_KEY, new Date().toISOString());
    } catch {
      /* quota */
    }
    markRead('agentErrors');
  }, [markRead]);

  // Coalesced refresh — several SSE events can land in the same tick and each
  // would otherwise fire its own 5-endpoint refetch.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 1500);
  }, [refresh]);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  // ─── Notification raising ───────────────────────────────────────────
  // One helper so every source announces itself the same way: an in-app
  // toast when the tab is visible, an OS notification when it isn't, the
  // audio cue in both cases, and the SAME click target for both.
  const announce = useCallback(
    (opts: {
      source: keyof NotificationPrefs;
      title: string;
      body: string;
      tag: string;
      navigateTo?: string;
    }) => {
      if (!notiArmed.current) return;
      if (!prefsRef.current[opts.source]) return;
      const go = opts.navigateTo ? () => navigate(opts.navigateTo!) : undefined;
      if (document.hidden) {
        fireBrowserNotification({ title: opts.title, body: opts.body, tag: opts.tag, onClick: go });
      } else {
        const text = opts.body ? `${opts.title}: ${opts.body}` : opts.title;
        showToast(text, 'info', { onClick: go });
      }
      playNotifySound();
    },
    [navigate, showToast, playNotifySound],
  );

  // ─── SSE-driven live updates ────────────────────────────────────────
  useBoardStreamEvent('user_mention', (rawFrame: any) => {
    if (!user) return;
    const raw = unwrapStreamEvent(rawFrame);
    if (!raw?.mention_id) return;
    const wsId = wsIdRef.current;
    if (raw?.workspace_id && wsId && raw.workspace_id !== wsId) return;
    mutateCounts((prev) => ({ ...prev, mentions: prev.mentions + 1 }));
    announce({
      source: 'mentions',
      title: `${raw?.actor_name || '누군가'}님이 회원님을 멘션했습니다`,
      // The stored preview is raw comment/message text and still carries the
      // `@[user:<uuid>|이름]` tokens — printing it as-is put a UUID in the
      // middle of the notification body.
      body: renderMentionPreview(raw?.preview).slice(0, 140),
      tag: `mention:${raw.mention_id}`,
      navigateTo: mentionTarget(raw, wsId),
    });
  });

  // chat_room_message — increment room unread if I'm a participant,
  // I'm not the sender, and I'm not currently viewing that room.
  useBoardStreamEvent('chat_room_message', (raw: any) => {
    if (!user) return;
    const wsId = wsIdRef.current;
    // SSE delivery is scoped by room membership, not workspace, so a user in
    // two workspaces gets both workspaces' traffic here. Without this check
    // the badge for the workspace on screen counted foreign rooms it never
    // lists — a number the user could not act on or clear.
    if (raw?.workspace_id && wsId && raw.workspace_id !== wsId) return;
    // Action-Run and Orchestration-Step rooms reuse the chat pipeline but are
    // deliberately hidden from the chat list (they live inside the Action /
    // Mission detail views). Counting them produced a total that no visible
    // room accounted for and that nothing could ever mark read.
    if (raw?.is_action_room) return;
    // Progress rows (tool-call heartbeats) never bump unread/badge/browser
    // notifications — only real chat turns count. Mirrors server-side unread
    // semantics (listRooms filters `type <> 'progress'`).
    if (raw?.type === 'progress') return;
    const roomId: string | undefined = raw?.room_id;
    if (!roomId) return;
    const senderId: string | undefined = raw?.sender_id;
    const senderType: string | undefined = raw?.sender_type;
    // Skip self-echoes.
    if (senderType === 'user' && senderId === user.id) return;
    // Skip if the user is currently on that room's page (simple URL check).
    if (isRoomActive(roomId)) return;

    mutateCounts((prev) => {
      const next = { ...prev.chat.perRoom, [roomId]: (prev.chat.perRoom[roomId] || 0) + 1 };
      return { ...prev, chat: { total: prev.chat.total + 1, perRoom: next } };
    });
    announce({
      source: 'chat',
      title: raw?.sender_name || 'New message',
      body: typeof raw?.content === 'string' ? raw.content.slice(0, 140) : '',
      tag: `chat:${roomId}`,
      navigateTo: wsId ? `/ws/${wsId}/chat/${encodeURIComponent(roomId)}` : undefined,
    });
  });

  // chat_room_update with update_type=read propagates cross-device read state
  // — clear this room's unread if it's me.
  useBoardStreamEvent('chat_room_update', (raw: any) => {
    if (!user) return;
    // The wire field is `update_type` (ChatRoomUpdatePayload). This used to
    // read `raw.event`, which is never set, so every read-sync event was
    // dropped and a room read on another device stayed lit here forever.
    if (raw?.update_type !== 'read') return;
    if (raw?.participant_type !== 'user' || raw?.participant_id !== user.id) return;
    const roomId: string | undefined = raw?.room_id;
    if (!roomId) return;
    applyMarkRead('chat', roomId);
  });

  // 티켓 628f4b39 — ticket_reads_cleared 는 이 "모두 읽음"을 실행한 본인의
  // 다른 탭/기기 세션에만 전달된다(서버 필터가 user_id 로 스코프). 로컬에서
  // 직접 누른 경우엔 markTicketsReadForBoard 가 이미 상태를 지우고 이
  // BroadcastChannel 로도 알렸으므로, 여기선 순수 mutator(applyMark...)만
  // 불러 재브로드캐스트 루프를 만들지 않는다 — chat_room_update 읽음 동기화와
  // 동일한 패턴.
  useBoardStreamEvent('ticket_reads_cleared', (rawFrame: any) => {
    if (!user) return;
    const raw = unwrapStreamEvent(rawFrame);
    if (!raw?.user_id || raw.user_id !== user.id) return;
    const wsId = wsIdRef.current;
    if (raw?.workspace_id && wsId && raw.workspace_id !== wsId) return;
    applyMarkTicketsReadForBoard(raw?.board_id || undefined);
  });

  // board_update carrying an 'activity' with entity_type='comment' and
  // action='created' → a new comment landed on a ticket.
  useBoardStreamEvent('board_update', (raw: any) => {
    if (!user) return;
    if (raw?.entity_type !== 'comment' || raw?.action !== 'created') return;
    const ticketId: string | undefined = raw?.ticket_id;
    if (!ticketId) return;
    // Own comments must not raise the viewer's own unread badge. `actor_id`
    // is the authoritative check — comparing names cannot work, since agent
    // actors are re-projected to "<Manager>/<Agent>" before emit.
    if (raw?.actor_id && raw.actor_id === user.id) return;
    if (isTicketActive(ticketId)) return;

    const boardId: string | undefined = raw?.board_id || undefined;
    // A ticket with no unread yet isn't in perTicket, and this event doesn't
    // say whether the viewer is involved in it. So: bump what we already
    // track, and let a debounced refetch settle involvement for the rest.
    // Previously those comments were dropped outright, leaving a badge at 0
    // for up to a minute after the comment that should have raised it.
    const tracked = countsRef.current.tickets.perTicket[ticketId] !== undefined;
    if (!tracked) {
      scheduleRefresh();
      return;
    }
    mutateCounts((prev) => {
      const had = prev.tickets.perTicket[ticketId];
      if (had === undefined) return prev;
      const perBoard = { ...prev.tickets.perBoard };
      const knownBoard = prev.tickets.ticketBoard[ticketId] || boardId;
      if (knownBoard) perBoard[knownBoard] = (perBoard[knownBoard] || 0) + 1;
      return {
        ...prev,
        tickets: {
          total: prev.tickets.total + 1,
          perTicket: { ...prev.tickets.perTicket, [ticketId]: had + 1 },
          perBoard,
          ticketBoard: knownBoard
            ? { ...prev.tickets.ticketBoard, [ticketId]: knownBoard }
            : prev.tickets.ticketBoard,
        },
      };
    });
    announce({
      source: 'tickets',
      title: `New comment from ${raw?.actor_name || 'someone'}`,
      body: raw?.current_column_name ? `in ${raw.current_column_name}` : '',
      tag: `ticket-comment:${ticketId}`,
      navigateTo: ticketTarget(wsIdRef.current, boardId, ticketId),
    });
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

  // ─── Tab title counter ───────────────────────────────────────────────
  // Owned here rather than by whichever page happens to be mounted. ChatPage
  // used to hard-code `document.title = '(1) AWB'` on every incoming message
  // and never restore it, so the tab claimed exactly one unread forever.
  const totalUnread =
    counts.mentions + counts.chat.total + counts.tickets.total;
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread > 99 ? '99+' : totalUnread}) ${BASE_TITLE}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [totalUnread]);

  // ─── Prefs + permission ─────────────────────────────────────────────
  const setPref = useCallback((key: keyof NotificationPrefs, value: boolean) => {
    setPrefs(setNotificationPref(key, value));
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
      countsLoaded,
      totalUnread,
      prefs,
      setPref,
      notificationPermission,
      requestNotificationPermission,
      refresh,
      markRead,
      markTicketsReadForBoard,
      noteMentionsCleared,
      markAgentErrorsSeen,
    }),
    [counts, countsLoaded, totalUnread, prefs, setPref, notificationPermission, requestNotificationPermission, refresh, markRead, markTicketsReadForBoard, noteMentionsCleared, markAgentErrorsSeen],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within <NotificationProvider>');
  return ctx;
}

// Re-exported so consumers of this context (NotificationSettingsPanel) can
// type against the prefs record without reaching past it.
export type { NotificationPrefs };

/**
 * Accepts either an already-flat SSE frame or the raw `{ event_type, scope,
 * payload, timestamp }` envelope and returns the flat fields.
 *
 * The server flattens every event the web UI consumes, but `user_mention`
 * shipped the envelope for a while and nothing noticed, because reading
 * `data.mention_id` off an envelope yields `undefined` instead of throwing —
 * the mention inbox filled with blank, unclickable rows while the badge kept
 * counting. Normalizing at the boundary means a shape regression degrades to
 * "the REST refresh wins" instead of "the UI shows nonsense".
 */
export function unwrapStreamEvent(raw: any): any {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.payload && typeof raw.payload === 'object' && raw.event_type) return raw.payload;
  return raw;
}

// ─── Deep-link builders ────────────────────────────────────────────────
// Kept next to the handlers that raise the notifications so the click target
// and the announcement can never drift apart.

/** Board deep link consumed by Board.tsx's `?ticket=` effect. */
function ticketTarget(
  wsId: string | null,
  boardId: string | undefined,
  ticketId: string,
): string | undefined {
  if (!wsId) return undefined;
  const t = encodeURIComponent(ticketId);
  // Without a board the boards index resolves the ticket's board and forwards.
  return boardId
    ? `/ws/${wsId}/boards/${encodeURIComponent(boardId)}?ticket=${t}`
    : `/ws/${wsId}/boards?ticket=${t}`;
}

/** Mention deep link — comment mentions land on the board, chat on the room. */
function mentionTarget(raw: any, wsId: string | null): string | undefined {
  if (!wsId) return undefined;
  if (raw?.source_type === 'chat_message' && raw?.room_id) {
    const room = encodeURIComponent(raw.room_id);
    const msg = raw.source_id ? `?message=${encodeURIComponent(raw.source_id)}` : '';
    return `/ws/${wsId}/chat/${room}${msg}`;
  }
  if (raw?.source_type === 'comment' && raw?.ticket_id) {
    const base = ticketTarget(wsId, raw.board_id || undefined, raw.ticket_id);
    if (!base) return undefined;
    return raw.source_id ? `${base}&comment=${encodeURIComponent(raw.source_id)}` : base;
  }
  return undefined;
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
