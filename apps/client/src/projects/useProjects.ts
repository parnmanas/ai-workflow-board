import { t as translate } from '../i18n/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Project } from '../types';

// Account project list shared by the Tickets page, the ticket form/panel,
// the Projects page and every "use project folder" helper. One in-flight
// request per account is shared; `notifyProjectsChanged()` (called after a
// project write) makes every mounted consumer refetch.

const PROJECTS_CHANGED = 'awb:projects-changed';
const inflight = new Map<string, Promise<Project[]>>();

function fetchProjects(accountId: string): Promise<Project[]> {
  const existing = inflight.get(accountId);
  if (existing) return existing;
  const p = api.listProjects(accountId)
    .then((rows) => (Array.isArray(rows) ? rows : []))
    .finally(() => { inflight.delete(accountId); });
  inflight.set(accountId, p);
  return p;
}

export function notifyProjectsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROJECTS_CHANGED));
}

export function useProjects(accountId: string | null | undefined) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(!!accountId);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!accountId) { setProjects([]); setLoading(false); return; }
    setLoading(true);
    try {
      setProjects(await fetchProjects(accountId));
      setError(null);
    } catch (e: any) {
      setError(e?.message || translate('프로젝트 목록을 불러오지 못했습니다'));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    let cancelled = false;
    if (!accountId) { setProjects([]); setLoading(false); return; }
    setLoading(true);
    fetchProjects(accountId)
      .then((rows) => { if (!cancelled) { setProjects(rows); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e?.message || translate('프로젝트 목록을 불러오지 못했습니다')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    const onChanged = () => { void reload(); };
    window.addEventListener(PROJECTS_CHANGED, onChanged);
    return () => { cancelled = true; window.removeEventListener(PROJECTS_CHANGED, onChanged); };
  }, [accountId, reload]);

  return { projects, loading, error, reload };
}
