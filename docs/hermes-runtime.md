# Hermes runtime

Hermes is an optional reasoning runtime behind AWB's Runtime Host. AWB does
not embed Hermes' dashboard and does not delegate project control to Hermes.
The integration uses the official Agent Client Protocol (ACP) stdio server:
newline-delimited JSON-RPC on stdout and diagnostics on stderr.

Official references:

- [Hermes ACP editor integration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/acp.md)
- [Hermes programmatic integration](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md)
- [Agent Client Protocol](https://agentclientprotocol.com/)

## Why ACP

Hermes offers ACP, a TUI gateway, and an HTTP API. AWB uses ACP because it
provides a typed lifecycle for initialization, sessions, prompts, streaming
updates, tool calls, permission requests, cancellation, and usage. Scraping a
CLI or sharing a dashboard transport would couple AWB to presentation details
and weaken process ownership.

## Installation

Install Hermes using its official installer, then ensure the ACP extra is
available. From a Hermes source installation:

```bash
cd ~/.hermes/hermes-agent
uv pip install -e '.[acp]'
hermes acp --check
```

Equivalent entry points:

```bash
hermes acp
hermes-acp
python -m acp_adapter
```

The Runtime Host starts `hermes-acp` by default. Override only the executable
path when necessary:

```bash
export HERMES_ACP_COMMAND=/absolute/path/to/hermes-acp
awb-agent-manager
```

The host creates an isolated `HERMES_HOME` below each managed Agent directory.
Provider credentials must be available to the Runtime Host service account.

## Agent configuration

Hermes is never selected implicitly. Configure the Agent with `type: "hermes"`,
a Runtime Host owner, and one of the following policies.

### Single

Use this for most Agents. Hermes reasons and uses tools but cannot create a
runtime child.

```json
{
  "strategy": "single",
  "permission_mode": "strict"
}
```

### Delegated

Use this when a parent can split bounded subtasks. Each child is a ChildRun,
not another AWB Agent.

```json
{
  "strategy": "delegated",
  "permission_mode": "trusted",
  "max_children": 3,
  "max_iterations": 3,
  "extra": {
    "max_depth": 2,
    "max_concurrency": 2,
    "allowed_child_tools": ["read_file", "search_files", "terminal"],
    "allowed_child_skills": ["repository-analysis@3"]
  }
}
```

### Swarm

Use this only when peer-style parallel exploration materially improves the
task and the host reports a healthy Hermes ACP capability probe.

```json
{
  "strategy": "swarm",
  "permission_mode": "trusted",
  "max_children": 5,
  "max_iterations": 5,
  "extra": {
    "max_depth": 2,
    "max_concurrency": 3,
    "allowed_child_tools": ["read_file", "search_files"],
    "allowed_child_skills": ["repository-analysis@3", "test-review@2"]
  }
}
```

Swarm is not a durable team model. It is a runtime strategy inside one parent
run. If participants need separate queues, identities, authorization, or
long-lived accountability, create multiple AWB Agents instead.

## Permission modes

- `strict`: cancels ACP permission requests and forbids child creation.
- `approve`: delegates to an operator approval bridge. The current Runtime
  Host baseline has no such bridge, so it fails closed.
- `trusted`: selects an ACP allow option when offered, while all AWB and
  collaboration policy remains enforced.

For unattended deployments, prefer `strict` for single Agents. Use `trusted`
only with narrow tool/skill allowlists and host-level isolation.

## Collaboration enforcement

The Runtime Host validates native delegation events and permission requests:

- strategy support and a healthy ACP probe for swarm;
- total child, iteration, depth, and concurrency limits;
- exact child tool and skill subsets;
- no child terminal ticket transitions;
- no child consensus decisions;
- proposal-only skill changes.

Violations emit `collaboration/denied` and cancel the parent run. ChildRun
start/finish records contain bounded, sanitized telemetry for the AWB UI.

## Skills

AWB, not Hermes, is the skill authority:

1. An administrator publishes an immutable SkillVersion.
2. An exact version is assigned by Agent and optional board/role scope.
3. Dispatch creates a deterministic RunSkillSnapshot.
4. The snapshot locks after dispatch acknowledgement.
5. The Runtime Host verifies snapshot and file digests.
6. Files are materialized privately and injected into Hermes.
7. Runtime learning may create a pending proposal only.
8. A human rejects it or publishes a new immutable version.

Never let a runtime modify an active version in place.

## UI boundary

Use AWB as the primary UI:

- **Runtime Hosts**: process/capability/health administration;
- **Agents**: durable responsibilities and runtime policy;
- **Skills**: versions, assignments, quarantine, and proposals;
- **Agent detail → ChildRuns**: bounded Hermes collaboration history.

Hermes Dashboard, WebUI, or OpenAI-compatible frontends can help runtime
diagnosis and experimentation, but should not become a second control plane.

## Recommended evolution

1. Persisted AWB approval queue that completes ACP permission requests.
2. Provider/credential health probes in Runtime Host capabilities.
3. Per-run cost and child-budget policies.
4. End-to-end conformance tests against a real `hermes-acp`.
5. Optional deep links to external Hermes diagnostics without duplicating AWB
   state.
