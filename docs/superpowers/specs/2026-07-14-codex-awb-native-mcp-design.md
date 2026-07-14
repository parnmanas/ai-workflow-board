# Codex AWB Native MCP Design

## Problem

The Agent Manager currently treats Codex as a non-MCP CLI. `CodexCliAdapter`
does not declare `NATIVE_MCP`, returns `needsMcpConfig: false`, and does not
write AWB into the managed agent's `CODEX_HOME/config.toml`. The manager does
write an adjacent `mcp-config.json`, but Codex does not load that Claude-style
JSON file. As a result, a managed Codex run starts without `mcp__awb__*` tools.

Current Codex supports Streamable HTTP MCP servers through
`$CODEX_HOME/config.toml`. AWB should use that native path rather than add a
second proxy layer.

## Goals

- Make every managed Codex agent load the AWB MCP server automatically.
- Fail the Codex run when the required AWB MCP server cannot initialize.
- Keep per-agent authentication isolated and avoid writing the raw AWB API key
  into `config.toml`.
- Preserve ticket, role, and trigger attribution for MCP calls.
- Preserve operator-authored Codex configuration and unrelated MCP servers.
- Make spawn, manager rehydrate, and MCP refresh converge on the same config.
- Prevent duplicate comments caused by both native MCP writes and the existing
  manager stdout fallback.

## Non-goals

- Changing the AWB server MCP tool names, schemas, or transport.
- Changing the companion stdio plugin. Its version is not bumped because the
  server MCP surface is unchanged.
- Adding persistent Codex sessions; Codex remains a one-shot adapter.
- Changing Antigravity or Claude MCP behavior.

## Selected Approach

Use Codex's native MCP configuration. The Codex adapter owns a small,
idempotent merge of Agent Manager-controlled `awb` and `host` tables into the
managed agent's `config.toml`. Per-run attribution headers are supplied as
Codex CLI config overrides because those values vary by ticket dispatch.

This is preferred over CLI-only injection because persistent configuration is
inspectable with `codex mcp list` and automatically repaired on rehydrate. It
is preferred over a stdio proxy because AWB already exposes a supported
Streamable HTTP endpoint.

## Configuration Design

`CodexCliAdapter.prepareCliHome()` receives the existing `AdapterMcpContext`
and ensures these managed entries exist in `<cli-home>/config.toml`:

```toml
[mcp_servers.awb]
url = "https://awb.example.com/mcp"
bearer_token_env_var = "AWB_API_KEY"
http_headers = { "X-AWB-Client-Type" = "managed-subagent" }
required = true

[mcp_servers.host]
command = "<resolved agent-manager command>"
args = ["<resolved prefix args>", "mcp-host"]
```

The actual URL and host command are generated at runtime. `awb.required` is
always true. `host` remains optional because failure of host-only desktop tools
must not prevent ticket processing.

The merge owns only `[mcp_servers.awb]` and `[mcp_servers.host]`. It preserves
all unrelated Codex settings and MCP entries. Re-running it replaces stale
managed blocks rather than appending duplicates. Invalid existing TOML is a
configuration error and must be surfaced; silently replacing the operator's
file could destroy valid settings.

The current operator-home fallback may create `config.toml` as a symlink to
the operator's global Codex config. MCP preparation must never write through
that symlink. It reads the inherited source, removes the per-agent symlink, and
writes an agent-owned regular file containing the preserved settings plus the
managed MCP entries. Subscription-provided `config_toml` receives the same
agent-local treatment. A TOML parser/serializer must be used so table names,
arrays, quoting, and nested values are handled as TOML data instead of by
regular-expression editing. Semantic settings are preserved; comments and
original formatting are not part of the persistence contract.

The AWB API key is already injected into managed children as `AWB_API_KEY`.
Codex reads it through `bearer_token_env_var`, so the key is not duplicated in
`config.toml`. The existing protected per-agent `apikey` file remains the
manager's source of truth.

## Per-run Attribution

The static config identifies the client as a managed subagent. A ticket run
also needs the headers below when present:

- `X-AWB-Subagent-Ticket-Id`
- `X-AWB-Subagent-Role`
- `X-AWB-Subagent-Trigger-Source`

The one-shot spawn specification will carry this MCP attribution metadata to
the Codex adapter. `buildOneshotSpawn()` will emit a narrowly scoped `-c`
override for `mcp_servers.awb.http_headers` containing the static client type
plus the applicable attribution headers. Values will be serialized as TOML
data, not interpolated as shell fragments, because the manager uses argv-based
process spawning.

Chat and action-room runs omit ticket-role headers and use the static managed
client header. This preserves the server's existing role resolution behavior
and avoids tagging a multi-role agent's comment with every role it holds.

## Native MCP Behavior

`CodexCliAdapter` will declare `ADAPTER_CAPABILITIES.NATIVE_MCP`. Consequences:

- Ticket and chat prompts instruct Codex to call AWB MCP tools directly.
- The manager no longer posts Codex's final stdout as a second AWB comment or
  chat message.
- JSONL parsing remains active for progress, completion, errors, and operator
  diagnostics.
- Codex remains one-shot because `PERSISTENT_SESSION` is not enabled.

The adapter's `needsMcpConfig` remains false: that flag means a CLI accepts the
Claude-style `--mcp-config <json>` argument, which Codex does not. Native MCP
availability comes from `CODEX_HOME/config.toml` instead.

## Lifecycle

The same adapter preparation path is used in three cases:

1. `spawn_agent`: write or refresh the Codex managed MCP blocks before the
   first run.
2. Manager startup rehydrate: repair existing Codex homes after an Agent
   Manager upgrade or URL change.
3. `refresh_mcp_config`: refresh both the manager JSON config and the CLI-native
   config for the target agent.

Existing Codex agents therefore become usable after the upgraded Agent Manager
restarts; operators do not need to recreate agents.

## Error Handling

- Missing MCP context leaves credential preparation behavior unchanged, but a
  managed Codex spawn normally always supplies the context.
- Invalid or unwritable `config.toml` causes cli-home preparation to fail and
  is logged with the agent and CLI. The affected Codex run must not be reported
  as successfully MCP-enabled.
- At Codex startup, `required = true` turns AWB connection or initialization
  failure into a failed run rather than silently continuing without tools.
- Logs and command output must not include the API key or Authorization header.

## Testing

Add focused Agent Manager tests before production changes:

- Codex declares native MCP but not persistent-session support.
- Preparing a fresh Codex home writes valid AWB and host MCP tables.
- AWB uses `bearer_token_env_var = "AWB_API_KEY"`, contains no raw API key,
  and sets `required = true`.
- Existing non-managed Codex settings and MCP servers survive the merge.
- An inherited `config.toml` symlink is replaced by an agent-local regular file
  without modifying the symlink target.
- Repeated preparation updates managed values without duplicate tables.
- Invalid TOML fails without overwriting the file.
- Ticket-role metadata becomes the expected per-run Codex config override.
- Chat runs omit ticket-role headers.
- Native-MCP prompt selection prevents the stdout fallback path.
- A temporary `CODEX_HOME` is accepted by the installed Codex CLI and
  `codex mcp list` shows `awb` as enabled and required.

Run the Agent Manager test suite, its package build, and the workspace root
build. Because `apps/agent-manager/src` changes, bump
`apps/agent-manager/package.json` according to the Agent Manager release
procedure and verify the root lockfile remains synchronized.

## Rollout and Compatibility

This is an Agent Manager-only contract correction. The AWB server continues to
serve the same Streamable HTTP MCP endpoint and accepts the same headers. Older
Codex builds that do not understand the required MCP configuration will fail
clearly during startup; the supported Agent Manager environment must use a
Codex release with native Streamable HTTP MCP support.
