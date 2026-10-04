// List view sorting + view-mode persistence for the Tickets page.
// React-free — `test/ticket-list-sort.test.mjs` imports it directly.

import { TICKET_PRIORITY_RANK, TICKET_STATUSES, type TicketPriority, type TicketStatus } from './status';
import { assigneeDisplayName } from './assignee';

export type TicketView = 'kanban' | 'list';
export const TICKET_VIEW_STORAGE_KEY = 'awb.tickets.view';

export function readTicketView(storage: Pick<Storage, 'getItem'> | null | undefined): TicketView {
  try {
    return storage?.getItem(TICKET_VIEW_STORAGE_KEY) === 'list' ? 'list' : 'kanban';
  } catch {
    return 'kanban';
  }
}

export function writeTicketView(storage: Pick<Storage, 'setItem'> | null | undefined, view: TicketView): void {
  try { storage?.setItem(TICKET_VIEW_STORAGE_KEY, view); } catch { /* quota / private mode */ }
}

export type TicketSortKey = 'title' | 'status' | 'priority' | 'tags' | 'project' | 'assignee' | 'updated';
export type SortDir = 'asc' | 'desc';

export interface TicketSort {
  key: TicketSortKey;
  dir: SortDir;
}

export const DEFAULT_TICKET_SORT: TicketSort = { key: 'updated', dir: 'desc' };

export interface SortableTicket {
  id: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority | string;
  tags?: string[] | null;
  project_id?: string | null;
  assignee?: any;
  updated_at?: string;
}

export interface TicketSortContext {
  projectNames?: Record<string, string>;
  hostNames?: Record<string, string>;
}

const STATUS_RANK: Record<string, number> = Object.fromEntries(TICKET_STATUSES.map((s, i) => [s, i]));

function sortValue(t: SortableTicket, key: TicketSortKey, ctx: TicketSortContext): string | number {
  switch (key) {
    case 'title': return (t.title || '').toLowerCase();
    case 'status': return STATUS_RANK[t.status] ?? 99;
    case 'priority': return TICKET_PRIORITY_RANK[t.priority as TicketPriority] ?? -1;
    case 'tags': return (t.tags || []).join(',').toLowerCase();
    case 'project': return (t.project_id ? ctx.projectNames?.[t.project_id] || t.project_id : '').toLowerCase();
    case 'assignee': return assigneeDisplayName(t.assignee, ctx.hostNames).toLowerCase();
    case 'updated': return t.updated_at ? Date.parse(t.updated_at) || 0 : 0;
  }
}

/**
 * Stable sort by one column. Empty values (no project / unassigned / no tags)
 * always sink to the bottom regardless of direction; ties fall back to most
 * recently updated, then id.
 */
export function sortTickets<T extends SortableTicket>(tickets: readonly T[], sort: TicketSort, ctx: TicketSortContext = {}): T[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const isEmpty = (v: string | number) => v === '' || v === -1;
  return [...tickets].sort((a, b) => {
    const av = sortValue(a, sort.key, ctx);
    const bv = sortValue(b, sort.key, ctx);
    const ae = isEmpty(av);
    const be = isEmpty(bv);
    if (ae !== be) return ae ? 1 : -1;
    if (av !== bv) return (av < bv ? -1 : 1) * sign;
    const au = a.updated_at || '';
    const bu = b.updated_at || '';
    if (au !== bu) return au < bu ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Clicking a header: same column flips direction, a new column starts at its natural direction. */
export function nextSort(current: TicketSort, key: TicketSortKey): TicketSort {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'updated' || key === 'priority' ? 'desc' : 'asc' };
}
