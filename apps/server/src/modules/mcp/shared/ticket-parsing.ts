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

import type { DataSource, EntityManager } from 'typeorm';
import { In } from 'typeorm';
import { Ticket } from '../../../entities/Ticket';
import { Resource } from '../../../entities/Resource';
import { TicketAttachment } from '../../../entities/TicketAttachment';
import { safeJsonParse } from './helpers';
import { projectTicketAttachment } from './ticket-helpers';

type RepoScope = DataSource | EntityManager;

export type CommentAttachment = {
  id: string;
  file_name: string;
  file_mimetype: string;
  file_data: string;
};

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
 * Sort comments by newest-first and decode JSON-string columns
 * (`attachment_resource_ids` array, `metadata` object). Leaves `attachments`
 * as an empty array — call `expandCommentAttachments` afterwards to hydrate
 * file metadata + bytes from the Resource table. Idempotent: rows whose
 * columns are already decoded pass through unchanged.
 */
export function parseComments<T extends { created_at: Date | string }>(comments: T[] | undefined): T[] {
  return (comments || []).slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((c) => {
      const out: any = { ...(c as any) };
      const rawIds = out.attachment_resource_ids;
      if (typeof rawIds === 'string') {
        const parsed = safeJsonParse(rawIds);
        out.attachment_resource_ids = Array.isArray(parsed) ? parsed : [];
      } else if (!Array.isArray(out.attachment_resource_ids)) {
        out.attachment_resource_ids = [];
      }
      if (!Array.isArray(out.attachments)) out.attachments = [];
      const rawMetadata = out.metadata;
      if (typeof rawMetadata === 'string') {
        const parsed = safeJsonParse(rawMetadata);
        out.metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      }
      return out as T;
    });
}

/**
 * Hydrate the `attachments` field on a flat array of comments by issuing one
 * `IN (...)` query against the Resource table. Safe to call on an empty list
 * (returns immediately) and on comments that have no attachment_resource_ids
 * (leaves `attachments: []`).
 *
 * Expects each comment to already have `attachment_resource_ids` decoded
 * (i.e., `parseComments` ran first).
 */
export async function expandCommentAttachments(
  scope: RepoScope,
  comments: any[] | undefined,
): Promise<void> {
  if (!comments || comments.length === 0) return;
  const allIds = new Set<string>();
  for (const c of comments) {
    const ids = c?.attachment_resource_ids;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string' && id) allIds.add(id);
  }
  if (allIds.size === 0) {
    for (const c of comments) if (Array.isArray(c?.attachment_resource_ids)) c.attachments = [];
    return;
  }
  const rows = await scope.getRepository(Resource).find({ where: { id: In([...allIds]) } });
  const map = new Map<string, CommentAttachment>();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      file_name: r.file_name,
      file_mimetype: r.file_mimetype,
      file_data: r.file_data,
    });
  }
  for (const c of comments) {
    const ids: string[] = Array.isArray(c.attachment_resource_ids) ? c.attachment_resource_ids : [];
    // Drop ids that no longer resolve (deleted resource) so the client never
    // has to defend against missing attachments in render code.
    c.attachments = ids.map((id) => map.get(id)).filter((a): a is CommentAttachment => !!a);
  }
}

/**
 * Load a ticket with its full children-of-children tree and comments,
 * returning a decoded/sorted plain-JSON shape.
 *
 * Tree depth cap is the schema's 2-level nesting (root → child → grandchild).
 * Grandchildren have `children: []` forced, matching historic API behavior.
 *
 * Ticket-level file attachments (the `attachments` field on root + every
 * descendant) are hydrated as metadata only — `file_data` is omitted so the
 * payload stays small. Callers that need the bytes hit the dedicated
 * `GET /api/tickets/:id/attachments/:attachmentId` endpoint.
 */
export async function loadTicketFull(scope: RepoScope, id: string) {
  const ticketRepo = scope.getRepository(Ticket);
  const ticket = await ticketRepo.findOne({
    where: { id },
    relations: ['children', 'children.children', 'children.children.comments', 'children.comments', 'comments'],
  });
  if (!ticket) return null;
  const out: any = {
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
        attachments: [] as any[],
      })),
      comments: parseComments(child.comments),
      attachments: [] as any[],
    })),
    comments: parseComments(ticket.comments),
    attachments: [] as any[],
  };
  // One batched lookup for every attachment across the whole tree so we don't
  // fan out per-comment Resource queries.
  const allComments: any[] = [
    ...out.comments,
    ...out.children.flatMap((c: any) => [...c.comments, ...c.children.flatMap((gc: any) => gc.comments)]),
  ];
  await expandCommentAttachments(scope, allComments);

  // Ticket-level attachments — collected for root + every descendant in a
  // single IN(...) query, then partitioned back onto each ticket node.
  const allTicketIds: string[] = [
    out.id,
    ...out.children.map((c: any) => c.id),
    ...out.children.flatMap((c: any) => (c.children || []).map((gc: any) => gc.id)),
  ];
  const attachmentRows = await scope.getRepository(TicketAttachment)
    .find({ where: { ticket_id: In(allTicketIds) } as any });
  const attachmentsByTicket = new Map<string, any[]>();
  for (const row of attachmentRows) {
    const list = attachmentsByTicket.get(row.ticket_id) || [];
    list.push(projectTicketAttachment(row, { includeData: false }));
    attachmentsByTicket.set(row.ticket_id, list);
  }
  const sortAttachments = (list: any[]) =>
    list.slice().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  out.attachments = sortAttachments(attachmentsByTicket.get(out.id) || []);
  for (const child of out.children) {
    child.attachments = sortAttachments(attachmentsByTicket.get(child.id) || []);
    for (const gc of child.children) {
      gc.attachments = sortAttachments(attachmentsByTicket.get(gc.id) || []);
    }
  }
  // Resolve the ticket's base repository (if any) into a small embedded
  // snapshot so the client + agent get url / name / default_branch in one
  // round-trip. Failing the lookup is non-fatal: leaves base_repo: null and
  // the picker UI / agent prompt fall back to the bare id.
  // Workspace-scoped lookup: even though writes are guarded, the read also
  // filters by ticket.workspace_id so a stale/cross-workspace id (e.g. from
  // a ticket cloned across workspaces) never leaks the foreign url here.
  if (ticket.base_repo_resource_id) {
    try {
      const repo = ticket.workspace_id
        ? await scope.getRepository(Resource).findOne({
            where: { id: ticket.base_repo_resource_id, workspace_id: ticket.workspace_id },
          })
        : null;
      out.base_repo = repo
        ? {
            id: repo.id,
            name: repo.name,
            url: repo.url,
            default_branch: repo.default_branch || '',
            type: repo.type,
          }
        : null;
    } catch {
      out.base_repo = null;
    }
  } else {
    out.base_repo = null;
  }
  return out;
}
