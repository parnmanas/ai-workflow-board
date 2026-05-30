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
import { Agent } from '../../../entities/Agent';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { TicketRoleAssignment } from '../../../entities/TicketRoleAssignment';
import { Resource } from '../../../entities/Resource';
import { TicketAttachment } from '../../../entities/TicketAttachment';
import { User } from '../../../entities/User';
import { WorkspaceRole } from '../../../entities/WorkspaceRole';
import { safeJsonParse } from './helpers';
import { formatAgentDisplayName, projectTicketAttachment } from './ticket-helpers';
import { listPrerequisitesFull } from '../../tickets/ticket-prerequisites.service';

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
    // On-ticket-done hook binding (ticket 16a6339c) — decode the JSON-string
    // column to an array, same treatment as labels / channel_ids.
    on_done_action_ids: safeJsonParse(ticket.on_done_action_ids),
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
    if (!row.ticket_id) continue;
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
  // v0.34: hydrate `role_assignments` for root + every descendant in one
  // batched lookup. Each entry surfaces the role slug / id and the resolved
  // holder ({ type, id, name }) — so an MCP caller can verify planner /
  // assignee / any custom role with a single `get_ticket`. Replicates
  // `TicketRoleAssignmentService.resolveForTicket` inline so this works in
  // the standalone MCP entry point (no DI / no service wiring).
  await hydrateRoleAssignments(scope, out);

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

  // Hydrate the linked next-ticket snapshot so the picker UI can render its
  // title + current column without a second round-trip. Workspace-scoped
  // for the same defense-in-depth reason as base_repo above — a stale id
  // pointing at another workspace's row never leaks its title here.
  // Failing the lookup is non-fatal: leaves next_ticket: null and the UI
  // shows "(deleted)" / falls back to the bare id.
  if (ticket.next_ticket_id) {
    try {
      const next = await scope.getRepository(Ticket).findOne({
        where: ticket.workspace_id
          ? { id: ticket.next_ticket_id, workspace_id: ticket.workspace_id }
          : { id: ticket.next_ticket_id },
      });
      if (next) {
        let columnName = '';
        if (next.column_id) {
          const col = await scope.getRepository(BoardColumn).findOne({ where: { id: next.column_id } });
          columnName = col?.name || '';
        }
        out.next_ticket = { id: next.id, title: next.title, column_name: columnName };
      } else {
        out.next_ticket = null;
      }
    } catch {
      out.next_ticket = null;
    }
  } else {
    out.next_ticket = null;
  }

  // Prerequisites (ticket 48d14fff) — the M:N "blocked-by" set for the root
  // ticket. Each row carries the prereq's title + current column + whether
  // that column is terminal (= satisfied) so the detail panel can render
  // status pills without a second round-trip. Surfaced on get_ticket (MCP)
  // and the REST GET the panel uses. Failing the lookup is non-fatal — leaves
  // an empty array. Only loaded for the root ticket (subtasks can't carry
  // prerequisites — they have no column to resume on).
  try {
    out.prerequisites = await listPrerequisitesFull(scope, out.id);
  } catch {
    out.prerequisites = [];
  }
  return out;
}

/**
 * Single-batched lookup of `ticket_role_assignments` for a ticket tree.
 * Mutates each node in `tree` (root + children + grandchildren) by setting
 * `node.role_assignments` to:
 *
 *   [{ role_id, slug, holder: { type, id, name } | null }, ...]
 *
 * sorted by `role.position`. Slugs include builtin (assignee/reporter/
 * reviewer) and any workspace-scoped custom role (e.g. `planner`) that has
 * a holder pinned. Empty arrays for nodes with no assignment rows.
 *
 * Holder name uses `formatAgentDisplayName` so the same Manager/Agent
 * formatting that `resolveAgentIdAndName` writes into the legacy text
 * columns is what comes back from `get_ticket`. Roles whose role row was
 * deleted underneath the assignment are dropped (matches
 * `TicketRoleAssignmentService.resolveForTicket` semantics).
 */
async function hydrateRoleAssignments(scope: RepoScope, root: any): Promise<void> {
  const allTicketIds: string[] = [
    root.id,
    ...root.children.map((c: any) => c.id),
    ...root.children.flatMap((c: any) => (c.children || []).map((gc: any) => gc.id)),
  ];
  if (allTicketIds.length === 0) return;
  const rows = await scope.getRepository(TicketRoleAssignment)
    .find({ where: { ticket_id: In(allTicketIds) } as any })
    .catch(() => [] as TicketRoleAssignment[]);

  // Always set the field — even when empty — so callers don't have to
  // defend against `undefined` in the response shape.
  const empty: any[] = [];
  root.role_assignments = empty;
  for (const c of root.children) {
    c.role_assignments = [] as any[];
    for (const gc of (c.children || [])) gc.role_assignments = [] as any[];
  }
  if (rows.length === 0) return;

  const roleIds = [...new Set(rows.map(r => r.role_id))];
  const agentIds = [...new Set(rows.map(r => r.agent_id).filter((x): x is string => !!x))];
  const userIds = [...new Set(rows.map(r => r.user_id).filter((x): x is string => !!x))];
  const [roles, agents, users] = await Promise.all([
    scope.getRepository(WorkspaceRole).find({ where: { id: In(roleIds) } }),
    agentIds.length
      ? scope.getRepository(Agent).find({ where: { id: In(agentIds) } })
      : Promise.resolve([] as Agent[]),
    userIds.length
      ? scope.getRepository(User).find({ where: { id: In(userIds) } })
      : Promise.resolve([] as User[]),
  ]);
  const roleMap = new Map(roles.map(r => [r.id, r]));
  const agentMap = new Map(agents.map(a => [a.id, a]));
  const userMap = new Map(users.map(u => [u.id, u]));
  // Pre-resolve manager-display once per agent so the tree-walk below stays
  // O(rows) without re-querying the manager table per assignment.
  const displayByAgentId = new Map<string, string>();
  for (const a of agents) {
    displayByAgentId.set(a.id, await formatAgentDisplayName(scope, a));
  }

  const byTicket = new Map<string, any[]>();
  for (const r of rows) {
    const role = roleMap.get(r.role_id);
    if (!role) continue;
    let holder: any = null;
    if (r.agent_id && agentMap.has(r.agent_id)) {
      holder = { type: 'agent', id: r.agent_id, name: displayByAgentId.get(r.agent_id) || agentMap.get(r.agent_id)!.name };
    } else if (r.user_id && userMap.has(r.user_id)) {
      const u = userMap.get(r.user_id)!;
      holder = { type: 'user', id: u.id, name: u.name || u.email };
    }
    const entry = { role_id: role.id, slug: role.slug, holder, position: role.position };
    const list = byTicket.get(r.ticket_id) || [];
    list.push(entry);
    byTicket.set(r.ticket_id, list);
  }
  const sortAndStrip = (list: any[]) =>
    list.slice().sort((a, b) => a.position - b.position)
      .map(({ position: _p, ...rest }) => rest);
  root.role_assignments = sortAndStrip(byTicket.get(root.id) || []);
  for (const c of root.children) {
    c.role_assignments = sortAndStrip(byTicket.get(c.id) || []);
    for (const gc of (c.children || [])) {
      gc.role_assignments = sortAndStrip(byTicket.get(gc.id) || []);
    }
  }
}
