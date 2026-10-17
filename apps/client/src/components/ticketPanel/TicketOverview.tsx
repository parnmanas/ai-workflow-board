import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Action, Ticket, TicketCard, TicketPrerequisiteRow, TicketStatus } from '../../types';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { TICKET_PRIORITIES, TICKET_PRIORITY_LABELS, TICKET_STATUSES, ticketStatusColor, ticketStatusLabel } from '../../tickets/status';
import { useProjects } from '../../projects/useProjects';
import { useTicketTags } from '../../tickets/useTicketTags';
import { mergeTagSuggestions } from '../../tickets/tagInput';
import type { RuntimeSpecDraft } from '../../runtime/runtimeSpec';
import TagInput from '../common/TagInput';
import ChildTicketList from '../SubtaskList';
import ProjectBranchFields from './ProjectBranchFields';
import AssigneeSection from './AssigneeSection';
import OnDoneActionsField from './OnDoneActionsField';
import PrerequisitesField from './PrerequisitesField';
import TicketAttachmentsSection from './TicketAttachmentsSection';
import PendingNotice from './PendingNotice';
import { DescriptionField } from './TextFields';
import { collectTagPool, effectiveAssignee, effectiveTags, runtimeSpecEqual, type TicketDraft } from './ticketDraft';
import { controlStyle, fieldGrid, fieldLabel, section, wrapText } from './panelStyles';

const PRIORITY_COLORS: Record<string, string> = {
  // tag/label palette — not tokenized
  low: '#94a3b8', medium: '#60a5fa', high: '#fbbf24', critical: '#ef4444',
};

export interface TicketOverviewProps {
  ticket: Ticket;
  draft: TicketDraft;
  setDraft: React.Dispatch<React.SetStateAction<TicketDraft>>;
  isRoot: boolean;
  accountId: string;
  accountTickets?: TicketCard[];
  savingDraft: boolean;
  /** Why the last "실행" did not dispatch — shown under the assignee. */
  runNote: string | null;
  /** Status picked but not confirmed by the server yet. */
  pendingStatus: TicketStatus | null;
  onStatusChange(status: TicketStatus): void;
  parkRequested: boolean;
  onParkDone(): void;
  onAddComment(ticketId: string, content: string): void | Promise<void>;
  onCreateChild(parentId: string, data: { title: string; description?: string; tags?: string[] }): void;
  onMoveChild(childId: string, status: TicketStatus): void;
  onDeleteChild(childId: string): void;
  onReparentChild?(parentId: string, childId: string): void;
  onSelectChild(child: Ticket): void;
  onOpenTicket?(id: string): void;
  onPreview(src: string, mimetype?: string): void;
}

/** Prerequisite links: seeded from the ticket, then read fresh (the list endpoint is authoritative). */
function usePrerequisites(ticket: Ticket) {
  const [rows, setRows] = useState<TicketPrerequisiteRow[]>(ticket.prerequisites || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(ticket.prerequisites || []);
    setError(null);
    let cancelled = false;
    api.listPrerequisites(ticket.id)
      .then(res => { if (!cancelled) setRows(res?.prerequisites || []); })
      .catch(() => { /* keep the seeded list */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id, ticket.updated_at]);

  const change = useCallback(async (work: () => Promise<{ prerequisites?: TicketPrerequisiteRow[] }>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await work();
      setRows(updated?.prerequisites || []);
      return true;
    } catch (e: any) {
      setError(e?.message || failure);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const add = useCallback((id: string, reason: string) =>
    change(() => api.addPrerequisites(ticket.id, [id], reason || undefined), '선행 티켓을 추가하지 못했습니다'), [change, ticket.id]);
  const remove = useCallback(async (id: string) => {
    await change(() => api.removePrerequisite(ticket.id, id), '선행 티켓을 빼지 못했습니다');
  }, [change, ticket.id]);

  return { rows, busy, error, add, remove };
}

function useAccountActions(accountId: string) {
  const [actions, setActions] = useState<Action[]>([]);
  useEffect(() => {
    if (!accountId) { setActions([]); return; }
    let cancelled = false;
    api.listActions(accountId)
      .then(rows => { if (!cancelled) setActions(rows || []); })
      .catch(() => { if (!cancelled) setActions([]); });
    return () => { cancelled = true; };
  }, [accountId]);
  return actions;
}

export default function TicketOverview(props: TicketOverviewProps) {
  const {
    ticket, draft, setDraft, isRoot, accountId, accountTickets, savingDraft, runNote,
    pendingStatus, onStatusChange, parkRequested, onParkDone, onAddComment,
    onCreateChild, onMoveChild, onDeleteChild, onReparentChild, onSelectChild, onOpenTicket, onPreview,
  } = props;
  const setField = <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) =>
    setDraft(prev => ({ ...prev, [key]: value }));

  const { projects, loading: projectsLoading } = useProjects(accountId || null);
  // Until the account list loads, the full ticket's own project summary (it
  // carries host_folders) still lets the assignee editor prefill a folder.
  const draftProject = useMemo(
    () => projects.find(p => p.id === draft.projectId)
      || (ticket.project && ticket.project.id === draft.projectId ? ticket.project : null),
    [projects, draft.projectId, ticket.project],
  );
  const accountTags = useTicketTags(accountId || null);
  const tagPool = useMemo(
    () => mergeTagSuggestions(collectTagPool(accountTickets), accountTags),
    [accountTickets, accountTags],
  );
  const prerequisites = usePrerequisites(ticket);
  const actions = useAccountActions(accountId);
  const status = pendingStatus ?? ticket.status;

  const otherTickets = (accountTickets || []).filter(t => t.id !== ticket.id);
  const linksInUse = prerequisites.rows.length > 0 || !!draft.nextTicketId || draft.onDoneActionIds.length > 0;

  return (
    <div style={{ minWidth: 0 }}>
      <PendingNotice
        ticket={ticket}
        prerequisites={prerequisites.rows}
        parkRequested={parkRequested}
        onParkDone={onParkDone}
        onAddComment={onAddComment}
      />

      <div style={{ ...fieldGrid, ...section }}>
        <div>
          <label style={fieldLabel}>상태{pendingStatus ? ' · 옮기는 중' : ''}</label>
          <select
            value={status}
            disabled={!!pendingStatus}
            onChange={e => onStatusChange(e.target.value as TicketStatus)}
            style={{
              ...controlStyle, fontWeight: 600, color: ticketStatusColor(status),
              border: `1px solid ${ticketStatusColor(status)}`, cursor: pendingStatus ? 'not-allowed' : 'pointer',
            }}
          >
            {TICKET_STATUSES.map(s => <option key={s} value={s}>{ticketStatusLabel(s)}</option>)}
          </select>
        </div>
        <div>
          <label style={fieldLabel}>우선순위</label>
          <select
            value={draft.priority}
            onChange={e => setField('priority', e.target.value as TicketDraft['priority'])}
            style={{
              ...controlStyle, fontWeight: 600, color: PRIORITY_COLORS[draft.priority],
              border: `1px solid ${PRIORITY_COLORS[draft.priority]}`, cursor: 'pointer',
            }}
          >
            {TICKET_PRIORITIES.map(p => <option key={p} value={p}>{TICKET_PRIORITY_LABELS[p]}</option>)}
          </select>
        </div>
      </div>

      {/* Project / branch / assignee belong to root tickets: children are a
          checklist the parent's assignee works through in the same checkout. */}
      {isRoot ? (
        <>
          <ProjectBranchFields
            projects={projects}
            projectsLoading={projectsLoading}
            projectId={draft.projectId}
            baseBranch={draft.baseBranch}
            savedProject={ticket.project}
            onProjectChange={id => setDraft(prev => ({ ...prev, projectId: id, baseBranch: '' }))}
            onBranchChange={b => setField('baseBranch', b)}
            labelStyle={fieldLabel}
          />
          <div style={section}>
            <AssigneeSection
              key={`assignee-${ticket.id}`}
              assignee={effectiveAssignee(draft, ticket)}
              unsaved={!!draft.assignee && !runtimeSpecEqual(draft.assignee.value, ticket.assignee)}
              project={draftProject}
              accountId={accountId}
              disabled={savingDraft}
              onChange={(next: RuntimeSpecDraft | null) => setField('assignee', { value: next })}
              runNote={runNote}
              labelStyle={fieldLabel}
            />
          </div>
        </>
      ) : (
        <div style={section}>
          <span style={fieldLabel}>담당</span>
          <div style={{ fontSize: '12px', color: tokens.colors.textMuted }}>상위 티켓의 담당자가 함께 처리합니다</div>
        </div>
      )}

      <div style={section}>
        <span style={fieldLabel}>태그</span>
        <TagInput
          key={`tags-${ticket.id}`}
          value={effectiveTags(draft, ticket)}
          suggestions={tagPool}
          onChange={next => setField('tags', next)}
        />
      </div>

      <DescriptionField
        value={draft.description}
        dirty={draft.description !== (ticket.description || '')}
        onChange={v => setField('description', v)}
      />

      <div style={section}>
        <ChildTicketList
          parentTicket={ticket}
          maxDepth={2}
          accountTickets={accountTickets}
          tagPool={tagPool}
          onCreateChild={onCreateChild}
          onMoveChild={onMoveChild}
          onDeleteChild={onDeleteChild}
          onReparentChild={onReparentChild}
          onSelectChild={onSelectChild}
        />
      </div>

      <TicketAttachmentsSection
        key={`attachments-${ticket.id}`}
        ticket={ticket}
        onPreview={onPreview}
        labelStyle={fieldLabel}
      />

      <details open={linksInUse} style={{ ...section, borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 10 }}>
        <summary style={{ ...fieldLabel, cursor: 'pointer', marginBottom: 10 }}>
          연결·자동화{linksInUse ? '' : ' (없음)'}
        </summary>
        <PrerequisitesField
          key={`prereq-${ticket.id}`}
          rows={prerequisites.rows}
          busy={prerequisites.busy}
          error={prerequisites.error}
          candidates={otherTickets.filter(t => !prerequisites.rows.some(r => r.prerequisite_ticket_id === t.id))}
          onAdd={prerequisites.add}
          onRemove={prerequisites.remove}
          onOpen={onOpenTicket}
          labelStyle={fieldLabel}
        />
        <div style={section}>
          <label style={fieldLabel}>
            다음 티켓{ticket.next_ticket?.status ? ` · 지금 ${ticketStatusLabel(ticket.next_ticket.status)}` : ''}
          </label>
          <select
            value={draft.nextTicketId}
            onChange={e => setField('nextTicketId', e.target.value)}
            style={{ ...controlStyle, cursor: 'pointer' }}
          >
            <option value="">— 없음 —</option>
            {ticket.next_ticket && !otherTickets.some(t => t.id === ticket.next_ticket!.id) && (
              <option value={ticket.next_ticket.id}>{ticket.next_ticket.title} · {ticketStatusLabel(ticket.next_ticket.status)}</option>
            )}
            {otherTickets.map(t => <option key={t.id} value={t.id}>{t.title} · {ticketStatusLabel(t.status)}</option>)}
          </select>
          <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 4 }}>
            이 티켓이 완료되면 다음 티켓을 대기열(To Do)로 올립니다.
          </div>
        </div>
        <OnDoneActionsField
          value={draft.onDoneActionIds}
          onChange={update => setDraft(prev => ({ ...prev, onDoneActionIds: update(prev.onDoneActionIds) }))}
          actions={actions}
          labelStyle={fieldLabel}
        />
      </details>

      <div style={{ fontSize: '11px', color: tokens.colors.textMuted, lineHeight: 1.6, ...wrapText }}>
        {ticket.created_by && <>만든 사람 {ticket.created_by} · </>}
        만듦 {new Date(ticket.created_at).toLocaleString()}
        {ticket.updated_at && <> · 수정 {new Date(ticket.updated_at).toLocaleString()}</>}
      </div>
    </div>
  );
}
