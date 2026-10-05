# Account ownership migration

Migration `1760000000092-AccountOwnership` accompanies workspace removal. A
pre-sync step renames ownership before TypeORM synchronize can drop the old
columns. Use the application boot path or `npm run migration:run -w server`;
calling the raw TypeORM CLI with `src/db.ts` bypasses the required preparation.
The offline command accepts no options and rejects legacy flags such as `--fake`
before making changes.

## Apply

1. Stop processes that write the target database, including standalone MCP.
2. Back up the database. For sql.js back up **both** `database/data.db` and
   `database/ontology.db` (or the configured `SQLJS_DB_PATH` and
   `SQLJS_ONTOLOGY_DB_PATH`). For PostgreSQL take a restorable database backup.
3. Build and run the upgraded server, or run the offline command with the same
   DB configuration: `npm run migration:run -w server`.
4. Verify that the migration ledger includes `AccountOwnership1760000000092`,
   memberships and credentials still resolve, existing projects/tickets appear,
   and native sessions resume. Re-running the command is safe.

Boot and the offline command run ownership rename, PostgreSQL repair, legacy
Agent/Board preparation, synchronize and data migrations in that order. The
independent ontology sql.js database gets its own ownership rename before its
schema is synchronized. The offline command forces both sql.js files to disk
before exiting. `DB_SCHEMA` is respected by ownership migration and PostgreSQL
repair; unrelated schemas are not modified.

## Preservation and failure behavior

Workspace IDs become account IDs unchanged. Tickets, projects, credentials,
API-key bindings, schedules, memberships and selected structured configuration
keep their owner references. Nullable Global catalog ownership remains NULL.
Native session IDs, CLI homes, transcripts and working folders do not change.
A pre-0091 installation still receives the existing Agent/Board data conversions
after ownership is renamed; historical migration ledger names remain valid.

SQLite and PostgreSQL ownership DDL/data rewrites are transactional. If both old
and new tables, owner columns or ownership JSON keys coexist, migration stops
instead of choosing which copy to discard. Fix the ambiguity from the backup
and retry. The two sql.js files are separate transactions, so always restore
both together if the upgrade must be rolled back.

## Roll back

There is no down migration. Stop the upgraded process, restore the pre-upgrade
backup and run the corresponding old application version. Never start the old
version against an account schema: its synchronize step can discard the renamed
data. Keep server and Agent Manager source changes together; publish versions
are computed by the existing main-branch release workflow.
