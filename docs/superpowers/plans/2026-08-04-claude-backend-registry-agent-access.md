# Claude Backend Registry Agent Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow every existing Agent with a DB-backed, full-scope MCP key to create, list, and assign Claude backend profiles across all Workspaces.

**Architecture:** Keep MCP authentication and the registry operations unchanged, but replace the manager-type authorization check with an existing-Agent check. Preserve the DB source and exact `full` scope requirements, and update the public tool copy to reflect the new contract.

**Tech Stack:** TypeScript, NestJS, TypeORM, MCP SDK, Node.js test runner

## Global Constraints

- Environment-key, dev-mode, reduced-scope, unbound, and deleted-Agent callers remain unauthorized.
- Authorized Agents may assign profiles to any Workspace regardless of the API key's Workspace stamp.
- Same-name profile overwrite behavior remains unchanged.
- No database, entity, REST, or client schema changes.
- Implement test-first and verify the focused suite plus the server build before pushing.

---

### Task 1: Generalize the Registry Authorization Gate

**Files:**
- Modify: `apps/server/test/claude-backend-profile-mcp.test.mjs`
- Modify: `apps/server/src/modules/mcp/tools/claude-backend-profile-tools.ts`

**Interfaces:**
- Consumes: `McpAgentContext` from `apps/server/src/modules/mcp/shared/session-auth.ts` and the TypeORM `Agent` repository.
- Produces: `requireAgentRegistryAccess(dataSource: DataSource, caller: McpAgentContext | undefined): Promise<string | null>`.

- [ ] **Step 1: Write the failing authorization tests**

Replace the manager-only test with assertions that call
`requireAgentRegistryAccess` and prove:

```js
const managerCaller = {
  agentId: managerAgent.id,
  source: 'db',
  scope: 'full',
};
assert.equal(await tools.requireAgentRegistryAccess(ds, managerCaller), null);

const ordinaryAgent = await ds.getRepository('Agent').save(
  ds.getRepository('Agent').create({
    name: 'Ordinary profile operator',
    type: 'claude',
    workspace_id: workspace.id,
  }),
);
const crossWorkspaceCaller = {
  agentId: ordinaryAgent.id,
  source: 'db',
  scope: 'full',
  workspaceId: '00000000-0000-0000-0000-000000000000',
};
assert.equal(await tools.requireAgentRegistryAccess(ds, crossWorkspaceCaller), null);
```

Add rejection assertions for `source: 'env'`, `source: 'dev-mode'`,
`scope: 'write'`, a missing `agentId`, and a nonexistent Agent id. Match the
new error contract:

```js
/DB-backed, full-scope MCP key bound to an Agent/
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm run build -w server
node apps/server/test/run-suite.mjs apps/server/test/claude-backend-profile-mcp.test.mjs
```

Expected: the focused suite fails because
`requireAgentRegistryAccess` is not exported.

- [ ] **Step 3: Implement the minimal authorization change**

In `claude-backend-profile-tools.ts`:

```ts
const REGISTRY_GATE_ERROR =
  'Unauthorized: Claude backend profile registry tools require a DB-backed, full-scope MCP key bound to an Agent.';

export async function requireAgentRegistryAccess(
  dataSource: DataSource,
  caller: McpAgentContext | undefined,
): Promise<string | null> {
  if (!caller || caller.source !== 'db' || caller.scope !== 'full' || !caller.agentId) {
    return REGISTRY_GATE_ERROR;
  }
  const agent = await dataSource.getRepository(Agent).findOne({
    where: { id: caller.agentId },
  });
  return agent ? null : REGISTRY_GATE_ERROR;
}
```

Use this helper in the shared tool gate. Change each tool description from
`Manager-authenticated MCP only` to `DB-backed, full-scope Agent MCP only`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm run build -w server
node apps/server/test/run-suite.mjs apps/server/test/claude-backend-profile-mcp.test.mjs
```

Expected: all Claude backend profile MCP tests pass with zero failures.

- [ ] **Step 5: Review the focused diff**

Run:

```powershell
git diff --check
git diff -- apps/server/src/modules/mcp/tools/claude-backend-profile-tools.ts apps/server/test/claude-backend-profile-mcp.test.mjs
```

Expected: no whitespace errors and no changes outside the approved authorization contract.

### Task 2: Verify, Commit, and Publish

**Files:**
- Include: `docs/superpowers/plans/2026-08-04-claude-backend-registry-agent-access.md`
- Include: `apps/server/src/modules/mcp/tools/claude-backend-profile-tools.ts`
- Include: `apps/server/test/claude-backend-profile-mcp.test.mjs`

**Interfaces:**
- Consumes: the implementation and focused tests from Task 1.
- Produces: a verified commit published to `origin/main`.

- [ ] **Step 1: Run final verification**

Run:

```powershell
npm run build -w server
node apps/server/test/run-suite.mjs apps/server/test/claude-backend-profile-mcp.test.mjs
git diff --check
```

Expected: build exit code 0, focused suite 0 failures, and no diff-check errors.

- [ ] **Step 2: Confirm branch and change scope**

Run:

```powershell
git branch --show-current
git status --short
git diff --stat HEAD
```

Expected: branch is `main`; only the plan, source, and focused test are pending.

- [ ] **Step 3: Commit the implementation**

Run:

```powershell
git add -- docs/superpowers/plans/2026-08-04-claude-backend-registry-agent-access.md apps/server/src/modules/mcp/tools/claude-backend-profile-tools.ts apps/server/test/claude-backend-profile-mcp.test.mjs
git commit -m "fix(mcp): allow agents to manage backend profiles"
```

Expected: one implementation commit containing the approved files.

- [ ] **Step 4: Push main**

Run:

```powershell
git push origin main
```

Expected: `origin/main` advances to the implementation commit.

- [ ] **Step 5: Confirm published state**

Run:

```powershell
git status --short
git log -3 --oneline --decorate
```

Expected: clean working tree and local `main` equals `origin/main`.
