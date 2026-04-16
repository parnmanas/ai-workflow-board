import React, { useState } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Column } from '../types';
import { tokens } from '../tokens';
import { Button, Input } from './common';

const ROLES = ['assignee', 'reviewer', 'reporter'] as const;

interface ColumnManagerProps {
  columns: Column[];
  boardId: string;
  routingConfig: Record<string, string[]>;
  onCreateColumn: (boardId: string, name: string, color?: string) => Promise<void>;
  onUpdateColumn: (columnId: string, data: { name?: string; color?: string; position?: number; description?: string }) => Promise<void>;
  onDeleteColumn: (columnId: string) => Promise<void>;
  onUpdateRoutingConfig: (config: Record<string, string[]>) => Promise<void>;
}

// tag/label palette — decorative column color swatches, not tokenized
const PRESET_COLORS = [
  '#94a3b8', '#60a5fa', '#fbbf24', '#a78bfa', '#34d399',
  '#f87171', '#fb923c', '#38bdf8', '#e879f9', '#4ade80',
  '#facc15', '#2dd4bf', '#818cf8', '#f472b6', '#c084fc',
];

export default function ColumnManager({
  columns, boardId, routingConfig,
  onCreateColumn, onUpdateColumn, onDeleteColumn, onUpdateRoutingConfig,
}: ColumnManagerProps) {
  const [newColName, setNewColName] = useState('');
  const [newColColor, setNewColColor] = useState('#60a5fa'); // tag/label palette default — not tokenized
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [editDesc, setEditDesc] = useState('');

  const sorted = [...columns].sort((a, b) => a.position - b.position);

  const handleCreate = async () => {
    if (!newColName.trim()) return;
    await onCreateColumn(boardId, newColName.trim(), newColColor);
    setNewColName('');
  };

  const startEdit = (col: Column) => {
    setEditingId(col.id);
    setEditName(col.name);
    setEditColor(col.color);
    setEditDesc(col.description || '');
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    await onUpdateColumn(editingId, { name: editName.trim(), color: editColor, description: editDesc.trim() });
    setEditingId(null);
  };

  const handleDelete = async (colId: string) => {
    const col = columns.find(c => c.id === colId);
    const ticketCount = col?.tickets?.length || 0;
    const msg = ticketCount > 0
      ? `This column has ${ticketCount} ticket(s). Delete column and all tickets?`
      : 'Delete this column?';
    if (!confirm(msg)) return;
    await onDeleteColumn(colId);
  };

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination || result.source.index === result.destination.index) return;
    const col = sorted[result.source.index];
    await onUpdateColumn(col.id, { position: result.destination.index });
  };

  const toggleRole = (colName: string, role: string) => {
    const key = colName.toLowerCase();
    const current = routingConfig[key] || [];
    const next = current.includes(role)
      ? current.filter(r => r !== role)
      : [...current, role];
    const updated = { ...routingConfig };
    if (next.length > 0) {
      updated[key] = next;
    } else {
      delete updated[key];
    }
    onUpdateRoutingConfig(updated);
  };

  const getColRoles = (colName: string): string[] => routingConfig[colName.toLowerCase()] || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Column list */}
        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="column-manager-list">
            {(provided) => (
              <div
                ref={provided.innerRef}
                {...provided.droppableProps}
                style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}
              >
                {sorted.map((col, idx) => {
                  const isEditing = editingId === col.id;
                  const colRoles = getColRoles(col.name);

                  return (
                    <Draggable key={col.id} draggableId={col.id} index={idx} isDragDisabled={isEditing}>
                      {(dragProvided, snapshot) => (
                        <div
                          ref={dragProvided.innerRef}
                          {...dragProvided.draggableProps}
                          style={{
                            background: snapshot.isDragging ? tokens.colors.surfaceCard : tokens.colors.surface,
                            borderRadius: tokens.radii.lg,
                            border: snapshot.isDragging ? `1px solid ${tokens.colors.accent}` : `1px solid ${tokens.colors.border}`,
                            boxShadow: snapshot.isDragging ? tokens.shadows.card : 'none',
                            ...dragProvided.draggableProps.style,
                          }}
                        >
                          {isEditing ? (
                            /* ── Edit mode ── */
                            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <div style={{
                                  width: 24, height: 24, borderRadius: 4, background: editColor,
                                  flexShrink: 0, cursor: 'pointer', position: 'relative',
                                }}>
                                  <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)}
                                    style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }} />
                                </div>
                                <div style={{ flex: 1 }}>
                                  <Input
                                    autoFocus
                                    value={editName}
                                    onChange={e => setEditName(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') handleSaveEdit(); if (e.key === 'Escape') setEditingId(null); }}
                                  />
                                </div>
                                <Button size="sm" variant="primary" onClick={handleSaveEdit}>Save</Button>
                                <Button size="sm" variant="secondary" onClick={() => setEditingId(null)}>Cancel</Button>
                              </div>
                              <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)}
                                placeholder="Description / prompt for agents..."
                                rows={2}
                                style={{
                                  width: '100%', background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.borderStrong}`, borderRadius: tokens.radii.md,
                                  padding: '6px 8px', color: tokens.colors.textStrong, fontSize: '12px', resize: 'vertical',
                                  outline: 'none', lineHeight: 1.5, boxSizing: 'border-box',
                                }}
                              />
                            </div>
                          ) : (
                            /* ── View mode ── */
                            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {/* Top row: drag handle, color, name, ticket count, actions */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div {...dragProvided.dragHandleProps} style={{
                                  width: 20, flexShrink: 0, display: 'flex', alignItems: 'center',
                                  justifyContent: 'center', cursor: 'grab', color: tokens.colors.borderStrong, fontSize: '14px', userSelect: 'none',
                                }} title="Drag to reorder">⠿</div>
                                <div style={{ width: 16, height: 16, borderRadius: tokens.radii.sm, background: col.color, flexShrink: 0 }} />
                                <span style={{ flex: 1, fontSize: '14px', color: tokens.colors.textStrong, fontWeight: 600 }}>{col.name}</span>
                                <span style={{ fontSize: '11px', color: tokens.colors.textMuted, flexShrink: 0 }}>
                                  {col.tickets?.length || 0} tickets
                                </span>
                                <Button size="sm" variant="secondary" onClick={() => startEdit(col)}>Edit</Button>
                                <Button size="sm" variant="danger" onClick={() => handleDelete(col.id)}>×</Button>
                              </div>

                              {/* Description preview */}
                              {col.description && (
                                <div style={{ paddingLeft: 28, fontSize: '12px', color: tokens.colors.textMuted, lineHeight: 1.4 }}>
                                  {col.description}
                                </div>
                              )}

                              {/* Routing toggles — always visible */}
                              <div style={{ paddingLeft: 28, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: '10px', color: tokens.colors.borderStrong, fontWeight: 600, textTransform: 'uppercase', flexShrink: 0 }}>
                                  Routing
                                </span>
                                <div style={{ display: 'flex', gap: 4 }}>
                                  {ROLES.map(role => {
                                    const active = colRoles.includes(role);
                                    return (
                                      <button
                                        key={role}
                                        onClick={() => toggleRole(col.name, role)}
                                        style={{
                                          padding: '3px 10px', borderRadius: tokens.radii.sm, fontSize: '11px', fontWeight: 600,
                                          border: active ? `1px solid ${tokens.colors.accent}` : `1px solid ${tokens.colors.border}`,
                                          background: active ? `${tokens.colors.accent}20` : 'transparent',
                                          color: active ? tokens.colors.accentLight : tokens.colors.borderStrong,
                                          cursor: 'pointer', textTransform: 'capitalize',
                                        }}
                                      >
                                        {role}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </Draggable>
                  );
                })}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>

        {/* Add new column */}
        <div style={{
          padding: '12px', background: tokens.colors.surface, borderRadius: tokens.radii.lg,
          border: `1px solid ${tokens.colors.border}`,
        }}>
          <div style={{ fontSize: '12px', color: tokens.colors.textMuted, marginBottom: 8, fontWeight: 600 }}>Add Column</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{
              width: 28, height: 28, borderRadius: tokens.radii.md,
              background: newColColor, flexShrink: 0, cursor: 'pointer',
              position: 'relative', border: `2px solid ${tokens.colors.border}`,
            }}>
              <input type="color" value={newColColor} onChange={e => setNewColColor(e.target.value)}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }} />
            </div>
            <div style={{ flex: 1 }}>
              <Input
                value={newColName}
                onChange={e => setNewColName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                placeholder="Column name"
              />
            </div>
            <Button variant="primary" size="sm" onClick={handleCreate}>Add</Button>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
            {PRESET_COLORS.map(c => (
              <div key={c} onClick={() => setNewColColor(c)} style={{
                width: 18, height: 18, borderRadius: tokens.radii.sm, background: c, cursor: 'pointer',
                border: c === newColColor ? `2px solid ${tokens.colors.textStrong}` : '2px solid transparent',
              }} />
            ))}
          </div>
        </div>
    </div>
  );
}
