import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useNotifications } from '../../contexts/NotificationContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { tokens } from '../../tokens';
import type { ChatRoomListItem, ChatRoomDetail, ChatRoomMessageItem, DashboardAgent } from '../../types';
import { useOpenTicketArtifact } from '../../contexts/ticketArtifactOpener';
import { type MentionParticipant } from './utils/markdown';
import {
  projectParticipants,
  countUserParticipants,
  makeRefreshActiveRoomParticipants,
  reflectParticipantChange,
  dispatchChatRoomUpdate,
} from './utils/participantFlow';
import NewChatModal from './ParticipantPicker';
import ChatRoomView from './RoomDetailPanel';
import { getDmAgentPartnerId, normalizeAgentTasks } from './utils/agentTasks';
import { isSessionStatusLive, pruneExpiredSessionStatus, restoreSessionStatusSnapshot, mergeSessionStatusSnapshot } from './utils/sessionStatusFlow';

/**
 * ChatPage — Phase 7 room-based chat surface.
 *
 * Complete replacement of v1.0 agent-thread ChatPage. Implements CHAT-04
 * through CHAT-10 and CHAT-13/16: room list with unread badges, participant
 * picker modal (DM / group), markdown rendering, SSE real-time updates,
 * read receipts, and room management actions (rename/leave/add participants).
 *
 * The persistent application Sidebar owns room discovery and navigation.
 * This page only renders the selected room so the room list is not duplicated
 * in the main content area.
 */

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
      <span style={{ fontSize: tokens.typography.fontSizeLg, fontWeight: 600, color: tokens.colors.danger }}>
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
          fontSize: tokens.typography.fontSizeMd,
          cursor: 'pointer',
        }}
      >
        새로고침
      </button>
    </div>
  );
}

export default function ChatPage() {
  const { wsId, roomId: routeRoomId } = useParams<{ wsId: string; roomId?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  // Announcements (toast / sound / OS notification) belong to
  // NotificationContext so they behave the same on every route.
  // Keep sidebar chat badge in lockstep: whenever we POST mark-read we
  // also tell the NotificationContext so the badge clears without
  // waiting for the 60 s refresh. Room-scoped (per-room unread zeros).
  const { markRead: markBadgeRead } = useNotifications();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const openTicketArtifact = useOpenTicketArtifact();

  const [rooms, setRooms] = useState<ChatRoomListItem[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatRoomMessageItem[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  // Older-message pagination: true while a `before=<id>` fetch is in flight.
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  // Set to false once a fetch returns fewer than MESSAGE_PAGE_SIZE rows so
  // the scroll listener stops asking for more.
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [participantCount, setParticipantCount] = useState(0);
  const [roomParticipants, setRoomParticipants] = useState<MentionParticipant[]>([]);
  const [chatProtocolVersion, setChatProtocolVersion] = useState<number | null>(null);
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);
  const [typingAgents, setTypingAgents] = useState<Record<string, { name: string; status?: string }>>({}); // agent_id -> { name, status }
  // ticket e18be8ff — agent_id -> live keep-alive/background-task snapshot for
  // the active room's session(s). keepAliveUntilMs is an absolute deadline so
  // the badge can tick a live countdown between SSE pushes.
  const [sessionStatusByAgent, setSessionStatusByAgent] = useState<Record<string, { name: string; keepAliveUntilMs: number | null; backgroundTaskCount: number }>>({});
  // Observer mode: viewer is *not* a participant of the active room (only
  // possible when showAllRooms is on). Used to skip mark-read calls that
  // would 403 server-side for non-members.
  const [isObserver, setIsObserver] = useState<boolean>(false);
  const [dashboardAgents, setDashboardAgents] = useState<DashboardAgent[]>([]);
  const activeRoomIdRef = useRef<string | null>(null);
  const isObserverRef = useRef<boolean>(false);
  // Review round 2, P1 #2 — per-agent "sequence number the SSE handler last
  // set sessionStatusByAgent for this agent". Lets the room-entry GET
  // snapshot below tell whether a newer SSE push already landed while the GET
  // was in flight, so it can keep that newer state instead of stomping it
  // back to the (by then stale) snapshot row. See mergeSessionStatusSnapshot.
  const sessionStatusUpdatedAtRef = useRef<Record<string, number>>({});
  // Review round 2 follow-up, P1 #2 — a shared monotonic counter backing the
  // comparison above. Date.now() was tried first, but a GET-issued and an
  // SSE-handled event landing in the same millisecond produced equal
  // timestamps, which the merge treated as "not newer" and let the snapshot
  // wrongly stomp a same-tick SSE update. Every read of this ref via
  // `nextSessionStatusSeq()` hands out a distinct, strictly-increasing
  // integer, so two events can never tie regardless of wall-clock resolution.
  const sessionStatusSeqRef = useRef<number>(0);
  const nextSessionStatusSeq = useCallback(() => (sessionStatusSeqRef.current += 1), []);
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
  // 실제 로직(P2 stale-response 가드 포함)은 participantFlow.makeRefreshActiveRoomParticipants
  // 에 있고 회귀 테스트(apps/client/test/chat-participants.test.mjs)가 그 코드를 직접 구동한다.
  // 여기선 ChatPage 의 ref/상태 세터만 주입한다 — activeRoomId·observer 는 ref 로 읽어
  // 응답 시점 최신값을 본다.
  const refreshActiveRoomParticipants = useMemo(
    () =>
      makeRefreshActiveRoomParticipants({
        getChatRoom: (roomId, observer) => api.getChatRoom(roomId, observer),
        getActiveRoomId: () => activeRoomIdRef.current,
        isObserver: () => isObserverRef.current,
        setRoomParticipants,
        setParticipantCount,
      }),
    [],
  );

  // Workspace-wide observer toggle (v0.32+) — when on, the room list
  // includes every active room in the workspace, including agent-to-agent
  // DMs the current user isn't a participant in. Off by default; persisted
  // to localStorage so the choice survives reloads.
  const [showAllRooms] = useState<boolean>(() => {
    try { return localStorage.getItem('chat:showAllRooms') === 'true'; } catch { return false; }
  });

  // Workspace 전환 시 이전 workspace 의 활성 방을 들고 있지 않도록 초기화한다.
  // activeRoomId 가 null 이 되면 아래 "Load messages on room change" effect 가
  // messages/roomParticipants/isObserver 도 함께 정리한다 (티켓 28258c75).
  useEffect(() => {
    setActiveRoomId(null);
  }, [wsId]);

  // Load rooms on mount + when scope toggles + when workspace changes.
  // Pass wsId explicitly (instead of relying on the ambient X-Workspace-Id
  // header) — this effect fires the instant the URL's wsId changes, which can
  // beat the sibling AppLayout effect that syncs the ambient header to the new
  // workspace, so relying on it here could re-fetch under the old workspace.
  useEffect(() => {
    api.listChatRooms(showAllRooms ? 'workspace' : undefined, wsId)
      .then((list) => {
        setRooms(list);
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
      });
  }, [showAllRooms, wsId]);

  // Keep the persistent shell's compact room list in sync without creating a
  // second real-time stream subscription in the Sidebar. AppLayout also loads
  // an initial snapshot, so this event is an immediate local-state refinement
  // while ChatPage is mounted.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('chat-rooms-changed', {
      detail: { workspaceId: wsId, rooms },
    }));
  }, [rooms, wsId]);

  // Canonical room links use /chat/:roomId so the persistent Sidebar can
  // identify the active room. The old ?room=<id> form remains supported for
  // mention links and is immediately normalized to the canonical route.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const newChatParam = searchParams.get('new');
    const roomParam = searchParams.get('room');
    const messageParam = searchParams.get('message');
    if (newChatParam === '1' && wsId) {
      setShowNewChat(true);
      navigate(`/ws/${wsId}/chat`, { replace: true });
      return;
    }
    if (roomParam && wsId) {
      const messageQuery = messageParam ? `?message=${encodeURIComponent(messageParam)}` : '';
      navigate(`/ws/${wsId}/chat/${roomParam}${messageQuery}`, { replace: true });
      return;
    }
    const targetRoomId = routeRoomId || null;
    setActiveRoomId(targetRoomId);
    if (!targetRoomId) return;
    if (messageParam) setScrollToMessageId(messageParam);
  }, [routeRoomId, searchParams, navigate, wsId]);

  // Load messages + mark read on room change
  useEffect(() => {
    setTypingAgents({}); // clear stale typing indicators when switching rooms
    setSessionStatusByAgent({}); // clear stale keep-alive/background-task badges when switching rooms
    sessionStatusUpdatedAtRef.current = {};
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
          const mentionPs = projectParticipants(detail);
          setRoomParticipants(mentionPs);
          setParticipantCount(countUserParticipants(mentionPs));
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

    // Restore currently-active keep-alive/background-task badges on room
    // entry — the SSE push that would otherwise populate this is
    // fire-and-forget, so opening/re-entering the room between pushes would
    // otherwise show nothing until the next progress recheck (ticket
    // e18be8ff review round 1, P1 #2). requestStartedSeq + the merge below
    // guard against a newer SSE push landing before this resolves (review
    // round 2, P1 #2) — a plain replace would stomp it back to this stale
    // snapshot. observer=true matches the getChatRoom/getChatRoomMessages
    // calls above so a non-participant workspace-wide viewer isn't 404'd by
    // the server's new room-access check (review round 2, P1 #1).
    //
    // requestStartedSeq captures the shared monotonic counter's CURRENT value
    // (no increment) as a marker: any SSE handler run afterward calls
    // nextSessionStatusSeq(), which always produces something strictly
    // greater than whatever was current at this point — unlike Date.now(),
    // which can tie with the SSE handler's own Date.now() in the same
    // millisecond (review round 2 follow-up, P1 #2).
    const requestStartedSeq = sessionStatusSeqRef.current;
    api.getChatRoomSessionStatus(activeRoomId, initialObserver)
      .then((entries) => {
        if (cancelled) return;
        setSessionStatusByAgent((prev) =>
          mergeSessionStatusSnapshot(prev, entries, sessionStatusUpdatedAtRef.current, requestStartedSeq),
        );
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

  // The document title (unread counter) is owned by NotificationContext, which
  // derives it from the live badge totals for every route. This page used to
  // snapshot the title at mount and restore that snapshot on focus, which
  // fought the counter — the snapshot could itself be a stale "(1) AWB".

  // Scroll to a specific message after room loads
  useEffect(() => {
    if (!scrollToMessageId || loadingMessages) return;
    const el = document.querySelector(`[data-message-id="${scrollToMessageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Briefly highlight the message
      const htmlEl = el as HTMLElement;
      htmlEl.style.transition = 'background 0s';
      htmlEl.style.background = tokens.overlays.accentStrong;
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
      // Announcing the message (toast / OS notification / sound / tab title)
      // is NOT done here any more — NotificationContext subscribes to the
      // same event and does it for every route. Doing it here as well meant
      // the exact same message was announced twice while the chat page was
      // open and not at all from anywhere else, and the tab title was pinned
      // to a hard-coded "(1) AWB" that nothing ever cleared.
    }

    // Re-sort: move room to top
    setRooms((prev) => {
      const idx = prev.findIndex((r) => r.id === msg.room_id);
      if (idx <= 0) return prev;
      const updated = [...prev];
      const [room] = updated.splice(idx, 1);
      return [room, ...updated];
    });
  }, []));

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

  // SSE: chat_room_session_status — keep-alive / live background-task-count
  // badge. Pushed on keep-alive grant/release and on every progress recheck
  // (idle timer / maxTurns / unhealthy gate) — NOT on a fixed clock, so an
  // entry with no live grant and no background tasks means "nothing to show"
  // and is removed rather than rendered as "0".
  useBoardStreamEvent('chat_room_session_status', useCallback((data: any) => {
    if (!data || !data.room_id) return;
    if (data.room_id !== activeRoomIdRef.current) return;
    // Recorded before the state update so a room-entry GET snapshot that was
    // already in flight knows this agent's `prev` is newer than whatever the
    // snapshot read (review round 2, P1 #2 — see mergeSessionStatusSnapshot).
    // Uses the shared monotonic counter, not Date.now() — see
    // requestStartedSeq above for why (review round 2 follow-up, P1 #2).
    sessionStatusUpdatedAtRef.current[data.agent_id] = nextSessionStatusSeq();
    setSessionStatusByAgent((prev) => {
      const keepAliveUntilMs = typeof data.keep_alive_until_ms === 'number' ? data.keep_alive_until_ms : null;
      const backgroundTaskCount = data.background_task_count || 0;
      const entry = { name: data.agent_name || 'Agent', keepAliveUntilMs, backgroundTaskCount };
      if (!isSessionStatusLive(entry, Date.now())) {
        if (!prev[data.agent_id]) return prev;
        const next = { ...prev };
        delete next[data.agent_id];
        return next;
      }
      return { ...prev, [data.agent_id]: entry };
    });
  }, []));

  // The keep-alive countdown is computed from an absolute deadline at render
  // time, so a badge showing "잔여 XX분" needs periodic re-renders between SSE
  // pushes (pushes only fire when the deadline itself changes) — hence the
  // tick counter. Each tick also prunes any entry whose deadline has already
  // passed and that has no live background tasks: a lost/late exit or
  // follow-up SSE push would otherwise leave a "잔여 0분" badge stuck forever
  // (ticket e18be8ff review round 1, P1 #1). Only runs while there's
  // something to show.
  const [, setStatusTick] = useState(0);
  useEffect(() => {
    if (Object.keys(sessionStatusByAgent).length === 0) return;
    const timer = setInterval(() => {
      setStatusTick((t) => t + 1);
      setSessionStatusByAgent((prev) => pruneExpiredSessionStatus(prev, Date.now()));
    }, 30000);
    return () => clearInterval(timer);
  }, [sessionStatusByAgent]);

  // Safety timeout: clear all typing indicators after 15s in case is_typing:false is lost
  useEffect(() => {
    const ids = Object.keys(typingAgents);
    if (ids.length === 0) return;
    const timer = setTimeout(() => setTypingAgents({}), 15000);
    return () => clearTimeout(timer);
  }, [typingAgents]);

  // SSE: chat_room_update — 봉투 unwrap + update_type 분기(renamed/participant_*/read)
  // 디스패치는 participantFlow.dispatchChatRoomUpdate 에 있고, 회귀 테스트
  // (apps/client/test/chat-participants.test.mjs)가 실제 이벤트 페이로드로 그 코드를
  // 직접 구동한다. 여기선 ChatPage 의 ref/세터/스코프만 주입한다.
  // participant_added/left 는 방 목록 + (열려 있으면) 활성 방 로스터를 함께 갱신 —
  // 다른 사용자의 추가/이탈까지 실시간 반영. read(본인)은 defensive 하게
  // participant_type === 'user' 로 걸러 badge 오염을 막는다(dispatch 내부).
  useBoardStreamEvent('chat_room_update', useCallback((data: any) => {
    dispatchChatRoomUpdate(
      {
        currentUserId: user?.id,
        getActiveRoomId: () => activeRoomIdRef.current,
        listChatRooms: () => api.listChatRooms(showAllRooms ? 'workspace' : undefined, wsId),
        setRooms,
        refreshActiveRoomParticipants,
      },
      data,
    );
  }, [user?.id, showAllRooms, refreshActiveRoomParticipants, wsId]));

  function selectRoom(roomId: string) {
    setActiveRoomId(roomId);
    if (wsId) navigate(`/ws/${wsId}/chat/${roomId}`);
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
      if (wsId) navigate(`/ws/${wsId}/chat`);
    }
  }

  function handleRoomRenamed(roomId: string, name: string) {
    setRooms((prev) =>
      prev.map((r) => (r.id === roomId ? { ...r, name } : r)),
    );
  }

  // 자유 참여 토글 결과 반영 (ticket 995a9519). 서버의 open_join_changed SSE 는
  // 다른 클라이언트를 갱신하고, 누른 본인은 이 경로로 즉시 갱신된다.
  function handleOpenJoinChanged(roomId: string, openJoin: boolean) {
    setRooms((prev) =>
      prev.map((r) => (r.id === roomId ? { ...r, open_join: openJoin } : r)),
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
    // 방 목록 + (열려 있으면) 활성 방 로스터를 함께 갱신 — SSE 경로와 동일 반응.
    reflectParticipantChange(
      {
        listChatRooms: () => api.listChatRooms(showAllRooms ? 'workspace' : undefined, wsId),
        setRooms,
        getActiveRoomId: () => activeRoomIdRef.current,
        refreshActiveRoomParticipants,
      },
      roomId,
    );
  }

  function handleNewChatCreated(room: ChatRoomDetail | null) {
    setShowNewChat(false);
    if (!room || !room.id) {
      // Add-people mode — just refresh
      api.listChatRooms(undefined, wsId).then(setRooms).catch(() => {});
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
    api.listChatRooms(undefined, wsId).then(setRooms).catch(() => {});
  }

  const activeRoom = useMemo(
    () => rooms.find((r) => r.id === activeRoomId) || null,
    [rooms, activeRoomId],
  );

  // URL 의 wsId 를 직접 쓴다(ambient getActiveWorkspaceId() 대신) — workspace 전환
  // 직후의 첫 렌더에서는 AppLayout 의 setActiveWorkspaceId() 이펙트가 아직 커밋 전이라
  // ambient 값이 이전 workspace 를 가리켜, 이 값에 의존하는 agent dashboard(활성
  // task 배지)와 RoomListPanel 의 채팅 검색(searchChatMessages)이 구 workspace
  // 기준으로 동작하는 race 가 있었다 (티켓 28258c75).
  const workspaceId = wsId || '';
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    api.getAgentDashboard(workspaceId).then((agents) => { if (!cancelled) setDashboardAgents(agents); }).catch(() => { if (!cancelled) setDashboardAgents([]); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  useBoardStreamEvent('agent_status', useCallback((event: any) => {
    const payload = event?.payload ?? event;
    const agentId = payload?.agent_id ?? event?.scope?.agent_id;
    if (!agentId) return;
    setDashboardAgents((agents) => agents.map((agent) => agent.id !== agentId ? agent : {
      ...agent,
      current_task: payload.current_task,
      active_tasks: payload.active_tasks !== undefined ? payload.active_tasks : agent.active_tasks,
    }));
  }, []));

  const dmAgentId = getDmAgentPartnerId({ roomType: activeRoom?.type, participants: roomParticipants, currentUserId: user?.id, isObserver });
  const activeAgentTasks = normalizeAgentTasks(dashboardAgents.find((agent) => agent.id === dmAgentId));
  const showUpgradeBanner = chatProtocolVersion !== null && chatProtocolVersion < 2;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {showUpgradeBanner && <ProtocolUpgradeBanner />}
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
        onOpenJoinChanged={handleOpenJoinChanged}
        onParticipantsAdded={handleParticipantsAdded}
        onRoomCleared={handleRoomCleared}
        isMobile={isMobile}
        participantCount={participantCount}
        participants={roomParticipants}
        typingAgents={typingAgents}
        sessionStatusByAgent={sessionStatusByAgent}
        currentUserId={user?.id}
        activeTasks={activeAgentTasks}
        onSelectTask={openTicketArtifact}
      />

      <NewChatModal
        open={showNewChat}
        onClose={() => setShowNewChat(false)}
        onCreated={handleNewChatCreated}
      />
    </div>
  );
}
