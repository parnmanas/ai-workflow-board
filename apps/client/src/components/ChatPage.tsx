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

// ─── Utility functions (copied verbatim from v1.0) ────────────────────────────

function relativeTimeShort(iso: string | undefined | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const d = new Date(then);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (isToday) return `${hh}:${mm}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${hh}:${mm}`;
}

function daySeparatorLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const startOf = (dt: Date) =>
    new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) return 'TODAY';
  if (diffDays === 1) return 'YESTERDAY';
  return d
    .toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    .toUpperCase();
}

function sameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// ─── renderMarkdown — XSS-safe inline markdown ───────────────────────────────
// T-07-12: No dangerouslySetInnerHTML. React JSX element construction only.
// URL scheme validation: only http:// and https:// are allowed in <a> href.
// Phase 8: @mention tokens rendered as accent-colored pills (CHAT-17).

const ROLE_SHORTCUTS = new Set(['reviewer', 'assignee', 'reporter']);

interface MentionParticipant {
  id: string;
  name: string;
  type: string;
}

function renderMarkdown(text: string, participants?: MentionParticipant[]): React.ReactNode[] {
  if (!text) return [];

  // Step 1: Split on backtick code spans
  const parts = text.split(/(`[^`]*`)/g);
  const nodes: React.ReactNode[] = [];
  let keyIdx = 0;

  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      // Code span
      const code = part.slice(1, -1);
      nodes.push(
        <code
          key={keyIdx++}
          style={{
            fontFamily: 'monospace',
            fontSize: 13,
            background: tokens.colors.surfaceCard,
            padding: '1px 4px',
            borderRadius: tokens.radii.xs,
          }}
        >
          {code}
        </code>,
      );
    } else {
      // Step 1b: Split on @mention tokens before applying other formatting
      const mentionParts = part.split(/(@[a-zA-Z0-9_-]+)/g);
      for (const mp of mentionParts) {
        if (mp.startsWith('@') && mp.length > 1) {
          const name = mp.slice(1);
          const lower = name.toLowerCase();
          const isRoleShortcut = ROLE_SHORTCUTS.has(lower);
          const matchedParticipant = participants?.find(
            (p) => p.name.toLowerCase() === lower,
          );
          const isAgent = matchedParticipant?.type === 'agent';
          const isResolved = isRoleShortcut || !!matchedParticipant;

          if (isResolved) {
            // Render as pill: agent = accentSubtle bg, user/role = accentPale bg
            const bgColor = isAgent ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.12)';
            const textColor = isAgent ? tokens.colors.accentSubtle : tokens.colors.accentPale;
            nodes.push(
              <span
                key={keyIdx++}
                aria-label={`Mention: ${mp}`}
                style={{
                  background: bgColor,
                  color: textColor,
                  borderRadius: tokens.radii.sm,
                  padding: '0 4px',
                  display: 'inline',
                }}
              >
                {mp}
              </span>,
            );
          } else {
            // Unresolved mention: plain muted text
            nodes.push(
              <span key={keyIdx++} style={{ color: tokens.colors.textSecondary }}>{mp}</span>,
            );
          }
          continue;
        }

        // Step 2: Apply bold, italic, links to non-mention, non-code segments
        const segments = mp.split(/(\*\*[^*]+\*\*|\*[^*]+\*|https?:\/\/[^\s]+)/g);
        for (const seg of segments) {
          if (!seg) continue;
          if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 4) {
            nodes.push(
              <strong key={keyIdx++} style={{ fontWeight: 600 }}>
                {seg.slice(2, -2)}
              </strong>,
            );
          } else if (seg.startsWith('*') && seg.endsWith('*') && seg.length > 2) {
            nodes.push(<em key={keyIdx++}>{seg.slice(1, -1)}</em>);
          } else if (/^https?:\/\//.test(seg)) {
            // T-07-12: Only allow http/https — reject javascript: and data: schemes
            nodes.push(
              <InlineLink key={keyIdx++} href={seg} />,
            );
          } else {
            nodes.push(<React.Fragment key={keyIdx++}>{seg}</React.Fragment>);
          }
        }
      }
    }
  }

  return nodes;
}

// Separate component to hold hover state for link underline without global CSS
function InlineLink({ href }: { href: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: COLORS.accent,
        textDecoration: hovered ? 'underline' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {href}
    </a>
  );
}

// ─── Participant type for picker ──────────────────────────────────────────────

interface PickerParticipant {
  id: string;
  name: string;
  type: 'user' | 'agent';
}

// ─── NewChatModal ─────────────────────────────────────────────────────────────

interface NewChatModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (room: ChatRoomDetail | null) => void;
  /** If provided, modal is in "Add People" mode */
  addToRoomId?: string;
  /** Participants already in the room (excluded from picker) */
  existingParticipantIds?: string[];
}

function NewChatModal({ open, onClose, onCreated, addToRoomId, existingParticipantIds = [] }: NewChatModalProps) {
  const { user: currentUser } = useAuth();
  const [participants, setParticipants] = useState<PickerParticipant[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedParticipants, setSelectedParticipants] = useState<PickerParticipant[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const modalId = useRef(`modal-${Math.random().toString(36).slice(2)}`).current;

  useEffect(() => {
    if (!open) return;
    setSearchQuery('');
    setSelectedParticipants([]);
    setError(null);

    Promise.all([
      api.getUsers().catch(() => [] as any[]),
      api.getAgents().catch(() => [] as any[]),
    ]).then(([users, agents]) => {
      const excludeIds = new Set([...existingParticipantIds, currentUser?.id].filter(Boolean));
      const list: PickerParticipant[] = [
        ...users.map((u: any) => ({ id: u.id, name: u.name, type: 'user' as const })),
        ...agents.map((a: any) => ({ id: a.id, name: a.name, type: 'agent' as const })),
      ].filter((p) => !excludeIds.has(p.id));
      setParticipants(list);
    });

    // Focus search on open
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key closes
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return participants;
    const q = searchQuery.toLowerCase();
    return participants.filter((p) => p.name.toLowerCase().includes(q));
  }, [participants, searchQuery]);

  function toggleParticipant(p: PickerParticipant) {
    setSelectedParticipants((prev) => {
      const idx = prev.findIndex((s) => s.id === p.id);
      if (idx >= 0) return prev.filter((_, i) => i !== idx);
      return [...prev, p];
    });
  }

  function removeSelected(id: string) {
    setSelectedParticipants((prev) => prev.filter((p) => p.id !== id));
  }

  const isAddMode = !!addToRoomId;
  const isDM = !isAddMode && selectedParticipants.length === 1;
  const isGroup = !isAddMode && selectedParticipants.length > 1;
  const canCreate = selectedParticipants.length > 0 && !creating;

  async function handleCreate() {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const apiParticipants = selectedParticipants.map((p) => ({
        participant_type: p.type,
        participant_id: p.id,
      }));
      if (isAddMode && addToRoomId) {
        await api.addChatRoomParticipants(addToRoomId, apiParticipants);
        onCreated(null); // signal completion (add-people mode)
      } else {
        const room = await api.createChatRoom(apiParticipants);
        onCreated(room);
      }
    } catch (err: any) {
      const msg = err?.message || 'Failed to create room.';
      if (msg.includes('50') || msg.includes('full') || msg.includes('limit')) {
        setError('This room is full (50 participant limit).');
      } else {
        setError(msg);
      }
    } finally {
      setCreating(false);
    }
  }

  if (!open) return null;

  const titleId = `${modalId}-title`;
  const title = isAddMode ? 'Add People' : 'New Chat';
  const createBtnLabel = isAddMode
    ? (creating ? 'Adding…' : 'Add to Room')
    : isDM
    ? (creating ? 'Creating…' : 'Start Chat')
    : (creating ? 'Creating…' : 'Create Group');

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          background: COLORS.secondary,
          border: `1px solid ${COLORS.border}`,
          borderRadius: tokens.radii.lg,
          width: 480,
          maxWidth: '90vw',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: `1px solid ${COLORS.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <span id={titleId} style={{ fontSize: 16, fontWeight: 600, color: COLORS.textPrimary }}>
            {title}
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: COLORS.textSecondary,
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: '0 4px',
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Selected chips */}
        {selectedParticipants.length > 0 && (
          <div
            style={{
              padding: '8px 16px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              borderBottom: `1px solid ${COLORS.border}`,
              flexShrink: 0,
            }}
          >
            {selectedParticipants.map((p) => (
              <span
                key={p.id}
                style={{
                  background: COLORS.accent,
                  color: 'white',
                  borderRadius: tokens.radii.xl,
                  padding: '4px 8px',
                  fontSize: 11,
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {p.name}
                <button
                  onClick={() => removeSelected(p.id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: 12,
                    lineHeight: 1,
                    padding: 0,
                  }}
                  aria-label={`Remove ${p.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Search input */}
        <div style={{ padding: '8px 16px', flexShrink: 0 }}>
          <input
            ref={searchRef}
            type="text"
            placeholder="Search users and agents…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              background: COLORS.dominant,
              border: `1px solid ${COLORS.border}`,
              borderRadius: tokens.radii.md,
              padding: '8px 16px',
              fontSize: 14,
              color: COLORS.textPrimary,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* DM / Group label */}
        {!isAddMode && selectedParticipants.length > 0 && (
          <div style={{ padding: '0 16px 8px', fontSize: 11, color: COLORS.textSecondary, flexShrink: 0 }}>
            {isDM ? 'Direct message' : `Group · ${selectedParticipants.length} selected`}
          </div>
        )}

        {/* Participant list */}
        <div style={{ overflowY: 'auto', maxHeight: 280, flex: 1 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: COLORS.textMuted, textAlign: 'center' }}>
              No matches. Try a different name.
            </div>
          ) : (
            filtered.map((p) => {
              const isSelected = selectedParticipants.some((s) => s.id === p.id);
              const initials = p.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
              return (
                <label
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '0 16px',
                    height: 40,
                    cursor: 'pointer',
                    background: isSelected ? 'rgba(99,102,241,0.08)' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleParticipant(p)}
                    style={{ accentColor: COLORS.accent, width: 14, height: 14, flexShrink: 0 }}
                  />
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: COLORS.border,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 600,
                      color: COLORS.textPrimary,
                      flexShrink: 0,
                    }}
                  >
                    {initials}
                  </div>
                  <span style={{ fontSize: 13, color: COLORS.textPrimary, flex: 1 }}>{p.name}</span>
                  <span style={{ fontSize: 11, color: COLORS.textSecondary }}>
                    {p.type === 'agent' ? 'Agent' : 'User'}
                  </span>
                </label>
              );
            })
          )}
        </div>

        {/* Error */}
        {error && (
          <div
            style={{
              margin: '0 16px',
              padding: '8px 12px',
              border: `1px solid ${COLORS.destructive}`,
              borderRadius: tokens.radii.sm,
              color: COLORS.destructive,
              fontSize: 13,
              flexShrink: 0,
            }}
          >
            {error}
          </div>
        )}

        {/* Create button */}
        <div style={{ padding: 16, flexShrink: 0 }}>
          <button
            onClick={handleCreate}
            disabled={!canCreate}
            style={{
              width: '100%',
              background: COLORS.accent,
              color: 'white',
              border: 'none',
              borderRadius: tokens.radii.md,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: canCreate ? 'pointer' : 'not-allowed',
              opacity: canCreate ? 1 : 0.5,
            }}
          >
            {createBtnLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ChatRoomListPanel ────────────────────────────────────────────────────────

interface ChatRoomListPanelProps {
  rooms: ChatRoomListItem[];
  loading: boolean;
  error: string | null;
  activeRoomId: string | null;
  onSelectRoom: (id: string) => void;
  onNewChat: () => void;
  workspaceId: string;
  onNavigateToMessage: (roomId: string, messageId: string) => void;
}

function ChatRoomListPanel({
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
  typingAgents?: Record<string, string>; // agent_id -> agent_name
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
  typingAgents = {},
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
          {Object.values(typingAgents).join(', ')}
          {Object.keys(typingAgents).length === 1 ? ' is typing' : ' are typing'}
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

// ─── MessageList ──────────────────────────────────────────────────────────────

interface MessageListProps {
  messages: ChatRoomMessageItem[];
  participantCount: number;
  participants?: MentionParticipant[];
  currentUserId?: string;
}

function MessageList({ messages, participantCount, participants = [], currentUserId }: MessageListProps) {
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Close lightbox on Escape key
  useEffect(() => {
    if (!lightboxImage) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightboxImage(null);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [lightboxImage]);

  const rendered: React.ReactNode[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const prev = i > 0 ? messages[i - 1] : null;

    // Day separator
    if (!prev || !sameDay(prev.created_at, msg.created_at)) {
      const label = daySeparatorLabel(msg.created_at);
      rendered.push(
        <div
          key={`day-${msg.id}`}
          role="separator"
          aria-label={label}
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '16px 16px',
            gap: 12,
          }}
        >
          <div style={{ flex: 1, height: 1, background: COLORS.border }} />
          <span
            style={{
              fontSize: 11,
              color: COLORS.textMuted,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>
          <div style={{ flex: 1, height: 1, background: COLORS.border }} />
        </div>,
      );
    }

    // Collapse sender info if same sender within 60s
    const prevSameWindow =
      prev &&
      prev.sender_id === msg.sender_id &&
      sameDay(prev.created_at, msg.created_at) &&
      new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() < 60000;

    const isAgent = msg.sender_type === 'agent';
    const isLast = i === messages.length - 1;

    // Parse images JSON (stored as string from server)
    let msgImages: Array<{ data: string; filename: string; mimetype: string }> = [];
    if (msg.images) {
      try {
        const parsed = typeof msg.images === 'string' ? JSON.parse(msg.images) : msg.images;
        if (Array.isArray(parsed)) msgImages = parsed;
      } catch {
        // malformed images field — skip silently
      }
    }

    const isMe = msg.sender_type === 'user' && msg.sender_id === currentUserId;

    rendered.push(
      <div
        key={msg.id}
        data-message-id={msg.id}
        style={{
          padding: '3px 16px',
          display: 'flex',
          justifyContent: isMe ? 'flex-end' : 'flex-start',
        }}
      >
        <div style={{ maxWidth: '75%' }}>
          {!prevSameWindow && (
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                marginBottom: 4,
                justifyContent: isMe ? 'flex-end' : 'flex-start',
              }}
            >
              {isMe ? (
                <>
                  <span style={{ fontSize: 11, color: COLORS.textMuted }}>
                    {formatClockTime(msg.created_at)}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
                    {msg.sender_name}
                  </span>
                </>
              ) : (
                <>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: isAgent ? COLORS.agentName : COLORS.textPrimary,
                    }}
                  >
                    {msg.sender_name}
                  </span>
                  {isAgent && (
                    <span style={{ fontSize: 11, color: COLORS.textSecondary }}>(agent)</span>
                  )}
                  <span style={{ fontSize: 11, color: COLORS.textMuted }}>
                    {formatClockTime(msg.created_at)}
                  </span>
                </>
              )}
            </div>
          )}
          <div
            style={{
              fontSize: 14,
              color: COLORS.textPrimary,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: isMe ? `${tokens.colors.accent}18` : COLORS.secondary,
              padding: '8px 12px',
              borderRadius: prevSameWindow
                ? '12px'
                : isMe
                  ? '12px 12px 2px 12px'
                  : '12px 12px 12px 2px',
            }}
          >
            {renderMarkdown(msg.content, participants)}
            {/* Inline image thumbnails */}
            {msgImages.length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', justifyContent: isMe ? 'flex-end' : 'flex-start' }}>
                {msgImages.map((img, idx) => (
                  <img
                    key={idx}
                    src={`data:${img.mimetype};base64,${img.data}`}
                    alt={img.filename || `Image ${idx + 1}`}
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: tokens.radii.sm,
                      objectFit: 'cover',
                      cursor: 'pointer',
                      border: `1px solid ${COLORS.border}`,
                    }}
                    onClick={() => setLightboxImage(`data:${img.mimetype};base64,${img.data}`)}
                  />
                ))}
              </div>
            )}
          </div>
          {/* Read receipt below last message */}
          {isLast && participantCount > 1 && (
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4, textAlign: isMe ? 'right' : 'left' }}>
              Read by {participantCount - 1}
            </div>
          )}
        </div>
      </div>,
    );
  }

  return (
    <>
      <div>{rendered}</div>
      {/* Image lightbox */}
      {lightboxImage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={() => setLightboxImage(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <img
            src={lightboxImage}
            alt="Full size preview"
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: tokens.radii.sm }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
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
  const [typingAgents, setTypingAgents] = useState<Record<string, string>>({}); // agent_id -> agent_name
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

  // SSE: chat_room_typing — agent typing indicator
  useBoardStreamEvent('chat_room_typing', useCallback((data: any) => {
    if (!data || !data.room_id) return;
    if (data.room_id !== activeRoomIdRef.current) return;
    setTypingAgents((prev) => {
      if (data.is_typing) {
        return { ...prev, [data.agent_id]: data.agent_name || 'Agent' };
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
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {showUpgradeBanner && <ProtocolUpgradeBanner />}
      <Group orientation="horizontal" style={{ height: '100%' }}>
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
