/**
 * Database compatibility module
 *
 * Provides AppDataSource + buildDataSourceOptions() for modules that need
 * direct DataSource access (mcp-tools.ts, mcp-server.ts) and for the NestJS
 * DatabaseModule, which imports buildDataSourceOptions() to keep the
 * TypeORM configuration unified (D-05).
 *
 * Invariants (locked by .planning/phases/01-foundation/01-CONTEXT.md):
 * - D-01: synchronize is HARDCODED on in every branch (sqlite/mysql/postgres).
 *         It is NOT keyed off NODE_ENV. Schema DDL is driven by entity definitions.
 * - D-02: Migrations handle DATA only, not schema. The migrationsRun flag is
 *         hardcoded off so we can invoke runMigrations() manually from
 *         DatabaseModule.onModuleInit() after the synchronize step has completed (P-03).
 * - D-05: This file is the single source of truth for DataSource options.
 */
import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';
import * as entitiesBarrel from './entities';

const entities = Object.values(entitiesBarrel);

// New boards start with no columns. Hardcoded English defaults silently
// imposed a workflow shape ("Backlog/To Do/In Progress/Review/Done") that
// only matched the boards whose owners were happy to mirror it; everyone
// else had to delete and recreate. Workflow shape is now an explicit board
// setup step (UI / API), and trigger routing only fires for columns whose
// names are mapped in Board.routing_config.
export const DEFAULT_COLUMNS: Array<{ name: string; position: number; color: string }> = [];

export function buildDataSourceOptions(): DataSourceOptions {
  const dbType = (process.env.DB_TYPE || 'sqlite') as 'sqlite' | 'mysql' | 'postgres';
  // Migrations glob — matches both src/.ts (tsx dev mode) and dist/.js (compiled)
  const migrationsGlob = [path.join(__dirname, 'database', 'migrations', '*.{js,ts}')];

  if (dbType === 'mysql') {
    return {
      type: 'mysql',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'ai_workflow',
      entities,
      migrations: migrationsGlob,
      synchronize: true,   // D-01: always true, never NODE_ENV-gated
      migrationsRun: false, // D-02: invoked manually from DatabaseModule.onModuleInit()
      logging: false,
    };
  }

  if (dbType === 'postgres') {
    return {
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'ai_workflow',
      entities,
      migrations: migrationsGlob,
      synchronize: true,   // D-01
      migrationsRun: false, // D-02
      logging: false,
    };
  }

  // Default: SQLite (sql.js — pure WASM, no native build required)
  const dbDir = path.join(__dirname, '..', '..', '..', 'database');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  return {
    type: 'sqljs',
    location: path.join(dbDir, 'data.db'),
    autoSave: true,
    entities,
    migrations: migrationsGlob,
    synchronize: true,   // D-01
    migrationsRun: false, // D-02
    logging: false,
  };
}

export const AppDataSource = new DataSource(buildDataSourceOptions());

export async function initDb() {
  await AppDataSource.initialize();
  const dbType = process.env.DB_TYPE || 'sqlite';
  console.log(`[DB] Connected using ${dbType}`);
}
