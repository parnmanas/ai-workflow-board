# Runtime Host (`awb-agent-manager`)

`awb-agent-manager` is AWB's host-side execution service. The package, binary,
configuration directory, and HTTP routes keep their existing names for
compatibility, but the architectural role is **Runtime Host**, not an
independent Agent and not an agent hierarchy.

## AWB entity references

User-visible Ticket, Agent, Board, Action, Function, and Schedule references use
`#[type:<full-uuid>|Human-readable name]`, never a shortened ID alone. MCP
results expose the canonical token as `_ref`; use that value in chat, comments,
and Run results. See [entity-references.md](entity-references.md) for resolution,
context, and fallback rules.

The Runtime Host owns the resources that must live on an execution machine:

- the authenticated SSE/REST connection to AWB;
- one isolated working environment and credential boundary per AWB Agent;
- runtime process lifecycle, cancellation, recovery, and health reporting;
- delivery of immutable skill snapshots;
- protocol adapters, including Hermes over ACP stdio;
- bounded ChildRun telemetry for runtime-native collaboration.

AWB remains the control plane. It owns Agent identity, authorization, work
state, audit history, runtime selection, collaboration policy, and governed
skills.

See [Hermes runtime](hermes-runtime.md) for Hermes installation and policy
examples.

## Identity model

| Concept | Lifetime | Purpose |
|---|---|---|
| Runtime Host | machine/process | Executes configured runtimes and reports capabilities |
| AWB Agent | durable database identity | Owns responsibilities, permissions, assignments, and history |
| Hermes ChildRun | bounded child of one parent run | Performs temporary delegated or swarm work |

A ChildRun is never promoted to an AWB Agent. Create another AWB Agent only
when the participant needs durable responsibility, separate authorization, an
independent queue, or long-lived history.

Every executable Agent must have:

1. a `manager_agent_id` identifying its Runtime Host;
2. an explicit runtime id (`type`);
3. an explicit `runtime_config`.

There is no default runtime, default strategy, or fallback to an editor/plugin
session. A missing, unknown, unavailable, or invalid runtime fails with a
typed error instead of silently changing execution semantics.

## Host topology

```text
AWB server (control plane)
  ├─ Agent/runtime configuration
  ├─ events, permissions, audit, skills
  └─ Runtime Host API + SSE
             │
             ▼
awb-agent-manager (execution plane)
  ├─ capability heartbeat
  ├─ managed Agent isolation
  ├─ classic CLI adapters
  └─ Hermes ACP process owner
       ├─ one process per durable AWB Agent
       ├─ resumable session per AWB run
       └─ bounded ChildRuns
```

The historical package/API label `agent-manager` is therefore a compatibility
alias. New UI and documentation should say **Runtime Host**.

## Installation and pairing

```bash
npm i -g awb-agent-manager
awb-agent-manager setup
awb-agent-manager service install
```

The setup flow redeems a one-time pairing token created in **Admin → Runtime
Hosts** and writes host configuration under `$AWB_AGENT_MANAGER_HOME` (or the
platform configuration directory).

Useful commands:

```bash
awb-agent-manager --version
awb-agent-manager --dry-run
awb-agent-manager service install --dry-run
awb-agent-manager service uninstall
```

## Runtime selection contract

Runtime ids currently registered by the host are `claude`, `deepseek`,
`codex`, `antigravity`, `pi`, and `hermes`. Only Hermes is owned through the
ACP process supervisor; the others keep their explicit CLI adapter path.

```json
{
  "strategy": "single",
  "permission_mode": "strict",
  "profile": "optional-runtime-profile",
  "max_children": 3,
  "max_iterations": 3,
  "extra": {}
}
```

- `strategy`: `single`, `delegated`, or `swarm`. Non-Hermes runtimes currently
  support only `single`.
- `permission_mode`: `strict`, `approve`, or `trusted`.
- `profile`: optional runtime-native model/profile name.
- `max_children` and `max_iterations`: bounded collaboration budgets.
- `extra`: runtime-specific policy such as child depth, concurrency, tools,
  and skills.

The server validates the same contract as the host. This prevents invalid
configurations from being stored and protects execution if old or manually
edited data reaches the host.

## Capability and health reporting

The Runtime Host heartbeat advertises each runtime's protocol, session mode,
MCP support, approval support, cancellation/steering support, usage reporting,
collaboration strategies, and skill-delivery modes. Scheduling must use this
live capability report; it must not infer availability from a runtime name.

For Hermes, a successful ACP `initialize` handshake is the health probe. A
`swarm` run is rejected if the probe is not healthy and is never downgraded.

## Process and session ownership

- Hermes has exactly one isolated ACP process per durable AWB Agent.
- Each AWB run maps to one Hermes session with an Agent id and lease id.
- Restore requires the same Agent and lease.
- Cancel interrupts work but retains the recovery mapping.
- Close removes the mapping. ACP implementations without the optional
  `session/close` extension are supported.
- Stop/restart removes the process owner and on-disk ownership marker.
- Startup cleanup terminates orphaned processes owned by a dead Runtime Host.

## Security boundaries

- API keys and credentials remain scoped to the managed Agent.
- Hermes stdout is reserved for ACP JSON-RPC; diagnostics use stderr.
- MCP requests include Agent id, AWB run id, client type, and strategy.
- Skill files are materialized privately after digest verification.
- ChildRun metadata and summaries are bounded and secret-sanitized.
- ChildRuns cannot perform terminal ticket transitions, consensus actions, or
  skill publication.

## Durable send outbox

Chat replies, silent-exit audit comments, and dispatch/command acknowledgements
that fail while AWB is temporarily unreachable are persisted to
`$AWB_AGENT_MANAGER_HOME/outbox.json`. The Runtime Host rehydrates this FIFO
queue at startup and retries it when SSE reconnects, with a 60-second periodic
backstop for isolated REST failures.

Only retryable transport failures and HTTP 5xx, 408, or 429 responses enter the
queue. Other 4xx responses are permanent failures. Time-sensitive progress,
output-liveness, and filesystem-response traffic is never buffered.

| Kind | Source | TTL |
|---|---|---|
| `chat_message` | Real `postChatRoomMessage` replies; progress heartbeats excluded | 24h |
| `silent_exit_comment` | `postSilentExitSystemComment` | 24h |
| `dispatch_ack` | `postDispatchAck`, deduplicated by `trigger_id` server-side | 15min |
| `command_ack` | `postCommandAck` | 1h |

Delivery is at-least-once and FIFO. A flush stops at the first retryable
failure, entries are persisted after every queue mutation, and the queue is
capped at 500 entries by dropping the oldest. A corrupt outbox is discarded
without blocking Runtime Host startup. Replay calls transport-only `*Raw`
senders so a failed replay cannot enqueue a duplicate copy of itself.

## Troubleshooting

| Error | Meaning | Operator action |
|---|---|---|
| `runtime_not_configured` | Agent has no explicit runtime | Select a runtime and save its config |
| `runtime_unknown` | Runtime id is not registered | Correct the Agent type or deploy a supporting host |
| `runtime_unavailable` | Runtime cannot start/probe | Check heartbeat, executable, credentials, and PATH |
| `runtime_config_invalid` | Strategy/permission/bounds are invalid | Correct the runtime configuration |
| `runtime_collaboration_denied` | Child exceeded policy | Inspect depth/concurrency/tool/skill allowlists |
| `acp_timeout` | Hermes did not answer in time | Check Hermes stderr, provider health, and host load |
| `acp_process_exited` | Hermes terminated | Check Runtime Host logs and provider credentials |
| `acp_malformed_message` | stdout was not ACP JSON-RPC | Send wrapper diagnostics to stderr |

Protocol-level smoke check:

```bash
hermes acp --check
hermes acp --version
```

Use Hermes-native UIs only for runtime diagnostics. AWB is the authoritative
project UI because it owns the work graph, identities, permissions, skills,
and audit trail.
