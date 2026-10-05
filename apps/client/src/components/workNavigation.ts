import { missionStyle } from './orchestration/status';
import type { ActivityView } from '../activity';

// 사이드바 WORK 섹션의 계층 모델 (티켓 03ca8b5b).
//
// WORK 는 맨 위에 평평한 Tickets 메뉴(워크스페이스 전체 티켓 풀 — 보드는 없어졌다,
// docs/tickets.md) 하나와, Teams / Orchestrations 두 개의 계층형 최상위 메뉴를
// 그 순서대로 노출한다. 계층형 메뉴는 해당 엔티티 목록을 서브메뉴로 편다. active
// 판정을 이 순수 모듈로 뽑아낸 이유는 두 가지다:
//  - 최상위 메뉴 경로끼리 접두사가 겹치면(예전 /orchestration/teams) 두 메뉴가
//    동시에 active 로 보이는 버그가 난다 — 소유 경로 판정을 한곳에 모은다.
//  - 렌더 없이 순서·경로·active·empty 상태를 그대로 단언할 수 있다.

/**
 * 목록이 바뀌었음을 사이드바에 알리는 window 이벤트 이름 — 페이지가 쏘고
 * 사이드바가 듣는다.
 */
export const TEAMS_CHANGED_EVENT = 'orchestration-teams-changed';
export const MISSIONS_CHANGED_EVENT = 'orchestration-missions-changed';

export interface WorkNavChild {
  id: string;
  label: string;
  /**
   * 이 행이 "지금 돌고 있나"를 말하는 공용 진행 상태(src/activity.ts). 사이드바는
   * 색·애니메이션을 스스로 고르지 않고 이 값만 그린다 — 미션 카드·세션 목록·티켓
   * 카드가 같은 어휘를 쓰게 하는 지점이다. 없으면 점을 찍지 않는다.
   */
  activity?: ActivityView;
  /** 클릭 시 이동할 전체 경로(쿼리스트링 포함). */
  path: string;
  active: boolean;
  badge?: number;
  badgeLabel?: string;
}

export type WorkNavGroupKey = 'teams' | 'orchestrations';

export interface WorkNavGroup {
  key: WorkNavGroupKey;
  label: string;
  icon: string;
  /** 최상위 메뉴 자체를 클릭했을 때의 목적지(목록 화면). */
  path: string;
  active: boolean;
  badge?: number;
  badgeLabel?: string;
  children: WorkNavChild[];
  /** 목록이 비었을 때 서브메뉴 자리에 보여줄 문구. */
  emptyLabel: string;
  /** 아직 첫 응답을 받지 못한 상태 — empty state 와 구분해서 보여준다. */
  loading: boolean;
}

export interface WorkNavInput {
  /** Optional mount prefix; ownership is never part of a work address. */
  basePath?: string;
  /** 현재 위치. pathname 만 넘긴다 — 쿼리는 selectedTeamId 로 따로 받는다. */
  pathname: string;
  /** `?team=<id>` 로 선택된 팀(Teams 서브메뉴 active 판정용). */
  selectedTeamId?: string | null;
  teams: Array<{ id: string; name: string }>;
  missions: Array<{ id: string; title: string; status?: string }>;
  teamsLoading?: boolean;
  missionsLoading?: boolean;
}

/**
 * 미션 상태 → 진행 상태. 미션 화면과 **같은** 표(orchestration/status.ts)를 쓴다 —
 * 사이드바용 사본을 만들면 같은 미션이 왼쪽에선 회색, 오른쪽에선 파랑이 된다.
 */
function missionActivityView(status: string): ActivityView {
  const style = missionStyle(status);
  return { label: style.label, tone: style.tone, live: style.live };
}

/** `path` 자신이거나 그 하위 경로인가. */
function isUnder(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/**
 * WORK 맨 위의 평평한 Tickets 메뉴. 배지는 워크스페이스 전체 읽지 않은 티켓
 * 코멘트 수다(보드별 롤업은 보드와 함께 없어졌다).
 */
export interface TicketsNavItem {
  key: 'tickets';
  label: string;
  icon: string;
  path: string;
  active: boolean;
  badge: number;
  badgeLabel: string;
}

export function buildTicketsNavItem(input: {
  /** Optional mount prefix; ownership is never part of a work address. */
  basePath?: string;
  pathname: string;
  ticketUnreadTotal?: number;
}): TicketsNavItem {
  const path = '/tickets';
  const total = input.ticketUnreadTotal || 0;
  return {
    key: 'tickets',
    label: 'Tickets',
    icon: '#',
    path,
    active: isUnder(input.pathname, path),
    badge: total,
    badgeLabel: `읽지 않은 티켓 코멘트 ${total}건`,
  };
}

/**
 * 계층형 최상위 메뉴 2개 + 서브메뉴를 요구된 순서(Teams → Orchestrations)로
 * 만든다. 순서 자체가 요구사항이므로 배열 리터럴 순서를 바꾸지 말 것.
 */
export function buildWorkNavGroups(input: WorkNavInput): WorkNavGroup[] {
  const {
    basePath = '',
    pathname,
    selectedTeamId = null,
    teams,
    missions,
    teamsLoading = false,
    missionsLoading = false,
  } = input;

  const teamsPath = '/teams';
  const orchestrationsPath = '/missions';

  return [
    {
      key: 'teams',
      label: 'Teams',
      icon: 'T',
      path: teamsPath,
      active: isUnder(pathname, teamsPath),
      children: teams.map((team) => ({
        id: team.id,
        label: team.name,
        path: `${teamsPath}?team=${encodeURIComponent(team.id)}`,
        // 팀 전용 상세 라우트가 없어 목록 화면이 곧 상세 화면이다 — 선택은
        // 쿼리 파라미터로 표현되므로 active 도 그걸로 판정한다.
        active: isUnder(pathname, teamsPath) && selectedTeamId === team.id,
      })),
      emptyLabel: 'No teams yet',
      loading: teamsLoading,
    },
    {
      key: 'orchestrations',
      label: 'Missions',
      icon: 'O',
      path: orchestrationsPath,
      active: isUnder(pathname, orchestrationsPath),
      children: missions.map((mission) => ({
        id: mission.id,
        label: mission.title,
        path: `${orchestrationsPath}/${mission.id}`,
        active: pathname === `${orchestrationsPath}/${mission.id}`,
        activity: mission.status ? missionActivityView(mission.status) : undefined,
      })),
      emptyLabel: 'No missions yet',
      loading: missionsLoading,
    },
  ];
}

/**
 * 현재 경로를 소유한 그룹. 라우팅으로 들어온 화면의 그룹은 접혀 있어도 펴서
 * 보여줘야 하므로(딥링크로 미션 상세에 도착한 경우) 그 판정을 여기서 한다.
 */
export function activeWorkGroupKey(groups: WorkNavGroup[]): WorkNavGroupKey | null {
  return groups.find((group) => group.active)?.key ?? null;
}
