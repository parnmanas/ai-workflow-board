import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { AgentSessionEventRecord } from '../../types';
import { mergeSessionLimitEvents } from './sessionUsageLimits.logic';

/** Refresh quota on session entry and foreground return without reloading conversation state. */
export function useSessionUsageRefresh(accountId: string, managerId: string, cli: string, sessionId: string): AgentSessionEventRecord[] {
  const key = JSON.stringify([accountId, managerId, cli, sessionId]);
  const [snapshot, setSnapshot] = useState<{ key: string; events: AgentSessionEventRecord[] }>({ key: '', events: [] });
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let timer: number | null = null;
    const refresh = async () => {
      if (!active || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const result = await api.getHostSessionUsageLimits(managerId, cli, sessionId);
        if (active && Array.isArray(result.events)) {
          setSnapshot((previous) => ({ key, events: mergeSessionLimitEvents(previous.key === key ? previous.events : [], result.events) }));
        }
      } catch {
        // Background failures keep the last known report; another focus can retry.
      } finally {
        inFlight = false;
      }
    };
    const schedule = () => {
      if (document.visibilityState !== 'visible') return;
      if (timer !== null) window.clearTimeout(timer);
      // Browsers commonly emit both visibilitychange and focus on one return.
      timer = window.setTimeout(() => { timer = null; void refresh(); }, 100);
    };
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', schedule);
    schedule();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [key, managerId, cli, sessionId]);
  return snapshot.key === key ? snapshot.events : [];
}
