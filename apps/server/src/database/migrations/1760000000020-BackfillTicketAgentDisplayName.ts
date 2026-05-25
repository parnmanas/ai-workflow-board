import { MigrationInterface, QueryRunner } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';

/**
 * Backfill: re-canonicalize `tickets.assignee` / `tickets.reporter` text
 * columns to `<Manager>/<Agent>` whenever the corresponding *_id points at
 * an Agent that has a `manager_agent_id`.
 *
 * Why: the legacy denormalized text columns (`assignee`, `reporter`) are
 * read directly by TicketCard. Two write paths used to store bare leaf
 * names ("AWB") instead of the canonical Manager/Agent display
 * ("Rolf/AWB"):
 *
 *   1. REST `PUT /tickets/:id/role-assignments/:roleId` (setRoleAssignment)
 *   2. REST `PATCH /tickets/:id` (update) when the caller passed both
 *      `assignee_id` and a bare `assignee` literal — the literal won.
 *
 * Both are fixed in the same commit; this migration re-syncs every existing
 * row so TicketCard stops showing the truncated name on tickets that were
 * created or edited before the fix.
 *
 * Invariants (D-02/D-03/D-04):
 *
 * - DATA only, no schema DDL. Touches row values via the Repository API.
 * - Idempotent — if every ticket already has the canonical display in the
 *   text column, this is a no-op. Re-running touches zero rows.
 * - Portable: no DB-specific SQL, runs on sqlite / mysql / postgres.
 * - User-held slots are skipped (user names don't have the Manager/Agent
 *   shape; the column already stores `User.name || User.email`).
 *
 * down() is a no-op — there is no faithful inverse without an audit log of
 * the prior (broken) value.
 */
export class BackfillTicketAgentDisplayName1760000000020 implements MigrationInterface {
  name = 'BackfillTicketAgentDisplayName1760000000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const ticketRepo = manager.getRepository(Ticket);
    const agentRepo = manager.getRepository(Agent);

    // Load every agent once and build a lookup of canonical display names
    // keyed by agent id. Cheaper than per-ticket lookups; the agent table
    // is small relative to tickets.
    const agents = await agentRepo.find();
    const agentById = new Map<string, Agent>();
    for (const a of agents) agentById.set(a.id, a);

    const formatDisplay = (agent: Agent): string => {
      if (!agent.manager_agent_id) return agent.name;
      const mgr = agentById.get(agent.manager_agent_id);
      if (!mgr) return agent.name;
      return `${mgr.name}/${agent.name}`;
    };

    const tickets = await ticketRepo.find();
    let updated = 0;
    for (const t of tickets) {
      let dirty = false;
      if (t.assignee_id) {
        const a = agentById.get(t.assignee_id);
        if (a) {
          const display = formatDisplay(a);
          if (t.assignee !== display) {
            t.assignee = display;
            dirty = true;
          }
        }
      }
      if (t.reporter_id) {
        const a = agentById.get(t.reporter_id);
        if (a) {
          const display = formatDisplay(a);
          if (t.reporter !== display) {
            t.reporter = display;
            dirty = true;
          }
        }
      }
      if (dirty) {
        await ticketRepo.save(t);
        updated++;
      }
    }

    // No logger handle in QueryRunner — use console so /admin/logs picks it
    // up from the runMigrations() wrapper in DatabaseModule.onModuleInit().
    if (updated > 0) {
      // eslint-disable-next-line no-console
      console.log(`[Migration] BackfillTicketAgentDisplayName: re-canonicalized ${updated} ticket row(s)`);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No faithful inverse — see header.
  }
}
