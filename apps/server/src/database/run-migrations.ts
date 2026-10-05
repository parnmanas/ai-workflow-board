import 'dotenv/config';
import 'reflect-metadata';
import {
  AppDataSource, AppOntologyDataSource, buildDataSourceOptions, initDb,
  flushSqljs, flushOntologySqljs, ensureSqljsDbHealthy, ensureOntologySqljsDbHealthy,
} from '../db';
import { preSyncAccountOwnership } from './pre-sync-account-ownership';
import { preSyncPostgres } from './pre-sync-postgres';

/** Offline data migration entry point; use the same pre-sync order as boot. */
async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error('Unsupported migration arguments; run migration:run without options. No database changes were made.');
  try {
    await ensureSqljsDbHealthy();
    await ensureOntologySqljsDbHealthy();
    await preSyncAccountOwnership(buildDataSourceOptions());
    await preSyncPostgres();
    await initDb();
    await flushSqljs(AppDataSource, true);
    if (AppOntologyDataSource) await flushOntologySqljs(AppOntologyDataSource, true);
    console.log('[DB] Schema and data migrations are current');
  } finally {
    if (AppOntologyDataSource?.isInitialized) await AppOntologyDataSource.destroy();
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}

main().catch(error => {
  console.error(`[DB] Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
