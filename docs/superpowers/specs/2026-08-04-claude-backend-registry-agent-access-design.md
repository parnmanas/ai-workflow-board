# Claude Backend Registry Agent Access Design

**Date:** 2026-08-04  
**Status:** Approved for implementation planning

## Problem

Claude backend registry MCP tools currently require a DB-backed, full-scope
API key bound to an Agent whose type is `manager`. Operational tickets run as
ordinary managed Agents, and those sessions correctly receive keys bound to
their own Agent identity. Because manager Agents are not ticket-dispatch
targets, an ordinary operational ticket cannot satisfy the registry gate and
always ends with `Unauthorized`.

The authorization rule and the dispatch model therefore make the advertised
AI-managed backend configuration workflow impossible to complete.

## Decision

Allow every existing Agent identity with a DB-backed, full-scope MCP key to use
all Claude backend registry MCP tools:

- `upsert_claude_backend_profile`
- `assign_workspace_backend_profile`
- `list_claude_backend_profiles`

The caller's Agent type and API-key Workspace do not restrict registry access.
An authorized Agent may create or inspect instance-global profiles and assign
them to any Workspace.

## Authorization Contract

Access is granted only when all of the following are true:

1. the MCP session resolves to a caller;
2. the caller source is `db`;
3. the caller scope is exactly `full`;
4. the key is bound to an `agentId`; and
5. that Agent row still exists in the database.

The following callers remain unauthorized:

- unauthenticated sessions;
- environment-key sessions;
- development-mode sessions;
- DB-backed keys with a scope other than `full`;
- DB-backed keys not bound to an Agent; and
- keys whose bound Agent row no longer exists.

The error message and tool descriptions must describe the DB-backed,
full-scope Agent requirement without claiming the tools are manager-only.

## Data Flow

The existing MCP session authentication continues to resolve the API key into
`McpAgentContext`. Each registry tool passes that context to the shared registry
gate. The gate validates the source, scope, binding, and current Agent row,
then invokes the existing registry operation unchanged.

No manager-key delegation, impersonation, privilege rebinding, new Action, or
new credential transport is introduced.

## Existing Behavior Preserved

- Profile validation and credential ownership checks remain unchanged.
- Workspace assignment remains idempotent and preserves unrelated profile
  assignments.
- Safe list responses continue to omit credential references and secrets.
- A same-name profile with a different endpoint, model, or protocol continues
  to be rejected rather than overwritten.
- REST authorization, UI permissions, session attribution, and API-key
  provisioning remain unchanged.

## Implementation Shape

Update the registry authorization helper so it accepts any existing Agent row
instead of requiring `agent.type === 'manager'`. Rename the helper if needed so
its name reflects the new contract. Update all three MCP tool descriptions and
the shared authorization error.

No database migration, entity change, API schema change, or client change is
required.

## Testing

Extend the focused Claude backend profile MCP tests to prove:

- a manager Agent with a DB-backed full-scope key is allowed;
- ordinary Agent types are allowed with the same key properties;
- cross-Workspace profile assignment remains available to an authorized Agent;
- env, dev-mode, reduced-scope, missing-binding, and deleted-Agent contexts are
  rejected; and
- existing upsert, assignment, concurrency, credential, and safe-list behavior
  continues to pass.

Verification requires a successful server build and the focused Claude backend
profile MCP test suite.

## Out of Scope

- Allowing environment or development-mode identities to mutate the registry
- Relaxing the `full` scope requirement
- Changing same-name profile overwrite behavior
- Adding profile discovery or backend health polling
- Deploying the resulting server build to an AWB instance
