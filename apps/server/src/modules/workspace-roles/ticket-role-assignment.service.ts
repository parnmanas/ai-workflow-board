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

/** One role with ALL of its holders — the multi-holder (T1) view. */
export interface ResolvedRoleHolders {
  role: WorkspaceRole;
  holders: Array<{ type: 'agent' | 'user'; id: string; name: string }>;
}

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** A single holder identity — exactly one of agent_id / user_id is set. */
export interface HolderRef {
  agent_id?: string | null;
  user_id?: string | null;
}

/**
 * Normalized holder identity written into `holder_key` — the third leg of the
 * `(ticket_id, role_id, holder_key)` unique key. Agents win when (illegally)
 * both are supplied; the empty string marks a vacant slot, which we never
 * actually persist (vacant rows are deleted). Kept as a pure function so the
 * migration backfill and the service agree on the exact format.
 */
export function computeHolderKey(holder: HolderRef): string {
  const agent_id = holder.agent_id || null;
  const user_id = holder.user_id || null;
  if (agent_id) return `agent:${agent_id}`;
  if (user_id) return `user:${user_id}`;
  return '';
}

/**
 * Read/write helper for `ticket_role_assignments`. Centralizes the
 * (ticket_id, role_id) → holder lookup so the trigger loop, allocation
 * service, notification service, ticket CRUD, and MCP tools all share one
 * implementation of "who holds role X on ticket Y."
 *
 * MULTI-HOLDER (다중담당자 T1): a role may now carry several holders. Two
 * families of write helpers:
 *   - `setHolder()` / `syncBuiltinTrio()` — SINGLE-holder authoritative. They
 *     make the given holder the *sole* occupant of the role (clearing any
 *     others), preserving the exact v1 semantics every current consumer
 *     depends on. Passing both null clears the whole slot.
 *   - `addHolder()` / `removeHolder()` / `setHolders()` — MULTI-holder. They
 *     add/remove/replace individual holders without disturbing siblings.
 *
 * Setting a holder is upsert-style: passing `agent_id`/`user_id` writes the
 * row (keyed by `holder_key`), passing both null clears it (deletes the
 * assignment row outright — we don't keep empty rows around because the
 * absence-of-a-row already means "vacant" everywhere else in the codebase).
 *
 * Single-holder consumers (trigger loop / allocation / mention) read the
 * FIRST holder via `getHolderBySlug()` / `getOne()` shims until the T2
 * fan-out teaches them to iterate every holder.
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

  /**
   * Same data as `resolveForTicket` but grouped by role into a `holders[]`
   * array — the multi-holder (T1) shape the UI (T6) and consensus gate (T3)
   * consume. The flat `resolveForTicket` is kept for the existing single-holder
   * callers (author-role badge, REST role-assignments projection) that filter
   * row-by-row; this grouped view is the additive multi-holder accessor.
   */
  async resolveGroupedForTicket(ticketId: string): Promise<ResolvedRoleHolders[]> {
    const flat = await this.resolveForTicket(ticketId);
    const byRole = new Map<string, ResolvedRoleHolders>();
    for (const r of flat) {
      let group = byRole.get(r.role.id);
      if (!group) {
        group = { role: r.role, holders: [] };
        byRole.set(r.role.id, group);
      }
      if (r.holder) group.holders.push(r.holder);
    }
    return [...byRole.values()].sort((a, b) => a.role.position - b.role.position);
  }

  /**
   * Lookup the FIRST assignment for one (ticket, role) pair, or null.
   *
   * With multi-holder a role can now own several rows; single-holder consumers
   * (trigger loop / allocation / mention via `getHolderBySlug`) call this as a
   * shim and get the earliest-created holder deterministically. Explicit order
   * matters — an unordered findOne would pick a nondeterministic row once a
   * role has 2+ holders. Real fan-out (iterate every holder) arrives in T2.
   */
  async getOne(ticketId: string, roleId: string): Promise<TicketRoleAssignment | null> {
    return this.assignRepo.findOne({
      where: { ticket_id: ticketId, role_id: roleId },
      order: { created_at: 'ASC', id: 'ASC' },
    });
  }

  /** ALL holder rows for one (ticket, role) pair, earliest-created first. */
  async getAll(ticketId: string, roleId: string): Promise<TicketRoleAssignment[]> {
    return this.assignRepo.find({
      where: { ticket_id: ticketId, role_id: roleId },
      order: { created_at: 'ASC', id: 'ASC' },
    });
  }

  /**
   * SINGLE-holder authoritative set. Makes `holder` the *sole* occupant of the
   * role on the ticket (clearing any other holders); passing both null clears
   * the whole slot. This preserves the exact v1 semantics every current
   * consumer depends on — even if a role has since gained extra holders via the
   * multi-holder path, `setHolder` collapses it back to one. Mutually exclusive
   * agent_id / user_id.
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

    // Authoritative: drop every existing holder of this role first, so the end
    // state is exactly "this one holder" (or vacant). Delete-then-insert also
    // sidesteps the (ticket_id, role_id, holder_key) unique key when switching
    // between holders.
    await this.assignRepo.delete({ ticket_id: ticketId, role_id: roleId });
    if (!agent_id && !user_id) return null;

    return this.assignRepo.save(this.assignRepo.create({
      ticket_id: ticketId,
      role_id: roleId,
      agent_id,
      user_id,
      holder_key: computeHolderKey({ agent_id, user_id }),
    }));
  }

  /**
   * MULTI-holder: add one holder to a role WITHOUT disturbing existing holders.
   * Idempotent on (ticket, role, holder) — re-adding the same holder returns
   * the existing row instead of creating a duplicate (the unique key would
   * reject it anyway). Passing both null is a no-op. Mutually exclusive
   * agent_id / user_id.
   */
  async addHolder(
    ticketId: string,
    roleId: string,
    holder: { agent_id?: string | null; user_id?: string | null },
  ): Promise<TicketRoleAssignment | null> {
    const agent_id = holder.agent_id || null;
    const user_id = holder.user_id || null;
    if (agent_id && user_id) {
      throw makeError(400, 'cannot set both agent_id and user_id on the same role assignment');
    }
    if (!agent_id && !user_id) return null;

    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw makeError(404, `role ${roleId} not found`);

    const holder_key = computeHolderKey({ agent_id, user_id });
    const existing = await this.assignRepo.findOne({
      where: { ticket_id: ticketId, role_id: roleId, holder_key },
    });
    if (existing) return existing;

    return this.assignRepo.save(this.assignRepo.create({
      ticket_id: ticketId,
      role_id: roleId,
      agent_id,
      user_id,
      holder_key,
    }));
  }

  /**
   * MULTI-holder: remove one specific holder from a role, leaving the rest in
   * place. No-op if that holder isn't currently on the role. Returns true iff a
   * row was actually deleted.
   */
  async removeHolder(
    ticketId: string,
    roleId: string,
    holder: { agent_id?: string | null; user_id?: string | null },
  ): Promise<boolean> {
    const holder_key = computeHolderKey({
      agent_id: holder.agent_id || null,
      user_id: holder.user_id || null,
    });
    if (!holder_key) return false;
    const res = await this.assignRepo.delete({ ticket_id: ticketId, role_id: roleId, holder_key });
    return (res.affected || 0) > 0;
  }

  /**
   * MULTI-holder: replace the ENTIRE holder set of a role with `holders`.
   * Deletes holders no longer present and inserts new ones, leaving unchanged
   * holders untouched (so their created_at — the getOne "first holder" tiebreak
   * — is preserved). Passing `[]` clears the role. Duplicate holders in the
   * input are de-duplicated by holder_key. Mutually exclusive agent_id/user_id
   * per entry.
   */
  async setHolders(
    ticketId: string,
    roleId: string,
    holders: Array<{ agent_id?: string | null; user_id?: string | null }>,
  ): Promise<TicketRoleAssignment[]> {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw makeError(404, `role ${roleId} not found`);

    // Normalize + de-dupe the desired set, keeping the first occurrence.
    const desired = new Map<string, { agent_id: string | null; user_id: string | null }>();
    for (const h of holders) {
      const agent_id = h.agent_id || null;
      const user_id = h.user_id || null;
      if (agent_id && user_id) {
        throw makeError(400, 'cannot set both agent_id and user_id on the same role assignment');
      }
      const key = computeHolderKey({ agent_id, user_id });
      if (!key) continue; // skip vacant entries
      if (!desired.has(key)) desired.set(key, { agent_id, user_id });
    }

    const existing = await this.getAll(ticketId, roleId);
    const existingKeys = new Set(existing.map(r => r.holder_key));

    // Delete rows whose holder is no longer desired.
    const toDelete = existing.filter(r => !desired.has(r.holder_key));
    if (toDelete.length) {
      await this.assignRepo.delete(toDelete.map(r => r.id));
    }

    // Insert rows for newly-desired holders.
    const toInsert: TicketRoleAssignment[] = [];
    for (const [key, h] of desired) {
      if (existingKeys.has(key)) continue;
      toInsert.push(this.assignRepo.create({
        ticket_id: ticketId,
        role_id: roleId,
        agent_id: h.agent_id,
        user_id: h.user_id,
        holder_key: key,
      }));
    }
    if (toInsert.length) await this.assignRepo.save(toInsert);

    return this.getAll(ticketId, roleId);
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
