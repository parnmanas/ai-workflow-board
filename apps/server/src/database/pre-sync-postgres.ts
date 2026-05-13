/**
 * Pre-synchronize schema fixups for Postgres.
 *
 * Background — D-01 hardcodes `synchronize: true` on every driver, so the
 * runtime schema is generated from the entity decorators. When we widen a
 * column's TypeORM type — e.g. flipping a foreign-key-like column from
 * `varchar` to `uuid` so the JOIN against an actual uuid PK stops emitting
 * `operator does not exist: character varying = uuid` — TypeORM's PG driver
 * issues an `ALTER TABLE … ALTER COLUMN … TYPE uuid` without a USING clause,
 * which Postgres rejects (there's no implicit cast from text → uuid even
 * when every row is a perfectly valid uuid string). Synchronize crashes, and
 * because D-02 runs migrations AFTER synchronize, a regular data migration
 * can't paper over it either.
 *
 * Solution — for those handful of columns we know we want to widen, run the
 * `ALTER … USING col::uuid` ourselves in raw SQL BEFORE the Nest app boots
 * and TypeORM initializes its DataSource. Once the live column type matches
 * the entity, synchronize sees no diff and skips the broken auto-ALTER.
 *
 * Idempotent: walks `information_schema.columns` first and skips any column
 * already typed `uuid`. Safe to re-invoke on every boot, no-ops on a
 * fresh DB where synchronize will create the column as uuid directly, and
 * skips entirely when DB_TYPE is anything other than `postgres` (sqlite /
 * mysql don't have the operator-mismatch problem — sqlite stores everything
 * as TEXT, mysql does implicit type coercion on equality).
 *
 * Failure mode — if a target column contains a value that isn't a valid uuid
 * (e.g. literal `'system'`, an empty string, or a leftover slug from
 * pre-migration code), we abort with a loud error listing the offending
 * table.column and the bad-row count. Operator must clean the data
 * manually (UPDATE … SET col = NULL WHERE col = ''; etc.) before
 * redeploying. This keeps a half-migrated DB from going live.
 *
 * Scope — Phase A of the v0.42 uuid-typing unification, addressing the
 * trigger-failed bug (`getWorkflowLoadTicketIds` join against ra.ticket_id
 * = t.id). Phase B will scrub the larger cluster of `''`-defaulted FK-like
 * columns (Ticket.assignee_id / reporter_id / reviewer_id /
 * base_repo_resource_id / created_by_id, Agent.workspace_id, Comment.
 * author_id, …) in a separate change.
 */

import { Client } from 'pg';

/**
 * Columns the entity decorator now declares as `uuid` but Postgres may
 * still have as `character varying` from before the change. Each one is
 * exhaustively populated by code paths that already insert valid uuids
 * (FK-like references to a `@PrimaryGeneratedColumn('uuid')` PK on another
 * table), so the `::uuid` cast in the USING clause is expected to succeed
 * on every row. The detection step below is a defensive gate, not a hot
 * path.
 *
 * `nullableEmptyToNull` controls the optional pre-step that converts
 * empty-string sentinels to NULL before the type alter. The four columns
 * in Phase A don't have `''` defaults, but defensive coercion is cheap.
 */
const COLUMNS_TO_UUID: ReadonlyArray<{
  table: string;
  column: string;
  /**
   * If true, before the ALTER we run `UPDATE … SET col = NULL WHERE col = ''`.
   * Only meaningful for nullable columns. NOT NULL columns with `''` rows
   * have no safe automated fix — those land in the abort path below.
   */
  nullableEmptyToNull: boolean;
}> = [
  // Fix for: getWorkflowLoadTicketIds JOIN (ra.ticket_id = t.id) — and the
  // same pattern in allocation.service.ts and ticket-crud-tools.ts (col.id
  // = t.column_id, b.id = col.board_id).
  { table: 'ticket_role_assignments', column: 'ticket_id', nullableEmptyToNull: false },
  { table: 'ticket_role_assignments', column: 'role_id',   nullableEmptyToNull: false },
  { table: 'tickets',                 column: 'column_id', nullableEmptyToNull: true  },
  { table: 'columns',                 column: 'board_id',  nullableEmptyToNull: false },
];

/**
 * Strict uuid pattern (lowercase or uppercase, with hyphens, version
 * digit unconstrained). Matches the canonical 8-4-4-4-12 hex layout that
 * `gen_random_uuid()` / `uuid_generate_v4()` produce. Anything else (slug,
 * empty string, literal sentinel) flunks and triggers the abort path.
 */
const UUID_REGEX = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export async function preSyncPostgres(): Promise<void> {
  const dbType = (process.env.DB_TYPE || 'sqlite').toLowerCase();
  if (dbType !== 'postgres') return;

  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ai_workflow',
  });
  await client.connect();
  try {
    for (const target of COLUMNS_TO_UUID) {
      await alterColumnToUuid(client, target);
    }
  } finally {
    await client.end();
  }
}

async function alterColumnToUuid(
  client: Client,
  target: { table: string; column: string; nullableEmptyToNull: boolean },
): Promise<void> {
  const { table, column, nullableEmptyToNull } = target;

  // Is the table here at all? On a brand-new DB the entity hasn't been
  // synced yet — synchronize will create it as uuid directly, no pre-fix
  // needed.
  const colInfo = await client.query<{ data_type: string; is_nullable: string }>(
    `SELECT data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  if (colInfo.rows.length === 0) return;

  const currentType = colInfo.rows[0].data_type;
  if (currentType === 'uuid') return; // already migrated

  // Optional empty-string → NULL pass for nullable columns. Skip for NOT
  // NULL columns; any `''` there is a code bug that needs operator
  // attention, and we'd fail loudly in the validity check below anyway.
  if (nullableEmptyToNull) {
    await client.query(
      `UPDATE "${table}" SET "${column}" = NULL WHERE "${column}" = ''`,
    );
  }

  // Detect rows that won't survive the `::uuid` cast. Catches both empty
  // strings on NOT NULL columns AND any leftover non-uuid sentinel (e.g.
  // a stray slug or 'system' literal). We surface the count and first few
  // bad values so the operator can act on them.
  const bad = await client.query<{ value: string; rows: string }>(
    `SELECT "${column}" AS value, COUNT(*)::text AS rows
       FROM "${table}"
      WHERE "${column}" IS NOT NULL
        AND "${column}" !~ '${UUID_REGEX}'
      GROUP BY "${column}"
      ORDER BY COUNT(*) DESC
      LIMIT 5`,
  );
  if (bad.rows.length > 0) {
    const sample = bad.rows
      .map((r) => `  ${JSON.stringify(r.value)} × ${r.rows}`)
      .join('\n');
    throw new Error(
      `[pre-sync-postgres] Cannot convert ${table}.${column} (${currentType}) → uuid: ` +
        `${bad.rows.length}+ distinct non-uuid value(s) present. Sample:\n${sample}\n` +
        `Clean these rows (UPDATE / DELETE) before redeploying.`,
    );
  }

  // Safe to cast. The USING clause is what synchronize fails to emit.
  // SET DEFAULT NULL also strips any leftover `''` default that would
  // otherwise re-fail the implicit type check.
  // eslint-disable-next-line no-console
  console.log(
    `[pre-sync-postgres] ALTER ${table}.${column} (${currentType} → uuid)`,
  );
  await client.query(
    `ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP DEFAULT`,
  );
  await client.query(
    `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE uuid USING "${column}"::uuid`,
  );
}
