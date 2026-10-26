import { getLocaleTag } from '../../i18n/core';
import { t as translate, getLocale } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DragDropContext, type DropResult } from '@hello-pangea/dnd';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { api } from '../../api';
import type { TicketCreateInput } from '../../api';
import type { Ticket, TicketCard, Account } from '../../types';
import { tokens } from '../../tokens';
import { useToast } from '../../contexts/ToastContext';
import { useLoading } from '../../contexts/LoadingContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useAuth } from '../../contexts/AuthContext';
import { useNotifications } from '../../contexts/NotificationContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useProjects } from '../../projects/useProjects';
import { useHostNames } from '../../runtime/useHostNames';
import { TICKET_STATUSES, isTicketStatus, type TicketStatus } from '../../tickets/status';
import { filtersFromSearch, filtersToSearch, tagFacet, toggleInList, type TicketFilters } from '../../tickets/ticketFilters';
import { assigneeDisplayName, assigneeOptions, type AssigneeOption } from '../../tickets/assignee';
import { computeMovePosition, findTicketInTree, groupByStatus, treeIds } from '../../tickets/kanban';
import { readTicketView, writeTicketView, type TicketView } from '../../tickets/ticketList';
import { sumUnread } from '../ticketUnreadRollup';
import TicketPanel from '../TicketPanel';
import CreateTicketForm from '../CreateTicketForm';
import TicketFilterBar from './TicketFilterBar';
import StatusLane, { LANE_DROPPABLE_PREFIX } from './StatusLane';
import TicketListView from './TicketListView';
import { useTicketsData } from './useTicketsData';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useDragToScroll } from '../../hooks/useDragToScroll';

function storage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/**
 * Tickets — all accessible tickets (docs/tickets.md). Replaces boards:
 * a fixed status lifecycle instead of columns, tags + project instead of "which
 * board", one assignee spec instead of role routing.
 *
 * URL is the state: filters (`q`, `status`, `tags`, `project`, `assignee`,
 * `archived`) make a view shareable, and `?ticket=<id>` opens the detail panel
 * (`&comment=<id>` scrolls to a comment) — closing the panel removes them. The
 * panel fetches the ticket by id, so a deep link opens even when the current
 * filters hide it.
 */
export default function TicketsPage() {
  useLocale();
  const { currentAccountId } = useAuth();
  const accountId = currentAccountId || '';
  const compact = useMediaQuery('(max-width: 1100px)');
  const [searchParams, setSearchParams] = useSearchParams();
  const { showToast } = useToast();
  const { withLoading } = useLoading();
  const confirm = useConfirm();
  const { hasPermission } = useAuth();
  const { counts, markAllTicketsReadLocal } = useNotifications();

  const filters = useMemo(() => filtersFromSearch(searchParams), [searchParams, getLocale()]);
  const openTicketId = searchParams.get('ticket');
  const scrollToCommentId = searchParams.get('comment');

  const [view, setViewState] = useState<TicketView>(() => readTicketView(storage()));
  const setView = useCallback((next: TicketView) => {
    setViewState(next);
    writeTicketView(storage(), next);
  }, []);

  const data = useTicketsData(accountId, filters);
  const { projects } = useProjects(accountId);
  const hostNames = useHostNames();
  const projectNames = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects, getLocale()]);

  // ── Account (dispatch pause banner) ──────────────────────────────
  const [account, setAccount] = useState<Account | null>(null);
  const loadAccount = useCallback(() => {
    if (!accountId) return;
    api.getAccount(accountId).then(setAccount).catch(() => setAccount(null));
  }, [accountId]);
  useEffect(() => { loadAccount(); }, [loadAccount]);

  // ── Filters ⇄ URL ──────────────────────────────────────────────────
  const setFilters = useCallback((next: TicketFilters) => {
    setSearchParams((prev) => filtersToSearch(next, prev), { replace: true });
  }, [setSearchParams]);
  const addTagFilter = useCallback((tag: string) => {
    if (filters.tags.includes(tag)) return;
    setFilters({ ...filters, tags: toggleInList(filters.tags, tag) });
  }, [filters, setFilters]);

  // The assignee facet comes from the loaded rows — but once an assignee is
  // selected the server only returns that assignee's tickets, so keep the
  // options of the last load that was not narrowed by assignee.
  const [assigneeOpts, setAssigneeOpts] = useState<AssigneeOption[]>([]);
  useEffect(() => {
    if (filters.assigneeKey && assigneeOpts.length) return;
    setAssigneeOpts(assigneeOptions(data.tickets, hostNames));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.tickets, hostNames, filters.assigneeKey]);
  useEffect(() => { setAssigneeOpts([]); }, [accountId]);

  const facet = useMemo(
    () => tagFacet(data.tagCounts, data.tickets, filters.tags),
    [data.tagCounts, data.tickets, filters.tags, getLocale()],
  );

  // ── Panel ⇄ `?ticket=` ─────────────────────────────────────────────
  const openTicket = useCallback((id: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('ticket', id);
      next.delete('comment');
      return next;
    });
  }, [setSearchParams]);
  const closeTicket = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('ticket');
      next.delete('comment');
      return next;
    });
  }, [setSearchParams]);
  // setSearchParams (and so closeTicket) changes identity on every URL change;
  // effects that only need "close the panel" read it through a ref.
  const closeTicketRef = useRef(closeTicket);
  closeTicketRef.current = closeTicket;
  const consumeComment = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('comment');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const [panelTicket, setPanelTicket] = useState<Ticket | null>(null);
  const [panelNonce, setPanelNonce] = useState(0);
  const openRow = useMemo(() => findTicketInTree(data.tickets, openTicketId), [data.tickets, openTicketId, getLocale()]);
  // Primitive change signal from the list row so the refetch compares by value.
  const rowSignal = openRow
    ? `${openRow.updated_at}|${(openRow.comments || []).map((c) => `${c.id}:${c.status ?? ''}`).join(',')}`
    : '';
  const panelIdsRef = useRef<Set<string>>(new Set());
  panelIdsRef.current = panelTicket ? treeIds(panelTicket) : new Set(openTicketId ? [openTicketId] : []);
  // Tickets whose fetch already failed for this open — one toast, not one per refresh.
  const panelErrorNotified = useRef<string | null>(null);

  useEffect(() => {
    if (!openTicketId) { setPanelTicket(null); panelErrorNotified.current = null; return; }
    let cancelled = false;
    api.getTicket(openTicketId)
      .then((full) => {
        if (cancelled) return;
        panelErrorNotified.current = null;
        setPanelTicket(full);
      })
      .catch((err: any) => {
        if (cancelled || panelErrorNotified.current === openTicketId) return;
        panelErrorNotified.current = openTicketId;
        showToast(err?.status === 404
          ? translate('링크된 티켓을 찾을 수 없습니다 (삭제되었거나 접근 권한이 없습니다)')
          : translate('티켓을 열 수 없습니다: {0}', { 0: err?.message || translate('네트워크 오류') }), 'error');
        if (err?.status === 404 || err?.status === 403) closeTicketRef.current();
      });
    return () => { cancelled = true; };
  }, [openTicketId, rowSignal, panelNonce, data.changeNonce, showToast]);

  // Live: an SSE change to the open ticket (or one of its sub-tasks) refreshes
  // the panel even when the list row didn't change (e.g. a child comment).
  const panelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useBoardStreamEvent('board_update', (evt: any) => {
    const id = evt?.ticket_id;
    if (!openTicketId || !id || !panelIdsRef.current.has(id)) return;
    if (panelTimer.current) clearTimeout(panelTimer.current);
    panelTimer.current = setTimeout(() => setPanelNonce((n) => n + 1), 300);
  });
  useEffect(() => () => { if (panelTimer.current) clearTimeout(panelTimer.current); }, []);

  const activePanelTicket = panelTicket && panelTicket.id === openTicketId ? panelTicket : null;

  // ── Actions ────────────────────────────────────────────────────────
  const wrapAction = useCallback(async (action: () => Promise<any>, successMsg?: string) => {
    try {
      await withLoading(action);
      if (successMsg) showToast(successMsg, 'success');
    } catch (err: any) {
      showToast(err?.message || translate('Operation failed'), 'error');
    }
  }, [showToast, withLoading]);

  const [createOpen, setCreateOpen] = useState(false);
  const handleCreate = useCallback(async (body: TicketCreateInput) => {
    try {
      const created = await withLoading(() => data.createTicket(body));
      showToast(translate('티켓을 만들었습니다'), 'success');
      setCreateOpen(false);
      if (created?.id) openTicket(created.id);
    } catch (err: any) {
      showToast(err?.message || translate('티켓을 만들지 못했습니다'), 'error');
      throw err;
    }
  }, [data, withLoading, showToast, openTicket]);

  const handleQuickAdd = useCallback(async (title: string, status: TicketStatus) => {
    try {
      await data.createTicket({
        title,
        status,
        ...(filters.projectId ? { project_id: filters.projectId } : {}),
        ...(filters.tags.length ? { tags: filters.tags } : {}),
      });
    } catch (err: any) {
      showToast(err?.message || translate('티켓을 만들지 못했습니다'), 'error');
      throw err;
    }
  }, [data, filters.projectId, filters.tags, showToast]);

  // The panel toasts a failed move itself — just let the rejection through.
  const handleMove = useCallback(
    (ticketId: string, status: TicketStatus) => data.moveTicket(ticketId, status),
    [data],
  );

  const handleDelete = useCallback(async (ticketId: string) => {
    const ok = await confirm({
      title: translate('Delete ticket'),
      message: translate('Delete this ticket? This also removes its subtasks and comments. This cannot be undone.'),
    });
    if (!ok) return;
    // Close first: the post-delete refresh would otherwise refetch the open
    // ticket and report the (expected) 404 as an error.
    if (ticketId === openTicketId) closeTicket();
    await wrapAction(() => data.deleteTicket(ticketId), translate('Ticket deleted'));
  }, [confirm, wrapAction, data, closeTicket, openTicketId]);

  const handleDeleteChild = useCallback(async (childId: string) => {
    const ok = await confirm({ title: translate('Delete subtask'), message: translate('Delete this subtask? This cannot be undone.') });
    if (!ok) return;
    await wrapAction(() => data.deleteTicket(childId), translate('Subtask deleted'));
  }, [confirm, wrapAction, data]);

  const handleMarkAllRead = useCallback(() => wrapAction(async () => {
    await api.markAllTicketsRead();
    markAllTicketsReadLocal();
  }, translate('읽지 않은 티켓 코멘트를 모두 읽음으로 표시했습니다')), [wrapAction, markAllTicketsReadLocal]);

  const canAdmin = hasPermission('admin.access');
  const handleResumeDispatch = useCallback(() => wrapAction(async () => {
    await api.updateAccount(accountId, { dispatch_paused_at: null });
    loadAccount();
  }, translate('티켓 디스패치를 재개했습니다')), [wrapAction, accountId, loadAccount]);

  // ── Kanban drag & drop ─────────────────────────────────────────────
  const lanes = useMemo(() => groupByStatus(data.tickets), [data.tickets, getLocale()]);
  const visibleStatuses = filters.statuses.length ? filters.statuses : [...TICKET_STATUSES];

  const handleDragEnd = useCallback(async (result: DropResult) => {
    const { source, destination, draggableId } = result;
    if (!destination) return;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;
    const ticketId = draggableId.replace(/^ticket-/, '');

    if (!destination.droppableId.startsWith(LANE_DROPPABLE_PREFIX)) return;
    const status = destination.droppableId.slice(LANE_DROPPABLE_PREFIX.length);
    if (!isTicketStatus(status)) return;
    if (filters.archived) {
      showToast(translate('보관된 티켓은 이동할 수 없습니다 — 먼저 보관을 해제하세요'), 'error');
      return;
    }
    const moved = data.tickets.find((t) => t.id === ticketId);
    if (!moved) return;
    const position = computeMovePosition(lanes[status], moved, status, destination.index);
    try {
      await data.moveTicket(ticketId, status, position);
    } catch (err: any) {
      showToast(err?.message || translate('Failed to move ticket'), 'error');
    }
  }, [data, lanes, filters.archived, showToast]);

  // ── Render helpers ─────────────────────────────────────────────────
  const unreadFor = useCallback((t: TicketCard) => sumUnread(t, counts.tickets.perTicket), [counts.tickets.perTicket]);
  const assigneeLabelFor = useCallback((t: TicketCard) => assigneeDisplayName(t.assignee, hostNames), [hostNames]);
  const projectNameFor = useCallback((t: TicketCard) => (t.project_id ? projectNames[t.project_id] || '' : ''), [projectNames]);
  const kanbanScrollRef = useDragToScroll<HTMLDivElement>({ axis: 'x' });

  const body = data.loading && data.tickets.length === 0 ? (
    <div style={{ padding: 24, color: tokens.colors.textMuted, fontSize: 13 }}>{translate('Loading tickets…')}</div>
  ) : data.error && data.tickets.length === 0 ? (
    <div role="alert" style={{ padding: 24, color: tokens.colors.danger, fontSize: 13 }}>
      {data.error}{' '}
      <button type="button" onClick={() => void data.refresh()} style={{ marginLeft: 8, background: 'none', border: 'none', color: tokens.colors.accent, cursor: 'pointer' }}>{translate('다시 시도')}</button>
    </div>
  ) : view === 'kanban' ? (
    <div
      ref={kanbanScrollRef}
      data-testid="tickets-kanban"
      style={{ display: 'flex', gap: 12, padding: 16, height: '100%', boxSizing: 'border-box', overflowX: 'auto', alignItems: 'stretch', cursor: 'grab' }}
    >
      {visibleStatuses.map((s) => (
        <StatusLane
          key={s}
          status={s}
          tickets={lanes[s]}
          onTicketClick={(t) => openTicket(t.id)}
          onQuickAdd={filters.archived ? undefined : handleQuickAdd}
          unreadFor={unreadFor}
          assigneeLabelFor={assigneeLabelFor}
          projectNameFor={projectNameFor}
          onTagClick={addTagFilter}
        />
      ))}
    </div>
  ) : (
    <TicketListView
      tickets={data.tickets.filter((t) => !t.parent_id)}
      activeTicketId={openTicketId}
      onOpen={(t) => openTicket(t.id)}
      unreadFor={unreadFor}
      assigneeLabelFor={assigneeLabelFor}
      projectNames={projectNames}
      hostNames={hostNames}
      onTagClick={addTagFilter}
    />
  );

  const panel = openTicketId ? (
    activePanelTicket ? (
      <TicketPanel
        ticket={activePanelTicket}
        accountTickets={data.tickets}
        accountId={accountId}
        onClose={closeTicket}
        onMove={handleMove}
        onDelete={(id) => { void handleDelete(id); }}
        onCreateChild={(parentId, childData) => { void wrapAction(() => data.createChildTicket(parentId, childData), translate('하위 작업을 추가했습니다')); }}
        onDeleteChild={(childId) => { void handleDeleteChild(childId); }}
        onReparentChild={(parentId, childId) => { void wrapAction(() => data.reparentTicket(childId, parentId), translate('하위 작업으로 연결했습니다')); }}
        // Must reject on failure — the panel keeps its edits visible.
        onSaveDraft={async (ticketId, fields) => {
          if (Object.keys(fields).length === 0) return;
          const updated = await withLoading(() => data.updateTicket(ticketId, fields));
          // PATCH returns the full ticket — adopt it before resolving so the
          // panel never flashes the pre-save values after dropping its draft.
          if (updated && (updated as Ticket).id === openTicketId) setPanelTicket(updated as Ticket);
        }}
        // Rejects on failure — the composer keeps the text and the files.
        onAddComment={async (ticketId, content, _attachments, options) => {
          await withLoading(() => data.addComment(ticketId, content, [], options));
        }}
        onSetCommentStatus={(ticketId, commentId, status) => {
          void wrapAction(() => data.setCommentStatus(ticketId, commentId, status), status === 'resolved' ? translate('질문을 해결로 표시했습니다') : translate('질문을 다시 열었습니다'));
        }}
        onSelectTicket={openTicket}
        scrollToCommentId={scrollToCommentId}
        onScrollToCommentConsumed={consumeComment}
      />
    ) : (
      <div style={{ padding: 24, color: tokens.colors.textMuted, fontSize: 13, background: tokens.colors.surface, height: '100%' }}>
        {translate('티켓을 불러오는 중…')}<button type="button" onClick={closeTicket} style={{ marginLeft: 12, background: 'none', border: 'none', color: tokens.colors.accent, cursor: 'pointer' }}>{translate('닫기')}</button>
      </div>
    )
  ) : null;

  const rootCount = data.tickets.length;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, visibility: compact && panel ? 'hidden' : undefined }}>
      {account?.dispatch_paused_at && (
        <div
          role="status"
          data-testid="dispatch-paused-banner"
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
            background: tokens.colors.warningBg, color: tokens.colors.warningLight,
            fontSize: 13, borderBottom: `1px solid ${tokens.colors.warning}`,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 16 }}>⏸</span>
          <span style={{ flex: 1 }}>
            <strong>{account.name}{translate('의 티켓 디스패치가 일시정지되어 있습니다')}</strong> ({new Date(account.dispatch_paused_at).toLocaleString(getLocaleTag())} {translate('부터). 이 소유 계정의 새 작업이 에이전트에게 전달되지 않습니다 — 편집·코멘트·이동은 그대로 가능합니다.')}</span>
          {canAdmin && (
            <button
              type="button"
              onClick={() => void handleResumeDispatch()}
              style={{
                background: 'transparent', border: `1px solid ${tokens.colors.warning}`, borderRadius: tokens.radii.sm,
                color: tokens.colors.warningLight, fontSize: 12, fontWeight: 600, padding: '3px 10px', cursor: 'pointer',
              }}
            >{translate('재개')}</button>
          )}
        </div>
      )}

      <TicketFilterBar
        filters={filters}
        onChange={setFilters}
        tagFacet={facet}
        projects={projects}
        assigneeOptions={assigneeOpts}
        view={view}
        onViewChange={setView}
        ticketCount={rootCount}
        unreadCount={counts.tickets.total}
        onCreate={() => setCreateOpen(true)}
        onMarkAllRead={() => void handleMarkAllRead()}
      />

      {/* One DragDropContext around lanes + panel (the list view has no
          draggables; the context is harmless there). */}
      <DragDropContext onDragEnd={(r) => { void handleDragEnd(r); }}>
        {panel && !compact ? (
          <Group orientation="horizontal" style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
            <Panel minSize="35">
              <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>{body}</div>
            </Panel>
            <Separator style={{ width: 4, background: tokens.colors.border, cursor: 'col-resize', flexShrink: 0 }} />
            <Panel defaultSize="45" minSize="30" maxSize="65" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {panel}
            </Panel>
          </Group>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{body}</div>
        )}
      </DragDropContext>
      </div>
      {compact && panel && (
        <div className="awb-ticket-detail" role="region" aria-label={translate('Ticket detail')} style={{ position: 'absolute', inset: 0, minWidth: 0, overflow: 'hidden', background: tokens.colors.surface }}>
          {panel}
        </div>
      )}

      <CreateTicketForm
        isOpen={createOpen}
        accountId={accountId}
        projects={projects}
        knownTags={data.tagCounts}
        initialProjectId={filters.projectId || undefined}
        initialStatus={filters.statuses.length === 1 ? filters.statuses[0] : undefined}
        onSubmit={handleCreate}
        onCancel={() => setCreateOpen(false)}
      />
    </div>
  );
}
