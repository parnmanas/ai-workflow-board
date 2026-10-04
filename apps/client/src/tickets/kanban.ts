// Kanban lanes + drag/drop position math for the Tickets page (docs/tickets.md).
// React-free — `test/ticket-kanban.test.mjs` imports it directly.
//
// Server move semantics (PATCH /tickets/:id/move `{ status, position? }`, same
// as the old column move): the ticket is removed from its lane (lane positions
// above it shift down by one), then inserted at `position` in the destination
// lane — positions ≥ `position` shift up by one, `position` is clamped to the
// lane length, and an omitted `position` appends at the end. Positions are
// therefore contiguous 0..N-1 per lane, and `position` is an INDEX in the
// destination lane as it looks with the moved ticket taken out.
//
// The page may show only part of a lane (tag / project / search filters), so a
// drop index in the visible list is not a lane index. `computeMovePosition`
// translates it through the neighbours' stored positions instead.

import { TICKET_STATUSES, type TicketStatus } from './status';

export interface KanbanTicket {
  id: string;
  status: TicketStatus;
  position: number;
  created_at?: string;
  parent_id?: string | null;
}

/** Lane order: position, then creation time, then id (stable). */
export function compareLaneOrder(a: KanbanTicket, b: KanbanTicket): number {
  if (a.position !== b.position) return a.position - b.position;
  const ac = a.created_at || '';
  const bc = b.created_at || '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Root tickets grouped into the 5 status lanes, each sorted in lane order. */
export function groupByStatus<T extends KanbanTicket>(tickets: readonly T[]): Record<TicketStatus, T[]> {
  const lanes = Object.fromEntries(TICKET_STATUSES.map((s) => [s, [] as T[]])) as unknown as Record<TicketStatus, T[]>;
  for (const t of tickets) {
    if (t.parent_id) continue;
    (lanes[t.status] || lanes.todo).push(t);
  }
  for (const s of TICKET_STATUSES) lanes[s].sort(compareLaneOrder);
  return lanes;
}

/**
 * Position to send for a drop at `destIndex` of the VISIBLE destination lane.
 *
 * `visibleLane` is the destination lane as rendered before the drop (it still
 * contains the moved ticket when the move is inside one lane). Returns
 * `undefined` when the visible lane is otherwise empty — the server then
 * appends to the end of the (possibly non-empty, filtered-out) lane.
 */
export function computeMovePosition(
  visibleLane: readonly KanbanTicket[],
  moved: Pick<KanbanTicket, 'id' | 'status' | 'position'>,
  destStatus: TicketStatus,
  destIndex: number,
): number | undefined {
  const others = visibleLane.filter((t) => t.id !== moved.id);
  // Lane index a stored position will have once the moved ticket is taken out
  // of its (same) lane.
  const sameLane = moved.status === destStatus;
  const afterRemoval = (p: number) => (sameLane && moved.position < p ? p - 1 : p);
  if (others.length === 0) return undefined;
  const index = Math.max(0, Math.min(destIndex, others.length));
  if (index < others.length) return Math.max(0, afterRemoval(others[index].position));
  return afterRemoval(others[others.length - 1].position) + 1;
}

/**
 * Optimistic local copy of a move — mirrors the server semantics above on the
 * loaded rows so the board settles where the server will put it. Returns a new
 * array; rows not in the affected lanes keep their identity.
 */
export function applyMove<T extends KanbanTicket>(
  tickets: readonly T[],
  movedId: string,
  destStatus: TicketStatus,
  position: number | undefined,
): T[] {
  const moved = tickets.find((t) => t.id === movedId);
  if (!moved) return [...tickets];
  const srcStatus = moved.status;
  // Same clamp as the server: the destination lane length without the mover.
  const destLen = tickets.filter((t) => t.id !== movedId && !t.parent_id && t.status === destStatus).length;
  const pos = position === undefined ? destLen : Math.max(0, Math.min(position, destLen));
  return tickets.map((t) => {
    if (t.id === movedId) return { ...t, status: destStatus, position: pos };
    if (t.parent_id) return t;
    let p = t.position;
    if (t.status === srcStatus && p > moved.position) p -= 1;
    if (t.status === destStatus && p >= pos) p += 1;
    return p === t.position ? t : { ...t, position: p };
  });
}

/** A row anywhere in the loaded tree (root → child → grandchild), or null. */
export function findTicketInTree<T extends { id: string; children?: T[] }>(tickets: readonly T[], id: string | null | undefined): T | null {
  if (!id) return null;
  for (const t of tickets) {
    if (t.id === id) return t;
    const found = findTicketInTree(t.children || [], id);
    if (found) return found;
  }
  return null;
}

/** Ids of a row and all of its descendants. */
export function treeIds(row: { id: string; children?: Array<{ id: string; children?: any[] }> } | null | undefined): Set<string> {
  const ids = new Set<string>();
  const walk = (r: { id: string; children?: any[] }) => { ids.add(r.id); for (const c of r.children || []) walk(c); };
  if (row) walk(row);
  return ids;
}
