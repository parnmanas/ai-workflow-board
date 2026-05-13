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
 * Solution — for every column we want widened, run the ALTER ourselves in
 * raw SQL BEFORE the Nest app boots and TypeORM initializes its DataSource.
 * Once the live column type matches the entity, synchronize sees no diff and
 * skips the broken auto-ALTER.
 *
 * Each conversion runs in four steps:
 *   1. (if `nullable: true`) DROP NOT NULL — the entity now allows NULL, so
 *      legacy NOT NULL constraints from `default: ''` v1 columns must come
 *      off before we can scrub.
 *   2. (if `nullable: true`) UPDATE col = NULL WHERE col = '' — converts the
 *      empty-string sentinel to the proper SQL NULL. After Phase B every
 *      FK-like column treats absence as NULL, never ''.
 *   3. DROP DEFAULT — any v1 `default: ''` would otherwise re-fail the
 *      uuid cast on the next INSERT.
 *   4. ALTER … TYPE uuid USING col::uuid — the cast PG refuses to insert
 *      implicitly. The remaining values are pre-validated against the uuid
 *      regex so this never fails on dirty data; if a non-uuid sentinel
 *      (e.g. `'system'` or a stray slug) is present, the function aborts
 *      with a diagnostic listing the bad rows so the operator can decide
 *      whether to scrub or back out the deploy.
 *
 * Idempotent — every step short-circuits when the live column already matches
 * the target shape, so this is safe to re-invoke on every boot (no-op on a
 * fresh DB where synchronize will create the columns as uuid directly, no-op
 * on a previously-migrated DB). Skipped entirely when DB_TYPE is anything
 * other than `postgres` — sqlite stores everything as TEXT and never trips
 * the operator-mismatch problem; mysql does implicit type coercion on
 * equality so the same JOINs work without a type change.
 *
 * Scope — completes the v0.42 uuid-typing unification. Phase A landed the
 * four columns blocking the trigger-failed bug
 * (`getWorkflowLoadTicketIds` JOIN against `ra.ticket_id = t.id`). Phase B
 * extends to every FK-like column referencing a `@PrimaryGeneratedColumn(
 * 'uuid')` PK that the v1 schema declared as varchar. Columns intentionally
 * left as varchar (kept here for the record):
 *   - activity_logs.actor_id — `'system'` sentinel written by automation
 *   - activity_logs.entity_id — polymorphic, may key on slug in future
 *   - activity_logs.ticket_id — `''` for non-ticket activity rows
 *   - relation_tuples.{subject,object}_id — polymorphic ReBAC tuples
 *   - subagents.subagent_id (PK) — plugin-generated UUID stored as
 *     varchar by convention; widening would require touching
 *     subagent_log_lines.subagent_id (FK) in lockstep and there's no
 *     current JOIN that hits the PG operator path.
 *   - system_settings.key, workspace_roles.slug, workspaces.slug,
 *     users.discord_user_id, api_keys.key, channels.{bot_token,channel_id},
 *     user_channels.target, comments.{status,type,attachment_resource_ids},
 *     subagents.{label,role,ticket_title,session_key,signal} — non-uuid.
 */

import { Client } from 'pg';

/**
 * Strict uuid pattern (lowercase or uppercase, with hyphens, version
 * digit unconstrained). Matches the canonical 8-4-4-4-12 hex layout that
 * `gen_random_uuid()` / `uuid_generate_v4()` produce. Anything else (slug,
 * empty string, literal sentinel) flunks and triggers the abort path.
 */
const UUID_REGEX = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

interface ColumnTarget {
  table: string;
  column: string;
  /**
   * True when the entity declares `nullable: true`. Drives the DROP NOT NULL
   * + UPDATE '' → NULL pre-passes. False keeps the existing NOT NULL
   * constraint — used for columns where the entity always supplies a uuid
   * (e.g. `chat_rooms.workspace_id`, `action_runs.action_id`) and any '' in
   * production is a data bug that should surface as a loud abort, not be
   * silently nulled.
   */
  nullable: boolean;
}

/**
 * Every column the v0.42 uuid-typing unification widens. Ordered roughly by
 * entity to make audits easier, not by topology — column ALTERs are
 * independent of FK ordering in PG (the constraint is on values, not on
 * types matching exactly, and uuid::varchar comparison still passes through
 * the implicit text cast on the catalogue side).
 */
const COLUMNS_TO_UUID: ReadonlyArray<ColumnTarget> = [
  // ───── Phase A (kept here for idempotent re-runs) ─────
  { table: 'ticket_role_assignments', column: 'ticket_id', nullable: false },
  { table: 'ticket_role_assignments', column: 'role_id',   nullable: false },
  { table: 'tickets',                 column: 'column_id', nullable: true  },
  { table: 'columns',                 column: 'board_id',  nullable: false },

  // ───── Phase B: workspace_id columns ─────
  { table: 'tickets',              column: 'workspace_id', nullable: true },
  { table: 'comments',             column: 'workspace_id', nullable: true },
  { table: 'activity_logs',        column: 'workspace_id', nullable: true },
  { table: 'ticket_attachments',   column: 'workspace_id', nullable: true },
  { table: 'api_keys',             column: 'workspace_id', nullable: true },
  { table: 'ticket_read_state',    column: 'workspace_id', nullable: true },
  { table: 'columns',              column: 'workspace_id', nullable: true },
  { table: 'channels',             column: 'workspace_id', nullable: true },
  { table: 'agent_error_logs',     column: 'workspace_id', nullable: true },
  { table: 'boards',               column: 'workspace_id', nullable: true },
  { table: 'agents',               column: 'workspace_id', nullable: true },
  { table: 'prompt_templates',     column: 'workspace_id', nullable: true },
  { table: 'workspace_roles',      column: 'workspace_id', nullable: false },
  { table: 'chat_rooms',           column: 'workspace_id', nullable: false },
  { table: 'chat_room_messages',   column: 'workspace_id', nullable: false },
  { table: 'user_mentions',        column: 'workspace_id', nullable: false },
  { table: 'credentials',          column: 'workspace_id', nullable: false },
  { table: 'resources',            column: 'workspace_id', nullable: false },
  { table: 'actions',              column: 'workspace_id', nullable: false },
  { table: 'action_runs',          column: 'workspace_id', nullable: false },
  { table: 'subagents',            column: 'workspace_id', nullable: false },

  // ───── Phase B: ticket / column / board FK columns ─────
  { table: 'comments',           column: 'ticket_id',     nullable: false },
  { table: 'ticket_attachments', column: 'ticket_id',     nullable: false },
  { table: 'ticket_read_state',  column: 'ticket_id',     nullable: false },
  { table: 'tickets',            column: 'parent_id',     nullable: true  },
  { table: 'tickets',            column: 'next_ticket_id', nullable: true },
  { table: 'comments',           column: 'parent_id',     nullable: true  },
  { table: 'chat_rooms',         column: 'ticket_id',     nullable: true  },
  { table: 'user_mentions',      column: 'ticket_id',     nullable: true  },
  { table: 'subagents',          column: 'ticket_id',     nullable: true  },
  { table: 'actions',            column: 'board_id',      nullable: true  },

  // ───── Phase B: user / agent / resource / credential FK columns ─────
  { table: 'tickets',                 column: 'assignee_id',           nullable: true  },
  { table: 'tickets',                 column: 'reporter_id',           nullable: true  },
  { table: 'tickets',                 column: 'reviewer_id',           nullable: true  },
  { table: 'tickets',                 column: 'locked_by_agent_id',    nullable: true  },
  { table: 'tickets',                 column: 'base_repo_resource_id', nullable: true  },
  { table: 'tickets',                 column: 'created_by_id',         nullable: true  },
  { table: 'comments',                column: 'author_id',             nullable: true  },
  { table: 'ticket_attachments',      column: 'uploaded_by_id',        nullable: true  },
  { table: 'ticket_read_state',       column: 'user_id',               nullable: false },
  { table: 'users',                   column: 'requested_workspace_id', nullable: true },
  { table: 'user_channels',           column: 'user_id',               nullable: false },
  { table: 'user_mentions',           column: 'user_id',               nullable: false },
  { table: 'user_mentions',           column: 'source_id',             nullable: false },
  { table: 'user_mentions',           column: 'actor_id',              nullable: false },
  { table: 'user_mentions',           column: 'room_id',               nullable: true  },
  { table: 'ticket_role_assignments', column: 'agent_id',              nullable: true  },
  { table: 'ticket_role_assignments', column: 'user_id',               nullable: true  },
  { table: 'agents',                  column: 'parent_agent_id',       nullable: true  },
  { table: 'agents',                  column: 'manager_agent_id',      nullable: true  },
  { table: 'agents',                  column: 'credential_id',         nullable: true  },
  { table: 'api_keys',                column: 'agent_id',              nullable: true  },
  { table: 'resources',               column: 'board_id',              nullable: true  },
  { table: 'resources',               column: 'credential_id',         nullable: true  },
  { table: 'resource_embeddings',     column: 'resource_id',           nullable: false },
  { table: 'subagents',               column: 'agent_id',              nullable: false },
  { table: 'agent_error_logs',        column: 'agent_id',              nullable: false },
  { table: 'chat_rooms',              column: 'action_id',             nullable: true  },
  { table: 'chat_room_participants',  column: 'room_id',               nullable: false },
  { table: 'chat_room_participants',  column: 'participant_id',        nullable: false },
  { table: 'chat_room_messages',      column: 'room_id',               nullable: false },
  { table: 'chat_room_messages',      column: 'sender_id',             nullable: false },
  { table: 'actions',                 column: 'target_agent_id',       nullable: false },
  { table: 'action_runs',             column: 'action_id',             nullable: false },
  { table: 'action_runs',             column: 'room_id',               nullable: false },
  { table: 'action_runs',             column: 'triggered_by_id',       nullable: true  },
];

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
  target: ColumnTarget,
): Promise<void> {
  const { table, column, nullable } = target;

  // On a brand-new DB the table hasn't been synced yet — synchronize will
  // create it as uuid directly, no pre-fix needed.
  const colInfo = await client.query<{ data_type: string; is_nullable: string }>(
    `SELECT data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  if (colInfo.rows.length === 0) return;

  const currentType = colInfo.rows[0].data_type;
  const currentlyNullable = colInfo.rows[0].is_nullable === 'YES';
  if (currentType === 'uuid') return; // already migrated

  // Step 1: drop NOT NULL when the entity now permits NULL. Synchronize would
  // do this after pre-sync, but we need it now so the '' → NULL scrub in step
  // 2 doesn't violate the constraint.
  if (nullable && !currentlyNullable) {
    await client.query(
      `ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP NOT NULL`,
    );
  }

  // Step 2: empty-string → NULL pass for nullable columns. Skipped on
  // NOT-NULL columns because we can't legally NULL a value there; any '' on
  // a NOT NULL column is a code bug and will surface in the abort path
  // below.
  if (nullable) {
    await client.query(
      `UPDATE "${table}" SET "${column}" = NULL WHERE "${column}" = ''`,
    );
  }

  // Step 3: strip any '' default so subsequent INSERTs don't re-fail the
  // implicit cast once the column is uuid.
  await client.query(
    `ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP DEFAULT`,
  );

  // Step 4: detect rows that won't survive the `::uuid` cast. Catches both
  // empty strings on NOT NULL columns AND any non-uuid sentinel (e.g.
  // a stray slug or 'system' literal). Surface the first few bad values so
  // the operator can act on them.
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

  // Step 5: cast type. The USING clause is what synchronize fails to emit.
  // eslint-disable-next-line no-console
  console.log(
    `[pre-sync-postgres] ALTER ${table}.${column} (${currentType} → uuid)`,
  );
  await client.query(
    `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE uuid USING "${column}"::uuid`,
  );
}
