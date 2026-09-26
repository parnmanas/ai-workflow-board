import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { useConversationScroll } from '../../hooks/useConversationScroll';
import { ActivityPill } from '../common/ActivityIndicator';
import { roomActivity } from '../../activity';
import type { AgentCurrentTask, ChatRoomListItem, ChatRoomMessageItem } from '../../types';
import MessageList from './MessageList';
import { useMentionViewportReader } from '../../hooks/useMentionViewportReader';
import { useNotifications } from '../../contexts/NotificationContext';
import NewChatModal from './ParticipantPicker';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useToast } from '../../contexts/ToastContext';
import { type MentionParticipant } from './utils/markdown';
import ChatMessageInput from './ChatMessageInput';
import { canInviteToRoom } from './utils/participantFlow';
import ActiveTaskStrip from './ActiveTaskStrip';


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
  /** 자유 참여(open join) 토글 — ticket 995a9519. */
  onToggleOpenJoin: () => void;
  /** 토글 요청이 진행 중인가. 중복 클릭을 막고 진행 상태를 보여준다. */
  openJoinPending: boolean;
}

/**
 * 방 헤더의 동작 버튼 묶음. context 를 전혀 쓰지 않는 순수 표현 컴포넌트라 provider
 * 없이 마운트할 수 있어, 버튼 노출 조건을 실제 렌더로 검증하려고 export 한다
 * (`apps/client/test/chat-invite-participants.test.mjs`). `{cond && <button/>}` 이
 * 조용히 접히는 결함은 소스 문자열 검사로는 잡히지 않는다.
 */
export function RoomHeaderActions({
  room,
  isRenaming,
  onRenameStart,
  onRenameCancel,
  onRenameConfirm,
  onLeave,
  onClear,
  onAddPeople,
  onToggleOpenJoin,
  openJoinPending,
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
    border: `1px solid ${tokens.colors.border}`,
    color: tokens.colors.textSecondary,
    borderRadius: tokens.radii.md,
    padding: '8px 16px',
    fontSize: tokens.typography.fontSizeMd,
    cursor: 'pointer',
  } as React.CSSProperties;

  const destructiveButton = {
    background: 'transparent',
    border: `1px solid ${tokens.colors.danger}`,
    color: tokens.colors.danger,
    borderRadius: tokens.radii.md,
    padding: '8px 16px',
    fontSize: tokens.typography.fontSizeMd,
    cursor: 'pointer',
  } as React.CSSProperties;

  if (isRenaming) {
    return (
      <div style={{ display: 'flex', gap: tokens.spacing.sm, alignItems: 'center' }}>
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
            borderBottom: `1px solid ${tokens.colors.accent}`,
            color: tokens.colors.textPrimary,
            fontSize: tokens.typography.fontSizeXl,
            fontWeight: 600,
            outline: 'none',
            width: 200,
          }}
        />
        <button
          onClick={() => { const v = renameValue.trim(); if (v) onRenameConfirm(v); }}
          style={{ ...ghostButton, borderColor: tokens.colors.accent, color: tokens.colors.accent }}
        >
          Rename Room
        </button>
        <button onClick={onRenameCancel} style={ghostButton}>
          Cancel
        </button>
      </div>
    );
  }

  // 아직 참여하지 않은 자유 참여 방(ticket 995a9519). 방은 목록에 보이고 읽을 수도
  // 있지만, 참여자 전용 동작(초대·이름 변경·내 이력 지우기·나가기·옵션 토글)은 서버가
  // 전부 거부한다. 눌러도 실패할 버튼을 주는 대신 감추고, 어떻게 참여하는지 알려준다.
  // `false` 일 때만 감춘다 — 값이 없는(구버전) 응답은 예전처럼 참여자로 본다.
  if (room.is_participant === false) {
    return (
      <span
        data-testid="room-open-join-hint"
        style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary }}
      >
        Open room — send a message to join
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', gap: tokens.spacing.sm }}>
      {/* 초대는 모든 방 타입에서 열려 있다 (티켓 70e62a9d). DM 에서 누르면 서버가 방을
          group 으로 승격시키며, 되돌릴 수 없다는 경고는 피커 모달이 보여준다 — 여기서
          버튼을 감추면 사용자가 실제로 대화하는 DM 에서는 초대 자체가 불가능해진다. */}
      <button onClick={onAddPeople} data-testid="room-add-people" style={ghostButton}>
        Add People
      </button>
      {/* 자유 참여(open join, ticket 995a9519) — group 전용. DM 은 정확히 2인
          불변식이라 서버가 이 옵션을 거부하므로 토글 자체를 걸지 않는다. 켜면 같은
          워크스페이스의 모든 유저에게 방이 보이고, 참여자가 아니어도 첫 발언 시점에
          자동으로 참여자가 된다. */}
      {room.type === 'group' && (
        <button
          onClick={onToggleOpenJoin}
          disabled={openJoinPending}
          aria-pressed={!!room.open_join}
          data-testid="room-open-join-toggle"
          title={
            room.open_join
              ? 'Anyone in this workspace can see and join this room. Click to close it to participants only.'
              : 'Only participants can see this room. Click to let anyone in this workspace see and join it.'
          }
          style={{
            ...ghostButton,
            cursor: openJoinPending ? 'default' : 'pointer',
            opacity: openJoinPending ? 0.6 : 1,
            ...(room.open_join
              ? { borderColor: tokens.colors.accent, color: tokens.colors.accent }
              : null),
          }}
        >
          {room.open_join ? 'Open Join: On' : 'Open Join: Off'}
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
  // 자유 참여 토글 결과를 방 목록에 반영한다 (ticket 995a9519). 서버의
  // chat_room_update(open_join_changed) 는 **다른** 클라이언트를 위한 것이고,
  // 누른 본인의 화면은 이 콜백으로 즉시 갱신된다.
  onOpenJoinChanged: (roomId: string, openJoin: boolean) => void;
  isMobile: boolean;
  onBack?: () => void;
  participantCount?: number;
  participants?: MentionParticipant[];
  typingAgents?: Record<string, { name: string; status?: string }>; // agent_id -> { name, status }
  // ticket e18be8ff — agent_id -> live keep-alive/background-task snapshot.
  // keepAliveUntilMs is an absolute deadline; render computes the countdown.
  sessionStatusByAgent?: Record<string, { name: string; keepAliveUntilMs: number | null; backgroundTaskCount: number }>;
  currentUserId?: string;
  activeTasks?: AgentCurrentTask[];
  onSelectTask?: (ticketId: string, title: string) => void;
}

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
  onOpenJoinChanged,
  isMobile,
  onBack,
  participantCount = 0,
  participants = [],
  typingAgents = {} as Record<string, { name: string; status?: string }>,
  sessionStatusByAgent = {} as Record<string, { name: string; keepAliveUntilMs: number | null; backgroundTaskCount: number }>,
  currentUserId,
  activeTasks = [],
  onSelectTask = () => {},
}: ChatRoomViewProps) {
  const confirm = useConfirm();
  const { showToast } = useToast();
  const { noteMentionsCleared } = useNotifications();
  const [isRenaming, setIsRenaming] = useState(false);
  const [showAddPeople, setShowAddPeople] = useState(false);
  /** 자유 참여 토글 요청이 진행 중인가 (ticket 995a9519). */
  const [openJoinPending, setOpenJoinPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // @-mentions in this room clear when the message carrying them is actually
  // on screen. Deliberately NOT tied to the room's read marker: a room opens
  // scrolled to the newest message, so marking the room read says nothing
  // about a mention 200 messages up. No observer guard needed — the pending
  // set is scoped to the caller's own user_id server-side, so a non-member
  // watching someone else's room simply gets an empty list.
  useMentionViewportReader({
    containerRef: scrollRef,
    source: { roomId: room?.id },
    anchorAttribute: 'data-message-id',
    renderSignal: messages.length,
    onCleared: noteMentionsCleared,
  });

  // ── Scroll management ──────────────────────────────────────────────────────
  //
  // 규칙 네 가지(첫 진입 즉시 바닥 고정 · 근접할 때만 새 메시지 추종 · 과거 페이지
  // prepend 보정 · 이미지 디코딩으로 높이가 자랄 때 재고정)는 원래 이 파일에서
  // 티켓 abd1ce81 로 만들어졌고, 지금은 네 대화창(chat · mission 대화 · mission step
  // 세션 · Agent Session 전사)이 공유하는 useConversationScroll 이 갖는다. 규칙을
  // 고칠 일이 있으면 그 훅을 고칠 것 — 여기 사본을 되살리지 말 것.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const loadOlder = useCallback(() => {
    if (!onLoadOlderMessages) return;
    if (!hasMoreMessages || loadingOlderMessages) return;
    const oldestId = messages[0]?.id;
    if (!oldestId) return;
    void onLoadOlderMessages(oldestId);
  }, [onLoadOlderMessages, hasMoreMessages, loadingOlderMessages, messages]);

  const { atBottom, scrollToBottom } = useConversationScroll({
    scrollRef,
    contentRef,
    resetKey: room?.id ?? null,
    tailKey: messages[messages.length - 1]?.id ?? null,
    contentKey: messages.length,
    ready: !loadingMessages && messages.length > 0,
    onLoadOlder: loadOlder,
  });

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

  async function handleToggleOpenJoin() {
    if (!room || openJoinPending) return;
    const next = !room.open_join;
    setOpenJoinPending(true);
    try {
      const result = await api.setChatRoomOpenJoin(room.id, next);
      // 서버가 확정한 값을 쓴다 — 낙관적 토글이 서버 판정과 갈리면 화면이 거짓말한다.
      onOpenJoinChanged(room.id, result.open_join);
    } catch (e: any) {
      // 서버가 거부하는 경우(시스템 소유 방 등)를 조용히 삼키면 버튼이 죽은 것처럼
      // 보인다. 사유를 그대로 띄우고 상태는 건드리지 않는다.
      showToast(e?.message || 'Could not change the open-join setting', 'error');
    } finally {
      setOpenJoinPending(false);
    }
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
          background: tokens.colors.surface,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: tokens.typography.fontSizeXl, fontWeight: 600, color: tokens.colors.textPrimary, marginBottom: tokens.spacing.sm }}>
            Select a room
          </div>
          <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary }}>
            Choose a chat from the sidebar to view messages.
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
      onToggleOpenJoin={handleToggleOpenJoin}
      openJoinPending={openJoinPending}
    />
  );

  return (
    <div
      style={{
        background: tokens.colors.surface,
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
            borderBottom: `1px solid ${tokens.colors.border}`,
            padding: '16px 24px',
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.md,
            flexShrink: 0,
          }}
        >
          {isMobile && onBack && (
            <button
              onClick={onBack}
              style={{ background: 'transparent', border: 'none', color: tokens.colors.textSecondary, cursor: 'pointer', fontSize: 18, flexShrink: 0 }}
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
            onToggleOpenJoin={handleToggleOpenJoin}
            openJoinPending={openJoinPending}
          />
        </div>
      ) : (
        <PageHeader
          title={roomDisplayName}
          description={undefined}
          actions={
            <div style={{ display: 'flex', gap: tokens.spacing.sm, alignItems: 'center' }}>
              {/* 이 방이 지금 돌고 있나 — 사이드바의 방 행과 같은 어휘/색
                  (src/activity.ts). 아래 "…is typing" 줄은 누가·무엇을 하는지까지
                  말하지만, 헤더의 이 pill 은 스크롤과 무관하게 항상 보인다. */}
              {Object.keys(typingAgents).length > 0 && (
                <ActivityPill
                  view={roomActivity({ workingNames: Object.values(typingAgents).map((entry) => entry.name) })}
                />
              )}
              {isMobile && onBack && (
                <button
                  onClick={onBack}
                  style={{ background: 'transparent', border: 'none', color: tokens.colors.textSecondary, cursor: 'pointer', fontSize: 18 }}
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
            borderBottom: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surfaceCard,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: tokens.typography.fontSizeXs, fontWeight: 600, color: tokens.colors.textSecondary, marginRight: 2 }}>
            Participants · {participants.length}
          </span>
          {participants.slice(0, MAX_VISIBLE_PARTICIPANT_CHIPS).map((p) => (
            <span
              key={`${p.type}:${p.id}`}
              style={{
                fontSize: tokens.typography.fontSizeXs,
                color: tokens.colors.textPrimary,
                background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.xl,
                padding: '2px 8px',
                whiteSpace: 'nowrap',
              }}
            >
              {p.name}
              {p.type === 'agent' && (
                <span style={{ color: tokens.colors.textSecondary, marginLeft: 4, fontSize: 10 }}>agent</span>
              )}
            </span>
          ))}
          {participants.length > MAX_VISIBLE_PARTICIPANT_CHIPS && (
            <span
              title={participants.map((p) => p.name).join(', ')}
              style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textSecondary, padding: '2px 4px', whiteSpace: 'nowrap' }}
            >
              +{participants.length - MAX_VISIBLE_PARTICIPANT_CHIPS} more
            </span>
          )}
          {/* 대화 도중 참여자 추가 진입점 — 헤더의 "Add People" 과 같은 모달을 연다.
              DM 을 포함한 모든 방에서 보인다(티켓 70e62a9d). 아직 참여하지 않은 자유
              참여 방에서는 서버가 거부하므로 감춘다 — 헤더가 그 경우 버튼 묶음을 통째로
              대체하는 것과 같은 기준이고, 규칙 자체는 canInviteToRoom 이 소유한다. */}
          {canInviteToRoom(room) && (
            <button
              onClick={() => setShowAddPeople(true)}
              aria-label="Add participant"
              style={{
                fontSize: tokens.typography.fontSizeXs,
                fontWeight: 600,
                color: tokens.colors.accent,
                background: 'transparent',
                border: `1px dashed ${tokens.colors.accent}`,
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

      <ActiveTaskStrip tasks={activeTasks} onSelectTicket={onSelectTask} />

      {/* Older-message loading banner — sits OUTSIDE the scroll viewport so
          its appearance/disappearance doesn't perturb scrollHeight and break
          the prepend scroll-anchor math in useConversationScroll. */}
      {loadingOlderMessages && (
        <div
          aria-live="polite"
          style={{
            padding: '4px 16px',
            textAlign: 'center',
            fontSize: tokens.typography.fontSizeXs,
            color: tokens.colors.textMuted,
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
              <div key={i} style={{ marginBottom: tokens.spacing.md }}>
                <div style={{ width: 80, height: 12, background: tokens.colors.border, borderRadius: tokens.radii.sm, marginBottom: 6 }} />
                <div style={{ width: '60%', height: 14, background: tokens.colors.border, borderRadius: tokens.radii.sm }} />
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
            <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary }}>
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
      </div>

      {/* 위에서 이력을 읽는 중일 때만 뜨는 복귀 버튼 — mission 대화·세션 전사와 같은
          버튼이다(대화창 네 곳의 동작을 일치시킨다). */}
      {!atBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom('auto')}
          data-testid="chat-jump-latest"
          style={{
            alignSelf: 'center', marginTop: -34, marginBottom: 6, fontSize: 11.5, padding: '4px 10px',
            borderRadius: 999, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surfaceCard,
            color: tokens.colors.textSecondary, cursor: 'pointer', zIndex: 1,
          }}
        >
          ↓ 최신으로
        </button>
      )}

      {/* Typing indicator */}
      {Object.keys(typingAgents).length > 0 && (
        <div style={{
          padding: '4px 16px',
          fontSize: '13px',
          color: tokens.colors.textSecondary,
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

      {/* ticket e18be8ff — keep-alive / background-task-count badge */}
      {Object.keys(sessionStatusByAgent).length > 0 && (
        <div style={{
          padding: '4px 16px',
          fontSize: '13px',
          color: tokens.colors.textSecondary,
          flexShrink: 0,
        }}>
          {Object.entries(sessionStatusByAgent).map(([agentId, s]) => {
            const parts: string[] = [];
            if (s.backgroundTaskCount > 0) parts.push(`백그라운드 작업 ${s.backgroundTaskCount}개 실행 중`);
            // Only render a still-future deadline — a stale/expired one (SSE
            // exit push lost or delayed) must not surface as "잔여 0분"
            // (ticket e18be8ff review round 1, P1 #1). The countdown-tick
            // effect in ChatPage prunes these on its own cadence; this guard
            // covers the gap before the next prune runs.
            if (s.keepAliveUntilMs && s.keepAliveUntilMs > Date.now()) {
              const remainMin = Math.max(1, Math.round((s.keepAliveUntilMs - Date.now()) / 60_000));
              parts.push(`keep-alive 잔여 ${remainMin}분`);
            }
            if (parts.length === 0) return null;
            const namePrefix = Object.keys(sessionStatusByAgent).length > 1 ? `${s.name} — ` : '';
            return <div key={agentId}>{namePrefix}{parts.join(' · ')}</div>;
          })}
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
        // DM 에 초대하면 방이 group 으로 승격되고 되돌릴 수 없다 — 확정 전에 알린다.
        promotesDmToGroup={room.type === 'dm'}
      />
    </div>
  );
}
