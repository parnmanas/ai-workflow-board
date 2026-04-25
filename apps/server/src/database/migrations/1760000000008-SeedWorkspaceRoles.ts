import { MigrationInterface, QueryRunner } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { Ticket } from '../../entities/Ticket';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { Agent } from '../../entities/Agent';
import { User } from '../../entities/User';
import { BUILTIN_ROLES } from '../../db';

/**
 * v0.34 — workspace-configurable roles bootstrap.
 *
 * Two pure-data passes (schema is already in place via synchronize):
 *
 *   1. **Seed built-in roles per workspace** — every existing workspace gets
 *      three rows in `workspace_roles` (slug=assignee/reporter/reviewer,
 *      is_builtin=true). Idempotent: re-running is a no-op because the
 *      seed checks for existing rows by (workspace_id, slug).
 *
 *   2. **Backfill ticket assignments** — for every ticket whose legacy
 *      `assignee_id` / `reporter_id` / `reviewer_id` column is non-empty,
 *      create the corresponding `ticket_role_assignments` row. Resolves
 *      whether the holder is an agent or user by repository lookup so the
 *      mutually-exclusive `(agent_id|user_id)` invariant holds. Idempotent
 *      via `(ticket_id, role_id)` uniqueness.
 *
 * The legacy ticket columns are NOT dropped here — that happens in a
 * follow-up migration (`1760000000009-DropLegacyTicketRoleColumns`) once
 * Deploy 1 has been verified in prod. Doing it in two steps avoids the
 * synchronize-before-migration ordering trap (synchronize would drop the
 * source columns before this backfill could read them).
 *
 * Constraint matrix (locked by v0.34 work):
 * - D-02: data only, no schema DDL.
 * - D-04: idempotent by uniqueness checks, safe on already-migrated DBs.
 */
export class SeedWorkspaceRoles1760000000008 implements MigrationInterface {
  name = 'SeedWorkspaceRoles1760000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;

    const wsRepo = manager.getRepository(Workspace);
    const roleRepo = manager.getRepository(WorkspaceRole);
    const ticketRepo = manager.getRepository(Ticket);
    const assignRepo = manager.getRepository(TicketRoleAssignment);
    const agentRepo = manager.getRepository(Agent);
    const userRepo = manager.getRepository(User);

    // ── Pass 1: seed built-in roles (preset shared with new-workspace path) ──
    const workspaces = await wsRepo.find();
    let createdRoles = 0;
    for (const ws of workspaces) {
      for (const def of BUILTIN_ROLES) {
        const existing = await roleRepo.findOne({
          where: { workspace_id: ws.id, slug: def.slug },
        });
        if (existing) continue;
        await roleRepo.save(roleRepo.create({
          workspace_id: ws.id,
          slug: def.slug,
          name: def.name,
          role_prompt: '',
          description: def.description,
          position: def.position,
          is_builtin: true,
        }));
        createdRoles++;
      }
    }
    console.log(`[v0.34 migration] seeded ${createdRoles} built-in role(s) across ${workspaces.length} workspace(s)`);

    // ── Pass 2: backfill ticket_role_assignments ─────────────────────────
    // Build a lookup index per workspace so we don't N+1 the role table per
    // ticket. Only built-in slugs are referenced here; custom slugs can't
    // exist yet on a fresh migration.
    const allRoles = await roleRepo.find({ where: { is_builtin: true } });
    const roleIndex = new Map<string, string>(); // `${ws_id}:${slug}` → role_id
    for (const r of allRoles) {
      roleIndex.set(`${r.workspace_id}:${r.slug}`, r.id);
    }

    // Cache holder-type lookup so we don't re-query per ticket.
    const agentIds = new Set<string>((await agentRepo.find({ select: ['id'] })).map(a => a.id));
    const userIds = new Set<string>((await userRepo.find({ select: ['id'] })).map(u => u.id));

    // Stream through tickets in batches — workspaces with thousands of
    // tickets shouldn't blow memory.
    const BATCH = 500;
    let offset = 0;
    let backfilled = 0;
    /* eslint-disable no-constant-condition */
    while (true) {
      const tickets = await ticketRepo.find({
        skip: offset,
        take: BATCH,
        order: { created_at: 'ASC' },
      });
      if (tickets.length === 0) break;

      for (const t of tickets) {
        if (!t.workspace_id) continue;
        const slots: Array<{ slug: string; holderId: string }> = [
          { slug: 'assignee', holderId: t.assignee_id || '' },
          { slug: 'reporter', holderId: t.reporter_id || '' },
          { slug: 'reviewer', holderId: t.reviewer_id || '' },
        ];
        for (const slot of slots) {
          if (!slot.holderId) continue;
          const roleId = roleIndex.get(`${t.workspace_id}:${slot.slug}`);
          if (!roleId) continue;
          // Skip if assignment already exists (idempotency)
          const existing = await assignRepo.findOne({
            where: { ticket_id: t.id, role_id: roleId },
          });
          if (existing) continue;
          // Resolve holder kind. If we can't pin it down (orphan ID), drop
          // it onto agent_id by default — that's where v1 always stored it.
          let agent_id: string | null = null;
          let user_id: string | null = null;
          if (userIds.has(slot.holderId)) user_id = slot.holderId;
          else if (agentIds.has(slot.holderId)) agent_id = slot.holderId;
          else agent_id = slot.holderId; // legacy fallback
          await assignRepo.save(assignRepo.create({
            ticket_id: t.id,
            role_id: roleId,
            agent_id,
            user_id,
          }));
          backfilled++;
        }
      }
      offset += tickets.length;
      if (tickets.length < BATCH) break;
    }
    console.log(`[v0.34 migration] backfilled ${backfilled} ticket role assignment(s)`);
  }

  public async down(): Promise<void> {
    // Data migrations don't have a true inverse — see BaselineDataMigration's
    // empty down() for precedent. Rolling back v0.34 means dropping the new
    // tables (handled by entity removal + synchronize) which automatically
    // discards the seeded rows.
  }
}
