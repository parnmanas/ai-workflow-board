import React, { useState, useEffect, useCallback } from 'react';
import { Outlet, useNavigate, useParams, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import WorkspaceSelector from './WorkspaceSelector';
import ViewModeToggle from './ViewModeToggle';
import { useViewMode } from '../contexts/ViewModeContext';
import { ArtifactPanelProvider } from '../contexts/ArtifactPanelContext';
import ArtifactPanel, { ArtifactToggleButton } from './ArtifactPanel';
import TicketArtifactController from './TicketArtifactController';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useWorkspaces } from '../hooks/useBoard';
import { api, setActiveWorkspaceId } from '../api';
import { BoardStreamProvider } from '../contexts/BoardStreamContext';
import { NotificationProvider } from '../contexts/NotificationContext';
import { TicketMetaProvider } from '../contexts/TicketMetaContext';
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
  const { mode } = useViewMode();
  // 드로어 모드: 모바일(항상) + 데스크톱 Chat-first. 이때 사이드바는 햄버거로 여는
  // off-canvas 오버레이가 되어 Chat-first 에 깔끔한 대화 캔버스를 준다. Advanced
  // 데스크톱은 drawerMode=false → 기존 상시 사이드바 그대로(회귀 0).
  const drawerMode = isMobile || mode === 'chat';
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();
  const params = useParams<{ wsId?: string }>();
  const location = useLocation();
  const isAdminRoute = location.pathname.startsWith('/admin');

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
    // Preserve the current top-level menu (boards / chat / agents / users / ...)
    // when switching workspaces. Deeper segments (e.g. boards/:boardId,
    // agents/:agentId) are scoped to the old workspace and won't resolve in
    // the new one, so we keep only the first segment after /ws/:wsId/.
    const m = location.pathname.match(/^\/ws\/[^/]+\/([^/]+)/);
    const section = m?.[1] ?? 'boards';
    navigate(`/ws/${wsId}/${section}`);
  }, [navigate, location.pathname]);

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

  // 드로어 모드를 벗어나면(Chat→Advanced 전환, 데스크톱 확대 등) 열린 드로어를 닫는다.
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
    <div className="awb-shell">
      <Sidebar
        overlay={drawerMode}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        wsId={urlWsId}
        boards={sidebarBoards}
      />
      {drawerMode && drawerOpen && (
        <div
          className="awb-sidebar-backdrop"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="awb-main">
        {/* 드로어 모드 톱바(모바일 상시 + 데스크톱 Chat-first) — 햄버거로 사이드바의
            기존 전체 네비 인벤토리(Boards/Chat/Agents/…)를 오버레이로 연다. */}
        {drawerMode && (
          <div className="awb-topbar">
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
            {/* 데스크톱 Chat-first 는 상시 톱스트립이 없으므로 여기서 워크스페이스 전환을
                유지한다. 모바일은 폭 절약을 위해 기존대로 셀렉터를 톱바에 넣지 않는다. */}
            {!isMobile && !isAdminRoute && (
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

        {/* Advanced 데스크톱 상시 톱스트립 — WorkspaceSelector(writer)를 소유. admin
            라우트에선 숨김(ws 컨텍스트 없음). Chat-first·모바일에선 위 드로어 톱바가
            대신하므로 여기선 렌더하지 않는다(!drawerMode). */}
        {!drawerMode && !isAdminRoute && (
          <div
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
            <ViewModeToggle />
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
