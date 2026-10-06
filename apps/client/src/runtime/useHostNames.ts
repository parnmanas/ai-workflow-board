import { useEffect, useState } from 'react';
import { api } from '../api';

// Runtime Host id → display name, from the same catalog the runtime spec editor
// picks hosts from (`GET /agent-templates/hosts`). Shared by every surface that
// renders an assignee spec as `<Host>/<label>` (tickets page, cards, artifact).
// Shared until a Host is renamed; a failed fetch is retried on the next mount.

let cache: Record<string, string> | null = null;
let inflight: Promise<Record<string, string>> | null = null;
const HOST_NAMES_CHANGED_EVENT = 'awb:host-names-changed';

export function invalidateHostNames(): void {
  cache = null;
  window.dispatchEvent(new window.Event(HOST_NAMES_CHANGED_EVENT));
}

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
    const reload = () => {
      loadHostNames().then((m) => { if (!cancelled) setNames(m); }).catch(() => {});
    };
    reload();
    window.addEventListener(HOST_NAMES_CHANGED_EVENT, reload);
    return () => { cancelled = true; window.removeEventListener(HOST_NAMES_CHANGED_EVENT, reload); };
  }, []);
  return names;
}
