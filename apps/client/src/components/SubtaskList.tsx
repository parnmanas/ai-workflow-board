import React, { useState } from 'react';
import { Ticket, Agent } from '../types';
import { tokens } from '../tokens';

interface ChildTicketListProps {
  parentTicket: Ticket;
  agents: Agent[];
  maxDepth: number; // max allowed depth for this parent's children
  onCreateChild: (parentId: string, data: { title: string; description?: string; priority?: string; assignee?: string; reporter?: string }) => void;
  onUpdateChild: (childId: string, data: Record<string, any>) => void;
  onDeleteChild: (childId: string) => void;
  onSelectChild?: (child: Ticket) => void; // opens slide panel
}

const priorityColors: Record<string, string> = {
  low: tokens.colors.textSecondary,
  medium: tokens.colors.info,
  high: tokens.colors.warningLight,
  critical: tokens.colors.danger,
};

const statusColors: Record<string, string> = {
  todo: tokens.colors.textSecondary,
  in_progress: tokens.colors.warningLight,
  done: tokens.colors.successLight,
};

export default function ChildTicketList({ parentTicket, agents, maxDepth, onCreateChild, onUpdateChild, onDeleteChild, onSelectChild }: ChildTicketListProps) {
  const children = parentTicket.children || [];
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState({
    title: '', description: '', priority: 'medium', assignee: '', reporter: '',
  });
  const [createErrors, setCreateErrors] = useState<{ title?: string; description?: string }>({});

  const doneCount = children.filter(c => c.status === 'done').length;
  const progress = children.length > 0 ? (doneCount / children.length) * 100 : 0;

  const inputStyle = {
    background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
    padding: '6px 10px', color: tokens.colors.textStrong, fontSize: '12px', outline: 'none', width: '100%',
  };

  // Single atomic create path — both title and description required so agents
  // never see a half-written subtask. Quick title-only create was removed for
  // the same race-condition reason as the parent ticket modal: the assignee
  // agent can poll the board before the reporter finishes typing.
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
      priority: createForm.priority,
      assignee: createForm.assignee,
      reporter: createForm.reporter,
    });
    setCreateForm({ title: '', description: '', priority: 'medium', assignee: '', reporter: '' });
    setCreateErrors({});
    setShowCreateForm(false);
  };

  const canCreateChildren = parentTicket.depth < maxDepth;

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h4 style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textDisabled }}>
          Subtasks ({doneCount}/{children.length})
        </h4>
        {canCreateChildren && !showCreateForm && (
          <button onClick={() => setShowCreateForm(true)} style={{
            background: 'none', border: 'none', color: tokens.colors.accent, cursor: 'pointer',
            fontSize: '11px', fontWeight: 600,
          }}>+ Add subtask</button>
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
        {children.map(child => (
          <div key={child.id} style={{
            borderRadius: tokens.radii.md, background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
              <input
                type="checkbox"
                checked={child.status === 'done'}
                onChange={() => onUpdateChild(child.id, { status: child.status === 'done' ? 'todo' : 'done' })}
                style={{ cursor: 'pointer', accentColor: tokens.colors.accent }}
              />
              <span style={{
                fontSize: '10px', fontWeight: 700, padding: '1px 4px', borderRadius: tokens.radii.xs,
                color: priorityColors[child.priority || 'medium'],
                background: `${priorityColors[child.priority || 'medium']}15`,
              }}>{(child.priority || 'medium').slice(0, 3).toUpperCase()}</span>
              <span
                onClick={() => onSelectChild?.(child)}
                style={{
                  flex: 1, fontSize: '13px', cursor: onSelectChild ? 'pointer' : 'default',
                  color: child.status === 'done' ? tokens.colors.textMuted : tokens.colors.textStrong,
                  textDecoration: child.status === 'done' ? 'line-through' : 'none',
                }}
              >{child.title}</span>
              {(child.children || []).length > 0 && (
                <span style={{ fontSize: '10px', color: tokens.colors.textMuted, background: tokens.colors.surface, padding: '2px 6px', borderRadius: tokens.radii.sm }}>
                  {(child.children || []).filter(gc => gc.status === 'done').length}/{(child.children || []).length}
                </span>
              )}
              <select
                value={child.status || 'todo'}
                onChange={e => {
                  e.stopPropagation();
                  onUpdateChild(child.id, { status: e.target.value });
                }}
                onClick={e => e.stopPropagation()}
                style={{
                  background: 'transparent', border: 'none', fontSize: '10px', fontWeight: 600,
                  color: statusColors[child.status || 'todo'], cursor: 'pointer', outline: 'none',
                }}
              >
                <option value="todo">To Do</option>
                <option value="in_progress">In Progress</option>
                <option value="done">Done</option>
              </select>
              {child.assignee && (
                <span style={{ fontSize: '10px', color: tokens.colors.textMuted, background: tokens.colors.surface, padding: '2px 6px', borderRadius: tokens.radii.sm }}>
                  {child.assignee}
                </span>
              )}
              <button onClick={(e) => { e.stopPropagation(); onDeleteChild(child.id); }} style={{
                background: 'none', border: 'none', color: tokens.colors.borderStrong, cursor: 'pointer',
                fontSize: '14px', padding: '0 4px',
              }}>x</button>
            </div>
          </div>
        ))}
      </div>

      {/* Create form — expanded inline, not a modal, because SubtaskList
         already lives inside the ticket slide-panel and a nested modal reads
         as a depth mismatch. Validation matches the parent ticket modal:
         both title AND description must be non-empty. */}
      {canCreateChildren && showCreateForm && (
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <select value={createForm.priority} onChange={e => setCreateForm({ ...createForm, priority: e.target.value })} style={inputStyle}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <select value={createForm.assignee} onChange={e => setCreateForm({ ...createForm, assignee: e.target.value })} style={inputStyle}>
              <option value="">Unassigned</option>
              {agents.filter(a => a.is_active).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
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
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              onClick={() => { setShowCreateForm(false); setCreateErrors({}); setCreateForm({ title: '', description: '', priority: 'medium', assignee: '', reporter: '' }); }}
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
