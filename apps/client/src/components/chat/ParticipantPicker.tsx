import { useState, useEffect, useRef, useMemo } from 'react';
import { api } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { tokens } from '../../tokens';
import type { ChatRoomDetail } from '../../types';

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

// ─── Participant type for picker ──────────────────────────────────────────────

export interface PickerParticipant {
  id: string;
  name: string;
  type: 'user' | 'agent';
}

// ─── NewChatModal ─────────────────────────────────────────────────────────────

export interface NewChatModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (room: ChatRoomDetail | null) => void;
  /** If provided, modal is in "Add People" mode */
  addToRoomId?: string;
  /** Participants already in the room (excluded from picker) */
  existingParticipantIds?: string[];
}

export default function NewChatModal({ open, onClose, onCreated, addToRoomId, existingParticipantIds = [] }: NewChatModalProps) {
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
