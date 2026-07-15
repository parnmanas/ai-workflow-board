import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useSearchParams } from 'react-router-dom';
import { api, getActiveWorkspaceId } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useToast } from '../../contexts/ToastContext';
import { useNotifications } from '../../contexts/NotificationContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { tokens } from '../../tokens';
import type { ChatRoomListItem, ChatRoomDetail, ChatRoomMessageItem } from '../../types';
import { type MentionParticipant } from './utils/markdown';
import NewChatModal from './ParticipantPicker';
import ChatRoomListPanel from './RoomListPanel';
import ChatRoomView from './RoomDetailPanel';

/**
 * ChatPage — Phase 7 room-based chat surface.
 *
 * Complete replacement of v1.0 agent-thread ChatPage. Implements CHAT-04
 * through CHAT-10 and CHAT-13/16: room list with unread badges, participant
 * picker modal (DM / group), markdown rendering, SSE real-time updates,
 * read receipts, and room management actions (rename/leave/add participants).
 *
 * Two-panel layout via react-resizable-panels. Mobile: single-panel with
 * room list default, tap-to-enter room.
 */

// ─── Style constants ─────────────────────────────────────────────────────────

const COLORS = {
  border: tokens.colors.border,
};

// Page size for both initial load and `before=<id>` history pagination.
// Server caps at 200 (chat-rooms.controller.ts) — 50 is a comfortable
// scroll window without dragging the first paint.
const MESSAGE_PAGE_SIZE = 50;

// ─── ProtocolUpgradeBanner ────────────────────────────────────────────────────

function ProtocolUpgradeBanner() {
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 100,
        height: 40,
        background: `${tokens.colors.danger}1A`,
        borderBottom: `1px solid ${tokens.colors.danger}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.danger }}>
        채팅 시스템이 업그레이드되었습니다.
      </span>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: 'transparent',
          border: `1px solid ${tokens.colors.danger}`,
          color: tokens.colors.danger,
          borderRadius: tokens.radii.md,
          padding: '4px 8px',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        새로고침
      </button>
    </div>
  );
}

export default function ChatPage() {
  const { user } = useAuth();
  const { showToast, playNotifySound } = useToast();
  // Keep sidebar chat badge in lockstep: whenever we POST mark-read we
  // also tell the NotificationContext so the badge clears without
  // waiting for the 60 s refresh. Room-scoped (per-room unread zeros).
  const { markRead: markBadgeRead } = useNotifications();
  const isMobile = useMediaQuery('(max-width: 767px)');

  const [rooms, setRooms] = useState<ChatRoomListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatRoomMessageItem[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  // Older-message pagination: true while a `before=<id>` fetch is in flight.
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  // Set to false once a fetch returns fewer than MESSAGE_PAGE_SIZE rows so
  // the scroll listener stops asking for more.
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'room'>('list');
  const [participantCount, setParticipantCount] = useState(0);
  const [roomParticipants, setRoomParticipants] = useState<MentionParticipant[]>([]);
  const [chatProtocolVersion, setChatProtocolVersion] = useState<number | null>(null);
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);
  const [typingAgents, setTypingAgents] = useState<Record<string, { name: string; status?: string }>>({}); // agent_id -> { name, status }
  // Observer mode: viewer is *not* a participant of the active room (only
  // possible when showAllRooms is on). Used to skip mark-read calls that
  // would 403 server-side for non-members.
  const [isObserver, setIsObserver] = useState<boolean>(false);
  const originalTitleRef = useRef(document.title);
  const activeRoomIdRef = useRef<string | null>(null);
  const isObserverRef = useRef<boolean>(false);
  // Mirror of `messages` for use inside async callbacks (older-page dedup) that
  // run between renders and can't rely on the closed-over state snapshot.
  const messagesRef = useRef<ChatRoomMessageItem[]>([]);

  // Keep refs in sync with state for use in SSE callbacks
  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);
  useEffect(() => {
    isObserverRef.current = isObserver;
  }, [isObserver]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // 활성 방의 참여자 로스터(roomParticipants/participantCount)를 서버 최신값으로 재조회한다.
  // 참여자 추가/이탈 직후 대화 화면 상단 로스터가 곧바로 반영되도록 호출한다 (모달 콜백 + SSE 양쪽에서 사용).
  // observer 여부는 ref 로 읽어 워크스페이스 관찰 모드의 방도 안전하게 재조회한다.
  const refreshActiveRoomParticipants = useCallback((roomId: string) => {
    api.getChatRoom(roomId, isObserverRef.current)
      .then((detail: any) => {
        // Stale-response 가드: 재조회를 시작한 방이 응답 시점에도 여전히 활성 방일 때만
        // 로스터를 반영한다. 참여자 추가/`participant_*` SSE 직후 사용자가 다른 방으로
        // 전환하고 새 방 상세가 먼저 도착하면, 늦게 도착한 이전 방 응답이 현재 방
        // 로스터/카운트를 덮어써 "현재 참여자"가 잘못 표시될 수 있어 이를 폐기한다.
        if (activeRoomIdRef.current !== roomId) return;
        if (!detail?.participants) return;
        const mentionPs: MentionParticipant[] = detail.participants.map((p: any) => ({
          id: p.participant_id,
          name: p.name,
          type: p.participant_type,
        }));
        setRoomParticipants(mentionPs);
        setParticipantCount(mentionPs.filter((p) => p.type === 'user').length);
      })
      .catch(() => {});
  }, []);

  // Workspace-wide observer toggle (v0.32+) — when on, the room list
  // includes every active room in the workspace, including agent-to-agent
  // DMs the current user isn't a participant in. Off by default; persisted
  // to localStorage so the choice survives reloads.
  const [showAllRooms, setShowAllRoomsState] = useState<boolean>(() => {
    try { return localStorage.getItem('chat:showAllRooms') === 'true'; } catch { return false; }
  });
  const setShowAllRooms = useCallback((v: boolean) => {
    setShowAllRoomsState(v);
    try { localStorage.setItem('chat:showAllRooms', String(v)); } catch { /* noop */ }
  }, []);

  // Load rooms on mount + when scope toggles
  useEffect(() => {
    setLoading(true);
    api.listChatRooms(showAllRooms ? 'workspace' : undefined)
      .then((list) => {
        setRooms(list);
        setRoomsError(null);
      })
      .catch((err: any) => {
        // Surface the real failure in the console so a future "Could not load
        // chats" (e.g. a server 500) is diagnosable at a glance instead of an
        // opaque generic toast — request() preserves HTTP status + error code
        // on the thrown error. The user-facing message is intentionally left
        // generic (we don't leak backend detail into the UI).
        console.error(
          `[chat] listChatRooms failed (scope=${showAllRooms ? 'workspace' : 'mine'}, status=${err?.status ?? '?'}, code=${err?.code ?? ''})`,
          err,
        );
        setRoomsError('Could not load chats.');
      })
      .finally(() => setLoading(false));
  }, [showAllRooms]);

  // Mention deep link: `?room=<id>&message=<id>` selects the room and queues
  // a scroll-and-highlight on the targeted message. We strip both params from
  // the URL once applied so back/forward doesn't keep re-firing the highlight.
  // The message scroll is best-effort — if the row isn't in the initial 50
  // we'd need history pagination to find it; that's acceptable for v1.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const roomParam = searchParams.get('room');
    const messageParam = searchParams.get('message');
    if (!roomParam) return;
    setActiveRoomId(roomParam);
    if (isMobile) setMobileView('room');
    if (messageParam) setScrollToMessageId(messageParam);
    const next = new URLSearchParams(searchParams);
    next.delete('room');
    next.delete('message');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, isMobile]);

  // Load messages + mark read on room change
  useEffect(() => {
    setTypingAgents({}); // clear stale typing indicators when switching rooms
    // Reset pagination state on every room switch so the new room starts
    // with a clean "no older fetched yet" slate. Without this, switching
    // from a fully-loaded room (hasMoreMessages=false) to a new room
    // would suppress the first older-page fetch.
    setHasMoreMessages(false);
    setLoadingOlderMessages(false);
    // Stale-response 세대 플래그: 이 effect 가 정리(다른 방으로 전환/언마운트)되면
    // 아래 메시지·상세 fetch 의 늦은 응답을 폐기해, 이전 방의 메시지/참여자/observer
    // 상태가 새 방 화면을 덮어쓰지 않도록 한다.
    let cancelled = false;
    if (!activeRoomId) {
      setMessages([]);
      setRoomParticipants([]);
      setIsObserver(false);
      return;
    }
    // When showAllRooms is on, assume non-member until detail confirms
    // membership — the observer flag bypasses the active-participant gate
    // server-side, so we send it on the *initial* fetch to avoid a 403.
    const initialObserver = showAllRooms;
    setIsObserver(initialObserver);
    setLoadingMessages(true);
    api.getChatRoomMessages(activeRoomId, MESSAGE_PAGE_SIZE, undefined, initialObserver)
      .then((msgs) => {
        if (cancelled) return;
        setMessages(msgs);
        // A full page back implies there *might* be more older rows.
        // Server returns in chronological order capped at MESSAGE_PAGE_SIZE,
        // so a short page means we already hit the start of history.
        setHasMoreMessages(msgs.length >= MESSAGE_PAGE_SIZE);
      })
      .catch(() => {
        if (cancelled) return;
        setMessages([]);
        setHasMoreMessages(false);
      })
      .finally(() => {
        // 이미 다른 방으로 전환했다면 loading 플래그는 새 effect 가 관리하므로 건드리지 않는다.
        if (!cancelled) setLoadingMessages(false);
      });

    // Fetch room detail to populate participants for @mention pill rendering
    api.getChatRoom(activeRoomId, initialObserver)
      .then((detail: any) => {
        if (cancelled) return;
        if (detail?.participants) {
          const mentionPs: MentionParticipant[] = detail.participants.map((p: any) => ({
            id: p.participant_id,
            name: p.name,
            type: p.participant_type,
          }));
          setRoomParticipants(mentionPs);
          setParticipantCount(mentionPs.filter((p) => p.type === 'user').length);
          const isMember = detail.participants.some(
            (p: any) => p.participant_id === user?.id && p.participant_type === 'user',
          );
          // Re-derive: only an observer if scope is workspace AND viewer
          // truly isn't a participant. Members in workspace mode get
          // normal read-receipt behaviour.
          setIsObserver(showAllRooms && !isMember);
          if (isMember) {
            api.markChatRoomRead(activeRoomId).catch(() => {});
            markBadgeRead('chat', activeRoomId);
            setRooms((prev) =>
              prev.map((r) => (r.id === activeRoomId ? { ...r, unread_count: 0 } : r)),
            );
          }
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [activeRoomId, showAllRooms, user?.id, markBadgeRead]);

  // Mark read on visibility change (tab regains focus)
  useEffect(() => {
    if (!activeRoomId || isObserver) return;
    function handleVisibility() {
      if (document.visibilityState === 'visible' && activeRoomId) {
        api.markChatRoomRead(activeRoomId).catch(() => {});
        setRooms((prev) =>
          prev.map((r) => (r.id === activeRoomId ? { ...r, unread_count: 0 } : r)),
        );
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [activeRoomId, isObserver]);

  // SSE: server_meta — protocol version handshake (CHAT-20)
  useBoardStreamEvent('server_meta', useCallback((data: any) => {
    if (data && typeof data.chat_protocol_version === 'number') {
      setChatProtocolVersion(data.chat_protocol_version);
    }
  }, []));

  // Reset document title when tab becomes visible
  useEffect(() => {
    function handleVisibilityForTitle() {
      if (document.visibilityState === 'visible') {
        document.title = originalTitleRef.current;
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityForTitle);
    return () => document.removeEventListener('visibilitychange', handleVisibilityForTitle);
  }, []);

  // Scroll to a specific message after room loads
  useEffect(() => {
    if (!scrollToMessageId || loadingMessages) return;
    const el = document.querySelector(`[data-message-id="${scrollToMessageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Briefly highlight the message
      const htmlEl = el as HTMLElement;
      htmlEl.style.transition = 'background 0s';
      htmlEl.style.background = 'rgba(99,102,241,0.20)';
      setTimeout(() => {
        htmlEl.style.transition = 'background 1.5s ease';
        htmlEl.style.background = 'transparent';
      }, 50);
      setScrollToMessageId(null);
    }
  }, [scrollToMessageId, loadingMessages, messages]);

  // SSE: chat_room_message
  useBoardStreamEvent('chat_room_message', useCallback((data: any) => {
    const msg: ChatRoomMessageItem = data;
    if (!msg || !msg.room_id) return;

    const currentActiveRoomId = activeRoomIdRef.current;

    // Auto-clear typing indicator when the agent's message arrives
    if ((msg as any).sender_type === 'agent' && (msg as any).sender_id) {
      setTypingAgents((prev) => {
        if (!((msg as any).sender_id in prev)) return prev;
        const next = { ...prev };
        delete next[(msg as any).sender_id];
        return next;
      });
    }

    // Progress rows are tool-call heartbeats — render them in the active
    // room as compact muted lines, but skip every unread/toast/sound/title
    // side effect so they don't masquerade as real chat activity.
    const isProgress = msg.type === 'progress';

    if (msg.room_id === currentActiveRoomId) {
      setMessages((prev) => {
        // Deduplicate: skip if this message was already appended optimistically
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      // Skip read-receipts when watching as a non-member observer.
      if (!isObserverRef.current && !isProgress) {
        api.markChatRoomRead(msg.room_id).catch(() => {});
        markBadgeRead('chat', msg.room_id);
      }
    } else if (!isProgress) {
      setRooms((prev) =>
        prev.map((r) =>
          r.id === msg.room_id
            ? { ...r, unread_count: (r.unread_count || 0) + 1, last_message_at: msg.created_at }
            : r,
        ),
      );

      // Toast notification for non-active room (CHAT-14)
      setRooms((prevRooms) => {
        const room = prevRooms.find((r) => r.id === msg.room_id);
        // Custom room name wins for DMs (see ticket 1ae77f55 — DM rename).
        const roomDisplayName = room
          ? (room.type === 'dm'
              ? (room.name || room.dm_partner_name || 'Direct Message')
              : (room.name || 'Chat'))
          : 'Chat';
        const senderName = (msg as any).sender_name || 'Someone';
        const preview = msg.content.length > 60 ? msg.content.slice(0, 57) + '...' : msg.content;
        showToast(`${roomDisplayName}: ${senderName}: ${preview}`, 'info');

        // Background tab title notification
        if (document.hidden) {
          document.title = '(1) AWB';
        }

        // Play sound via ToastContext (handles autoplay unlock + mute state)
        playNotifySound();

        return prevRooms; // no state change, just side effects
      });
    }

    // Re-sort: move room to top
    setRooms((prev) => {
      const idx = prev.findIndex((r) => r.id === msg.room_id);
      if (idx <= 0) return prev;
      const updated = [...prev];
      const [room] = updated.splice(idx, 1);
      return [room, ...updated];
    });
  }, [showToast, playNotifySound]));

  // SSE: chat_room_typing — agent typing indicator with optional status
  useBoardStreamEvent('chat_room_typing', useCallback((data: any) => {
    if (!data || !data.room_id) return;
    if (data.room_id !== activeRoomIdRef.current) return;
    setTypingAgents((prev) => {
      if (data.is_typing) {
        return { ...prev, [data.agent_id]: { name: data.agent_name || 'Agent', status: data.status || undefined } };
      }
      const next = { ...prev };
      delete next[data.agent_id];
      return next;
    });
  }, []));

  // Safety timeout: clear all typing indicators after 15s in case is_typing:false is lost
  useEffect(() => {
    const ids = Object.keys(typingAgents);
    if (ids.length === 0) return;
    const timer = setTimeout(() => setTypingAgents({}), 15000);
    return () => clearTimeout(timer);
  }, [typingAgents]);

  // SSE: chat_room_update
  useBoardStreamEvent('chat_room_update', useCallback((data: any) => {
    if (!data) return;
    // Server emits envelope: { event_type, payload, scope, timestamp }; handle both shapes
    const payload = data.payload ?? data;
    if (payload.update_type === 'renamed' && payload.room_id && payload.new_name) {
      setRooms((prev) =>
        prev.map((r) => (r.id === payload.room_id ? { ...r, name: payload.new_name } : r)),
      );
    } else if (
      payload.update_type === 'participant_added' ||
      payload.update_type === 'participant_left'
    ) {
      // 방 목록(참여자 프로젝션)을 현재 스코프 그대로 갱신한다.
      api.listChatRooms(showAllRooms ? 'workspace' : undefined).then(setRooms).catch(() => {});
      // 열려 있는 방의 참여자가 바뀌면 상단 로스터도 즉시 재조회 — 다른 사용자의 추가/이탈까지 실시간 반영.
      if (payload.room_id && payload.room_id === activeRoomIdRef.current) {
        refreshActiveRoomParticipants(payload.room_id);
      }
    } else if (
      payload.update_type === 'read' &&
      payload.room_id &&
      payload.participant_type === 'user' &&
      payload.participant_id === user?.id
    ) {
      // B3: same user read in another tab/device → sync local unread to 0.
      // Filter by participant_type === 'user' so an agent in the same room
      // that happens to share a UUID with our user_id (won't in practice, but
      // defensive) doesn't clobber our badge.
      setRooms((prev) =>
        prev.map((r) => (r.id === payload.room_id ? { ...r, unread_count: 0 } : r)),
      );
    }
  }, [user?.id, showAllRooms, refreshActiveRoomParticipants]));

  function selectRoom(roomId: string) {
    setActiveRoomId(roomId);
    if (isMobile) setMobileView('room');
  }

  function handleNavigateToMessage(roomId: string, messageId: string) {
    selectRoom(roomId);
    setScrollToMessageId(messageId);
  }

  // Older-message loader: fetches a page of history strictly older than
  // `beforeMessageId` and prepends it to the in-memory buffer. Uses a ref
  // guard *and* a state flag — the ref blocks the re-entrant case where the
  // scroll listener fires again before React commits the state update.
  const loadingOlderRef = useRef(false);
  const handleLoadOlderMessages = useCallback(async (beforeMessageId: string) => {
    if (!activeRoomId) return;
    if (loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlderMessages(true);
    try {
      const older = await api.getChatRoomMessages(
        activeRoomId,
        MESSAGE_PAGE_SIZE,
        beforeMessageId,
        isObserverRef.current,
      );
      if (older.length === 0) {
        setHasMoreMessages(false);
        return;
      }
      // Dedup against what's already buffered (an SSE message could have
      // arrived in between). Capture how many rows were genuinely new so we can
      // close pagination correctly afterwards — `setMessages` runs async/in a
      // batch, so we compute `fresh` here against a ref snapshot rather than
      // reading the post-update state.
      const existing = new Set(messagesRef.current.map((m) => m.id));
      const fresh = older.filter((m) => !existing.has(m.id));
      if (fresh.length > 0) {
        setMessages((prev) => {
          // Re-dedup inside the updater against the authoritative prev — a
          // concurrent SSE append between the snapshot and commit is rare but
          // possible, and a double-insert would create duplicate React keys.
          const prevIds = new Set(prev.map((m) => m.id));
          const stillFresh = fresh.filter((m) => !prevIds.has(m.id));
          if (stillFresh.length === 0) return prev;
          return [...stillFresh, ...prev];
        });
      }
      // Close pagination when the page was short (true start of history) OR
      // yielded no new rows (we've caught up to already-buffered content) —
      // the latter prevents the same cursor from being re-requested forever
      // at the boundary (acceptance criterion d).
      setHasMoreMessages(fresh.length > 0 && older.length >= MESSAGE_PAGE_SIZE);
    } catch {
      // Silent failure — the user can scroll up again to retry.
    } finally {
      setLoadingOlderMessages(false);
      loadingOlderRef.current = false;
    }
  }, [activeRoomId]);

  function handleMessageSent(msg: ChatRoomMessageItem) {
    // Dedup against the SSE `chat_room_message` broadcast: when the
    // server's SSE fan-out beats the POST response back to us, the
    // SSE handler will already have appended the same row. Without
    // this guard the user sees their own message twice until refresh
    // (see ticket 3203bbaf — Chat Echo back 버그).
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }

  function handleLeaveRoom(roomId: string) {
    setRooms((prev) => prev.filter((r) => r.id !== roomId));
    if (activeRoomId === roomId) {
      setActiveRoomId(null);
      setMessages([]);
      if (isMobile) setMobileView('list');
    }
  }

  function handleRoomRenamed(roomId: string, name: string) {
    setRooms((prev) =>
      prev.map((r) => (r.id === roomId ? { ...r, name } : r)),
    );
  }

  function handleRoomCleared(roomId: string) {
    // Per-viewer Clear (ticket 1ae77f55) — drop the local message buffer and
    // zero this room's sidebar metadata so the active-room view + room list
    // line up with what the next listRooms/getMessages would return.
    if (roomId === activeRoomIdRef.current) {
      setMessages([]);
    }
    setRooms((prev) =>
      prev.map((r) =>
        r.id === roomId
          ? { ...r, unread_count: 0, last_message_preview: null }
          : r,
      ),
    );
    markBadgeRead('chat', roomId);
  }

  function handleParticipantsAdded(roomId: string) {
    // 방 목록의 참여자 프로젝션을 현재 스코프 그대로 갱신한다.
    api.listChatRooms(showAllRooms ? 'workspace' : undefined).then(setRooms).catch(() => {});
    // 추가가 일어난 방이 지금 열려 있으면 상단 참여자 로스터를 즉시 재조회해 반영한다 (완료 조건: 즉시 반영).
    if (roomId === activeRoomIdRef.current) {
      refreshActiveRoomParticipants(roomId);
    }
  }

  function handleNewChatCreated(room: ChatRoomDetail | null) {
    setShowNewChat(false);
    if (!room || !room.id) {
      // Add-people mode — just refresh
      api.listChatRooms().then(setRooms).catch(() => {});
      return;
    }
    // Immediately add the room to the list and select it (avoids race condition).
    // dm_partner_name comes from the create response so a brand-new DM shows
    // the partner's name as the fallback label even before the background
    // listChatRooms refresh completes.
    const listItem: ChatRoomListItem = {
      id: room.id,
      type: room.type,
      name: room.name,
      last_message_at: room.last_message_at ?? null,
      created_at: room.created_at,
      unread_count: 0,
      last_message_preview: null,
      last_message_sender: null,
      dm_partner_name: room.dm_partner_name ?? null,
      dm_partner_type: null,
    };
    setRooms((prev) => {
      const exists = prev.some((r) => r.id === room.id);
      if (exists) return prev;
      return [listItem, ...prev];
    });
    selectRoom(room.id);
    // Refresh in background to get full data (unread_count, etc.)
    api.listChatRooms().then(setRooms).catch(() => {});
  }

  const activeRoom = useMemo(
    () => rooms.find((r) => r.id === activeRoomId) || null,
    [rooms, activeRoomId],
  );

  const workspaceId = getActiveWorkspaceId() || '';
  const showUpgradeBanner = chatProtocolVersion !== null && chatProtocolVersion < 2;

  // Mobile layout: single panel
  if (isMobile) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {showUpgradeBanner && <ProtocolUpgradeBanner />}
        {mobileView === 'list' ? (
          <ChatRoomListPanel
            rooms={rooms}
            loading={loading}
            error={roomsError}
            activeRoomId={activeRoomId}
            onSelectRoom={selectRoom}
            onNewChat={() => setShowNewChat(true)}
            workspaceId={workspaceId}
            onNavigateToMessage={handleNavigateToMessage}
            showAllRooms={showAllRooms}
            onToggleShowAllRooms={setShowAllRooms}
            currentUserId={user?.id}
          />
        ) : (
          <ChatRoomView
            room={activeRoom}
            messages={messages}
            loadingMessages={loadingMessages}
            loadingOlderMessages={loadingOlderMessages}
            hasMoreMessages={hasMoreMessages}
            onLoadOlderMessages={handleLoadOlderMessages}
            onMessageSent={handleMessageSent}
            onLeaveRoom={handleLeaveRoom}
            onRoomRenamed={handleRoomRenamed}
            onParticipantsAdded={handleParticipantsAdded}
            onRoomCleared={handleRoomCleared}
            isMobile={true}
            onBack={() => {
              setMobileView('list');
              setActiveRoomId(null);
            }}
            participantCount={participantCount}
            participants={roomParticipants}
            typingAgents={typingAgents}
            currentUserId={user?.id}
          />
        )}
        <NewChatModal
          open={showNewChat}
          onClose={() => setShowNewChat(false)}
          onCreated={handleNewChatCreated}
        />
      </div>
    );
  }

  // Desktop layout: two-panel
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {showUpgradeBanner && <ProtocolUpgradeBanner />}
      <Group orientation="horizontal" style={{ height: '100%', flex: 1, overflow: 'hidden' }}>
        <Panel defaultSize="30" minSize="20">
          <ChatRoomListPanel
            rooms={rooms}
            loading={loading}
            error={roomsError}
            activeRoomId={activeRoomId}
            onSelectRoom={selectRoom}
            onNewChat={() => setShowNewChat(true)}
            workspaceId={workspaceId}
            onNavigateToMessage={handleNavigateToMessage}
            showAllRooms={showAllRooms}
            onToggleShowAllRooms={setShowAllRooms}
            currentUserId={user?.id}
          />
        </Panel>
        <Separator style={{ background: COLORS.border, width: 1, cursor: 'col-resize' }} />
        <Panel defaultSize="70" minSize="40">
          <ChatRoomView
            room={activeRoom}
            messages={messages}
            loadingMessages={loadingMessages}
            loadingOlderMessages={loadingOlderMessages}
            hasMoreMessages={hasMoreMessages}
            onLoadOlderMessages={handleLoadOlderMessages}
            onMessageSent={handleMessageSent}
            onLeaveRoom={handleLeaveRoom}
            onRoomRenamed={handleRoomRenamed}
            onParticipantsAdded={handleParticipantsAdded}
            onRoomCleared={handleRoomCleared}
            isMobile={false}
            participantCount={participantCount}
            participants={roomParticipants}
            typingAgents={typingAgents}
            currentUserId={user?.id}
          />
        </Panel>
      </Group>

      <NewChatModal
        open={showNewChat}
        onClose={() => setShowNewChat(false)}
        onCreated={handleNewChatCreated}
      />
    </div>
  );
}
