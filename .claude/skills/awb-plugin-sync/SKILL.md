---
name: awb-plugin-sync
description: Sync the companion stdio MCP plugin after changing the AWB MCP tool surface. Use whenever MCP tools are added, removed, or renamed, or their input/output schemas change in apps/server — the change is NOT shipped until the plugin repo is bumped and pushed.
---

# AWB Plugin Sync Procedure

The Claude CLI talks to AWB through a separate stdio↔HTTP forwarder plugin:

- **Repo:** `github.com/parnmanas/claude-plugins`, subpath `ai-workflow-board/`
- `proxy.mjs` — pure stdio↔HTTP MCP forwarder (Claude CLI ↔ proxy.mjs ↔ AWB `/mcp`)
- `lib/mcp-forward-session.mjs` — owns the AWB MCP session (stale-session recovery, retries)

Any change to the AWB MCP tool surface requires a matching plugin release.

## Procedure (all three steps, in order)

1. Update `proxy.mjs` / the affected MCP forwarding code in the plugin repo.
2. **Bump `version` in `.claude-plugin/plugin.json`.**
3. Commit + push the plugin repo.

> ⚠️ Step 2 is the most frequently forgotten step. Without a version bump the marketplace cache never picks up the change — the push looks done but every client keeps the old plugin.

## Out of plugin scope (do NOT add these to the plugin)

Since plugin v0.40.0, the plugin is a pure forwarder. These belong to `apps/agent-manager/` instead:

- SSE event stream consumption
- Subagent spawning / supervision
- Channel handling

If the change involves any of the above, use the `awb-agent-manager-release` skill instead (or in addition, if both surfaces moved).
