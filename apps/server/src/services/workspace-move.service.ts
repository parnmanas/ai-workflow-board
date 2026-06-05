/**
 * WorkspaceMoveService — cross-workspace "move house" for a board and the
 * workspace-scoped references that hang off it (ticket 8882056b).
 *
 * Background: a workspace is a SCOPE boundary, not a label. Boards, columns,
 * tickets, roles, templates, actions, resources and channels all carry a
 * denormalized `workspace_id` (most of them indexed) and are filtered by it on
 * every list / dispatch / focus path. So moving a board to another workspace
 * means re-stamping that scope on everything the board owns AND fixing up the
 * workspace-scoped FKs the board's tickets point at — otherwise the board's
 * columns/tickets silently vanish from the destination's scope filters, and
 * role assignments point at the *source* workspace's WorkspaceRole rows.
 *
 * Design:
 *   - ONE analyze/apply code path (`runBoardMove(mgr, …, apply)`). Preview
 *     (`apply=false`) runs the exact same traversal as commit (`apply=true`)
 *     and only differs in whether it writes — so the dry-run report can never
 *     drift from what commit actually does. Preview runs against
 *     `dataSource.manager` (read-only); commit runs inside one
 *     `dataSource.transaction(...)` so the whole move is atomic (no partial
 *     application) per acceptance criterion (d).
 *   - Default policy is "carry-along, non-destructive":
 *       • board-OWNED scoped deps (columns, tickets, Actions/Resources whose
 *         `board_id` = this board) → hard re-stamp `workspace_id` to dest.
 *       • workspace-SHARED deps referenced by the board's tickets (prompt
 *         templates, ws-level actions/resources, channels) → COPY into dest by
 *         name if absent (original left intact), then remap the referencing id.
 *       • role assignments → remap `role_id` to the dest workspace's same-slug
 *         WorkspaceRole, creating the role in dest if it doesn't exist; column
 *         `role_routing` slugs are likewise guaranteed to exist in dest.
 *   - Companion agents (G): agents that hold a role on the board's tickets
 *     become cross-workspace after the move. They are always reported; with
 *     `carry_agents` they are moved too — but only when the agent holds no
 *     roles on tickets OUTSIDE this board (otherwise carrying it would break
 *     those other-board tickets, so it's surfaced as a blocker instead).
 *
 * Pure helpers run against a `DataSource | EntityManager` scope so the service
 * works in both NestJS DI (REST controller) and the standalone MCP entry point
 * — mirroring TicketPrerequisitesService.
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { Board } from '../entities/Board';
import { BoardColumn } from '../entities/BoardColumn';
import { Ticket } from '../entities/Ticket';
import { Workspace } from '../entities/Workspace';
import { PromptTemplate } from '../entities/PromptTemplate';
import { Action } from '../entities/Action';
import { Resource } from '../entities/Resource';
import { Channel } from '../entities/Channel';
import { WorkspaceRole } from '../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../entities/TicketRoleAssignment';
import { Agent } from '../entities/Agent';
import { ApiKey } from '../entities/ApiKey';
import { Credential } from '../entities/Credential';
import { ActivityService } from './activity.service';

export type RepoScope = DataSource | EntityManager;

/** One line of the move plan, rendered verbatim in the dry-run report. */
export interface MovePreviewItem {
  /**
   * restamp — hard UPDATE of workspace_id on a board-owned row
   * copy     — workspace-shared dep duplicated into dest (non-destructive)
   * reuse    — workspace-shared dep already present in dest, id remapped
   * remap    — a referencing id rewritten (role_id, template id, channel id)
   * carry    — companion agent moved along with the board
   * warn     — something the operator should know (cleared dangling link, …)
   * block    — a hard stop; commit is refused while any block item exists
   */
  kind: 'restamp' | 'copy' | 'reuse' | 'remap' | 'carry' | 'warn' | 'block';
  entity:
    | 'board' | 'column' | 'ticket' | 'prompt_template' | 'action' | 'resource'
    | 'workspace_role' | 'role_assignment' | 'channel' | 'agent' | 'api_key' | 'credential';
  id: string;
  detail: string;
}

/**
 * A structured remedy candidate attached to a blocker (ticket 9efa643b). The
 * client renders one inline control per remedy next to the blocker so the
 * operator can resolve it without leaving the move preview.
 *
 * kind:
 *   repreview — the remedy only flips a *move option* (a policy or the
 *               exclude_agent_ids set). The client toggles that option locally
 *               and re-runs the dry-run preview; NOTHING is written. The
 *               `params` carry the option value to apply (e.g. { value:'clear' }
 *               for a policy, { agent_id } for a carry exclusion).
 *   mutation  — the remedy performs a real DB write via
 *               `WorkspaceMoveService.runMoveRemedy(action, params)` (exposed at
 *               POST …/move-to-workspace/remedy). The client confirms, calls the
 *               endpoint, then re-previews so the blocker disappears if resolved.
 */
export interface MoveRemedy {
  action: string;
  label: string;
  kind: 'repreview' | 'mutation';
  params?: Record<string, any>;
}

/**
 * A structured blocker (ticket 9efa643b). Supersedes the old `blockers: string[]`
 * — `message` preserves the exact human-readable string for back-compat (string
 * fallback), while `code` + entity refs + `remedies` let the client render an
 * inline fix. preview and commit run the same traversal, so the structured
 * blocker set is identical in both (preview=commit invariant).
 */
export interface MoveBlocker {
  /** Stable discriminator: companion_agent_outside_roles | dangling_credential
   *  | api_keys_foreign_refuse | cross_ref_block | denorm_ref_block. */
  code: string;
  /** Human-readable reason — identical to the legacy string blocker. */
  message: string;
  /** Offending agent (companion / cross-ref / credential blockers). */
  agent_id?: string;
  /** Offending tickets (outside-board roles, cross-ws refs). */
  ticket_ids?: string[];
  /** Denormalized fields implicated (assignee_id/reporter_id/reviewer_id). */
  fields?: string[];
  /** Dangling credential reference. */
  credential_id?: string;
  /** Foreign api keys (api_key_policy=refuse). */
  api_key_ids?: string[];
  /** Structured actions that can clear this blocker, rendered inline. */
  remedies: MoveRemedy[];
}

export interface BoardMovePreview {
  board: { id: string; name: string };
  source_workspace: { id: string; name: string } | null;
  target_workspace: { id: string; name: string };
  counts: { columns: number; tickets: number; copied: number; remapped: number; restamped: number };
  items: MovePreviewItem[];
  /** Non-empty → commit is refused. Structured so the client can render an
   *  inline remedy per blocker; `message` preserves the legacy string. */
  blockers: MoveBlocker[];
  carry_agents: boolean;
  /** false for dry-run preview, true once the transaction has committed. */
  committed: boolean;
}

export interface BoardMoveOptions {
  /** Move companion agents (those holding roles on the board's tickets) too. */
  carry_agents?: boolean;
  /**
   * Companion agents to EXCLUDE from the carry even when carry_agents=true —
   * they stay in the source workspace and the board moves without them (ticket
   * 9efa643b "drop_companion_agent" remedy). Excluding an agent that would
   * otherwise block the move (it holds roles outside this board) is the
   * write-free way to unblock: the board moves, the agent is relocated
   * separately later. A move option, so preview and commit honour it identically.
   */
  exclude_agent_ids?: string[];
  actor_id?: string;
  actor_name?: string;
}

/**
 * How to treat the agent's ApiKey rows (api_keys.agent_id = agent) whose
 * `workspace_id` differs from the destination after the move:
 *   migrate — re-stamp ApiKey.workspace_id to dest (default; keeps the keys live).
 *   clear   — null the keys' agent_id (detach; keys survive but stop authing as this agent).
 *   refuse  — block the move while any such key exists (operator must resolve first).
 */
export type AgentApiKeyPolicy = 'migrate' | 'clear' | 'refuse';

/**
 * What to do with cross-workspace references that the move would create:
 * role assignments + denormalized assignee/reporter/reviewer ids on tickets
 * that do NOT live in the destination workspace.
 *   block — refuse the move and report each offending ticket (default; symmetric
 *           with the board move's companion-agent blocker).
 *   clear — delete those role-assignment rows and blank the denormalized ids so
 *           no source-workspace ticket is left pointing at a now-foreign agent.
 */
export type AgentCrossRefPolicy = 'block' | 'clear';

export interface AgentMoveOptions {
  /** ApiKey re-scoping policy (default 'migrate'). */
  api_key_policy?: AgentApiKeyPolicy;
  /** Cross-workspace reference policy (default 'block'). */
  cross_ref_policy?: AgentCrossRefPolicy;
  actor_id?: string;
  actor_name?: string;
}

export interface AgentMovePreview {
  agent: { id: string; name: string };
  source_workspace: { id: string; name: string } | null;
  target_workspace: { id: string; name: string };
  counts: { api_keys: number; copied: number; cleared: number; cross_refs: number };
  items: MovePreviewItem[];
  /** Non-empty → commit is refused. Structured so the client can render an
   *  inline remedy per blocker; `message` preserves the legacy string. */
  blockers: MoveBlocker[];
  api_key_policy: AgentApiKeyPolicy;
  cross_ref_policy: AgentCrossRefPolicy;
  /** false for dry-run preview, true once the transaction has committed. */
  committed: boolean;
}

/** Internal error type so blockers abort the commit transaction cleanly. */
export class WorkspaceMoveBlockedError extends Error {
  constructor(public readonly blockers: MoveBlocker[]) {
    super(`Cross-workspace move blocked: ${blockers.map((b) => b.message).join('; ')}`);
    this.name = 'WorkspaceMoveBlockedError';
  }

  /** Convenience for callers that only want the human-readable reasons. */
  get messages(): string[] {
    return this.blockers.map((b) => b.message);
  }
}

/** Action verbs accepted by runMoveRemedy (ticket 9efa643b). */
export type MoveRemedyAction =
  | 'unassign_from_tickets'
  | 'clear_credential'
  | 'assign_credential';

@Injectable()
export class WorkspaceMoveService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /** Dry-run: compute the full plan and report without writing anything. */
  async previewBoardMove(
    boardId: string,
    targetWorkspaceId: string,
    opts: BoardMoveOptions = {},
  ): Promise<BoardMovePreview> {
    return this.runBoardMove(this.dataSource.manager, boardId, targetWorkspaceId, opts, false);
  }

  /**
   * Commit: apply the move atomically in a single transaction. Throws
   * WorkspaceMoveBlockedError (and rolls back) if any blocker is present, so
   * the move is all-or-nothing.
   */
  async commitBoardMove(
    boardId: string,
    targetWorkspaceId: string,
    opts: BoardMoveOptions = {},
  ): Promise<BoardMovePreview> {
    const result = await this.dataSource.transaction((mgr) =>
      this.runBoardMove(mgr, boardId, targetWorkspaceId, opts, true),
    );
    // Activity log outside the txn — a failed move never reaches here.
    await this.activityService.logActivity({
      entity_type: 'board',
      entity_id: result.board.id,
      action: 'moved',
      field_changed: 'workspace',
      old_value: result.source_workspace?.name || result.source_workspace?.id || '',
      new_value: result.target_workspace.name || result.target_workspace.id,
      ticket_id: '',
      actor_id: opts.actor_id,
      actor_name: opts.actor_name,
    });
    return result;
  }

  /** Dry-run: compute the full agent-move plan and report without writing. */
  async previewAgentMove(
    agentId: string,
    targetWorkspaceId: string,
    opts: AgentMoveOptions = {},
  ): Promise<AgentMovePreview> {
    return this.runAgentMove(this.dataSource.manager, agentId, targetWorkspaceId, opts, false);
  }

  /**
   * Commit: move the agent to another workspace atomically in a single
   * transaction. Throws WorkspaceMoveBlockedError (and rolls back) if any
   * blocker is present, so the move is all-or-nothing.
   *
   * NOTE: the agent-manager `reload_config` SSE dispatch is the caller's
   * responsibility (it needs the in-memory InstanceRegistry, which this
   * DB-pure service deliberately doesn't depend on) — see
   * AgentsController.moveToWorkspace / the move_agent_to_workspace MCP tool.
   */
  async commitAgentMove(
    agentId: string,
    targetWorkspaceId: string,
    opts: AgentMoveOptions = {},
  ): Promise<AgentMovePreview> {
    const result = await this.dataSource.transaction((mgr) =>
      this.runAgentMove(mgr, agentId, targetWorkspaceId, opts, true),
    );
    await this.activityService.logActivity({
      entity_type: 'agent',
      entity_id: result.agent.id,
      action: 'moved',
      field_changed: 'workspace',
      old_value: result.source_workspace?.name || result.source_workspace?.id || '',
      new_value: result.target_workspace.name || result.target_workspace.id,
      ticket_id: '',
      actor_id: opts.actor_id,
      actor_name: opts.actor_name,
    });
    return result;
  }

  /**
   * Execute a structured blocker remedy (ticket 9efa643b) — the "mutation"
   * branch of a MoveRemedy. These are the only writes the inline-remedy flow
   * performs; "repreview" remedies are pure option toggles handled entirely on
   * the client (they just re-run the dry-run preview with a different option).
   *
   * Runs in one transaction so a partial remedy never lands. After a remedy the
   * client re-previews the move; the blocker disappears iff the underlying
   * condition is gone — i.e. the remedy and the move preview share the same
   * source of truth, no special-cased "assume fixed" UI state.
   *
   * Actions:
   *   unassign_from_tickets — detach `agent_id` from `ticket_ids`: delete every
   *     TicketRoleAssignment for that (agent, ticket) pair AND blank any
   *     denormalized assignee/reporter/reviewer id equal to the agent. Clears
   *     the companion-agent-outside-roles, cross_ref_block and denorm_ref_block
   *     blockers in one shot.
   *   clear_credential — null the agent's credential_id (resolves a dangling
   *     credential reference).
   *   assign_credential — point the agent at an existing credential_id.
   */
  async runMoveRemedy(
    action: MoveRemedyAction | string,
    params: Record<string, any>,
    actor?: { id?: string; name?: string },
  ): Promise<{ ok: true; action: string; affected: number }> {
    const affected = await this.dataSource.transaction(async (mgr) => {
      switch (action) {
        case 'unassign_from_tickets':
          return this._remedyUnassignFromTickets(mgr, params);
        case 'clear_credential':
          return this._remedyClearCredential(mgr, params);
        case 'assign_credential':
          return this._remedyAssignCredential(mgr, params);
        default:
          throw new Error(`Unknown move remedy action: ${action}`);
      }
    });
    return { ok: true, action, affected };
  }

  /** unassign_from_tickets — see runMoveRemedy. Returns rows touched. */
  private async _remedyUnassignFromTickets(
    mgr: EntityManager, params: Record<string, any>,
  ): Promise<number> {
    const agentId: string = params?.agent_id;
    const ticketIds: string[] = Array.isArray(params?.ticket_ids) ? params.ticket_ids.filter(Boolean) : [];
    if (!agentId) throw new Error('agent_id is required');
    if (ticketIds.length === 0) return 0;

    let affected = 0;
    const assignRepo = mgr.getRepository(TicketRoleAssignment);
    const del = await assignRepo.delete({ agent_id: agentId, ticket_id: In(ticketIds) });
    affected += del.affected || 0;

    // Blank any denormalized id equal to the agent on those tickets.
    const ticketRepo = mgr.getRepository(Ticket);
    const tickets = await ticketRepo.find({ where: { id: In(ticketIds) } });
    for (const t of tickets) {
      const patch: Record<string, string> = {};
      for (const f of ['assignee_id', 'reporter_id', 'reviewer_id'] as const) {
        if ((t as any)[f] === agentId) patch[f] = '';
      }
      if (Object.keys(patch).length) {
        await ticketRepo.update({ id: t.id }, patch);
        affected += Object.keys(patch).length;
      }
    }
    return affected;
  }

  /** clear_credential — null the agent's dangling credential reference. */
  private async _remedyClearCredential(
    mgr: EntityManager, params: Record<string, any>,
  ): Promise<number> {
    const agentId: string = params?.agent_id;
    if (!agentId) throw new Error('agent_id is required');
    const res = await mgr.getRepository(Agent).update({ id: agentId }, { credential_id: null });
    return res.affected || 0;
  }

  /** assign_credential — point the agent at an existing credential row. */
  private async _remedyAssignCredential(
    mgr: EntityManager, params: Record<string, any>,
  ): Promise<number> {
    const agentId: string = params?.agent_id;
    const credentialId: string = params?.credential_id;
    if (!agentId) throw new Error('agent_id is required');
    if (!credentialId) throw new Error('credential_id is required');
    const cred = await mgr.getRepository(Credential).findOne({ where: { id: credentialId } });
    if (!cred) throw new Error('credential_id does not exist');
    const res = await mgr.getRepository(Agent).update({ id: agentId }, { credential_id: credentialId });
    return res.affected || 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Core — single analyze/apply path
  // ──────────────────────────────────────────────────────────────────────────

  private async runBoardMove(
    mgr: RepoScope,
    boardId: string,
    targetWorkspaceId: string,
    opts: BoardMoveOptions,
    apply: boolean,
  ): Promise<BoardMovePreview> {
    const items: MovePreviewItem[] = [];
    const blockers: MoveBlocker[] = [];
    const carryAgents = !!opts.carry_agents;
    const excludeAgentIds = new Set(opts.exclude_agent_ids || []);
    let copied = 0, remapped = 0, restamped = 0;

    const board = await mgr.getRepository(Board).findOne({ where: { id: boardId } });
    if (!board) throw new Error('Board not found');

    const sourceWsId = board.workspace_id || '';
    const targetWs = await mgr.getRepository(Workspace).findOne({ where: { id: targetWorkspaceId } });
    if (!targetWs) throw new Error('Target workspace not found');
    const sourceWs = sourceWsId
      ? await mgr.getRepository(Workspace).findOne({ where: { id: sourceWsId } })
      : null;

    if (sourceWsId === targetWorkspaceId) {
      throw new Error('Board already belongs to the target workspace');
    }

    // ── Collect the board's columns + every ticket it owns (roots + all
    //    descendants, since child tickets have column_id=null and hang off
    //    their parent via parent_id). ──────────────────────────────────────
    const columns = await mgr.getRepository(BoardColumn).find({ where: { board_id: boardId } });
    const columnIds = columns.map((c) => c.id);
    const ticketIds = await this.collectBoardTicketIds(mgr, columnIds);
    const tickets = ticketIds.length
      ? await mgr.getRepository(Ticket).find({ where: { id: In(ticketIds) } })
      : [];

    // (A) Hard re-stamp board + columns + tickets ──────────────────────────
    items.push({ kind: 'restamp', entity: 'board', id: board.id, detail: `board "${board.name}" workspace → ${targetWs.name}` });
    restamped += 1 + columnIds.length + ticketIds.length;
    if (apply) {
      await mgr.getRepository(Board).update({ id: board.id }, { workspace_id: targetWorkspaceId });
      if (columnIds.length) await mgr.getRepository(BoardColumn).update({ id: In(columnIds) }, { workspace_id: targetWorkspaceId });
      if (ticketIds.length) await mgr.getRepository(Ticket).update({ id: In(ticketIds) }, { workspace_id: targetWorkspaceId });
    }
    items.push({ kind: 'restamp', entity: 'column', id: columnIds.join(','), detail: `${columnIds.length} column(s) re-stamped` });
    items.push({ kind: 'restamp', entity: 'ticket', id: '', detail: `${ticketIds.length} ticket(s) re-stamped (roots + subtasks)` });

    // (E) Role slugs + TicketRoleAssignment.role_id remap ──────────────────
    const roleIdRemap = await this.remapRoleAssignments(
      mgr, sourceWsId, targetWorkspaceId, columns, ticketIds, items, apply,
    );
    remapped += roleIdRemap.size;

    // (B) column_prompts → prompt_templates (workspace-shared; copy-if-absent)
    const tplResult = await this.carryColumnPrompts(mgr, board, sourceWsId, targetWorkspaceId, items, apply);
    copied += tplResult.copied;
    remapped += tplResult.remapped;

    // (C/D) board-owned Actions & Resources re-stamp; ws-level referenced ones
    //       copied-if-absent + remapped on the tickets that reference them.
    const actRes = await this.carryActionsAndResources(
      mgr, boardId, sourceWsId, targetWorkspaceId, tickets, items, apply,
    );
    copied += actRes.copied; remapped += actRes.remapped; restamped += actRes.restamped;

    // (F) channel_ids (ws-level; copy-if-absent) + next_ticket_id integrity
    const chRes = await this.carryChannels(mgr, sourceWsId, targetWorkspaceId, tickets, items, apply);
    copied += chRes.copied; remapped += chRes.remapped;
    await this.checkNextTicketLinks(mgr, tickets, ticketIds, items, apply);

    // (G) companion agents ─────────────────────────────────────────────────
    await this.handleCompanionAgents(
      mgr, sourceWsId, targetWorkspaceId, ticketIds, carryAgents, excludeAgentIds, items, blockers, apply,
    );

    if (apply && blockers.length) {
      // Abort the transaction — nothing is committed. Preview never throws.
      throw new WorkspaceMoveBlockedError(blockers);
    }

    return {
      board: { id: board.id, name: board.name },
      source_workspace: sourceWs ? { id: sourceWs.id, name: sourceWs.name } : (sourceWsId ? { id: sourceWsId, name: sourceWsId } : null),
      target_workspace: { id: targetWs.id, name: targetWs.name },
      counts: { columns: columnIds.length, tickets: ticketIds.length, copied, remapped, restamped },
      items,
      blockers,
      carry_agents: carryAgents,
      committed: apply,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Root tickets on the board's columns plus all their descendants (BFS over parent_id). */
  private async collectBoardTicketIds(mgr: RepoScope, columnIds: string[]): Promise<string[]> {
    if (columnIds.length === 0) return [];
    const repo = mgr.getRepository(Ticket);
    const roots = await repo.find({ where: { column_id: In(columnIds) }, select: ['id'] });
    const all = new Set<string>(roots.map((r) => r.id));
    let frontier = [...all];
    while (frontier.length) {
      const kids = await repo.find({ where: { parent_id: In(frontier) }, select: ['id'] });
      frontier = [];
      for (const k of kids) if (!all.has(k.id)) { all.add(k.id); frontier.push(k.id); }
    }
    return [...all];
  }

  /**
   * (E) For every WorkspaceRole referenced by the moved tickets' role
   * assignments, find-or-create the same-slug role in dest and rewrite the
   * assignment rows' `role_id`. Also guarantees every slug used in the board's
   * column `role_routing` exists in dest. Returns sourceRoleId → destRoleId.
   */
  private async remapRoleAssignments(
    mgr: RepoScope, sourceWsId: string, targetWsId: string,
    columns: BoardColumn[], ticketIds: string[],
    items: MovePreviewItem[], apply: boolean,
  ): Promise<Map<string, string>> {
    const roleRepo = mgr.getRepository(WorkspaceRole);
    const assignRepo = mgr.getRepository(TicketRoleAssignment);

    const assignments = ticketIds.length
      ? await assignRepo.find({ where: { ticket_id: In(ticketIds) } })
      : [];

    // Slugs we must guarantee exist in dest: from assignment roles + from each
    // column's role_routing array.
    const sourceRoleIds = [...new Set(assignments.map((a) => a.role_id))];
    const sourceRoles = sourceRoleIds.length
      ? await roleRepo.find({ where: { id: In(sourceRoleIds) } })
      : [];
    const sourceRoleById = new Map(sourceRoles.map((r) => [r.id, r]));

    const routingSlugs = new Set<string>();
    for (const col of columns) {
      try { for (const s of JSON.parse(col.role_routing || '[]')) if (typeof s === 'string') routingSlugs.add(s); }
      catch { /* malformed routing — ignore */ }
    }
    for (const r of sourceRoles) routingSlugs.add(r.slug);

    // Find-or-create each slug in dest.
    const destRoleBySlug = new Map<string, string>();
    const destRoles = await roleRepo.find({ where: { workspace_id: targetWsId } });
    for (const r of destRoles) destRoleBySlug.set(r.slug, r.id);

    for (const slug of routingSlugs) {
      if (destRoleBySlug.has(slug)) {
        items.push({ kind: 'reuse', entity: 'workspace_role', id: destRoleBySlug.get(slug)!, detail: `role "${slug}" already in dest` });
        continue;
      }
      // Copy definition from a source role of the same slug if we have one.
      const src = sourceRoles.find((r) => r.slug === slug);
      items.push({ kind: 'copy', entity: 'workspace_role', id: src?.id || slug, detail: `create role "${slug}" in dest` });
      if (apply) {
        const created = await roleRepo.save(roleRepo.create({
          workspace_id: targetWsId,
          slug,
          name: src?.name || slug,
          role_prompt: src?.role_prompt || '',
          description: src?.description || '',
          position: src?.position ?? 0,
          is_builtin: src?.is_builtin ?? false,
        }));
        destRoleBySlug.set(slug, created.id);
      }
    }

    // Build sourceRoleId → destRoleId and rewrite assignment rows.
    const roleIdRemap = new Map<string, string>();
    for (const r of sourceRoles) {
      const destId = destRoleBySlug.get(r.slug);
      if (destId) roleIdRemap.set(r.id, destId);
    }
    for (const a of assignments) {
      const destRoleId = roleIdRemap.get(a.role_id);
      if (!destRoleId || destRoleId === a.role_id) continue;
      const slug = sourceRoleById.get(a.role_id)?.slug || '?';
      items.push({ kind: 'remap', entity: 'role_assignment', id: a.id, detail: `assignment role_id → dest "${slug}"` });
      if (apply) await assignRepo.update({ id: a.id }, { role_id: destRoleId });
    }
    return roleIdRemap;
  }

  /**
   * (B) Carry the board's `column_prompts` template references into dest:
   * copy each referenced PromptTemplate into dest by name if absent, then
   * rewrite the column_prompts map to the dest template ids.
   */
  private async carryColumnPrompts(
    mgr: RepoScope, board: Board, sourceWsId: string, targetWsId: string,
    items: MovePreviewItem[], apply: boolean,
  ): Promise<{ copied: number; remapped: number }> {
    let copied = 0, remapped = 0;
    let map: Record<string, string>;
    try { map = JSON.parse(board.column_prompts || '{}'); } catch { map = {}; }
    const entries = Object.entries(map).filter(([, tplId]) => typeof tplId === 'string' && tplId);
    if (entries.length === 0) return { copied, remapped };

    const tplRepo = mgr.getRepository(PromptTemplate);
    const newMap: Record<string, string> = { ...map };
    const tplCache = new Map<string, string>(); // sourceTplId → destTplId

    for (const [colId, srcTplId] of entries) {
      let destTplId = tplCache.get(srcTplId);
      if (!destTplId) {
        const src = await tplRepo.findOne({ where: { id: srcTplId } });
        if (!src) {
          items.push({ kind: 'warn', entity: 'prompt_template', id: srcTplId, detail: `template ${srcTplId} missing — column_prompts entry dropped` });
          delete newMap[colId];
          continue;
        }
        const existing = await tplRepo.findOne({ where: { workspace_id: targetWsId, name: src.name } });
        if (existing) {
          destTplId = existing.id;
          items.push({ kind: 'reuse', entity: 'prompt_template', id: existing.id, detail: `template "${src.name}" reused in dest` });
        } else {
          items.push({ kind: 'copy', entity: 'prompt_template', id: src.id, detail: `copy template "${src.name}" → dest` });
          copied++;
          if (apply) {
            const created = await tplRepo.save(tplRepo.create({
              workspace_id: targetWsId, name: src.name, description: src.description,
              content: src.content, category: src.category,
            }));
            destTplId = created.id;
          } else {
            destTplId = srcTplId; // placeholder for dry-run map only
          }
        }
        tplCache.set(srcTplId, destTplId);
      }
      if (destTplId !== srcTplId) { newMap[colId] = destTplId; remapped++; }
    }
    if (apply) {
      await mgr.getRepository(Board).update({ id: board.id }, {
        column_prompts: Object.keys(newMap).length ? JSON.stringify(newMap) : null,
      });
    }
    return { copied, remapped };
  }

  /**
   * (C/D) Board-owned Actions & Resources (board_id = this board) re-stamp to
   * dest. Workspace-level Actions/Resources referenced by the moved tickets'
   * `on_done_action_ids` / `base_repo_resource_id` are copied-if-absent into
   * dest and the referencing ticket fields are remapped.
   */
  private async carryActionsAndResources(
    mgr: RepoScope, boardId: string, sourceWsId: string, targetWsId: string,
    tickets: Ticket[], items: MovePreviewItem[], apply: boolean,
  ): Promise<{ copied: number; remapped: number; restamped: number }> {
    let copied = 0, remapped = 0, restamped = 0;
    const actionRepo = mgr.getRepository(Action);
    const resourceRepo = mgr.getRepository(Resource);

    // Board-owned rows → re-stamp (they move with the board).
    const ownedActions = await actionRepo.find({ where: { board_id: boardId } });
    const ownedResources = await resourceRepo.find({ where: { board_id: boardId } });
    if (ownedActions.length) {
      items.push({ kind: 'restamp', entity: 'action', id: ownedActions.map((a) => a.id).join(','), detail: `${ownedActions.length} board-owned action(s) re-stamped` });
      restamped += ownedActions.length;
      if (apply) await actionRepo.update({ id: In(ownedActions.map((a) => a.id)) }, { workspace_id: targetWsId });
    }
    if (ownedResources.length) {
      items.push({ kind: 'restamp', entity: 'resource', id: ownedResources.map((r) => r.id).join(','), detail: `${ownedResources.length} board-owned resource(s) re-stamped` });
      restamped += ownedResources.length;
      if (apply) await resourceRepo.update({ id: In(ownedResources.map((r) => r.id)) }, { workspace_id: targetWsId });
    }
    const ownedActionIds = new Set(ownedActions.map((a) => a.id));
    const ownedResourceIds = new Set(ownedResources.map((r) => r.id));

    // ws-level Actions referenced by on_done_action_ids → copy-if-absent.
    const actionCache = new Map<string, string>();
    for (const t of tickets) {
      let ids: string[];
      try { ids = JSON.parse(t.on_done_action_ids || '[]'); } catch { ids = []; }
      if (!Array.isArray(ids) || ids.length === 0) continue;
      let changed = false;
      const newIds = [...ids];
      for (let i = 0; i < newIds.length; i++) {
        const aId = newIds[i];
        if (!aId || ownedActionIds.has(aId)) continue; // board-owned moved already
        const res = await this.copyActionIfAbsent(actionRepo, aId, sourceWsId, targetWsId, actionCache, items, apply);
        if (res.copied) copied++;
        if (res.id && res.id !== aId) { newIds[i] = res.id; changed = true; remapped++; }
      }
      if (changed && apply) await mgr.getRepository(Ticket).update({ id: t.id }, { on_done_action_ids: JSON.stringify(newIds) });
    }

    // ws-level Resources referenced by base_repo_resource_id → copy-if-absent.
    const resourceCache = new Map<string, string>();
    for (const t of tickets) {
      const rId = t.base_repo_resource_id;
      if (!rId || ownedResourceIds.has(rId)) continue;
      const res = await this.copyResourceIfAbsent(resourceRepo, rId, sourceWsId, targetWsId, resourceCache, items, apply);
      if (res.copied) copied++;
      if (res.id && res.id !== rId) { remapped++; if (apply) await mgr.getRepository(Ticket).update({ id: t.id }, { base_repo_resource_id: res.id }); }
    }
    return { copied, remapped, restamped };
  }

  private async copyActionIfAbsent(
    repo: any, srcId: string, sourceWsId: string, targetWsId: string,
    cache: Map<string, string>, items: MovePreviewItem[], apply: boolean,
  ): Promise<{ id: string | null; copied: boolean }> {
    if (cache.has(srcId)) return { id: cache.get(srcId)!, copied: false };
    const src = await repo.findOne({ where: { id: srcId } });
    if (!src) { items.push({ kind: 'warn', entity: 'action', id: srcId, detail: `action ${srcId} missing — left as-is` }); return { id: null, copied: false }; }
    if (src.workspace_id === targetWsId) { cache.set(srcId, srcId); return { id: srcId, copied: false }; }
    const existing = await repo.findOne({ where: { workspace_id: targetWsId, name: src.name, board_id: IsNull() } });
    if (existing) {
      items.push({ kind: 'reuse', entity: 'action', id: existing.id, detail: `ws-level action "${src.name}" reused in dest` });
      cache.set(srcId, existing.id); return { id: existing.id, copied: false };
    }
    items.push({ kind: 'copy', entity: 'action', id: src.id, detail: `copy ws-level action "${src.name}" → dest` });
    let destId = srcId;
    if (apply) {
      const created = await repo.save(repo.create({
        workspace_id: targetWsId, board_id: null, name: src.name, description: src.description,
        prompt: src.prompt, target_agent_id: src.target_agent_id, schedule_cron: src.schedule_cron,
        trigger: src.trigger, trigger_label: src.trigger_label, enabled: src.enabled, max_runs: src.max_runs,
      }));
      destId = created.id;
    }
    cache.set(srcId, destId); return { id: destId, copied: true };
  }

  private async copyResourceIfAbsent(
    repo: any, srcId: string, sourceWsId: string, targetWsId: string,
    cache: Map<string, string>, items: MovePreviewItem[], apply: boolean,
  ): Promise<{ id: string | null; copied: boolean }> {
    if (cache.has(srcId)) return { id: cache.get(srcId)!, copied: false };
    const src = await repo.findOne({ where: { id: srcId } });
    if (!src) { items.push({ kind: 'warn', entity: 'resource', id: srcId, detail: `resource ${srcId} missing — left as-is` }); return { id: null, copied: false }; }
    if (src.workspace_id === targetWsId) { cache.set(srcId, srcId); return { id: srcId, copied: false }; }
    const existing = await repo.findOne({ where: { workspace_id: targetWsId, name: src.name, board_id: IsNull() } });
    if (existing) {
      items.push({ kind: 'reuse', entity: 'resource', id: existing.id, detail: `ws-level resource "${src.name}" reused in dest` });
      cache.set(srcId, existing.id); return { id: existing.id, copied: false };
    }
    items.push({ kind: 'copy', entity: 'resource', id: src.id, detail: `copy ws-level resource "${src.name}" → dest` });
    let destId = srcId;
    if (apply) {
      const created = await repo.save(repo.create({
        workspace_id: targetWsId, board_id: null, credential_id: src.credential_id, name: src.name,
        description: src.description, type: src.type, url: src.url, default_branch: src.default_branch,
        content: src.content, file_data: src.file_data, file_name: src.file_name,
        file_mimetype: src.file_mimetype, tags: src.tags,
      }));
      destId = created.id;
    }
    cache.set(srcId, destId); return { id: destId, copied: true };
  }

  /** (F) channel_ids: copy referenced ws-level channels into dest if absent, remap ids. */
  private async carryChannels(
    mgr: RepoScope, sourceWsId: string, targetWsId: string,
    tickets: Ticket[], items: MovePreviewItem[], apply: boolean,
  ): Promise<{ copied: number; remapped: number }> {
    let copied = 0, remapped = 0;
    const repo = mgr.getRepository(Channel);
    const cache = new Map<string, string>();
    for (const t of tickets) {
      let ids: string[];
      try { ids = JSON.parse(t.channel_ids || '[]'); } catch { ids = []; }
      if (!Array.isArray(ids) || ids.length === 0) continue;
      let changed = false;
      const newIds = [...ids];
      for (let i = 0; i < newIds.length; i++) {
        const cId = newIds[i];
        if (!cId) continue;
        let destId = cache.get(cId);
        if (!destId) {
          const src = await repo.findOne({ where: { id: cId } });
          if (!src) { items.push({ kind: 'warn', entity: 'channel', id: cId, detail: `channel ${cId} missing — left as-is` }); cache.set(cId, cId); destId = cId; }
          else if (src.workspace_id === targetWsId) { cache.set(cId, cId); destId = cId; }
          else {
            const existing = await repo.findOne({ where: { workspace_id: targetWsId, name: src.name, type: src.type } });
            if (existing) { items.push({ kind: 'reuse', entity: 'channel', id: existing.id, detail: `channel "${src.name}" reused in dest` }); destId = existing.id; }
            else {
              items.push({ kind: 'copy', entity: 'channel', id: src.id, detail: `copy channel "${src.name}" → dest` });
              copied++;
              if (apply) {
                const created = await repo.save(repo.create({
                  workspace_id: targetWsId, name: src.name, type: src.type, bot_token: src.bot_token,
                  channel_id: src.channel_id, is_active: src.is_active, notify_on_status_change: src.notify_on_status_change,
                  notify_on_update: src.notify_on_update, notify_on_comment: src.notify_on_comment,
                }));
                destId = created.id;
              } else destId = cId;
            }
            cache.set(cId, destId!);
          }
        }
        if (destId !== cId) { newIds[i] = destId!; changed = true; remapped++; }
      }
      if (changed && apply) await mgr.getRepository(Ticket).update({ id: t.id }, { channel_ids: JSON.stringify(newIds) });
    }
    return { copied, remapped };
  }

  /**
   * (F) next_ticket_id integrity: a link that points at a ticket NOT in the
   * moved set becomes a cross-workspace pointer after the move, violating the
   * same-workspace guard the rest of the codebase assumes. Report it and clear
   * it on commit (links within the moved set stay valid and are left intact).
   */
  private async checkNextTicketLinks(
    mgr: RepoScope, tickets: Ticket[], ticketIds: string[],
    items: MovePreviewItem[], apply: boolean,
  ): Promise<void> {
    const moved = new Set(ticketIds);
    for (const t of tickets) {
      if (!t.next_ticket_id) continue;
      if (moved.has(t.next_ticket_id)) continue; // travels together — fine
      items.push({ kind: 'warn', entity: 'ticket', id: t.id, detail: `next_ticket_id pointed outside the board (${t.next_ticket_id}) — cleared to avoid a cross-workspace link` });
      if (apply) await mgr.getRepository(Ticket).update({ id: t.id }, { next_ticket_id: null });
    }
  }

  /**
   * (G) Companion agents: agents holding a role on the board's tickets become
   * cross-workspace after the move. Always reported. With carry_agents they are
   * moved (workspace_id + their ApiKeys + credential copy-if-absent) — but only
   * when the agent holds no roles on tickets OUTSIDE this board, else carrying
   * it would break those tickets and it's surfaced as a blocker.
   */
  private async handleCompanionAgents(
    mgr: RepoScope, sourceWsId: string, targetWsId: string, ticketIds: string[],
    carryAgents: boolean, excludeAgentIds: Set<string>,
    items: MovePreviewItem[], blockers: MoveBlocker[], apply: boolean,
  ): Promise<void> {
    if (ticketIds.length === 0) return;
    const assignRepo = mgr.getRepository(TicketRoleAssignment);
    const agentRepo = mgr.getRepository(Agent);

    const onBoard = await assignRepo.find({ where: { ticket_id: In(ticketIds) } });
    const agentIds = [...new Set(onBoard.map((a) => a.agent_id).filter((x): x is string => !!x))];
    if (agentIds.length === 0) return;
    const agents = await agentRepo.find({ where: { id: In(agentIds) } });

    const movedSet = new Set(ticketIds);
    for (const agent of agents) {
      // manager-type / workspace-less agents are global — nothing to carry.
      if (!agent.workspace_id) continue;
      if (agent.workspace_id !== sourceWsId) continue; // already elsewhere

      // Does this agent hold roles on tickets outside the moved set?
      const elsewhere = await assignRepo.find({ where: { agent_id: agent.id } });
      const outsideCount = elsewhere.filter((a) => !movedSet.has(a.ticket_id)).length;

      if (!carryAgents) {
        items.push({ kind: 'warn', entity: 'agent', id: agent.id, detail: `agent "${agent.name}" stays in source ws — will be cross-workspace from this board (use carry_agents to move it)` });
        continue;
      }
      // Operator explicitly dropped this agent from the carry (drop_companion_agent
      // remedy): the board moves without it, the agent stays put. Write-free unblock.
      if (excludeAgentIds.has(agent.id)) {
        items.push({ kind: 'warn', entity: 'agent', id: agent.id, detail: `agent "${agent.name}" excluded from carry — board moves without it; relocate the agent separately later` });
        continue;
      }
      if (outsideCount > 0) {
        const outsideTicketIds = [...new Set(elsewhere.filter((a) => !movedSet.has(a.ticket_id)).map((a) => a.ticket_id))];
        const msg = `agent "${agent.name}" holds roles on ${outsideCount} ticket(s) outside this board — cannot carry without breaking them`;
        blockers.push({
          code: 'companion_agent_outside_roles',
          message: msg,
          agent_id: agent.id,
          ticket_ids: outsideTicketIds,
          remedies: [
            { action: 'drop_companion_agent', kind: 'repreview', label: `Move board only — leave "${agent.name}" behind`, params: { agent_id: agent.id } },
            { action: 'unassign_from_tickets', kind: 'mutation', label: `Unassign "${agent.name}" from ${outsideTicketIds.length} outside ticket(s)`, params: { agent_id: agent.id, ticket_ids: outsideTicketIds } },
          ],
        });
        items.push({ kind: 'block', entity: 'agent', id: agent.id, detail: msg });
        continue;
      }
      // Carry: workspace_id, api keys, credential (copy-if-absent).
      items.push({ kind: 'carry', entity: 'agent', id: agent.id, detail: `carry agent "${agent.name}" → dest workspace` });
      if (apply) await agentRepo.update({ id: agent.id }, { workspace_id: targetWsId });
      // api keys travel with the board move's companion carry (always migrate).
      await this.migrateAgentApiKeys(mgr, agent, targetWsId, 'migrate', items, blockers, apply);
      await this.carryAgentCredential(mgr, agent, targetWsId, items, blockers, apply);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Agent move (ticket 868ead64) — generalises the companion-agent carry above
  // into a standalone cross-workspace operation for a single agent.
  // ──────────────────────────────────────────────────────────────────────────

  private async runAgentMove(
    mgr: RepoScope,
    agentId: string,
    targetWorkspaceId: string,
    opts: AgentMoveOptions,
    apply: boolean,
  ): Promise<AgentMovePreview> {
    const items: MovePreviewItem[] = [];
    const blockers: MoveBlocker[] = [];
    const apiKeyPolicy: AgentApiKeyPolicy = opts.api_key_policy || 'migrate';
    const crossRefPolicy: AgentCrossRefPolicy = opts.cross_ref_policy || 'block';

    const agentRepo = mgr.getRepository(Agent);
    const agent = await agentRepo.findOne({ where: { id: agentId } });
    if (!agent) throw new Error('Agent not found');

    const targetWs = await mgr.getRepository(Workspace).findOne({ where: { id: targetWorkspaceId } });
    if (!targetWs) throw new Error('Target workspace not found');

    // (A) manager-type agents are workspace-less by design — moving them is a
    //     no-op category error, not a silent restamp. Refuse explicitly.
    if (agent.type === 'manager') {
      throw new Error('Manager-type agents are workspace-less and cannot be moved between workspaces');
    }

    const sourceWsId = agent.workspace_id || '';
    if (sourceWsId === targetWorkspaceId) {
      throw new Error('Agent already belongs to the target workspace');
    }
    const sourceWs = sourceWsId
      ? await mgr.getRepository(Workspace).findOne({ where: { id: sourceWsId } })
      : null;

    // (A) Re-stamp the agent's workspace_id.
    items.push({ kind: 'restamp', entity: 'agent', id: agent.id, detail: `agent "${agent.name}" workspace → ${targetWs.name}` });
    if (apply) await agentRepo.update({ id: agent.id }, { workspace_id: targetWorkspaceId });

    // (B) Credential carry (copy-if-absent; block on a dangling reference).
    const credRes = await this.carryAgentCredential(mgr, agent, targetWorkspaceId, items, blockers, apply);

    // (C) ApiKey rows scoped to this agent.
    const keyRes = await this.migrateAgentApiKeys(mgr, agent, targetWorkspaceId, apiKeyPolicy, items, blockers, apply);

    // (D) Actions in OTHER workspaces that target this agent → warn (config; not auto-migrated).
    await this.warnForeignAgentActions(mgr, agent, targetWorkspaceId, items);

    // (E) Cross-workspace role assignments + denormalized assignee/reporter/reviewer refs.
    const refRes = await this.handleCrossWorkspaceAgentRefs(
      mgr, agent, targetWorkspaceId, crossRefPolicy, items, blockers, apply,
    );

    if (apply && blockers.length) {
      // Abort the transaction — nothing is committed. Preview never throws.
      throw new WorkspaceMoveBlockedError(blockers);
    }

    return {
      agent: { id: agent.id, name: agent.name },
      source_workspace: sourceWs ? { id: sourceWs.id, name: sourceWs.name } : (sourceWsId ? { id: sourceWsId, name: sourceWsId } : null),
      target_workspace: { id: targetWs.id, name: targetWs.name },
      counts: { api_keys: keyRes.affected, copied: credRes.copied, cleared: refRes.cleared, cross_refs: refRes.crossRefs },
      items,
      blockers,
      api_key_policy: apiKeyPolicy,
      cross_ref_policy: crossRefPolicy,
      committed: apply,
    };
  }

  /**
   * (B) Carry an agent's Credential into the destination workspace.
   * copy-if-absent by name (non-destructive, mirrors the board move). A
   * credential_id that points at a now-missing row is a hard blocker — moving
   * the agent would leave it pointing at auth that doesn't exist in dest.
   * Returns { copied } so callers can roll the count up.
   */
  private async carryAgentCredential(
    mgr: RepoScope, agent: Agent, targetWsId: string,
    items: MovePreviewItem[], blockers: MoveBlocker[], apply: boolean,
  ): Promise<{ copied: number }> {
    if (!agent.credential_id) return { copied: 0 };
    const credRepo = mgr.getRepository(Credential);
    const cred = await credRepo.findOne({ where: { id: agent.credential_id } });
    if (!cred) {
      const msg = `agent "${agent.name}" references credential ${agent.credential_id} which no longer exists — resolve before moving`;
      blockers.push({
        code: 'dangling_credential',
        message: msg,
        agent_id: agent.id,
        credential_id: agent.credential_id,
        remedies: [
          { action: 'clear_credential', kind: 'mutation', label: 'Clear the dangling credential reference', params: { agent_id: agent.id } },
        ],
      });
      items.push({ kind: 'block', entity: 'credential', id: agent.credential_id, detail: msg });
      return { copied: 0 };
    }
    if (cred.workspace_id === targetWsId) {
      items.push({ kind: 'reuse', entity: 'credential', id: cred.id, detail: `credential "${cred.name}" already in dest` });
      return { copied: 0 };
    }
    const existing = await credRepo.findOne({ where: { workspace_id: targetWsId, name: cred.name } });
    if (existing) {
      items.push({ kind: 'reuse', entity: 'credential', id: existing.id, detail: `credential "${cred.name}" reused in dest` });
      if (apply) await mgr.getRepository(Agent).update({ id: agent.id }, { credential_id: existing.id });
      return { copied: 0 };
    }
    items.push({ kind: 'copy', entity: 'credential', id: cred.id, detail: `copy credential "${cred.name}" → dest` });
    if (apply) {
      const created = await credRepo.save(credRepo.create({
        workspace_id: targetWsId, name: cred.name, description: cred.description,
        provider: cred.provider, encrypted_data: cred.encrypted_data,
      }));
      await mgr.getRepository(Agent).update({ id: agent.id }, { credential_id: created.id });
    }
    return { copied: 1 };
  }

  /**
   * (C) ApiKey rows whose `agent_id` = this agent and whose `workspace_id`
   * differs from dest. Policy: migrate (re-stamp), clear (detach agent_id) or
   * refuse (block). Returns { affected } = rows the policy touched.
   */
  private async migrateAgentApiKeys(
    mgr: RepoScope, agent: Agent, targetWsId: string, policy: AgentApiKeyPolicy,
    items: MovePreviewItem[], blockers: MoveBlocker[], apply: boolean,
  ): Promise<{ affected: number }> {
    const keyRepo = mgr.getRepository(ApiKey);
    const keys = await keyRepo.find({ where: { agent_id: agent.id } });
    const stale = keys.filter((k) => (k.workspace_id || '') !== targetWsId);
    if (stale.length === 0) return { affected: 0 };

    if (policy === 'refuse') {
      const msg = `agent "${agent.name}" has ${stale.length} api key(s) in another workspace (policy=refuse)`;
      blockers.push({
        code: 'api_keys_foreign_refuse',
        message: msg,
        agent_id: agent.id,
        api_key_ids: stale.map((k) => k.id),
        remedies: [
          { action: 'set_api_key_policy', kind: 'repreview', label: 'Migrate the keys (re-stamp to dest)', params: { value: 'migrate' } },
          { action: 'set_api_key_policy', kind: 'repreview', label: 'Clear the keys (detach from agent)', params: { value: 'clear' } },
        ],
      });
      items.push({ kind: 'block', entity: 'api_key', id: stale.map((k) => k.id).join(','), detail: msg });
      return { affected: stale.length };
    }
    const staleIds = stale.map((k) => k.id);
    if (policy === 'clear') {
      items.push({ kind: 'warn', entity: 'api_key', id: staleIds.join(','), detail: `${stale.length} api key(s) detached from agent "${agent.name}" (policy=clear)` });
      if (apply) await keyRepo.update({ id: In(staleIds) }, { agent_id: null });
      return { affected: stale.length };
    }
    // migrate (default)
    items.push({ kind: 'remap', entity: 'api_key', id: staleIds.join(','), detail: `${stale.length} api key(s) re-stamped to dest workspace` });
    if (apply) await keyRepo.update({ id: In(staleIds) }, { workspace_id: targetWsId });
    return { affected: stale.length };
  }

  /**
   * (D) Actions in workspaces OTHER than dest whose `target_agent_id` = this
   * agent become cross-workspace after the move. Actions are operator config
   * (not auto-migrated, to avoid duplicating scheduled jobs), so they are
   * surfaced as warnings only.
   */
  private async warnForeignAgentActions(
    mgr: RepoScope, agent: Agent, targetWsId: string, items: MovePreviewItem[],
  ): Promise<void> {
    const actions = await mgr.getRepository(Action).find({ where: { target_agent_id: agent.id } });
    for (const a of actions) {
      if ((a.workspace_id || '') === targetWsId) continue; // already lands in dest — fine
      items.push({ kind: 'warn', entity: 'action', id: a.id, detail: `action "${a.name}" (ws ${a.workspace_id}) targets this agent — becomes cross-workspace; review/move it manually` });
    }
  }

  /**
   * (E) Role assignments and denormalized assignee/reporter/reviewer ids that
   * reference this agent on tickets which are NOT in the destination workspace.
   * After the move those become cross-workspace links — the same integrity
   * violation the board move guards against. Default policy 'block' reports
   * each and refuses the commit; 'clear' deletes the assignment rows and blanks
   * the denormalized ids so no foreign ticket is left pointing at the agent.
   * Returns { crossRefs, cleared }.
   */
  private async handleCrossWorkspaceAgentRefs(
    mgr: RepoScope, agent: Agent, targetWsId: string, policy: AgentCrossRefPolicy,
    items: MovePreviewItem[], blockers: MoveBlocker[], apply: boolean,
  ): Promise<{ crossRefs: number; cleared: number }> {
    const assignRepo = mgr.getRepository(TicketRoleAssignment);
    const ticketRepo = mgr.getRepository(Ticket);

    const assignments = await assignRepo.find({ where: { agent_id: agent.id } });
    // Denormalized refs: assignee_id / reporter_id / reviewer_id columns.
    const denormTickets = await ticketRepo.find({
      where: [
        { assignee_id: agent.id },
        { reporter_id: agent.id },
        { reviewer_id: agent.id },
      ],
    });

    // Resolve the workspace of every ticket referenced so we can tell which
    // references would straddle the workspace boundary post-move.
    const ticketIds = new Set<string>([
      ...assignments.map((a) => a.ticket_id),
      ...denormTickets.map((t) => t.id),
    ]);
    const ticketWs = new Map<string, string>();
    if (ticketIds.size) {
      const rows = await ticketRepo.find({ where: { id: In([...ticketIds]) }, select: ['id', 'workspace_id'] });
      for (const r of rows) ticketWs.set(r.id, r.workspace_id || '');
    }

    let crossRefs = 0, cleared = 0;
    // Accumulate offending tickets/fields so the block-policy path can emit ONE
    // grouped, remediable blocker each (role assignments / denorm refs) the UI
    // can resolve in a single click, rather than one blocker per row.
    const blockAssignTicketIds = new Set<string>();
    const blockDenormTicketIds = new Set<string>();
    const blockDenormFields = new Set<string>();

    // Role assignments on non-dest tickets.
    for (const a of assignments) {
      if (ticketWs.get(a.ticket_id) === targetWsId) continue; // lands in dest — fine
      crossRefs++;
      if (policy === 'block') {
        const msg = `agent "${agent.name}" holds a role on ticket ${a.ticket_id} (ws ${ticketWs.get(a.ticket_id) || '?'}) outside dest`;
        blockAssignTicketIds.add(a.ticket_id);
        items.push({ kind: 'block', entity: 'role_assignment', id: a.id, detail: msg });
      } else {
        items.push({ kind: 'warn', entity: 'role_assignment', id: a.id, detail: `role assignment on foreign ticket ${a.ticket_id} cleared (policy=clear)` });
        cleared++;
        if (apply) await assignRepo.delete({ id: a.id });
      }
    }

    // Denormalized assignee/reporter/reviewer ids on non-dest tickets.
    for (const t of denormTickets) {
      if ((ticketWs.get(t.id) || t.workspace_id || '') === targetWsId) continue;
      const fields: Array<'assignee_id' | 'reporter_id' | 'reviewer_id'> =
        (['assignee_id', 'reporter_id', 'reviewer_id'] as const).filter((f) => (t as any)[f] === agent.id);
      crossRefs += fields.length;
      if (policy === 'block') {
        const msg = `agent "${agent.name}" is ${fields.join('/')} on ticket ${t.id} (ws ${t.workspace_id}) outside dest`;
        blockDenormTicketIds.add(t.id);
        for (const f of fields) blockDenormFields.add(f);
        items.push({ kind: 'block', entity: 'ticket', id: t.id, detail: msg });
      } else {
        items.push({ kind: 'warn', entity: 'ticket', id: t.id, detail: `${fields.join('/')} on foreign ticket ${t.id} cleared (policy=clear)` });
        cleared += fields.length;
        if (apply) {
          const patch: Record<string, string> = {};
          for (const f of fields) patch[f] = '';
          await ticketRepo.update({ id: t.id }, patch);
        }
      }
    }

    // Emit grouped blockers (block policy only). Both offer the write-free
    // policy switch (set_cross_ref_policy=clear → re-preview) plus a direct
    // unassign mutation that detaches the agent from the offending tickets.
    if (blockAssignTicketIds.size > 0) {
      const ids = [...blockAssignTicketIds];
      blockers.push({
        code: 'cross_ref_block',
        message: `agent "${agent.name}" holds a role on ${ids.length} ticket(s) outside dest`,
        agent_id: agent.id,
        ticket_ids: ids,
        remedies: [
          { action: 'set_cross_ref_policy', kind: 'repreview', label: 'Clear the foreign refs on move (policy=clear)', params: { value: 'clear' } },
          { action: 'unassign_from_tickets', kind: 'mutation', label: `Unassign "${agent.name}" from ${ids.length} foreign ticket(s)`, params: { agent_id: agent.id, ticket_ids: ids } },
        ],
      });
    }
    if (blockDenormTicketIds.size > 0) {
      const ids = [...blockDenormTicketIds];
      blockers.push({
        code: 'denorm_ref_block',
        message: `agent "${agent.name}" is ${[...blockDenormFields].join('/')} on ${ids.length} ticket(s) outside dest`,
        agent_id: agent.id,
        ticket_ids: ids,
        fields: [...blockDenormFields],
        remedies: [
          { action: 'set_cross_ref_policy', kind: 'repreview', label: 'Clear the foreign refs on move (policy=clear)', params: { value: 'clear' } },
          { action: 'unassign_from_tickets', kind: 'mutation', label: `Detach "${agent.name}" from ${ids.length} foreign ticket(s)`, params: { agent_id: agent.id, ticket_ids: ids } },
        ],
      });
    }

    return { crossRefs, cleared };
  }
}
