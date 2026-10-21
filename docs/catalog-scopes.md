# Catalog ownership and explicit Global items

Resources, Credentials, Functions and Skills are account-owned by default.
Omitting a scope never selects Global. Missing account context is an error.
Global authoring requires both an explicit `scope: 'global'` request and the
corresponding Global-write permission. Global rows use `account_id IS NULL`.

The catalog UI does not list old workspaces or offer an account/owner picker.
New rows use the caller's default Account. Where Global authoring is supported,
an unchecked-by-default **Create new items as Global (shared with all accounts)**
control makes that choice explicit. Having Global-write permission alone does
not select it. Existing rows retain their actual owner when edited or deleted.

Lists combine accessible account rows and Global rows. Account-specific
Function keys and Skill slugs can override matching Global defaults. IDs remain
stable; matching names do not justify deleting or merging resources or
credentials. Global credentials can be used by account-owned work, but a CLI
login session always belongs to its caller's Account and executes on an
accessible host, even when the resulting credential will be Global.

Teams and shared memory use the default Account and have no scope picker.
Global catalog visibility does not grant host control or other accounts' work
access. Existing data attribution and login ownership are documented in
[account ownership](ownership.md).
