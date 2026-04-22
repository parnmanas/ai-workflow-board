import React, { useState, useEffect, useCallback } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import Sidebar from './Sidebar';
import WorkspaceSelector from './WorkspaceSelector';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useWorkspaces } from '../hooks/useBoard';
import { api } from '../api';
import { BoardStreamProvider } from '../contexts/BoardStreamContext';
import { NotificationProvider } from '../contexts/NotificationContext';
import WorkspaceBanner from './WorkspaceBanner';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';

/**
 * Persistent authenticated-user shell — Phase 1 FOUND-03 / FOUND-04 / D-10.
 *
 * Renders the Sidebar and a React Router <Outlet /> for the nested child route.
 * Board, Dashboard, Chat, Settings, and Admin are all nested under this layout.
 *
 * SSE Reconnect Contract (D-10 architectural intent):
 * This component owns the single authoritative real-time stream subscription
 * via <BoardStreamProvider>, which wraps the <Outlet />. Because AppLayout
 * remains mounted across nested-route changes, the underlying EventSource
 * stays alive while navigating Board → Stub → Board. No downstream component
 * may instantiate its own EventSource — subscribers pull events through
 * useBoardStream() / useBoardStreamEvent() instead.
 *
 * See .planning/phases/01-foundation/01-UI-SPEC.md §"SSE Reconnect Contract".
 */
export default function AppLayout() {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const params = useParams<{ wsId?: string }>();
  const { user } = useAuth();

  // Workspace state — AppLayout is the single writer to localStorage.currentWorkspaceId.
  // Workspace changes navigate to /ws/:wsId/boards via React Router instead of
  // dispatching CustomEvents — URL is now the source of truth for workspace context.
  const {
    workspaces,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    refresh: refreshWorkspaces,
  } = useWorkspaces();

  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('currentWorkspaceId');
  });

  const [currentBoardId, setCurrentBoardId] = useState<string | null>(null);
  const [currentBoardName, setCurrentBoardName] = useState<string | undefined>(undefined);
  const [sidebarBoards, setSidebarBoards] = useState<{ id: string; name: string }[]>([]);

  // URL wsId takes precedence for sidebar context
  const urlWsId = params.wsId || currentWorkspaceId;

  // Derive current workspace object for WorkspaceBanner
  const currentWorkspace = workspaces.find(w => w.id === currentWorkspaceId) ?? null;

  // Auto-select first workspace if none saved
  useEffect(() => {
    if (workspaces.length > 0 && !currentWorkspaceId) {
      const first = workspaces[0].id;
      setCurrentWorkspaceId(first);
      try { localStorage.setItem('currentWorkspaceId', first); } catch {}
    }
  }, [workspaces, currentWorkspaceId]);

  // Track boards for sidebar + WorkspaceSelector edit UX
  const fetchBoards = useCallback((wsId: string) => {
    let cancelled = false;
    api.getBoards(wsId).then((boards) => {
      if (cancelled) return;
      const activeBoards = boards.filter((b: any) => !b.archived_at);
      setSidebarBoards(activeBoards.map((b: any) => ({ id: b.id, name: b.name })));
      if (boards.length > 0) {
        setCurrentBoardId(boards[0].id);
        setCurrentBoardName(boards[0].name);
      } else {
        setCurrentBoardId(null);
        setCurrentBoardName(undefined);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!currentWorkspaceId) {
      setCurrentBoardId(null);
      setCurrentBoardName(undefined);
      setSidebarBoards([]);
      return;
    }
    return fetchBoards(currentWorkspaceId);
  }, [currentWorkspaceId, fetchBoards]);

  // Refresh sidebar boards when boards are created/deleted/updated
  useEffect(() => {
    const handleBoardRefresh = () => {
      if (currentWorkspaceId) fetchBoards(currentWorkspaceId);
    };
    window.addEventListener('boards-changed', handleBoardRefresh);
    return () => window.removeEventListener('boards-changed', handleBoardRefresh);
  }, [currentWorkspaceId, fetchBoards]);

  const handleSelectWorkspace = useCallback((wsId: string) => {
    setCurrentWorkspaceId(wsId);
    try { localStorage.setItem('currentWorkspaceId', wsId); } catch {}
    navigate(`/ws/${wsId}/boards`);
  }, [navigate]);

  const handleCreateWorkspace = useCallback(async (name: string, description?: string, boardName?: string) => {
    const ws = await createWorkspace(name, description, boardName);
    if (ws?.id) {
      setCurrentWorkspaceId(ws.id);
      try { localStorage.setItem('currentWorkspaceId', ws.id); } catch {}
      navigate(`/ws/${ws.id}/boards`);
    }
  }, [createWorkspace, navigate]);

  const handleUpdateWorkspace = useCallback(async (id: string, data: { name?: string; description?: string }) => {
    await updateWorkspace(id, data);
  }, [updateWorkspace]);

  const handleDeleteWorkspace = useCallback(async (wsId: string) => {
    await deleteWorkspace(wsId);
    if (wsId === currentWorkspaceId) {
      // Use the fresh list returned by refreshWorkspaces to avoid stale closure over workspaces state
      const updated = await refreshWorkspaces();
      const next = (updated || []).filter(w => w.id !== wsId)[0]?.id ?? null;
      setCurrentWorkspaceId(next);
      if (next) {
        try { localStorage.setItem('currentWorkspaceId', next); } catch {}
        navigate(`/ws/${next}/boards`);
      }
    }
  }, [deleteWorkspace, refreshWorkspaces, currentWorkspaceId, navigate]);

  const handleUpdateBoard = useCallback(async (boardId: string, data: { name?: string }) => {
    await api.updateBoard(boardId, data);
    if (data.name) setCurrentBoardName(data.name);
  }, []);

  // Reset mobile open state whenever we cross the breakpoint
  useEffect(() => {
    if (!isMobile) setMobileOpen(false);
  }, [isMobile]);

  // Escape closes the mobile drawer
  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile, mobileOpen]);

  return (
    // BoardStreamProvider wraps the whole authenticated shell (Sidebar + main)
    // because Sidebar now subscribes to `user_mention` SSE events for the unread
    // badge. The provider itself is a singleton — moving it up does NOT add an
    // extra EventSource connection.
    <BoardStreamProvider>
    <NotificationProvider>
    <div className="awb-shell">
      <Sidebar
        isMobile={isMobile}
        isOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        wsId={urlWsId}
        boards={sidebarBoards}
      />
      {isMobile && mobileOpen && (
        <div
          className="awb-sidebar-backdrop"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="awb-main">
        {/* Mobile top bar — visible only < 768px via media query display rules */}
        <div className="awb-topbar">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            style={{
              width: 44,
              height: 44,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            {/* Three horizontal bars */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ width: 20, height: 2, background: tokens.colors.textSecondary, borderRadius: 1 }} />
              <div style={{ width: 20, height: 2, background: tokens.colors.textSecondary, borderRadius: 1 }} />
              <div style={{ width: 20, height: 2, background: tokens.colors.textSecondary, borderRadius: 1 }} />
            </div>
          </button>
          <div style={{ fontSize: '15px', fontWeight: 700, color: tokens.colors.textPrimary }}>AWB</div>
        </div>

        {/* Desktop-only global top strip — owns WorkspaceSelector (writer).
            Lives OUTSIDE BoardStreamProvider so workspace switching does not
            tear down the SSE stream (the provider manages its own per-board
            subscription logic). */}
        {!isMobile && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '8px 24px',
              borderBottom: `1px solid ${tokens.colors.border}`,
              background: tokens.colors.surface,
              flexShrink: 0,
            }}
          >
            <WorkspaceSelector
              workspaces={workspaces}
              currentWorkspaceId={currentWorkspaceId}
              currentBoardName={currentBoardName}
              currentBoardId={currentBoardId}
              onSelect={handleSelectWorkspace}
              onCreate={handleCreateWorkspace}
              onDelete={handleDeleteWorkspace}
              onUpdate={handleUpdateWorkspace}
              onUpdateBoard={handleUpdateBoard}
            />
          </div>
        )}

        {/* Admin workspace context banner — shown when an admin is operating in a specific workspace */}
        {user?.role === 'admin' && currentWorkspaceId && currentWorkspace && (
          <WorkspaceBanner workspaceName={currentWorkspace.name} />
        )}

        <main className="awb-content">
          <Outlet />
        </main>
      </div>
    </div>
    </NotificationProvider>
    </BoardStreamProvider>
  );
}
