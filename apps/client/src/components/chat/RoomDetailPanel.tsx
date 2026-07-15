import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import type { ChatRoomListItem, ChatRoomMessageItem } from '../../types';
import MessageList from './MessageList';
import NewChatModal from './ParticipantPicker';
import { useConfirm } from '../../contexts/ConfirmContext';
import { type MentionParticipant } from './utils/markdown';
import ChatMessageInput from './ChatMessageInput';

// ─── Style constants (mirror ChatPage.tsx COLORS) ────────────────────────────

const COLORS = {
  dominant: tokens.colors.surface,
  secondary: tokens.colors.surfaceCard,
  accent: tokens.colors.accent,
  border: tokens.colors.border,
  textPrimary: tokens.colors.textPrimary,
  textSecondary: tokens.colors.textSecondary,
  textMuted: tokens.colors.borderStrong,
  destructive: tokens.colors.danger,
};


// ─── RoomHeaderActions ────────────────────────────────────────────────────────

interface RoomHeaderActionsProps {
  room: ChatRoomListItem;
  isRenaming: boolean;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onRenameConfirm: (name: string) => void;
  onLeave: () => void;
  onClear: () => void;
  onAddPeople: () => void;
}

function RoomHeaderActions({
  room,
  isRenaming,
  onRenameStart,
  onRenameCancel,
  onRenameConfirm,
  onLeave,
  onClear,
  onAddPeople,
}: RoomHeaderActionsProps) {
  const [renameValue, setRenameValue] = useState(room.name || '');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(room.name || '');
      setTimeout(() => renameInputRef.current?.focus(), 30);
    }
  }, [isRenaming, room.name]);

  function handleRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const val = renameValue.trim();
      if (val) onRenameConfirm(val);
    } else if (e.key === 'Escape') {
      onRenameCancel();
    }
  }

  const ghostButton = {
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    color: COLORS.textSecondary,
    borderRadius: tokens.radii.md,
    padding: '8px 16px',
    fontSize: 13,
    cursor: 'pointer',
  } as React.CSSProperties;

  const destructiveButton = {
    background: 'transparent',
    border: `1px solid ${COLORS.destructive}`,
    color: COLORS.destructive,
    borderRadius: tokens.radii.md,
    padding: '8px 16px',
    fontSize: 13,
    cursor: 'pointer',
  } as React.CSSProperties;

  if (isRenaming) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          ref={renameInputRef}
          type="text"
          placeholder="Room name"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: `1px solid ${COLORS.accent}`,
            color: COLORS.textPrimary,
            fontSize: 16,
            fontWeight: 600,
            outline: 'none',
            width: 200,
          }}
        />
        <button
          onClick={() => { const v = renameValue.trim(); if (v) onRenameConfirm(v); }}
          style={{ ...ghostButton, borderColor: COLORS.accent, color: COLORS.accent }}
        >
          Rename Room
        </button>
        <button onClick={onRenameCancel} style={ghostButton}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {/* Add People stays group-only — DMs are fixed at 2 participants. */}
      {room.type === 'group' && (
        <button onClick={onAddPeople} style={ghostButton}>
          Add People
        </button>
      )}
      {/* Rename is allowed for DMs too so users can tag multi-rooms with
          the same partner ("Roadmap" / "Casual" / "On-call"). */}
      <button onClick={onRenameStart} style={ghostButton}>
        Rename
      </button>
      <button
        onClick={onClear}
        aria-label="Clear conversation"
        title="Clear conversation history from your view only (other participants are unaffected)"
        style={ghostButton}
      >
        Clear
      </button>
      <button
        onClick={onLeave}
        aria-label="Leave room"
        style={destructiveButton}
      >
        Leave
      </button>
    </div>
  );
}

// ─── ChatRoomView (RoomDetailPanel) ───────────────────────────────────────────

export interface ChatRoomViewProps {
  room: ChatRoomListItem | null;
  messages: ChatRoomMessageItem[];
  loadingMessages: boolean;
  // Older-page pagination plumbed in from ChatPage. `hasMoreMessages` gates
  // the scroll-near-top trigger; `loadingOlderMessages` blocks re-entry while
  // a fetch is in flight; `onLoadOlderMessages` runs the actual fetch + prepend.
  loadingOlderMessages?: boolean;
  hasMoreMessages?: boolean;
  onLoadOlderMessages?: (beforeMessageId: string) => void | Promise<void>;
  onMessageSent: (msg: ChatRoomMessageItem) => void;
  onLeaveRoom: (roomId: string) => void;
  onRoomRenamed: (roomId: string, name: string) => void;
  onParticipantsAdded: (roomId: string) => void;
  // Per-viewer Clear (ticket 1ae77f55) — parent wipes local message state
  // for the room and zeroes its sidebar metadata.
  onRoomCleared: (roomId: string) => void;
  isMobile: boolean;
  onBack?: () => void;
  participantCount?: number;
  participants?: MentionParticipant[];
  typingAgents?: Record<string, { name: string; status?: string }>; // agent_id -> { name, status }
  currentUserId?: string;
}

// Distance from the top (in px) at which we start fetching older history.
// Small enough that we don't pre-fetch eagerly, large enough to hide the
// network round-trip behind the user's scroll inertia.
const LOAD_OLDER_THRESHOLD = 120;

// Distance from the bottom (in px) within which we consider the viewer "at the
// bottom" — i.e. reading the latest messages. Append-follow and the async
// re-pin only fire inside this band; outside it the viewer is reading history
// and we never drag them down.
const NEAR_BOTTOM_THRESHOLD = 80;

// 대화 화면 상단 참여자 로스터에서 칩으로 보여줄 최대 인원. 초과분은 "+N more" 로 접는다
// (그룹 방은 최대 50명이라 전부 칩으로 깔면 헤더가 지나치게 커진다).
const MAX_VISIBLE_PARTICIPANT_CHIPS = 8;

export default function ChatRoomView({
  room,
  messages,
  loadingMessages,
  loadingOlderMessages = false,
  hasMoreMessages = false,
  onLoadOlderMessages,
  onMessageSent,
  onLeaveRoom,
  onRoomRenamed,
  onParticipantsAdded,
  onRoomCleared,
  isMobile,
  onBack,
  participantCount = 0,
  participants = [],
  typingAgents = {} as Record<string, { name: string; status?: string }>,
  currentUserId,
}: ChatRoomViewProps) {
  const confirm = useConfirm();
  const [isRenaming, setIsRenaming] = useState(false);
  const [showAddPeople, setShowAddPeople] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // ── Scroll management (ticket abd1ce81) ─────────────────────────────────────
  // Three deliberately-separated behaviours:
  //   1. Initial room load  → pin to bottom INSTANTLY in useLayoutEffect (no
  //      animation). A smooth scrollIntoView here used to stall "in the middle":
  //      async image attachments grew the list height mid-animation, so the
  //      smooth scroll landed short of the now-taller bottom.
  //   2. Live append (send / SSE) → smooth follow, but ONLY when the viewer is
  //      already near the bottom. If they scrolled up to read history we leave
  //      their position alone (no forced yank-to-bottom).
  //   3. Async height growth (images decoding, markdown reflow) → re-pin to the
  //      bottom while near-bottom; while reading history we do nothing and let
  //      the browser's native scroll anchoring hold position (no older drift).
  const lastMessageIdRef = useRef<string | null>(null);
  const didInitialScrollRef = useRef(false);
  const isNearBottomRef = useRef(true);

  function scrollToBottom(behavior: ScrollBehavior) {
    const el = scrollRef.current;
    if (!el) return;
    if (behavior === 'smooth') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    isNearBottomRef.current = true;
  }

  // Prepend anchor + initial instant pin + tail-append, in one layout effect so
  // they all run before paint (no visible jump) with a deterministic priority.
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // (1) Older-page prepend: restore the viewer's visual offset by the height
    // delta so the list doesn't snap to the top. Highest priority; never
    // touches tail tracking or the initial-scroll latch.
    const anchor = prependAnchorRef.current;
    if (anchor) {
      const delta = el.scrollHeight - anchor.scrollHeight;
      if (delta > 0) el.scrollTop = anchor.scrollTop + delta;
      prependAnchorRef.current = null;
      return;
    }

    if (loadingMessages || messages.length === 0) return;
    const tailId = messages[messages.length - 1].id;

    // (2) First committed message set for this room → instant bottom pin.
    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true;
      lastMessageIdRef.current = tailId;
      scrollToBottom('auto');
      return;
    }

    // (3) Tail id changed = a new message at the bottom (send / SSE append).
    // Follow it only when the viewer is near the bottom; otherwise respect
    // their scroll-up and don't drag them down.
    if (tailId !== lastMessageIdRef.current) {
      lastMessageIdRef.current = tailId;
      if (isNearBottomRef.current) scrollToBottom('smooth');
    }
  }, [messages, loadingMessages]);

  // Reset all scroll-tracking whenever the room changes — otherwise a stale
  // lastMessageIdRef / latched initial-scroll from the previous room can
  // suppress the new room's initial bottom pin.
  useEffect(() => {
    lastMessageIdRef.current = null;
    prependAnchorRef.current = null;
    didInitialScrollRef.current = false;
    isNearBottomRef.current = true;
  }, [room?.id]);

  // Re-pin to the bottom as async content (image attachments decoding, markdown
  // reflow) grows the list — but ONLY while the viewer is near the bottom. This
  // is the other half of the "stops in the middle" fix: the instant pin above
  // runs before images decode, so without this the bottom would creep away as
  // they load. While reading history (not near bottom) we do nothing and let
  // native scroll anchoring hold the viewer's spot, so older-image growth above
  // the viewport doesn't drift the view.
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      // Don't fight an in-flight prepend anchor restore.
      if (prependAnchorRef.current) return;
      if (isNearBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [room?.id, loadingMessages]);

  // Scroll listener: keeps `isNearBottomRef` current (gates append-follow and
  // the ResizeObserver re-pin) and fires the older-page fetch when the viewer
  // scrolls into the top zone. We listen on the viewport ref rather than an
  // IntersectionObserver sentinel because the latter fires once on mount
  // (sentinel visible inside the empty viewport) and would spuriously kick off
  // a fetch before the user scrolls. The threshold + hasMoreMessages gate +
  // loading guard together fire only on genuine upward scroll into the load zone.
  useEffect(() => {
    const el = scrollRef.current;
    const loadOlder = onLoadOlderMessages;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      isNearBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_THRESHOLD;
      if (!loadOlder) return;
      if (!hasMoreMessages) return;
      if (loadingOlderMessages) return;
      if (messages.length === 0) return;
      if (el.scrollTop > LOAD_OLDER_THRESHOLD) return;
      const oldestId = messages[0]?.id;
      if (!oldestId) return;
      prependAnchorRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
      void loadOlder(oldestId);
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [hasMoreMessages, loadingOlderMessages, messages, onLoadOlderMessages]);

  async function handleLeave() {
    if (!room) return;
    const confirmed = await confirm({
      title: 'Leave room',
      message: "Leave this room? You'll need to be re-added to rejoin.",
      confirmLabel: 'Leave',
    });
    if (!confirmed) return;
    await api.leaveChatRoom(room.id).catch(() => {});
    onLeaveRoom(room.id);
  }

  async function handleRenameConfirm(name: string) {
    if (!room) return;
    setIsRenaming(false);
    await api.renameChatRoom(room.id, name).catch(() => {});
    onRoomRenamed(room.id, name);
  }

  async function handleClear() {
    if (!room) return;
    const confirmed = await confirm({
      title: 'Clear conversation',
      message: "Clear this conversation's history from your view? Other participants are unaffected.",
      confirmLabel: 'Clear',
    });
    if (!confirmed) return;
    try {
      await api.clearChatRoom(room.id);
      onRoomCleared(room.id);
    } catch {
      // best-effort — if the server call fails the next room load will
      // simply show the unchanged history. We don't show a toast here
      // because the action is reversible by ignoring the failure.
    }
  }

  if (!room) {
    return (
      <div
        style={{
          background: COLORS.dominant,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 8 }}>
            Select a room
          </div>
          <div style={{ fontSize: 13, color: COLORS.textSecondary }}>
            Choose a chat from the list to view messages.
          </div>
        </div>
      </div>
    );
  }

  // Custom room name wins for DMs too — multi-rooms with the same partner
  // rely on the custom name to disambiguate.
  const roomDisplayName =
    room.type === 'dm'
      ? (room.name || room.dm_partner_name || 'Direct Message')
      : (room.name || 'Unnamed Group');

  const headerActions = isRenaming ? null : (
    <RoomHeaderActions
      room={room}
      isRenaming={isRenaming}
      onRenameStart={() => setIsRenaming(true)}
      onRenameCancel={() => setIsRenaming(false)}
      onRenameConfirm={handleRenameConfirm}
      onLeave={handleLeave}
      onClear={handleClear}
      onAddPeople={() => setShowAddPeople(true)}
    />
  );

  return (
    <div
      style={{
        background: COLORS.dominant,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {isRenaming ? (
        <div
          style={{
            background: tokens.gradients.surfaceCard,
            borderBottom: `1px solid ${COLORS.border}`,
            padding: '16px 24px',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexShrink: 0,
          }}
        >
          {isMobile && onBack && (
            <button
              onClick={onBack}
              style={{ background: 'transparent', border: 'none', color: COLORS.textSecondary, cursor: 'pointer', fontSize: 18, flexShrink: 0 }}
            >
              ←
            </button>
          )}
          <RoomHeaderActions
            room={room}
            isRenaming={isRenaming}
            onRenameStart={() => setIsRenaming(true)}
            onRenameCancel={() => setIsRenaming(false)}
            onRenameConfirm={handleRenameConfirm}
            onLeave={handleLeave}
            onClear={handleClear}
            onAddPeople={() => setShowAddPeople(true)}
          />
        </div>
      ) : (
        <PageHeader
          title={roomDisplayName}
          description={undefined}
          actions={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {isMobile && onBack && (
                <button
                  onClick={onBack}
                  style={{ background: 'transparent', border: 'none', color: COLORS.textSecondary, cursor: 'pointer', fontSize: 18 }}
                  aria-label="Back to room list"
                >
                  ←
                </button>
              )}
              {headerActions}
            </div>
          }
        />
      )}

      {/* 참여자 로스터 — 현재 방의 참여자 목록을 대화 화면 상단에 표시한다 (ticket 141b7414).
          participants 는 부모(ChatPage)가 방 상세를 조회해 내려주며, 참여자 추가/이탈 시
          즉시 재조회되어 이 로스터가 곧바로 갱신된다. */}
      {participants.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 6,
            padding: '8px 16px',
            borderBottom: `1px solid ${COLORS.border}`,
            background: COLORS.secondary,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.textSecondary, marginRight: 2 }}>
            Participants · {participants.length}
          </span>
          {participants.slice(0, MAX_VISIBLE_PARTICIPANT_CHIPS).map((p) => (
            <span
              key={`${p.type}:${p.id}`}
              style={{
                fontSize: 11,
                color: COLORS.textPrimary,
                background: COLORS.dominant,
                border: `1px solid ${COLORS.border}`,
                borderRadius: tokens.radii.xl,
                padding: '2px 8px',
                whiteSpace: 'nowrap',
              }}
            >
              {p.name}
              {p.type === 'agent' && (
                <span style={{ color: COLORS.textSecondary, marginLeft: 4, fontSize: 10 }}>agent</span>
              )}
            </span>
          ))}
          {participants.length > MAX_VISIBLE_PARTICIPANT_CHIPS && (
            <span
              title={participants.map((p) => p.name).join(', ')}
              style={{ fontSize: 11, color: COLORS.textSecondary, padding: '2px 4px', whiteSpace: 'nowrap' }}
            >
              +{participants.length - MAX_VISIBLE_PARTICIPANT_CHIPS} more
            </span>
          )}
          {/* 대화 도중 참여자 추가 진입점 — 그룹 방 전용 (DM 은 서버가 추가를 거부한다).
              헤더의 "Add People" 버튼과 동일한 모달을 연다. */}
          {room.type === 'group' && (
            <button
              onClick={() => setShowAddPeople(true)}
              aria-label="Add participant"
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: COLORS.accent,
                background: 'transparent',
                border: `1px dashed ${COLORS.accent}`,
                borderRadius: tokens.radii.xl,
                padding: '2px 8px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              + Add
            </button>
          )}
        </div>
      )}

      {/* Older-message loading banner — sits OUTSIDE the scroll viewport so
          its appearance/disappearance doesn't perturb scrollHeight and break
          the prepend scroll-anchor math in useLayoutEffect above. */}
      {loadingOlderMessages && (
        <div
          aria-live="polite"
          style={{
            padding: '4px 16px',
            textAlign: 'center',
            fontSize: 11,
            color: COLORS.textMuted,
            fontStyle: 'italic',
            flexShrink: 0,
          }}
        >
          Loading older messages…
        </div>
      )}

      {/* Message scroll area */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {loadingMessages ? (
          <div style={{ padding: 24 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} style={{ marginBottom: 16 }}>
                <div style={{ width: 80, height: 12, background: COLORS.border, borderRadius: tokens.radii.sm, marginBottom: 6 }} />
                <div style={{ width: '60%', height: 14, background: COLORS.border, borderRadius: tokens.radii.sm }} />
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div style={{ fontSize: 13, color: COLORS.textSecondary }}>
              No messages yet. Send one to get started.
            </div>
          </div>
        ) : (
          // contentRef wraps only the rendered messages so the ResizeObserver
          // above can watch the list's height grow as image attachments decode.
          <div ref={contentRef}>
            <MessageList messages={messages} participantCount={participantCount} participants={participants} currentUserId={currentUserId} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Typing indicator */}
      {Object.keys(typingAgents).length > 0 && (
        <div style={{
          padding: '4px 16px',
          fontSize: '13px',
          color: COLORS.textSecondary,
          fontStyle: 'italic',
          flexShrink: 0,
        }}>
          {(() => {
            const entries = Object.values(typingAgents);
            const names = entries.map(e => e.name);
            const statuses = entries.map(e => e.status).filter(Boolean);
            // If any agent has a status message, show it
            if (statuses.length > 0) {
              return `${names.join(', ')} — ${statuses[0]}`;
            }
            return `${names.join(', ')}${entries.length === 1 ? ' is typing' : ' are typing'}`;
          })()}
          <span style={{ display: 'inline-block', width: 20 }}>...</span>
        </div>
      )}

      {/* Message input */}
      <ChatMessageInput
        roomId={room.id}
        onSent={onMessageSent}
        isMobile={isMobile}
      />

      {/* Add People modal */}
      <NewChatModal
        open={showAddPeople}
        onClose={() => setShowAddPeople(false)}
        onCreated={(_result) => {
          setShowAddPeople(false);
          onParticipantsAdded(room.id);
        }}
        addToRoomId={room.id}
        // 이미 방에 있는 참여자는 피커 후보에서 제외해 중복 선택을 막는다.
        existingParticipantIds={participants.map((p) => p.id)}
      />
    </div>
  );
}
