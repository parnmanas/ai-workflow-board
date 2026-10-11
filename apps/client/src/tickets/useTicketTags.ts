import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TicketTagCount } from '../types';

// Account-wide tag suggestions (GET /accounts/:accountId/ticket-tags) for the
// tag pickers — the Tickets list facet only covers the current filter, this
// covers the whole pool. Fetched when `enabled` (e.g. a form opens); a failed
// fetch just leaves the other suggestion sources.
export function useTicketTags(accountId: string | null | undefined, enabled = true): TicketTagCount[] {
  const [tags, setTags] = useState<TicketTagCount[]>([]);
  useEffect(() => {
    if (!accountId || !enabled) return;
    let cancelled = false;
    api.listTicketTags(accountId)
      .then((res) => { if (!cancelled) setTags(Array.isArray(res?.tags) ? res.tags : []); })
      .catch(() => { /* suggestions are best-effort */ });
    return () => { cancelled = true; };
  }, [accountId, enabled]);
  return tags;
}
