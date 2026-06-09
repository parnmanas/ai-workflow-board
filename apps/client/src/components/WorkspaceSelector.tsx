import React, { useState } from 'react';
import { Workspace } from '../types';
import { tokens } from '../tokens';
import { useConfirm } from '../contexts/ConfirmContext';

interface WorkspaceSelectorProps {
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  currentBoardName?: string;
  currentBoardId?: string | null;
  onSelect: (workspaceId: string) => void;
  onCreate: (name: string, description?: string, boardName?: string) => Promise<void>;
  onDelete: (workspaceId: string) => Promise<void>;
  onUpdate: (workspaceId: string, data: { name?: string; description?: string }) => Promise<void>;
  onUpdateBoard?: (boardId: string, data: { name?: string }) => Promise<void>;
}

export default function WorkspaceSelector({
  workspaces,
  currentWorkspaceId,
  currentBoardName,
  currentBoardId,
  onSelect,
  onCreate,
  onDelete,
  onUpdate,
  onUpdateBoard,
}: WorkspaceSelectorProps) {
  const confirm = useConfirm();
  const [showDropdown, setShowDropdown] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newBoardName, setNewBoardName] = useState('');
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editBoardName, setEditBoardName] = useState('');

  const currentWs = workspaces.find(w => w.id === currentWorkspaceId);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    await onCreate(newName.trim(), newDesc.trim(), newBoardName.trim() || undefined);
    setNewName('');
    setNewDesc('');
    setNewBoardName('');
    setShowCreate(false);
  };

  const handleEdit = async () => {
    if (!currentWorkspaceId || !editName.trim()) return;
    await onUpdate(currentWorkspaceId, { name: editName.trim(), description: editDesc.trim() });
    if (onUpdateBoard && currentBoardId && editBoardName.trim()) {
      await onUpdateBoard(currentBoardId, { name: editBoardName.trim() });
    }
    setShowEdit(false);
  };

  const handleDelete = async () => {
    if (!currentWorkspaceId) return;
    const ok = await confirm({
      title: 'Delete workspace',
      message: 'Are you sure you want to delete this workspace? All boards and tickets will be deleted.',
    });
    if (!ok) return;
    await onDelete(currentWorkspaceId);
  };

  const startEdit = () => {
    if (currentWs) {
      setEditName(currentWs.name);
      setEditDesc(currentWs.description || '');
      setEditBoardName(currentBoardName || '');
      setShowEdit(true);
      setShowDropdown(false);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderRadius: tokens.radii.lg,
          background: tokens.colors.surfaceCard,
          border: `1px solid ${tokens.colors.border}`,
          color: tokens.colors.textStrong,
          fontSize: '13px',
          fontWeight: 600,
          cursor: 'pointer',
          minWidth: 160,
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: tokens.gradients.accent,
        }} />
        {currentWs?.name || 'Select Workspace'}
        <span style={{ marginLeft: 'auto', fontSize: '10px', color: tokens.colors.textMuted }}>▼</span>
      </button>

      {showDropdown && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          marginTop: 4,
          minWidth: 260,
          background: tokens.colors.surfaceCard,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: 10,
          boxShadow: tokens.shadows.card,
          zIndex: 1000,
          overflow: 'hidden',
        }}>
          <div style={{ padding: '8px 12px', fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
            Workspaces
          </div>
          {workspaces.map(ws => (
            <div
              key={ws.id}
              onClick={() => { onSelect(ws.id); setShowDropdown(false); }}
              style={{
                padding: '10px 12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: ws.id === currentWorkspaceId ? tokens.colors.border : 'transparent',
                borderLeft: ws.id === currentWorkspaceId ? `3px solid ${tokens.colors.accent}` : '3px solid transparent',
              }}
              onMouseEnter={e => { if (ws.id !== currentWorkspaceId) (e.currentTarget.style.background = `${tokens.colors.surfaceCard}80`); }}
              onMouseLeave={e => { if (ws.id !== currentWorkspaceId) (e.currentTarget.style.background = 'transparent'); }}
            >
              <span style={{ fontSize: '13px', color: tokens.colors.textStrong, fontWeight: 500 }}>{ws.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: '11px', color: tokens.colors.textMuted }}>
                {(ws as any).board_count ?? ws.boards?.length ?? 0} board{((ws as any).board_count ?? ws.boards?.length ?? 0) !== 1 ? 's' : ''}
              </span>
            </div>
          ))}
          <div style={{ borderTop: `1px solid ${tokens.colors.border}`, padding: 4, display: 'flex', gap: 4 }}>
            <button
              onClick={() => { setShowCreate(true); setShowDropdown(false); }}
              style={{
                flex: 1, padding: '8px', background: tokens.colors.accent, border: 'none',
                borderRadius: tokens.radii.md, color: 'white', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
              }}
            >
              + New Workspace
            </button>
            {currentWs && (
              <>
                <button
                  onClick={startEdit}
                  style={{
                    padding: '8px 10px', background: tokens.colors.border, border: 'none',
                    borderRadius: tokens.radii.md, color: tokens.colors.textSecondary, fontSize: '12px', cursor: 'pointer',
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={() => { handleDelete(); setShowDropdown(false); }}
                  style={{
                    padding: '8px 10px', background: tokens.colors.dangerBg, border: 'none',
                    borderRadius: tokens.radii.md, color: tokens.colors.dangerLight, fontSize: '12px', cursor: 'pointer',
                  }}
                >
                  Del
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
        }} onClick={() => setShowCreate(false)}>
          <div style={{
            background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.xl,
            padding: 24, minWidth: 360, boxShadow: tokens.shadows.modal,
          }} onClick={e => e.stopPropagation()}>
            <h3 style={{ color: tokens.colors.textPrimary, fontSize: '16px', marginBottom: 16 }}>Create Workspace</h3>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              placeholder="Workspace name"
              style={{
                width: '100%', padding: '10px 12px', borderRadius: tokens.radii.lg,
                background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
                color: tokens.colors.textStrong, fontSize: '14px', marginBottom: 8, boxSizing: 'border-box',
              }}
            />
            <input
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              placeholder="Description (optional)"
              style={{
                width: '100%', padding: '10px 12px', borderRadius: tokens.radii.lg,
                background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
                color: tokens.colors.textStrong, fontSize: '14px', marginBottom: 8, boxSizing: 'border-box',
              }}
            />
            <input
              value={newBoardName}
              onChange={e => setNewBoardName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              placeholder={newName ? `${newName} Board` : 'Board name (optional)'}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: tokens.radii.lg,
                background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
                color: tokens.colors.textStrong, fontSize: '14px', marginBottom: 16, boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowCreate(false)} style={{
                padding: '8px 16px', borderRadius: tokens.radii.lg, background: tokens.colors.border,
                border: 'none', color: tokens.colors.textSecondary, fontSize: '13px', cursor: 'pointer',
              }}>Cancel</button>
              <button onClick={handleCreate} style={{
                padding: '8px 16px', borderRadius: tokens.radii.lg, background: tokens.colors.accent,
                border: 'none', color: 'white', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
              }}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEdit && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
        }} onClick={() => setShowEdit(false)}>
          <div style={{
            background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.xl,
            padding: 24, minWidth: 360, boxShadow: tokens.shadows.modal,
          }} onClick={e => e.stopPropagation()}>
            <h3 style={{ color: tokens.colors.textPrimary, fontSize: '16px', marginBottom: 16 }}>Edit Workspace</h3>
            <input
              autoFocus
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleEdit()}
              placeholder="Workspace name"
              style={{
                width: '100%', padding: '10px 12px', borderRadius: tokens.radii.lg,
                background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
                color: tokens.colors.textStrong, fontSize: '14px', marginBottom: 8, boxSizing: 'border-box',
              }}
            />
            <input
              value={editDesc}
              onChange={e => setEditDesc(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleEdit()}
              placeholder="Description (optional)"
              style={{
                width: '100%', padding: '10px 12px', borderRadius: tokens.radii.lg,
                background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
                color: tokens.colors.textStrong, fontSize: '14px', marginBottom: 8, boxSizing: 'border-box',
              }}
            />
            <input
              value={editBoardName}
              onChange={e => setEditBoardName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleEdit()}
              placeholder={editName ? `${editName} Board` : 'Board name'}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: tokens.radii.lg,
                background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
                color: tokens.colors.textStrong, fontSize: '14px', marginBottom: 16, boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowEdit(false)} style={{
                padding: '8px 16px', borderRadius: tokens.radii.lg, background: tokens.colors.border,
                border: 'none', color: tokens.colors.textSecondary, fontSize: '13px', cursor: 'pointer',
              }}>Cancel</button>
              <button onClick={handleEdit} style={{
                padding: '8px 16px', borderRadius: tokens.radii.lg, background: tokens.colors.accent,
                border: 'none', color: 'white', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
              }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
