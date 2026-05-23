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
 * Before the cast we drop every FK constraint in the schema. Without
 * this, PG aborts the ALTER with "foreign key constraint <name> cannot
 * be implemented" whenever the referenced column type doesn't match
 * the new type (e.g., `agents.workspace_id` cast to varchar while
 * `workspaces.id` stays uuid). The drop is bounded to this transaction
 * — TypeORM's synchronize re-creates declared FKs from @ManyToOne
 * decorators immediately after, and FKs that existed in the DB without
 * an entity-level declaration are cruft from a previous schema state
 * and don't need to come back.
 *
 * Special case: columns that participate in an `@ManyToOne` to a uuid
 * PK MUST stay uuid even though the @Column declaration says varchar
 * — TypeORM's PG driver responds to the FK-target type by trying to
 * rebuild the column with the matching type, which triggers the same
 * `ADD COLUMN … NOT NULL contains null values` blocker. The 8 known
 * columns (see MANY_TO_ONE_FK_COLUMNS) are skipped by the generic
 * varchar cast and forcibly re-aligned to uuid afterward, cleaning up
 * any '' / non-uuid values along the way (nullable → set NULL, not
 * nullable → delete the row).
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
 *   [pre-sync] dropped N FK constraints (TypeORM will recreate)
 *   [pre-sync] <table>.<col>: cast uuid → varchar
 *   [pre-sync] <table>.<col>: deleted N NULL rows
 *   [pre-sync] done in <ms>ms (fk-dropped=F, uuid-cast=U, rows-deleted=R)
 */

import { Client } from 'pg';

/**
 * The 8 columns that have an @ManyToOne to a uuid-PK entity (source:
 * grep `@ManyToOne` across entities + checking referencedColumnName).
 * TypeORM's PG driver expects these to be uuid even though the
 * @Column declaration says varchar — the FK type-match drives column
 * type, not the @Column override. Casting these to varchar (which
 * the generic uuid → varchar pass would otherwise do) breaks the
 * symmetry and TypeORM tries to rebuild the column to uuid, hitting
 * the ADD COLUMN NOT NULL blocker.
 *
 * Excluded from the generic varchar cast and re-aligned to uuid in
 * a dedicated pass below. SubagentLogLine.subagent_id has @ManyToOne
 * but references Subagent.subagent_id (varchar) — NOT a uuid PK —
 * so it stays out of this list and gets cast to varchar normally.
 */
interface ManyToOneFkColumn {
  table: string;
  column: string;
  /** false = entity declares NOT NULL (no `nullable: true`). Drives
   *  '' / invalid-uuid cleanup: nullable → SET NULL, NOT NULL → DELETE
   *  the row (orphan by definition). */
  nullable: boolean;
}

const MANY_TO_ONE_FK_COLUMNS: ReadonlyArray<ManyToOneFkColumn> = [
  { table: 'api_keys',               column: 'agent_id',     nullable: true  },
  { table: 'boards',                 column: 'workspace_id', nullable: true  },
  { table: 'chat_room_participants', column: 'room_id',      nullable: false },
  { table: 'columns',                column: 'board_id',     nullable: false },
  { table: 'comments',               column: 'ticket_id',    nullable: false },
  { table: 'ticket_attachments',     column: 'ticket_id',    nullable: false },
  { table: 'tickets',                column: 'column_id',    nullable: true  },
  { table: 'tickets',                column: 'parent_id',    nullable: true  },
];

const KEEP_AS_UUID: ReadonlySet<string> = new Set(
  MANY_TO_ONE_FK_COLUMNS.map((c) => `${c.table}.${c.column}`),
);

/** Canonical 8-4-4-4-12 hex uuid layout (case-insensitive). Values
 *  failing this regex can't be cast to uuid and must be scrubbed. */
const UUID_REGEX = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

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
 * Drop every FOREIGN KEY constraint in the current schema. Run before
 * the uuid → varchar cast pass so PG doesn't reject ALTER COLUMN TYPE
 * with "foreign key constraint <name> cannot be implemented" whenever
 * the cast leaves referrer and referenced column types out of sync.
 *
 * Bounded to this transaction. TypeORM synchronize re-creates declared
 * FKs from @ManyToOne decorators right after pre-sync returns; FKs
 * that existed in the DB without an entity-level @ManyToOne are
 * leftovers from a previous schema generation and don't need to come
 * back. Returns the count of constraints dropped for the exit log.
 */
async function dropAllForeignKeys(client: Client): Promise<number> {
  const res = await client.query<{ table_name: string; constraint_name: string }>(
    `SELECT tc.table_name, tc.constraint_name
       FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema    = current_schema()
      ORDER BY tc.table_name, tc.constraint_name`,
  );
  for (const { table_name, constraint_name } of res.rows) {
    // IF EXISTS guards against concurrent drops (defensive — should be
    // impossible inside our own transaction but cheap to be safe).
    // Constraint name is quoted because TypeORM's auto-names are mixed
    // case and would otherwise be lower-cased by PG identifier folding.
    await client.query(
      `ALTER TABLE ${table_name} DROP CONSTRAINT IF EXISTS "${constraint_name}"`,
    );
  }
  return res.rows.length;
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

  let castCount = 0;
  for (const { table_name, column_name } of res.rows) {
    if (KEEP_AS_UUID.has(`${table_name}.${column_name}`)) {
      // ManyToOne FK to uuid PK — must stay uuid (handled by
      // alignManyToOneFkColumnsToUuid below).
      continue;
    }
    await client.query(
      `ALTER TABLE ${table_name} ALTER COLUMN ${column_name} TYPE varchar USING ${column_name}::text`,
    );
    logLine(`${table_name}.${column_name}: cast uuid → varchar`);
    castCount++;
  }
  return castCount;
}

/**
 * Force each @ManyToOne FK column to uuid type, scrubbing '' /
 * non-uuid values along the way. Idempotent: skips columns already
 * at uuid type.
 *
 * Order is important — this runs AFTER castNonPkUuidColumnsToVarchar
 * because the generic cast may have left these columns as varchar in
 * an earlier pre-sync iteration; this pass recovers them. On a fresh
 * DB they're already uuid and the function is a no-op.
 *
 * Cleanup rules:
 *   nullable column → UPDATE SET col = NULL WHERE col is non-uuid
 *   NOT NULL column → DELETE WHERE col IS NULL OR col is non-uuid
 *                     (an orphan row by definition; the entity
 *                     guarantees the FK target exists)
 */
async function alignManyToOneFkColumnsToUuid(client: Client): Promise<number> {
  let alignedCount = 0;
  for (const spec of MANY_TO_ONE_FK_COLUMNS) {
    if (!(await tableExists(client, spec.table))) continue;

    const colInfo = await client.query<{ data_type: string }>(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name   = $1
          AND column_name  = $2`,
      [spec.table, spec.column],
    );
    if (colInfo.rows.length === 0) continue;
    if (colInfo.rows[0].data_type === 'uuid') continue; // already aligned

    if (spec.nullable) {
      const u = await client.query(
        `UPDATE ${spec.table}
            SET ${spec.column} = NULL
          WHERE ${spec.column} IS NOT NULL
            AND ${spec.column} !~ $1`,
        [UUID_REGEX],
      );
      if (u.rowCount && u.rowCount > 0) {
        logLine(
          `${spec.table}.${spec.column}: scrubbed ${u.rowCount} non-uuid values → NULL`,
        );
      }
    } else {
      const d = await client.query(
        `DELETE FROM ${spec.table}
          WHERE ${spec.column} IS NULL
             OR ${spec.column} !~ $1`,
        [UUID_REGEX],
      );
      if (d.rowCount && d.rowCount > 0) {
        logLine(
          `${spec.table}.${spec.column}: deleted ${d.rowCount} rows with NULL / non-uuid`,
        );
      }
    }

    await client.query(
      `ALTER TABLE ${spec.table} ALTER COLUMN ${spec.column} TYPE uuid USING ${spec.column}::uuid`,
    );
    logLine(`${spec.table}.${spec.column}: aligned → uuid (ManyToOne FK)`);
    alignedCount++;
  }
  return alignedCount;
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

  let fksDropped = 0;
  let uuidCast = 0;
  let uuidAligned = 0;
  let rowsDeleted = 0;

  try {
    await client.query('BEGIN');

    // 1. Drop every FK constraint first. PG rejects ALTER COLUMN TYPE
    //    with "foreign key constraint <name> cannot be implemented"
    //    whenever the cast would leave referrer/referenced types out
    //    of sync (e.g., agents.workspace_id varchar vs workspaces.id
    //    uuid). TypeORM synchronize re-creates declared FKs from
    //    @ManyToOne decorators immediately after this returns.
    fksDropped = await dropAllForeignKeys(client);
    if (fksDropped > 0) {
      logLine(`dropped ${fksDropped} FK constraints (TypeORM will recreate)`);
    }

    // 2. Generic uuid → varchar realignment for every non-PK uuid column,
    //    EXCEPT the 8 ManyToOne FK columns that must stay uuid.
    uuidCast = await castNonPkUuidColumnsToVarchar(client);

    // 3. Re-align the 8 ManyToOne FK columns back to uuid if a previous
    //    pre-sync iteration cast them to varchar. Scrubs '' / non-uuid
    //    values so the ALTER … TYPE uuid cast succeeds.
    uuidAligned = await alignManyToOneFkColumnsToUuid(client);

    // 4. NULL-row cleanup on the curated NOT-NULL column list.
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
    `done in ${Date.now() - startedAt}ms (fk-dropped=${fksDropped}, uuid-cast=${uuidCast}, uuid-aligned=${uuidAligned}, rows-deleted=${rowsDeleted})`,
  );
}
