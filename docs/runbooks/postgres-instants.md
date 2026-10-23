# PostgreSQL instant storage

When: upgrading an existing PostgreSQL AWB database, moving it between server timezones, or investigating a timestamp comparison.

AWB's `Date`, creation, update and deletion timestamp columns represent absolute instants. `InstantDataSource` maps them to PostgreSQL `timestamp with time zone` (`timestamptz`). The original TypeORM metadata is retained, including the migration protocol's schema fingerprint. SQLite and MySQL retain their existing drivers and storage behavior. Calendar dates and recurrence timezone fields are unchanged.

PostgreSQL honors the offset sent with a JS Date and compares `now()` with the same absolute timeline. API Date serialization remains ISO 8601 with `Z`; browser locale formatting converts that instant for display. A display timezone option cannot repair a wrongly interpreted database value. `timestamptz` does not preserve the writer's timezone name.

## Existing PostgreSQL databases

Before upgrading, back up the database and stop all old server instances that might synchronize its schema. Do not start older AWB code against a converted database: its schema synchronization expects the old type. A rollback requires the matching database backup as well as the old code.

Both NestJS and standalone MCP use `InstantDataSource`. Immediately before TypeORM synchronization it:

1. Finds only declared instant columns that still use `timestamp without time zone`, in the entity's schema. External tables are excluded.
2. Locks the affected tables in deterministic order, with a five-second lock acquisition timeout, then rechecks their types.
3. Uses the Node process's IANA timezone to preserve the previous `pg` timestamp interpretation. For populated columns this automatic policy requires the PostgreSQL session timezone to have the same name.
4. Rejects ambiguous or nonexistent legacy local times around DST transitions. PostgreSQL and JS choose different occurrences in a repeated hour, so silently converting those values would change existing instants.
5. Converts all affected columns in one transaction, using explicit `AT TIME ZONE`, preserving nulls, defaults, indexes and fractional precision. Columns in each table are converted together. Failure rolls back the conversion. Restart skips columns already converted.

This preserves the current server's reading of legacy values; it does **not** reconstruct or repair historical mixed-timezone writes. Review known past writer changes before upgrading. Matching current Node/DB timezones is not proof of historical consistency.

If the writer timezone is known and differs from the upgrading process or DB session, set `AWB_LEGACY_TIMESTAMP_TIMEZONE` to that verified IANA name for the upgrade (for example `Asia/Seoul`). Do not use a guessed zone just to bypass a failed check. Mixed-writer rows require a separate, evidence-based reconciliation. DST fold/gap rows must also be resolved before retrying; the override does not suppress the ambiguity guard. An empty database needs no legacy policy.

The environment variable only controls legacy conversion. Future instants are independent of Node and PostgreSQL session timezones; no global `pg` parser or process timezone is changed. Remove the override after the upgrade.

## Verification

Build the server, then run `node --test test/instant-data-source.test.mjs` from `apps/server`. With `DB_TYPE=postgres` and the normal `DB_*` connection variables, it also runs isolated PostgreSQL schemas, including nine Node/DB timezone combinations, two distinct instants in the New York repeated hour, legacy microsecond preservation, generated timestamps, atomic rollback, explicit-zone validation and restart idempotency. The test is registered in the PostgreSQL CI pretest suite. Without PostgreSQL it checks SQLite round trips and unchanged Date metadata/fingerprints.

For a rollout, rehearse conversion on a restored backup and compare timestamp counts and epoch values before restarting the live server. Recheck `information_schema.columns` after boot and confirm the health endpoint. A timezone mismatch or ambiguity error is a migration guard, not a reason to let TypeORM rebuild the columns itself.
