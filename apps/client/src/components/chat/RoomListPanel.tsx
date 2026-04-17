import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import type { ChatRoomListItem } from '../../types';
import { relativeTimeShort } from './utils/time';

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

// ─── ChatRoomListPanel ────────────────────────────────────────────────────────

export interface ChatRoomListPanelProps {
  rooms: ChatRoomListItem[];
  loading: boolean;
  error: string | null;
  activeRoomId: string | null;
  onSelectRoom: (id: string) => void;
  onNewChat: () => void;
  workspaceId: string;
  onNavigateToMessage: (roomId: string, messageId: string) => void;
}

export default function ChatRoomListPanel({
  rooms,
  loading,
  error,
  activeRoomId,
  onSelectRoom,
  onNewChat,
  workspaceId,
  onNavigateToMessage,
}: ChatRoomListPanelProps) {
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search
  useEffect(() => {
    if (!isSearching) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (searchQuery.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    debounceRef.current = setTimeout(() => {
      api.searchChatMessages(workspaceId, searchQuery)
        .then((results) => setSearchResults(results))
        .catch(() => setSearchResults([]))
        .finally(() => setSearchLoading(false));
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, isSearching, workspaceId]);

  // Escape key closes search
  useEffect(() => {
    if (!isSearching) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSearching(false);
        setSearchQuery('');
        setSearchResults([]);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isSearching]);

  function openSearch() {
    setIsSearching(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }

  function closeSearch() {
    setIsSearching(false);
    setSearchQuery('');
    setSearchResults([]);
  }

  function highlightMatch(content: string, query: string): React.ReactNode {
    if (!query || query.length < 2) return content;
    const lower = content.toLowerCase();
    const qLower = query.toLowerCase();
    const idx = lower.indexOf(qLower);
    if (idx < 0) return content;
    return (
      <>
        {content.slice(0, idx)}
        <span style={{ background: 'rgba(99,102,241,0.25)', color: tokens.colors.accentPale, borderRadius: tokens.radii.xs }}>
          {content.slice(idx, idx + query.length)}
        </span>
        {content.slice(idx + query.length)}
      </>
    );
  }

  return (
    <div
      style={{
        background: COLORS.secondary,
        borderRight: `1px solid ${COLORS.border}`,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {!isSearching ? (
        <PageHeader
          title="Chat"
          description="Workspace messaging"
          actions={
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button
                onClick={openSearch}
                aria-label="Search messages"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: COLORS.textSecondary,
                  fontSize: 16,
                  padding: 8,
                  cursor: 'pointer',
                  lineHeight: 1,
                }}
              >
                &#128269;
              </button>
              <button
                onClick={onNewChat}
                style={{
                  background: COLORS.accent,
                  color: 'white',
                  border: 'none',
                  borderRadius: tokens.radii.md,
                  padding: '8px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                + New Chat
              </button>
            </div>
          }
        />
      ) : (
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search messages..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              flex: 1,
              background: COLORS.dominant,
              border: `1px solid ${COLORS.border}`,
              borderRadius: tokens.radii.md,
              padding: '8px 16px',
              fontSize: 14,
              color: COLORS.textPrimary,
              outline: 'none',
            }}
            onFocus={(e) => (e.target.style.borderColor = COLORS.accent)}
            onBlur={(e) => (e.target.style.borderColor = COLORS.border)}
          />
          <button
            onClick={closeSearch}
            aria-label="Cancel search"
            style={{
              background: 'transparent',
              border: 'none',
              color: COLORS.textSecondary,
              fontSize: 18,
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isSearching ? (
          searchQuery.length < 2 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 13, color: COLORS.textSecondary }}>
              Type at least 2 characters to search
            </div>
          ) : searchLoading ? (
            <div style={{ padding: '8px 0' }}>
              {[1, 2, 3].map((i) => (
                <div key={i} style={{ height: 40, margin: '8px 16px', background: COLORS.border, borderRadius: tokens.radii.sm }} />
              ))}
            </div>
          ) : searchResults.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 14, color: COLORS.textSecondary }}>
              No messages match '{searchQuery}'. Try shorter keywords or check your spelling.
            </div>
          ) : (
            <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {searchResults.map((result) => (
                <SearchResultRow
                  key={result.message_id}
                  result={result}
                  query={searchQuery}
                  highlightMatch={highlightMatch}
                  onClick={() => {
                    closeSearch();
                    onNavigateToMessage(result.room_id, result.message_id);
                  }}
                />
              ))}
            </ul>
          )
        ) : loading ? (
          <RoomListSkeleton />
        ) : error ? (
          <div
            style={{
              margin: 16,
              padding: '8px 12px',
              border: `1px solid ${COLORS.destructive}`,
              borderRadius: tokens.radii.sm,
              color: COLORS.destructive,
              fontSize: 13,
            }}
          >
            Could not load chats. Check your connection and retry.
          </div>
        ) : rooms.length === 0 ? (
          <div
            style={{
              padding: '48px 24px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 8 }}>
              No chats yet
            </div>
            <div style={{ fontSize: 13, color: COLORS.textSecondary }}>
              Start a conversation with your team or agents. Click 'New Chat' to begin.
            </div>
          </div>
        ) : (
          <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rooms.map((room) => (
              <RoomListRow
                key={room.id}
                room={room}
                isActive={room.id === activeRoomId}
                onClick={() => onSelectRoom(room.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── SearchResultRow ──────────────────────────────────────────────────────────

interface SearchResultRowProps {
  result: any;
  query: string;
  highlightMatch: (content: string, query: string) => React.ReactNode;
  onClick: () => void;
}

function SearchResultRow({ result, query, highlightMatch, onClick }: SearchResultRowProps) {
  const [hovered, setHovered] = useState(false);
  const snippet = result.content.length > 120 ? result.content.slice(0, 117) + '...' : result.content;

  return (
    <li
      role="listitem"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        minHeight: 56,
        padding: '10px 16px',
        cursor: 'pointer',
        background: hovered ? 'rgba(255,255,255,0.04)' : 'transparent',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 2,
        borderBottom: `1px solid ${COLORS.border}`,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {result.room_name}
        </span>
        <span style={{ fontSize: 11, fontWeight: 400, color: COLORS.textMuted, flexShrink: 0 }}>
          {relativeTimeShort(result.created_at)}
        </span>
      </div>
      <div style={{ fontSize: 14, fontWeight: 400, color: COLORS.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {highlightMatch(snippet, query)}
      </div>
    </li>
  );
}

function RoomListSkeleton() {
  return (
    <div style={{ padding: '8px 0' }}>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            height: 64,
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: COLORS.border,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                width: '60%',
                height: 12,
                borderRadius: tokens.radii.sm,
                background: COLORS.border,
                marginBottom: 6,
              }}
            />
            <div
              style={{
                width: '80%',
                height: 10,
                borderRadius: tokens.radii.sm,
                background: COLORS.border,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

interface RoomListRowProps {
  room: ChatRoomListItem;
  isActive: boolean;
  onClick: () => void;
}

function RoomListRow({ room, isActive, onClick }: RoomListRowProps) {
  const [hovered, setHovered] = useState(false);

  const displayName =
    room.type === 'dm' ? (room.dm_partner_name || room.name || 'Direct Message') : (room.name || 'Unnamed Group');

  const initials = displayName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const unreadCount = room.unread_count || 0;
  const showBadge = unreadCount > 0;
  const badgeLabel = unreadCount >= 100 ? '99+' : String(unreadCount);

  const bg = isActive
    ? 'rgba(99,102,241,0.08)'
    : hovered
    ? 'rgba(255,255,255,0.04)'
    : 'transparent';

  return (
    <li
      role="listitem"
      aria-current={isActive ? 'true' : undefined}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: 64,
        padding: '0 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        background: bg,
        borderLeft: isActive ? `3px solid ${COLORS.accent}` : '3px solid transparent',
        boxSizing: 'border-box',
      }}
    >
      {/* Avatar */}
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          background: COLORS.border,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 600,
          color: COLORS.textPrimary,
          flexShrink: 0,
        }}
      >
        {initials}
      </div>

      {/* Text content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: COLORS.textPrimary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayName}
        </div>
        {room.last_message_preview && (
          <div
            style={{
              fontSize: 11,
              color: COLORS.textSecondary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 2,
            }}
          >
            {room.last_message_preview}
          </div>
        )}
      </div>

      {/* Right side: timestamp + badge */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 4,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, color: COLORS.textMuted }}>
          {relativeTimeShort(room.last_message_at || room.created_at)}
        </span>
        {showBadge && (
          <span
            aria-label={`${unreadCount} unread messages`}
            style={{
              background: COLORS.accent,
              color: 'white',
              fontSize: 11,
              fontWeight: 600,
              minWidth: 16,
              height: 16,
              borderRadius: tokens.radii.lg,
              padding: '0 4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {badgeLabel}
          </span>
        )}
      </div>
    </li>
  );
}
