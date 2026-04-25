import { Module, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { TypeOrmModule, InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions, DEFAULT_COLUMNS, BUILTIN_ROLES } from '../db';
import * as entitiesBarrel from '../entities';
import { Workspace } from '../entities/Workspace';
import { Board } from '../entities/Board';
import { BoardColumn } from '../entities/BoardColumn';
import { WorkspaceRole } from '../entities/WorkspaceRole';
import { LogService } from '../services/log.service';

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

    const wsRepo = this.dataSource.getRepository(Workspace);
    const boardRepo = this.dataSource.getRepository(Board);
    const colRepo = this.dataSource.getRepository(BoardColumn);
    const roleRepo = this.dataSource.getRepository(WorkspaceRole);

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
      }));

      const defaultCols = DEFAULT_COLUMNS.map(c => ({
        ...c,
        board_id: board.id,
      }));
      await colRepo.save(defaultCols.map(c => colRepo.create(c)));

      // v0.34 — seed the same role preset every newly-created workspace
      // gets so the default workspace doesn't end up role-less if the
      // 1760000000008 migration runs before this block (or never runs at
      // all on a fresh DB).
      await roleRepo.save(BUILTIN_ROLES.map(def => roleRepo.create({
        workspace_id: ws.id,
        slug: def.slug,
        name: def.name,
        role_prompt: '',
        description: def.description,
        position: def.position,
        is_builtin: true,
      })));

      this.dbLog(`Seeded default workspace with board, ${defaultCols.length} columns, and ${BUILTIN_ROLES.length} roles`);
    }
  }
}
