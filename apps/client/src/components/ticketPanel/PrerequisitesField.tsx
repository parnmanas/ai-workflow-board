import React, { useState } from 'react';
import { tokens } from '../../tokens';
import type { TicketPrerequisiteRow, TicketStatus } from '../../types';
import { ticketStatusLabel } from '../../tickets/status';
import { openPrerequisiteCount } from './ticketDraft';

interface PrerequisitesFieldProps {
  rows: TicketPrerequisiteRow[];
  busy: boolean;
  error: string | null;
  /** Pickable tickets (workspace pool minus self and already-linked). */
  candidates: Array<{ id: string; title: string; status: TicketStatus }>;
  /** Resolves true when the link was added (clears the picker). */
  onAdd(prerequisiteId: string, reason: string): Promise<boolean>;
  onRemove(prerequisiteId: string): void;
  onOpen?: (ticketId: string) => void;
  labelStyle: React.CSSProperties;
}

/**
 * Prerequisites (ticket 48d14fff) — the M:N "blocked-by another ticket" set.
 * Distinct from Next Ticket (forward 1:1 push): this ticket stays parked
 * (pending_on_tickets) until EVERY prerequisite is done, then auto-resumes.
 */
export default function PrerequisitesField({
  rows, busy, error, candidates, onAdd, onRemove, onOpen, labelStyle,
}: PrerequisitesFieldProps) {
  const [pickId, setPickId] = useState('');
  const [reason, setReason] = useState('');
  const open = openPrerequisiteCount(rows);

  const handleAdd = async () => {
    if (!pickId) return;
    if (await onAdd(pickId, reason.trim())) {
      setPickId('');
      setReason('');
    }
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>
        Prerequisites
        {rows.length > 0 && (open > 0 ? ` · ${open} blocking, auto-resumes when all done` : ' · all satisfied')}
      </label>

      {rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {rows.map(row => {
            const p = row.prerequisite;
            const archived = !!p?.archived_at;
            const satisfied = !!p?.is_done && !archived;
            const pill = !p
              ? { label: 'MISSING', bg: tokens.colors.warningBg, fg: tokens.colors.warningLight }
              : archived
                ? { label: 'ARCHIVED', bg: tokens.colors.surface, fg: tokens.colors.textMuted }
                : satisfied
                  ? { label: 'SATISFIED', bg: tokens.colors.successBg, fg: tokens.colors.successLight }
                  : { label: p.status ? ticketStatusLabel(p.status) : 'BLOCKING', bg: tokens.colors.surface, fg: tokens.colors.info };
            return (
              <div key={row.prerequisite_ticket_id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md, padding: '6px 8px',
              }}>
                <span style={{
                  flexShrink: 0, fontSize: '9px', fontWeight: 800, letterSpacing: '0.4px',
                  padding: '1px 6px', borderRadius: tokens.radii.sm, textTransform: 'uppercase',
                  background: pill.bg, color: pill.fg,
                }}>{pill.label}</span>
                <button
                  type="button"
                  onClick={() => onOpen && p && onOpen(p.id)}
                  title={p ? 'Open prerequisite ticket' : undefined}
                  disabled={!p || !onOpen}
                  style={{
                    flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', padding: 0,
                    color: tokens.colors.textStrong, fontSize: '12px', cursor: (p && onOpen) ? 'pointer' : 'default',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >{p ? p.title : `(deleted) ${row.prerequisite_ticket_id}`}</button>
                <button
                  type="button"
                  onClick={() => onRemove(row.prerequisite_ticket_id)}
                  disabled={busy}
                  title="Remove this prerequisite"
                  style={{
                    flexShrink: 0, background: 'transparent', border: 'none', color: tokens.colors.textMuted,
                    fontSize: '14px', cursor: busy ? 'not-allowed' : 'pointer', lineHeight: 1, padding: '0 2px',
                  }}
                >×</button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          value={pickId}
          onChange={e => setPickId(e.target.value)}
          style={{
            flex: 1, minWidth: 0, background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md, padding: '5px 8px', color: tokens.colors.textStrong, fontSize: '12px', cursor: 'pointer',
          }}
        >
          <option value="">— Add a prerequisite ticket —</option>
          {candidates.map(t => (
            <option key={t.id} value={t.id}>{t.title} · {ticketStatusLabel(t.status)}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAdd}
          disabled={busy || !pickId}
          style={{
            flexShrink: 0, background: tokens.colors.accent, color: 'white', border: 'none',
            borderRadius: tokens.radii.md, padding: '5px 12px', fontSize: '12px', fontWeight: 600,
            cursor: (busy || !pickId) ? 'not-allowed' : 'pointer', opacity: (busy || !pickId) ? 0.5 : 1,
          }}
        >Add</button>
      </div>
      {pickId && (
        <input
          type="text"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Optional: why is this a prerequisite?"
          style={{
            width: '100%', marginTop: 6, boxSizing: 'border-box',
            background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
            padding: '5px 8px', color: tokens.colors.textStrong, fontSize: '12px', fontFamily: 'inherit',
          }}
        />
      )}
      {error && <div style={{ marginTop: 6, fontSize: '11px', color: tokens.colors.warningLight }}>{error}</div>}
    </div>
  );
}
