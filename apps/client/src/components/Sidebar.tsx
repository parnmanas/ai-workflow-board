import React from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useToast } from '../contexts/ToastContext';
import { api } from '../api';
import type { AgentSessionUpdateEvent, AgentSessionHost, AgentSessionSummary, ChatRoomListItem } from '../types';
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
import { useAgentSessionsNav } from '../hooks/useAgentSessionsNav';
import { groupSessionsByCwd, sessionPath, splitRecentCwdGroups, splitRecentSessions, upsertSessionInGroups, type CwdGroup } from './sessions/sessionList.logic';
import { runtimeLabel, sessionDisplayTitle } from './sessions/sessionTranscript.logic';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';

// ─── 사이드바 폴드 상태 쿠키 저장 ───────────────────────────────────────────

const SIDEBAR_FOLD_KEY = 'awb_sidebar_fold';
const SIDEBAR_FOLD_MAX_AGE = 60 * 60 * 24 * 365; // 1년

interface SidebarFoldSnapshot {
  sessions?: boolean;
  chats?: boolean;
  sections?: Record<string, boolean>;
  hosts?: string[];
}

function loadSidebarFold(): Required<SidebarFoldSnapshot> {
  try {
    const match = document.cookie.split(';').find((c) => c.trim().startsWith(`${SIDEBAR_FOLD_KEY}=`));
    const raw = match ? decodeURIComponent(match.trim().slice(SIDEBAR_FOLD_KEY.length + 1)) : null;
    const parsed: SidebarFoldSnapshot = raw ? (JSON.parse(raw) as SidebarFoldSnapshot) : {};
    return {
      sessions: parsed.sessions ?? false,
      chats: parsed.chats ?? false,
      sections: parsed.sections ?? {},
      hosts: parsed.hosts ?? [],
    };
  } catch {
    return { sessions: false, chats: false, sections: {}, hosts: [] };
  }
}

function saveSidebarFold(snap: Required<SidebarFoldSnapshot>): void {
  try {
    const value = encodeURIComponent(JSON.stringify(snap));
    document.cookie = `${SIDEBAR_FOLD_KEY}=${value}; path=/; max-age=${SIDEBAR_FOLD_MAX_AGE}; SameSite=Lax`;
  } catch { /* best-effort */ }
}

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

  // 사이드바 폴드 상태 — localStorage 에서 초기화
  const [foldInit] = React.useState(loadSidebarFold);
  const [sessionsCollapsed, setSessionsCollapsed] = React.useState(() => foldInit.sessions);
  const [chatsCollapsed, setChatsCollapsed] = React.useState(() => foldInit.chats);
  const [sectionCollapsed, setSectionCollapsed] = React.useState<Record<string, boolean>>(() => foldInit.sections);
  const [collapsedHosts, setCollapsedHosts] = React.useState<Set<string>>(() => new Set(foldInit.hosts));
  const [collapsedHostCwds, setCollapsedHostCwds] = React.useState<Set<string>>(() => new Set());
  const [expandedOlderCwds, setExpandedOlderCwds] = React.useState<Set<string>>(() => new Set());
  // 3일보다 오래된 작업 폴더를 펼쳐 둔 호스트. 세션 행과 같은 창을 쓴다(splitRecentCwdGroups).
  const [expandedOlderHosts, setExpandedOlderHosts] = React.useState<Set<string>>(() => new Set());
  const [hostSessions, setHostSessions] = React.useState<Record<string, { groups: CwdGroup[]; loading: boolean; loaded: boolean }>>({});
  const loadAttemptedRef = React.useRef<Set<string>>(new Set());

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
  // Agent Session(CLI 직접 세션) — Chat 위에 오는 주 작업 표면. 행은 (Runtime Host × CLI)
  // 이고 세션 자체는 그 장비에 있다. 권한이 없는 사용자에겐 섹션을 그리지 않는다.
  const canUseSessions = hasPermission('agent_sessions.use');
  const canUseTerminals = hasPermission('terminals.use');
  const { hosts: sessionHosts, loading: sessionHostsLoading } = useAgentSessionsNav(canUseSessions && wsId ? wsId : null);

  // 워크스페이스를 바꾸면 펼침 상태를 초기 5개로 되돌린다. 30초 폴링이나
  // chat-rooms-changed 이벤트로 rooms 배열만 갱신될 때는 wsId 가 그대로이므로
  // 이 로컬 state 가 리셋되지 않고 유지된다.
  React.useEffect(() => {
    setVisibleRoomCount(SIDEBAR_ROOMS_BASE_COUNT);
    setVisibleGroupCounts({});
    // 워크스페이스 전환 시 세션 캐시만 초기화 (폴드 상태는 localStorage 유지)
    loadAttemptedRef.current.clear();
    setHostSessions({});
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
        // Terminal(Runtime Host 셸) — 기본 admin 전용 권한이라 없는 사용자에게는 행 자체를
        // 그리지 않는다(눌러도 403 인 행을 남겨 두지 않는다).
        ...(canUseTerminals
          ? [{
            key: 'terminals',
            path: `${workspaceBase}/terminals`,
            label: 'Terminals',
            icon: 'T',
          }]
          : []),
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

  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  const loadHostSessions = React.useCallback(async (host: AgentSessionHost) => {
    const { manager_id: managerId } = host;
    setHostSessions((prev) => ({ ...prev, [managerId]: { groups: prev[managerId]?.groups ?? [], loading: true, loaded: false } }));
    const byCliMap: Record<string, AgentSessionSummary[]> = {};
    await Promise.all(host.clis.map(async (cli) => {
      try {
        const list = await api.listHostSessions(managerId, cli);
        byCliMap[cli] = Array.isArray(list) ? list : [];
      } catch {
        byCliMap[cli] = [];
      }
    }));
    setHostSessions((prev) => ({ ...prev, [managerId]: { groups: groupSessionsByCwd(byCliMap), loading: false, loaded: true } }));
  }, []);

  // 라이브 상태 갱신 — 세션 페이지가 받는 것과 같은 driver 전용 SSE. 목록을 다시 묻지 않고
  // 그 자리에서 반영한다. **이미 있는 행은 고치고, 처음 보는 세션은 넣는다** — 방금 만든
  // 세션이 사이드바에 바로 뜨는 경로가 이것이다(서버는 열리는 즉시 reason:'opened' 로 쏜다).
  // 예전에는 있는 행만 고쳐서, 새 세션은 새로고침하거나 그 호스트 목록을 다시 부를 때까지
  // 보이지 않았다.
  useBoardStreamEvent('agent_session_update', React.useCallback((data: AgentSessionUpdateEvent) => {
    const live = data?.session;
    if (!live) return;
    setHostSessions((prev) => {
      const entry = prev[live.manager_id];
      // 아직 이 호스트의 목록을 불러온 적이 없으면 넣지 않는다 — 펼칠 때 서버에서 통째로
      // 받아오므로, 여기서 한 건만 심어 두면 "그 세션 하나만 있는 목록" 처럼 보인다.
      if (!entry?.loaded) return prev;
      const groups = upsertSessionInGroups(entry.groups, {
        cli: live.cli,
        session_id: live.session_id,
        cwd: live.cwd,
        title: live.title,
        updated_at: live.updated_at,
        live_status: live.status,
      });
      return { ...prev, [live.manager_id]: { ...entry, groups } };
    });
  }, []));
  // 매니저가 재시작하거나 사라지면(인스턴스 등록/제거) 그 장비의 목록을 다시 묻는다 — 프로세스가 전부
  // 죽었으므로 예전 dot 은 전부 틀린 값이다. 30초 하트비트 갱신(action 'updated')은 무시한다.
  useBoardStreamEvent('agent_instance_update', React.useCallback((data: any) => {
    const action = data?.action;
    const managerId = data?.instance?.agent_id;
    if ((action !== 'registered' && action !== 'removed') || typeof managerId !== 'string') return;
    if (!loadAttemptedRef.current.has(managerId)) return;
    const host = sessionHosts.find((h) => h.manager_id === managerId);
    if (host) void loadHostSessions(host);
  }, [sessionHosts, loadHostSessions]));

  // 세션 섹션이 열려 있고 호스트가 확장된 상태면 자동 로드 (첫 시도만)
  React.useEffect(() => {
    if (sessionsCollapsed || !canUseSessions) return;
    for (const host of sessionHosts) {
      if (collapsedHosts.has(host.manager_id)) continue;
      if (loadAttemptedRef.current.has(host.manager_id)) continue;
      loadAttemptedRef.current.add(host.manager_id);
      void loadHostSessions(host);
    }
  // loadHostSessions는 useCallback으로 안정적이므로 포함, hostSessions는 의도적으로 제외
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsCollapsed, canUseSessions, sessionHosts, collapsedHosts, loadHostSessions]);

  const toggleHostSessions = React.useCallback((host: AgentSessionHost) => {
    setCollapsedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(host.manager_id)) {
        next.delete(host.manager_id);
        if (!loadAttemptedRef.current.has(host.manager_id)) {
          loadAttemptedRef.current.add(host.manager_id);
          void loadHostSessions(host);
        }
      } else {
        next.add(host.manager_id);
      }
      return next;
    });
  }, [loadHostSessions]);

  // 폴드 상태를 localStorage에 저장
  React.useEffect(() => {
    saveSidebarFold({
      sessions: sessionsCollapsed,
      chats: chatsCollapsed,
      sections: sectionCollapsed,
      hosts: Array.from(collapsedHosts),
    });
  }, [sessionsCollapsed, chatsCollapsed, sectionCollapsed, collapsedHosts]);

  const toggleSection = React.useCallback((key: string) => {
    setSectionCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const toggleCwd = React.useCallback((cwdKey: string) => {
    setCollapsedHostCwds((prev) => {
      const next = new Set(prev);
      if (next.has(cwdKey)) next.delete(cwdKey); else next.add(cwdKey);
      return next;
    });
  }, []);

  const sectionFoldButtonStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 5, flex: 1,
    background: 'none', border: 'none', cursor: 'pointer',
    color: 'inherit', fontSize: 'inherit', fontWeight: 'inherit',
    letterSpacing: 'inherit', textTransform: 'inherit' as const,
    padding: 0, textAlign: 'left' as const, userSelect: 'none' as const,
  };

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
        width: overlay ? undefined : 288,
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
        {canUseSessions && (
          <section aria-labelledby="sidebar-sessions-heading">
            {/* 섹션 헤더 — 폴드 토글 + 새 세션 버튼 */}
            <div style={sectionHeaderStyle}>
              <button
                type="button"
                aria-expanded={!sessionsCollapsed}
                onClick={() => setSessionsCollapsed((v) => !v)}
                style={sectionFoldButtonStyle}
              >
                <span aria-hidden="true" style={{ fontSize: 7, color: tokens.colors.textMuted, lineHeight: 1 }}>
                  {sessionsCollapsed ? '▶' : '▼'}
                </span>
                <span id="sidebar-sessions-heading">Sessions</span>
              </button>
              <button
                type="button"
                aria-label="New session"
                title="New session"
                onClick={() => handleNavClick(`${workspaceBase}/sessions?new=1`)}
                style={{ width: 24, height: 24, border: 'none', borderRadius: 6, background: 'transparent', color: tokens.colors.textSecondary, cursor: 'pointer', fontSize: 17, lineHeight: 1 }}
              >
                +
              </button>
            </div>

            {/* 호스트 > cwd > 세션 트리 */}
            {!sessionsCollapsed && (
              <div aria-label="Runtime Hosts" style={{ paddingBottom: 4 }}>
                {sessionHostsLoading && sessionHosts.length === 0 ? (
                  <div style={subListTextStyle}>Loading hosts...</div>
                ) : sessionHosts.length === 0 ? (
                  <div style={subListTextStyle}>No Runtime Host connected</div>
                ) : (
                  sessionHosts.map((host) => {
                    const hostExpanded = !collapsedHosts.has(host.manager_id);
                    const hostData = hostSessions[host.manager_id];
                    const hostBasePath = `${workspaceBase}/sessions/${host.manager_id}`;
                    const hostActive = isPathActive(hostBasePath);
                    return (
                      <React.Fragment key={host.manager_id}>
                        {/* 호스트 행 */}
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <button
                            type="button"
                            onClick={() => handleNavClick(hostBasePath)}
                            aria-current={hostActive ? 'page' : undefined}
                            title={host.hostname && host.hostname !== host.name ? `${host.name} (${host.hostname})` : host.name}
                            style={{ ...navRowStyle(hostActive, true), flex: 1, paddingRight: 4 }}
                            onMouseEnter={(e) => { if (!hostActive) e.currentTarget.style.background = tokens.colors.surfaceHover; }}
                            onMouseLeave={(e) => { if (!hostActive) e.currentTarget.style.background = 'transparent'; }}
                          >
                            <span style={iconStyle(hostActive)} aria-hidden="true">
                              {(host.name[0] || 'H').toUpperCase()}
                            </span>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {host.name}
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-label={hostExpanded ? `Collapse ${host.name}` : `Expand ${host.name}`}
                            aria-expanded={hostExpanded}
                            onClick={() => toggleHostSessions(host)}
                            style={{ width: 24, height: 24, marginRight: 6, border: 'none', borderRadius: 6, background: 'transparent', color: tokens.colors.textMuted, cursor: 'pointer', fontSize: 8, flexShrink: 0 }}
                          >
                            {hostExpanded ? '▼' : '▶'}
                          </button>
                        </div>

                        {/* 세션 트리 */}
                        {hostExpanded && (
                          <div>
                            {hostData?.loading && !hostData.loaded ? (
                              <div style={{ padding: '3px 12px 3px 52px', fontSize: 11, color: tokens.colors.textMuted }}>Loading…</div>
                            ) : !hostData?.groups.length ? (
                              <div style={{ padding: '3px 12px 3px 52px', fontSize: 11, color: tokens.colors.textMuted, fontStyle: 'italic' }}>No sessions</div>
                            ) : (
                              (() => {
                                // 최근 세션이 없는 작업 폴더는 접어 둔다 — 목록 화면이 세션 행에 쓰는 것과 같은 3일 창.
                                const { visible: visibleGroups, hidden: olderGroups } = splitRecentCwdGroups(hostData.groups);
                                const olderHostExpanded = expandedOlderHosts.has(host.manager_id);
                                const shownGroups = olderHostExpanded ? hostData.groups : visibleGroups;
                                return (<>
                              {shownGroups.map((group) => {
                                const cwdKey = `${host.manager_id}:${group.cwd}`;
                                const cwdExpanded = !collapsedHostCwds.has(cwdKey);
                                const hasActive = group.sessions.some(
                                  (s) => location.pathname === sessionPath(`/ws/${wsId ?? ''}`, host.manager_id, s.cli, s.session_id),
                                );
                                return (
                                  <React.Fragment key={cwdKey}>
                                    {/* cwd 헤더 */}
                                    <button
                                      type="button"
                                      onClick={() => toggleCwd(cwdKey)}
                                      title={group.cwd || '(unknown directory)'}
                                      style={{
                                        width: '100%', textAlign: 'left', border: 'none', background: 'transparent',
                                        display: 'flex', alignItems: 'center', gap: 5,
                                        padding: '3px 12px 3px 38px',
                                        color: hasActive ? tokens.colors.accent : tokens.colors.textMuted,
                                        cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', minHeight: 24,
                                      }}
                                      onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.surfaceHover; }}
                                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                    >
                                      <span aria-hidden="true" style={{ fontSize: 7, flexShrink: 0 }}>{cwdExpanded ? '▼' : '▶'}</span>
                                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO }}>
                                        {group.cwdLabel}
                                      </span>
                                      <span style={{ fontSize: 10, color: tokens.colors.textMuted, flexShrink: 0 }}>{group.sessions.length}</span>
                                    </button>
                                    {/* 세션 행 */}
                                    {cwdExpanded && (() => {
                                      const { visible: alwaysVisible, hidden } = splitRecentSessions(group.sessions);
                                      const olderExpanded = expandedOlderCwds.has(cwdKey);
                                      const displayed = olderExpanded ? group.sessions : alwaysVisible;
                                      return (
                                        <>
                                          {displayed.map((s) => {
                                            const sPath = sessionPath(`/ws/${wsId ?? ''}`, host.manager_id, s.cli, s.session_id);
                                            const sActive = location.pathname === sPath;
                                            const statusColor = s.live_status === 'busy' || s.live_status === 'starting'
                                              ? tokens.colors.warningLight
                                              : s.live_status === 'error' ? tokens.colors.dangerLight
                                              : s.live_status === 'ready' || s.live_status === 'awaiting_permission' ? tokens.colors.successLight
                                              : null;
                                            return (
                                              <button
                                                key={s.session_id}
                                                type="button"
                                                onClick={() => handleNavClick(sPath)}
                                                aria-current={sActive ? 'page' : undefined}
                                                title={sessionDisplayTitle(s)}
                                                style={{
                                                  width: '100%', textAlign: 'left', border: 'none',
                                                  borderLeft: `3px solid ${sActive ? tokens.colors.accent : 'transparent'}`,
                                                  background: sActive ? tokens.colors.surfaceHover : 'transparent',
                                                  display: 'flex', alignItems: 'center', gap: 6,
                                                  padding: '2px 10px 2px 50px',
                                                  color: sActive ? tokens.colors.textPrimary : tokens.colors.textSecondary,
                                                  cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', minHeight: 26,
                                                }}
                                                onMouseEnter={(e) => { if (!sActive) e.currentTarget.style.background = tokens.colors.surfaceHover; }}
                                                onMouseLeave={(e) => { if (!sActive) e.currentTarget.style.background = 'transparent'; }}
                                              >
                                                <span style={{ fontSize: 9, fontWeight: 700, color: sActive ? tokens.colors.accent : tokens.colors.textMuted, whiteSpace: 'nowrap', fontFamily: MONO, flexShrink: 0 }}>
                                                  {runtimeLabel(s.cli).slice(0, 2).toUpperCase()}
                                                </span>
                                                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                  {sessionDisplayTitle(s)}
                                                </span>
                                                {statusColor && (
                                                  <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: statusColor }} />
                                                )}
                                              </button>
                                            );
                                          })}
                                          {hidden.length > 0 && (
                                            <button
                                              type="button"
                                              onClick={() => setExpandedOlderCwds((prev) => {
                                                const next = new Set(prev);
                                                if (next.has(cwdKey)) next.delete(cwdKey); else next.add(cwdKey);
                                                return next;
                                              })}
                                              style={{
                                                width: '100%', textAlign: 'left', border: 'none', background: 'transparent',
                                                padding: '2px 10px 2px 50px', color: tokens.colors.textMuted,
                                                cursor: 'pointer', fontSize: 10.5, fontFamily: 'inherit', minHeight: 22,
                                              }}
                                              onMouseEnter={(e) => { e.currentTarget.style.color = tokens.colors.textSecondary; }}
                                              onMouseLeave={(e) => { e.currentTarget.style.color = tokens.colors.textMuted; }}
                                            >
                                              {olderExpanded ? '접기 ↑' : `+${hidden.length}개 더 보기`}
                                            </button>
                                          )}
                                        </>
                                      );
                                    })()}
                                  </React.Fragment>
                                );
                              })}
                              {olderGroups.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setExpandedOlderHosts((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(host.manager_id)) next.delete(host.manager_id);
                                    else next.add(host.manager_id);
                                    return next;
                                  })}
                                  style={{
                                    width: '100%', textAlign: 'left', border: 'none', background: 'transparent',
                                    padding: '2px 10px 2px 38px', color: tokens.colors.textMuted,
                                    cursor: 'pointer', fontSize: 10.5, fontFamily: 'inherit', minHeight: 22,
                                  }}
                                  onMouseEnter={(e) => { e.currentTarget.style.color = tokens.colors.textSecondary; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.color = tokens.colors.textMuted; }}
                                >
                                  {olderHostExpanded ? '접기 ↑' : `+${olderGroups.length}개 폴더 더 보기`}
                                </button>
                              )}
                                </>);
                              })()
                            )}
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </div>
            )}
          </section>
        )}

        {canUseSessions && <div style={{ height: 1, margin: '6px 12px 0', background: tokens.colors.border }} />}

        <section aria-labelledby="sidebar-chat-heading">
          <div style={sectionHeaderStyle}>
            <button
              type="button"
              aria-expanded={!chatsCollapsed}
              onClick={() => setChatsCollapsed((v) => !v)}
              style={sectionFoldButtonStyle}
            >
              <span aria-hidden="true" style={{ fontSize: 7, color: tokens.colors.textMuted, lineHeight: 1 }}>
                {chatsCollapsed ? '▶' : '▼'}
              </span>
              <span id="sidebar-chat-heading">Chat</span>
            </button>
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

          {!chatsCollapsed && renderNavItem({
            key: 'all-chats',
            path: `${workspaceBase}/chat`,
            label: 'All chats',
            icon: 'C',
            badge: counts.chat.total,
            badgeLabel: `읽지 않은 채팅 메시지 ${counts.chat.total}건`,
            exact: true,
          })}

          {!chatsCollapsed && <div
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
          </div>}
        </section>

        <div style={{ height: 1, margin: '6px 12px 0', background: tokens.colors.border }} />

        <div style={{ paddingBottom: 8 }}>
          {workspaceSections.map((section) => {
            const sKey = section.title.toLowerCase();
            const isCollapsed = sectionCollapsed[sKey] ?? false;
            return (
              <section key={section.title} aria-labelledby={`sidebar-${sKey}`}>
                <div style={sectionHeaderStyle}>
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleSection(sKey)}
                    style={sectionFoldButtonStyle}
                  >
                    <span aria-hidden="true" style={{ fontSize: 7, color: tokens.colors.textMuted, lineHeight: 1 }}>
                      {isCollapsed ? '▶' : '▼'}
                    </span>
                    <span id={`sidebar-${sKey}`}>{section.title}</span>
                  </button>
                  {section.title === 'Work' && !isCollapsed && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {counts.tickets.total > 0 && (
                        <button
                          type="button"
                          onClick={handleMarkAllTicketsRead}
                          disabled={markingAllTicketsRead}
                          title={`워크스페이스 전체 읽지 않은 티켓 코멘트 ${counts.tickets.total}건을 모두 읽음으로 표시`}
                          style={{
                            border: 'none', background: 'transparent', color: tokens.colors.accent,
                            fontSize: 10, fontWeight: 700, textTransform: 'none', letterSpacing: 'normal',
                            cursor: markingAllTicketsRead ? 'default' : 'pointer',
                            opacity: markingAllTicketsRead ? 0.5 : 1, padding: '2px 4px',
                          }}
                        >
                          {`${counts.tickets.total}건 모두 읽음`}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {!isCollapsed && section.title === 'Work' && workGroups.map(renderWorkGroup)}
                {!isCollapsed && section.items.map((item) => renderNavItem(item))}
              </section>
            );
          })}

          {canAdmin && (
            <section aria-labelledby="sidebar-operations">
              <div style={sectionHeaderStyle}>
                <button
                  type="button"
                  aria-expanded={!(sectionCollapsed['operations'] ?? false)}
                  onClick={() => toggleSection('operations')}
                  style={sectionFoldButtonStyle}
                >
                  <span aria-hidden="true" style={{ fontSize: 7, color: tokens.colors.textMuted, lineHeight: 1 }}>
                    {(sectionCollapsed['operations'] ?? false) ? '▶' : '▼'}
                  </span>
                  <span id="sidebar-operations">Operations</span>
                </button>
              </div>
              {!(sectionCollapsed['operations'] ?? false) && operations.map((item) => renderNavItem(item))}
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
