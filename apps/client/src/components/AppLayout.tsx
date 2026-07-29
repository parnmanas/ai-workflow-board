import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Outlet, useNavigate, useParams, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useDialogFocus } from './useDialogFocus';
import WorkspaceSelector from './WorkspaceSelector';
import ViewModeToggle from './ViewModeToggle';
import { useViewMode } from '../contexts/ViewModeContext';
import { ArtifactPanelProvider } from '../contexts/ArtifactPanelContext';
import ArtifactPanel, { ArtifactToggleButton } from './ArtifactPanel';
import TicketArtifactController from './TicketArtifactController';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useWorkspaces } from '../hooks/useBoard';
import { api, setActiveWorkspaceId, bootstrapActiveWorkspaceId } from '../api';
import { BoardStreamProvider } from '../contexts/BoardStreamContext';
import { NotificationProvider } from '../contexts/NotificationContext';
import { TicketMetaProvider } from '../contexts/TicketMetaContext';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';
import type { ChatRoomListItem } from '../types';

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
  const { mode } = useViewMode();
  // Desktop keeps the Hermes-style navigation visible in both Chat and
  // Advanced modes. Only narrow mobile viewports use the off-canvas drawer.
  const drawerMode = isMobile;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();
  const params = useParams<{ wsId?: string }>();
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith('/admin');
  const { currentWorkspaceId: authWorkspaceId, setCurrentWorkspace: setAuthWorkspace } = useAuth();

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

  // Seeded from the same URL→sessionStorage→localStorage bootstrap api.ts uses
  // for the X-Workspace-Id header, not localStorage alone — otherwise this tab's
  // state could disagree with its own per-tab active workspace right from mount
  // (ticket dc5c0813, see bootstrapActiveWorkspaceId's doc comment).
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(() => bootstrapActiveWorkspaceId());

  const [currentBoardId, setCurrentBoardId] = useState<string | null>(null);
  const [currentBoardName, setCurrentBoardName] = useState<string | undefined>(undefined);
  const [sidebarBoards, setSidebarBoards] = useState<{ id: string; name: string }[]>([]);
  const [sidebarRooms, setSidebarRooms] = useState<ChatRoomListItem[]>([]);
  const [sidebarRoomsLoading, setSidebarRoomsLoading] = useState(false);

  // URL wsId takes precedence for sidebar context
  const urlWsId = params.wsId || currentWorkspaceId;

  // ── Single-source-of-truth sync: URL → state → per-tab active workspace ──
  //
  // currentWorkspaceId used to live in 3 places (localStorage header
  // source, AppLayout state, AuthContext state) that drifted apart on
  // URL-initiated changes (bookmark load, browser back, sidebar click
  // while on a non-ws route, etc). Symptom: WorkspaceSelector dropdown
  // showed workspace A while the page showed B, and writes (create
  // agent, etc.) landed in whichever workspace localStorage happened
  // to hold.
  //
  // Fix: whenever the URL carries a wsId, force local state + per-tab
  // active workspace to agree with it. localStorage is also written so
  // a fresh tab opened later can recover the last workspace as a default,
  // but localStorage is no longer consulted at request time — each tab
  // owns its own X-Workspace-Id (see api.ts setActiveWorkspaceId).
  useEffect(() => {
    if (params.wsId && params.wsId !== currentWorkspaceId) {
      setCurrentWorkspaceId(params.wsId);
      try { localStorage.setItem('currentWorkspaceId', params.wsId); } catch {}
    }
  }, [params.wsId, currentWorkspaceId]);

  // Keep the api module's per-tab active workspace in lockstep with our
  // state so every API call (and any code that reads getActiveWorkspaceId)
  // sees the workspace the tab is actually rendering. Runs on mount too,
  // so the bootstrap value (URL → sessionStorage → localStorage) is
  // promoted to state-driven authority once React is in control.
  useEffect(() => {
    setActiveWorkspaceId(currentWorkspaceId);
  }, [currentWorkspaceId]);

  // AuthContext also exposes a currentWorkspaceId (read by ViewModeToggle's
  // Chat/Advanced toggle, the legacy WorkspacedRedirect/WorkspaceDefaultRedirect
  // routes, and NotificationContext's unread-badge fetch), but its only setter
  // (setCurrentWorkspace) is called exclusively from the login workspace picker.
  // That left it as the one drift source the sync above (comment block up top)
  // never closed: switching workspaces from the top nav updated everything
  // except this, so those consumers kept acting on the workspace active at
  // login. Mirror our authoritative currentWorkspaceId into it too (티켓 28258c75).
  useEffect(() => {
    if (currentWorkspaceId && currentWorkspaceId !== authWorkspaceId) {
      setAuthWorkspace(currentWorkspaceId);
    }
  }, [currentWorkspaceId, authWorkspaceId, setAuthWorkspace]);

  // Auto-select first workspace if none saved AND the URL doesn't already
  // dictate one. Without the URL check this effect would fight the
  // sync-from-URL effect above on admin routes where params.wsId is
  // undefined but a saved workspace should persist.
  useEffect(() => {
    if (params.wsId) return;
    if (workspaces.length > 0 && !currentWorkspaceId) {
      const first = workspaces[0].id;
      setCurrentWorkspaceId(first);
      try { localStorage.setItem('currentWorkspaceId', first); } catch {}
    }
  }, [workspaces, currentWorkspaceId, params.wsId]);

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

  const fetchSidebarRooms = useCallback(async (wsId: string) => {
    setSidebarRoomsLoading(true);
    try {
      const rooms = await api.listChatRooms(undefined, wsId);
      setSidebarRooms(rooms);
    } catch {
      setSidebarRooms([]);
    } finally {
      setSidebarRoomsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!currentWorkspaceId) {
      setSidebarRooms([]);
      setSidebarRoomsLoading(false);
      return;
    }
    fetchSidebarRooms(currentWorkspaceId);

    // The Sidebar intentionally does not own an EventSource. A low-frequency
    // fallback keeps room metadata fresh while other pages are open, and
    // ChatPage pushes immediate snapshots through chat-rooms-changed.
    const timer = window.setInterval(() => fetchSidebarRooms(currentWorkspaceId), 30_000);
    const handleRoomChange = (event: Event) => {
      const detail = (event as CustomEvent<{
        workspaceId?: string;
        rooms?: ChatRoomListItem[];
      }>).detail;
      if (detail?.workspaceId !== currentWorkspaceId) return;
      if (Array.isArray(detail.rooms)) {
        setSidebarRooms(detail.rooms);
        setSidebarRoomsLoading(false);
      } else {
        fetchSidebarRooms(currentWorkspaceId);
      }
    };
    window.addEventListener('chat-rooms-changed', handleRoomChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('chat-rooms-changed', handleRoomChange);
    };
  }, [currentWorkspaceId, fetchSidebarRooms]);

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
    // Admin 화면은 workspace 비종속(글로벌) 화면이므로 전환 시 그대로 유지하고
    // 이동하지 않는다 — currentWorkspaceId 상태만 갱신해 이후 workspace-scoped
    // 화면으로 이동할 때 새 workspace 를 사용하도록 한다.
    if (isAdminRoute) return;
    // Preserve the current top-level menu (boards / chat / agents / users / ...)
    // when switching workspaces. Deeper segments (e.g. boards/:boardId,
    // agents/:agentId) are scoped to the old workspace and won't resolve in
    // the new one, so we keep only the first segment after /ws/:wsId/.
    const m = location.pathname.match(/^\/ws\/[^/]+\/([^/]+)/);
    const section = m?.[1] ?? 'boards';
    navigate(`/ws/${wsId}/${section}`);
  }, [navigate, location.pathname, isAdminRoute]);

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

  // 모바일 드로어 모드를 벗어나 데스크톱으로 확대되면 열린 드로어를 닫는다.
  useEffect(() => {
    if (!drawerMode) setDrawerOpen(false);
  }, [drawerMode]);

  // Escape 로 드로어 닫기
  useEffect(() => {
    if (!drawerMode || !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerMode, drawerOpen]);

  // 드로어(off-canvas 네비)의 초기 포커스·Tab 트랩·opener(햄버거) 복귀를 Modal/Artifact
  // 패널과 동일한 공용 훅으로 통일한다(F2-5). 열리면 사이드바 내 첫 포커스 요소로 이동,
  // Tab 은 사이드바 안에 갇히고, 닫히면 열었던 햄버거 버튼으로 포커스가 되돌아온다.
  const drawerRef = useRef<HTMLElement>(null);
  useDialogFocus({ active: drawerMode && drawerOpen, trap: true, containerRef: drawerRef });

  return (
    // BoardStreamProvider wraps the whole authenticated shell (Sidebar + main)
    // because Sidebar now subscribes to `user_mention` SSE events for the unread
    // badge. The provider itself is a singleton — moving it up does NOT add an
    // extra EventSource connection. ArtifactPanelProvider(에픽 bf65ca00 S1)는 셸
    // 하나만 마운트해 채팅 카드(S2/S3)가 우측 패널을 구동하게 한다.
    <BoardStreamProvider>
    <NotificationProvider>
    <ArtifactPanelProvider>
    <TicketMetaProvider>
    <TicketArtifactController>
    <div className="awb-shell" data-testid="app-shell">
      <Sidebar
        overlay={drawerMode}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        wsId={urlWsId}
        boards={sidebarBoards}
        rooms={sidebarRooms}
        roomsLoading={sidebarRoomsLoading}
        containerRef={drawerRef}
      />
      {drawerMode && drawerOpen && (
        <div
          className="awb-sidebar-backdrop"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="awb-main">
        {/* 모바일 톱바 — 햄버거로 전체 내비게이션을 오버레이로 연다. */}
        {drawerMode && (
          <div className="awb-topbar" data-testid="app-header">
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
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
            <div style={{ flex: 1 }} />
            {/* 모바일은 폭 절약을 위해 워크스페이스 셀렉터를 표시하지 않는다. */}
            {!isMobile && (
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
            )}
            {mode === 'chat' && <ArtifactToggleButton />}
            <ViewModeToggle />
          </div>
        )}

        {/* Desktop top bar stays compact because primary navigation lives in
            the persistent Sidebar. It retains workspace switching, the Chat
            artifact toggle, and the Chat/Advanced mode control. */}
        {!drawerMode && (
          <div
            data-testid="app-header"
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '8px 24px',
              borderBottom: `1px solid ${tokens.colors.border}`,
              background: tokens.colors.surface,
              flexShrink: 0,
              justifyContent: 'space-between',
              gap: 12,
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {mode === 'chat' && <ArtifactToggleButton />}
              <ViewModeToggle />
            </div>
          </div>
        )}

        <main className="awb-content">
          <Outlet />
        </main>
      </div>
      {/* 우측 Artifact 패널 — 데스크톱은 본문 옆 영역, 모바일은 오버레이 시트.
          닫혀 있으면 null 을 반환해 레이아웃에 영향 없음. */}
      <ArtifactPanel isMobile={isMobile} />
    </div>
    </TicketArtifactController>
    </TicketMetaProvider>
    </ArtifactPanelProvider>
    </NotificationProvider>
    </BoardStreamProvider>
  );
}
