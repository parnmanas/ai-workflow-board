import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { Agent } from '../../entities/Agent';
import { User } from '../../entities/User';

export interface ResolvedAssignment {
  assignment: TicketRoleAssignment;
  role: WorkspaceRole;
  holder: { type: 'agent' | 'user'; id: string; name: string } | null;
}

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Read/write helper for `ticket_role_assignments`. Centralizes the
 * (ticket_id, role_id) → holder lookup so the trigger loop, allocation
 * service, notification service, ticket CRUD, and MCP tools all share one
 * implementation of "who holds role X on ticket Y."
 *
 * Setting a holder is upsert-style: passing `agent_id`/`user_id` writes the
 * row, passing both null clears it (deletes the assignment row outright —
 * we don't keep empty rows around because the absence-of-a-row already means
 * "vacant" everywhere else in the codebase).
 */
@Injectable()
export class TicketRoleAssignmentService {
  constructor(
    @InjectRepository(TicketRoleAssignment)
    private readonly assignRepo: Repository<TicketRoleAssignment>,

    @InjectRepository(WorkspaceRole)
    private readonly roleRepo: Repository<WorkspaceRole>,

    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /** Raw assignment rows for a ticket. */
  async listForTicket(ticketId: string): Promise<TicketRoleAssignment[]> {
    return this.assignRepo.find({ where: { ticket_id: ticketId } });
  }

  /**
   * Resolve assignments + role definitions + holder display info for a
   * ticket. Single batched query path so callers don't N+1.
   */
  async resolveForTicket(ticketId: string): Promise<ResolvedAssignment[]> {
    const rows = await this.listForTicket(ticketId);
    if (rows.length === 0) return [];

    const roleIds = [...new Set(rows.map(r => r.role_id))];
    const agentIds = [...new Set(rows.map(r => r.agent_id).filter((x): x is string => !!x))];
    const userIds = [...new Set(rows.map(r => r.user_id).filter((x): x is string => !!x))];

    const [roles, agents, users] = await Promise.all([
      this.roleRepo.find({ where: { id: In(roleIds) } }),
      agentIds.length ? this.agentRepo.find({ where: { id: In(agentIds) } }) : Promise.resolve([] as Agent[]),
      userIds.length ? this.userRepo.find({ where: { id: In(userIds) } }) : Promise.resolve([] as User[]),
    ]);

    const roleMap = new Map(roles.map(r => [r.id, r]));
    const agentMap = new Map(agents.map(a => [a.id, a]));
    const userMap = new Map(users.map(u => [u.id, u]));

    return rows
      .map(r => {
        const role = roleMap.get(r.role_id);
        if (!role) return null;
        let holder: ResolvedAssignment['holder'] = null;
        if (r.agent_id && agentMap.has(r.agent_id)) {
          const a = agentMap.get(r.agent_id)!;
          holder = { type: 'agent', id: a.id, name: a.name };
        } else if (r.user_id && userMap.has(r.user_id)) {
          const u = userMap.get(r.user_id)!;
          holder = { type: 'user', id: u.id, name: u.name || u.email };
        }
        return { assignment: r, role, holder };
      })
      .filter((x): x is ResolvedAssignment => !!x)
      .sort((a, b) => a.role.position - b.role.position);
  }

  /** Lookup the assignment for one (ticket, role) pair, or null. */
  async getOne(ticketId: string, roleId: string): Promise<TicketRoleAssignment | null> {
    return this.assignRepo.findOne({ where: { ticket_id: ticketId, role_id: roleId } });
  }

  /**
   * Set (or clear) the holder of a role on a ticket. Mutually exclusive
   * agent_id / user_id; passing both null removes the assignment row.
   *
   * Caller is responsible for verifying the holder exists in the right
   * workspace — this helper accepts the IDs as-is and only enforces the
   * mutual-exclusion shape.
   */
  async setHolder(
    ticketId: string,
    roleId: string,
    holder: { agent_id?: string | null; user_id?: string | null },
  ): Promise<TicketRoleAssignment | null> {
    const agent_id = holder.agent_id || null;
    const user_id = holder.user_id || null;
    if (agent_id && user_id) {
      throw makeError(400, 'cannot set both agent_id and user_id on the same role assignment');
    }

    // Validate role exists (cheap; prevents orphan assignment rows)
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw makeError(404, `role ${roleId} not found`);

    const existing = await this.getOne(ticketId, roleId);
    if (!agent_id && !user_id) {
      if (existing) await this.assignRepo.delete({ id: existing.id });
      return null;
    }

    if (existing) {
      existing.agent_id = agent_id;
      existing.user_id = user_id;
      return this.assignRepo.save(existing);
    }
    return this.assignRepo.save(this.assignRepo.create({
      ticket_id: ticketId,
      role_id: roleId,
      agent_id,
      user_id,
    }));
  }

  /** Holder lookup keyed by role slug — convenience for the trigger loop. */
  async getHolderBySlug(
    ticketId: string,
    workspaceId: string,
    slug: string,
  ): Promise<{ agent_id: string | null; user_id: string | null; role_id: string } | null> {
    const role = await this.roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
    if (!role) return null;
    const a = await this.getOne(ticketId, role.id);
    if (!a) return { agent_id: null, user_id: null, role_id: role.id };
    return { agent_id: a.agent_id, user_id: a.user_id, role_id: role.id };
  }

  /**
   * Mirror the v1 `(assignee_id, reporter_id, reviewer_id)` triple onto the
   * assignment table. Used by ticket create/update endpoints so newly
   * written tickets stay queryable by the trigger loop / allocation
   * service (which now read TicketRoleAssignment, not the legacy columns).
   *
   * Each of the three slug arguments is independently optional —
   * `undefined` means "leave the existing assignment untouched", empty
   * string means "clear the slot". This matches how the REST controller
   * receives `body.assignee_id` (string with empty = clear, missing =
   * unchanged on update). Holder type is auto-detected against agents/users.
   */
  async syncBuiltinTrio(
    ticketId: string,
    workspaceId: string,
    legacy: { assignee_id?: string; reporter_id?: string; reviewer_id?: string },
  ): Promise<void> {
    if (!workspaceId) return;
    const slugs: Array<[keyof typeof legacy, string]> = [
      ['assignee_id', 'assignee'],
      ['reporter_id', 'reporter'],
      ['reviewer_id', 'reviewer'],
    ];
    for (const [field, slug] of slugs) {
      const raw = legacy[field];
      if (raw === undefined) continue; // not in payload — preserve existing
      const role = await this.roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
      if (!role) continue; // workspace missing the builtin (shouldn't happen post-migration)
      if (!raw) {
        // Empty string → clear the slot
        await this.setHolder(ticketId, role.id, { agent_id: null, user_id: null });
        continue;
      }
      // Auto-detect agent vs user. Agents are checked first to match the
      // v1 default-fallback (legacy columns historically only stored agent IDs).
      const agentExists = await this.agentRepo.findOne({ where: { id: raw } });
      if (agentExists) {
        await this.setHolder(ticketId, role.id, { agent_id: raw, user_id: null });
        continue;
      }
      const userExists = await this.userRepo.findOne({ where: { id: raw } });
      if (userExists) {
        await this.setHolder(ticketId, role.id, { agent_id: null, user_id: raw });
        continue;
      }
      // Orphan ID — store as agent_id to mirror v1 column semantics.
      await this.setHolder(ticketId, role.id, { agent_id: raw, user_id: null });
    }
  }

  /** All tickets where the given agent (or user) holds at least one role. */
  async listTicketIdsForHolder(holder: { agent_id?: string; user_id?: string }): Promise<string[]> {
    const where = holder.agent_id
      ? { agent_id: holder.agent_id }
      : holder.user_id
        ? { user_id: holder.user_id }
        : null;
    if (!where) return [];
    const rows = await this.assignRepo.find({ where, select: ['ticket_id'] });
    return [...new Set(rows.map(r => r.ticket_id))];
  }
}
