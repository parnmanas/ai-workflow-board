import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { ChatMessageTicketAction } from '../../types';

export default function TicketUnpendActionCard({ action }: { action: ChatMessageTicketAction }) {
  const [resolved, setResolved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.getTicket(action.ticket_id)
      .then((ticket) => {
        if (active) setResolved(!ticket?.pending_user_action);
      })
      .catch(() => {
        // A transient status-read failure must not remove the human's ability
        // to invoke the guarded PATCH and let the server decide.
      });
    return () => { active = false; };
  }, [action.ticket_id]);

  async function resume() {
    if (resolved || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await api.updateTicket(action.ticket_id, { pending_user_action: false });
      setResolved(true);
    } catch (e: any) {
      setError(e?.message || 'Failed to resume ticket');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-ticket-unpend-action={action.ticket_id}
      style={{
        width: 'min(460px, 100%)',
        border: `1px solid ${resolved ? `${tokens.colors.success}66` : tokens.colors.border}`,
        borderRadius: tokens.radii.lg,
        background: tokens.colors.surfaceCard,
        padding: 12,
        boxShadow: tokens.shadows.card,
      }}
    >
      <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted, marginBottom: 4 }}>
        Human approval required
      </div>
      <div style={{ fontSize: tokens.typography.fontSizeMd, fontWeight: 700, color: tokens.colors.textPrimary }}>
        {action.title}
      </div>
      <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary, marginTop: 4 }}>
        {resolved ? 'This ticket has been resumed.' : 'Resume this ticket and restart dispatch?'}
      </div>
      <button
        type="button"
        disabled={resolved || submitting}
        onClick={resume}
        style={{
          marginTop: 10,
          border: 0,
          borderRadius: tokens.radii.md,
          padding: '7px 12px',
          background: resolved ? `${tokens.colors.success}22` : tokens.colors.accent,
          color: resolved ? tokens.colors.success : '#fff',
          fontWeight: 700,
          cursor: resolved || submitting ? 'default' : 'pointer',
          opacity: submitting ? 0.7 : 1,
        }}
      >
        {resolved ? '✓ Resumed' : submitting ? 'Resuming…' : '▶ Resume (Unpend)'}
      </button>
      {error && (
        <div role="alert" style={{ marginTop: 6, fontSize: tokens.typography.fontSizeXs, color: tokens.colors.danger }}>
          {error}
        </div>
      )}
    </div>
  );
}
