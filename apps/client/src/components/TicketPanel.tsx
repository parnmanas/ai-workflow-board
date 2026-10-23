import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Ticket, TicketCard, TicketStatus } from '../types';
import { api, getActiveAccountId } from '../api';
import { tokens } from '../tokens';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { useNotifications } from '../contexts/NotificationContext';
import { triggerReasonLabel } from '../tickets/status';
import TicketPanelHeader from './ticketPanel/TicketPanelHeader';
import TicketOverview from './ticketPanel/TicketOverview';
import TicketConversation from './ticketPanel/TicketConversation';
import TicketActivityLog from './ticketPanel/TicketActivityLog';
import MediaLightbox from './common/MediaLightbox';
import { TitleField } from './ticketPanel/TextFields';
import { panelButton } from './ticketPanel/panelStyles';
import { computeDirtyTicketFields, draftFromTicket, settleSavedDraft, type TicketDraft } from './ticketPanel/ticketDraft';

export interface TicketPanelProps {
  ticket: Ticket;
  /** Root tickets of the loaded account pool — pickers and tag suggestions. */
  accountTickets?: TicketCard[];
  accountId?: string;
  onClose: () => void;
  /** Status change (PATCH /tickets/:id/move). */
  onMove?: (ticketId: string, status: TicketStatus) => void | Promise<void>;
  /** Asks to delete (the page confirms, and closes the panel when it was this ticket). */
  onDelete: (id: string) => void;
  onCreateChild: (parentId: string, data: { title: string; description?: string; tags?: string[] }) => void;
  onDeleteChild: (childId: string) => void;
  onReparentChild?: (parentId: string, childId: string) => void;
  /** Commits the buffered edits (one PATCH). MUST reject on failure so the edits stay. */
  onSaveDraft: (ticketId: string, ticketFields: Record<string, any>) => Promise<void>;
  /** Resolves once the comment is stored; rejects on failure (the composer keeps the text). */
  onAddComment: (
    ticketId: string,
    content: string,
    attachments?: undefined,
    options?: { type?: string; parent_id?: string | null; attachment_resource_ids?: string[] },
  ) => void | Promise<void>;
  onSetCommentStatus?: (ticketId: string, commentId: string, status: 'open' | 'resolved') => void;
  onSelectTicket?: (id: string) => void;
  /** Mention deep link — opens the conversation and highlights this comment. */
  scrollToCommentId?: string | null;
  onScrollToCommentConsumed?: () => void;
}

type Tab = 'overview' | 'conversation' | 'activity';

function findInTree(root: Ticket, id: string): Ticket | null {
  if (root.id === id) return root;
  for (const child of root.children || []) {
    const found = findInTree(child, id);
    if (found) return found;
  }
  return null;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Ticket detail (docs/tickets.md). A compact title stays put; the body is one of
 * three tabs — 개요 (everything editable, buffered behind Save), 대화 (comments)
 * and 기록 (activity). Subtasks open in place with a back button.
 */
export default function TicketPanel({
  ticket, accountTickets, accountId,
  onClose, onMove, onDelete, onCreateChild, onDeleteChild, onReparentChild, onSaveDraft,
  onAddComment, onSetCommentStatus, onSelectTicket, scrollToCommentId, onScrollToCommentConsumed,
}: TicketPanelProps) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const { markRead: markBadgeRead } = useNotifications();

  // Subtasks open inside the panel; the stack resets with the root ticket.
  const [navStack, setNavStack] = useState<string[]>([ticket.id]);
  useEffect(() => { setNavStack([ticket.id]); }, [ticket.id]);
  const active = findInTree(ticket, navStack[navStack.length - 1]) || ticket;
  const isRoot = !active.parent_id;
  // The ticket's own owning account wins — the page may list several accounts.
  const resolvedAccountId = active.account_id || accountId || getActiveAccountId() || '';

  const [tab, setTab] = useState<Tab>(scrollToCommentId ? 'conversation' : 'overview');
  useEffect(() => { if (scrollToCommentId) setTab('conversation'); }, [scrollToCommentId]);

  // ── Buffered edits ─────────────────────────────────────────────────
  // Reset only when another ticket opens: a remote update must never wipe
  // what the user is typing.
  const [draft, setDraft] = useState<TicketDraft>(() => draftFromTicket(active));
  const [parkRequested, setParkRequested] = useState(false);
  useEffect(() => {
    setDraft(draftFromTicket(active));
    setParkRequested(false);
    if (!scrollToCommentId) setTab('overview');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id]);
  const dirtyFields = computeDirtyTicketFields(draft, active);
  const isDirty = Object.keys(dirtyFields).length > 0;
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    if (saving || !isDirty) return;
    const committed = draft;
    setSaving(true);
    try {
      await onSaveDraft(active.id, dirtyFields);
      // Edits typed while the save was in flight survive.
      setDraft(cur => settleSavedDraft(cur, committed));
      showToast('저장했습니다', 'success');
    } catch (e: any) {
      showToast(`저장하지 못했습니다: ${e?.message || 'unknown error'}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [saving, isDirty, draft, onSaveDraft, active.id, dirtyFields, showToast]);

  const confirmingClose = useRef(false);
  const requestClose = useCallback(async () => {
    if (isDirty) {
      if (confirmingClose.current) return;
      confirmingClose.current = true;
      const ok = await confirm({ title: '변경 버리기', message: '저장하지 않은 수정 내용을 버릴까요?', confirmLabel: '버리기' });
      confirmingClose.current = false;
      if (!ok) return;
    }
    onClose();
  }, [isDirty, confirm, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) void requestClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose]);

  // ── Immediate actions (keyed by ticket id: the panel is reused) ────
  const [statusPending, setStatusPending] = useState<{ id: string; status: TicketStatus } | null>(null);
  const pendingStatus = statusPending?.id === active.id ? statusPending.status : null;
  const move = useCallback(async (id: string, status: TicketStatus) => {
    try {
      await Promise.resolve(onMove ? onMove(id, status) : api.moveTicket(id, status));
    } catch (e: any) {
      showToast(`상태를 바꾸지 못했습니다: ${e?.message || 'unknown error'}`, 'error');
    }
  }, [onMove, showToast]);
  const changeStatus = useCallback(async (status: TicketStatus) => {
    const id = active.id;
    if (status === active.status || pendingStatus) return;
    setStatusPending({ id, status });
    try { await move(id, status); } finally { setStatusPending(cur => (cur?.id === id ? null : cur)); }
  }, [active.id, active.status, pendingStatus, move]);

  const [runningId, setRunningId] = useState<string | null>(null);
  const [runRefusal, setRunRefusal] = useState<{ id: string; reason: string } | null>(null);
  const run = useCallback(async () => {
    const id = active.id;
    if (runningId === id) return;
    setRunningId(id);
    setRunRefusal(null);
    try {
      const res = await api.triggerTicket(id);
      if (res?.dispatched) {
        showToast('담당자에게 보냈습니다', 'success');
      } else {
        const reason = triggerReasonLabel(res?.reason);
        setRunRefusal({ id, reason });
        showToast(res?.reason === 'queued' ? reason : `보내지 않았습니다: ${reason}`, 'info');
      }
    } catch (e: any) {
      showToast(`실행하지 못했습니다: ${e?.message || 'unknown error'}`, 'error');
    } finally {
      setRunningId(cur => (cur === id ? null : cur));
    }
  }, [active.id, runningId, showToast]);

  const [archivingId, setArchivingId] = useState<string | null>(null);
  const toggleArchive = useCallback(async () => {
    const id = active.id;
    if (archivingId === id) return;
    const archived = !!active.archived_at;
    setArchivingId(id);
    try {
      if (archived) await api.unarchiveTicket(id);
      else await api.archiveTicket(id);
      showToast(archived ? '보관을 해제했습니다' : '보관했습니다', 'success');
    } catch (e: any) {
      showToast(`${archived ? '보관 해제' : '보관'}하지 못했습니다: ${e?.message || 'unknown error'}`, 'error');
    } finally {
      setArchivingId(cur => (cur === id ? null : cur));
    }
  }, [active.id, active.archived_at, archivingId, showToast]);

  const copyId = useCallback(async () => {
    const ok = await copyText(active.id);
    showToast(ok ? `티켓 ID 를 복사했습니다 (${active.id})` : '복사하지 못했습니다 — 클립보드 권한을 확인하세요', ok ? 'success' : 'error');
  }, [active.id, showToast]);

  // ── Read marker: opening counts as read; leaving records "read up to now".
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  useEffect(() => {
    const id = active.id;
    let cancelled = false;
    api.getTicketReadState(id)
      .then(state => { if (!cancelled) setLastReadAt(state.last_read_at); })
      .catch(() => { if (!cancelled) setLastReadAt(null); });
    markBadgeRead('tickets', id);
    return () => {
      cancelled = true;
      api.markTicketRead(id).catch(() => { /* best-effort */ });
    };
  }, [active.id, markBadgeRead]);

  const [preview, setPreview] = useState<{ src: string; mimetype?: string } | null>(null);
  const onPreview = useCallback((src: string, mimetype?: string) => setPreview({ src, mimetype }), []);

  const commentCount = (active.comments || []).filter(c => c.author_type !== 'system').length;
  const tabs: Array<{ id: Tab; label: string; badge?: string; attention?: boolean }> = [
    { id: 'overview', label: '개요', attention: !!active.pending_user_action },
    { id: 'conversation', label: '대화', badge: commentCount ? `${commentCount}${active.comments_has_more ? '+' : ''}` : undefined },
    { id: 'activity', label: '기록' },
  ];

  return (
    <div style={{
      height: '100%', width: '100%', display: 'flex', flexDirection: 'column', minWidth: 0,
      background: tokens.colors.surface, borderLeft: `1px solid ${tokens.colors.border}`, overflow: 'hidden',
    }}>
      <TicketPanelHeader
        ticket={active}
        title={draft.title}
        isRoot={isRoot}
        canGoBack={navStack.length > 1}
        running={runningId === active.id}
        archiveBusy={archivingId === active.id}
        onBack={() => setNavStack(prev => (prev.length > 1 ? prev.slice(0, -1) : prev))}
        onCopyId={() => void copyId()}
        onRun={() => void run()}
        onPark={() => { setParkRequested(true); setTab('overview'); }}
        onToggleArchive={() => void toggleArchive()}
        onDelete={() => onDelete(active.id)}
        onClose={() => void requestClose()}
        onShowOverview={() => setTab('overview')}
      />

      <div role="tablist" className="awb-ticket-tabs" style={{
        display: 'flex', gap: 2, padding: '0 10px', borderBottom: `1px solid ${tokens.colors.border}`,
        flexShrink: 0, overflowX: 'auto',
      }}>
        {tabs.map(t => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
              padding: '8px 12px', background: 'transparent', border: 'none',
              borderBottom: `2px solid ${tab === t.id ? (t.attention ? tokens.colors.warning : tokens.colors.accent) : 'transparent'}`,
              color: tab === t.id ? tokens.colors.textStrong : (t.attention ? tokens.colors.warningLight : tokens.colors.textSecondary),
              fontSize: '12px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {t.label}
            {t.attention && <span aria-label="확인 필요" style={{ width: 7, height: 7, borderRadius: '50%', background: tokens.colors.warning }} />}
            {t.badge && (
              <span style={{ fontSize: '10px', background: tokens.colors.border, color: tokens.colors.textMuted, borderRadius: 8, padding: '1px 5px' }}>{t.badge}</span>
            )}
          </button>
        ))}
      </div>

      {/* The bottom padding keeps the last control clear of the app-wide
          sound toggle that floats at the bottom-right corner (ToastContext). */}
      <div className="awb-ticket-content" style={{
        flex: 1, minHeight: 0, overflowY: tab === 'conversation' ? 'hidden' : 'auto', overflowX: 'hidden', padding: '14px 14px 60px',
        display: 'flex', flexDirection: 'column',
      }}>
        {tab === 'overview' && (
          <>
            <div style={{ marginBottom: 14 }}>
              <TitleField value={draft.title} onChange={v => setDraft(prev => ({ ...prev, title: v }))} />
            </div>
            <TicketOverview
              ticket={active}
              draft={draft}
              setDraft={setDraft}
              isRoot={isRoot}
              accountId={resolvedAccountId}
              accountTickets={accountTickets}
              savingDraft={saving}
              runNote={runRefusal?.id === active.id ? runRefusal.reason : null}
              pendingStatus={pendingStatus}
              onStatusChange={s => void changeStatus(s)}
              parkRequested={parkRequested}
              onParkDone={() => setParkRequested(false)}
              onAddComment={(id, content) => onAddComment(id, content)}
              onCreateChild={onCreateChild}
              onMoveChild={(id, s) => void move(id, s)}
              onDeleteChild={onDeleteChild}
              onReparentChild={onReparentChild}
              onSelectChild={child => setNavStack(prev => [...prev, child.id])}
              onOpenTicket={onSelectTicket}
              onPreview={onPreview}
            />
          </>
        )}
        {tab === 'conversation' && (
          <TicketConversation
            ticket={active}
            accountId={resolvedAccountId}
            lastReadAt={lastReadAt}
            scrollToCommentId={scrollToCommentId}
            onScrollToCommentConsumed={onScrollToCommentConsumed}
            onAddComment={onAddComment}
            onSetCommentStatus={onSetCommentStatus}
            onPreview={onPreview}
          />
        )}
        {tab === 'activity' && <TicketActivityLog ticketId={active.id} refreshKey={String(active.updated_at)} />}
      </div>

      {isDirty && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, flexShrink: 0,
          // Right padding leaves room for the floating sound toggle.
          padding: '8px 64px 8px 14px', borderTop: `1px solid ${tokens.colors.border}`, background: tokens.colors.surfaceCard,
        }}>
          <span style={{ fontSize: '12px', color: tokens.colors.textMuted, flex: '1 1 auto' }}>저장하지 않은 변경이 있습니다</span>
          <button type="button" onClick={() => setDraft(draftFromTicket(active))} disabled={saving} style={panelButton('plain', saving)}>되돌리기</button>
          <button type="button" onClick={() => void save()} disabled={saving} style={panelButton('primary', saving)}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      )}

      {preview && (
        <MediaLightbox
          items={[{ src: preview.src, kind: preview.mimetype?.startsWith('video/') ? 'video' : 'image', caption: '미리보기' }]}
          index={0}
          onIndexChange={() => {}}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
