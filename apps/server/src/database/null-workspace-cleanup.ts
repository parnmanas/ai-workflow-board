/**
 * Defensive boot-time pre-sync for the workspace_id columns that keep
 * tripping TypeORM synchronize on Postgres. Two failure modes addressed:
 *
 *   (a) Column type mismatch — a previous pre-sync iteration widened
 *       varchar → uuid; the current entity declares varchar; TypeORM
 *       responds to the type diff with a column-rebuild that issues
 *       `ADD COLUMN … NOT NULL` against a table that already has rows.
 *       PG rejects that with:
 *         column "workspace_id" of relation "<table>" contains null values
 *       (the error names NULL because the freshly-added column is NULL
 *       on every existing row, not because the original column has NULLs).
 *
 *   (b) Lingering NULL rows — entity says NOT NULL but the live column
 *       allows NULL and has some, so the plain `SET NOT NULL` TypeORM
 *       wants to apply also fails with the same error message.
 *
 * Pre-sync handles both by aligning each target column back to varchar
 * (cast uuid → text is safe; uuids serialise as their canonical hex)
 * and deleting NULL rows before TypeORM ever sees the schema.
 *
 * Runs BEFORE TypeORM initializes (called from main.ts bootstrap and
 * mcp-server.ts boot). Connects via raw `pg` Client since the TypeORM
 * DataSource is not yet up.
 *
 * Postgres-only. Sqlite (local dev) doesn't enforce these constraints
 * the same way and never hits the blocker; mysql coerces NULL to ''.
 * Skipped when DB_TYPE != postgres.
 *
 * Idempotent — re-running on a clean DB is a no-op (every step
 * short-circuits when the live column already matches the target
 * shape and there are no NULL rows). Safe to call on every boot.
 *
 * Failure semantics — connection / SQL errors throw with a wrapped
 * message identifying this as the pre-sync step, so the bootstrap
 * stack surfaces "null-workspace pre-sync failed: …" instead of a bare
 * pg error pointing nowhere obvious. All work is wrapped in one
 * transaction; per-table failure rolls the whole batch back so a
 * partial pre-sync never lands.
 *
 * Always emits an entry + exit log line ("starting" / "done in Nms
 * type-aligned=X rows-deleted=Y") so an operator can confirm the
 * pre-sync ran without inferring from the absence of error logs.
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

/**
 * Cast `workspace_id` back to varchar if the live column is anything
 * else (uuid being the actual culprit; the deleted Phase-B pre-sync
 * widened these and the resurrection of the entities as varchar leaves
 * the type stale). Returns true if a cast was applied.
 *
 * Safe even when rows have legacy '' values (varchar already, no-op)
 * or uuids (cast `uuid::text` always works — uuids serialise to their
 * canonical hex string). No FK constraints on workspace_id columns in
 * this codebase (only `boards.workspace_id` has @ManyToOne, and that
 * table's column is nullable so it's outside this defensive scope).
 */
async function alignWorkspaceIdToVarchar(
  client: Client,
  table: string,
): Promise<boolean> {
  const res = await client.query<{ data_type: string }>(
    `SELECT data_type
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name   = $1
        AND column_name  = 'workspace_id'`,
    [table],
  );
  if (res.rows.length === 0) return false;
  const dataType = res.rows[0].data_type;
  // PG returns 'character varying' for @Column({ type: 'varchar' });
  // 'text' is functionally equivalent and TypeORM won't churn on it.
  if (dataType === 'character varying' || dataType === 'text') return false;

  await client.query(
    `ALTER TABLE ${table} ALTER COLUMN workspace_id TYPE varchar USING workspace_id::text`,
  );
  return true;
}

export async function cleanupNullWorkspaceRows(): Promise<void> {
  if ((process.env.DB_TYPE || 'sqlite') !== 'postgres') {
    return;
  }

  const startedAt = Date.now();
  logLine('starting pre-sync for workspace_id columns');

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
      `null-workspace pre-sync: connect to Postgres failed: ${err?.message ?? err}`,
    );
  }

  let typeAligned = 0;
  let rowsDeleted = 0;

  try {
    await client.query('BEGIN');

    // 0. Type alignment — bring every target column back to varchar so
    //    TypeORM's column-rebuild path doesn't fire. Must happen BEFORE
    //    NULL deletion so the subsequent SET NOT NULL TypeORM applies
    //    is a simple in-place change, not a rebuild.
    for (const table of TABLES_NOT_NULL_WORKSPACE) {
      if (!(await tableExists(client, table))) continue;
      const aligned = await alignWorkspaceIdToVarchar(client, table);
      if (aligned) {
        typeAligned++;
        logLine(`${table}: aligned workspace_id type → varchar`);
      }
    }

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
            rowsDeleted += r.rowCount;
            logLine(
              `${dep}: deleted ${r.rowCount} rows tied to ${roomIds.length} orphan rooms`,
            );
          }
        }
        const r = await client.query(
          `DELETE FROM chat_rooms WHERE workspace_id IS NULL`,
        );
        rowsDeleted += r.rowCount ?? 0;
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
        rowsDeleted += r.rowCount;
        logLine(`${table}: deleted ${r.rowCount} rows with NULL workspace_id`);
      }
    }

    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(
      `null-workspace pre-sync failed (rolled back): ${err?.message ?? err}. ` +
        `Fix the underlying DB state and retry; the pre-sync is idempotent.`,
    );
  } finally {
    await client.end().catch(() => {});
  }

  logLine(
    `done in ${Date.now() - startedAt}ms — type-aligned=${typeAligned}, rows-deleted=${rowsDeleted}`,
  );
}
