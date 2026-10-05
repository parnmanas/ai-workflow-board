# Work ownership

AWB opens work directly: `/sessions`, `/tickets`, `/projects`, `/teams`,
`/missions` and `/chat`. There is no workspace selector and no required
workspace segment in a work URL. Tags and projects classify tickets; a project
continues to represent one repository and its main clone folder on each host.

`Account` is the ownership and administration boundary. It carries memberships,
credentials, shared catalogs, execution defaults, dispatch controls and budgets.
It is managed at `/settings/ownership`; it does not contain a separate copy of
the work interface. Existing workspace IDs become account IDs without merging
accounts or their permissions. The first accessible account is the automatic
creation default; a supplied authorized owner or a selected project/team can
choose the owner of new work.

## Authorization and discovery

Canonical work list endpoints aggregate accessible accounts: tickets, projects,
chat rooms, teams, missions, actions, automation schedules, QA and Security.
Unread counters and mention inboxes use the same accessible ownership set.
ID-addressed requests resolve the actual resource owner and check membership;
a page's default account cannot grant access or change an existing owner.
Account administration distinguishes members from owners: members can read,
owners or administrators can change settings and membership. Resource catalogs
still have explicit Global (`account_id NULL`) and Account scopes. Global
credentials keep their additional administration permission.

User SSE streams filter events with an ownership account against the user's
accessible accounts, then apply existing room/recipient filters. Membership changes
close browser streams so reconnect resolves current permissions. Native session
events also carry their pinned owner internally before delivery. Host control
and runtime permissions retain their existing contracts. Runtime Hosts and
native CLI history remain machine-level resources; account membership does not
replace permission to operate a host.

## Native sessions

The native session identity remains `(Runtime Host, CLI, native session ID)`.
AWB stores no session transcript. `agent_session_executions` stores only the
execution binding: owner, credential ID, config defaults and runtime profile.
The first open pins those settings. Subsequent prompts, restart and reopen use
the pinned binding, including after a server restart or a change of account
creation defaults. An explicit session config/mode change updates the binding.
Unbound native sessions acquire a binding when first opened through AWB; existing
native IDs and files are not rewritten.

## Compatibility and extension

The schema uses `accounts`, `account_id`, and `automation_schedules`. REST and MCP
use `X-Account-Id`, account tools and automation schedule tools. Legacy
`/ws/:wsId/...` UI bookmarks redirect with entity IDs, query strings and hashes
preserved. Legacy REST owner fields, headers, account administration routes and
MCP tool calls are normalized at the transport boundary. Existing installed
managers receive legacy ownership aliases; newer managers read old configuration
and write the canonical account fields.

Filesystem `workspace_folder`, CLI `workspace-write` and trust settings still
mean an execution directory. They are independent of work ownership and retain
their existing names and behavior. Historical migration names and index names
also remain where required for persisted migration history.

Long-lived reusable task context can be introduced independently in the future.
This change introduces no new context container and does not make one mandatory.
For DB upgrade and rollback instructions see
[the migration runbook](runbooks/account-ownership-migration.md).
