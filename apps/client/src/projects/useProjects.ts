import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Project } from '../types';

// Account project list shared by the Tickets page, the ticket form/panel,
// the Projects page and every "use project folder" helper. One in-flight
// request per workspace is shared; `notifyProjectsChanged()` (called after a
// project write) makes every mounted consumer refetch.

const PROJECTS_CHANGED = 'awb:projects-changed';
const inflight = new Map<string, Promise<Project[]>>();

function fetchProjects(wsId: string): Promise<Project[]> {
  const existing = inflight.get(wsId);
  if (existing) return existing;
  const p = api.listProjects(wsId)
    .then((rows) => (Array.isArray(rows) ? rows : []))
    .finally(() => { inflight.delete(wsId); });
  inflight.set(wsId, p);
  return p;
}

export function notifyProjectsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROJECTS_CHANGED));
}

export function useProjects(wsId: string | null | undefined) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(!!wsId);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!wsId) { setProjects([]); setLoading(false); return; }
    setLoading(true);
    try {
      setProjects(await fetchProjects(wsId));
      setError(null);
    } catch (e: any) {
      setError(e?.message || '프로젝트 목록을 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, [wsId]);

  useEffect(() => {
    let cancelled = false;
    if (!wsId) { setProjects([]); setLoading(false); return; }
    setLoading(true);
    fetchProjects(wsId)
      .then((rows) => { if (!cancelled) { setProjects(rows); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e?.message || '프로젝트 목록을 불러오지 못했습니다'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    const onChanged = () => { void reload(); };
    window.addEventListener(PROJECTS_CHANGED, onChanged);
    return () => { cancelled = true; window.removeEventListener(PROJECTS_CHANGED, onChanged); };
  }, [wsId, reload]);

  return { projects, loading, error, reload };
}
