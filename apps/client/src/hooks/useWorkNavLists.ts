import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import type { OrchestrationUpdateEvent } from '../types';
import { MISSIONS_CHANGED_EVENT, TEAMS_CHANGED_EVENT } from '../components/workNavigation';

/**
 * 사이드바 WORK 섹션이 서브메뉴로 펼치는 Teams/Orchestrations 목록 (티켓 03ca8b5b).
 *
 * Boards 는 이미 AppLayout 이 받아 Sidebar 에 prop 으로 넘겨주지만, 이 두 목록은
 * SSE(`orchestration_update`)로 갱신돼야 해서 여기서 직접 가져온다 — AppLayout 은
 * BoardStreamProvider 를 *렌더하는* 쪽이라 그 훅을 쓸 수 없고, Sidebar 는 provider
 * 안쪽이라 쓸 수 있다.
 */

/** 내비게이션이지 목록 화면이 아니므로 가져오는 미션 수에 상한을 둔다. */
export const WORK_NAV_MISSION_LIMIT = 50;

export interface WorkNavTeam {
  id: string;
  name: string;
}

export interface WorkNavMission {
  id: string;
  title: string;
}

export interface WorkNavLists {
  teams: WorkNavTeam[];
  missions: WorkNavMission[];
  teamsLoading: boolean;
  missionsLoading: boolean;
}

export function useWorkNavLists(wsId: string | null): WorkNavLists {
  const [teams, setTeams] = useState<WorkNavTeam[]>([]);
  const [missions, setMissions] = useState<WorkNavMission[]>([]);
  // SSE 핸들러가 "이미 아는 미션인가"를 **동기적으로** 판정해야 한다. setMissions
  // updater 안에서 판정하면 React 가 그 함수를 렌더 시점까지 미루므로 판정 결과를
  // 핸들러 본문에서 읽을 수 없다(항상 미지 취급 → 매 프레임 재조회).
  const missionsRef = useRef<WorkNavMission[]>([]);
  missionsRef.current = missions;
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [missionsLoading, setMissionsLoading] = useState(false);

  // 워크스페이스를 빠르게 전환하면 이전 워크스페이스의 응답이 늦게 도착해 새
  // 워크스페이스의 목록을 덮어쓸 수 있다 — 요청 세대를 세어 마지막 것만 반영한다.
  const generationRef = useRef(0);

  const fetchTeams = useCallback(async (workspaceId: string, generation: number) => {
    setTeamsLoading(true);
    try {
      const list = await api.listOrchestrationTeams(workspaceId);
      if (generationRef.current !== generation) return;
      setTeams(list.map((team) => ({ id: team.id, name: team.name })));
    } catch {
      if (generationRef.current !== generation) return;
      setTeams([]);
    } finally {
      if (generationRef.current === generation) setTeamsLoading(false);
    }
  }, []);

  const fetchMissions = useCallback(async (workspaceId: string, generation: number) => {
    setMissionsLoading(true);
    try {
      const list = await api.listOrchestrationMissions(workspaceId, { limit: WORK_NAV_MISSION_LIMIT });
      if (generationRef.current !== generation) return;
      setMissions(list.map((mission) => ({ id: mission.id, title: mission.title })));
    } catch {
      if (generationRef.current !== generation) return;
      setMissions([]);
    } finally {
      if (generationRef.current === generation) setMissionsLoading(false);
    }
  }, []);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!wsId) {
      setTeams([]);
      setMissions([]);
      setTeamsLoading(false);
      setMissionsLoading(false);
      return;
    }
    void fetchTeams(wsId, generation);
    void fetchMissions(wsId, generation);
  }, [wsId, fetchTeams, fetchMissions]);

  // 페이지에서 팀/미션을 만들거나 지우면 곧바로 서브메뉴에 반영한다.
  useEffect(() => {
    if (!wsId) return;
    const reloadTeams = () => void fetchTeams(wsId, generationRef.current);
    const reloadMissions = () => void fetchMissions(wsId, generationRef.current);
    window.addEventListener(TEAMS_CHANGED_EVENT, reloadTeams);
    window.addEventListener(MISSIONS_CHANGED_EVENT, reloadMissions);
    return () => {
      window.removeEventListener(TEAMS_CHANGED_EVENT, reloadTeams);
      window.removeEventListener(MISSIONS_CHANGED_EVENT, reloadMissions);
    };
  }, [wsId, fetchTeams, fetchMissions]);

  // 에이전트가 만든 미션도 새로고침 없이 나타나야 한다. 프레임이 title 을 실어
  // 오므로 이미 아는 미션은 제자리에서 이름만 고치고(바쁜 미션이 step 전이마다
  // 프레임을 쏘는데 그때마다 목록을 다시 받으면 낭비), 모르는 미션일 때만 재조회한다.
  useBoardStreamEvent('orchestration_update', (data: OrchestrationUpdateEvent) => {
    if (!wsId || !data || data.workspace_id !== wsId) return;
    if (!missionsRef.current.some((mission) => mission.id === data.mission_id)) {
      void fetchMissions(wsId, generationRef.current);
      return;
    }
    setMissions((prev) => {
      const idx = prev.findIndex((mission) => mission.id === data.mission_id);
      if (idx === -1 || prev[idx].title === data.title) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], title: data.title };
      return next;
    });
  });

  return { teams, missions, teamsLoading, missionsLoading };
}
