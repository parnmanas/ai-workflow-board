import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { api } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useToast } from '../contexts/ToastContext';
import { useMediaQuery } from '../hooks/useMediaQuery';
import PageHeader from './PageHeader';
import { tokens } from '../tokens';
import type { ChatRoomListItem, ChatRoomDetail, ChatRoomMessageItem } from '../types';
import { type MentionParticipant } from './chat/utils/markdown';
import MessageList from './chat/MessageList';
import NewChatModal from './chat/ParticipantPicker';
import ChatRoomListPanel from './chat/RoomListPanel';

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
  dominant: tokens.colors.surface,
  secondary: tokens.colors.surfaceCard,
  accent: tokens.colors.accent,
  border: tokens.colors.border,
  textPrimary: tokens.colors.textPrimary,
  textSecondary: tokens.colors.textSecondary,
  textMuted: tokens.colors.borderStrong,
  destructive: tokens.colors.danger,
  agentName: tokens.colors.accentSubtle,
};



// ─── ChatMessageInput ─────────────────────────────────────────────────────────

interface ChatMessageInputProps {
  roomId: string;
  onSent: (msg: ChatRoomMessageItem) => void;
  isMobile: boolean;
}

interface PendingImage {
  data: string;
  filename: string;
  mimetype: string;
  preview: string; // object URL for thumbnail display only
}

const MAX_CLIENT_IMAGES = 5;
const MAX_CLIENT_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_CLIENT_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function ChatMessageInput({ roomId, onSent, isMobile }: ChatMessageInputProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 112)}px`;
  }, [text]);

  // Revoke object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      pendingImages.forEach((img) => URL.revokeObjectURL(img.preview));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSend() {
    const content = text.trim();
    if ((!content && pendingImages.length === 0) || sending) return;
    setSending(true);
    setSendError(null);
    setText('');
    const imagesToSend = pendingImages.map(({ data, filename, mimetype }) => ({ data, filename, mimetype }));
    setPendingImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.preview));
      return [];
    });
    try {
      const msg = await api.sendChatRoomMessage(roomId, content || ' ', imagesToSend.length > 0 ? imagesToSend : undefined);
      onSent(msg);
    } catch (err: any) {
      setSendError('Message not sent. Check your connection.');
      setText(content); // restore draft
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    // Reset input so the same file can be re-selected after removal
    e.target.value = '';
    setUploadError(null);

    if (pendingImages.length + files.length > MAX_CLIENT_IMAGES) {
      setUploadError('Maximum 5 images per message');
      return;
    }

    const readers: Promise<PendingImage>[] = files.map(
      (file) =>
        new Promise((resolve, reject) => {
          if (!ALLOWED_CLIENT_MIMETYPES.has(file.type)) {
            reject(new Error('Unsupported format. Use JPEG, PNG, GIF, or WebP.'));
            return;
          }
          if (file.size > MAX_CLIENT_IMAGE_BYTES) {
            reject(new Error('File too large (max 5 MB)'));
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            // Strip data URL prefix to get raw base64
            const base64 = result.split(',')[1] || result;
            const preview = URL.createObjectURL(file);
            resolve({ data: base64, filename: file.name, mimetype: file.type, preview });
          };
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        }),
    );

    Promise.all(readers)
      .then((newImages) => {
        setPendingImages((prev) => [...prev, ...newImages]);
      })
      .catch((err: Error) => {
        setUploadError(err.message);
      });
  }

  function removeImage(idx: number) {
    setPendingImages((prev) => {
      URL.revokeObjectURL(prev[idx].preview);
      return prev.filter((_, i) => i !== idx);
    });
    setUploadError(null);
  }

  const canSend = (text.trim().length > 0 || pendingImages.length > 0) && !sending;
  const canAttach = pendingImages.length < MAX_CLIENT_IMAGES && !sending;

  return (
    <div
      style={{
        background: COLORS.secondary,
        borderTop: `1px solid ${COLORS.border}`,
        flexShrink: 0,
      }}
    >
      {/* AttachmentStrip */}
      {pendingImages.length > 0 && (
        <div
          style={{
            background: tokens.colors.surfaceCard,
            borderTop: `1px solid ${COLORS.border}`,
            padding: '8px 16px',
            display: 'flex',
            gap: 8,
            overflowX: 'auto',
            alignItems: 'flex-end',
          }}
        >
          {pendingImages.map((img, idx) => (
            <div key={idx} style={{ position: 'relative', flexShrink: 0 }}>
              <img
                src={img.preview}
                alt={img.filename}
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: tokens.radii.sm,
                  objectFit: 'cover',
                  border: `1px solid ${COLORS.border}`,
                  display: 'block',
                }}
              />
              <button
                onClick={() => removeImage(idx)}
                aria-label={`Remove ${img.filename}`}
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  width: 16,
                  height: 16,
                  background: 'rgba(0,0,0,0.6)',
                  color: tokens.colors.textPrimary,
                  border: 'none',
                  borderRadius: tokens.radii.lg,
                  fontSize: 11,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                ×
              </button>
            </div>
          ))}
          <div style={{ marginLeft: 'auto', fontSize: 11, color: COLORS.textSecondary, whiteSpace: 'nowrap', alignSelf: 'center' }}>
            {pendingImages.length} / 5 images
          </div>
        </div>
      )}
      {uploadError && (
        <div style={{ fontSize: 11, color: tokens.colors.danger, padding: '4px 16px' }}>
          {uploadError}
        </div>
      )}

      <div style={{ padding: '16px 16px' }}>
        {sendError && (
          <div style={{ fontSize: 13, color: COLORS.destructive, marginBottom: 8 }}>
            {sendError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          {/* Attach button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!canAttach}
            aria-label="Attach images"
            style={{
              background: 'transparent',
              border: 'none',
              color: canAttach ? COLORS.textSecondary : COLORS.textMuted,
              fontSize: 20,
              padding: 8,
              cursor: canAttach ? 'pointer' : 'not-allowed',
              flexShrink: 0,
              alignSelf: 'flex-end',
              lineHeight: 1,
              height: 44,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            +
          </button>
          <textarea
            ref={textareaRef}
            aria-label="Message"
            aria-required="true"
            placeholder="Type a message…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            rows={1}
            style={{
              flex: 1,
              background: COLORS.dominant,
              border: `1px solid ${COLORS.border}`,
              borderRadius: tokens.radii.md,
              color: COLORS.textPrimary,
              fontSize: 14,
              padding: '8px 16px',
              resize: 'none',
              minHeight: 44,
              maxHeight: 112,
              outline: 'none',
              fontFamily: 'inherit',
              lineHeight: 1.5,
              boxSizing: 'border-box',
            }}
            onFocus={(e) => (e.target.style.borderColor = COLORS.accent)}
            onBlur={(e) => (e.target.style.borderColor = COLORS.border)}
          />
          <button
            onClick={handleSend}
            disabled={!canSend}
            aria-label={isMobile ? 'Send message' : undefined}
            style={{
              background: COLORS.accent,
              color: 'white',
              border: 'none',
              borderRadius: tokens.radii.md,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: canSend ? 'pointer' : 'not-allowed',
              opacity: canSend ? 1 : 0.5,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              alignSelf: 'flex-end',
              height: 44,
            }}
          >
            {isMobile ? '▶' : 'Send Message'}
          </button>
        </div>
        <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4 }}>
          Enter to send · Shift+Enter for new line
        </div>
      </div>
    </div>
  );
}

// ─── RoomHeaderActions ────────────────────────────────────────────────────────

interface RoomHeaderActionsProps {
  room: ChatRoomListItem;
  isRenaming: boolean;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onRenameConfirm: (name: string) => void;
  onLeave: () => void;
  onAddPeople: () => void;
}

function RoomHeaderActions({
  room,
  isRenaming,
  onRenameStart,
  onRenameCancel,
  onRenameConfirm,
  onLeave,
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
      {room.type === 'group' && (
        <>
          <button onClick={onAddPeople} style={ghostButton}>
            Add People
          </button>
          <button onClick={onRenameStart} style={ghostButton}>
            Rename
          </button>
        </>
      )}
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

// ─── ChatRoomView ─────────────────────────────────────────────────────────────

interface ChatRoomViewProps {
  room: ChatRoomListItem | null;
  messages: ChatRoomMessageItem[];
  loadingMessages: boolean;
  onMessageSent: (msg: ChatRoomMessageItem) => void;
  onLeaveRoom: (roomId: string) => void;
  onRoomRenamed: (roomId: string, name: string) => void;
  onParticipantsAdded: (roomId: string) => void;
  isMobile: boolean;
  onBack?: () => void;
  participantCount?: number;
  participants?: MentionParticipant[];
  typingAgents?: Record<string, { name: string; status?: string }>; // agent_id -> { name, status }
  currentUserId?: string;
}

function ChatRoomView({
  room,
  messages,
  loadingMessages,
  onMessageSent,
  onLeaveRoom,
  onRoomRenamed,
  onParticipantsAdded,
  isMobile,
  onBack,
  participantCount = 0,
  participants = [],
  typingAgents = {} as Record<string, { name: string; status?: string }>,
  currentUserId,
}: ChatRoomViewProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [showAddPeople, setShowAddPeople] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function handleLeave() {
    if (!room) return;
    const confirmed = window.confirm("Leave this room? You'll need to be re-added to rejoin.");
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

  const roomDisplayName =
    room.type === 'dm'
      ? (room.dm_partner_name || room.name || 'Direct Message')
      : (room.name || 'Unnamed Group');

  const headerActions = isRenaming ? null : (
    <RoomHeaderActions
      room={room}
      isRenaming={isRenaming}
      onRenameStart={() => setIsRenaming(true)}
      onRenameCancel={() => setIsRenaming(false)}
      onRenameConfirm={handleRenameConfirm}
      onLeave={handleLeave}
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
          <MessageList messages={messages} participantCount={participantCount} participants={participants} currentUserId={currentUserId} />
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
      />
    </div>
  );
}

// ─── Main ChatPage component ──────────────────────────────────────────────────

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
  const { showToast, muted, playNotifySound } = useToast();
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
  const originalTitleRef = useRef(document.title);
  const activeRoomIdRef = useRef<string | null>(null);

  // Keep ref in sync with state for use in SSE callbacks
  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);

  // Load rooms on mount
  useEffect(() => {
    setLoading(true);
    api.listChatRooms()
      .then((list) => {
        setRooms(list);
        setRoomsError(null);
      })
      .catch(() => {
        setRoomsError('Could not load chats.');
      })
      .finally(() => setLoading(false));
  }, []);

  // Load messages + mark read on room change
  useEffect(() => {
    setTypingAgents({}); // clear stale typing indicators when switching rooms
    if (!activeRoomId) {
      setMessages([]);
      setRoomParticipants([]);
      return;
    }
    setLoadingMessages(true);
    api.getChatRoomMessages(activeRoomId)
      .then((msgs) => setMessages(msgs))
      .catch(() => setMessages([]))
      .finally(() => setLoadingMessages(false));

    // Fetch room detail to populate participants for @mention pill rendering
    api.getChatRoom(activeRoomId)
      .then((detail: any) => {
        if (detail?.participants) {
          const mentionPs: MentionParticipant[] = detail.participants.map((p: any) => ({
            id: p.participant_id,
            name: p.name,
            type: p.participant_type,
          }));
          setRoomParticipants(mentionPs);
          setParticipantCount(mentionPs.filter((p) => p.type === 'user').length);
        }
      })
      .catch(() => {});

    // Mark room as read
    api.markChatRoomRead(activeRoomId).catch(() => {});
    setRooms((prev) =>
      prev.map((r) => (r.id === activeRoomId ? { ...r, unread_count: 0 } : r)),
    );

  }, [activeRoomId]);

  // Mark read on visibility change (tab regains focus)
  useEffect(() => {
    if (!activeRoomId) return;
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
  }, [activeRoomId]);

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
      api.markChatRoomRead(msg.room_id).catch(() => {});
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
    }
  }, []));

  function selectRoom(roomId: string) {
    setActiveRoomId(roomId);
    if (isMobile) setMobileView('room');
  }

  function handleNavigateToMessage(roomId: string, messageId: string) {
    selectRoom(roomId);
    setScrollToMessageId(messageId);
  }

  function handleMessageSent(msg: ChatRoomMessageItem) {
    setMessages((prev) => [...prev, msg]);
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

  function handleParticipantsAdded(roomId: string) {
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

  const workspaceId = typeof window !== 'undefined' ? (localStorage.getItem('currentWorkspaceId') || '') : '';
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
