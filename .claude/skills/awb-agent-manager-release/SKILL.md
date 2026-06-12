---
name: awb-agent-manager-release
description: Release procedure for changes under apps/agent-manager (SSE pipeline, subagent supervision, persistent sessions, CLI lifecycle). Use whenever apps/agent-manager/src is modified, and especially when SSE event types are added or changed — those must ship in the same PR as the server side.
---

# Agent Manager Release Procedure

`apps/agent-manager/` is a standalone Node binary (`awb-agent-manager`) that owns the SSE pipeline (`EventStream` → `EventDispatcher`), subagent supervision (`SubagentManager`), persistent ticket/chat sessions, fs-browser reverse-RPC, heartbeat, and the agent lockfile.

## Procedure (in order)

1. Modify `apps/agent-manager/src/`.
2. Verify `npm run build` passes **from the workspace root** (turbo builds the whole monorepo — a green agent-manager-only build is not enough).
3. **Bump `version` in `apps/agent-manager/package.json`.**
4. Commit + push.

## SSE contract rule

If you add or change an **SSE event type**, the server side (`apps/server/src/modules/agent-manager/`) must change **in the same PR**. The agent-manager and the AWB server consume the same contract; splitting the two halves across PRs ships a window where one side speaks a dialect the other doesn't understand.

## Deployment reality check

- The AWB server/client **auto-deploys** from the production branch.
- The agent-manager does **not** auto-deploy — it runs from a local checkout on the host and is typically the lagging piece.
- When debugging "the fix didn't take effect": grep the *running* agent-manager `dist/` on the host before blaming the new code.

## Field mapping reference (AWB SSE → handlers)

| SSE field | Handler meaning |
|---|---|
| `action` | role |
| `field_changed` | trigger_id |
| `actor_name` | agent_id |

Internals: `docs/agent-manager.md`. Quickstart: `apps/agent-manager/README.md`.
