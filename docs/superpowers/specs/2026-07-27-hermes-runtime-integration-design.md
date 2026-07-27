# Hermes Runtime Integration and Harness Design

## Decision

AWB remains the control plane. The existing `awb-agent-manager` process becomes
the only execution host and is presented as **Runtime Host** in product
language. Hermes is added as an agent runtime hosted by that process; it does
not replace AWB's scheduler, ticket state machine, policy engine, worktree
leases, credentials, audit log, or approval system.

The Hermes integration uses the official `hermes-acp` stdio server and Agent
Client Protocol (ACP). Direct Hermes Gateway-to-AWB execution and text-only
`hermes` CLI scraping are intentionally excluded from the primary path.

All executable AWB agents must therefore satisfy both conditions:

1. they are attached to a connected Runtime Host; and
2. they have an explicitly configured runtime.

There is no implicit runtime default and no unknown-runtime fallback. Missing
or unavailable runtime configuration fails closed.

## Why This Boundary

The three codebases point to the same division of responsibility:

- AWB already has the durable project control plane: tickets, roles, dispatch
  intents, worktree leases, hard budgets, consensus, approvals, credentials,
  and audit records.
- Hermes has the stronger model loop: context compression, native tool
  execution, steering, approvals, resumable sessions, delegation, profiles,
  and a maintained ACP server.
- OpenClaw separates its Gateway control plane from external coding harnesses,
  runs those harnesses through ACP, records their work as managed background
  tasks, and keeps routing and policy in the Gateway. It also treats
  self-learning as a proposal queue rather than permitting direct mutation of
  live skills.

Putting Hermes directly beside Agent Manager would create two authorities for
process lifetime, repository ownership, credentials, and ticket transitions.
Embedding or reimplementing Hermes' model loop in AWB would duplicate the most
complex and fastest-changing part of an agent system. Hosting Hermes through
ACP preserves one authority for each concern.

## Terminology

| Term | Responsibility |
| --- | --- |
| AWB Control Plane | Durable project state, scheduling, RBAC, budgets, approvals, audit, and skill governance |
| Runtime Host | The current `awb-agent-manager` binary; owns local processes, credentials, worktrees, leases, heartbeats, and protocol adapters |
| Agent | A durable AWB identity with roles, permissions, runtime selection, and accountability |
| Runtime | The model loop that executes a prepared run, such as Claude, Codex, PI, Antigravity, or Hermes |
| Harness | The adapter contract between Runtime Host and a runtime |
| Run | One accountable execution of a ticket, chat turn, action, QA job, or security job |
| Child Run | Ephemeral work delegated by a parent runtime during one AWB run |
| Skill Snapshot | The immutable, approved skill set materialized for one run |
| Skill Proposal | A candidate skill change that cannot become active without review |

The package and API compatibility name `agent-manager` remains during the
migration. New UI copy and new domain interfaces use Runtime Host. A binary
rename can happen later without mixing protocol migration with packaging work.

## Goals

- Add Hermes as a first-class runtime without weakening AWB controls.
- Remove all executable agent paths that bypass Runtime Host.
- Replace implicit runtime behavior with explicit, validated selection.
- Preserve existing Claude, Codex, PI, DeepSeek, and Antigravity execution.
- Normalize runtime events, capabilities, sessions, approvals, and usage.
- Support Hermes single-agent and delegated collaboration inside one AWB run.
- Establish an AWB-owned, versioned skill lifecycle with immutable run
  snapshots and reviewable proposals.
- Make failures attributable: selection, host availability, runtime startup,
  protocol, policy, skill materialization, and run execution are distinct.

## Non-goals

- Replacing the AWB board with Hermes Dashboard, Hermes WebUI, or another UI.
- Letting Hermes own ticket transitions, assignment, global budgets, or
  repository leases.
- Reimplementing Hermes' agent loop inside TypeScript.
- Treating Hermes child agents as durable AWB identities by default.
- Automatically publishing a skill written by a runtime.
- Making every runtime expose identical features. Unsupported capabilities are
  explicit instead of emulated invisibly.

## Architecture

```text
AWB client
    |
AWB server (control plane)
    |  durable DispatchIntent / Run / Approval / SkillSnapshot
    |  authenticated SSE + REST + MCP
Runtime Host (current awb-agent-manager)
    |  worktree + credential + process + lease ownership
    |  RuntimeAdapter contract
    +-- Claude/Codex/PI/Antigravity adapters
    +-- Hermes ACP adapter
            |
            +-- hermes-acp stdio JSON-RPC process
                    |
                    +-- Hermes session / native tools / delegate_task
                    +-- child agents or bounded swarm workers
```

The outer boundary is always an AWB Run. Runtime-native sessions, threads, and
children are subordinate resources linked to that Run.

## Runtime Selection

`Agent.type` currently mixes identity and CLI selection. During this change it
remains the persisted compatibility field but is treated as `runtime_id` by
new code. Valid executable values are explicit registry entries:

- `claude`
- `deepseek`
- `codex`
- `antigravity`
- `pi`
- `hermes`

`manager` remains a non-executable Runtime Host identity. `custom` is not a
valid executable runtime until a registered adapter claims it.

New selection rules:

1. Agent creation requires a known runtime id for executable agents.
2. An executable Agent requires `manager_agent_id`.
3. The linked Runtime Host heartbeat must advertise that runtime as available.
4. The configured model/profile/strategy must be accepted by that runtime's
   capability descriptor.
5. Failure at any step prevents dispatch.

`createAdapter()` must not default to Claude and must not map unknown values to
Claude. It returns a typed selection error. Existing rows are diagnosed and
made inactive when their intent cannot be migrated safely.

Runtime-specific configuration is stored in a structured
`runtime_config` value. Its common shape is:

```ts
interface AgentRuntimeConfig {
  strategy: 'single' | 'delegated' | 'swarm';
  permission_mode: 'strict' | 'approve' | 'trusted';
  profile?: string;
  max_children?: number;
  max_iterations?: number;
  extra?: Record<string, unknown>;
}
```

There is no default strategy or permission mode at the API boundary. Existing
agents receive an explicit migration value derived from their current behavior
(`single` plus their current effective permission setting); new requests must
send both values.

## Runtime Host Contract

Every adapter publishes a capability descriptor rather than two boolean
capabilities:

```ts
interface RuntimeCapabilities {
  protocol: 'stream-json' | 'jsonl' | 'acp';
  session: 'oneshot' | 'persistent' | 'resumable';
  native_mcp: boolean;
  native_approvals: boolean;
  steering: boolean;
  cancellation: boolean;
  usage: 'none' | 'tokens' | 'tokens-and-cost';
  collaboration: Array<'delegated' | 'swarm'>;
  skill_delivery: Array<'prompt' | 'filesystem' | 'native'>;
}
```

The Runtime Host exposes the installed/healthy descriptor for each runtime in
its heartbeat. AWB validates assignment and dispatch against the descriptor.
UI controls are capability-driven; a runtime without steering does not show a
steer action, for example.

All adapters emit one normalized event stream:

```ts
type RuntimeEvent =
  | { type: 'session_started'; runtime_session_id: string }
  | { type: 'message_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_started'; call_id: string; name: string; input?: unknown }
  | { type: 'tool_completed'; call_id: string; output?: unknown }
  | { type: 'approval_requested'; approval: RuntimeApproval }
  | { type: 'usage'; usage: RuntimeUsage }
  | { type: 'child_started'; child: ChildRunRef }
  | { type: 'child_completed'; child: ChildRunRef; status: string }
  | { type: 'completed'; result?: string }
  | { type: 'failed'; error: RuntimeError };
```

Existing stdout parsers are adapted to this contract incrementally. The
server-visible event shape remains backward compatible during rollout.

## Hermes ACP Adapter

### Process model

Runtime Host starts one `hermes-acp` process per managed Hermes Agent. This
provides credential/profile isolation and permits multiple sessions without
mixing durable AWB identities. Stdout is reserved for ACP JSON-RPC; all
diagnostics are read from stderr and sanitized before upload.

The adapter performs:

1. executable resolution and health probe;
2. ACP `initialize`;
3. session create or load with the leased run worktree as `cwd`;
4. model/profile and MCP server configuration;
5. prompt dispatch;
6. translation of ACP updates to `RuntimeEvent`;
7. AWB approval resolution back to ACP;
8. cancellation, steering, and orderly session/process close.

Runtime Host persists only the mapping needed to recover:

```text
AWB run id -> agent id -> ACP session id -> worktree lease id
```

Hermes owns its canonical session history. AWB stores the normalized event and
message mirror required for audit and UI, not a second editable copy of Hermes
internals.

### MCP

AWB's Streamable HTTP MCP server is injected into each Hermes ACP session with
the run-scoped headers already used by managed agents:

- `Authorization`
- `X-AWB-Client-Type`
- `X-AWB-Subagent-Ticket-Id`
- `X-AWB-Subagent-Role`
- `X-AWB-Subagent-Trigger-Source`
- `X-AWB-Subagent-Trigger-Id`

The API key remains in the Runtime Host credential boundary. It must not be
written into prompts, event logs, skill files, or Hermes result text.

Hermes native tools remain subject to Runtime Host/AWB permission policy.
Native ACP approval requests are forwarded to AWB when the effective mode is
`approve`, denied when `strict` disallows the operation, and may proceed
headlessly only when an operator explicitly chose `trusted`.

### Sessions and recovery

- Ticket work uses a ticket/run-bound session.
- Chat uses a room/agent-bound persistent session.
- Restart recovery first attempts ACP session load.
- If the Hermes session cannot be restored, the run is marked recoverable and
  a new session may be created only with AWB's compacted context and the same
  valid lease.
- Runtime Host restart never silently claims a new worktree or changes a
  ticket state.
- Cancel stops the active turn; close ends the Runtime Host binding. These are
  separate operations.

### Collaboration

Hermes collaboration is subordinate to one AWB run:

- `single`: no runtime-requested child work.
- `delegated`: Hermes may use `delegate_task` within configured depth,
  concurrency, tool, and budget limits.
- `swarm`: Runtime Host may launch the Hermes Kanban/Swarm coordinator only
  when that capability is installed and healthy.

Hermes child workers are Child Runs, not durable AWB Agents. They inherit:

- the parent run id;
- a bounded child budget;
- a subset of tools and skills;
- the parent's outer worktree lease;
- isolated nested working directories where Hermes requires them.

Only the top-level AWB Agent can claim the ticket role, call ticket terminal
transitions, or satisfy consensus. Child work is evidence/artifact production.
This prevents one logical assignment from appearing as several independently
accountable actors.

Swarm uses Hermes' local coordinator for within-run scheduling only. AWB does
not mirror the entire Hermes Kanban board into AWB tickets. If a worker must
own a durable backlog item, it becomes a normal AWB ticket and Agent instead
of a hidden child.

## Removal of Standalone Execution

The following execution modes are removed:

- proxy sessions sourced from a bare editor/plugin process;
- daemon mode that executes an Agent without a Runtime Host link;
- managerless `manager_agent_id = null` executable Agents;
- server event routing branches that synthesize or proxy unmanaged sessions;
- UI choices and types for `daemon` and `proxy`;
- autostart behavior that tolerates an executable Agent without a host;
- unknown/custom runtime fallback to Claude.

The following are retained:

- Agent as a domain identity;
- Runtime Host manager identity and pairing;
- MCP tools and external callers that do not execute an AWB Agent;
- audit/history records produced by old proxy sessions;
- read-only display of historical sessions where required for compatibility.

Migration is conservative:

1. Runtime Host identities remain valid.
2. Executable Agents with a valid host remain active.
3. Managerless executable Agents are set inactive and receive a diagnostic
   reason; they are not auto-attached to an arbitrary host.
4. Legacy session/history rows remain readable but cannot resume.
5. New writes cannot create the removed topology.

## Skill Lifecycle

AWB is the organizational source of truth for skills. Runtime-local personal
skills are separate and are not silently promoted into AWB.

### Entities

`Skill`

- stable id, workspace scope, slug, title, description, status;
- origin (`manual`, `imported`, `runtime-proposal`);
- owner and audit timestamps.

`SkillVersion`

- immutable version number;
- `SKILL.md` body and bounded support-file manifest;
- content digest;
- compatibility requirements and security scan result;
- publisher and publication timestamp.

`AgentSkillAssignment`

- Agent id;
- Skill id and pinned SkillVersion id;
- enabled flag;
- optional role or board scope.

`RunSkillSnapshot`

- Run id;
- ordered list of pinned version ids and digests;
- materialization status and location;
- immutable after dispatch acknowledgement.

`SkillProposal`

- proposed create or revision;
- source run/runtime/agent;
- base SkillVersion when revising;
- content and support-file manifest;
- status (`pending`, `approved`, `rejected`, `quarantined`);
- reviewer decision and reason.

### Delivery

At dispatch, AWB resolves assignments and policy into an immutable
RunSkillSnapshot. Runtime Host verifies digests and materializes only that
snapshot into the run's private harness directory. It never points Hermes at a
mutable global organizational skill directory.

Runtime adapters receive skills according to capability:

- filesystem-native runtimes get a generated skill directory;
- prompt-only runtimes get bounded skill cards or selected bodies;
- runtimes with native skill registration receive the same pinned snapshot.

Location and authorization are separate. A file being present does not grant
its required tools; tool policy, sandboxing, OS credentials, and MCP scopes
remain independent controls.

### Learning and promotion

Hermes self-improvement or any runtime-generated skill change writes a
SkillProposal. It cannot update a published SkillVersion, change assignments,
or materialize into an active run.

Proposal generation runs with a narrow tool surface and one bounded mutation
budget. Secret scanning, size limits, path traversal checks, and support-file
allowlists run before persistence. Approval creates a new immutable version;
it does not rewrite snapshots of active or historical runs.

This follows the useful OpenClaw Skill Workshop invariant: learned procedures
remain proposals until an operator explicitly applies them.

## Prompt and Context Assembly

AWB composes control-plane context:

- agent role and board/column policy;
- ticket objective, constraints, and prerequisites;
- worktree and branch contract;
- approval and tool policy;
- skill snapshot manifest;
- budget and collaboration limits;
- attribution metadata.

The runtime owns model-loop context:

- transcript encoding;
- native tool continuation;
- compaction;
- retry and overflow recovery;
- native reasoning and message streaming.

AWB may mirror compacted summaries but does not inject prompt text that
pretends to be protocol state. Structured fields are preferred whenever the
runtime exposes them.

## Error Model

Errors have stable categories and do not silently fall back:

| Code | Meaning |
| --- | --- |
| `runtime_not_configured` | Executable Agent has no explicit runtime |
| `runtime_unknown` | Runtime id is not registered |
| `runtime_host_required` | Executable Agent is not linked to a Runtime Host |
| `runtime_host_offline` | Linked host is unavailable |
| `runtime_unavailable` | Host does not advertise a healthy selected runtime |
| `runtime_config_invalid` | Strategy/profile/permission config is invalid |
| `runtime_start_failed` | Runtime process could not start or initialize |
| `runtime_protocol_error` | ACP/stream protocol was malformed or disconnected |
| `runtime_approval_denied` | Required operation was denied or expired |
| `skill_snapshot_failed` | Pinned skills could not be verified/materialized |
| `runtime_session_lost` | Runtime-native session cannot be restored |

DispatchIntent remains pending or is explicitly nacked according to the
existing retry policy. A failure before runtime acknowledgement never appears
as a successfully started Agent.

## API and UI Changes

- Admin navigation and copy use Runtime Hosts.
- Agent create/edit requires Runtime Host, runtime, strategy, and permission
  mode for executable agents.
- Runtime options come from connected host capability heartbeats.
- Hermes exposes profile/model plus strategy-specific bounds.
- Removed proxy/daemon selectors and proxy session controls disappear.
- Agent detail shows top-level Runs and collapsible Child Runs.
- Skill screens provide catalog, pinned assignments, snapshot evidence, and
  proposal review.
- Runtime error codes are rendered as actionable diagnostics rather than a
  generic offline state.

No runtime is preselected in the UI. If the operator has not configured one,
the form and dispatch explain what is missing.

## Security Invariants

- Runtime Host is the only process allowed to receive an Agent API key.
- Run-scoped credentials are never persisted in prompts or skill content.
- Worktree paths are resolved and validated by Runtime Host.
- Child agents cannot broaden parent tool, skill, credential, or budget scope.
- Approval responses bind to run, session, and tool call ids and expire.
- ACP stdout is parsed as protocol only; human diagnostics use stderr.
- Skill archives reject absolute paths, traversal, symlinks, oversized files,
  and recognized credentials.
- Historical snapshots and decisions are immutable audit evidence.

## Delivery Phases

### Phase 1: topology and explicit runtime

- introduce the capability registry and typed selection errors;
- remove Claude fallback;
- require Runtime Host for executable Agents;
- remove proxy/daemon server and client execution branches;
- migrate invalid legacy Agents to inactive diagnostics.

### Phase 2: Hermes ACP

- add process/client/session implementation;
- add Hermes runtime discovery and heartbeat capability;
- bridge MCP, events, usage, approval, cancellation, and steering;
- add single and delegated strategies;
- add runtime/session recovery tests.

### Phase 3: governed skills and collaboration

- add skill catalog, immutable versions, assignments, and run snapshots;
- materialize pinned snapshots for adapters;
- add proposals and review lifecycle;
- add bounded Child Run persistence;
- enable swarm only behind an advertised healthy capability.

Each phase is independently buildable and testable. Compatibility shims may
exist between phases, but removed standalone execution cannot be re-enabled by
fallback.

## Testing

### Unit

- exact runtime selection and unknown/missing failures;
- capability validation for strategies and controls;
- ACP framing, request correlation, notifications, cancellation, and stderr;
- normalized event translation;
- permission decisions and approval expiry;
- skill digest, snapshot ordering, materialization, and path safety;
- proposal lifecycle and immutability;
- child budget/tool/skill subset validation.

### Server integration

- executable Agent creation rejects missing host/runtime/config;
- Runtime Host heartbeat advertises Hermes health and capabilities;
- DispatchIntent ack/nack behavior for every runtime error category;
- no endpoint creates or resumes proxy/daemon sessions;
- managerless legacy Agent is inactive but its history remains readable;
- snapshot is fixed at dispatch and survives later skill publication;
- only top-level Agent can transition a ticket.

### Runtime Host integration

- fake ACP server covers initialize, session create/load, prompt, tool events,
  approval, usage, completion, disconnect, and malformed messages;
- optional live `hermes-acp` smoke test runs when Hermes is installed;
- MCP credentials and attribution reach the child environment/session but not
  logs;
- process tree cleanup leaves no owned orphan;
- delegated children remain within configured concurrency/depth/budget.

### Client

- no proxy/daemon controls remain;
- no runtime is selected by default;
- capability-driven Hermes settings render correctly;
- runtime diagnostics and skill proposal decisions are visible.

### Completion gate

- Agent Manager, server, and client focused tests pass;
- each package builds;
- root build passes;
- repository search finds no executable proxy/daemon topology branch;
- a managed Hermes smoke run can call an AWB MCP tool, request approval, emit
  progress, and finish without bypassing Runtime Host.

## Source Notes

The Hermes contract was checked against the official
`NousResearch/hermes-agent` repository at commit `8c36cd4`, including
`acp_adapter`, session handling, tool registry, approvals, delegation, profiles,
and Kanban/Swarm behavior.

The comparison with OpenClaw was checked against the official
`openclaw/openclaw` repository at commit `1fe66e0`, especially its runtime
ownership contract, external ACP harness path, per-agent workspace boundaries,
managed worktrees, skill allowlists/snapshots, and Skill Workshop proposal
lifecycle.
