# Account ownership

Account is the default ownership and execution boundary. Only catalog objects
explicitly created as Global are shared. A missing owner on a Runtime Host or
API key is invalid; it does not mean Global.

Runtime Hosts, manager keys, runtime keys, native sessions, tickets, projects,
teams and missions belong to an Account. A key must match its active Host's
owner. A manager cannot provision a runtime key, fetch credentials, or execute
work for another Account. Global credentials may be consumed by account-owned
work; creating a Global credential still runs its login process on a host the
caller can access.

User-facing lists and SSE use the caller's accessible accounts. Detail and
write routes resolve the object's owner, rather than trusting a browser's
account hint. Administrator and Global-authoring permissions do not bypass
host ownership. Error-log lists and counts use the same account boundary;
uploads are stamped with the authenticated owner. New independent work uses the caller's default Account;
referenced projects and teams determine ownership of their work. See
[catalog scopes](catalog-scopes.md) for Global authoring.

Deployment reports also default to the authenticated Account. Global reports
require an explicit `scope: 'global'` on the administrator REST endpoint; the
MCP reporter can only report for its own Account. Ticket acknowledgements,
output liveness and tool telemetry must match the assigned runtime's Account
and Host.

Work pages retain `/sessions`, `/tickets`, `/projects`, and `/missions` without
the old workspace/account picker. Account defaults are at `/settings/defaults`;
login-user administration is at `/settings/users`. Old workspace membership,
account CRUD and membership-assignment APIs are not restored by this change.

## Login identity and ownership

A User is a login identity; an Account owns work. Signup/setup creates one
personal Account per User. `accounts.owner_user_id` identifies its owner and
`kind = 'personal'` has a unique owner index. Concurrent first requests reuse
the same account. Inactive users have no access. An administrator manages
instance users and explicit Global configuration; that role does not grant
access to someone else's work. Account defaults are editable by their owner.
Organization membership is reserved for a future implementation, without
reviving workspace selectors or legacy role tuples.

Lists, raw attachments, activity feeds, artifact references and SSE check the
same account boundary. Operator registrations and report routing are account
bound. MCP runtime keys cannot create, alter or delete login users; the human
user-administration UI manages those identities. Disabling a user preserves
its work; deleting a user that owns an Account is rejected.

## Existing data migration

Migration `1760000000094-SingleInstanceWork` consolidated old ownership into
`00000000-0000-4000-8000-000000000001`. Migration
`1760000000095-PersonalAccountOwnership` assigns that unchanged UUID to the
active User explicitly named by `AWB_LEGACY_OWNER_USER_ID`. Other users receive
empty personal Accounts. For this installation the confirmed legacy owner is
Parn; kent.k starts empty. Historical NULL catalog owners were an automatic
Global default, so existing credentials and custom catalog rows become private.
Builtin Skills/Functions remain Global. Empty/stale ownership in work and
history is repaired without changing contents, IDs, timestamps or ciphertext.
An upgrade with existing data and no explicit owner fails instead of guessing.
Fresh installations create their first Account at signup/setup.

Back up the database before applying the forward migration and verify that
business contents and credential ciphertext remain intact. Keep existing
native homes, transcripts and credential/MCP paths. Deploy the server's SSE
ownership stamps together with the manager update; a new manager rejects
work from an older server that omits them.

Runtime REST/MCP/SSE uses `account_id`. Historical workspace owner conversion
belongs only to database migration code. Filesystem `workspace_folder`,
RunWorkspace, CLI workspace trust and Codex `workspace-write` retain their
working-directory meanings.
