# Global Agent Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Agent.workspace_id = NULL` globally visible and assignable while treating legacy empty workspace values identically and normalizing future writes to `NULL`.

**Architecture:** Centralize Agent/workspace compatibility in a small server policy module, then route every Agent discovery and assignment boundary through it. Keep artifact workspace isolation intact: only the Agent identity is global, while tickets, runs, rooms, and API authorization retain concrete workspace scope.

**Tech Stack:** NestJS, TypeORM, TypeScript, React, Node test runner.

## Global Constraints

- `NULL` and legacy `''` both read as global Agent scope.
- Explicit `null` or empty input writes `NULL`; omitted update fields preserve the current value.
- Global scope does not bypass manager, active, online, runtime, permission, or role requirements.
- Artifact and API-key workspace authorization remains unchanged.
- Implementation runs inline in the current workspace because subagent delegation was not requested.

---

### Task 1: Canonical Agent workspace policy

**Files:**
- Create: `apps/server/src/common/agent-workspace-scope.ts`
- Create: `apps/server/test/agent-workspace-scope.test.mjs`
- Modify: `apps/server/package.json`

**Interfaces:**
- Produces: `normalizeAgentWorkspaceId(value: unknown): string | null`
- Produces: `agentIsVisibleInWorkspace(agentWorkspaceId: string | null | undefined, workspaceId: string): boolean`
- Produces: `agentWorkspaceWhere(workspaceId: string): Array<{ workspace_id: string | FindOperator<string> | null }>`

- [ ] Write behavior tests for local, null-global, empty-global, foreign, and write normalization cases.
- [ ] Build and run the test, confirming RED because the policy module does not exist.
- [ ] Implement the three policy functions with TypeORM `IsNull()` for query construction.
- [ ] Rebuild and confirm GREEN.
- [ ] Register the new top-level test in a package lifecycle script.

### Task 2: Agent discovery and workspace mutation contracts

**Files:**
- Modify: `apps/server/src/modules/agents/agents.controller.ts`
- Modify: `apps/server/src/modules/agent-manager/agent-manager.controller.ts`
- Modify: `apps/server/src/modules/mcp/tools/agent-tools.ts`
- Modify: `apps/server/src/modules/tickets/tickets.controller.ts`
- Test: `apps/server/test/global-agent-discovery.test.mjs`

**Interfaces:**
- Consumes: Task 1 policy helpers.
- Produces: workspace lists/dashboards/MCP results containing local plus global Agents.
- Produces: create/update/workspace endpoints that persist explicit global scope as `NULL`.

- [ ] Add integration tests proving REST list/dashboard, MCP list, comment-summary candidate selection, and managed-Agent workspace mutation include or accept null/empty global Agents but exclude foreign Agents.
- [ ] Run the focused test and confirm each missing path fails.
- [ ] Replace workspace-only Agent queries with the canonical query policy.
- [ ] Add explicit `workspace_id` create/update semantics and validate concrete workspace ids.
- [ ] Make the managed-Agent workspace endpoint accept `null` and normalize `''`.
- [ ] Re-run the focused test and confirm GREEN.

### Task 3: Assignment and execution reference boundaries

**Files:**
- Modify: `apps/server/src/modules/workspaces/workspaces.controller.ts`
- Modify: `apps/server/src/modules/workspace-roles/ticket-role-assignment.service.ts`
- Modify: `apps/server/src/modules/actions/actions.service.ts`
- Modify: `apps/server/src/modules/qa/qa.service.ts`
- Modify: `apps/server/src/modules/security/security-profile.service.ts`
- Modify: `apps/server/src/modules/features/features.service.ts`
- Modify: `apps/server/src/modules/workspace-schedule/workspace-schedule.service.ts`
- Modify: `apps/server/src/modules/skills/skills.service.ts`
- Modify: `apps/server/src/modules/benchmarks/benchmark.service.ts`
- Modify: `apps/server/src/modules/chat-rooms/room-crud.service.ts`
- Modify: `apps/server/src/modules/chat-rooms/room-messaging.service.ts`
- Modify: `apps/server/src/modules/mcp/tools/comment-tools.ts`
- Test: `apps/server/test/global-agent-assignment.test.mjs`

**Interfaces:**
- Consumes: `agentIsVisibleInWorkspace`.
- Produces: consistent acceptance of global Agents at every Agent-reference write boundary.

- [ ] Add table-driven integration tests for workspace assistant, role/default holder, Action, QA, Security, Feature planner, Schedule, Skill, benchmark, chat, and mention assignment.
- [ ] Include negative fixtures for foreign concrete workspace, manager, inactive, and missing Agents where those restrictions apply.
- [ ] Run the focused test and confirm RED only on global-Agent cases.
- [ ] Replace strict workspace equality checks and workspace-only repository lookups with the shared policy without weakening other guards.
- [ ] Re-run the focused test and confirm GREEN.

### Task 4: Runtime-facing workspace context

**Files:**
- Modify: `apps/server/src/modules/agent-api/agent-api.controller.ts`
- Modify: `apps/server/src/modules/agents/allocation.service.ts`
- Modify: `apps/server/src/modules/agents/trigger-loop.service.ts`
- Modify: `apps/server/src/modules/agent-manager/agent-manager.controller.ts`
- Test: `apps/server/test/global-agent-runtime-context.test.mjs`

**Interfaces:**
- Consumes: global Agent identity plus a concrete requested artifact workspace.
- Produces: dispatch/allocation behavior that accepts global Agents while retaining ticket/run workspace scope.

- [ ] Add tests showing a global Agent can be allocated and dispatched in two distinct workspaces.
- [ ] Add tests showing Agent API-key authorization is not implicitly made cross-workspace by the global identity alone.
- [ ] Confirm RED on global allocation/dispatch and GREEN after applying the policy only to identity compatibility checks.

### Task 5: Client global workspace controls

**Files:**
- Modify: `apps/client/src/api.ts`
- Modify: `apps/client/src/types.ts`
- Modify: `apps/client/src/components/admin/AgentManagerPage.tsx`
- Modify: `apps/client/src/components/admin/ManagedAgentDialog.tsx`
- Modify: `apps/client/src/components/AgentsPage.tsx`
- Modify: `apps/client/src/components/AgentArtifact.tsx`
- Modify: `apps/client/src/components/chat/assistantEntry.ts`
- Test: `apps/client/test/global-agent-workspace.test.mjs`

**Interfaces:**
- Consumes: nullable `Agent.workspace_id` and nullable managed-Agent workspace API.
- Produces: explicit `All workspaces` selection and stable workspace-context navigation.

- [ ] Add client behavior tests for null serialization, global eligibility, label rendering, and route fallback.
- [ ] Run the test and confirm RED.
- [ ] Update API/types and controls, sending `{ workspace_id: null }` for `All workspaces`.
- [ ] Ensure picker filters treat null/empty Agents as eligible in any active workspace.
- [ ] Re-run tests and client build for GREEN.

### Task 6: Legacy normalization and completeness guard

**Files:**
- Create: `apps/server/src/database/migrations/1760000000074-NormalizeGlobalAgentWorkspace.ts`
- Create: `apps/server/test/agent-workspace-reference-parity.test.mjs`
- Modify: `apps/server/src/entities/Agent.ts`
- Modify: `apps/server/package.json`

**Interfaces:**
- Produces: database normalization from `''` to `NULL`.
- Produces: a source audit that rejects new strict Agent/workspace comparisons or workspace-only Agent candidate queries.

- [ ] Add a migration behavior test and a source parity test covering the audited Agent-reference inventory.
- [ ] Confirm RED against the pre-migration/parity state.
- [ ] Implement the reversible normalization migration and update the entity contract comment.
- [ ] Resolve every parity violation intentionally, documenting authorization-only exceptions.
- [ ] Confirm both tests GREEN.

### Task 7: Verification and publication

**Files:**
- Review all files changed by Tasks 1-6.

- [ ] Run `npm run build` from the repository root.
- [ ] Run every new focused server/client test and existing Agent, ticket lifecycle, role assignment, Action, QA, Security, Feature, Schedule, Skill, benchmark, chat, and runtime-context suites.
- [ ] Run `git diff --check` and inspect the staged diff for unrelated changes.
- [ ] Commit implementation with an Agent global-workspace message.
- [ ] Fetch `origin/main`, reconcile any non-conflicting upstream commits, and re-run affected verification if the base changed.
- [ ] Push `main` and verify `HEAD` equals `origin/main`.
