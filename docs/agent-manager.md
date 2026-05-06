# Agent Manager — Reference

`apps/agent-manager/` is the standalone subagent runner that drives CLI-based
AI agents (Claude, Codex, Gemini, custom) on behalf of an AWB workspace. It
replaces the daemon that used to live inside the
`@parnmanas/awb` Claude plugin (≤ v0.39).

For an installation walkthrough, see
[`apps/agent-manager/README.md`](../apps/agent-manager/README.md). This document is the
internals / operations reference.

## Responsibilities

| Concern                                  | Owner                                |
|------------------------------------------|--------------------------------------|
| stdio MCP forwarding (Claude CLI → AWB)  | `claude-plugins/ai-workflow-board/proxy.mjs` (separate package) |
| SSE event delivery to subagents          | `agent-manager` `EventStream` + `EventDispatcher` |
| Subagent lifecycle (spawn / drain / TTL) | `agent-manager` `SubagentManager`    |
| Persistent ticket / chat sessions        | `agent-manager` `TicketSessionManager`, `ChatSessionManager` |
| CLI process supervision                  | `agent-manager` `ManagedAgentRegistry` + cli-adapters |
| Instance heartbeat for AWB dashboard     | `agent-manager` `InstanceHeartbeat`  |
| Pairing + agent identity issuance        | AWB server `apps/server/src/modules/agent-manager/` |

The plugin is now a pure stdio↔HTTP MCP forwarder. It does **not** consume the
SSE stream and does **not** spawn subagents.

## Process layout

```
awb-agent-manager (single Node process per host/instance)
├── EventStream           SSE consumer; reconnect with backoff
├── EventDispatcher       routes incoming events by type
│   ├── trigger_event       → SubagentManager (spawn ticket subagent)
│   ├── chat_room_message   → ChatSessionManager (persistent room session)
│   ├── ticket_*            → TicketSessionManager (persistent ticket session)
│   ├── fs_browse_request   → FsBrowser (reverse-RPC fs handler)
│   └── agent_manager_command → AgentManagerCommandHandler (admin RPC)
├── ManagedAgentRegistry  in-memory state of CLI children (status, pid, cwd)
├── InstanceHeartbeat     POST /api/agent/instance-heartbeat every 30s
├── PresenceHeartbeat     POST /api/agent/presence (online/offline marker)
└── AgentLockfile         PID-owned exclusion at $AWB_AGENT_MANAGER_HOME/agent.lock
```

## Configuration

### Paths

`AGENT_MANAGER_HOME` resolves in this order (first hit wins):

1. `$AWB_AGENT_MANAGER_HOME`
2. `%APPDATA%\awb-agent-manager` (Windows only)
3. `$XDG_CONFIG_HOME/awb-agent-manager`
4. `~/.config/awb-agent-manager`

Inside that directory:

| File                    | Purpose                                              |
|-------------------------|------------------------------------------------------|
| `config.json`           | URL, API key, workspace_id, agent_id, CLI selection  |
| `agent.json`            | Cached agent identity (resolved via MCP whoami)      |
| `agent.lock`            | PID-owned mutual exclusion                           |
| `subagents.json`        | Persisted subagent state (resumable across restarts) |
| `subagents/`            | Per-subagent working directories                     |
| `instances/`            | Per-instance heartbeat state (multi-instance hosts)  |
| `agent-manager.log`     | Append-only log file                                 |

### Legacy import

On first run, agent-manager copies
`~/.claude/channels/awb/{config,agent}.json` into the new location if no
`config.json` exists yet. A `MIGRATED-TO-AGENT-MANAGER.txt` marker is dropped
in the legacy directory so subsequent runs skip the import. Legacy files are
**never deleted** — the claude-plugin proxy still reads them for stdio MCP
forwarding.

### Schema

```ts
interface AwbConfig {
  url: string;                 // AWB base URL, no trailing slash
  apiKey: string;              // bearer issued by /api/agent-manager/pair/redeem
  workspace_id?: string;       // workspace this manager binds to
  agent_id?: string | null;    // manager's Agent identity (auto-resolved if null)
  cli?: 'claude' | 'codex' | 'gemini' | string;  // default 'claude'
  delegation?: {
    enabled?: boolean;         // master switch for SubagentManager
    max_concurrent_subagents?: number;
    // …other tunables documented in lib/constants.ts → DELEGATION_DEFAULTS
  };
}
```

## Pairing & bootstrap

Pairing is the only supported way to provision a fresh manager. The flow:

1. **Mint** — admin POSTs `/api/admin/agent-manager/pair` (workspace-scoped,
   ttl 10 min, response includes raw token + 6-char display code, shown once).
2. **Redeem** — manager POSTs `/api/agent-manager/pair/redeem` with the token
   or display code plus a stable `instance_id`. AWB returns:
   - `api_key` — bearer for subsequent requests
   - `agent_id` — Agent identity created for this manager (`type='manager'`)
   - `workspace_id` — bound workspace
3. **Persist** — the manager writes the response into `config.json` and
   starts. (At present this is a manual write — see README.)

Tokens become single-use after redemption (`redeemed_at` set,
`redeemed_by_instance_id` recorded). Each redemption creates a new Agent row
to keep multi-host setups independently revocable.

Display code alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no
`0/O/1/I/l`).

## SSE event contract

Events arrive on the AWB SSE stream (`GET /api/sse/...`, scoped by API key).
The dispatcher maps `event.type` to the right handler:

| `type`                  | Handler                          | Notes                                                 |
|-------------------------|----------------------------------|-------------------------------------------------------|
| `trigger_event`         | `SubagentManager`                | Spawns a ticket-scoped Claude subagent                |
| `ticket_*`              | `TicketSessionManager`           | Forwards into the long-lived ticket session           |
| `chat_room_message`     | `ChatSessionManager`             | Forwards into the chat-room session                   |
| `fs_browse_request`     | `FsBrowser`                      | Reverse-RPC: lists / reads files in scoped paths      |
| `agent_manager_command` | `AgentManagerCommandHandler`     | Admin → manager RPC (see below)                       |
| `instance_*`            | `InstanceHeartbeat` (passive)    | Server-side reconciliation only                       |

### `agent_manager_command` payload

```ts
interface AgentManagerCommand {
  instance_id: string;     // target manager instance (drop if not us)
  command_id: string;      // ack key
  command: 'spawn_agent' | 'stop_agent' | 'restart_agent'
         | 'set_working_dir' | 'reload_config'
         | 'update_plugins' | 'refresh_mcp_config' | 'pull_working_dir';
  agent_id: string;        // server fans out scoped to the manager identity;
                           // this is the MANAGER's id, not the target managed
                           // agent. The target travels in args.agent_id.
  args?: {
    agent_id?: string;     // REQUIRED for *_agent / set_working_dir / maintenance verbs;
                           // identifies the managed-agent target on this manager
    working_dir?: string;
    cli?: 'claude' | 'codex' | 'gemini' | 'custom';
  };
}
```

Each handler returns an ack via
`POST /api/agent-manager/command/ack` with shape
`{ command_id, status: 'ok' | 'error', detail: string }`. The ack travels
over REST (not SSE) so it is not affected by the SSE reconnect loop.

The server-side ack endpoint enforces:

- `command_id` must match a pending dispatch (in-memory ledger, 10-minute TTL).
  Unknown / expired ids → `410 Gone`.
- The API key making the ack request must belong to the same manager Agent
  identity the dispatch was scoped to. Mismatch → `403 Forbidden` and the
  ledger record is restored so the legitimate manager can still ack.
- Each `command_id` is one-shot: a successful ack consumes the ledger
  entry. Replays land on `410 Gone`.

| Command              | Status                          |
|----------------------|---------------------------------|
| `set_working_dir`    | Real — registry update + heartbeat |
| `reload_config`      | Real — re-reads `config.json`. URL/apiKey/cli changes flagged disruptive |
| `spawn_agent`        | Real — provisions apiKey, writes mcp-config, registers context (ST-6) |
| `stop_agent`         | Real — drops context + erases on-disk secrets                          |
| `restart_agent`      | Real — `stop` + `spawn` composition                                    |
| `update_plugins`     | Real — `git pull --ff-only` on every claude marketplace under `<cli-home>/plugins/marketplaces/*` |
| `refresh_mcp_config` | Real — rewrites `mcp-config.json` with current AWB url + existing apiKey |
| `pull_working_dir`   | Real — `git pull --ff-only` inside `Agent.working_dir` (30s timeout)    |

## Heartbeats

Two heartbeats run on independent timers:

- **InstanceHeartbeat** — `POST /api/agent/instance-heartbeat` every 30s with
  `{ mode, agent_ids, working_dirs, paired_at, ... }`. AWB stores the latest
  payload and surfaces it in the admin dashboard. `mode='manager'` triggers
  the additional ManagedAgents UI section.
- **PresenceHeartbeat** — `POST /api/agent/presence`. Coarser ping that drives
  the agent's online/offline indicator.

If the manager exits cleanly it sends a final heartbeat with
`mode='offline'`. A crash leaves the prior heartbeat in place; the dashboard
will mark the instance stale based on `last_seen`.

## Lockfile

`$AWB_AGENT_MANAGER_HOME/agent.lock` holds the running manager's PID and
start time. On startup:

1. If no lock — create one and continue.
2. If a lock exists and the PID is alive — refuse to start (exit 1) unless
   `--force` is passed.
3. If the PID is dead — take it over.

The lockfile is also inspected for the legacy `~/.claude/channels/awb/agent.lock`
to refuse running concurrently with the old plugin daemon.

## Security model

- **API key scope** — pairing redeem creates an `ApiKey` bound to the
  manager's Agent row. All subsequent requests use this key as a Bearer
  header. The key has full agent scope (same as a Claude plugin install).
- **Pairing tokens** — never persisted on the manager. Single-use,
  10-minute TTL, mint endpoint is admin-only.
- **fs-browser scope** — reverse-RPC fs operations are gated by realpath
  against an explicit allowlist (working_dir of each managed agent). Symlink
  escapes are rejected at `realpath` time before any IO.
- **Lockfile** — prevents two managers writing the same `subagents.json`. A
  hostile take-over still requires PID forge; honest installations are safe.

## Operational runbooks

- **Re-login a managed claude CLI** — see
  [`docs/managed-agent-relogin.md`](managed-agent-relogin.md). Covers both
  the direct path (`scripts/relogin-managed-agent.{ps1,sh}` redirecting
  `CLAUDE_CONFIG_DIR` to the per-agent cli-home) and the remote-injection
  path (paste `.credentials.json` into AWB Admin → Credentials →
  Claude (Subscription), attach to agent, restart). Required when subagent
  turns return `is_error=true` in 1–2 s and sessions are killed as
  UNHEALTHY every 25 minutes — the canonical signature of an expired
  OAuth token.

## Testing

> **No automated tests yet — all behavior is verified manually.** The plugin
> daemon's prior unit tests (`subagent-manager`, `chat-session-manager`,
> `agent-lockfile`, `self-update`, `subagent-delegation`) were dropped when
> the daemon moved here and have not been ported to TS yet. The same logic
> still runs (re-typed line-for-line during ST-2), so short-term regression
> risk is low — but new contributors should treat the public contracts here
> (SSE event shapes, config schema, ack semantics) as the source of truth
> rather than inferring from code.

Minimum manual smoke pass before each version bump:

- `npm run build` (workspace root, via turbo) — agent-manager + server +
  client all compile clean.
- Pairing dry-run — mint via admin UI → redeem via curl → manager starts and
  the instance shows up on the dashboard.
- `agent_manager_command` round-trip — every verb (`spawn_agent`,
  `stop_agent`, `restart_agent`, `set_working_dir`, `reload_config`,
  `update_plugins`, `refresh_mcp_config`, `pull_working_dir`) acks `ok` for
  the happy path. Maintenance verbs additionally exercise:
  `update_plugins` against an agent with a non-empty
  `<cli-home>/plugins/marketplaces/`; `refresh_mcp_config` against an agent
  with an existing apiKey; `pull_working_dir` against a clean checkout.

## Versioning + sync rules

- `apps/agent-manager/package.json#version` — bump on any behavior or contract
  change; published artefacts (npm tarball / Docker image) are tagged from
  this number.
- Changes to the SSE contract (new `type`, new fields, semantics) require a
  matching server change in `apps/server/src/modules/agent-manager/` and
  must include a smoke-test of the new event end-to-end.
- The claude-plugin (`submodules/claude-plugins/ai-workflow-board/`) is a
  separate distribution. Touch only when stdio MCP forwarding behavior
  itself changes; agent-manager work does not require a plugin version
  bump.

See the parent repo's `CLAUDE.md` _Agent Manager sync_ rule for how the
ralf monorepo coordinates submodule ref bumps after these changes land.
