/**
 * Defensive boot-time pre-sync for Postgres deploys.
 *
 * Two failure modes addressed, both surface as the same misleading
 * TypeORM error:
 *
 *   QueryFailedError: column "<col>" of relation "<table>" contains
 *   null values
 *
 *   (a) Column type mismatch — a previous pre-sync iteration widened
 *       many FK-like columns from varchar → uuid; the current entities
 *       declare varchar; TypeORM responds to the type diff with a
 *       column-rebuild path that issues `ADD COLUMN … NOT NULL` against
 *       a non-empty table. PG names "null values" in the error even
 *       though the NULLs are in the freshly-added rebuild column, not
 *       the original — the message is a red herring.
 *
 *   (b) Lingering NULL rows — entity declares the column NOT NULL but
 *       the live column allows NULL and has some, so the plain
 *       `SET NOT NULL` TypeORM wants to apply also fails with the same
 *       error message (this time naming a real NULL).
 *
 * Pre-sync handles both. (a) is fixed generically by walking every
 * non-PK uuid column in the live schema and casting it back to varchar
 * — the canonical column shape per project convention is varchar; only
 * `@PrimaryGeneratedColumn('uuid')` produces a legitimate uuid column
 * and we exclude PKs from the rewrite. No entity uses `@Column({
 * type: 'uuid' })` directly, so the auto-discovery is safe.
 *
 * (b) is fixed by deleting NULL rows on a curated list of NOT-NULL
 * FK-like columns. The list is hardcoded because TypeORM metadata
 * isn't loaded yet at this boot stage; source of truth is the entity
 * decorators (any `@Column({ type: 'varchar' })` without `nullable:
 * true` qualifies). New entities with NOT-NULL FK columns must be
 * added here.
 *
 * Runs BEFORE TypeORM initializes (called from main.ts bootstrap and
 * mcp-server.ts boot). Connects via raw `pg` Client since the TypeORM
 * DataSource is not yet up.
 *
 * Postgres-only. Sqlite (local dev) doesn't enforce these constraints
 * the same way and never hits the blocker; mysql coerces NULL to ''.
 * Skipped when DB_TYPE != postgres.
 *
 * Idempotent — re-running on a clean DB is a no-op (cast skipped when
 * column already varchar; DELETE no-op when no NULL rows). Safe to
 * call on every boot.
 *
 * Failure semantics — connection / SQL errors throw with a wrapped
 * message identifying this as the pre-sync step, so the bootstrap
 * stack surfaces "pre-sync failed: …" instead of a bare pg error
 * pointing nowhere obvious. All work is wrapped in one transaction;
 * any per-step failure rolls the whole batch back so a partial
 * pre-sync never lands.
 *
 * Always emits an entry + exit log line so an operator can confirm
 * execution from the boot log:
 *   [pre-sync] starting
 *   [pre-sync] <table>.<col>: cast uuid → varchar
 *   [pre-sync] <table>.<col>: deleted N NULL rows
 *   [pre-sync] done in <ms>ms (uuid-cast=X, rows-deleted=Y)
 */

import { Client } from 'pg';

/**
 * Curated list of NOT-NULL FK-like columns (entity declares
 * `@Column({ type: 'varchar' })` without `nullable: true`). Used for
 * the NULL-row cleanup pass — TypeORM's `SET NOT NULL` will fail if
 * the live column still has NULL rows. Source of truth:
 * apps/server/src/entities/*.ts. Add new entries when introducing
 * non-nullable FK columns.
 *
 * Optional `dependentBy` triggers a cascade pass: rows on each named
 * dependent table whose `<column>` matches a soon-to-be-deleted parent
 * are deleted first so plain FK columns (no ON DELETE CASCADE on the
 * DB side) don't leave orphans pointing at a deleted row.
 */
interface NotNullColumn {
  table: string;
  column: string;
  dependentBy?: ReadonlyArray<{ table: string; column: string }>;
}

const NOT_NULL_COLUMNS: ReadonlyArray<NotNullColumn> = [
  // ── workspace_id columns (entity declares NOT NULL) ──
  { table: 'actions',                column: 'workspace_id' },
  { table: 'action_runs',            column: 'workspace_id' },
  { table: 'agents',                 column: 'workspace_id' },
  {
    table: 'chat_rooms',
    column: 'workspace_id',
    dependentBy: [
      { table: 'chat_room_messages',     column: 'room_id' },
      { table: 'chat_room_participants', column: 'room_id' },
    ],
  },
  { table: 'chat_room_messages',     column: 'workspace_id' },
  { table: 'credentials',            column: 'workspace_id' },
  { table: 'prompt_templates',       column: 'workspace_id' },
  { table: 'resources',              column: 'workspace_id' },
  { table: 'subagents',              column: 'workspace_id' },
  { table: 'user_mentions',          column: 'workspace_id' },
  { table: 'workspace_roles',        column: 'workspace_id' },

  // ── Other NOT-NULL FK columns ──
  { table: 'actions',                column: 'target_agent_id' },
  { table: 'action_runs',            column: 'action_id' },
  { table: 'action_runs',            column: 'room_id' },
  { table: 'agent_error_logs',       column: 'agent_id' },
  { table: 'chat_room_messages',     column: 'room_id' },
  { table: 'chat_room_messages',     column: 'sender_id' },
  { table: 'chat_room_participants', column: 'participant_id' },
  { table: 'chat_room_participants', column: 'room_id' },
  { table: 'columns',                column: 'board_id' },
  { table: 'comments',               column: 'ticket_id' },
  { table: 'resource_embeddings',    column: 'resource_id' },
  { table: 'subagents',              column: 'agent_id' },
  { table: 'ticket_attachments',     column: 'ticket_id' },
  { table: 'ticket_read_state',      column: 'ticket_id' },
  { table: 'ticket_read_state',      column: 'user_id' },
  { table: 'ticket_role_assignments', column: 'ticket_id' },
  { table: 'ticket_role_assignments', column: 'role_id' },
  { table: 'user_channels',          column: 'user_id' },
  { table: 'user_mentions',          column: 'user_id' },
  { table: 'user_mentions',          column: 'source_id' },
  { table: 'user_mentions',          column: 'actor_id' },
];

function logLine(msg: string): void {
  // Bootstrap-time logging — LogService not constructed yet. console.log
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
 * Walk every column in the current schema whose data_type is uuid and
 * which is NOT part of a PRIMARY KEY constraint, then cast each to
 * varchar. The cast `<col>::text` is always safe — uuids serialise to
 * their canonical hex form.
 *
 * Generic over the table set so adding new uuid-widened columns later
 * doesn't require a code change here. Returns the count of columns
 * cast so the exit log can report progress.
 */
async function castNonPkUuidColumnsToVarchar(client: Client): Promise<number> {
  const res = await client.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
      WHERE c.table_schema = current_schema()
        AND c.data_type    = 'uuid'
        AND NOT EXISTS (
          SELECT 1
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage  kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema    = kcu.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND tc.table_schema    = c.table_schema
             AND tc.table_name      = c.table_name
             AND kcu.column_name    = c.column_name
        )
      ORDER BY c.table_name, c.column_name`,
  );

  for (const { table_name, column_name } of res.rows) {
    await client.query(
      `ALTER TABLE ${table_name} ALTER COLUMN ${column_name} TYPE varchar USING ${column_name}::text`,
    );
    logLine(`${table_name}.${column_name}: cast uuid → varchar`);
  }
  return res.rows.length;
}

export async function preSyncPostgres(): Promise<void> {
  if ((process.env.DB_TYPE || 'sqlite') !== 'postgres') {
    return;
  }

  const startedAt = Date.now();
  logLine('starting');

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
      `pre-sync: connect to Postgres failed: ${err?.message ?? err}`,
    );
  }

  let uuidCast = 0;
  let rowsDeleted = 0;

  try {
    await client.query('BEGIN');

    // 1. Generic uuid → varchar realignment for every non-PK uuid column.
    //    Stops TypeORM's column-rebuild path from firing on the type diff.
    uuidCast = await castNonPkUuidColumnsToVarchar(client);

    // 2. NULL-row cleanup on the curated NOT-NULL column list.
    //    Stops TypeORM's `SET NOT NULL` from failing on legacy NULL rows.
    //    Tables with `dependentBy` cascade first so deleting the parent
    //    doesn't leave dependent rows pointing at a deleted row.
    for (const spec of NOT_NULL_COLUMNS) {
      if (!(await tableExists(client, spec.table))) continue;

      if (spec.dependentBy && spec.dependentBy.length > 0) {
        // Resolve parent IDs to delete, cascade to dependents, then delete parents.
        const badRows = await client.query<{ id: string }>(
          `SELECT id FROM ${spec.table} WHERE ${spec.column} IS NULL`,
        );
        if (badRows.rows.length > 0) {
          const ids = badRows.rows.map((r) => r.id);
          for (const dep of spec.dependentBy) {
            if (!(await tableExists(client, dep.table))) continue;
            const r = await client.query(
              `DELETE FROM ${dep.table} WHERE ${dep.column} = ANY($1::text[])`,
              [ids],
            );
            if (r.rowCount && r.rowCount > 0) {
              rowsDeleted += r.rowCount;
              logLine(
                `${dep.table}: deleted ${r.rowCount} rows tied to ${ids.length} orphan ${spec.table}`,
              );
            }
          }
        }
      }

      const r = await client.query(
        `DELETE FROM ${spec.table} WHERE ${spec.column} IS NULL`,
      );
      if (r.rowCount && r.rowCount > 0) {
        rowsDeleted += r.rowCount;
        logLine(
          `${spec.table}.${spec.column}: deleted ${r.rowCount} rows with NULL`,
        );
      }
    }

    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(
      `pre-sync failed (rolled back): ${err?.message ?? err}. ` +
        `Fix the underlying DB state and retry; the pre-sync is idempotent.`,
    );
  } finally {
    await client.end().catch(() => {});
  }

  logLine(
    `done in ${Date.now() - startedAt}ms (uuid-cast=${uuidCast}, rows-deleted=${rowsDeleted})`,
  );
}
