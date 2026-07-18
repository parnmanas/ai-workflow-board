import React, { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import type { ChatRoomListItem } from '../../types';
import { relativeTimeShort } from './utils/time';

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
  // v0.32: workspace-wide observer toggle. When true, the list shows every
  // active room in the workspace including agent-to-agent rooms the user
  // isn't a participant in. Optional so legacy callers compile unchanged.
  showAllRooms?: boolean;
  onToggleShowAllRooms?: (next: boolean) => void;
  // 방 목록의 참여자 요약에서 "본인"을 제외하기 위한 현재 사용자 id. 없으면 제외 없이
  // 모든 참여자 이름을 보여준다(옵셔널이라 기존 호출부는 그대로 컴파일된다).
  currentUserId?: string;
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
  showAllRooms,
  onToggleShowAllRooms,
  currentUserId,
}: ChatRoomListPanelProps) {
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always-visible top filter (separate from the magnifier-overlay search).
  // Filters the room list by participant / room name client-side, and — when
  // the text reaches ≥ 2 chars — additionally fires the same workspace
  // message search so users can find a thread by something said inside it.
  const [filterQuery, setFilterQuery] = useState('');
  const [messageHits, setMessageHits] = useState<any[]>([]);
  const [messageHitsLoading, setMessageHitsLoading] = useState(false);
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search (magnifier-overlay mode)
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

  // Debounced message search for the always-visible filter input. Reuses the
  // 300 ms cadence + searchChatMessages endpoint that powers the overlay.
  useEffect(() => {
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    const q = filterQuery.trim();
    if (q.length < 2) {
      setMessageHits([]);
      setMessageHitsLoading(false);
      return;
    }
    setMessageHitsLoading(true);
    filterDebounceRef.current = setTimeout(() => {
      api.searchChatMessages(workspaceId, q)
        .then((results) => setMessageHits(results))
        .catch(() => setMessageHits([]))
        .finally(() => setMessageHitsLoading(false));
    }, 300);
    return () => {
      if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    };
  }, [filterQuery, workspaceId]);

  // Client-side room filter — matches the trimmed query against the room's
  // displayName, every active participant name, and the DM partner snapshot.
  // Skipped when the filter is empty so the natural last-activity order is
  // preserved.
  const filteredRooms = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter((room) => {
      const display =
        room.type === 'dm'
          ? (room.name || room.dm_partner_name || '')
          : (room.name || '');
      if (display.toLowerCase().includes(q)) return true;
      if (room.dm_partner_name && room.dm_partner_name.toLowerCase().includes(q)) return true;
      if (room.participants) {
        for (const p of room.participants) {
          if (p.name && p.name.toLowerCase().includes(q)) return true;
        }
      }
      return false;
    });
  }, [rooms, filterQuery]);

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
        background: tokens.colors.surfaceCard,
        borderRight: `1px solid ${tokens.colors.border}`,
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
            <div style={{ display: 'flex', gap: tokens.spacing.xs, alignItems: 'center' }}>
              <button
                onClick={openSearch}
                aria-label="Search messages"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: tokens.colors.textSecondary,
                  fontSize: tokens.typography.fontSizeXl,
                  padding: 8,
                  cursor: 'pointer',
                  lineHeight: 1,
                }}
              >
                &#128269;
              </button>
              {onToggleShowAllRooms && (
                <button
                  onClick={() => onToggleShowAllRooms(!showAllRooms)}
                  title={showAllRooms ? 'Showing every workspace room (incl. agent-to-agent). Click for "my rooms" only.' : 'Click to also show rooms you are not a participant in.'}
                  style={{
                    background: showAllRooms ? tokens.colors.accent : 'transparent',
                    color: showAllRooms ? 'white' : tokens.colors.textSecondary,
                    border: `1px solid ${showAllRooms ? tokens.colors.accent : tokens.colors.border}`,
                    borderRadius: tokens.radii.md,
                    padding: '6px 10px',
                    fontSize: tokens.typography.fontSizeXs,
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {showAllRooms ? 'All rooms' : 'My rooms'}
                </button>
              )}
              <button
                onClick={onNewChat}
                style={{
                  background: tokens.colors.accent,
                  color: 'white',
                  border: 'none',
                  borderRadius: tokens.radii.md,
                  padding: '8px 16px',
                  fontSize: tokens.typography.fontSizeMd,
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
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${tokens.colors.border}`, flexShrink: 0, display: 'flex', gap: tokens.spacing.sm, alignItems: 'center' }}>
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search messages..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              flex: 1,
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '8px 16px',
              fontSize: tokens.typography.fontSizeLg,
              color: tokens.colors.textPrimary,
              outline: 'none',
            }}
            onFocus={(e) => (e.target.style.borderColor = tokens.colors.accent)}
            onBlur={(e) => (e.target.style.borderColor = tokens.colors.border)}
          />
          <button
            onClick={closeSearch}
            aria-label="Cancel search"
            style={{
              background: 'transparent',
              border: 'none',
              color: tokens.colors.textSecondary,
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

      {/* Always-visible filter input — member name + ≥ 2-char message search.
          Hidden in magnifier-overlay mode to avoid two competing inputs. */}
      {!isSearching && (
        <div
          style={{
            padding: '8px 16px',
            borderBottom: `1px solid ${tokens.colors.border}`,
            flexShrink: 0,
            display: 'flex',
            gap: tokens.spacing.sm,
            alignItems: 'center',
          }}
        >
          <input
            type="text"
            placeholder="Filter by member or message…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            aria-label="Filter rooms by member name or message content"
            style={{
              flex: 1,
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '6px 12px',
              fontSize: tokens.typography.fontSizeMd,
              color: tokens.colors.textPrimary,
              outline: 'none',
            }}
            onFocus={(e) => (e.target.style.borderColor = tokens.colors.accent)}
            onBlur={(e) => (e.target.style.borderColor = tokens.colors.border)}
          />
          {filterQuery && (
            <button
              onClick={() => setFilterQuery('')}
              aria-label="Clear filter"
              style={{
                background: 'transparent',
                border: 'none',
                color: tokens.colors.textSecondary,
                fontSize: tokens.typography.fontSizeXl,
                cursor: 'pointer',
                padding: '0 4px',
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              ×
            </button>
          )}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isSearching ? (
          searchQuery.length < 2 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary }}>
              Type at least 2 characters to search
            </div>
          ) : searchLoading ? (
            <div style={{ padding: '8px 0' }}>
              {[1, 2, 3].map((i) => (
                <div key={i} style={{ height: 40, margin: '8px 16px', background: tokens.colors.border, borderRadius: tokens.radii.sm }} />
              ))}
            </div>
          ) : searchResults.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: tokens.typography.fontSizeLg, color: tokens.colors.textSecondary }}>
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
              border: `1px solid ${tokens.colors.danger}`,
              borderRadius: tokens.radii.sm,
              color: tokens.colors.danger,
              fontSize: tokens.typography.fontSizeMd,
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
            <div style={{ fontSize: tokens.typography.fontSizeLg, fontWeight: 600, color: tokens.colors.textPrimary, marginBottom: tokens.spacing.sm }}>
              No chats yet
            </div>
            <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary }}>
              Start a conversation with your team or agents. Click 'New Chat' to begin.
            </div>
          </div>
        ) : (
          <>
            {filteredRooms.length === 0 ? (
              <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary }}>
                No rooms match this filter.
              </div>
            ) : (
              <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {filteredRooms.map((room) => (
                  <RoomListRow
                    key={room.id}
                    room={room}
                    isActive={room.id === activeRoomId}
                    onClick={() => onSelectRoom(room.id)}
                    currentUserId={currentUserId}
                  />
                ))}
              </ul>
            )}

            {/* Inline message-search section — appears once the filter is
                ≥ 2 chars. Click jumps to the message in its room, same as
                the magnifier overlay flow. */}
            {filterQuery.trim().length >= 2 && (
              <div style={{ borderTop: `1px solid ${tokens.colors.border}`, marginTop: tokens.spacing.xs }}>
                <div
                  style={{
                    padding: '8px 16px',
                    fontSize: tokens.typography.fontSizeXs,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    color: tokens.colors.textMuted,
                  }}
                >
                  Messages
                </div>
                {messageHitsLoading ? (
                  <div style={{ padding: '8px 0' }}>
                    {[1, 2].map((i) => (
                      <div key={i} style={{ height: 40, margin: '8px 16px', background: tokens.colors.border, borderRadius: tokens.radii.sm }} />
                    ))}
                  </div>
                ) : messageHits.length === 0 ? (
                  <div style={{ padding: '8px 16px 16px', fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary }}>
                    No messages match '{filterQuery.trim()}'.
                  </div>
                ) : (
                  <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {messageHits.map((result) => (
                      <SearchResultRow
                        key={result.message_id}
                        result={result}
                        query={filterQuery.trim()}
                        highlightMatch={highlightMatch}
                        onClick={() => onNavigateToMessage(result.room_id, result.message_id)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
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
        background: hovered ? tokens.overlays.rowHover : 'transparent',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 2,
        borderBottom: `1px solid ${tokens.colors.border}`,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: tokens.spacing.sm }}>
        <span style={{ fontSize: tokens.typography.fontSizeMd, fontWeight: 600, color: tokens.colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {result.room_name}
        </span>
        <span style={{ fontSize: tokens.typography.fontSizeXs, fontWeight: 400, color: tokens.colors.textMuted, flexShrink: 0 }}>
          {relativeTimeShort(result.created_at)}
        </span>
      </div>
      <div style={{ fontSize: tokens.typography.fontSizeLg, fontWeight: 400, color: tokens.colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
            gap: tokens.spacing.sm,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: tokens.radii.full,
              background: tokens.colors.border,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                width: '60%',
                height: 12,
                borderRadius: tokens.radii.sm,
                background: tokens.colors.border,
                marginBottom: 6,
              }}
            />
            <div
              style={{
                width: '80%',
                height: 10,
                borderRadius: tokens.radii.sm,
                background: tokens.colors.border,
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
  currentUserId?: string;
}

// 서버가 방 목록에 실어 주는 participants 프로젝션은 스코프별로 필드명이 다르다:
//  - 내 방(listRooms):        { participant_type, participant_id, name }
//  - 워크스페이스(observer):  { type, id, name }
// 두 형태를 모두 안전하게 읽어 (id, name) 로 정규화한다.
function normalizeMember(p: any): { id: string; name: string } {
  return { id: p?.participant_id ?? p?.id ?? '', name: p?.name ?? '' };
}

// 방 참여자 이름을 "본인 제외"하고 최대 MAX 명까지, 초과분은 "+N" 으로 요약한다.
const MAX_SUMMARY_NAMES = 3;
function buildParticipantSummary(
  participants: ChatRoomListItem['participants'],
  currentUserId?: string,
): string | null {
  if (!participants || participants.length === 0) return null;
  const names = participants
    .map(normalizeMember)
    .filter((m) => m.id !== currentUserId && m.name)
    .map((m) => m.name);
  if (names.length === 0) return null;
  const shown = names.slice(0, MAX_SUMMARY_NAMES);
  const overflow = names.length - shown.length;
  return overflow > 0 ? `${shown.join(', ')} +${overflow}` : shown.join(', ');
}

function RoomListRow({ room, isActive, onClick, currentUserId }: RoomListRowProps) {
  const [hovered, setHovered] = useState(false);

  // Custom room name wins (DMs may be renamed now too — see ticket 1ae77f55);
  // empty room.name falls back to the partner snapshot for DMs or the
  // "Unnamed Group" placeholder for groups.
  const displayName =
    room.type === 'dm'
      ? (room.name || room.dm_partner_name || 'Direct Message')
      : (room.name || 'Unnamed Group');

  // 참여자 요약 라인. 그룹은 항상 노출한다(제목이 자동 조합/커스텀 이름이라 "누가 있는지"를
  // 따로 보여줄 가치가 있다). DM 은 요약이 제목과 다를 때만 노출한다 — 미변경 DM 은 제목=상대라
  // 중복이므로 숨기고, 이름이 바뀐 DM 은 상대가 누구인지 드러내 유용하다.
  const memberCount = room.participants?.length ?? 0;
  const rawSummary = buildParticipantSummary(room.participants, currentUserId);
  const participantSummary =
    room.type === 'group'
      ? rawSummary
      : rawSummary && rawSummary !== displayName
        ? rawSummary
        : null;

  const initials = displayName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  // B5: active room is always "read" from the UI's perspective. The server may
  // briefly report unread_count > 0 due to SSE-vs-markRead ordering, but there's
  // no user value in surfacing that to the room the user is literally viewing.
  const rawUnread = room.unread_count || 0;
  const unreadCount = isActive ? 0 : rawUnread;
  const showBadge = unreadCount > 0;
  const badgeLabel = unreadCount >= 100 ? '99+' : String(unreadCount);

  const bg = isActive
    ? tokens.overlays.accentFaint
    : hovered
    ? tokens.overlays.rowHover
    : 'transparent';

  return (
    <li
      role="listitem"
      aria-current={isActive ? 'true' : undefined}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        // 참여자 요약 라인이 추가돼 행 높이가 가변이므로 고정 height 대신 minHeight 사용.
        minHeight: 64,
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing.sm,
        cursor: 'pointer',
        background: bg,
        borderLeft: isActive ? `3px solid ${tokens.colors.accent}` : '3px solid transparent',
        boxSizing: 'border-box',
      }}
    >
      {/* Avatar */}
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: tokens.radii.full,
          background: tokens.colors.border,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: tokens.typography.fontSizeMd,
          fontWeight: 600,
          color: tokens.colors.textPrimary,
          flexShrink: 0,
        }}
      >
        {initials}
      </div>

      {/* Text content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span
            style={{
              fontSize: tokens.typography.fontSizeMd,
              fontWeight: 600,
              color: tokens.colors.textPrimary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {displayName}
          </span>
          {/* 그룹 방 참여자 수 뱃지 — 한눈에 인원 규모를 보여준다 */}
          {room.type === 'group' && memberCount > 0 && (
            <span
              aria-label={`${memberCount} participants`}
              style={{
                flexShrink: 0,
                fontSize: 10,
                fontWeight: 600,
                color: tokens.colors.textSecondary,
                background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.lg,
                padding: '0 6px',
                lineHeight: '16px',
              }}
            >
              {memberCount}
            </span>
          )}
        </div>
        {/* 참여자 이름 요약 라인 (그룹 전용, 본인 제외) */}
        {participantSummary && (
          <div
            title={participantSummary}
            style={{
              fontSize: tokens.typography.fontSizeXs,
              color: tokens.colors.textSecondary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 2,
            }}
          >
            {participantSummary}
          </div>
        )}
        {room.last_message_preview && (
          <div
            style={{
              fontSize: tokens.typography.fontSizeXs,
              color: tokens.colors.textSecondary,
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
          gap: tokens.spacing.xs,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
          {relativeTimeShort(room.last_message_at || room.created_at)}
        </span>
        {showBadge && (
          <span
            aria-label={`${unreadCount} unread messages`}
            style={{
              background: tokens.colors.accent,
              color: 'white',
              fontSize: tokens.typography.fontSizeXs,
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
