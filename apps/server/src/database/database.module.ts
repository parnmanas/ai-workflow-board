import { Module, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { TypeOrmModule, InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions, serializeSqljsTransactions } from '../db';
import * as entitiesBarrel from '../entities';
import { Account } from '../entities/Account';
import { LogService } from '../services/log.service';

const entityList = Object.values(entitiesBarrel);

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
  ) {
    // onModuleInit이 아니라 생성자에서 패치한다: Nest는 앱 전체 모든 모듈의
    // provider(생성자)를 어떤 모듈의 onModuleInit이 실행되기 전에 전부
    // 인스턴스화하므로, 다른 어디에서 나올 수 있는 가장 이른 .transaction()
    // 호출보다도 먼저 패치되는 것이 보장된다. Postgres/MySQL에서는 no-op —
    // db.ts의 serializeSqljsTransactions 참고.
    serializeSqljsTransactions(this.dataSource);
  }

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

    const wsRepo = this.dataSource.getRepository(Account);
    // Seed default workspace if empty (seeding, NOT migration — stays here).
    // A workspace is just a ticket pool now (docs/tickets.md) — nothing else
    // to seed.
    const wsCount = await wsRepo.count();
    if (wsCount === 0) {
      await wsRepo.save(wsRepo.create({
        name: 'Personal',
        description: 'Default ownership account',
      }));
      this.dbLog('Seeded default workspace');
    }
  }
}
