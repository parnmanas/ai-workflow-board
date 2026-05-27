import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import type { ChatRoomListItem, ChatRoomMessageItem } from '../../types';
import MessageList from './MessageList';
import NewChatModal from './ParticipantPicker';
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

// ─── ChatRoomView (RoomDetailPanel) ───────────────────────────────────────────

export interface ChatRoomViewProps {
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

export default function ChatRoomView({
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
