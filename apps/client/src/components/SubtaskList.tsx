import React, { useMemo, useState } from 'react';
import { Ticket, TicketStatus } from '../types';
import { tokens } from '../tokens';
import {
  DEFAULT_TICKET_STATUS, DONE_STATUS, TICKET_STATUSES,
  ticketStatusColor, ticketStatusLabel,
} from '../tickets/status';
import TagInput from './common/TagInput';

// Minimal shape the "Link existing" picker walks — both full Tickets and the
// list's TicketCard rows satisfy it.
interface LinkableTicket {
  id: string;
  title: string;
  priority?: string;
  children?: LinkableTicket[] | null;
}

interface ChildTicketListProps {
  parentTicket: Ticket;
  maxDepth: number; // max allowed depth for this parent's children
  // Root tickets of the loaded workspace pool, used by the "Link existing"
  // picker. Self, current children and ancestors are filtered out.
  workspaceTickets?: LinkableTicket[];
  /** Tag suggestions for the create form (collectTagPool of the loaded pool). */
  tagPool?: Array<{ tag: string; count: number }>;
  // POST /tickets/:parentId/children — children carry no assignee of their
  // own; the parent's assignee works through them.
  onCreateChild: (parentId: string, data: { title: string; description?: string; tags?: string[] }) => void;
  /** Status change for a child (PATCH /tickets/:id/move). */
  onMoveChild: (childId: string, status: TicketStatus) => void;
  onDeleteChild: (childId: string) => void;
  // Adopt an existing ticket as a subtask of this parent.
  onReparentChild?: (parentId: string, childId: string) => void;
  onSelectChild?: (child: Ticket) => void; // opens slide panel
}

const priorityColors: Record<string, string> = {
  low: tokens.colors.textSecondary,
  medium: tokens.colors.info,
  high: tokens.colors.warningLight,
  critical: tokens.colors.danger,
};

type AddMode = null | 'new' | 'link';

const EMPTY_FORM = { title: '', description: '', tags: [] as string[] };

export default function ChildTicketList({
  parentTicket, maxDepth, workspaceTickets, tagPool, onCreateChild, onMoveChild, onDeleteChild, onReparentChild, onSelectChild,
}: ChildTicketListProps) {
  const children = parentTicket.children || [];
  const [addMode, setAddMode] = useState<AddMode>(null);
  const [createForm, setCreateForm] = useState(EMPTY_FORM);
  const [createErrors, setCreateErrors] = useState<{ title?: string; description?: string }>({});
  const [linkQuery, setLinkQuery] = useState('');

  // Eligible candidates for "Link existing":
  //   - exclude this ticket itself and its subtree (already descendants)
  //   - exclude tickets already a direct child of this parent
  //   - exclude any of this ticket's ancestors (would create a cycle —
  //     server rejects too, but UX-wise we don't want to surface them)
  // workspaceTickets is a list of root tickets with nested children; flatten
  // so a leaf can also be promoted into another parent's subtask list.
  const linkCandidates = useMemo(() => {
    if (!workspaceTickets || !onReparentChild) return [];
    const flat: LinkableTicket[] = [];
    const walk = (t: LinkableTicket) => {
      flat.push(t);
      for (const c of (t.children || [])) walk(c);
    };
    for (const t of workspaceTickets) walk(t);
    const childIds = new Set(children.map(c => c.id));
    const subtreeIds = new Set<string>();
    const collect = (t: LinkableTicket) => {
      subtreeIds.add(t.id);
      for (const c of (t.children || [])) collect(c);
    };
    collect(parentTicket);
    const containsParent = (root: LinkableTicket): boolean => {
      if (root.id === parentTicket.id) return true;
      for (const c of (root.children || [])) if (containsParent(c)) return true;
      return false;
    };
    const q = linkQuery.trim().toLowerCase();
    return flat
      .filter(t => !subtreeIds.has(t.id))
      .filter(t => !childIds.has(t.id))
      .filter(t => !containsParent(t))
      .filter(t => !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
      .slice(0, 20);
  }, [workspaceTickets, children, parentTicket, linkQuery, onReparentChild]);

  const doneCount = children.filter(c => c.status === DONE_STATUS).length;
  const progress = children.length > 0 ? (doneCount / children.length) * 100 : 0;

  const inputStyle: React.CSSProperties = {
    background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
    padding: '6px 10px', color: tokens.colors.textStrong, fontSize: '12px', outline: 'none', width: '100%',
    boxSizing: 'border-box',
  };

  const resetCreate = () => {
    setCreateForm(EMPTY_FORM);
    setCreateErrors({});
    setAddMode(null);
  };

  // Single atomic create path — title and description are both required so
  // the parent's assignee never picks up a half-written subtask.
  const handleCreate = () => {
    const errs: { title?: string; description?: string } = {};
    if (!createForm.title.trim()) errs.title = 'Title is required.';
    if (!createForm.description.trim()) errs.description = 'Description is required.';
    if (Object.keys(errs).length > 0) {
      setCreateErrors(errs);
      return;
    }
    onCreateChild(parentTicket.id, {
      title: createForm.title.trim(),
      description: createForm.description.trim(),
      ...(createForm.tags.length > 0 ? { tags: createForm.tags } : {}),
    });
    resetCreate();
  };

  const handleLinkExisting = (ticketId: string) => {
    if (!onReparentChild) return;
    onReparentChild(parentTicket.id, ticketId);
    setLinkQuery('');
    setAddMode(null);
  };

  const canCreateChildren = parentTicket.depth < maxDepth;
  const canLinkExisting = canCreateChildren && !!onReparentChild;

  const actionBtnStyle: React.CSSProperties = {
    background: 'none', border: 'none', color: tokens.colors.accent, cursor: 'pointer',
    fontSize: '11px', fontWeight: 600, padding: 0,
  };

  const priorityBadge = (priority: string | undefined) => {
    const p = priority || 'medium';
    return (
      <span style={{
        fontSize: '10px', fontWeight: 700, padding: '1px 4px', borderRadius: tokens.radii.xs,
        color: priorityColors[p], background: `${priorityColors[p]}15`,
      }}>{p.slice(0, 3).toUpperCase()}</span>
    );
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h4 style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textDisabled }}>
          Subtasks ({doneCount}/{children.length})
        </h4>
        {canCreateChildren && addMode === null && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button onClick={() => setAddMode('new')} style={actionBtnStyle}>+ New subtask</button>
            {canLinkExisting && (
              <>
                <span style={{ color: tokens.colors.borderStrong, fontSize: '11px' }}>·</span>
                <button onClick={() => setAddMode('link')} style={actionBtnStyle}>+ Link existing</button>
              </>
            )}
          </div>
        )}
      </div>

      {children.length > 0 && (
        <div style={{
          height: 4, background: tokens.colors.border, borderRadius: tokens.radii.xs, marginBottom: 10, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', width: `${progress}%`,
            background: progress === 100 ? tokens.colors.successLight : tokens.colors.accent,
            borderRadius: tokens.radii.xs, transition: 'width 0.3s ease',
          }} />
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {children.map(child => {
          const isDone = child.status === DONE_STATUS;
          return (
            <div key={child.id} style={{
              borderRadius: tokens.radii.md, background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, overflow: 'hidden',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
                <input
                  type="checkbox"
                  checked={isDone}
                  onChange={() => onMoveChild(child.id, isDone ? DEFAULT_TICKET_STATUS : DONE_STATUS)}
                  style={{ cursor: 'pointer', accentColor: tokens.colors.accent }}
                />
                {priorityBadge(child.priority)}
                <span
                  onClick={() => onSelectChild?.(child)}
                  style={{
                    flex: 1, fontSize: '13px', cursor: onSelectChild ? 'pointer' : 'default',
                    color: isDone ? tokens.colors.textMuted : tokens.colors.textStrong,
                    textDecoration: isDone ? 'line-through' : 'none',
                  }}
                >{child.title}</span>
                {(child.children || []).length > 0 && (
                  <span style={{ fontSize: '10px', color: tokens.colors.textMuted, background: tokens.colors.surface, padding: '2px 6px', borderRadius: tokens.radii.sm }}>
                    {(child.children || []).filter(gc => gc.status === DONE_STATUS).length}/{(child.children || []).length}
                  </span>
                )}
                <select
                  value={child.status || DEFAULT_TICKET_STATUS}
                  onChange={e => {
                    e.stopPropagation();
                    onMoveChild(child.id, e.target.value as TicketStatus);
                  }}
                  onClick={e => e.stopPropagation()}
                  title="Status"
                  style={{
                    background: 'transparent', border: 'none', fontSize: '10px', fontWeight: 600,
                    color: ticketStatusColor(child.status), cursor: 'pointer', outline: 'none',
                  }}
                >
                  {TICKET_STATUSES.map(s => <option key={s} value={s}>{ticketStatusLabel(s)}</option>)}
                </select>
                <button onClick={(e) => { e.stopPropagation(); onDeleteChild(child.id); }} style={{
                  background: 'none', border: 'none', color: tokens.colors.borderStrong, cursor: 'pointer',
                  fontSize: '14px', padding: '0 4px',
                }}>x</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Link existing — picker over the flattened workspace pool. Distinct
         from the create form below: this re-parents an existing root/child
         ticket under this parent rather than minting a new one. Search filters
         by title or id; results are capped at 20 so the list stays compact. */}
      {canLinkExisting && addMode === 'link' && (
        <div style={{
          marginTop: 8, background: tokens.colors.surface, borderRadius: tokens.radii.md, padding: 10,
          border: `1px solid ${tokens.colors.border}`, display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <input
            autoFocus
            value={linkQuery}
            onChange={e => setLinkQuery(e.target.value)}
            placeholder="Search ticket by title or id..."
            style={inputStyle}
          />
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 2,
            maxHeight: 220, overflowY: 'auto',
          }}>
            {linkCandidates.length === 0 ? (
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, padding: '6px 8px', fontStyle: 'italic' }}>
                {linkQuery.trim() ? 'No matching tickets' : 'No tickets available to link'}
              </div>
            ) : linkCandidates.map(t => (
              <button
                key={t.id}
                onClick={() => handleLinkExisting(t.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                  background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.sm, padding: '6px 8px', cursor: 'pointer',
                  color: tokens.colors.textStrong, fontSize: '12px',
                }}
              >
                {priorityBadge(t.priority)}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                <span style={{ fontSize: '10px', color: tokens.colors.textMuted }}>#{t.id.slice(0, 6)}</span>
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => { setAddMode(null); setLinkQuery(''); }}
              style={{
                background: 'transparent', color: tokens.colors.textSecondary, border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md, padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
              }}
            >Cancel</button>
          </div>
        </div>
      )}

      {/* Create form — expanded inline, not a modal, because SubtaskList
         already lives inside the ticket slide-panel and a nested modal reads
         as a depth mismatch. Body = POST /tickets/:parentId/children
         { title, description, tags? }. */}
      {canCreateChildren && addMode === 'new' && (
        <div style={{
          marginTop: 8, background: tokens.colors.surface, borderRadius: tokens.radii.md, padding: 10,
          border: `1px solid ${tokens.colors.border}`, display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div>
            <input
              autoFocus
              value={createForm.title}
              onChange={e => { setCreateForm({ ...createForm, title: e.target.value }); if (createErrors.title) setCreateErrors({ ...createErrors, title: undefined }); }}
              placeholder="Subtask title"
              style={{ ...inputStyle, borderColor: createErrors.title ? tokens.colors.danger : tokens.colors.border }}
            />
            {createErrors.title && (
              <div style={{ fontSize: '11px', color: tokens.colors.danger, marginTop: 2 }}>{createErrors.title}</div>
            )}
          </div>
          <div>
            <textarea
              value={createForm.description}
              onChange={e => { setCreateForm({ ...createForm, description: e.target.value }); if (createErrors.description) setCreateErrors({ ...createErrors, description: undefined }); }}
              placeholder="Description (required) — what the assignee needs to know before starting"
              rows={3}
              style={{
                ...inputStyle,
                resize: 'vertical',
                borderColor: createErrors.description ? tokens.colors.danger : tokens.colors.border,
              }}
            />
            {createErrors.description && (
              <div style={{ fontSize: '11px', color: tokens.colors.danger, marginTop: 2 }}>{createErrors.description}</div>
            )}
          </div>
          <TagInput
            value={createForm.tags}
            suggestions={tagPool || []}
            onChange={tags => setCreateForm(prev => ({ ...prev, tags }))}
            placeholder="Tags (선택 — Enter / 쉼표)"
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              onClick={resetCreate}
              style={{
                background: 'transparent', color: tokens.colors.textSecondary, border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md, padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
              }}
            >Cancel</button>
            <button onClick={handleCreate} style={{
              background: tokens.colors.accent, color: 'white', border: 'none', borderRadius: tokens.radii.md,
              padding: '4px 12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
            }}>Add Subtask</button>
          </div>
        </div>
      )}
    </div>
  );
}
