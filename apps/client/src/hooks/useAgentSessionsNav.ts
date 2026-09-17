import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import type { AgentSessionHost } from '../types';

/**
 * 사이드바 Sessions 섹션이 펴는 (Runtime Host × CLI) 목록 (Agent Session, CLI 직접 세션).
 * 세션 자체는 장비에 있으므로 여기서는 호스트만 가져온다. 매니저가 붙거나 떨어지면
 * `agent_instance_update` SSE 로 재조회한다(useWorkNavLists 와 같은 세대 카운터 규약).
 */

export const AGENT_SESSIONS_CHANGED_EVENT = 'awb:agent-sessions-changed';

export interface AgentSessionsNav {
  hosts: AgentSessionHost[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAgentSessionsNav(wsId: string | null): AgentSessionsNav {
  const [hosts, setHosts] = useState<AgentSessionHost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const fetchHosts = useCallback(async (workspaceId: string, generation: number) => {
    setLoading(true);
    try {
      const list = await api.listAgentSessionHosts(workspaceId);
      if (generationRef.current !== generation) return;
      setHosts(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err: any) {
      if (generationRef.current !== generation) return;
      setHosts([]);
      setError(err?.message || 'Failed to load Runtime Hosts');
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!wsId) {
      setHosts([]);
      setLoading(false);
      return;
    }
    void fetchHosts(wsId, generation);
  }, [wsId, fetchHosts]);

  useEffect(() => {
    if (!wsId) return;
    const reload = () => void fetchHosts(wsId, generationRef.current);
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(AGENT_SESSIONS_CHANGED_EVENT, reload);
  }, [wsId, fetchHosts]);

  useBoardStreamEvent('agent_instance_update', () => {
    if (wsId) void fetchHosts(wsId, generationRef.current);
  });

  const reload = useCallback(() => {
    if (wsId) void fetchHosts(wsId, generationRef.current);
  }, [wsId, fetchHosts]);

  return { hosts, loading, error, reload };
}
