import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TicketTagCount } from '../types';

// Account-wide tag suggestions (GET /accounts/:wsId/ticket-tags) for the
// tag pickers — the Tickets list facet only covers the current filter, this
// covers the whole pool. Fetched when `enabled` (e.g. a form opens); a failed
// fetch just leaves the other suggestion sources.
export function useTicketTags(wsId: string | null | undefined, enabled = true): TicketTagCount[] {
  const [tags, setTags] = useState<TicketTagCount[]>([]);
  useEffect(() => {
    if (!wsId || !enabled) return;
    let cancelled = false;
    api.listTicketTags(wsId)
      .then((res) => { if (!cancelled) setTags(Array.isArray(res?.tags) ? res.tags : []); })
      .catch(() => { /* suggestions are best-effort */ });
    return () => { cancelled = true; };
  }, [wsId, enabled]);
  return tags;
}
