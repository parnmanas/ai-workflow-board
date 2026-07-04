import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { Agent } from '../../entities/Agent';
import { User } from '../../entities/User';
import type { DefaultRoleAssignments } from '../../common/default-role-assignments-config';

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
   * Board-wide batched multi-holder view: `resolveGroupedForTicket` for MANY
   * tickets in one shot (4 queries total — assignments + roles + agents + users),
   * returned as `ticketId → ResolvedRoleHolders[]`. Feeds the board-card
   * projection (T6 multi-avatar) without N+1 per-card lookups. Tickets with no
   * assignment are simply absent from the map (caller defaults to `[]`).
   */
  async resolveGroupedForTickets(ticketIds: string[]): Promise<Map<string, ResolvedRoleHolders[]>> {
    const result = new Map<string, ResolvedRoleHolders[]>();
    if (ticketIds.length === 0) return result;

    const rows = await this.assignRepo.find({ where: { ticket_id: In(ticketIds) } });
    if (rows.length === 0) return result;

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

    // ticketId → (roleId → group). Preserves per-ticket role grouping while
    // keeping insertion cheap; sorted by role.position on the way out.
    const byTicket = new Map<string, Map<string, ResolvedRoleHolders>>();
    for (const r of rows) {
      const role = roleMap.get(r.role_id);
      if (!role) continue;
      let holder: { type: 'agent' | 'user'; id: string; name: string } | null = null;
      if (r.agent_id && agentMap.has(r.agent_id)) {
        const a = agentMap.get(r.agent_id)!;
        holder = { type: 'agent', id: a.id, name: a.name };
      } else if (r.user_id && userMap.has(r.user_id)) {
        const u = userMap.get(r.user_id)!;
        holder = { type: 'user', id: u.id, name: u.name || u.email };
      }
      if (!holder) continue;
      let roleGroups = byTicket.get(r.ticket_id);
      if (!roleGroups) { roleGroups = new Map(); byTicket.set(r.ticket_id, roleGroups); }
      let group = roleGroups.get(role.id);
      if (!group) { group = { role, holders: [] }; roleGroups.set(role.id, group); }
      group.holders.push(holder);
    }
    for (const [ticketId, roleGroups] of byTicket) {
      result.set(ticketId, [...roleGroups.values()].sort((a, b) => a.role.position - b.role.position));
    }
    return result;
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

  /**
   * Keep only the holders whose agent/user still exists. A stale board default
   * config must never manufacture an orphan assignment row pointing at a
   * deleted agent/user. Batched (2 queries max). Agent-vs-user is mutually
   * exclusive per entry — an entry that names an agent that no longer exists is
   * dropped even if a user_id is also (illegally) present.
   */
  private async filterExistingHolders(
    holders: Array<{ agent_id?: string | null; user_id?: string | null }>,
  ): Promise<Array<{ agent_id: string | null; user_id: string | null }>> {
    const agentIds = [...new Set(holders.map(h => (h.agent_id || '').trim()).filter(Boolean))];
    const userIds = [...new Set(holders.map(h => (h.user_id || '').trim()).filter(Boolean))];
    const [agents, users] = await Promise.all([
      agentIds.length ? this.agentRepo.find({ where: { id: In(agentIds) }, select: ['id'] }) : Promise.resolve([] as Agent[]),
      userIds.length ? this.userRepo.find({ where: { id: In(userIds) }, select: ['id'] }) : Promise.resolve([] as User[]),
    ]);
    const agentSet = new Set(agents.map(a => a.id));
    const userSet = new Set(users.map(u => u.id));
    const out: Array<{ agent_id: string | null; user_id: string | null }> = [];
    for (const h of holders) {
      const agent_id = (h.agent_id || '').trim();
      const user_id = (h.user_id || '').trim();
      if (agent_id && agentSet.has(agent_id)) out.push({ agent_id, user_id: null });
      else if (user_id && userSet.has(user_id)) out.push({ agent_id: null, user_id });
    }
    return out;
  }

  /**
   * Apply a board's DEFAULT role holders (ticket d94a1b87) to a freshly-created
   * ticket. For each slug in `defaults`, if the ticket currently has NO holder
   * for that role, the default holders are written; a role that already carries
   * ≥1 holder (an explicit assignment already synced via syncBuiltinTrio /
   * setHolders at the creation site) is left untouched. This encodes the
   * create-time priority **explicit holder > board default > unassigned**.
   *
   * Contract for callers: run this AFTER the explicit-assignment writes at
   * every root-ticket creation site (MCP create_ticket, REST POST, QA/Security
   * auto-ticket, feature chain). `defaults` is the already-parsed/normalized
   * map from `parseDefaultRoleAssignments(board.default_role_assignments)`.
   * Holders whose agent/user no longer exists are dropped (a stale board config
   * must never manufacture an orphan). Never touches existing tickets — only
   * the one just created. Returns a per-slug summary of what was applied (for
   * the caller's activity/log line); a slug absent from the result was already
   * held or had no valid default holder.
   */
  async applyBoardDefaults(
    ticketId: string,
    workspaceId: string,
    defaults: DefaultRoleAssignments,
  ): Promise<Array<{ slug: string; applied: number }>> {
    if (!workspaceId || !defaults) return [];
    const slugs = Object.keys(defaults);
    if (slugs.length === 0) return [];

    const summary: Array<{ slug: string; applied: number }> = [];
    for (const slug of slugs) {
      const holders = defaults[slug] || [];
      if (holders.length === 0) continue;
      const role = await this.roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
      if (!role) continue; // board default names a slug this workspace doesn't have
      // Priority: explicit holder wins — only fill a role that is currently vacant.
      const existing = await this.getAll(ticketId, role.id);
      if (existing.length > 0) continue;
      const valid = await this.filterExistingHolders(holders);
      if (valid.length === 0) continue;
      const rows = await this.setHolders(ticketId, role.id, valid);
      if (rows.length > 0) summary.push({ slug, applied: rows.length });
    }
    return summary;
  }

  /**
   * Write-path (update_board) DB existence check for a board default config.
   * The JSON SHAPE is already validated by validateDefaultRoleAssignmentsInput;
   * this adds the layer that needs the DB — every slug must be a real role in
   * the board's workspace and every holder id a real agent/user. Returns the
   * first problem as an error string so the caller can 400, or `{ ok: true }`.
   * An empty config is trivially valid.
   */
  async validateBoardDefaults(
    workspaceId: string,
    defaults: DefaultRoleAssignments,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!workspaceId) return { ok: false, error: 'cannot validate default_role_assignments — board has no workspace' };
    for (const [slug, holders] of Object.entries(defaults)) {
      const role = await this.roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
      if (!role) return { ok: false, error: `default_role_assignments: unknown role slug "${slug}" for this workspace` };
      for (const h of holders) {
        const agent_id = (h.agent_id || '').trim();
        const user_id = (h.user_id || '').trim();
        if (agent_id) {
          const a = await this.agentRepo.findOne({ where: { id: agent_id }, select: ['id'] });
          if (!a) return { ok: false, error: `default_role_assignments["${slug}"]: agent ${agent_id} not found` };
        } else if (user_id) {
          const u = await this.userRepo.findOne({ where: { id: user_id }, select: ['id'] });
          if (!u) return { ok: false, error: `default_role_assignments["${slug}"]: user ${user_id} not found` };
        }
      }
    }
    return { ok: true };
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
