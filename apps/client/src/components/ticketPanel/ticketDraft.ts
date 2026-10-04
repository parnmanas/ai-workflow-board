// TicketPanel Save/Discard draft — the pure half. The panel buffers every
// detail-tab field edit here and commits whatever `computeDirtyTicketFields`
// returns as ONE `PATCH /tickets/:id` (docs/tickets.md). Status is not part
// of the draft: it moves immediately through `PATCH /tickets/:id/move`.
// React-free — `test/on-done-reorder-dirty.test.mjs` and
// `test/ticket-panel-draft.test.mjs` import it directly.

import type { TicketPriority } from '../../tickets/status';
import type { TicketPrerequisiteRow } from '../../types';
import { emptyRuntimeSpec, type RuntimeSpecDraft } from '../../runtime/runtimeSpec';

/** Tag set equality, case-SENSITIVE (renaming "bug" → "Bug" is a real edit). */
export function tagsEqual(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const sa = new Set(a || []);
  const sb = new Set(b || []);
  if (sa.size !== sb.size) return false;
  for (const t of sa) if (!sb.has(t)) return false;
  return true;
}

interface TaggedTicket {
  tags?: readonly string[] | null;
  children?: readonly TaggedTicket[] | null;
}

/**
 * Tag suggestions for the panel / subtask form: every tag in the loaded pool
 * (roots + nested children) with its use count, most used first. Spellings
 * differing only in case collapse to the first one seen. Feeds
 * `components/common/TagInput` (`suggestions` accepts `{tag, count}`).
 */
export function collectTagPool(tickets: readonly TaggedTicket[] | null | undefined): Array<{ tag: string; count: number }> {
  const byKey = new Map<string, { tag: string; count: number }>();
  const walk = (t: TaggedTicket) => {
    for (const raw of t.tags || []) {
      const tag = (raw || '').trim();
      if (!tag) continue;
      const hit = byKey.get(tag.toLowerCase());
      if (hit) hit.count += 1;
      else byKey.set(tag.toLowerCase(), { tag, count: 1 });
    }
    for (const c of t.children || []) walk(c);
  };
  for (const t of tickets || []) walk(t);
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Order-INSENSITIVE id equality — for sets (channel_ids). */
export const idsEqualUnordered = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
};

/**
 * Order-SENSITIVE id equality. on_done_action_ids is a sequence — its array
 * order IS the dispatch order — so a pure reorder must still register dirty
 * (ticket 59afc55a). idsEqualUnordered would mask it and leave Save disabled.
 */
export const idsEqualOrdered = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Move the item at `from` to `to` (clamped no-op when out of range). Same array when unchanged. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from < 0 || from >= list.length || from === to) return list as T[];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Key-order-independent JSON — RuntimeSpec equality without caring how the server orders keys. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function runtimeSpecEqual(
  a: Partial<RuntimeSpecDraft> | null | undefined,
  b: Partial<RuntimeSpecDraft> | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return stableStringify(a) === stableStringify(b);
}

/** A stored/validated spec → a complete editor draft (missing keys filled from the empty spec). */
export function toEditableSpec(spec: Partial<RuntimeSpecDraft> | Record<string, any> | null | undefined): RuntimeSpecDraft {
  const empty = emptyRuntimeSpec();
  if (!spec) return empty;
  return {
    ...empty,
    ...(spec as Partial<RuntimeSpecDraft>),
    runtime_config: { ...empty.runtime_config, ...((spec as any).runtime_config || {}) },
  };
}

/**
 * Buffered detail-tab edits. `tags` / `assignee` are `null` while untouched so
 * the panel keeps showing the server value — after a save the server may
 * normalize either one, and an untouched draft must not turn that into a
 * phantom "unsaved change".
 */
export interface TicketDraft {
  title: string;
  description: string;
  priority: TicketPriority;
  tags: string[] | null;
  projectId: string;
  baseBranch: string;
  assignee: { value: RuntimeSpecDraft | null } | null;
  channelIds: string[];
  nextTicketId: string;
  onDoneActionIds: string[];
}

/** The ticket fields the draft is compared against (a full Ticket satisfies it). */
export interface TicketDraftSource {
  title: string;
  description?: string | null;
  priority: TicketPriority;
  tags?: string[] | null;
  project_id?: string | null;
  base_branch?: string | null;
  assignee?: RuntimeSpecDraft | null;
  channel_ids?: string[] | null;
  next_ticket_id?: string | null;
  on_done_action_ids?: string[] | null;
}

export function draftFromTicket(ticket: TicketDraftSource): TicketDraft {
  return {
    title: ticket.title,
    description: ticket.description || '',
    priority: ticket.priority,
    tags: null,
    projectId: ticket.project_id || '',
    baseBranch: ticket.base_branch || '',
    assignee: null,
    channelIds: ticket.channel_ids || [],
    nextTicketId: ticket.next_ticket_id || '',
    onDoneActionIds: ticket.on_done_action_ids || [],
  };
}

export function effectiveTags(draft: TicketDraft, ticket: TicketDraftSource): string[] {
  return draft.tags ?? ticket.tags ?? [];
}

export function effectiveAssignee(draft: TicketDraft, ticket: TicketDraftSource): RuntimeSpecDraft | null {
  return draft.assignee ? draft.assignee.value : (ticket.assignee ?? null);
}

/**
 * Draft keys that differ from the server row, shaped as the PATCH body
 * (TicketPatch keys). Empty object = nothing to save.
 */
export function computeDirtyTicketFields(draft: TicketDraft, ticket: TicketDraftSource): Record<string, any> {
  const out: Record<string, any> = {};
  if (draft.title !== ticket.title) out.title = draft.title;
  if ((draft.description || '') !== (ticket.description || '')) out.description = draft.description;
  if (draft.priority !== ticket.priority) out.priority = draft.priority;
  if (draft.tags && !tagsEqual(draft.tags, ticket.tags)) out.tags = draft.tags;
  // '' → null clears the project; base_branch '' means "project default".
  if ((draft.projectId || null) !== (ticket.project_id || null)) out.project_id = draft.projectId || null;
  if ((draft.baseBranch || '') !== (ticket.base_branch || '')) out.base_branch = draft.baseBranch || '';
  if (draft.assignee && !runtimeSpecEqual(draft.assignee.value, ticket.assignee)) {
    out.assignee = draft.assignee.value;
  }
  if (!idsEqualUnordered(draft.channelIds, ticket.channel_ids || [])) out.channel_ids = draft.channelIds;
  // '' → null clears next_ticket_id.
  if ((draft.nextTicketId || '') !== (ticket.next_ticket_id || '')) out.next_ticket_id = draft.nextTicketId || null;
  // Order-SENSITIVE: array order is the dispatch order, so a reorder is dirty.
  if (!idsEqualOrdered(draft.onDoneActionIds, ticket.on_done_action_ids || [])) {
    out.on_done_action_ids = draft.onDoneActionIds;
  }
  return out;
}

/**
 * After a successful save: drop the `tags` / `assignee` overrides that were
 * part of that save (same object = not edited again while the save was in
 * flight) so the panel shows the server's — possibly normalized — value.
 */
export function settleSavedDraft(current: TicketDraft, saved: TicketDraft): TicketDraft {
  const tags = current.tags === saved.tags ? null : current.tags;
  const assignee = current.assignee === saved.assignee ? null : current.assignee;
  if (tags === current.tags && assignee === current.assignee) return current;
  return { ...current, tags, assignee };
}

/** Prerequisites still holding the ticket (present, not done, not archived). */
export function openPrerequisiteCount(rows: readonly TicketPrerequisiteRow[]): number {
  return rows.filter(r => r.prerequisite && !r.prerequisite.archived_at && !r.prerequisite.is_done).length;
}
