import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import PageHeader from './PageHeader';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';
import { Modal, Input, Button, Card, ConfirmDialog } from './common';

export default function BoardsIndexPage() {
  const { wsId } = useParams<{ wsId: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const isAdmin = hasPermission('admin.access');

  const [boards, setBoards] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Archived boards state
  const [showArchived, setShowArchived] = useState(false);
  const [archivedBoards, setArchivedBoards] = useState<any[]>([]);
  const [loadingArchived, setLoadingArchived] = useState(false);

  // Inline create form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Archive dialog state
  const [archiveTarget, setArchiveTarget] = useState<any | null>(null);

  // Rename modal state
  const [renamingBoard, setRenamingBoard] = useState<any | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    if (!wsId) return;
    setLoading(true);
    api.getBoards(wsId).then(data => {
      setBoards(data);
      setLoading(false);
    }).catch(() => {
      setError('Could not load boards. Refresh the page or contact your admin.');
      setLoading(false);
    });
  }, [wsId]);

  const handleCreate = async () => {
    if (!createName.trim() || !wsId) return;
    setIsCreating(true);
    try {
      const newBoard = await api.createBoard({
        name: createName.trim(),
        description: createDescription.trim() || undefined,
        workspace_id: wsId,
      });
      setShowCreateForm(false);
      setCreateName('');
      setCreateDescription('');
      window.dispatchEvent(new Event('boards-changed'));
      navigate(`/ws/${wsId}/boards/${newBoard.id}`);
    } catch {
      setError('Failed to create board.');
    } finally {
      setIsCreating(false);
    }
  };

  const loadArchivedBoards = async () => {
    if (!wsId) return;
    setLoadingArchived(true);
    try {
      const all = await api.getArchivedBoards(wsId);
      setArchivedBoards(all.filter((b: any) => b.archived_at));
    } catch {
      setError('Failed to load archived boards.');
    } finally {
      setLoadingArchived(false);
    }
  };

  const handleToggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    if (next && archivedBoards.length === 0) {
      loadArchivedBoards();
    }
  };

  const handleRestore = async (board: any) => {
    try {
      await api.restoreBoard(board.id);
      setArchivedBoards(prev => prev.filter(b => b.id !== board.id));
      setBoards(prev => [...prev, { ...board, archived_at: null }]);
      window.dispatchEvent(new Event('boards-changed'));
    } catch {
      setError('Failed to restore board.');
    }
  };

  // Pause / Resume — toggles the same Board.paused_at field on the server.
  // Optimistic update keeps the card label flipping snappy; on failure we
  // surface the error and the next page load reconciles state.
  const handlePauseToggle = async (board: any) => {
    const willPause = !board.paused_at;
    try {
      const updated = willPause ? await api.pauseBoard(board.id) : await api.resumeBoard(board.id);
      setBoards(prev => prev.map(b => b.id === board.id ? { ...b, paused_at: updated.paused_at } : b));
    } catch {
      setError(willPause ? 'Failed to pause board.' : 'Failed to resume board.');
    }
  };

  const openRename = (board: any) => {
    setRenamingBoard(board);
    setRenameValue(board.name);
  };

  const submitRename = async () => {
    if (!renamingBoard || !renameValue.trim() || renameValue.trim() === renamingBoard.name) return;
    try {
      await api.updateBoard(renamingBoard.id, { name: renameValue.trim() });
      setBoards(prev => prev.map(b => b.id === renamingBoard.id ? { ...b, name: renameValue.trim() } : b));
      window.dispatchEvent(new Event('boards-changed'));
    } catch {
      setError('Failed to rename board.');
    }
    setRenamingBoard(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title="Boards"
        actions={
          <Button variant="primary" size="md" onClick={() => setShowCreateForm(true)}>New Board</Button>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {error && (
          <div style={{ color: tokens.colors.danger, fontSize: 13, marginBottom: 16 }}>{error}</div>
        )}

        {/* Loading state */}
        {loading && (
          <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>Loading boards…</div>
        )}

        {/* Empty state */}
        {!loading && boards.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 24px' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary }}>No boards yet</h2>
            <p style={{ fontSize: 13, color: tokens.colors.textSecondary, marginTop: 8 }}>
              Create your first board to start organizing work.
            </p>
          </div>
        )}

        {/* Board card grid */}
        {!loading && boards.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 16,
          }}>
            {boards.map(board => (
              <Card
                key={board.id}
                onClick={() => navigate(`/ws/${wsId}/boards/${board.id}`)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: tokens.colors.textPrimary }}>
                    {board.name}
                  </div>
                  {board.paused_at && (
                    <span
                      title={`Paused since ${new Date(board.paused_at).toLocaleString()}`}
                      style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
                        textTransform: 'uppercase',
                        padding: '2px 6px', borderRadius: 4,
                        background: tokens.colors.warning,
                        color: '#fff',
                      }}
                    >⏸ Paused</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>
                  {board.description || 'No description'}
                </div>
                <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); openRename(board); }}
                  >Rename</Button>
                  <Button
                    variant={board.paused_at ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); handlePauseToggle(board); }}
                  >{board.paused_at ? 'Resume' : 'Pause'}</Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); setArchiveTarget(board); }}
                  >Archive</Button>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* Admin-only: Archived Boards section */}
        {isAdmin && !loading && (
          <div style={{ borderTop: `1px solid ${tokens.colors.border}`, marginTop: 24, paddingTop: 16 }}>
            <div
              onClick={handleToggleArchived}
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
            >
              <span style={{
                fontSize: 11, fontWeight: 700, color: tokens.colors.borderStrong,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                Archived Boards
              </span>
              <span style={{ fontSize: 10, color: tokens.colors.borderStrong }}>
                {showArchived ? '\u25BC' : '\u25B6'}
              </span>
              {showArchived && !loadingArchived && (
                <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
                  ({archivedBoards.length})
                </span>
              )}
            </div>

            {showArchived && loadingArchived && (
              <div style={{ color: tokens.colors.textSecondary, fontSize: 13, marginTop: 12 }}>
                Loading archived boards...
              </div>
            )}

            {showArchived && !loadingArchived && archivedBoards.length === 0 && (
              <div style={{ color: tokens.colors.textMuted, fontSize: 13, marginTop: 12 }}>
                No archived boards
              </div>
            )}

            {showArchived && !loadingArchived && archivedBoards.length > 0 && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                gap: 16,
                marginTop: 12,
              }}>
                {archivedBoards.map(board => (
                  <Card key={board.id} style={{ opacity: 0.7 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 4 }}>
                      {board.name}
                    </div>
                    <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6 }}>
                      Archived: {new Date(board.archived_at).toLocaleString()}
                    </div>
                    {board.description && (
                      <div style={{ fontSize: 13, color: tokens.colors.textSecondary, marginBottom: 8 }}>
                        {board.description}
                      </div>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => handleRestore(board)}>Restore Board</Button>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Archive confirm dialog */}
      {archiveTarget && (
        <ConfirmDialog
          isOpen={true}
          requireName={archiveTarget.name}
          title="Archive this board?"
          message={`Type ${archiveTarget.name} to confirm`}
          confirmLabel="Archive Board"
          onConfirm={async () => {
            try {
              await api.archiveBoard(archiveTarget.id);
              setBoards(prev => prev.filter(b => b.id !== archiveTarget.id));
              setArchiveTarget(null);
              window.dispatchEvent(new Event('boards-changed'));
            } catch {
              setError('Failed to archive board.');
              setArchiveTarget(null);
            }
          }}
          onCancel={() => setArchiveTarget(null)}
        />
      )}

      {/* Create board modal */}
      <Modal
        isOpen={showCreateForm}
        onClose={() => { setShowCreateForm(false); setCreateName(''); setCreateDescription(''); }}
        title="Create Board"
        maxWidth={400}
        footer={
          <>
            <Button variant="secondary" onClick={() => { setShowCreateForm(false); setCreateName(''); setCreateDescription(''); }}>Cancel</Button>
            <Button variant="primary" disabled={!createName.trim() || isCreating} loading={isCreating} onClick={handleCreate}>
              {isCreating ? 'Creating…' : 'Create Board'}
            </Button>
          </>
        }
      >
        <Input
          label="Board Name"
          value={createName}
          onChange={e => setCreateName(e.target.value)}
          placeholder="Board name"
          autoFocus
        />
        <div style={{ marginTop: 12 }}>
          <Input
            label="Description"
            value={createDescription}
            onChange={e => setCreateDescription(e.target.value)}
            placeholder="Description (optional)"
          />
        </div>
      </Modal>

      {/* Rename board modal */}
      <Modal
        isOpen={!!renamingBoard}
        onClose={() => setRenamingBoard(null)}
        title="Rename Board"
        maxWidth={400}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenamingBoard(null)}>Cancel</Button>
            <Button variant="primary" onClick={submitRename}>Save</Button>
          </>
        }
      >
        <Input
          label="Board Name"
          value={renameValue}
          onChange={e => setRenameValue(e.target.value)}
          placeholder="Enter board name"
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') submitRename(); }}
        />
      </Modal>
    </div>
  );
}
