import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useNotifications } from '../contexts/NotificationContext';
import type { ChatRoomListItem } from '../types';
import { tokens } from '../tokens';
import { MentionInboxBadge } from './common/MentionInboxBadge';
import { NavBadge } from './common/NavBadge';
import { NotificationSettingsPanel } from './common/NotificationSettingsPanel';

interface SidebarProps {
  overlay: boolean;
  isOpen: boolean;
  onClose: () => void;
  wsId: string | null;
  boards: { id: string; name: string }[];
  rooms: ChatRoomListItem[];
  roomsLoading: boolean;
  containerRef?: React.Ref<HTMLElement>;
}

interface NavItem {
  key: string;
  path: string;
  label: string;
  icon: string;
  badge?: number;
  exact?: boolean;
}

function roomDisplayName(room: ChatRoomListItem): string {
  if (room.type === 'dm') return room.name || room.dm_partner_name || 'Direct Message';
  return room.name || 'Unnamed Group';
}

function roomInitials(room: ChatRoomListItem): string {
  return roomDisplayName(room)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '#';
}

export default function Sidebar({
  overlay,
  isOpen,
  onClose,
  wsId,
  boards,
  rooms,
  roomsLoading,
  containerRef,
}: SidebarProps) {
  const { user, logout, hasPermission } = useAuth();
  const { counts } = useNotifications();
  const navigate = useNavigate();
  const location = useLocation();
  const [boardsExpanded, setBoardsExpanded] = React.useState(true);

  const workspaceBase = wsId ? `/ws/${wsId}` : '';
  const canAdmin = hasPermission('admin.access');

  const isPathActive = (path: string): boolean =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  const handleNavClick = (path: string) => {
    if (!path) return;
    navigate(path);
    if (overlay) onClose();
  };

  const workspaceSections: Array<{ title: string; items: NavItem[] }> = [
    {
      title: 'Work',
      items: [
        {
          key: 'boards',
          path: `${workspaceBase}/boards`,
          label: 'Boards',
          icon: 'B',
          badge: counts.tickets.total,
          exact: true,
        },
        {
          key: 'agents',
          path: `${workspaceBase}/agents`,
          label: 'AI Agents',
          icon: 'A',
        },
      ],
    },
    {
      title: 'Automation',
      items: [
        { key: 'functions', path: `${workspaceBase}/functions`, label: 'Functions', icon: 'F' },
        { key: 'actions', path: `${workspaceBase}/actions`, label: 'Actions', icon: 'A' },
        { key: 'schedules', path: `${workspaceBase}/schedules`, label: 'Schedules', icon: 'S' },
      ],
    },
    {
      title: 'Knowledge',
      items: [
        { key: 'resources', path: `${workspaceBase}/resources`, label: 'Resources', icon: 'R' },
        {
          key: 'prompt-templates',
          path: `${workspaceBase}/prompt-templates`,
          label: 'Prompt Templates',
          icon: 'P',
        },
      ],
    },
    {
      title: 'Quality',
      items: [
        { key: 'qa', path: `${workspaceBase}/qa`, label: 'QA', icon: 'Q' },
        { key: 'security', path: `${workspaceBase}/security`, label: 'Security', icon: 'S' },
      ],
    },
    {
      title: 'Settings',
      items: [
        {
          key: 'settings-overview',
          path: `${workspaceBase}/settings`,
          label: 'Settings Overview',
          icon: 'S',
          exact: true,
        },
        ...(canAdmin
          ? [{ key: 'workspace-settings', path: `${workspaceBase}/settings/workspace`, label: 'Workspace', icon: 'W' }]
          : []),
        { key: 'members', path: `${workspaceBase}/settings/members`, label: 'Members', icon: 'M' },
        { key: 'roles', path: `${workspaceBase}/settings/roles`, label: 'Roles', icon: 'R' },
        { key: 'credentials', path: `${workspaceBase}/settings/credentials`, label: 'Credentials', icon: 'C' },
        { key: 'channels', path: `${workspaceBase}/settings/channels`, label: 'Channels', icon: 'N' },
        { key: 'api-keys', path: `${workspaceBase}/settings/api-keys`, label: 'API Keys', icon: 'K' },
        {
          key: 'claude-profiles',
          path: `${workspaceBase}/settings/claude-profiles`,
          label: 'Claude Profiles',
          icon: 'C',
        },
        ...(canAdmin
          ? [
              {
                key: 'admin-users',
                path: '/admin/users',
                label: 'User Administration',
                icon: 'U',
                badge: counts.pendingUsers,
              },
              { key: 'system-settings', path: '/admin/settings', label: 'System Settings', icon: 'S' },
            ]
          : []),
      ],
    },
  ];

  const operations: NavItem[] = [
    {
      key: 'workflow-health',
      path: '/admin/workflow-health',
      label: 'Workflow Health',
      icon: 'H',
    },
    {
      key: 'skills',
      path: '/admin/skills',
      label: 'Skills',
      icon: 'S',
    },
    { key: 'server-logs', path: '/admin/logs', label: 'Server Logs', icon: 'L' },
    {
      key: 'agent-logs',
      path: '/admin/agent-logs',
      label: 'Agent Logs',
      icon: 'G',
      badge: counts.agentErrors,
    },
  ];

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 28,
    padding: '10px 12px 5px',
    color: tokens.colors.textMuted,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    userSelect: 'none',
  };

  const iconStyle = (active: boolean): React.CSSProperties => ({
    width: 24,
    height: 24,
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: active ? `${tokens.colors.accent}26` : `${tokens.colors.border}70`,
    color: active ? tokens.colors.accentLight : tokens.colors.textSecondary,
    fontSize: 10,
    fontWeight: 700,
  });

  const navRowStyle = (active: boolean, nested = false): React.CSSProperties => ({
    width: '100%',
    minHeight: nested ? 32 : 36,
    padding: nested ? '4px 12px 4px 24px' : '6px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    border: 'none',
    borderLeft: `3px solid ${active ? tokens.colors.accent : 'transparent'}`,
    background: active ? tokens.colors.surfaceHover : 'transparent',
    color: active ? tokens.colors.textPrimary : tokens.colors.textSecondary,
    fontFamily: 'inherit',
    fontSize: nested ? 12 : 13,
    fontWeight: active ? 600 : 500,
    textAlign: 'left',
    cursor: 'pointer',
  });

  const renderNavItem = (item: NavItem, nested = false) => {
    const active = item.exact ? location.pathname === item.path : isPathActive(item.path);
    return (
      <button
        key={item.key}
        type="button"
        onClick={() => handleNavClick(item.path)}
        style={navRowStyle(active, nested)}
        onMouseEnter={(event) => {
          if (!active) event.currentTarget.style.background = tokens.colors.surfaceHover;
        }}
        onMouseLeave={(event) => {
          if (!active) event.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={iconStyle(active)} aria-hidden="true">{item.icon}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.label}
        </span>
        {!!item.badge && item.badge > 0 && <NavBadge count={item.badge} />}
      </button>
    );
  };

  const sidebarClassName = [
    'awb-sidebar',
    overlay ? 'awb-sidebar--overlay' : '',
    overlay && isOpen ? 'awb-sidebar--open' : '',
  ].filter(Boolean).join(' ');

  return (
    <aside
      data-testid="app-sidebar"
      ref={containerRef}
      className={sidebarClassName}
      style={{
        width: overlay ? undefined : 260,
        flexShrink: 0,
        background: tokens.colors.surfaceCard,
        borderRight: `1px solid ${tokens.colors.border}`,
        display: 'flex',
        flexDirection: 'column',
      }}
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay ? true : undefined}
      aria-label={overlay ? 'Navigation' : undefined}
    >
      <div
        style={{
          minHeight: 64,
          padding: '12px 12px',
          borderBottom: `1px solid ${tokens.colors.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          boxSizing: 'border-box',
        }}
      >
        <button
          type="button"
          onClick={() => handleNavClick(workspaceBase ? `${workspaceBase}/assistant` : '')}
          aria-label="AWB home"
          style={{
            width: 34,
            height: 34,
            border: 'none',
            borderRadius: 10,
            background: tokens.gradients.accent,
            color: 'white',
            fontSize: 16,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          W
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.textPrimary }}>AWB</div>
          <div style={{ marginTop: 1, fontSize: 10, color: tokens.colors.textMuted }}>AI Workflow Board</div>
        </div>
        <MentionInboxBadge workspaceId={wsId} />
        <NotificationSettingsPanel />
      </div>

      <nav
        aria-label="Primary navigation"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <section aria-labelledby="sidebar-chat-heading" style={{ flexShrink: 0 }}>
          <div style={sectionHeaderStyle}>
            <span id="sidebar-chat-heading">Chat</span>
            <button
              type="button"
              aria-label="New chat"
              title="New chat"
              onClick={() => handleNavClick(`${workspaceBase}/chat?new=1`)}
              style={{
                width: 24,
                height: 24,
                border: 'none',
                borderRadius: 6,
                background: 'transparent',
                color: tokens.colors.textSecondary,
                cursor: 'pointer',
                fontSize: 17,
                lineHeight: 1,
              }}
            >
              +
            </button>
          </div>

          {renderNavItem({
            key: 'all-chats',
            path: `${workspaceBase}/chat`,
            label: 'All chats',
            icon: 'C',
            badge: counts.chat.total,
            exact: true,
          })}

          <div
            aria-label="Chat rooms"
            style={{
              maxHeight: 220,
              minHeight: roomsLoading ? 40 : undefined,
              overflowY: 'auto',
              paddingBottom: 4,
            }}
          >
            {roomsLoading && rooms.length === 0 ? (
              <div style={{ padding: '8px 14px 10px 46px', fontSize: 11, color: tokens.colors.textMuted }}>
                Loading chats...
              </div>
            ) : rooms.length === 0 ? (
              <div style={{ padding: '8px 14px 10px 46px', fontSize: 11, color: tokens.colors.textMuted }}>
                No chats yet
              </div>
            ) : (
              rooms.map((room) => {
                const roomPath = `${workspaceBase}/chat/${room.id}`;
                const active = location.pathname === roomPath;
                const unread = Math.max(room.unread_count || 0, counts.chat.perRoom[room.id] || 0);
                return (
                  <button
                    key={room.id}
                    type="button"
                    onClick={() => handleNavClick(roomPath)}
                    aria-current={active ? 'page' : undefined}
                    title={roomDisplayName(room)}
                    style={navRowStyle(active, true)}
                    onMouseEnter={(event) => {
                      if (!active) event.currentTarget.style.background = tokens.colors.surfaceHover;
                    }}
                    onMouseLeave={(event) => {
                      if (!active) event.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        ...iconStyle(active),
                        borderRadius: '50%',
                        fontSize: 9,
                      }}
                    >
                      {roomInitials(room)}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {roomDisplayName(room)}
                    </span>
                    {unread > 0 && <NavBadge count={unread} />}
                  </button>
                );
              })
            )}
          </div>
        </section>

        <div style={{ height: 1, margin: '6px 12px 0', background: tokens.colors.border, flexShrink: 0 }} />

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 8 }}>
          {workspaceSections.map((section) => (
            <section key={section.title} aria-labelledby={`sidebar-${section.title.toLowerCase()}`}>
              <div style={sectionHeaderStyle}>
                <span id={`sidebar-${section.title.toLowerCase()}`}>{section.title}</span>
                {section.title === 'Work' && (
                  <button
                    type="button"
                    aria-label={boardsExpanded ? 'Collapse board list' : 'Expand board list'}
                    aria-expanded={boardsExpanded}
                    onClick={() => setBoardsExpanded((value) => !value)}
                    style={{
                      width: 24,
                      height: 24,
                      border: 'none',
                      borderRadius: 6,
                      background: 'transparent',
                      color: tokens.colors.textMuted,
                      cursor: 'pointer',
                      fontSize: 10,
                    }}
                  >
                    {boardsExpanded ? '\u25BC' : '\u25B6'}
                  </button>
                )}
              </div>

              {section.items.map((item) => (
                <React.Fragment key={item.key}>
                  {renderNavItem(item)}
                  {item.key === 'boards' && boardsExpanded && (
                    <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                      {boards.length === 0 ? (
                        <div style={{ padding: '6px 14px 8px 46px', fontSize: 11, color: tokens.colors.textMuted }}>
                          No boards yet
                        </div>
                      ) : (
                        boards.map((board) => renderNavItem({
                          key: `board-${board.id}`,
                          path: `${workspaceBase}/boards/${board.id}`,
                          label: board.name,
                          icon: 'B',
                          badge: counts.tickets.perBoard[board.id],
                        }, true))
                      )}
                    </div>
                  )}
                </React.Fragment>
              ))}
            </section>
          ))}

          {canAdmin && (
            <section aria-labelledby="sidebar-operations">
              <div style={sectionHeaderStyle}>
                <span id="sidebar-operations">Operations</span>
              </div>
              {operations.map((item) => renderNavItem(item))}
            </section>
          )}
        </div>
      </nav>

      {user && (
        <div
          style={{
            padding: '10px 12px',
            borderTop: `1px solid ${tokens.colors.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 9,
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: tokens.colors.border,
              color: tokens.colors.textStrong,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {user.name?.[0]?.toUpperCase() || '?'}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: tokens.colors.textStrong,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user.name || 'User'}
            </div>
            <div style={{ marginTop: 1, fontSize: 9, color: tokens.colors.textMuted }}>
              {(user.role || '').toUpperCase()}
            </div>
          </div>
          <button
            type="button"
            onClick={async () => logout()}
            title="Logout"
            aria-label="Logout"
            style={{
              width: 30,
              height: 30,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: 7,
              background: 'transparent',
              color: tokens.colors.textMuted,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            \u2192
          </button>
        </div>
      )}
    </aside>
  );
}
