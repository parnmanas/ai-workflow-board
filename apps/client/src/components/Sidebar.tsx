import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';
import { MentionInboxBadge } from './common/MentionInboxBadge';
import { NavBadge } from './common/NavBadge';
import { NotificationSettingsPanel } from './common/NotificationSettingsPanel';
import { useNotifications } from '../contexts/NotificationContext';

interface SidebarProps {
  /**
   * true → off-canvas 드로어(햄버거로 여닫음), false → 본문 옆 상시 사이드바.
   * AppLayout 이 drawerMode(모바일 상시 + 데스크톱 Chat-first)일 때 true 로 넘긴다
   * (에픽 bf65ca00 · S1). Advanced 데스크톱은 false → 기존 상시 사이드바 그대로.
   */
  overlay: boolean;
  isOpen: boolean;
  onClose: () => void;
  wsId: string | null;
  boards: { id: string; name: string }[];
  /** 드로어(overlay) 포커스 트랩용 컨테이너 ref — AppLayout 의 useDialogFocus 가 소유(F2-5). */
  containerRef?: React.Ref<HTMLElement>;
}

/**
 * Responsive left sidebar — Phase 1 FOUND-03 / D-12 / D-13.
 *
 * overlay=false (Advanced 데스크톱): 본문 옆 상시 220px 사이드바.
 * overlay=true (모바일 · Chat-first 데스크톱): off-canvas 드로어; open 상태는
 * 부모(AppLayout)가 isOpen 으로 제어하고, 항목 클릭 시 onClose 로 접힌다.
 *
 * Three sections:
 *  - BOARDS: collapsible list of workspace boards with active board sub-entry
 *  - WORKSPACE: resource links (Chat, Users, Agents, etc.)
 *  - ADMIN: admin-only links, gated by hasPermission('admin.access')
 *
 * CRITICAL: This component MUST NOT import any real-time stream client or activity-bus
 * subscription per UI-SPEC §"SSE Reconnect Contract".
 */
export default function Sidebar({ overlay, isOpen, onClose, wsId, boards, containerRef }: SidebarProps) {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [boardsExpanded, setBoardsExpanded] = React.useState(true);
  // Badge counts come from NotificationContext (mounted in AppLayout). This
  // is a read-only consumer — we do not import any stream client here, per
  // the component header's SSE Reconnect Contract note.
  const { counts } = useNotifications();

  const isBoardActive = (boardId: string): boolean =>
    location.pathname.includes('/boards/' + boardId);

  const isPathActive = (path: string): boolean =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  const handleNavClick = (path: string) => {
    navigate(path);
    if (overlay) onClose();
  };

  // .awb-sidebar--overlay 가 붙으면 off-canvas 위치/transform 은 main.tsx 의 클래스
  // 규칙이 담당한다(미디어쿼리 비의존 → 데스크톱 Chat-first 에서도 동일 동작).
  const sidebarClassName = [
    'awb-sidebar',
    overlay ? 'awb-sidebar--overlay' : '',
    overlay && isOpen ? 'awb-sidebar--open' : '',
  ].filter(Boolean).join(' ');
  const persistentStyle: React.CSSProperties = {
    width: 220,
    flexShrink: 0,
    background: tokens.colors.surfaceCard,
    borderRight: `1px solid ${tokens.colors.border}`,
    display: 'flex',
    flexDirection: 'column',
  };
  const overlayStyle: React.CSSProperties = {
    // 위치/transform/transition/width 은 .awb-sidebar--overlay(main.tsx)가 담당.
    background: tokens.colors.surfaceCard,
    borderRight: `1px solid ${tokens.colors.border}`,
    display: 'flex',
    flexDirection: 'column',
  };

  const sectionHeaderStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    color: tokens.colors.borderStrong,
    padding: '12px 16px 6px',
    letterSpacing: '0.05em',
    userSelect: 'none',
    textTransform: 'uppercase',
  };

  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: tokens.colors.border,
    margin: '8px 12px',
  };

  const navRowStyle = (active: boolean): React.CSSProperties => ({
    padding: '8px 16px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    fontSize: 13,
    color: active ? tokens.colors.textStrong : tokens.colors.textMuted,
    fontWeight: active ? 600 : 400,
    borderLeft: active ? `3px solid ${tokens.colors.accent}` : '3px solid transparent',
    background: active ? tokens.colors.border : 'transparent',
    width: '100%',
    border: 'none',
    borderRight: 'none',
    textAlign: 'left',
    fontFamily: 'inherit',
  });

  // Nav items annotated with a `badge` count pulled from NotificationContext.
  // undefined (or 0) renders nothing in <NavBadge>, so items without a source
  // just get no decoration. Keeping the mapping in the item definition makes
  // it easy to add a new badge source later — one line in one place.
  const workspaceNavItems: { key: string; path: string; label: string; icon: string; badge?: number }[] = [
    { key: 'chat',             path: `/ws/${wsId}/chat`,             label: 'Chat',             icon: 'C', badge: counts.chat.total },
    { key: 'users',            path: `/ws/${wsId}/users`,            label: 'Users',            icon: 'U' },
    { key: 'agents',           path: `/ws/${wsId}/agents`,           label: 'AI Agents',        icon: 'A' },
    { key: 'prompt-templates', path: `/ws/${wsId}/prompt-templates`, label: 'Prompt Templates', icon: 'P' },
    { key: 'resources',        path: `/ws/${wsId}/resources`,        label: 'Resources',        icon: 'R' },
    { key: 'actions',          path: `/ws/${wsId}/actions`,          label: 'Actions',          icon: 'N' },
    { key: 'credentials',      path: `/ws/${wsId}/credentials`,      label: 'Credentials',      icon: 'X' },
    { key: 'channels',         path: `/ws/${wsId}/channels`,         label: 'Channels',         icon: 'H' },
    { key: 'api-keys',         path: `/ws/${wsId}/api-keys`,         label: 'API Keys',         icon: 'K' },
    { key: 'roles',            path: `/ws/${wsId}/roles`,            label: 'Roles',            icon: 'O' },
  ];
  // Workspace Settings hosts the workspace-default agent harness — operator
  // surface, so it only renders for admins (the page itself also gates).
  if (hasPermission('admin.access')) {
    workspaceNavItems.push({ key: 'settings', path: `/ws/${wsId}/settings`, label: 'Settings', icon: 'S' });
  }

  const adminNavItems: { key: string; path: string; label: string; icon: string; badge?: number }[] = [
    { key: 'admin-users',    path: '/admin/users',    label: 'Users',       icon: 'U', badge: counts.pendingUsers },
    { key: 'admin-qa',      path: '/admin/qa',      label: 'QA Tests',    icon: 'Q' },
    { key: 'admin-logs',    path: '/admin/logs',    label: 'Server Logs', icon: 'L' },
    { key: 'admin-agent-logs', path: '/admin/agent-logs', label: 'Agent Logs',  icon: 'G', badge: counts.agentErrors },
    { key: 'admin-agent-manager', path: '/admin/agent-manager', label: 'Agent Manager', icon: 'M' },
    { key: 'admin-column-policies', path: '/admin/column-policies', label: 'Column Policies', icon: 'P' },
    { key: 'admin-global-credentials', path: '/admin/global-credentials', label: 'Global Credentials', icon: 'K' },
    { key: 'admin-settings', path: '/admin/settings', label: 'Settings',    icon: 'S' },
  ];

  const renderNavButton = (
    item: { key: string; path: string; label: string; icon: string; badge?: number },
    active: boolean,
  ) => (
    <button
      key={item.key}
      onClick={() => handleNavClick(item.path)}
      style={{
        ...navRowStyle(active),
        borderLeft: active ? `3px solid ${tokens.colors.accent}` : '3px solid transparent',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          (e.currentTarget as HTMLButtonElement).style.background = tokens.colors.surfaceHover;
          (e.currentTarget as HTMLButtonElement).style.color = tokens.colors.textDisabled;
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          (e.currentTarget as HTMLButtonElement).style.color = tokens.colors.textMuted;
        }
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: tokens.radii.md,
          background: active ? tokens.colors.accent : `${tokens.colors.border}60`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '12px',
          fontWeight: 700,
          color: active ? 'white' : tokens.colors.textSecondary,
          flexShrink: 0,
        }}
      >
        {item.icon}
      </div>
      <span style={{ flex: 1 }}>{item.label}</span>
      {typeof item.badge === 'number' && item.badge > 0 && (
        <NavBadge count={item.badge} />
      )}
    </button>
  );

  return (
    <aside
      ref={containerRef}
      className={sidebarClassName}
      style={overlay ? overlayStyle : persistentStyle}
      // 드로어 모드는 배경을 가리는 모달성 네비 — 스크린리더/포커스 트랩을 위해 dialog 로 표식.
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay ? true : undefined}
      aria-label={overlay ? '내비게이션' : undefined}
    >
      {/* Header */}
      <div style={{ padding: '20px 16px 16px', borderBottom: `1px solid ${tokens.colors.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: tokens.gradients.accent,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '18px',
              fontWeight: 700,
              color: 'white',
              flexShrink: 0,
            }}
          >
            W
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: '15px', fontWeight: 700, color: tokens.colors.textPrimary, lineHeight: 1.2 }}>AWB</div>
            <div style={{ fontSize: '11px', color: tokens.colors.textMuted, lineHeight: 1.4 }}>Workflow Board</div>
          </div>
          <MentionInboxBadge workspaceId={wsId} />
          <NotificationSettingsPanel />
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '8px 0', overflowY: 'auto' }}>

        {/* BOARDS section */}
        <div
          style={{
            ...sectionHeaderStyle,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span
            role="link"
            tabIndex={0}
            onClick={() => { navigate(`/ws/${wsId}/boards`); if (overlay) onClose(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { navigate(`/ws/${wsId}/boards`); if (overlay) onClose(); } }}
            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            BOARDS
            {counts.tickets.total > 0 && <NavBadge count={counts.tickets.total} />}
          </span>
          <span
            role="button"
            aria-expanded={boardsExpanded}
            tabIndex={0}
            onClick={() => setBoardsExpanded((v) => !v)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setBoardsExpanded((v) => !v); }}
            style={{ fontSize: 10, color: tokens.colors.borderStrong, cursor: 'pointer', padding: '2px 4px' }}
          >
            {boardsExpanded ? '\u25BC' : '\u25B6'}
          </span>
        </div>

        {boardsExpanded && (
          <>
            {boards.length === 0 ? (
              <div style={{ padding: '6px 16px', fontSize: 11, color: tokens.colors.textMuted }}>
                No boards — create one above
              </div>
            ) : (
              boards.map((b) => {
                const active = isBoardActive(b.id);
                return (
                  <React.Fragment key={b.id}>
                    <button
                      onClick={() => { navigate(`/ws/${wsId}/boards/${b.id}`); if (overlay) onClose(); }}
                      style={{
                        width: '100%',
                        padding: '8px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        cursor: 'pointer',
                        fontSize: 13,
                        color: active ? tokens.colors.textStrong : tokens.colors.textMuted,
                        fontWeight: active ? 600 : 400,
                        borderLeft: active ? `3px solid ${tokens.colors.accent}` : '3px solid transparent',
                        background: active ? tokens.colors.border : 'transparent',
                        border: 'none',
                        textAlign: 'left',
                        fontFamily: 'inherit',
                      }}
                      onMouseEnter={(e) => {
                        if (!active) {
                          (e.currentTarget as HTMLButtonElement).style.background = tokens.colors.surfaceHover;
                          (e.currentTarget as HTMLButtonElement).style.color = tokens.colors.textDisabled;
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!active) {
                          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                          (e.currentTarget as HTMLButtonElement).style.color = tokens.colors.textMuted;
                        }
                      }}
                    >
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: tokens.radii.md,
                          background: active ? tokens.colors.accent : `${tokens.colors.border}60`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '12px',
                          fontWeight: 700,
                          color: active ? 'white' : tokens.colors.textSecondary,
                          flexShrink: 0,
                        }}
                      >
                        B
                      </div>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {b.name}
                      </span>
                      {counts.tickets.perBoard[b.id] > 0 && (
                        <NavBadge count={counts.tickets.perBoard[b.id]} />
                      )}
                    </button>
                    {/* Board sub-entries (QA, Security, Resources, Actions, Settings) when board is active */}
                    {active && (
                      <>
                        {[
                          { label: 'QA',         path: `/ws/${wsId}/boards/${b.id}/qa`        },
                          { label: 'Security',   path: `/ws/${wsId}/boards/${b.id}/security`  },
                          { label: 'Resources',  path: `/ws/${wsId}/boards/${b.id}/resources` },
                          { label: 'Actions',    path: `/ws/${wsId}/boards/${b.id}/actions`   },
                          { label: 'Settings',   path: `/ws/${wsId}/boards/${b.id}/settings`  },
                        ].map((sub) => {
                          const subActive = location.pathname === sub.path;
                          return (
                            <button
                              key={sub.path}
                              onClick={() => { navigate(sub.path); if (overlay) onClose(); }}
                              style={{
                                width: '100%',
                                padding: '6px 16px 6px 32px',
                                fontSize: 12,
                                color: subActive ? tokens.colors.textStrong : tokens.colors.textSecondary,
                                fontWeight: subActive ? 600 : 400,
                                cursor: 'pointer',
                                background: subActive ? tokens.colors.surfaceHover : 'transparent',
                                border: 'none',
                                textAlign: 'left',
                                fontFamily: 'inherit',
                              }}
                              onMouseEnter={(e) => {
                                if (!subActive) {
                                  (e.currentTarget as HTMLButtonElement).style.color = tokens.colors.textStrong;
                                  (e.currentTarget as HTMLButtonElement).style.background = tokens.colors.surfaceHover;
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (!subActive) {
                                  (e.currentTarget as HTMLButtonElement).style.color = tokens.colors.textSecondary;
                                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                                }
                              }}
                            >
                              {sub.label}
                            </button>
                          );
                        })}
                      </>
                    )}
                  </React.Fragment>
                );
              })
            )}

          </>
        )}

        {/* Divider */}
        <div style={dividerStyle} />

        {/* WORKSPACE section */}
        <div style={sectionHeaderStyle}>WORKSPACE</div>
        {workspaceNavItems.map((item) => renderNavButton(item, isPathActive(item.path)))}

        {/* ADMIN section — role-gated */}
        {hasPermission('admin.access') && (
          <>
            <div style={dividerStyle} />
            <div style={sectionHeaderStyle}>ADMIN</div>
            {adminNavItems.map((item) => renderNavButton(item, isPathActive(item.path)))}
          </>
        )}

      </nav>

      {/* User footer */}
      {user && (
        <div style={{ padding: '12px 16px', borderTop: `1px solid ${tokens.colors.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: tokens.colors.border,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '13px',
                fontWeight: 700,
                color: tokens.colors.textStrong,
                flexShrink: 0,
              }}
            >
              {user?.name?.[0]?.toUpperCase() || '?'}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: tokens.colors.textStrong,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user?.name || 'User'}
              </div>
              <div style={{ fontSize: '10px', color: tokens.colors.textMuted }}>
                {(user?.role || '').toUpperCase()}
              </div>
            </div>
          </div>
          <button
            onClick={async () => { await logout(); }}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: 'transparent',
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              color: tokens.colors.textSecondary,
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = tokens.colors.textStrong;
              (e.currentTarget as HTMLButtonElement).style.borderColor = tokens.colors.borderStrong;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = tokens.colors.textSecondary;
              (e.currentTarget as HTMLButtonElement).style.borderColor = tokens.colors.border;
            }}
          >
            Logout
          </button>
        </div>
      )}
    </aside>
  );
}
