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

  // Keep refs in sync with state for use in SSE callbacks
  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);
  useEffect(() => {
    isObserverRef.current = isObserver;
  }, [isObserver]);

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
      .catch(() => {
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
    api.getChatRoomMessages(activeRoomId, 50, undefined, initialObserver)
      .then((msgs) => setMessages(msgs))
      .catch(() => setMessages([]))
      .finally(() => setLoadingMessages(false));

    // Fetch room detail to populate participants for @mention pill rendering
    api.getChatRoom(activeRoomId, initialObserver)
      .then((detail: any) => {
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

    if (msg.room_id === currentActiveRoomId) {
      setMessages((prev) => {
        // Deduplicate: skip if this message was already appended optimistically
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      // Skip read-receipts when watching as a non-member observer.
      if (!isObserverRef.current) {
        api.markChatRoomRead(msg.room_id).catch(() => {});
        markBadgeRead('chat', msg.room_id);
      }
    } else {
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
        const roomDisplayName = room
          ? (room.type === 'dm' ? (room.dm_partner_name || room.name || 'Direct Message') : (room.name || 'Chat'))
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
      // Refresh room list
      api.listChatRooms().then(setRooms).catch(() => {});
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
  }, [user?.id]));

  function selectRoom(roomId: string) {
    setActiveRoomId(roomId);
    if (isMobile) setMobileView('room');
  }

  function handleNavigateToMessage(roomId: string, messageId: string) {
    selectRoom(roomId);
    setScrollToMessageId(messageId);
  }

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

  function handleParticipantsAdded(_roomId: string) {
    // Refresh rooms to pick up new participant info
    api.listChatRooms().then(setRooms).catch(() => {});
  }

  function handleNewChatCreated(room: ChatRoomDetail | null) {
    setShowNewChat(false);
    if (!room || !room.id) {
      // Add-people mode — just refresh
      api.listChatRooms().then(setRooms).catch(() => {});
      return;
    }
    // Immediately add the room to the list and select it (avoids race condition)
    const listItem: ChatRoomListItem = {
      id: room.id,
      type: room.type,
      name: room.name,
      last_message_at: null,
      created_at: room.created_at,
      unread_count: 0,
      last_message_preview: null,
      last_message_sender: null,
      dm_partner_name: null,
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
          />
        ) : (
          <ChatRoomView
            room={activeRoom}
            messages={messages}
            loadingMessages={loadingMessages}
            onMessageSent={handleMessageSent}
            onLeaveRoom={handleLeaveRoom}
            onRoomRenamed={handleRoomRenamed}
            onParticipantsAdded={handleParticipantsAdded}
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
          />
        </Panel>
        <Separator style={{ background: COLORS.border, width: 1, cursor: 'col-resize' }} />
        <Panel defaultSize="70" minSize="40">
          <ChatRoomView
            room={activeRoom}
            messages={messages}
            loadingMessages={loadingMessages}
            onMessageSent={handleMessageSent}
            onLeaveRoom={handleLeaveRoom}
            onRoomRenamed={handleRoomRenamed}
            onParticipantsAdded={handleParticipantsAdded}
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
