/**
 * Ticket normalization helpers — pure functions that take a TypeORM `Ticket`
 * entity (optionally with relations loaded) and produce a plain-JSON object
 * with `labels`/`channel_ids` decoded, children/comments sorted, and grandchildren
 * truncated.
 *
 * Used by:
 *   - MCP tools (mcp-tools.ts and tools/*-tools.ts)
 *   - tickets.controller.ts (Phase 4 will consolidate here)
 */

import type { DataSource } from 'typeorm';
import { Ticket } from '../../../entities/Ticket';
import { safeJsonParse } from './helpers';

/**
 * Shallow parse: decode JSON string columns on a single ticket row without
 * recursing into children.
 */
export function parseTicket(ticket: Ticket) {
  return {
    ...ticket,
    labels: safeJsonParse(ticket.labels),
    channel_ids: safeJsonParse(ticket.channel_ids),
  };
}

/**
 * Sort comments by newest-first and decode the `images` column (if stored as a
 * JSON string). Idempotent: comments that already have `images` as a parsed
 * array or `undefined` pass through unchanged.
 */
export function parseComments<T extends { created_at: Date | string }>(comments: T[] | undefined): T[] {
  return (comments || []).slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((c) => {
      const raw = (c as any).images;
      if (typeof raw === 'string') {
        return { ...(c as any), images: safeJsonParse(raw) } as T;
      }
      return c;
    });
}

/**
 * Load a ticket with its full children-of-children tree and comments,
 * returning a decoded/sorted plain-JSON shape.
 *
 * Tree depth cap is the schema's 2-level nesting (root → child → grandchild).
 * Grandchildren have `children: []` forced, matching historic API behavior.
 */
export async function loadTicketFull(dataSource: DataSource, id: string) {
  const ticketRepo = dataSource.getRepository(Ticket);
  const ticket = await ticketRepo.findOne({
    where: { id },
    relations: ['children', 'children.children', 'children.children.comments', 'children.comments', 'comments'],
  });
  if (!ticket) return null;
  return {
    ...ticket,
    labels: safeJsonParse(ticket.labels),
    channel_ids: safeJsonParse(ticket.channel_ids),
    children: (ticket.children || []).sort((a, b) => a.position - b.position).map(child => ({
      ...child,
      labels: safeJsonParse(child.labels),
      channel_ids: safeJsonParse(child.channel_ids),
      children: (child.children || []).sort((a, b) => a.position - b.position).map(gc => ({
        ...gc,
        labels: safeJsonParse(gc.labels),
        channel_ids: safeJsonParse(gc.channel_ids),
        children: [],
        comments: parseComments(gc.comments),
      })),
      comments: parseComments(child.comments),
    })),
    comments: parseComments(ticket.comments),
  };
}
