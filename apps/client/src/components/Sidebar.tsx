import { t as translate } from '../i18n/core';
import { useLocale } from '../i18n/react';
import LanguageSelect from './LanguageSelect';
import React from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useNotifications } from '../contexts/NotificationContext';
import { NotificationMuteButton, useToast } from '../contexts/ToastContext';
import { ArtifactToggleButton } from './ArtifactPanel';
import { api } from '../api';
import type { AgentSessionUpdateEvent, AgentSessionHost, AgentSessionSummary, ChatRoomListItem } from '../types';
import { tokens } from '../tokens';
import type { ActivityView } from '../activity';
import { MentionInboxBadge } from './common/MentionInboxBadge';
import { NavBadge } from './common/NavBadge';
import { ActivityDot } from './common/ActivityIndicator';
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
  buildTicketsNavItem,
  buildWorkNavGroups,
  type WorkNavGroup,
  type WorkNavGroupKey,
} from './workNavigation';
import { useWorkNavLists } from '../hooks/useWorkNavLists';
import { useAgentSessionsNav } from '../hooks/useAgentSessionsNav';
import { useMarketingInbox } from '../hooks/useMarketingInbox';
import { useRoomActivity } from '../hooks/useRoomActivity';
import { sessionActivity } from '../activity';
import { groupSessionsByCwd, sessionPath, splitRecentCwdGroups, splitRecentSessions, upsertSessionInGroups, type CwdGroup } from './sessions/sessionList.logic';
import { operatorForSession, useVoiceOperators } from '../voice/operator';
import { useWakeState } from '../voice/wakeState';
import WakeToggle from '../voice/WakeToggle';
import { runtimeLabel, sessionDisplayTitle } from './sessions/sessionTranscript.logic';
import { useBoardStream, useBoardStreamEvent } from '../contexts/BoardStreamContext';

import { loadSidebarFold, saveSidebarFold } from './sidebarFold';

/** 호스트 세션 목록이 실패했을 때 다시 묻는 간격·횟수 — 매니저가 서버 재시작 뒤 다시 붙는 데 걸리는 시간을 덮는다. */
const SESSION_LIST_RETRY_MS = 5_000;
const SESSION_LIST_RETRY_MAX = 6;

interface SidebarProps {
  overlay: boolean;
  isOpen: boolean;
  onClose: () => void;
  accountId: string | null;
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
  /** 이 행이 지금 돌고 있나 — 공용 진행 점(src/activity.ts). */
  activity?: ActivityView;
}

function roomDisplayName(room: ChatRoomListItem): string {
  if (room.type === 'dm') return room.name || room.dm_partner_name || translate('Direct Message');
  return room.name || translate('Unnamed Group');
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
  accountId,
  rooms,
  roomsLoading,
  containerRef,
}: SidebarProps) {
  useLocale();
  const { user, logout, hasPermission } = useAuth();
  const { counts, countsLoaded, markAllTicketsReadLocal } = useNotifications();
  const { showToast } = useToast();
  const { teams, missions, teamsLoading, missionsLoading } = useWorkNavLists(accountId);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // WORK 최상위 메뉴별 접기/펼치기. 기본은 모두 펼침 — 어느 메뉴 하나만 다르게
  // 동작하지 않도록 세 그룹이 같은 state 모양을 쓴다.
  // OPERATORS 목록도 같은 모양으로 접는다(키 'operators').
  const [collapsedGroups, setCollapsedGroups] = React.useState<Partial<Record<WorkNavGroupKey | 'operators', boolean>>>(
    // 저장본에서 복원한다. `foldInit` 는 아래에서 선언되므로 여기서 직접 읽는다 —
    // useState 초기화 함수는 최초 렌더에 한 번만 돈다.
    () => loadSidebarFold().groups as Partial<Record<WorkNavGroupKey | 'operators', boolean>>,
  );
  const [visibleGroupCounts, setVisibleGroupCounts] = React.useState<Partial<Record<WorkNavGroupKey, number>>>({});
  const [visibleRoomCount, setVisibleRoomCount] = React.useState(SIDEBAR_ROOMS_BASE_COUNT);
  const [markingAllTicketsRead, setMarkingAllTicketsRead] = React.useState(false);

  // 사이드바 폴드 상태 — 저장본에서 초기화한다. **접기 지점은 빠짐없이 여기서
  // 복원된다**; 하나라도 빠지면 그 메뉴만 새로고침마다 펼쳐져 돌아온다(실제로
  // Teams/Orchestrations 와 호스트 아래 작업 폴더가 그랬다).
  const [foldInit] = React.useState(loadSidebarFold);
  const [sessionsCollapsed, setSessionsCollapsed] = React.useState(() => foldInit.sessions);
  const [chatsCollapsed, setChatsCollapsed] = React.useState(() => foldInit.chats);
  const [sectionCollapsed, setSectionCollapsed] = React.useState<Record<string, boolean>>(() => foldInit.sections);
  const [collapsedHosts, setCollapsedHosts] = React.useState<Set<string>>(() => new Set(foldInit.hosts));
  const [collapsedHostCwds, setCollapsedHostCwds] = React.useState<Set<string>>(() => new Set(foldInit.hostCwds));
  const [expandedOlderCwds, setExpandedOlderCwds] = React.useState<Set<string>>(() => new Set(foldInit.olderCwds));
  // 3일보다 오래된 작업 폴더를 펼쳐 둔 호스트. 세션 행과 같은 창을 쓴다(splitRecentCwdGroups).
  const [expandedOlderHosts, setExpandedOlderHosts] = React.useState<Set<string>>(() => new Set(foldInit.olderHosts));
  const [hostSessions, setHostSessions] = React.useState<Record<string, { groups: CwdGroup[]; loading: boolean; loaded: boolean }>>({});
  const loadAttemptedRef = React.useRef<Set<string>>(new Set());

  // 계정 전체 "모두 읽음" (티켓 628f4b39) — Tickets 페이지의 배너와 같은
  // 동작(서버 upsert 먼저, 그다음 로컬 배지).
  const handleMarkAllTicketsRead = async () => {
    setMarkingAllTicketsRead(true);
    try {
      await api.markAllTicketsRead();
      markAllTicketsReadLocal();
      showToast(translate('읽지 않은 티켓 코멘트를 모두 읽음으로 표시했습니다'), 'success');
    } catch (err: any) {
      showToast(err?.message || translate('읽음 처리에 실패했습니다'), 'error');
    } finally {
      setMarkingAllTicketsRead(false);
    }
  };

  const basePath = '';
  const canAdmin = hasPermission('admin.access');
  // Agent Session(CLI 직접 세션) — Chat 위에 오는 주 작업 표면. 행은 (Runtime Host × CLI)
  // 이고 세션 자체는 그 장비에 있다. 권한이 없는 사용자에겐 섹션을 그리지 않는다.
  const canUseSessions = hasPermission('agent_sessions.use');
  const canUseTerminals = hasPermission('terminals.use');
  const canUseMemory = hasPermission('cli_memory.use');
  // Marketing(docs/marketing.md) — 캠페인 운영(manage) 또는 지출 승인(approve_spend) 중 하나면 행을 그린다.
  // 배지는 이 사용자가 처리할 수 있는 승인 대기 수(서버 GET /api/marketing/inbox 가 계정을 합쳐 센다).
  const canUseMarketing = hasPermission('marketing.manage') || hasPermission('marketing.approve_spend');
  const canUseBusiness = hasPermission('business.manage');
  const marketingPending = useMarketingInbox(canUseMarketing).summary?.total ?? 0;
  // Knowledge — 공용·프로젝트 메모리와 skill 배정은 Agent 를 관리하는 사람이 다룬다(서버 MANAGE_AGENTS).
  const canManageKnowledge = hasPermission('admin.agents');
  // Operators(이름 붙은 Agent Session) — 등록돼 있으면 맨 위에서 어디서든 바로 연다. 머리의 스위치가
  // 음성 지원("헤이 <이름>" 듣기 + 답 낭독)을 켠다(docs/voice-operator.md "음성 지원 · 잠들기").
  const operators = useVoiceOperators(canUseSessions && hasPermission('voice.use'));
  const wake = useWakeState();
  const { hosts: sessionHosts, loading: sessionHostsLoading } = useAgentSessionsNav(canUseSessions && accountId ? accountId : null);

  // 다른 사용자로 로그인할 때만 목록과 세션 캐시를 초기화한다.
  React.useEffect(() => {
    setVisibleRoomCount(SIDEBAR_ROOMS_BASE_COUNT);
    setVisibleGroupCounts({});
    // 폴드 상태는 localStorage에 유지한다.
    loadAttemptedRef.current.clear();
    pendingHostReloadRef.current.clear();
    lastGoodByCliRef.current = {};
    for (const retry of Object.values(retryRef.current)) if (retry.timer !== null) window.clearTimeout(retry.timer);
    retryRef.current = {};
    setHostSessions({});
  }, [user?.id]);

  const isPathActive = (path: string): boolean =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  const handleNavClick = (path: string) => {
    if (!path) return;
    navigate(path);
    if (overlay) onClose();
  };

  const featureSections: Array<{ title: string; items: NavItem[] }> = [
    {
      // Tickets(계정 전체 티켓 풀)는 맨 위 평평한 행으로, Teams /
      // Orchestrations 는 목록을 서브메뉴로 펴는 계층형 그룹이라 평평한 items 가
      // 아니라 workGroups 로 따로 그린다(티켓 03ca8b5b).
      title: 'Work',
      items: [
        // P4c-4: AI Agents 표면 제거 (Agent 테이블 삭제) — 실행 주체는
        // Sessions/Runtime Hosts 에서 본다.
        // Terminal(Runtime Host 셸) — 기본 admin 전용 권한이라 없는 사용자에게는 행 자체를
        // 그리지 않는다(눌러도 403 인 행을 남겨 두지 않는다).
        ...(canUseTerminals
          ? [{
            key: 'terminals',
            path: `${basePath}/terminals`,
            label: translate('Terminals'),
            icon: 'T',
          }]
          : []),
      ],
    },
    {
      title: 'Business',
      items: [
        ...(canUseBusiness ? [
          { key: 'business', path: '/business', label: translate('회사 · 전체 흐름'), icon: '◈', exact: true },
          { key: 'business-operations', path: '/business/operations', label: translate('운영 워크플로'), icon: '↗' },
          { key: 'business-mail', path: '/business/mail', label: translate('메일'), icon: '✉' },
          { key: 'business-connectors', path: '/business/connectors', label: translate('커넥터'), icon: '⌘' },
        ] : []),
        ...(canUseMarketing
          ? [{
            key: 'marketing',
            path: `${basePath}/marketing`,
            label: translate('Marketing'),
            icon: 'M',
            badge: marketingPending,
            badgeLabel: translate('승인 대기 {0}건', { 0: marketingPending }),
          }]
          : []),
      ],
    },
    {
      title: 'Automation',
      items: [
        { key: 'functions', path: `${basePath}/functions`, label: translate('Functions'), icon: 'F' },
        { key: 'actions', path: `${basePath}/actions`, label: translate('Actions'), icon: 'A' },
        { key: 'schedules', path: `${basePath}/schedules`, label: translate('Schedules'), icon: 'S' },
      ],
    },
    {
      title: 'Knowledge',
      items: [
        // 저장소(repository) — 티켓/미션/QA 가 가리키는 프로젝트와 Host 별 메인 클론 폴더.
        { key: 'projects', path: `${basePath}/projects`, label: translate('Projects'), icon: 'P' },
        { key: 'resources', path: `${basePath}/resources`, label: translate('Resources'), icon: 'R' },
        // 설치물(APK)·공유 파일 자료실 — 바이트는 Resource, 겉장은 LibraryItem.
        { key: 'library', path: `${basePath}/library`, label: translate('Library'), icon: 'L' },
        {
          key: 'ontology-graph',
          path: `${basePath}/ontology-graph`,
          label: translate('Ontology Graph'),
          icon: 'G',
        },
        // Memory · Skills — Agent 가 아는 것(docs/skills.md "Knowledge"): 공용 / 프로젝트별 메모리와 호스트 CLI 파일,
        // 범위별 skill 배정. 권한이 없는 사용자에게는 행 자체를 그리지 않는다.
        ...(canUseMemory || canManageKnowledge
          ? [{
            key: 'memory',
            path: `${basePath}/memory`,
            label: translate('Memory'),
            icon: 'M',
          }]
          : []),
        ...(canManageKnowledge
          ? [{
            key: 'skills',
            path: `${basePath}/skills`,
            label: translate('Skills'),
            icon: 'S',
          }]
          : []),
      ],
    },
    {
      title: 'Quality',
      items: [
        { key: 'qa', path: `${basePath}/qa`, label: translate('QA'), icon: 'Q' },
        { key: 'security', path: `${basePath}/security`, label: translate('Security'), icon: 'S' },
      ],
    },
    {
      title: 'Settings',
      items: [
        {
          key: 'settings-overview',
          path: `${basePath}/settings`,
          label: translate('Settings Overview'),
          icon: 'S',
          exact: true,
        },
        { key: 'work-defaults', path: `${basePath}/settings/defaults`, label: translate('Work defaults'), icon: 'O' },
        { key: 'users', path: `${basePath}/settings/users`, label: translate('Users'), icon: 'U' },
        { key: 'credentials', path: `${basePath}/settings/credentials`, label: translate('Credentials'), icon: 'C' },
        { key: 'channels', path: `${basePath}/settings/channels`, label: translate('Channels'), icon: 'N' },
        { key: 'api-keys', path: `${basePath}/settings/api-keys`, label: translate('API Keys'), icon: 'K' },
        {
          key: 'claude-profiles',
          path: `${basePath}/settings/claude-profiles`,
          label: translate('Claude Profiles'),
          icon: 'C',
        },
        ...(canAdmin
          ? [
              {
                key: 'admin-users',
                path: '/admin/users',
                label: translate('User Administration'),
                icon: 'U',
                badge: counts.pendingUsers,
                badgeLabel: translate('승인 대기 중인 가입 요청 {0}건', { 0: counts.pendingUsers }),
              },
              { key: 'system-settings', path: '/admin/settings', label: translate('System Settings'), icon: 'S' },
              { key: 'voice', path: '/admin/voice', label: translate('Voice'), icon: 'V' },
              { key: 'migration', path: '/admin/migration', label: translate('Live Import'), icon: 'M' },
            ]
          : []),
      ],
    },
  ];

  const operations: NavItem[] = [
    {
      key: 'workflow-health',
      path: '/admin/workflow-health',
      label: translate('Workflow Health'),
      icon: 'H',
    },
    {
      key: 'skill-registry',
      path: '/admin/skill-registry',
      label: translate('Skill Registry'),
      icon: 'R',
    },
    { key: 'server-logs', path: '/admin/logs', label: translate('Server Logs'), icon: 'L' },
    {
      key: 'agent-logs',
      path: '/admin/agent-logs',
      label: translate('Agent Logs'),
      icon: 'G',
      badge: counts.agentErrors,
      badgeLabel: translate('마지막 확인 이후 새 에러 로그 {0}건', { 0: counts.agentErrors }),
    },
  ];

  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  // 호스트 세션 목록 로드. **실패를 "세션 없음" 으로 바꾸지 않는다** — 서버 재시작 직후처럼 매니저가
  // 아직 다 붙지 않았을 때 목록 요청은 실패(host_offline·timeout)하는데, 예전에는 그 실패를 빈 목록으로
  // 저장하고 다시 묻지 않아서 그 호스트의 세션이 사이드바에서 사라진 채 남았다(운영 보고 2026-10-02).
  // 실패한 CLI 는 마지막으로 받은 목록을 유지하고, 잠시 뒤 다시 묻는다(횟수 제한).
  const lastGoodByCliRef = React.useRef<Record<string, Record<string, AgentSessionSummary[]>>>({});
  const loadSeqRef = React.useRef<Record<string, number>>({});
  const retryRef = React.useRef<Record<string, { timer: number | null; attempts: number }>>({});
  const sessionHostsRef = React.useRef<AgentSessionHost[]>(sessionHosts);
  sessionHostsRef.current = sessionHosts;
  const loadHostSessionsRef = React.useRef<(host: AgentSessionHost, fresh?: boolean) => Promise<void>>(async () => {});
  const loadHostSessions = React.useCallback(async (host: AgentSessionHost, fresh = true) => {
    const { manager_id: managerId } = host;
    const seq = (loadSeqRef.current[managerId] ?? 0) + 1;
    loadSeqRef.current[managerId] = seq;
    const retry = retryRef.current[managerId] ?? { timer: null, attempts: 0 };
    retryRef.current[managerId] = retry;
    if (retry.timer !== null) {
      window.clearTimeout(retry.timer);
      retry.timer = null;
    }
    // 새 계기(펼침·매니저 재접속·스트림 재연결)는 재시도 횟수를 새로 센다.
    if (fresh) retry.attempts = 0;
    setHostSessions((prev) => ({
      ...prev,
      [managerId]: { groups: prev[managerId]?.groups ?? [], loading: true, loaded: prev[managerId]?.loaded ?? false },
    }));
    const lastGood = lastGoodByCliRef.current[managerId] ?? {};
    const byCliMap: Record<string, AgentSessionSummary[]> = {};
    const fetched: Record<string, AgentSessionSummary[]> = {};
    let failed = false;
    await Promise.all(host.clis.map(async (cli) => {
      try {
        const list = await api.listHostSessions(managerId, cli);
        byCliMap[cli] = fetched[cli] = Array.isArray(list) ? list : [];
      } catch {
        failed = true;
        byCliMap[cli] = lastGood[cli] ?? [];
      }
    }));
    // 그 사이 더 새 로드가 시작됐으면 그 결과를 기다린다(늦게 온 옛 응답이 덮지 않게).
    if (loadSeqRef.current[managerId] !== seq) return;
    lastGoodByCliRef.current[managerId] = { ...lastGood, ...fetched };
    setHostSessions((prev) => ({ ...prev, [managerId]: { groups: groupSessionsByCwd(byCliMap), loading: false, loaded: true } }));
    if (failed && retry.attempts < SESSION_LIST_RETRY_MAX) {
      retry.attempts += 1;
      retry.timer = window.setTimeout(() => {
        retry.timer = null;
        const latest = sessionHostsRef.current.find((h) => h.manager_id === managerId);
        if (latest) void loadHostSessionsRef.current(latest, false);
        else pendingHostReloadRef.current.add(managerId);
      }, SESSION_LIST_RETRY_MS);
    }
  }, []);
  loadHostSessionsRef.current = loadHostSessions;

  // 다시 물어야 하는데 호스트가 아직 목록에 없는 매니저 — 목록에 나타나는 순간 로드한다.
  const pendingHostReloadRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    for (const host of sessionHosts) {
      if (!pendingHostReloadRef.current.delete(host.manager_id)) continue;
      if (loadAttemptedRef.current.has(host.manager_id)) void loadHostSessions(host);
    }
  }, [sessionHosts, loadHostSessions]);

  React.useEffect(() => () => {
    for (const retry of Object.values(retryRef.current)) if (retry.timer !== null) window.clearTimeout(retry.timer);
  }, []);

  /** 이미 불러온 적 있는 호스트를 다시 묻는다. 지금 목록에 없으면 나타날 때 묻는다. */
  const reloadAttemptedHost = React.useCallback((managerId: string) => {
    if (!loadAttemptedRef.current.has(managerId)) return;
    const host = sessionHostsRef.current.find((h) => h.manager_id === managerId);
    if (host) void loadHostSessions(host);
    else pendingHostReloadRef.current.add(managerId);
  }, [loadHostSessions]);

  // 이 브라우저의 SSE 가 끊겼다 다시 붙으면(대개 서버 재시작) 그 사이의 매니저 재접속 이벤트를 놓쳤을 수
  // 있다 — 불러온 적 있는 호스트를 모두 다시 묻는다. 첫 연결(false→true)은 끊김이 아니다.
  const { isConnected: streamConnected } = useBoardStream();
  const streamStateRef = React.useRef({ was: false, ever: false });
  React.useEffect(() => {
    const st = streamStateRef.current;
    const reconnected = streamConnected && !st.was && st.ever;
    st.was = streamConnected;
    if (streamConnected) st.ever = true;
    if (!reconnected) return;
    for (const managerId of loadAttemptedRef.current) reloadAttemptedHost(managerId);
  }, [streamConnected, reloadAttemptedHost]);

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
  // 호스트 목록(useAgentSessionsNav)도 같은 이벤트로 다시 받아 오므로, 방금 붙은 매니저가 아직 이
  // 렌더의 목록에 없을 수 있다 — 그때는 목록에 나타날 때 묻는다(예전에는 여기서 조용히 건너뛰었다).
  useBoardStreamEvent('agent_instance_update', React.useCallback((data: any) => {
    const action = data?.action;
    const managerId = data?.instance?.agent_id;
    if ((action !== 'registered' && action !== 'removed') || typeof managerId !== 'string') return;
    reloadAttemptedHost(managerId);
  }, [reloadAttemptedHost]));

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

  // 폴드 상태 저장. **접기 지점을 추가하면 이 객체와 의존성 배열에도 넣어야 한다** —
  // 빠뜨리면 그 메뉴만 저장되지 않고, 화면에서는 접히는데 새로고침하면 돌아온다.
  // `sidebar-fold-persistence.test.mjs` 가 이 목록과 복원 목록을 맞춰 본다.
  React.useEffect(() => {
    saveSidebarFold({
      sessions: sessionsCollapsed,
      chats: chatsCollapsed,
      sections: sectionCollapsed,
      groups: collapsedGroups as Record<string, boolean>,
      hosts: Array.from(collapsedHosts),
      hostCwds: Array.from(collapsedHostCwds),
      olderCwds: Array.from(expandedOlderCwds),
      olderHosts: Array.from(expandedOlderHosts),
    });
  }, [
    sessionsCollapsed, chatsCollapsed, sectionCollapsed, collapsedGroups,
    collapsedHosts, collapsedHostCwds, expandedOlderCwds, expandedOlderHosts,
  ]);

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
        {item.activity && <ActivityDot view={item.activity} size={6} />}
        {!!item.badge && item.badge > 0 && <NavBadge count={item.badge} label={item.badgeLabel} />}
      </button>
    );
  };

  // WORK — 맨 위 Tickets 한 줄(계정 전체 미읽음 배지), 그다음 Teams /
  // Orchestrations 를 그 순서대로 각자의 목록을 서브메뉴로 펴서 보여준다(티켓 03ca8b5b).
  const ticketsNav = buildTicketsNavItem({
    basePath,
    pathname: location.pathname,
    ticketUnreadTotal: counts.tickets.total,
  });
  const workGroups = buildWorkNavGroups({
    basePath,
    pathname: location.pathname,
    selectedTeamId: searchParams.get('team'),
    teams,
    missions,
    teamsLoading,
    missionsLoading,
  });

  // 앱 안에서 다른 그룹의 영역으로 **이동하면** 접혀 있던 그 그룹을 편다 — 그러지
  // 않으면 현재 위치를 가리키는 서브 항목이 접힌 채 숨는다. 사용자가 직접 접은 다른
  // 그룹은 그대로 둔다.
  //
  // **최초 렌더에서는 펴지 않는다.** 예전에는 마운트에서도 돌아서, 저장된 폴드를
  // 복원해도 "지금 보고 있는 화면이 속한 그룹" 하나는 매번 다시 펼쳐졌다 — 그룹을
  // 접어 둔 채 그 화면에서 새로고침하면 도로 펴졌다. 새로고침은 "이동" 이
  // 아니라 **같은 자리로 돌아오는 것**이므로, 저장된 상태가 이긴다.
  const activeGroupKey = activeWorkGroupKey(workGroups);
  // "이동했는가" 의 기준은 **경로**다. 효과 실행 횟수로 세면 안 된다 — `activeGroupKey`
  // 는 팀·미션 목록이 늦게 도착하면서 mount 이후에 null → 'teams' 로 채워지므로,
  // "첫 실행만 건너뛰기" 는 엉뚱한 실행을 소비하고 정작 값이 생겼을 때 펴 버린다
  // (실측: 그룹을 접어 둔 채 그 화면에서 새로고침하면 도로 펴졌다).
  const mountedPathRef = React.useRef(location.pathname);
  React.useEffect(() => {
    if (!activeGroupKey) return;
    // 같은 자리로 돌아온 것(새로고침·딥링크 전체 로드)은 이동이 아니다 — 저장된
    // 폴드가 이긴다.
    if (location.pathname === mountedPathRef.current) return;
    setCollapsedGroups((prev) => (prev[activeGroupKey] ? { ...prev, [activeGroupKey]: false } : prev));
  }, [activeGroupKey, location.pathname]);

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
            aria-label={expanded ? translate('Collapse {0} list', { 0: group.label }) : translate('Expand {0} list', { 0: group.label })}
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
          <div aria-label={translate('{0} list', { 0: group.label })}>
            {group.loading && group.children.length === 0 ? (
              <div style={subListTextStyle}>{translate('Loading {0}...', { 0: group.label.toLowerCase() })}</div>
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
                    activity: child.activity,
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
                    ? translate('{0} 더보기, {1}개 더 보기', { 0: group.label, 1: hiddenItems.length })
                    : translate('{0} 목록 접기', { 0: group.label })
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
                  {hiddenItems.length > 0 ? translate('더보기 ({0})', { 0: hiddenItems.length }) : translate('접기')}
                </span>
              </button>
            )}
          </div>
        )}
      </React.Fragment>
    );
  };

  // 왼쪽 프레임의 채팅 행이 "지금 이 방에서 에이전트가 일하고 있다"를 말한다.
  const roomActivity = useRoomActivity();

  const activeRoomId = rooms.find((room) => location.pathname === `${basePath}/chat/${room.id}`)?.id ?? null;
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
      aria-label={overlay ? translate('Navigation') : undefined}
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
          onClick={() => handleNavClick('/sessions')}
          aria-label={translate('AWB home')}
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
          {translate('W')}</button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.textPrimary }}>AWB</div>
          <div style={{ marginTop: 1, fontSize: 10, color: tokens.colors.textMuted }}>AI Workflow Board</div>
        </div>
        <MentionInboxBadge accountId={accountId} />
        <NotificationSettingsPanel />
        {/* Former main-frame header buttons — the desktop AWB brand bar is
            gone, so mute/artifact toggles live here on desktop. The drawer
            leaves them to the mobile top bar, which already shows both: in a
            260px header they doubled up and squeezed the brand. */}
        {!overlay && <NotificationMuteButton />}
        {!overlay && <ArtifactToggleButton />}
      </div>

      <nav
        aria-label={translate('Primary navigation')}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
      >
        {/* OPERATORS — HOSTS 와 같은 높이의 메뉴 줄이고, 등록된 operator 들이 그 아래 한 단계 들여 나온다
            (WORK 의 Teams/Orchestrations 목록과 같은 모양). 섹션 머리(SESSIONS · CHAT …)로 두면 그 아래 오는
            HOSTS 줄까지 operator 묶음처럼 보인다. 줄을 누르면 목록을 펴고 접는다 — operator 를 모아 보는
            화면은 따로 없다(관리는 Admin → Voice). */}
        {operators.length > 0 && accountId && (() => {
          const expanded = !collapsedGroups.operators;
          const awakeOperator = wake.mode === 'awake' ? operators.find((op) => op.id === wake.operatorId) ?? null : null;
          const toggle = () => setCollapsedGroups((prev) => ({ ...prev, operators: expanded }));
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={expanded}
                  aria-controls="sidebar-operators-list"
                  title={awakeOperator ? translate('Operators — {0} 깨어 있음', { 0: awakeOperator.name }) : translate('Operators — 이름을 불러 깨우는 세션들')}
                  style={{ ...navRowStyle(false), width: 'auto', flex: 1, minWidth: 0 }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = tokens.colors.surfaceHover; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={iconStyle(false)} aria-hidden="true">🎙</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {translate('OPERATORS')}</span>
                  {/* 접어 둬도 누가 깨어 있는지는 보인다. */}
                  {!expanded && awakeOperator && <ActivityDot view={{ label: translate('{0} 깨어 있음', { 0: awakeOperator.name }), tone: 'live', live: true }} size={6} />}
                </button>
                <WakeToggle operators={operators} />
                <button
                  type="button"
                  aria-label={expanded ? translate('Collapse Operators list') : translate('Expand Operators list')}
                  aria-expanded={expanded}
                  onClick={toggle}
                  style={{ width: 24, height: 24, marginRight: 8, border: 'none', borderRadius: 6, background: 'transparent', color: tokens.colors.textMuted, cursor: 'pointer', fontSize: 10, flexShrink: 0 }}
                >
                  {expanded ? '\u25BC' : '\u25B6'}
                </button>
              </div>
              {expanded && (
                <div id="sidebar-operators-list" aria-label={translate('Operators list')}>
                  {operators.map((op) => {
                    const awake = awakeOperator?.id === op.id;
                    return renderNavItem({
                      key: `operator-${op.id}`,
                      path: sessionPath(``, op.manager_id, op.cli, op.session_id),
                      label: op.name,
                      icon: (op.name.trim()[0] || 'O').toUpperCase(),
                      title: `${op.name} — ${op.title || runtimeLabel(op.cli)}${awake ? translate(' (깨어 있음)') : ''}`,
                      ...(awake ? { activity: { label: translate('깨어 있음'), tone: 'live' as const, live: true } } : {}),
                    }, true);
                  })}
                </div>
              )}
            </>
          );
        })()}
        {canAdmin && renderNavItem({
          key: 'hosts',
          path: `${basePath}/hosts`,
          label: translate('HOSTS'),
          icon: 'H',
        })}
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
                <span id="sidebar-sessions-heading">{translate('Sessions')}</span>
              </button>
              <button
                type="button"
                aria-label={translate('New session')}
                title={translate('New session')}
                onClick={() => handleNavClick(`${basePath}/sessions?new=1`)}
                style={{ width: 24, height: 24, border: 'none', borderRadius: 6, background: 'transparent', color: tokens.colors.textSecondary, cursor: 'pointer', fontSize: 17, lineHeight: 1 }}
              >
                +
              </button>
            </div>

            {/* 호스트 > cwd > 세션 트리 */}
            {!sessionsCollapsed && (
              <div aria-label={translate('Runtime Hosts')} style={{ paddingBottom: 4 }}>
                {sessionHostsLoading && sessionHosts.length === 0 ? (
                  <div style={subListTextStyle}>{translate('Loading hosts...')}</div>
                ) : sessionHosts.length === 0 ? (
                  <div style={subListTextStyle}>{translate('No Runtime Host connected')}</div>
                ) : (
                  sessionHosts.map((host) => {
                    const hostExpanded = !collapsedHosts.has(host.manager_id);
                    const hostData = hostSessions[host.manager_id];
                    const hostBasePath = `${basePath}/sessions/${host.manager_id}`;
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
                              {(host.name[0] || translate('H')).toUpperCase()}
                            </span>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {host.name}
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-label={hostExpanded ? translate('Collapse {0}', { 0: host.name }) : translate('Expand {0}', { 0: host.name })}
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
                              <div style={{ padding: '3px 12px 3px 52px', fontSize: 11, color: tokens.colors.textMuted }}>{translate('Loading…')}</div>
                            ) : !hostData?.groups.length ? (
                              <div style={{ padding: '3px 12px 3px 52px', fontSize: 11, color: tokens.colors.textMuted, fontStyle: 'italic' }}>{translate('No sessions')}</div>
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
                                  (s) => location.pathname === sessionPath(``, host.manager_id, s.cli, s.session_id),
                                );
                                return (
                                  <React.Fragment key={cwdKey}>
                                    {/* cwd 헤더 */}
                                    <button
                                      type="button"
                                      onClick={() => toggleCwd(cwdKey)}
                                      title={group.cwd || translate('(unknown directory)')}
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
                                            const sPath = sessionPath(``, host.manager_id, s.cli, s.session_id);
                                            const sActive = location.pathname === sPath;
                                            const displayTitle = operatorForSession(operators, host.manager_id, s.cli, s.session_id)?.name ?? sessionDisplayTitle(s);
                                            // 세션 목록·세션 헤더와 **같은** 어휘. 예전엔 여기에만
                                            // 따로 색 표가 있어 같은 'busy' 세션이 사이드바에선
                                            // 노란 점, 세션 화면에선 파란 pill 로 보였다.
                                            const activity = sessionActivity(s.live_status);
                                            return (
                                              <button
                                                key={s.session_id}
                                                type="button"
                                                onClick={() => handleNavClick(sPath)}
                                                aria-current={sActive ? 'page' : undefined}
                                                title={displayTitle}
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
                                                  {displayTitle}
                                                </span>
                                                <ActivityDot view={activity} size={6} />
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
                                              {olderExpanded ? translate('접기 ↑') : translate('+{0}개 더 보기', { 0: hidden.length })}
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
                                  {olderHostExpanded ? translate('접기 ↑') : translate('+{0}개 폴더 더 보기', { 0: olderGroups.length })}
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
              <span id="sidebar-chat-heading">{translate('Chat')}</span>
            </button>
            <button
              type="button"
              aria-label={translate('New chat')}
              title={translate('New chat')}
              onClick={() => handleNavClick(`${basePath}/chat?new=1`)}
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
            path: `${basePath}/chat`,
            label: translate('All chats'),
            icon: 'C',
            badge: counts.chat.total,
            badgeLabel: translate('읽지 않은 채팅 메시지 {0}건', { 0: counts.chat.total }),
            exact: true,
          })}

          {!chatsCollapsed && <div
            aria-label={translate('Chat rooms')}
            style={{
              minHeight: roomsLoading ? 40 : undefined,
              paddingBottom: 4,
            }}
          >
            {roomsLoading && rooms.length === 0 ? (
              <div style={{ padding: '8px 14px 10px 46px', fontSize: 11, color: tokens.colors.textMuted }}>
                {translate('Loading chats...')}</div>
            ) : rooms.length === 0 ? (
              <div style={{ padding: '8px 14px 10px 46px', fontSize: 11, color: tokens.colors.textMuted }}>
                {translate('No chats yet')}</div>
            ) : (
              displayRooms.map((room) => {
                const roomPath = `${basePath}/chat/${room.id}`;
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
                    <ActivityDot view={roomActivity.view(room.id)} size={6} />
                    {unread > 0 && (
                      <NavBadge
                        count={unread}
                        label={translate('{0} 읽지 않은 메시지 {1}건', { 0: roomDisplayName(room), 1: unread })}
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
                    ? translate('더보기, {0}개 더 보기', { 0: hiddenRooms.length })
                    : translate('채팅 목록 접기')
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
                  {hiddenRooms.length > 0 ? translate('더보기 ({0})', { 0: hiddenRooms.length }) : translate('접기')}
                </span>
                {hiddenRooms.length > 0 && hiddenUnreadTotal > 0 && (
                  <NavBadge
                    count={hiddenUnreadTotal}
                    label={translate('숨겨진 채팅의 읽지 않은 메시지 {0}건', { 0: hiddenUnreadTotal })}
                  />
                )}
              </button>
            )}
          </div>}
        </section>

        <div style={{ height: 1, margin: '6px 12px 0', background: tokens.colors.border }} />

        <div style={{ paddingBottom: 8 }}>
          {featureSections.map((section) => {
            if (section.title === 'Business' && !section.items.length) return null;
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
                    <span id={`sidebar-${sKey}`}>{translate(section.title)}</span>
                  </button>
                  {section.title === 'Work' && !isCollapsed && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {counts.tickets.total > 0 && (
                        <button
                          type="button"
                          onClick={handleMarkAllTicketsRead}
                          disabled={markingAllTicketsRead}
                          title={translate('읽지 않은 티켓 코멘트 {0}건을 모두 읽음으로 표시', { 0: counts.tickets.total })}
                          style={{
                            border: 'none', background: 'transparent', color: tokens.colors.accent,
                            fontSize: 10, fontWeight: 700, textTransform: 'none', letterSpacing: 'normal',
                            cursor: markingAllTicketsRead ? 'default' : 'pointer',
                            opacity: markingAllTicketsRead ? 0.5 : 1, padding: '2px 4px',
                          }}
                        >
                          {translate('{0}건 모두 읽음', { 0: counts.tickets.total })}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {!isCollapsed && section.title === 'Work' && renderNavItem(ticketsNav)}
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
                  <span id="sidebar-operations">{translate('Operations')}</span>
                </button>
              </div>
              {!(sectionCollapsed['operations'] ?? false) && operations.map((item) => renderNavItem(item))}
            </section>
          )}
        </div>
      </nav>

      <div style={{ padding: '8px 12px', borderTop: `1px solid ${tokens.colors.border}` }}>
        <LanguageSelect />
      </div>
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
              {user.name || translate('User')}
            </div>
            <div
              style={{
                marginTop: 1,
                fontSize: 9,
                color: tokens.colors.textMuted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {(user.role || '').toUpperCase()}
            </div>
          </div>
          <button
            type="button"
            onClick={async () => logout()}
            title={translate('Logout')}
            aria-label={translate('Logout')}
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
