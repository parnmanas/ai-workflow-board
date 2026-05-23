/**
 * Defensive boot-time cleanup for tables whose entity declares
 * workspace_id NOT NULL but where Postgres still has lingering NULL rows
 * from an earlier nullable schema window. Without this, TypeORM
 * synchronize aborts with:
 *
 *   QueryFailedError: column "workspace_id" of relation "<table>"
 *   contains null values
 *
 * Runs BEFORE TypeORM initializes (called from main.ts bootstrap and
 * mcp-server.ts boot). Connects via raw `pg` Client since the TypeORM
 * DataSource is not yet up.
 *
 * Postgres-only. Sqlite (local dev) lets the NULL through synchronize
 * without complaint; MySQL coerces NULL to '' on NOT NULL columns. The
 * blocker is specific to Postgres' strict NOT NULL enforcement during
 * ALTER … SET NOT NULL.
 *
 * Idempotent — re-running on a clean DB is a no-op. Safe to call on
 * every boot.
 *
 * Failure semantics — connection / SQL errors throw with a wrapped
 * message identifying this as the pre-sync step, so the bootstrap
 * stack surfaces "null-workspace cleanup failed: …" instead of a bare
 * pg error pointing nowhere obvious. The DELETE batch is wrapped in
 * a single transaction; any per-table failure rolls the whole batch
 * back so a partial cleanup never lands.
 */

import { Client } from 'pg';

/**
 * Tables whose entity declares `workspace_id NOT NULL` (i.e.
 * `@Column({ type: ... })` with no `nullable: true`, regardless of
 * whether a `default: ''` is present — defaults don't help if a prior
 * nullable schema window let NULL rows land). Source of truth:
 * apps/server/src/entities/*.ts. Update this list when adding a new
 * entity with a non-nullable workspace_id column.
 */
const TABLES_NOT_NULL_WORKSPACE: ReadonlyArray<string> = [
  'actions',            // Action
  'action_runs',        // ActionRun
  'agents',             // Agent           (default: '')
  'chat_rooms',         // ChatRoom
  'chat_room_messages', // ChatRoomMessage
  'credentials',        // Credential
  'prompt_templates',   // PromptTemplate  (default: '')
  'resources',          // Resource
  'subagents',          // Subagent
  'user_mentions',      // UserMention
  'workspace_roles',    // WorkspaceRole
];

/**
 * chat_rooms has dependent rows pinned by `room_id` on these tables.
 * Entities use plain FK columns (no ON DELETE CASCADE), so we cascade
 * by hand before deleting the parent room — otherwise we'd leave
 * orphan rows whose room_id points to a deleted parent.
 *
 * NOTE chat_room_participants has no workspace_id column at all
 * (entity defines room_id/participant_id only), so it never trips
 * the NULL blocker itself — it's listed here purely as a cascade
 * target so its rows don't outlive their parent room.
 */
const CHAT_ROOM_DEPENDENTS_BY_ROOM_ID: ReadonlyArray<string> = [
  'chat_room_messages',
  'chat_room_participants',
];

function logLine(msg: string): void {
  // Bootstrap-time logging — LogService is not constructed yet. console.log
  // matches the existing initDb logging style ("[DB] Connected using …").
  console.log(`[pre-sync] ${msg}`);
}

async function tableExists(client: Client, name: string): Promise<boolean> {
  const res = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name   = $1
     ) AS exists`,
    [name],
  );
  return res.rows[0]?.exists === true;
}

export async function cleanupNullWorkspaceRows(): Promise<void> {
  if ((process.env.DB_TYPE || 'sqlite') !== 'postgres') {
    return;
  }

  const client = new Client({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    user:     process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ai_workflow',
  });

  try {
    await client.connect();
  } catch (err: any) {
    throw new Error(
      `null-workspace cleanup: connect to Postgres failed: ${err?.message ?? err}`,
    );
  }

  try {
    await client.query('BEGIN');

    // 1. chat_rooms — cascade dependents by room_id, then delete the rooms.
    if (await tableExists(client, 'chat_rooms')) {
      const badRooms = await client.query<{ id: string }>(
        `SELECT id FROM chat_rooms WHERE workspace_id IS NULL`,
      );
      if (badRooms.rows.length > 0) {
        const roomIds = badRooms.rows.map((r) => r.id);
        for (const dep of CHAT_ROOM_DEPENDENTS_BY_ROOM_ID) {
          if (!(await tableExists(client, dep))) continue;
          const r = await client.query(
            `DELETE FROM ${dep} WHERE room_id = ANY($1::text[])`,
            [roomIds],
          );
          if (r.rowCount && r.rowCount > 0) {
            logLine(
              `${dep}: deleted ${r.rowCount} rows tied to ${roomIds.length} orphan rooms`,
            );
          }
        }
        const r = await client.query(
          `DELETE FROM chat_rooms WHERE workspace_id IS NULL`,
        );
        logLine(
          `chat_rooms: deleted ${r.rowCount ?? 0} orphan rooms with NULL workspace_id`,
        );
      }
    }

    // 2. All other tables — blanket DELETE WHERE workspace_id IS NULL.
    for (const table of TABLES_NOT_NULL_WORKSPACE) {
      if (table === 'chat_rooms') continue;
      if (!(await tableExists(client, table))) continue;
      const r = await client.query(
        `DELETE FROM ${table} WHERE workspace_id IS NULL`,
      );
      if (r.rowCount && r.rowCount > 0) {
        logLine(`${table}: deleted ${r.rowCount} rows with NULL workspace_id`);
      }
    }

    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(
      `null-workspace cleanup failed (rolled back): ${err?.message ?? err}. ` +
        `Fix the underlying DB state and retry; the cleanup is idempotent.`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}
