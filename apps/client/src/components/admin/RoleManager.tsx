import React, { useEffect, useState, useCallback } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Card } from '../common';

interface WorkspaceRoleRow {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  role_prompt: string;
  description: string;
  position: number;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

const EMPTY_FORM = {
  slug: '',
  name: '',
  role_prompt: '',
  description: '',
};

/**
 * v0.34: workspace-scoped role catalog editor.
 *
 * Lists every WorkspaceRole row for the active workspace. Built-in slugs
 * (`assignee`/`reporter`/`reviewer`) appear with a badge so admins can tell
 * what's seeded vs. what they added — but every field is editable now,
 * including the slug. Deletion is gated server-side on assignment count;
 * we surface that as an inline error instead of pre-disabling the button so
 * the admin sees *why* a role is locked.
 */
export default function RoleManager({ workspaceId }: { workspaceId: string }) {
  const [roles, setRoles] = useState<WorkspaceRoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const list = await api.listWorkspaceRoles(workspaceId);
      setRoles(list);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const resetForm = () => {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
    setShowForm(false);
    setActionError(null);
  };

  const startEdit = (r: WorkspaceRoleRow) => {
    setForm({
      slug: r.slug,
      name: r.name,
      role_prompt: r.role_prompt || '',
      description: r.description || '',
    });
    setEditingId(r.id);
    setShowForm(true);
    setActionError(null);
  };

  const handleSave = async () => {
    setActionError(null);
    if (!form.slug.trim() || !form.name.trim()) {
      setActionError('slug and name are required');
      return;
    }
    try {
      if (editingId) {
        await api.updateWorkspaceRole(workspaceId, editingId, {
          slug: form.slug,
          name: form.name,
          role_prompt: form.role_prompt,
          description: form.description,
        });
      } else {
        await api.createWorkspaceRole(workspaceId, {
          slug: form.slug,
          name: form.name,
          role_prompt: form.role_prompt,
          description: form.description,
        });
      }
      resetForm();
      await load();
    } catch (e: any) {
      setActionError(e?.message || 'Save failed');
    }
  };

  // Drag-to-reorder. Optimistic — render the new order immediately, then
  // persist; on server failure we reload from the source of truth so the
  // UI converges. Position field on each row is rewritten to 0..N-1 by
  // the server, but we don't bother updating the local copy because
  // `roles` is replaced on success.
  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    if (result.source.index === result.destination.index) return;
    const next = roles.slice();
    const [moved] = next.splice(result.source.index, 1);
    next.splice(result.destination.index, 0, moved);
    setRoles(next);
    try {
      const updated = await api.reorderWorkspaceRoles(workspaceId, next.map(r => r.id));
      setRoles(updated as WorkspaceRoleRow[]);
    } catch (e: any) {
      setActionError(e?.message || 'Reorder failed');
      await load();
    }
  };

  const handleDelete = async (r: WorkspaceRoleRow) => {
    if (!confirm(`Delete role "${r.name}" (slug: ${r.slug})?\n\nThis can't be undone, and only succeeds when no ticket assignments still reference it.`)) {
      return;
    }
    try {
      await api.deleteWorkspaceRole(workspaceId, r.id);
      await load();
    } catch (e: any) {
      setActionError(e?.message || 'Delete failed');
    }
  };

  if (loading && roles.length === 0) {
    return <div style={{ padding: 16, color: tokens.colors.textMuted }}>Loading roles…</div>;
  }
  if (error) {
    return <div style={{ padding: 16, color: tokens.colors.danger }}>{error}</div>;
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ margin: 0, color: tokens.colors.textMuted, fontSize: 13 }}>
          Roles control who gets triggered when a ticket moves through a column. Slugs (e.g. <code>assignee</code>)
          are used in <code>@[role:slug|Name]</code> mentions and <code>routing_config</code>. Each role's prompt is prepended to
          the agent's own <code>role_prompt</code> at trigger time. Drag the <code>⠿</code> handle to reorder —
          the order here drives how roles appear on every ticket.
        </p>
        <Button onClick={() => { resetForm(); setShowForm(true); }}>+ New role</Button>
      </div>

      {actionError && (
        <div style={{
          padding: '8px 12px',
          background: `${tokens.colors.danger}1A`,
          border: `1px solid ${tokens.colors.danger}`,
          color: tokens.colors.danger,
          borderRadius: tokens.radii.md,
          fontSize: 13,
        }}>
          {actionError}
        </div>
      )}

      <DragDropContext onDragEnd={handleDragEnd}>
        <Droppable droppableId="workspace-roles-list">
          {(provided) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              {roles.map((r, idx) => (
                <Draggable key={r.id} draggableId={r.id} index={idx}>
                  {(dragProvided, snapshot) => (
                    <div
                      ref={dragProvided.innerRef}
                      {...dragProvided.draggableProps}
                      style={{
                        ...dragProvided.draggableProps.style,
                        // Subtle lift while dragging so the visual order
                        // matches the data order during the gesture.
                        boxShadow: snapshot.isDragging ? tokens.shadows.modal : undefined,
                        opacity: snapshot.isDragging ? 0.95 : 1,
                      }}
                    >
                      <Card>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span
                              {...dragProvided.dragHandleProps}
                              title="Drag to reorder"
                              style={{
                                cursor: 'grab',
                                color: tokens.colors.borderStrong,
                                userSelect: 'none',
                                fontSize: 14,
                                padding: '0 4px',
                                lineHeight: 1,
                              }}
                            >⠿</span>
                            <strong style={{ fontSize: 15 }}>{r.name}</strong>
                            <code style={{
                              fontSize: 12,
                              padding: '2px 6px',
                              background: tokens.colors.surfaceSubtle,
                              borderRadius: tokens.radii.sm,
                            }}>{r.slug}</code>
                            {r.is_builtin && (
                              <span style={{
                                fontSize: 11,
                                padding: '2px 6px',
                                background: `${tokens.colors.accent}1A`,
                                color: tokens.colors.accent,
                                borderRadius: tokens.radii.sm,
                              }}>built-in</span>
                            )}
                          </div>
                          {r.description && (
                            <div style={{ fontSize: 13, color: tokens.colors.textMuted }}>{r.description}</div>
                          )}
                          {r.role_prompt && (
                            <details>
                              <summary style={{ cursor: 'pointer', fontSize: 12, color: tokens.colors.textMuted }}>
                                Role prompt ({r.role_prompt.length} chars)
                              </summary>
                              <pre style={{
                                fontSize: 12,
                                padding: 8,
                                background: tokens.colors.surfaceSubtle,
                                borderRadius: tokens.radii.sm,
                                whiteSpace: 'pre-wrap',
                                margin: '4px 0 0',
                              }}>{r.role_prompt}</pre>
                            </details>
                          )}
                          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                            <Button onClick={() => startEdit(r)}>Edit</Button>
                            <Button onClick={() => handleDelete(r)} variant="danger">Delete</Button>
                          </div>
                        </div>
                      </Card>
                    </div>
                  )}
                </Draggable>
              ))}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>

      {showForm && (
        <Modal isOpen={showForm} onClose={resetForm} title={editingId ? 'Edit role' : 'New role'} maxWidth={720}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 4 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>
                Slug — used in <code>@[role:slug|...]</code> mentions and routing_config. Lowercase letters/digits/hyphens.
              </span>
              <Input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                placeholder="qa-reviewer"
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>Name — display label</span>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="QA Reviewer"
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>Description (optional)</span>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Reviews production-readiness before merge."
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>
                Role prompt — prepended to agent's own role_prompt when triggered as this role.
              </span>
              <textarea
                value={form.role_prompt}
                onChange={(e) => setForm({ ...form, role_prompt: e.target.value })}
                placeholder="You are reviewing for production-readiness. Focus on edge cases and security holes."
                rows={10}
                style={{
                  fontFamily: 'monospace',
                  fontSize: 13,
                  padding: 8,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  resize: 'vertical',
                  background: tokens.colors.surfaceSubtle,
                  color: tokens.colors.textPrimary,
                }}
              />
            </label>
            {actionError && (
              <div style={{ color: tokens.colors.danger, fontSize: 12 }}>{actionError}</div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button onClick={resetForm}>Cancel</Button>
              <Button onClick={handleSave} variant="primary">{editingId ? 'Save' : 'Create'}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
