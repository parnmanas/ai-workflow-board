# Hermes Runtime Integration Implementation Plan

> **For implementers:** Execute this plan with `superpowers:executing-plans`.
> Keep each task test-first and commit only after its focused verification
> passes.

**Goal:** Make Runtime Host the only AWB Agent execution topology, add Hermes
as an explicit ACP runtime, and introduce governed skill snapshots/proposals
without changing AWB's control-plane ownership.

**Architecture:** AWB Server owns durable control state. The existing
`awb-agent-manager` binary is the Runtime Host and owns local processes,
credentials, worktrees, and protocol adapters. Hermes runs as an official
`hermes-acp` child process; normalized runtime events flow back through the
existing manager/server event path. Skills are versioned by AWB, pinned into a
run snapshot, and materialized by Runtime Host.

**Tech stack:** TypeScript, NestJS 11, TypeORM, React 18, Node 22 test runner,
stdio JSON-RPC/ACP, existing SSE/REST/MCP transports.

---

## Task 1: Establish explicit runtime selection

**Files**

- Create: `apps/agent-manager/src/lib/runtime/runtime-types.ts`
- Create: `apps/agent-manager/src/lib/runtime/runtime-registry.ts`
- Create: `apps/agent-manager/test/runtime-registry.test.mjs`
- Modify: `apps/agent-manager/src/lib/cli-adapters/base.ts`
- Modify: `apps/agent-manager/src/lib/cli-adapters/index.ts`
- Modify: `apps/server/src/common/types/cli-types.ts`

**Step 1: Write the failing registry tests**

Cover:

- each existing CLI returns a full `RuntimeCapabilities` descriptor;
- `hermes` is a registered runtime id;
- missing id throws `runtime_not_configured`;
- unknown/custom id throws `runtime_unknown`;
- no path falls back to Claude;
- unsupported `delegated`/`swarm` strategies fail validation.

Run:

```powershell
npm run build -w awb-agent-manager
node --test apps/agent-manager/test/runtime-registry.test.mjs
```

Expected: FAIL because the registry does not exist and the current factory
defaults unknown values to Claude.

**Step 2: Add runtime types and registry**

Define `RuntimeCapabilities`, `ExecutionStrategy`, `RuntimePermissionMode`,
`AgentRuntimeConfig`, `RuntimeSelectionError`, and a registry entry that wraps
the existing CLI adapter factories. Register Hermes as unavailable until its
factory lands, but preserve its capability declaration for validation/UI.

**Step 3: Remove adapter fallback**

Make `createAdapter()` require an explicit known CLI id and throw a typed
selection error for empty/unknown/custom values. Add `hermes` to the canonical
server list and keep `custom` identity-only.

**Step 4: Verify and commit**

```powershell
npm run test -w awb-agent-manager -- --test-name-pattern runtime
git add apps/agent-manager/src/lib/runtime apps/agent-manager/src/lib/cli-adapters apps/agent-manager/test/runtime-registry.test.mjs apps/server/src/common/types/cli-types.ts
git commit -m "feat(runtime): require explicit registered runtimes"
```

## Task 2: Persist and validate runtime configuration

**Files**

- Modify: `apps/server/src/entities/Agent.ts`
- Create: `apps/server/src/common/runtime-config.ts`
- Create: `apps/server/src/database/migrations/1760000000067-BackfillAgentRuntimeConfig.ts`
- Modify: `apps/server/src/modules/agents/agents.controller.ts`
- Modify: `apps/server/src/modules/agent-manager/agent-manager.controller.ts`
- Modify: `apps/server/src/modules/mcp/tools/agent-tools.ts`
- Create: `apps/server/test/agent-runtime-config.test.mjs`
- Create: `apps/server/test/qa-flows/agent-runtime-config.test.mjs`

**Step 1: Write failing API tests**

Assert that executable Agent create/update rejects:

- missing Runtime Host;
- manager Agent used as an executable runtime;
- missing runtime config;
- missing strategy or permission mode;
- unknown runtime;
- unsupported strategy.

Assert that manager identities remain valid without a parent host and that a
valid Hermes Agent persists its exact structured config.

**Step 2: Add the schema and parser**

Add nullable `runtime_config` JSON to `Agent` because manager identities are
non-executable. The parser requires explicit `strategy` and
`permission_mode`, bounds child/iteration limits, drops no unknown values
silently, and returns stable error codes.

**Step 3: Add conservative data migration**

Backfill hosted existing executable Agents with explicit `single` plus their
current effective permission mode. Mark managerless executable Agents inactive
and record a migration diagnostic in `role_prompt_meta`. Do not auto-attach a
host. Keep history rows intact.

**Step 4: Enforce in REST and MCP**

Use one validation helper from both normal Agent APIs and managed-Agent APIs.
Remove `type = 'custom'` and `manager_agent_id = null` request defaults for
executable creation.

**Step 5: Verify and commit**

```powershell
npm run build -w server
node apps/server/test/run-suite.mjs apps/server/test/agent-runtime-config.test.mjs apps/server/test/qa-flows/agent-runtime-config.test.mjs
git add apps/server/src/entities/Agent.ts apps/server/src/common/runtime-config.ts apps/server/src/database/migrations/1760000000067-BackfillAgentRuntimeConfig.ts apps/server/src/modules/agents/agents.controller.ts apps/server/src/modules/agent-manager/agent-manager.controller.ts apps/server/src/modules/mcp/tools/agent-tools.ts apps/server/test/agent-runtime-config.test.mjs apps/server/test/qa-flows/agent-runtime-config.test.mjs
git commit -m "feat(server): validate hosted agent runtime config"
```

## Task 3: Advertise Runtime Host capabilities

**Files**

- Modify: `apps/agent-manager/src/lib/instance-heartbeat.ts`
- Modify: `apps/agent-manager/src/main.ts`
- Modify: `apps/server/src/modules/agent-manager/instance-registry.service.ts`
- Modify: `apps/server/src/modules/agent-manager/agent-manager.controller.ts`
- Modify: `apps/server/src/common/types/stream-events.ts`
- Modify: `apps/client/src/types.ts`
- Create: `apps/agent-manager/test/runtime-heartbeat.test.mjs`
- Create: `apps/server/test/runtime-capabilities-heartbeat.test.mjs`

**Step 1: Write failing heartbeat tests**

Require `runtime_capabilities` keyed by runtime id with installed, healthy,
version, reason, and capability descriptor. Confirm absence/unhealthy is
distinct from unknown.

**Step 2: Build health discovery**

Resolve each executable without launching a run. Probe Hermes with
`hermes-acp --help` or its supported version command under a short timeout.
Cache slow probes and never block heartbeat indefinitely.

**Step 3: Store and serve the descriptors**

Update the wire type, in-memory instance record, SSE shape, and admin API.
Keep `cli_adapters` as a deprecated compatibility projection during rollout.

**Step 4: Verify and commit**

```powershell
npm run build -w awb-agent-manager
npm run build -w server
node --test apps/agent-manager/test/runtime-heartbeat.test.mjs
node apps/server/test/run-suite.mjs apps/server/test/runtime-capabilities-heartbeat.test.mjs
git add apps/agent-manager/src/lib/instance-heartbeat.ts apps/agent-manager/src/main.ts apps/server/src/modules/agent-manager/instance-registry.service.ts apps/server/src/modules/agent-manager/agent-manager.controller.ts apps/server/src/common/types/stream-events.ts apps/client/src/types.ts apps/agent-manager/test/runtime-heartbeat.test.mjs apps/server/test/runtime-capabilities-heartbeat.test.mjs
git commit -m "feat(runtime): advertise host capabilities"
```

## Task 4: Remove server-side standalone execution

**Files**

- Modify: `apps/server/src/modules/agent-manager/instance-registry.service.ts`
- Modify: `apps/server/src/modules/agent-manager/agent-manager.controller.ts`
- Modify: `apps/server/src/modules/events/events.controller.ts`
- Modify: `apps/server/src/modules/events/event-registry.ts`
- Modify: `apps/server/src/modules/events/types.ts`
- Modify: `apps/server/src/modules/agents/agent-autostart.service.ts`
- Modify: `apps/server/src/modules/agents/agent-status.service.ts`
- Modify: `apps/server/src/common/agent-lifecycle.ts`
- Modify: `apps/server/src/modules/mcp/mcp.controller.ts`
- Create: `apps/server/test/runtime-host-only-topology.test.mjs`
- Modify: affected proxy/status tests under `apps/server/test`

**Step 1: Write the topology guard**

The guard asserts:

- heartbeat mode accepts only `manager`;
- live session source is only `manager`;
- executable Agent events route only through its linked Runtime Host;
- no proxy main-session election or daemon routing remains;
- managerless Agent dispatch nacks with `runtime_host_required`;
- historical proxy labels may be read but cannot start/resume.

Run the new test and capture the expected failure.

**Step 2: Collapse presence and routing**

Remove daemon/proxy unions and branches. Delete proxy session synthesis,
pinning, session-key routing, and schema gate exceptions that exist only for
the bare plugin proxy. Keep generic MCP schema negotiation for supported
clients.

**Step 3: Make autostart fail closed**

Return stable runtime error codes and keep DispatchIntent unresolved according
to existing retry rules. Never treat a direct Agent heartbeat as runnable.

**Step 4: Update focused tests and commit**

```powershell
npm run build -w server
node apps/server/test/run-suite.mjs apps/server/test/runtime-host-only-topology.test.mjs apps/server/test/never-started-agent-feedback.test.mjs apps/server/test/event-registry-payload-parity-guard.test.mjs
git add apps/server/src apps/server/test
git commit -m "refactor(server): remove standalone agent execution"
```

## Task 5: Remove client proxy/daemon controls

**Files**

- Modify: `apps/client/src/types.ts`
- Modify: `apps/client/src/components/admin/AgentManager.tsx`
- Modify: `apps/client/src/components/admin/AgentManagerPage.tsx`
- Modify: `apps/client/src/components/admin/ManagedAgentDialog.tsx`
- Modify: `apps/client/src/components/AgentDetailModal.tsx`
- Modify: `apps/client/src/components/AgentArtifact.tsx`
- Modify: `apps/client/src/components/AgentsPage.tsx`
- Modify: `apps/client/src/api.ts`
- Create: `apps/client/test/runtime-host-only-ui.test.mjs`
- Modify: `apps/client/test/agent-artifact-view.test.mjs`

**Step 1: Write failing UI source/render tests**

Assert:

- no `daemon`/`proxy` mode choice or source remains;
- Runtime Host is required for executable Agent forms;
- runtime and strategy have no preselected default;
- Hermes fields are shown only after Hermes is explicitly selected;
- detach-to-legacy behavior is absent.

**Step 2: Simplify types and components**

Use `mode: 'manager'`, `source: 'manager'`, and capability-driven runtime
options. Rename display copy to Runtime Host while retaining API route names.

**Step 3: Verify and commit**

```powershell
npm run build -w client
node --import tsx --test --test-force-exit apps/client/test/runtime-host-only-ui.test.mjs apps/client/test/agent-artifact-view.test.mjs
git add apps/client/src apps/client/test
git commit -m "refactor(client): expose Runtime Host topology only"
```

## Task 6: Implement the ACP transport

**Files**

- Create: `apps/agent-manager/src/lib/runtime/acp/acp-types.ts`
- Create: `apps/agent-manager/src/lib/runtime/acp/acp-client.ts`
- Create: `apps/agent-manager/src/lib/runtime/acp/json-rpc-peer.ts`
- Create: `apps/agent-manager/src/lib/runtime/runtime-events.ts`
- Create: `apps/agent-manager/test/fixtures/fake-acp-server.mjs`
- Create: `apps/agent-manager/test/acp-client.test.mjs`

**Step 1: Write failing protocol tests**

Use the fake child process to cover:

- newline-delimited JSON-RPC request/response correlation;
- notifications and server-to-client requests;
- initialize/session create/load/prompt/cancel/close;
- approval response;
- message/tool/reasoning/usage updates;
- stderr separation and redaction;
- timeout, malformed JSON, EOF, and pending-request rejection.

**Step 2: Implement a bounded JSON-RPC peer**

Use argv-based `spawn`, no shell. Reserve stdout for protocol. Bound line and
message sizes, track request ids, expose `AbortSignal`, and reject all pending
requests on process exit.

**Step 3: Implement ACP method wrappers and event normalization**

Keep ACP wire values in `acp-types.ts`; translate them once into
`RuntimeEvent`. Preserve unknown notifications as sanitized diagnostics
without treating them as completion.

**Step 4: Verify and commit**

```powershell
npm run build -w awb-agent-manager
node --test apps/agent-manager/test/acp-client.test.mjs
git add apps/agent-manager/src/lib/runtime apps/agent-manager/test/fixtures/fake-acp-server.mjs apps/agent-manager/test/acp-client.test.mjs
git commit -m "feat(hermes): add ACP transport"
```

## Task 7: Add the Hermes runtime process and session owner

**Files**

- Create: `apps/agent-manager/src/lib/runtime/hermes/hermes-runtime.ts`
- Create: `apps/agent-manager/src/lib/runtime/hermes/hermes-process.ts`
- Create: `apps/agent-manager/src/lib/runtime/hermes/hermes-session-store.ts`
- Modify: `apps/agent-manager/src/lib/runtime/runtime-registry.ts`
- Modify: `apps/agent-manager/src/lib/managed-agent-context.ts`
- Modify: `apps/agent-manager/src/lib/managed-agent-store.ts`
- Modify: `apps/agent-manager/src/lib/orphan-cleanup.ts`
- Create: `apps/agent-manager/test/hermes-runtime.test.mjs`

**Step 1: Write failing lifecycle tests**

Cover one process per managed Hermes Agent, isolated state/profile paths,
session create/load, run-to-session persistence, cancellation versus close,
restart recovery, and owned process-tree cleanup.

**Step 2: Implement process ownership**

Resolve an explicit configured command or `hermes-acp`, pass a per-Agent state
directory, sanitize environment inheritance, initialize ACP, and mark the
runtime healthy only after handshake.

**Step 3: Implement session ownership**

Bind each session to run id and validated leased cwd. Persist only the recovery
mapping. Refuse to restore a session under a different Agent or worktree
lease.

**Step 4: Verify and commit**

```powershell
npm run build -w awb-agent-manager
node --test apps/agent-manager/test/hermes-runtime.test.mjs
git add apps/agent-manager/src/lib/runtime/hermes apps/agent-manager/src/lib/runtime/runtime-registry.ts apps/agent-manager/src/lib/managed-agent-context.ts apps/agent-manager/src/lib/managed-agent-store.ts apps/agent-manager/src/lib/orphan-cleanup.ts apps/agent-manager/test/hermes-runtime.test.mjs
git commit -m "feat(hermes): own ACP processes and sessions"
```

## Task 8: Route AWB runs through Hermes

**Files**

- Modify: `apps/agent-manager/src/lib/event-dispatcher.ts`
- Modify: `apps/agent-manager/src/lib/prompts.ts`
- Modify: `apps/agent-manager/src/lib/rest.ts`
- Modify: `apps/agent-manager/src/lib/agent-manager-commands.ts`
- Modify: `apps/agent-manager/src/main.ts`
- Create: `apps/agent-manager/src/lib/runtime/runtime-supervisor.ts`
- Create: `apps/agent-manager/test/hermes-dispatch.test.mjs`
- Create: `apps/server/test/qa-flows/hermes-runtime-dispatch.test.mjs`

**Step 1: Write failing dispatch tests**

Exercise ticket and chat runs with the fake ACP server. Assert leased cwd,
system/task context, model/profile, MCP attribution, normalized progress,
completion, usage, cancellation, steering, and typed nack behavior.

**Step 2: Add RuntimeSupervisor routing**

Existing CLI types continue through the existing managers. Hermes routes
through `HermesRuntime`. The dispatcher selects by explicit runtime id and
never crosses from one path to another after a startup failure.

**Step 3: Bridge MCP and approvals**

Register AWB MCP per session with run headers. Forward ACP permission requests
to the AWB approval endpoint and bind responses to run/session/tool call ids.
Strict denies, approve waits with expiry, trusted proceeds only when explicitly
configured.

**Step 4: Verify and commit**

```powershell
npm run build -w awb-agent-manager
npm run build -w server
node --test apps/agent-manager/test/hermes-dispatch.test.mjs
node apps/server/test/run-suite.mjs apps/server/test/qa-flows/hermes-runtime-dispatch.test.mjs
git add apps/agent-manager/src apps/agent-manager/test/hermes-dispatch.test.mjs apps/server/test/qa-flows/hermes-runtime-dispatch.test.mjs
git commit -m "feat(hermes): dispatch AWB runs through ACP"
```

## Task 9: Add governed skill entities and APIs

**Files**

- Create: `apps/server/src/entities/Skill.ts`
- Create: `apps/server/src/entities/SkillVersion.ts`
- Create: `apps/server/src/entities/AgentSkillAssignment.ts`
- Create: `apps/server/src/entities/RunSkillSnapshot.ts`
- Create: `apps/server/src/entities/SkillProposal.ts`
- Modify: `apps/server/src/entities/index.ts`
- Create: `apps/server/src/modules/skills/skills.module.ts`
- Create: `apps/server/src/modules/skills/skills.controller.ts`
- Create: `apps/server/src/modules/skills/skills.service.ts`
- Create: `apps/server/src/modules/skills/skill-validation.ts`
- Modify: `apps/server/src/app.module.ts`
- Create: `apps/server/src/database/migrations/1760000000068-BackfillSkillLifecycle.ts`
- Create: `apps/server/test/skill-lifecycle.test.mjs`

**Step 1: Write failing lifecycle tests**

Cover create, immutable publish, pinned assignment, workspace isolation,
digest stability, duplicate version rejection, proposal states, reviewer
audit, and rejection of traversal/symlink/oversized/secret-bearing content.

**Step 2: Implement entities and service**

Use immutable version rows and explicit state transitions. Compute a canonical
SHA-256 digest from the skill body and ordered support-file manifest.

**Step 3: Implement guarded APIs**

Add list/read/create-version/assign/propose/approve/reject/quarantine endpoints
under workspace permissions. Approval always creates a new version; it never
mutates existing content.

**Step 4: Verify and commit**

```powershell
npm run build -w server
node apps/server/test/run-suite.mjs apps/server/test/skill-lifecycle.test.mjs
git add apps/server/src/entities apps/server/src/modules/skills apps/server/src/app.module.ts apps/server/src/database/migrations/1760000000068-BackfillSkillLifecycle.ts apps/server/test/skill-lifecycle.test.mjs
git commit -m "feat(skills): add versioned governed lifecycle"
```

## Task 10: Pin and materialize run skill snapshots

**Files**

- Create: `apps/server/src/modules/skills/run-skill-snapshot.service.ts`
- Modify: `apps/server/src/modules/agents/dispatch-intent.service.ts`
- Modify: `apps/server/src/modules/events/event-registry.ts`
- Modify: `apps/server/src/common/types/stream-events.ts`
- Create: `apps/agent-manager/src/lib/skills/skill-materializer.ts`
- Modify: `apps/agent-manager/src/lib/event-dispatcher.ts`
- Modify: `apps/agent-manager/src/lib/managed-agent-context.ts`
- Create: `apps/server/test/run-skill-snapshot.test.mjs`
- Create: `apps/agent-manager/test/skill-materializer.test.mjs`

**Step 1: Write failing snapshot tests**

Assert deterministic ordering/digests, immutability after dispatch ack,
snapshot persistence across later publication, role/board assignment
resolution, materialization into a private run directory, and fail-closed
digest/path behavior.

**Step 2: Resolve snapshot before dispatch**

Create and persist the snapshot in the same logical dispatch preparation
boundary. Send only pinned ids, digests, and bounded file data/reference.

**Step 3: Materialize on Runtime Host**

Write under the owned run harness directory using safe relative paths and
atomic replacement. Point Hermes at this directory and inject a bounded
manifest into other runtime prompts.

**Step 4: Verify and commit**

```powershell
npm run build -w server
npm run build -w awb-agent-manager
node apps/server/test/run-suite.mjs apps/server/test/run-skill-snapshot.test.mjs
node --test apps/agent-manager/test/skill-materializer.test.mjs
git add apps/server/src apps/server/test/run-skill-snapshot.test.mjs apps/agent-manager/src apps/agent-manager/test/skill-materializer.test.mjs
git commit -m "feat(skills): pin immutable run snapshots"
```

## Task 11: Add Skill Proposals and Hermes child collaboration

**Files**

- Create: `apps/server/src/entities/ChildRun.ts`
- Modify: `apps/server/src/entities/index.ts`
- Create: `apps/server/src/modules/skills/skill-proposal-mcp.tools.ts`
- Modify: `apps/server/src/modules/mcp/internal/create-mcp-server.ts`
- Create: `apps/server/src/modules/agents/child-run.service.ts`
- Modify: `apps/server/src/modules/agents/agents.module.ts`
- Modify: `apps/agent-manager/src/lib/runtime/hermes/hermes-runtime.ts`
- Modify: `apps/agent-manager/src/lib/runtime/runtime-events.ts`
- Create: `apps/server/test/hermes-collaboration.test.mjs`
- Create: `apps/agent-manager/test/hermes-collaboration.test.mjs`

**Step 1: Write failing collaboration tests**

Cover:

- `single` rejects runtime child creation;
- `delegated` enforces depth, concurrency, child budget, tool subset, and skill
  subset;
- child start/finish events persist under the parent run;
- children cannot perform terminal ticket transitions or consensus actions;
- runtime-created skills become pending proposals only;
- `swarm` rejects when the host does not advertise the capability.

**Step 2: Persist bounded Child Runs**

Store attribution, status, budget, timestamps, and sanitized summary. Keep
Hermes-native detail as runtime metadata, not a new durable AWB Agent.

**Step 3: Expose proposal-only MCP**

Allow a run to create a bounded SkillProposal with its own source attribution.
Do not expose approve/apply endpoints to runtime Agent credentials.

**Step 4: Enable strategy controls**

For delegated mode, configure Hermes delegation bounds and normalize child
events. Enable swarm only when the explicit capability probe is healthy; never
fall back from swarm to delegated/single.

**Step 5: Verify and commit**

```powershell
npm run build -w server
npm run build -w awb-agent-manager
node apps/server/test/run-suite.mjs apps/server/test/hermes-collaboration.test.mjs
node --test apps/agent-manager/test/hermes-collaboration.test.mjs
git add apps/server/src apps/server/test/hermes-collaboration.test.mjs apps/agent-manager/src apps/agent-manager/test/hermes-collaboration.test.mjs
git commit -m "feat(hermes): govern child runs and skill proposals"
```

## Task 12: Add skill and run UI

**Files**

- Modify: `apps/client/src/types.ts`
- Modify: `apps/client/src/api.ts`
- Create: `apps/client/src/components/admin/SkillsPage.tsx`
- Create: `apps/client/src/components/admin/SkillProposalReview.tsx`
- Modify: `apps/client/src/components/AgentDetailModal.tsx`
- Modify: `apps/client/src/App.tsx`
- Create: `apps/client/test/skill-governance-ui.test.mjs`
- Create: `apps/client/test/hermes-child-runs-ui.test.mjs`

**Step 1: Write failing UI tests**

Assert catalog/version/assignment/proposal decisions, immutable digest
evidence, and collapsible Child Runs. Ensure runtime credentials cannot see
review/apply actions.

**Step 2: Implement minimal operational UI**

Prefer existing admin design language. Keep the AWB board primary; link to
Hermes diagnostics only when Runtime Host reports a URL and never embed an
external UI as the control plane.

**Step 3: Verify and commit**

```powershell
npm run build -w client
node --import tsx --test --test-force-exit apps/client/test/skill-governance-ui.test.mjs apps/client/test/hermes-child-runs-ui.test.mjs
git add apps/client/src apps/client/test
git commit -m "feat(client): manage skills and Hermes child runs"
```

## Task 13: Documentation, versioning, and compatibility cleanup

**Files**

- Modify: `apps/agent-manager/package.json`
- Modify: `package-lock.json`
- Modify: `docs/agent-manager.md`
- Create: `docs/hermes-runtime.md`
- Modify: `docs/architecture/modules.md`
- Modify: comments containing obsolete standalone topology in touched files

**Step 1: Document the operator contract**

Include installation of Hermes ACP extras, host probe diagnostics, explicit
Agent configuration, strategies, permission modes, skill proposal review,
session recovery, and error code troubleshooting.

**Step 2: Bump Runtime Host version**

Apply the repository's Agent Manager release convention and synchronize the
lockfile. Describe the compatibility alias from Agent Manager to Runtime Host.

**Step 3: Run obsolete-path searches**

```powershell
rg -n "mode: 'daemon'|mode: 'proxy'|source: 'proxy'|proxySessions|detach to legacy|fall back to the claude|manager_agent_id = null for legacy" apps docs
```

Only historical migration/read-compatibility text may remain.

**Step 4: Commit**

```powershell
git add apps/agent-manager/package.json package-lock.json docs apps
git commit -m "docs: document Hermes Runtime Host operation"
```

## Task 14: Full verification

**Step 1: Run focused suites**

```powershell
npm run test -w awb-agent-manager
npm run test -w client
npm run test:qa:fast -w server
```

**Step 2: Run package and root builds**

```powershell
npm run build -w awb-agent-manager
npm run build -w server
npm run build -w client
npm run build
```

**Step 3: Run the full server suite**

```powershell
npm run test -w server
```

**Step 4: Optional live Hermes smoke**

When `hermes-acp` is installed, run the opt-in smoke test against a temporary
workspace and mock AWB MCP endpoint. Verify initialize, tool call, approval,
usage, cancel, session reload, and clean process exit. If it is not installed,
report the live smoke as skipped while retaining fake-ACP coverage.

**Step 5: Inspect final state**

```powershell
git status --short
git log --oneline --decorate -15
git diff main...HEAD --check
```

Do not claim completion until all mandatory commands pass or every remaining
failure is demonstrated to be pre-existing and unrelated.
