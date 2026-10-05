import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useDialogFocus } from './useDialogFocus';
import { ArtifactPanelProvider } from '../contexts/ArtifactPanelContext';
import ArtifactPanel, { ArtifactToggleButton } from './ArtifactPanel';
import TicketArtifactController from './TicketArtifactController';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { api } from '../api';
import { BoardStreamProvider } from '../contexts/BoardStreamContext';
import { NotificationProvider } from '../contexts/NotificationContext';
import { TicketMetaProvider } from '../contexts/TicketMetaContext';
import VoiceAnnouncer from '../voice/VoiceAnnouncer';
import WakeListener from '../voice/WakeListener';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';
import type { ChatRoomListItem } from '../types';

/**
 * Persistent authenticated-user shell — Phase 1 FOUND-03 / FOUND-04 / D-10.
 *
 * Renders the Sidebar and a React Router <Outlet /> for the nested child route.
 * Tickets, Sessions, Chat, Settings, and Admin are all nested under this layout.
 *
 * SSE Reconnect Contract (D-10 architectural intent):
 * This component owns the single authoritative real-time stream subscription
 * via <BoardStreamProvider>, which wraps the <Outlet />. Because AppLayout
 * remains mounted across nested-route changes, the underlying EventSource
 * stays alive while navigating Tickets → Stub → Tickets. No downstream component
 * may instantiate its own EventSource — subscribers pull events through
 * useBoardStream() / useBoardStreamEvent() instead.
 *
 * See .planning/phases/01-foundation/01-UI-SPEC.md §"SSE Reconnect Contract".
 */
export default function AppLayout() {
  const isMobile = useMediaQuery('(max-width: 767px)');
  // Desktop keeps the Hermes-style navigation visible. Only narrow mobile
  // viewports use the off-canvas drawer.
  const drawerMode = isMobile;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { currentAccountId } = useAuth();
  const [sidebarRooms, setSidebarRooms] = useState<ChatRoomListItem[]>([]);
  const [sidebarRoomsLoading, setSidebarRoomsLoading] = useState(false);

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
    if (!currentAccountId) {
      setSidebarRooms([]);
      setSidebarRoomsLoading(false);
      return;
    }
    fetchSidebarRooms(currentAccountId);

    // The Sidebar intentionally does not own an EventSource. A low-frequency
    // fallback keeps room metadata fresh while other pages are open, and
    // ChatPage pushes immediate snapshots through chat-rooms-changed.
    const timer = window.setInterval(() => fetchSidebarRooms(currentAccountId), 30_000);
    const handleRoomChange = (event: Event) => {
      const detail = (event as CustomEvent<{
        accountId?: string;
        rooms?: ChatRoomListItem[];
      }>).detail;
      if (Array.isArray(detail.rooms)) {
        setSidebarRooms(detail.rooms);
        setSidebarRoomsLoading(false);
      } else {
        fetchSidebarRooms(currentAccountId);
      }
    };
    window.addEventListener('chat-rooms-changed', handleRoomChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('chat-rooms-changed', handleRoomChange);
    };
  }, [currentAccountId, fetchSidebarRooms]);

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
    {/* 음성 알림 · 이름 부르기 — 화면을 그리지 않고 모든 화면에서 산다(docs/voice-operator.md). */}
    <VoiceAnnouncer />
    <WakeListener />
    <ArtifactPanelProvider>
    <TicketMetaProvider>
    <TicketArtifactController>
    <div className="awb-shell" data-testid="app-shell">
      <Sidebar
        overlay={drawerMode}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        wsId={currentAccountId}
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
            <ArtifactToggleButton />
          </div>
        )}

        {/* Work navigation is global; ownership is managed in Settings. */}
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
            <span style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.textPrimary }}>AWB</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ArtifactToggleButton />
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
