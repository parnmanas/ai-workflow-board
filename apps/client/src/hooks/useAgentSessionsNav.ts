import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import type { AgentSessionSnapshot, AgentSessionUpdateEvent } from '../types';
import { applySessionUpdate, sortSessionsByActivity } from '../components/sessions/sessionList.logic';

export { applySessionUpdate, sortSessionsByActivity } from '../components/sessions/sessionList.logic';

/**
 * 사이드바 Sessions 섹션 + Sessions 목록 페이지가 공유하는 세션 목록
 * (Agent Session, CLI 직접 세션). useWorkNavLists 와 같은 규약 — 워크스페이스
 * 전환 세대 카운터로 늦은 응답을 버리고, SSE(`agent_session_update`)로 재조회
 * 없이 제자리 갱신한다. 서버가 소유자에게만 보내므로 여기서는 workspace 만 대조.
 */

export const AGENT_SESSIONS_CHANGED_EVENT = 'awb:agent-sessions-changed';

export interface AgentSessionsNav {
  sessions: AgentSessionSnapshot[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAgentSessionsNav(wsId: string | null): AgentSessionsNav {
  const [sessions, setSessions] = useState<AgentSessionSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const fetchSessions = useCallback(async (workspaceId: string, generation: number) => {
    setLoading(true);
    try {
      const list = await api.listAgentSessions(workspaceId);
      if (generationRef.current !== generation) return;
      setSessions(sortSessionsByActivity(Array.isArray(list) ? list : []));
      setError(null);
    } catch (err: any) {
      if (generationRef.current !== generation) return;
      setSessions([]);
      setError(err?.message || 'Failed to load sessions');
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!wsId) {
      setSessions([]);
      setLoading(false);
      return;
    }
    void fetchSessions(wsId, generation);
  }, [wsId, fetchSessions]);

  useEffect(() => {
    if (!wsId) return;
    const reload = () => void fetchSessions(wsId, generationRef.current);
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(AGENT_SESSIONS_CHANGED_EVENT, reload);
  }, [wsId, fetchSessions]);

  useBoardStreamEvent('agent_session_update', (data: AgentSessionUpdateEvent) => {
    if (!wsId || !data?.session || data.session.workspace_id !== wsId) return;
    setSessions((prev) => applySessionUpdate(prev, data));
  });

  const reload = useCallback(() => {
    if (wsId) void fetchSessions(wsId, generationRef.current);
  }, [wsId, fetchSessions]);

  return { sessions, loading, error, reload };
}
