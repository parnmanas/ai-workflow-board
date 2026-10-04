import { useEffect, useState } from 'react';
import { api } from '../api';

// Runtime Host id → display name, from the same catalog the runtime spec editor
// picks hosts from (`GET /agent-templates/hosts`). Shared by every surface that
// renders an assignee spec as `<Host>/<label>` (tickets page, cards, artifact).
// One request per page load; a failed fetch is retried on the next mount.

let cache: Record<string, string> | null = null;
let inflight: Promise<Record<string, string>> | null = null;

function loadHostNames(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = api.listTemplateHosts()
    .then((rows) => {
      const map: Record<string, string> = {};
      for (const h of rows || []) if (h?.id) map[h.id] = h.name || '';
      cache = map;
      return map;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useHostNames(): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>(() => cache || {});
  useEffect(() => {
    let cancelled = false;
    loadHostNames().then((m) => { if (!cancelled) setNames(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return names;
}
