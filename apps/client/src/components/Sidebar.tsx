import React from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useToast } from '../contexts/ToastContext';
import { api } from '../api';
import type { ChatRoomListItem } from '../types';
import { tokens } from '../tokens';
import { MentionInboxBadge } from './common/MentionInboxBadge';
import { NavBadge } from './common/NavBadge';
import { NotificationSettingsPanel } from './common/NotificationSettingsPanel';
import {
  SIDEBAR_ROOMS_BASE_COUNT,
  nextVisibleCount,
  nextVisibleRoomCount,
  paginateSidebarItems,
  paginateSidebarRooms,
} from './sidebarRoomsPaging';
import {
  activeWorkGroupKey,
  buildWorkNavGroups,
  type WorkNavGroup,
  type WorkNavGroupKey,
} from './workNavigation';
import { useWorkNavLists } from '../hooks/useWorkNavLists';

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
  /** What the badge number means, for the tooltip / screen reader. */
  badgeLabel?: string;
  exact?: boolean;
  /** 경로 접두사 규칙으로 판정할 수 없을 때 모델이 계산한 active 를 그대로 쓴다. */
  active?: boolean;
  /** 이름이 길어 말줄임될 때 전체 이름을 보여줄 툴팁. */
  title?: string;
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
  const { counts, countsLoaded, markTicketsReadForBoard } = useNotifications();
  const { showToast } = useToast();
  const { teams, missions, teamsLoading, missionsLoading } = useWorkNavLists(wsId);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // WORK 최상위 메뉴별 접기/펼치기. 기본은 모두 펼침 — 어느 메뉴 하나만 다르게
  // 동작하지 않도록 세 그룹이 같은 state 모양을 쓴다.
  const [collapsedGroups, setCollapsedGroups] = React.useState<Partial<Record<WorkNavGroupKey, boolean>>>({});
  const [visibleGroupCounts, setVisibleGroupCounts] = React.useState<Partial<Record<WorkNavGroupKey, number>>>({});
  const [visibleRoomCount, setVisibleRoomCount] = React.useState(SIDEBAR_ROOMS_BASE_COUNT);
  const [markingAllTicketsRead, setMarkingAllTicketsRead] = React.useState(false);

  // 워크스페이스 전체 "모두 읽음" (티켓 628f4b39) — 보드 스코프 버전은
  // "보드"가 명확한 Board 페이지 자체(Board.tsx)에 있고, 여기는 "모든
  // 보드를 한 번에"가 의미를 갖는 유일한 곳이다.
  const handleMarkAllTicketsRead = async () => {
    setMarkingAllTicketsRead(true);
    try {
      await api.markAllTicketsRead();
      markTicketsReadForBoard();
      showToast('모든 보드의 읽지 않은 코멘트를 읽음으로 표시했습니다', 'success');
    } catch (err: any) {
      showToast(err?.message || '읽음 처리에 실패했습니다', 'error');
    } finally {
      setMarkingAllTicketsRead(false);
    }
  };

  const workspaceBase = wsId ? `/ws/${wsId}` : '';
  const canAdmin = hasPermission('admin.access');

  // 워크스페이스를 바꾸면 펼침 상태를 초기 5개로 되돌린다. 30초 폴링이나
  // chat-rooms-changed 이벤트로 rooms 배열만 갱신될 때는 wsId 가 그대로이므로
  // 이 로컬 state 가 리셋되지 않고 유지된다.
  React.useEffect(() => {
    setVisibleRoomCount(SIDEBAR_ROOMS_BASE_COUNT);
    setVisibleGroupCounts({});
  }, [wsId]);

  const isPathActive = (path: string): boolean =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  const handleNavClick = (path: string) => {
    if (!path) return;
    navigate(path);
    if (overlay) onClose();
  };

  const workspaceSections: Array<{ title: string; items: NavItem[] }> = [
    {
      // Teams / Orchestrations / Boards 는 목록을 서브메뉴로 펴는 계층형 그룹이라
      // 평평한 items 가 아니라 workGroups 로 따로 그린다(티켓 03ca8b5b).
      title: 'Work',
      items: [
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
        {
          key: 'ontology-graph',
          path: `${workspaceBase}/ontology-graph`,
          label: 'Ontology Graph',
          icon: 'G',
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
                badgeLabel: `승인 대기 중인 가입 요청 ${counts.pendingUsers}건`,
              },
              { key: 'system-settings', path: '/admin/settings', label: 'System Settings', icon: 'S' },
              { key: 'migration', path: '/admin/migration', label: 'Live Import', icon: 'M' },
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
    {
      key: 'skill-registry',
      path: '/admin/skill-registry',
      label: 'Skill Registry',
      icon: 'R',
    },
    { key: 'server-logs', path: '/admin/logs', label: 'Server Logs', icon: 'L' },
    {
      key: 'agent-logs',
      path: '/admin/agent-logs',
      label: 'Agent Logs',
      icon: 'G',
      badge: counts.agentErrors,
      badgeLabel: `마지막 확인 이후 새 에러 로그 ${counts.agentErrors}건`,
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
    const active =
      item.active ?? (item.exact ? location.pathname === item.path : isPathActive(item.path));
    return (
      <button
        key={item.key}
        type="button"
        onClick={() => handleNavClick(item.path)}
        aria-current={active ? 'page' : undefined}
        title={item.title}
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
        {!!item.badge && item.badge > 0 && <NavBadge count={item.badge} label={item.badgeLabel} />}
      </button>
    );
  };

  // WORK 계층 — Teams / Orchestrations / Boards 를 그 순서대로, 각자의 목록을
  // 서브메뉴로 펴서 보여준다(티켓 03ca8b5b).
  const workGroups = buildWorkNavGroups({
    workspaceBase,
    pathname: location.pathname,
    selectedTeamId: searchParams.get('team'),
    teams,
    missions,
    boards,
    boardUnread: counts.tickets.perBoard,
    ticketUnreadTotal: counts.tickets.total,
    teamsLoading,
    missionsLoading,
  });

  // 딥링크(미션 상세 등)나 다른 화면에서 어떤 그룹의 영역으로 들어오면 접혀 있던
  // 그 그룹을 편다 — 그러지 않으면 현재 위치를 가리키는 서브 항목이 접힌 채 숨는다.
  // 사용자가 직접 접은 다른 그룹은 그대로 둔다.
  const activeGroupKey = activeWorkGroupKey(workGroups);
  React.useEffect(() => {
    if (!activeGroupKey) return;
    setCollapsedGroups((prev) => (prev[activeGroupKey] ? { ...prev, [activeGroupKey]: false } : prev));
  }, [activeGroupKey]);

  const subListTextStyle: React.CSSProperties = {
    padding: '6px 14px 8px 46px',
    fontSize: 11,
    color: tokens.colors.textMuted,
  };

  const renderWorkGroup = (group: WorkNavGroup) => {
    const expanded = !collapsedGroups[group.key];
    const visibleCount = visibleGroupCounts[group.key] ?? SIDEBAR_ROOMS_BASE_COUNT;
    const activeChildId = group.children.find((child) => child.active)?.id ?? null;
    const { visibleItems, hiddenItems } = paginateSidebarItems(group.children, visibleCount, activeChildId);
    const showPager = group.children.length > SIDEBAR_ROOMS_BASE_COUNT;

    return (
      <React.Fragment key={group.key}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => handleNavClick(group.path)}
            aria-current={group.active ? 'page' : undefined}
            title={group.label}
            style={{ ...navRowStyle(group.active), width: 'auto', flex: 1, minWidth: 0 }}
            onMouseEnter={(event) => {
              if (!group.active) event.currentTarget.style.background = tokens.colors.surfaceHover;
            }}
            onMouseLeave={(event) => {
              if (!group.active) event.currentTarget.style.background = 'transparent';
            }}
          >
            <span style={iconStyle(group.active)} aria-hidden="true">{group.icon}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {group.label}
            </span>
            {!!group.badge && group.badge > 0 && <NavBadge count={group.badge} label={group.badgeLabel} />}
          </button>
          <button
            type="button"
            aria-label={expanded ? `Collapse ${group.label} list` : `Expand ${group.label} list`}
            aria-expanded={expanded}
            onClick={() => setCollapsedGroups((prev) => ({ ...prev, [group.key]: expanded }))}
            style={{
              width: 24,
              height: 24,
              marginRight: 8,
              border: 'none',
              borderRadius: 6,
              background: 'transparent',
              color: tokens.colors.textMuted,
              cursor: 'pointer',
              fontSize: 10,
              flexShrink: 0,
            }}
          >
            {expanded ? '\u25BC' : '\u25B6'}
          </button>
        </div>

        {expanded && (
          <div aria-label={`${group.label} list`}>
            {group.loading && group.children.length === 0 ? (
              <div style={subListTextStyle}>{`Loading ${group.label.toLowerCase()}...`}</div>
            ) : group.children.length === 0 ? (
              <div style={subListTextStyle}>{group.emptyLabel}</div>
            ) : (
              visibleItems.map((child) =>
                renderNavItem(
                  {
                    key: `${group.key}-${child.id}`,
                    path: child.path,
                    // 목록 이름은 임의 길이라 아이콘은 그룹 아이콘을 그대로 쓰고,
                    // 잘린 이름 전체는 title 툴팁으로 보여준다.
                    icon: group.icon,
                    label: child.label,
                    title: child.label,
                    active: child.active,
                    badge: child.badge,
                    badgeLabel: child.badgeLabel,
                  },
                  true,
                ),
              )
            )}
            {showPager && (
              <button
                type="button"
                onClick={() =>
                  setVisibleGroupCounts((prev) => ({
                    ...prev,
                    [group.key]: nextVisibleCount(visibleCount, group.children.length, hiddenItems.length > 0),
                  }))
                }
                aria-expanded={hiddenItems.length === 0}
                aria-label={
                  hiddenItems.length > 0
                    ? `${group.label} 더보기, ${hiddenItems.length}개 더 보기`
                    : `${group.label} 목록 접기`
                }
                style={navRowStyle(false, true)}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = tokens.colors.surfaceHover;
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = 'transparent';
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  {hiddenItems.length > 0 ? `더보기 (${hiddenItems.length})` : '접기'}
                </span>
              </button>
            )}
          </div>
        )}
      </React.Fragment>
    );
  };

  const activeRoomId = rooms.find((room) => location.pathname === `${workspaceBase}/chat/${room.id}`)?.id ?? null;
  const { displayRooms, hiddenRooms } = paginateSidebarRooms(rooms, visibleRoomCount, activeRoomId);
  // One source of truth once the counts have loaded. Taking the max of the
  // two sources meant a room read on another tab (which clears perRoom via
  // the read event) kept showing the stale number from this tab's up-to-30s
  // -old room snapshot — and a badge you cannot clear by reading is exactly
  // the "wrong number" complaint. Before the first fetch the room snapshot
  // is all we have, so use it then.
  const unreadFor = (room: ChatRoomListItem): number =>
    countsLoaded ? counts.chat.perRoom[room.id] || 0 : room.unread_count || 0;
  const hiddenUnreadTotal = hiddenRooms.reduce((sum, room) => sum + unreadFor(room), 0);
  const showRoomsPager = rooms.length > SIDEBAR_ROOMS_BASE_COUNT;
  const handleToggleRoomsPager = () => {
    setVisibleRoomCount((count) => nextVisibleRoomCount(count, rooms.length, hiddenRooms.length > 0));
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
        style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
      >
        <section aria-labelledby="sidebar-chat-heading">
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
            badgeLabel: `읽지 않은 채팅 메시지 ${counts.chat.total}건`,
            exact: true,
          })}

          <div
            aria-label="Chat rooms"
            style={{
              minHeight: roomsLoading ? 40 : undefined,
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
              displayRooms.map((room) => {
                const roomPath = `${workspaceBase}/chat/${room.id}`;
                const active = location.pathname === roomPath;
                const unread = unreadFor(room);
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
                    {unread > 0 && (
                      <NavBadge
                        count={unread}
                        label={`${roomDisplayName(room)} 읽지 않은 메시지 ${unread}건`}
                      />
                    )}
                  </button>
                );
              })
            )}
            {showRoomsPager && (
              <button
                type="button"
                onClick={handleToggleRoomsPager}
                aria-expanded={hiddenRooms.length === 0}
                aria-label={
                  hiddenRooms.length > 0
                    ? `더보기, ${hiddenRooms.length}개 더 보기`
                    : '채팅 목록 접기'
                }
                style={navRowStyle(false, true)}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = tokens.colors.surfaceHover;
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = 'transparent';
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  {hiddenRooms.length > 0 ? `더보기 (${hiddenRooms.length})` : '접기'}
                </span>
                {hiddenRooms.length > 0 && hiddenUnreadTotal > 0 && (
                  <NavBadge
                    count={hiddenUnreadTotal}
                    label={`숨겨진 채팅의 읽지 않은 메시지 ${hiddenUnreadTotal}건`}
                  />
                )}
              </button>
            )}
          </div>
        </section>

        <div style={{ height: 1, margin: '6px 12px 0', background: tokens.colors.border }} />

        <div style={{ paddingBottom: 8 }}>
          {workspaceSections.map((section) => (
            <section key={section.title} aria-labelledby={`sidebar-${section.title.toLowerCase()}`}>
              <div style={sectionHeaderStyle}>
                <span id={`sidebar-${section.title.toLowerCase()}`}>{section.title}</span>
                {section.title === 'Work' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {/* \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uC804\uCCB4 \uC77C\uAD04 \uC77D\uC74C(\uC694\uAD6C\uC0AC\uD56D 2) \u2014 \uC9C0\uC6B8 \uAC8C \uC788\uC744
                       \uB54C\uB9CC \uB178\uCD9C\uD55C\uB2E4. \uC139\uC158 \uC81C\uBAA9\uACFC \uD55C \uD589\uC744 \uACF5\uC720\uD558\uBBC0\uB85C \uB300\uBB38\uC790\uB97C
                       \uC4F0\uC9C0 \uC54A\uC544 \uC2DC\uAC01\uC801\uC73C\uB85C \uC81C\uBAA9\uACFC \uACBD\uC7C1\uD558\uC9C0 \uC54A\uAC8C \uD55C\uB2E4. */}
                    {counts.tickets.total > 0 && (
                      <button
                        type="button"
                        onClick={handleMarkAllTicketsRead}
                        disabled={markingAllTicketsRead}
                        title={`\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uC804\uCCB4 \uC77D\uC9C0 \uC54A\uC740 \uD2F0\uCF13 \uCF54\uBA58\uD2B8 ${counts.tickets.total}\uAC74\uC744 \uBAA8\uB450 \uC77D\uC74C\uC73C\uB85C \uD45C\uC2DC`}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: tokens.colors.accent,
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'none',
                          letterSpacing: 'normal',
                          cursor: markingAllTicketsRead ? 'default' : 'pointer',
                          opacity: markingAllTicketsRead ? 0.5 : 1,
                          padding: '2px 4px',
                        }}
                      >
                        {/* \uCEA1\uB418\uC9C0 \uC54A\uC740 \uC815\uD655\uD55C \uC218\uCE58\uB97C \uD3C9\uBB38\uC73C\uB85C(\uC694\uAD6C\uC0AC\uD56D 3) \u2014
                           \uC544\uB798 \uBC30\uC9C0\uC758 "99+" \uD544\uC740 \uC2E4\uC81C \uC218\uCE58\uB97C \uD638\uBC84 \uD234\uD301 \uB4A4\uC5D0
                           \uC228\uAE30\uC9C0\uB9CC, \uC774 \uBC84\uD2BC\uC740 \uADF8\uB7EC\uC9C0 \uC54A\uB294\uB2E4. */}
                        {`${counts.tickets.total}\uAC74 \uBAA8\uB450 \uC77D\uC74C`}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {section.title === 'Work' && workGroups.map(renderWorkGroup)}

              {section.items.map((item) => renderNavItem(item))}
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
            {'\u2192'}
          </button>
        </div>
      )}
    </aside>
  );
}
