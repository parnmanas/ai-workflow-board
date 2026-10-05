// Tickets page filters ⇄ URL query string (docs/tickets.md). Filters live in
// the URL so a view is shareable/bookmarkable; the page owns `ticket` /
// `comment` (open panel) and leaves every other param alone. React-free —
// `test/ticket-filters.test.mjs` imports it directly.

import { TICKET_STATUSES, isTicketStatus, type TicketStatus } from './status';
import type { TicketListQuery } from '../api';

export interface TicketFilters {
  /** Free-text search (server `q`). */
  q: string;
  /** Status chips (multi). Empty = all statuses. */
  statuses: TicketStatus[];
  /** Tags — AND semantics (a ticket must carry every selected tag). */
  tags: string[];
  /** Project id, '' = any. */
  projectId: string;
  /** Assignee identity key (`runtimeIdentityKey`), '' = any. */
  assigneeKey: string;
  /** Show archived tickets (only) instead of the live pool. */
  archived: boolean;
}

export const EMPTY_TICKET_FILTERS: TicketFilters = {
  q: '',
  statuses: [],
  tags: [],
  projectId: '',
  assigneeKey: '',
  archived: false,
};

/** URL param names. Kept short; `ticket` / `comment` belong to the panel. */
export const FILTER_PARAMS = {
  q: 'q',
  statuses: 'status',
  tags: 'tags',
  projectId: 'project',
  assigneeKey: 'assignee',
  archived: 'archived',
} as const;

function splitList(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Statuses in the canonical lifecycle order, deduped, unknown values dropped. */
export function normalizeStatuses(values: Iterable<string>): TicketStatus[] {
  const set = new Set<string>();
  for (const v of values) if (isTicketStatus(v)) set.add(v);
  return TICKET_STATUSES.filter((s) => set.has(s));
}

/** Tags trimmed, deduped (first spelling wins), empty dropped, sorted for a stable URL. */
export function normalizeTags(values: Iterable<string>): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const v = String(raw ?? '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function filtersFromSearch(search: URLSearchParams | string): TicketFilters {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const archivedRaw = params.get(FILTER_PARAMS.archived);
  return {
    q: params.get(FILTER_PARAMS.q) || '',
    statuses: normalizeStatuses(splitList(params.get(FILTER_PARAMS.statuses))),
    tags: normalizeTags(splitList(params.get(FILTER_PARAMS.tags))),
    projectId: (params.get(FILTER_PARAMS.projectId) || '').trim(),
    assigneeKey: (params.get(FILTER_PARAMS.assigneeKey) || '').trim(),
    archived: archivedRaw === '1' || archivedRaw === 'true',
  };
}

/**
 * Write `filters` into a copy of `base` (other params — `ticket`, `comment`,
 * anything else — are preserved). Default values are removed rather than
 * written, so an unfiltered view has a clean URL.
 */
export function filtersToSearch(filters: TicketFilters, base?: URLSearchParams | string): URLSearchParams {
  const next = new URLSearchParams(typeof base === 'string' ? base : base?.toString() || '');
  const set = (key: string, value: string) => {
    if (value) next.set(key, value);
    else next.delete(key);
  };
  set(FILTER_PARAMS.q, filters.q.trim());
  set(FILTER_PARAMS.statuses, normalizeStatuses(filters.statuses).join(','));
  set(FILTER_PARAMS.tags, normalizeTags(filters.tags).join(','));
  set(FILTER_PARAMS.projectId, filters.projectId.trim());
  set(FILTER_PARAMS.assigneeKey, filters.assigneeKey.trim());
  set(FILTER_PARAMS.archived, filters.archived ? '1' : '');
  return next;
}

/** GET /accounts/:wsId/tickets query for these filters. */
export function filtersToQuery(filters: TicketFilters): TicketListQuery {
  const query: TicketListQuery = {};
  const statuses = normalizeStatuses(filters.statuses);
  if (statuses.length) query.status = statuses;
  const tags = normalizeTags(filters.tags);
  if (tags.length) query.tags = tags;
  if (filters.projectId.trim()) query.project_id = filters.projectId.trim();
  if (filters.assigneeKey.trim()) query.assignee_key = filters.assigneeKey.trim();
  if (filters.q.trim()) query.q = filters.q.trim();
  if (filters.archived) query.archived_only = true;
  return query;
}

export function hasActiveFilters(filters: TicketFilters): boolean {
  return !!(
    filters.q.trim()
    || filters.statuses.length
    || filters.tags.length
    || filters.projectId
    || filters.assigneeKey
    || filters.archived
  );
}

export function sameFilters(a: TicketFilters, b: TicketFilters): boolean {
  return filtersToSearch(a).toString() === filtersToSearch(b).toString();
}

export function toggleInList<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

// ─── Tags (AND filtering / counts) ─────────────────────────────────────────

/** Does the ticket carry every one of `tags`? (AND; an empty selection matches all). */
export function ticketHasAllTags(ticket: { tags?: string[] | null }, tags: readonly string[]): boolean {
  if (!tags.length) return true;
  const own = ticket.tags || [];
  return tags.every((t) => own.includes(t));
}

export function filterTicketsByTags<T extends { tags?: string[] | null }>(tickets: readonly T[], tags: readonly string[]): T[] {
  if (!tags.length) return [...tickets];
  return tickets.filter((t) => ticketHasAllTags(t, tags));
}

/** Tag → number of tickets carrying it, most used first, then alphabetical. */
export function countTags(tickets: ReadonlyArray<{ tags?: string[] | null }>): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of tickets) {
    for (const tag of new Set(t.tags || [])) {
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Tag facet for the filter bar: the server's counts for the matching set
 * (falls back to counting the loaded rows when a server sends none), with the
 * selected tags always present so they can be unselected even at count 0.
 */
export function tagFacet(
  serverTags: ReadonlyArray<{ tag: string; count: number }> | null | undefined,
  tickets: ReadonlyArray<{ tags?: string[] | null }>,
  selected: readonly string[],
): Array<{ tag: string; count: number; selected: boolean }> {
  const base = serverTags && serverTags.length ? [...serverTags] : countTags(tickets);
  const rows = base.map((r) => ({ tag: r.tag, count: r.count, selected: selected.includes(r.tag) }));
  for (const tag of selected) {
    if (!rows.some((r) => r.tag === tag)) rows.push({ tag, count: 0, selected: true });
  }
  return rows.sort((a, b) => Number(b.selected) - Number(a.selected) || b.count - a.count || a.tag.localeCompare(b.tag));
}
