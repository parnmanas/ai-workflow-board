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

// PRESET — not enforced. New boards seed with these starter columns so the
// first-run UX isn't an empty page; the user can rename, reorder, delete,
// or add more freely. Critically distinct from the old "hardcoded routing
// fallback" that auto-mapped column names to assignee/reporter/reviewer
// roles — that remains removed (TriggerLoopService keys off routing_config
// only, no name-based magic). New columns are created with empty
// routing_config so they emit zero triggers until a workspace owner opts
// in via Board Settings.
//
// Set this to [] if a deployment wants every board to start blank.
//
// `is_terminal: true` on Done marks it as a workflow end-state — agents
// stop polling tickets parked there and the column toggles available in
// Board Settings reflect it. Other presets stay non-terminal so tickets
// can flow through them in either direction.
export const DEFAULT_COLUMNS: Array<{ name: string; position: number; color: string; is_terminal?: boolean }> = [
  { name: 'Backlog',     position: 0, color: '#94a3b8' },
  { name: 'To Do',       position: 1, color: '#60a5fa' },
  { name: 'In Progress', position: 2, color: '#fbbf24' },
  { name: 'Review',      position: 3, color: '#a78bfa' },
  { name: 'Merging',     position: 4, color: '#f472b6' },
  { name: 'Done',        position: 5, color: '#34d399', is_terminal: true },
];

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
  // Allow QA flow-test subprocess to target an isolated db file via env.
  // Two processes writing sqljs to the same file clobber each other on
  // autoSave, so the admin "Run Flow Tests" endpoint sets this to e.g.
  // database/qa-flows.db before spawning node --test.
  const sqliteLocation = process.env.SQLJS_DB_PATH
    ? (path.isAbsolute(process.env.SQLJS_DB_PATH)
        ? process.env.SQLJS_DB_PATH
        : path.join(dbDir, process.env.SQLJS_DB_PATH))
    : path.join(dbDir, 'data.db');
  return {
    type: 'sqljs',
    location: sqliteLocation,
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
