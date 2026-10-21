# Shared work and instance defaults

Sessions, tickets, projects, teams and missions share one installation. There
are no user-defined work accounts, ownership memberships, or account selectors.
Active users can access work after authentication; feature permissions and
administrator-only configuration still apply. Chat-room participation, runtime
host authorization and credential-secret access remain separate controls.

`/settings/defaults` manages shared dispatch and execution defaults.
`/settings/users` manages login users, approval and feature permissions. Account
creation/deletion, membership assignment and the account CRUD MCP tools have
been removed. Approving a user no longer requires assigning a workspace.

## Data transition

Migration `1760000000094-SingleInstanceWork` removes the previous accounts and
membership tuples without deleting their tickets, comments, projects,
credentials, attachments, missions or native-session bindings. Business object
IDs, contents and timestamps are retained. Shared knowledge memory from the old
accounts is concatenated into the shared defaults without discarding its text. Usage rollups are summed after
removing the former ownership grouping. Conflicting catalog keys abort the
transaction instead of silently replacing a definition.

Per-account CLI defaults are reset; credential records and each existing
session's pinned configuration remain intact. Shared dispatch defaults start
with the application's defaults. Native CLI homes and transcript files are not
renamed or deleted.

## Remaining internal storage

The execution pipeline still carries `account_id` and reads defaults from the
`accounts` table. This is transitional implementation, not a selectable owner
or a permission boundary: the only internal execution key is
`00000000-0000-4000-8000-000000000001`. Do not reintroduce account creation or
membership around it. Removing these remaining fields requires a separate
server/manager contract change; this transition does not claim that physical
schema cleanup is complete.

Built-in/global catalog rows can still have a NULL internal key, while custom
rows use the shared execution key. This distinction does not partition users.

Runtime REST/MCP/SSE no longer translates workspace owner aliases. Historical
database migration code remains available to preserve data during upgrades.
Filesystem `workspace_folder`, CLI `workspace-write`, and CLI trust still refer
to actual working directories.

Back up the database before upgrading. Apply through the regular boot or
offline migration entry point; do not call the old account deletion API, which
used to cascade-delete work. Rollback requires restoring the backup together
with the previous server build.
