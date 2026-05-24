import { Module, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { TypeOrmModule, InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions, DEFAULT_COLUMNS, BUILTIN_ROLES, DEFAULT_BOARD_ROUTING } from '../db';
import { DEFAULT_PROMPT_TEMPLATES } from './default-prompt-templates';
import * as entitiesBarrel from '../entities';
import { Workspace } from '../entities/Workspace';
import { Board } from '../entities/Board';
import { BoardColumn } from '../entities/BoardColumn';
import { WorkspaceRole } from '../entities/WorkspaceRole';
import { PromptTemplate } from '../entities/PromptTemplate';
import { LogService } from '../services/log.service';
import { writeRoutingConfigThrough } from '../modules/boards/routing-config.helper';
import { seedDefaultColumnRolePolicies } from '../modules/column-policies/seed-helper';
import { Agent } from '../entities/Agent';
import { Not, IsNull } from 'typeorm';

const entityList = Object.values(entitiesBarrel);

/**
 * DEFAULT_COLUMNS is re-exported from here for backward compatibility —
 * several modules (workspaces, qa, boards controllers) import it from
 * `../../database/database.module`. The canonical definition lives in `db.ts`.
 */
export { DEFAULT_COLUMNS };

@Module({
  imports: [
    TypeOrmModule.forRoot(buildDataSourceOptions()),
    TypeOrmModule.forFeature(entityList),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule implements OnModuleInit {
  constructor(
    @InjectDataSource() private dataSource: DataSource,
    @Optional() @Inject(LogService) private logService?: LogService,
  ) {}

  private dbLog(message: string) {
    if (this.logService) {
      this.logService.info('DB', message);
    } else {
      console.log('[DB]', message);
    }
  }

  async onModuleInit() {
    const dbType = process.env.DB_TYPE || 'sqlite';
    this.dbLog(`Connected using ${dbType}`);

    // ── Run data migrations (D-02 / D-04) ──
    // `synchronize: true` has already produced the schema during DataSource.initialize();
    // we invoke runMigrations() manually here so it races cleanly with that step (P-03).
    // Baseline migrations are idempotent, so re-running on an already-migrated DB is a no-op.
    try {
      const pending = await this.dataSource.showMigrations();
      if (pending) {
        const applied = await this.dataSource.runMigrations({ transaction: 'each' });
        this.dbLog(
          `Ran ${applied.length} data migration(s): ${applied.map(m => m.name).join(', ')}`
        );
      }
    } catch (e) {
      this.dbLog(`Migration run failed: ${(e as Error).message}`);
      throw e;
    }

    // ── Boot-time defensive cleanup — strip workspace_id from manager rows ──
    // Operator invariant: AgentManager rows are NEVER tied to a workspace.
    //
    // Both prior attempts failed silently:
    //   1. `agentRepo.update({type:'manager', workspace_id: Not(IsNull())},
    //      {workspace_id: null})` — Not(IsNull()) in criteria was dropped
    //      on some TypeORM versions, emitting `WHERE type='manager'` only
    //      but with affected=0.
    //   2. `createQueryBuilder().update().set({workspace_id: null})` — `null`
    //      in .set() is treated as "skip this column" in some TypeORM
    //      versions, so the SQL ended up `UPDATE agents WHERE type='manager'`
    //      with an empty SET clause (no-op).
    //
    // Drop down to raw SQL via DataSource.query() to bypass ORM mediation
    // entirely. Log before-/after-counts so /admin/logs (category=DB)
    // proves what actually happened on every boot.
    try {
      const agentRepo = this.dataSource.getRepository(Agent);
      const totalManagers = await agentRepo.count({ where: { type: 'manager' } });
      const beforeNonNull = await agentRepo
        .createQueryBuilder('a')
        .where("a.type = :type", { type: 'manager' })
        .andWhere('a.workspace_id IS NOT NULL')
        .getCount();
      this.dbLog(
        `Boot cleanup: ${totalManagers} manager row(s) total, ${beforeNonNull} with non-NULL workspace_id — about to strip`,
      );

      const sql = "UPDATE agents SET workspace_id = NULL WHERE type = 'manager'";
      const raw = await this.dataSource.query(sql);
      // Postgres returns [rows, rowCount]; sqljs returns void. Try both shapes.
      const affected =
        Array.isArray(raw) && typeof raw[1] === 'number'
          ? raw[1]
          : (raw && typeof (raw as any).affected === 'number')
            ? (raw as any).affected
            : 'unknown';

      const afterNonNull = await agentRepo
        .createQueryBuilder('a')
        .where("a.type = :type", { type: 'manager' })
        .andWhere('a.workspace_id IS NOT NULL')
        .getCount();
      this.dbLog(
        `Boot cleanup: ${sql} → affected=${affected}, non-NULL after=${afterNonNull}`,
      );

      if (afterNonNull > 0) {
        // The UPDATE ran but rows still have non-NULL workspace_id. Most
        // likely cause: synchronize:true couldn't DROP NOT NULL on the
        // column (entity says nullable but the live schema rejects the
        // alter), so the raw UPDATE silently coerces NULL → '' or similar.
        // Dump the row state so the operator can see what's stuck.
        const stuck = await agentRepo
          .createQueryBuilder('a')
          .select(['a.id', 'a.name', 'a.workspace_id'])
          .where("a.type = :type", { type: 'manager' })
          .andWhere('a.workspace_id IS NOT NULL')
          .limit(10)
          .getMany();
        this.dbLog(
          `Boot cleanup: STILL non-NULL after UPDATE — sample: ${stuck
            .map((s) => `${s.id.slice(0, 8)}=${JSON.stringify(s.workspace_id)}`)
            .join(', ')}`,
        );
      }
    } catch (e) {
      this.dbLog(`Boot cleanup (manager workspace strip) FAILED: ${(e as Error).message}`);
      // Non-fatal — server can still serve, just the legacy rows stay
      // workspace-pinned until next boot or manual fix. Visible in logs.
    }

    const wsRepo = this.dataSource.getRepository(Workspace);
    const boardRepo = this.dataSource.getRepository(Board);
    const colRepo = this.dataSource.getRepository(BoardColumn);
    const roleRepo = this.dataSource.getRepository(WorkspaceRole);
    const tplRepo = this.dataSource.getRepository(PromptTemplate);

    // Seed default workspace if empty (seeding, NOT migration — stays here)
    const wsCount = await wsRepo.count();
    if (wsCount === 0) {
      const ws = await wsRepo.save(wsRepo.create({
        name: 'Default Workspace',
        description: 'Main workspace for AI agent collaboration',
      }));

      const board = await boardRepo.save(boardRepo.create({
        workspace_id: ws.id,
        name: 'AI Workflow Board',
        description: 'Main board for AI agent collaboration',
        // Seed the default plan→implement→review routing so the workflow
        // is functional out of the box. Admins can override via Board
        // Settings → Routing.
        routing_config: JSON.stringify(DEFAULT_BOARD_ROUTING),
      }));

      const defaultCols = DEFAULT_COLUMNS.map(c => ({
        ...c,
        board_id: board.id,
      }));
      const savedCols = await colRepo.save(defaultCols.map(c => colRepo.create(c)));

      // v0.41 — fan board.routing_config into per-column role_routing rows
      // so the trigger-loop / allocation paths can read role slugs straight
      // off the column without parsing the lowercased-name blob each time.
      await writeRoutingConfigThrough(this.dataSource, board.id);

      // v0.34 — seed the same role preset every newly-created workspace
      // gets so the default workspace doesn't end up role-less if the
      // 1760000000008 migration runs before this block (or never runs at
      // all on a fresh DB).
      await roleRepo.save(BUILTIN_ROLES.map(def => roleRepo.create({
        workspace_id: ws.id,
        slug: def.slug,
        name: def.name,
        role_prompt: def.role_prompt,
        description: def.description,
        position: def.position,
        is_builtin: true,
      })));

      // Default workflow prompt templates + auto-link to columns by name.
      // Inlined here (rather than calling PromptTemplatesService) because
      // DatabaseModule has no DI access to feature-module services.
      const seededTemplates = await tplRepo.save(DEFAULT_PROMPT_TEMPLATES.map(def =>
        tplRepo.create({
          workspace_id: ws.id,
          name: def.name,
          description: def.description,
          content: def.content,
          category: def.category,
        })));
      const tplIdByName = new Map(seededTemplates.map(t => [t.name, t.id]));
      const colPrompts: Record<string, string> = {};
      for (const col of savedCols) {
        // SEED-ONLY name match — runtime dispatch reads `BoardColumn.kind`
        // and `role_routing` exclusively (see ticket 47a90ea3 AC #3). This
        // hits at workspace-creation time only to pair the default prompt
        // templates with the freshly-minted default columns. TODO: migrate
        // `default-prompt-templates.ts::column_match` from a lowercased
        // name to a `kind_match: ColumnKind` enum so this last seed-time
        // hardcode goes away too.
        const def = DEFAULT_PROMPT_TEMPLATES.find(d => d.column_match === col.name.toLowerCase());
        if (!def) continue;
        const tplId = tplIdByName.get(def.name);
        if (tplId) colPrompts[col.id] = tplId;
      }
      if (Object.keys(colPrompts).length > 0) {
        await boardRepo.update({ id: board.id }, { column_prompts: JSON.stringify(colPrompts) });
      }

      // v0.42 — seed default ColumnRolePolicy rows for the freshly-created
      // default board (ticket f886ada7). Mirrors the 1760000000017
      // migration's logic — which only operates on PRE-existing boards —
      // so the first-run workspace gets the alert layer active out of the
      // box without a second restart.
      const policiesSeeded = await seedDefaultColumnRolePolicies(this.dataSource, { boardId: board.id });

      this.dbLog(`Seeded default workspace with board, ${defaultCols.length} columns, ${BUILTIN_ROLES.length} roles, ${seededTemplates.length} prompt templates, and ${policiesSeeded} column-role policies`);
    }
  }
}
