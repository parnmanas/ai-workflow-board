# Global Agent Workspace Design

## Goal

An Agent whose `workspace_id` is `NULL` is a global Agent. It must be visible and assignable in every workspace. Legacy rows whose `workspace_id` is the empty string are read with the same global semantics, while every new write normalizes the empty value to `NULL`.

## Scope and invariant

The canonical workspace compatibility rule is:

```text
agent.workspace_id is NULL
OR agent.workspace_id is empty
OR agent.workspace_id equals the target workspace id
```

The rule applies to every place that lists an Agent as a candidate or validates an Agent reference. This includes REST and MCP Agent listings, dashboards and detail views, ticket and board role holders, workspace assistant selection, Actions, QA, Security, Features, workspace schedules, Skills, benchmark participants, chat participants, comment mentions, and managed-agent administration.

Manager identities remain non-assignable where the existing domain rule excludes `type='manager'`. Global visibility does not override type, active-state, online-state, runtime-readiness, permission, or role requirements.

## Architecture

Add a small server-side Agent workspace policy module with two responsibilities:

1. An in-memory predicate for validating a loaded Agent against a target workspace.
2. A TypeORM-compatible query condition that returns workspace-local plus global rows.

All Agent repository queries and post-load validation branches use this policy instead of open-coded equality checks. A source-level parity guard inventories Agent-reference consumers and prevents a strict workspace comparison or workspace-only Agent query from silently returning.

The client treats `workspace_id` as `string | null`. Workspace selectors expose an explicit `All workspaces` option whose value is serialized as `null`. Workspace-scoped screens continue calling their existing Agent endpoints; the server includes global Agents in those responses, so individual picker components need no duplicate merge logic.

## Data flow

### Create and update

- Generic and managed Agent create/update endpoints accept a missing, `null`, or empty workspace value where the caller has Agent-management permission.
- Missing means preserve the current value on update; explicit `null` or empty means set global.
- Persisted empty values are normalized to `NULL`.
- The managed-Agent workspace endpoint accepts `{ "workspace_id": null }` and validates a non-null id only when assigning a concrete workspace.

### List and select

- A request scoped to workspace `W` returns Agents assigned to `W` plus global Agents.
- Admin `scope=all` continues to return all Agents exactly once.
- Dashboard/detail endpoints accept global Agents in a workspace context and calculate workspace-specific task/run data from that requested context.
- UI pickers receive the expanded list through the existing `getAgents(W)` and dashboard calls.

### Assign and execute

- An Agent reference is accepted when the Agent is compatible with the artifact's workspace under the canonical rule.
- Existing manager, inactive, offline, capability, and runtime checks remain unchanged.
- Ticket/run/chat records retain their own concrete `workspace_id`; making an Agent global never makes those records global.
- Runtime dispatch uses the target artifact's workspace context. Global Agent status does not grant its API key unrestricted cross-workspace data access outside a dispatched context.

## UI behavior

- Agent create/edit and Runtime Host managed-Agent workspace controls include `All workspaces`.
- Global rows display `All workspaces` instead of a blank or dash where workspace ownership is shown.
- Opening a global Agent from a workspace-scoped list retains that workspace in the route/context so workspace-specific task and activity panels remain meaningful.
- Moving a global Agent to a concrete workspace is supported. Returning it to global is an explicit selection, not an implicit failed move.

## Compatibility and migration

No destructive migration is required. Read paths accept both `NULL` and empty string immediately. A forward migration converts existing empty Agent workspace values to `NULL`, and all write paths normalize future empty input. Concrete workspace assignments are unchanged.

## Error handling

- Unknown non-null workspace ids return `400`.
- Agents bound to a different concrete workspace remain rejected with the existing domain-specific error.
- Global status never bypasses manager exclusion, inactive-Agent exclusion, unavailable runtime checks, or caller permission checks.
- Any Agent-reference consumer without a target workspace keeps its existing all-scope or explicit-error behavior; it must not guess a workspace.

## Testing

Tests follow RED-GREEN cycles and cover:

- the shared compatibility predicate and query behavior for local, global-null, global-empty, and foreign Agents;
- REST and MCP lists plus dashboard/detail visibility;
- explicit null writes and empty-to-null normalization;
- ticket/role, workspace assistant, Action, QA, Security, Feature, Schedule, Skill, benchmark, chat, and mention assignment boundaries;
- manager/inactive/foreign-Agent negative cases;
- client API serialization and `All workspaces` controls;
- a repository-wide Agent workspace parity guard;
- server, client, and agent-manager builds and relevant integration/QA suites.

## Out of scope

- Multiple selected workspaces per Agent. The model remains either one concrete workspace or global.
- Broadening user permissions or API-key authorization.
- Making tickets, boards, chat rooms, Actions, QA profiles, or Security profiles global.
