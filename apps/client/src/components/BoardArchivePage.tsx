import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { useBoard } from '../hooks/useBoard';
import { useToast } from '../contexts/ToastContext';
import { tokens } from '../tokens';
import PageHeader from './PageHeader';
import { Button, Input } from './common';

/**
 * Board-scoped archive view. Lists tickets where `archived_at IS NOT NULL`
 * via GET /api/boards/:id/archived-tickets, supports incremental cursor
 * pagination + title/id search, and exposes per-row Unarchive + View detail
 * actions. Bulk actions are intentionally out-of-scope for the first cut.
 */

interface ArchivedTicket {
  id: string;
  title: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string[];
  archived_at: string;
  terminal_entered_at: string | null;
  column_id: string | null;
  column_name: string;
  description: string;
}

const PAGE_SIZE = 50;

export default function BoardArchivePage() {
  const { wsId, boardId } = useParams<{ wsId: string; boardId: string }>();
  const { showToast } = useToast();
  const { board } = useBoard(boardId ?? '');

  const [tickets, setTickets] = useState<ArchivedTicket[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState<string>('');
  const [appliedQ, setAppliedQ] = useState<string>('');
  const [detail, setDetail] = useState<ArchivedTicket | null>(null);

  const loadInitial = useCallback(async (q?: string) => {
    if (!boardId) return;
    setLoading(true);
    try {
      const res = await api.listArchivedTickets(boardId, { limit: PAGE_SIZE, q: q || undefined });
      setTickets(res.tickets as ArchivedTicket[]);
      setNextCursor(res.next_cursor);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load archived tickets', 'error');
    } finally {
      setLoading(false);
    }
  }, [boardId, showToast]);

  const loadMore = useCallback(async () => {
    if (!boardId || !nextCursor) return;
    setLoading(true);
    try {
      const res = await api.listArchivedTickets(boardId, {
        limit: PAGE_SIZE,
        cursor: nextCursor,
        q: appliedQ || undefined,
      });
      setTickets((prev) => [...prev, ...(res.tickets as ArchivedTicket[])]);
      setNextCursor(res.next_cursor);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load more', 'error');
    } finally {
      setLoading(false);
    }
  }, [boardId, nextCursor, appliedQ, showToast]);

  useEffect(() => {
    loadInitial('');
  }, [loadInitial]);

  const onSearch = useCallback(() => {
    const q = search.trim();
    setAppliedQ(q);
    loadInitial(q);
  }, [search, loadInitial]);

  const onUnarchive = useCallback(async (id: string) => {
    try {
      await api.unarchiveTicket(id);
      setTickets((prev) => prev.filter((t) => t.id !== id));
      setDetail((cur) => (cur && cur.id === id ? null : cur));
      showToast('Ticket restored', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Failed to unarchive', 'error');
    }
  }, [showToast]);

  const formatDate = (iso: string | null) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const headerActionStyle: React.CSSProperties = useMemo(() => ({
    padding: '6px 12px',
    background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    color: tokens.colors.textStrong,
    fontSize: 12,
    textDecoration: 'none',
  }), []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Archive"
        description={board?.name}
        actions={
          wsId && boardId ? (
            <a href={`/ws/${wsId}/boards/${boardId}`} style={headerActionStyle}>← Back to Board</a>
          ) : null
        }
      />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24 }}>
        <section
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
            marginBottom: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 240 }}>
            <Input
              label="Search by title or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSearch(); }}
              placeholder="title fragment or full ticket id"
            />
          </div>
          <Button variant="primary" size="sm" onClick={onSearch} disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </Button>
          {appliedQ && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { setSearch(''); setAppliedQ(''); loadInitial(''); }}
            >Clear</Button>
          )}
        </section>

        {tickets.length === 0 && !loading && (
          <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: 24, textAlign: 'center' }}>
            {appliedQ
              ? `No archived tickets match "${appliedQ}".`
              : 'No archived tickets on this board yet.'}
          </div>
        )}

        {tickets.length > 0 && (
          <div
            style={{
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              overflow: 'hidden',
              background: tokens.colors.surfaceCard,
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr auto', gap: 8, padding: '8px 12px', background: tokens.colors.surface, fontSize: 11, fontWeight: 600, color: tokens.colors.textMuted, textTransform: 'uppercase' }}>
              <div>Title</div>
              <div>Original column</div>
              <div>Archived</div>
              <div>Priority</div>
              <div>Assignee</div>
              <div style={{ textAlign: 'right' }}>Actions</div>
            </div>
            {tickets.map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr auto',
                  gap: 8,
                  padding: '10px 12px',
                  borderTop: `1px solid ${tokens.colors.border}`,
                  fontSize: 13,
                  alignItems: 'center',
                }}
              >
                <div style={{ color: tokens.colors.textStrong, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <div style={{ fontWeight: 600 }}>{t.title}</div>
                  <div style={{ fontSize: 11, color: tokens.colors.textMuted, fontFamily: 'monospace' }}>{t.id.slice(0, 8)}</div>
                </div>
                <div style={{ color: tokens.colors.textSecondary }}>{t.column_name || '—'}</div>
                <div style={{ color: tokens.colors.textSecondary }}>{formatDate(t.archived_at)}</div>
                <div style={{ color: tokens.colors.textSecondary }}>{t.priority}</div>
                <div style={{ color: tokens.colors.textSecondary }}>{t.assignee || '—'}</div>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <Button variant="secondary" size="sm" onClick={() => setDetail(t)}>View</Button>
                  <Button variant="primary" size="sm" onClick={() => onUnarchive(t.id)}>Unarchive</Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {nextCursor && (
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
            <Button variant="secondary" size="sm" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </div>

      {detail && (
        <ArchivedTicketDetailModal
          ticket={detail}
          onClose={() => setDetail(null)}
          onUnarchive={() => onUnarchive(detail.id)}
        />
      )}
    </div>
  );
}

interface DetailProps {
  ticket: ArchivedTicket;
  onClose: () => void;
  onUnarchive: () => void;
}

interface ArchiveComment {
  id: string;
  author: string;
  author_type: string;
  content: string;
  created_at: string;
  type?: string;
}

function ArchivedTicketDetailModal({ ticket, onClose, onUnarchive }: DetailProps) {
  const [comments, setComments] = useState<ArchiveComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCommentsLoading(true);
    setCommentsError(null);
    api.getTicket(ticket.id)
      .then((full: any) => {
        if (cancelled) return;
        const list = Array.isArray(full?.comments) ? full.comments : [];
        // loadTicketFull returns newest-first; display oldest-first for
        // chronological context (matches the main ticket detail panel).
        const ordered = [...list].sort((a: any, b: any) => {
          const ta = new Date(a.created_at).getTime();
          const tb = new Date(b.created_at).getTime();
          return ta - tb;
        });
        setComments(ordered);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setCommentsError(err?.message || 'Failed to load comments');
      })
      .finally(() => {
        if (!cancelled) setCommentsLoading(false);
      });
    return () => { cancelled = true; };
  }, [ticket.id]);

  const formatCommentTime = (iso: string) => {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 92vw)',
          maxHeight: '85vh',
          overflow: 'auto',
          background: tokens.colors.surfaceCard,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.lg,
          padding: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary }}>{ticket.title}</div>
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, fontFamily: 'monospace', marginTop: 4 }}>{ticket.id}</div>
          </div>
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>

        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
          <Field label="Original column" value={ticket.column_name || '—'} />
          <Field label="Archived at" value={new Date(ticket.archived_at).toLocaleString()} />
          <Field label="Priority" value={ticket.priority} />
          <Field label="Assignee" value={ticket.assignee || '—'} />
          <Field label="Reporter" value={ticket.reporter || '—'} />
          <Field label="Labels" value={ticket.labels?.length > 0 ? ticket.labels.join(', ') : '—'} />
        </div>

        {ticket.description && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>Description</div>
            <pre style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'inherit',
              fontSize: 13,
              color: tokens.colors.textStrong,
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: 12,
              margin: 0,
              maxHeight: 320,
              overflow: 'auto',
            }}>{ticket.description}</pre>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>
            Comments {!commentsLoading && comments.length > 0 ? `(${comments.length})` : ''}
          </div>
          {commentsLoading && (
            <div style={{ fontSize: 13, color: tokens.colors.textMuted }}>Loading…</div>
          )}
          {!commentsLoading && commentsError && (
            <div style={{ fontSize: 13, color: tokens.colors.danger }}>{commentsError}</div>
          )}
          {!commentsLoading && !commentsError && comments.length === 0 && (
            <div style={{ fontSize: 13, color: tokens.colors.textMuted }}>No comments.</div>
          )}
          {!commentsLoading && !commentsError && comments.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: 12,
                maxHeight: 320,
                overflow: 'auto',
              }}
            >
              {comments.map((c) => (
                <div
                  key={c.id}
                  style={{
                    fontSize: 13,
                    color: tokens.colors.textStrong,
                    paddingBottom: 8,
                    borderBottom: `1px solid ${tokens.colors.border}`,
                  }}
                >
                  <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 2 }}>
                    <strong style={{ color: tokens.colors.textSecondary }}>{c.author || (c.author_type === 'agent' ? 'Agent' : 'User')}</strong>
                    {' · '}{formatCommentTime(c.created_at)}
                    {c.type && c.type !== 'note' ? ` · ${c.type}` : ''}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.content}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="primary" size="sm" onClick={onUnarchive}>Unarchive</Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
      <div style={{ color: tokens.colors.textStrong, marginTop: 2 }}>{value}</div>
    </div>
  );
}
