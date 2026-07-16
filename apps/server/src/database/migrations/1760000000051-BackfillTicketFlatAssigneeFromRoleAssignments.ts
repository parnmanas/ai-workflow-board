import { MigrationInterface, QueryRunner } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { User } from '../../entities/User';
import { Ticket } from '../../entities/Ticket';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';

/**
 * Backfill: re-project the normalized `ticket_role_assignments` holders onto
 * the flat legacy `tickets.assignee(_id)` / `reporter(_id)` / `reviewer_id`
 * columns wherever they drifted out of sync (ticket da39d1da).
 *
 * Why: board `default_role_assignments` and the generalized `role_assignments[]`
 * create path wrote ONLY the assignment table, never the flat columns. Yet the
 * board, MCP `get_board_summary` (`assignee: t.assignee || 'unassigned'`), and
 * MCP `get_my_tickets` (whose SQL WHERE FILTERS on `assignee_id` /
 * `reporter_id` / `reviewer_id`) all still read the flat columns — so a ticket
 * assigned purely via those paths rendered as "unassigned" and was even
 * excluded from the assignee's own `get_my_tickets` list (the dispatch-loss red
 * herring). The same commit teaches `TicketRoleAssignmentService` to mirror
 * every builtin-role write back to the flat columns; this migration heals rows
 * created before that fix.
 *
 * Source of truth = the assignment table. For each builtin slug we take the
 * FIRST holder (earliest created_at, id tiebreak) — the same holder the trigger
 * loop / allocation read via `getOne` — and write its id + canonical display
 * name into the flat columns (`reviewer` has an id column only). Holder display
 * matches the runtime write-back: canonical `<Manager>/<Agent>` for agents,
 * `name || email` for users, '' when the holder row points at a deleted
 * agent/user.
 *
 * Invariants (matching 1760000000020-BackfillTicketAgentDisplayName):
 * - DATA only, no DDL. Repository API, portable across sqlite/mysql/postgres.
 * - Idempotent — a row already equal to its first holder is untouched;
 *   re-running touches zero rows.
 * - NON-DESTRUCTIVE: only rewrites a flat column for a slug that actually has
 *   an assignment row. A slug with NO assignment row is left exactly as-is — we
 *   never blank an explicitly-set legacy column (the v0.34 seed migration
 *   1760000000008 already normalized every legacy flat holder into the
 *   assignment table, so a populated flat column without an assignment row is
 *   pre-v0.34 data we must not destroy).
 *
 * down() is a no-op — there is no faithful inverse without an audit log of the
 * prior (divergent) value.
 */
export class BackfillTicketFlatAssigneeFromRoleAssignments1760000000051 implements MigrationInterface {
  name = 'BackfillTicketFlatAssigneeFromRoleAssignments1760000000051';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const ticketRepo = manager.getRepository(Ticket);
    const agentRepo = manager.getRepository(Agent);
    const userRepo = manager.getRepository(User);
    const roleRepo = manager.getRepository(WorkspaceRole);
    const assignRepo = manager.getRepository(TicketRoleAssignment);

    // Builtin slug → flat column(s). Mirrors LEGACY_SLUG_COLUMNS in
    // ticket-role-assignment.service.ts (inlined so the migration is
    // self-contained). `reviewer` has no display-name column.
    const SLUG_COLUMNS: Record<string, { id: 'assignee_id' | 'reporter_id' | 'reviewer_id'; name?: 'assignee' | 'reporter' }> = {
      assignee: { id: 'assignee_id', name: 'assignee' },
      reporter: { id: 'reporter_id', name: 'reporter' },
      reviewer: { id: 'reviewer_id' },
    };

    // Only builtin roles carry a flat column — id → slug for those.
    const roles = await roleRepo.find();
    const builtinSlugByRoleId = new Map<string, string>();
    for (const r of roles) {
      if (SLUG_COLUMNS[r.slug]) builtinSlugByRoleId.set(r.id, r.slug);
    }
    if (builtinSlugByRoleId.size === 0) return;

    // Canonical <Manager>/<Agent> display, resolved once per agent (matches
    // resolveAgentDisplayName / the runtime write-back).
    const agents = await agentRepo.find();
    const agentById = new Map<string, Agent>();
    for (const a of agents) agentById.set(a.id, a);
    const displayForAgent = (agentId: string): { id: string; name: string } | null => {
      const a = agentById.get(agentId);
      if (!a) return { id: agentId, name: '' }; // orphan holder — mirror id, blank name
      if (!a.manager_agent_id) return { id: a.id, name: a.name };
      const mgr = agentById.get(a.manager_agent_id);
      return { id: a.id, name: mgr ? `${mgr.name}/${a.name}` : a.name };
    };

    const users = await userRepo.find();
    const userById = new Map<string, User>();
    for (const u of users) userById.set(u.id, u);

    // First holder per (ticket, role): earliest created_at, id tiebreak — the
    // exact getOne ordering single-holder consumers read.
    const assignments = await assignRepo.find();
    assignments.sort((a, b) => {
      const at = new Date(a.created_at).getTime();
      const bt = new Date(b.created_at).getTime();
      if (at !== bt) return at - bt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    // (ticketId → slug → first holder projection)
    const firstBySlug = new Map<string, Map<string, { id: string; name: string }>>();
    for (const row of assignments) {
      const slug = builtinSlugByRoleId.get(row.role_id);
      if (!slug) continue;
      let perTicket = firstBySlug.get(row.ticket_id);
      if (!perTicket) { perTicket = new Map(); firstBySlug.set(row.ticket_id, perTicket); }
      if (perTicket.has(slug)) continue; // already captured the earliest holder
      let projection: { id: string; name: string } | null = null;
      if (row.agent_id) {
        projection = displayForAgent(row.agent_id);
      } else if (row.user_id) {
        const u = userById.get(row.user_id);
        projection = { id: row.user_id, name: u ? (u.name || u.email) : '' };
      }
      if (projection) perTicket.set(slug, projection);
    }

    // Walk only tickets that have builtin assignment rows — never touch a slug
    // that lacks an assignment row (non-destructive).
    let updated = 0;
    for (const [ticketId, perTicket] of firstBySlug) {
      const t = await ticketRepo.findOne({ where: { id: ticketId } });
      if (!t) continue;
      const patch: Record<string, string> = {};
      for (const [slug, projection] of perTicket) {
        const cols = SLUG_COLUMNS[slug];
        if (!cols) continue;
        if (((t as any)[cols.id] || '') !== projection.id) patch[cols.id] = projection.id;
        if (cols.name && ((t as any)[cols.name] || '') !== projection.name) patch[cols.name] = projection.name;
      }
      if (Object.keys(patch).length > 0) {
        await ticketRepo.update(ticketId, patch);
        updated++;
      }
    }

    // No logger handle in QueryRunner — console so /admin/logs picks it up from
    // the runMigrations() wrapper in DatabaseModule.onModuleInit().
    if (updated > 0) {
      // eslint-disable-next-line no-console
      console.log(`[Migration] BackfillTicketFlatAssigneeFromRoleAssignments: healed ${updated} ticket row(s)`);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No faithful inverse — see header.
  }
}
