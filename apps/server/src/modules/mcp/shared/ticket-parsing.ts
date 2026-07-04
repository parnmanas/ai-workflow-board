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
import { Comment } from '../../../entities/Comment';
import { Ticket } from '../../../entities/Ticket';
import { TicketRoleAssignment } from '../../../entities/TicketRoleAssignment';
import { Resource } from '../../../entities/Resource';
import { TicketAttachment } from '../../../entities/TicketAttachment';
import { parseHandoffSpec } from '../../../common/handoff-spec-config';
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
    // Cross-board handoff relay (ticket ac21a745) — decode the JSON-string spec
    // to an object so the detail panel's handoff editor binds against it.
    handoff_spec: parseHandoffSpec(ticket.handoff_spec),
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
  // Metadata only — never SELECT file_data here. The bytes can be tens of MB
  // per attachment (large mp4s), and this hydrator runs on every ticket-detail
  // and board refetch; pulling the base64 inline used to bloat those responses
  // and, for big videos, made the panel unusable. The client renders via the
  // streaming GET /api/resources/:id/raw endpoint instead (ticket ff3e7337).
  const rows = await scope.getRepository(Resource).find({
    where: { id: In([...allIds]) },
    select: { id: true, file_name: true, file_mimetype: true },
  });
  const map = new Map<string, CommentAttachment>();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      file_name: r.file_name,
      file_mimetype: r.file_mimetype,
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
 * 코멘트 페이지네이션 상수. bounded `loadTicketFull` 의 첫 페이지와 전용 커서
 * 엔드포인트 `GET /api/tickets/:id/comments` 의 scroll-load-older 페이지가 같은
 * 페이지 크기를 쓰도록 공유한다. chat 메시지 페이지네이션 기본값(room-messaging.
 * service.ts)과 동일하게 맞췄다.
 */
export const DETAIL_COMMENT_PAGE = 50;
export const MAX_COMMENT_PAGE = 200;
// 클라 `comment-types.ts` 의 STALE_QUESTION_THRESHOLD_MS 와 동일(24h). 보드 카드는
// 전체 코멘트 메타로 stale-question 배지를 계산하지만, bounded detail 은 최신 N개만
// 싣으므로 배지가 윈도우 밖 오래된 질문을 놓치지 않도록 서버가 노드별 플래그를 계산해
// 같이 내려준다(보드 카드와 헤더 배지 일치 유지).
const STALE_QUESTION_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * 단일 티켓(root 또는 하위)의 커서 페이지네이션 코멘트 로더. 최신순(DESC)으로
 * 반환해 newest-at-top 으로 그리는 `CommentList` 에 그대로 들어간다 — 한 페이지는
 * 현재 화면 아래에 쌓이는 "더 오래된" 코멘트다.
 *
 * 커서는 `before` 코멘트 id 의 복합 `(created_at, id)` 라서 같은 millisecond
 * timestamp 를 공유하는 행(버스트성 에이전트 출력)도 건너뛰지 않는다 — chat
 * `getMessages` 커서와 동일한 보장. 최대 `limit` 행을 parse(`attachment_resource_ids`/
 * `metadata` 디코드) + `attachments` 하이드레이션까지 마쳐 `loadTicketFull` 의 코멘트와
 * 동일 shape 으로 반환한다.
 */
export async function loadTicketComments(
  scope: RepoScope,
  ticketId: string,
  opts?: { limit?: number; before?: string | null },
): Promise<any[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts?.limit ?? DETAIL_COMMENT_PAGE)), MAX_COMMENT_PAGE);
  const commentRepo = scope.getRepository(Comment);
  const qb = commentRepo
    .createQueryBuilder('c')
    .where('c.ticket_id = :ticketId', { ticketId })
    .orderBy('c.created_at', 'DESC')
    .addOrderBy('c.id', 'DESC')
    .limit(limit);
  if (opts?.before) {
    const cursor = await commentRepo.findOne({ where: { id: opts.before } });
    // 알 수 없는 커서(삭제된 행 / 잘못된 id)면 500 대신 최신 페이지를 반환한다.
    // chat 커서의 방어적 동작과 동일.
    if (cursor && cursor.ticket_id === ticketId) {
      qb.andWhere(
        '(c.created_at < :cAt OR (c.created_at = :cAt AND c.id < :cId))',
        { cAt: cursor.created_at, cId: cursor.id },
      );
    }
  }
  const rows = await qb.getMany();
  const parsed = parseComments(rows);
  await expandCommentAttachments(scope, parsed);
  return parsed;
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
 *
 * `opts.commentLimit` 는 코멘트 페이로드를 제한해, 코멘트가 수천 개인 티켓에서
 * 코멘트 트리(root + child + grandchild) 전체를 메모리에 올리는 것을 막는다 —
 * detail 패널이 열릴 때 타는 OOM 경로. 숫자를 주면 각 노드는 최신 N개 코멘트와
 * `comments_has_more` 플래그만 싣고, 패널은 `GET /api/tickets/:id/comments` 로
 * 더 오래된 페이지를 scroll-load 한다. 기본값(`null`/생략)은 기존의 전체
 * eager-load 를 유지해, 전체 코멘트를 약속하는 MCP `get_ticket` · agent-api
 * 계약을 건드리지 않는다.
 */
export async function loadTicketFull(
  scope: RepoScope,
  id: string,
  opts?: { commentLimit?: number | null },
) {
  const commentLimit = opts?.commentLimit ?? null;
  const ticketRepo = scope.getRepository(Ticket);
  const ticket = await ticketRepo.findOne({
    where: { id },
    // bounded 모드는 comment 관계를 아예 로드하지 않고 아래에서 노드별 최신 N개
    // 페이지를 가져온다; full 모드는 기존처럼 코멘트 트리 전체를 eager-load 한다.
    relations: commentLimit === null
      ? ['children', 'children.children', 'children.children.comments', 'children.comments', 'comments']
      : ['children', 'children.children'],
  });
  if (!ticket) return null;
  const out: any = {
    ...ticket,
    labels: safeJsonParse(ticket.labels),
    channel_ids: safeJsonParse(ticket.channel_ids),
    // On-ticket-done hook binding (ticket 16a6339c) — decode to an array, same
    // treatment as labels / channel_ids, so the REST GET the detail panel uses
    // returns string[] (the picker binds against it). parseTicket already does
    // this; loadTicketFull must match or the client sees a raw JSON string.
    on_done_action_ids: safeJsonParse(ticket.on_done_action_ids),
    // Cross-board handoff relay (ticket ac21a745) — decode on the root so the
    // detail panel's handoff editor binds against a spec object, not a raw string.
    handoff_spec: parseHandoffSpec(ticket.handoff_spec),
    children: (ticket.children || []).sort((a, b) => a.position - b.position).map(child => ({
      ...child,
      labels: safeJsonParse(child.labels),
      channel_ids: safeJsonParse(child.channel_ids),
      on_done_action_ids: safeJsonParse(child.on_done_action_ids),
      children: (child.children || []).sort((a, b) => a.position - b.position).map(gc => ({
        ...gc,
        labels: safeJsonParse(gc.labels),
        channel_ids: safeJsonParse(gc.channel_ids),
        on_done_action_ids: safeJsonParse(gc.on_done_action_ids),
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

  // bounded 모드: 위 구성에서 각 노드의 `comments` 는 빈 배열로 남았다(관계를
  // 로드 안 했으므로). load-older 엔드포인트와 같은 복합 커서 쿼리로 각 노드를
  // 최신 N개 페이지로 채우고, 클라가 불필요한 probe fetch 없이 scroll-load-older
  // 를 켤지 판단하도록 `comments_has_more` 를 찍는다. 추가 1행(`limit + 1`)이
  // 곧 has-more probe 다. 노드별 순차 쿼리는 2단계 트리 깊이(root → child →
  // grandchild)로 제한되며 각각 `limit + 1` 행으로 캡된다.
  if (commentLimit !== null) {
    const limit = Math.min(Math.max(1, Math.floor(commentLimit)), MAX_COMMENT_PAGE);
    const commentRepo = scope.getRepository(Comment);
    const fetchNewestPage = async (node: any) => {
      const rows = await commentRepo
        .createQueryBuilder('c')
        .where('c.ticket_id = :ticketId', { ticketId: node.id })
        .orderBy('c.created_at', 'DESC')
        .addOrderBy('c.id', 'DESC')
        .limit(limit + 1)
        .getMany();
      node.comments_has_more = rows.length > limit;
      node.comments = parseComments(rows.slice(0, limit));
    };
    await fetchNewestPage(out);
    for (const child of out.children) {
      await fetchNewestPage(child);
      for (const gc of child.children) await fetchNewestPage(gc);
    }

    // stale-open-question 배지: bounded 페이지 밖에 오래된 미답변 질문이 있어도
    // 헤더 배지가 보드 카드와 일치하도록 노드별 플래그를 한 번의 grouped 쿼리로
    // 계산한다(메타 컬럼만, body 로드 없음).
    const nodeIds: string[] = [
      out.id,
      ...out.children.map((c: any) => c.id),
      ...out.children.flatMap((c: any) => (c.children || []).map((gc: any) => gc.id)),
    ];
    const cutoff = new Date(Date.now() - STALE_QUESTION_THRESHOLD_MS);
    const staleRows = await commentRepo
      .createQueryBuilder('c')
      .select('c.ticket_id', 'ticket_id')
      .where('c.ticket_id IN (:...ids)', { ids: nodeIds })
      .andWhere("c.type = 'question'")
      .andWhere("c.status = 'open'")
      .andWhere('c.created_at <= :cutoff', { cutoff })
      .groupBy('c.ticket_id')
      .getRawMany();
    const staleSet = new Set(staleRows.map(r => r.ticket_id));
    out.has_stale_open_question = staleSet.has(out.id);
    for (const child of out.children) {
      child.has_stale_open_question = staleSet.has(child.id);
      for (const gc of child.children) gc.has_stale_open_question = staleSet.has(gc.id);
    }
  }

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
