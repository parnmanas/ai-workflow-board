# AWB entity references

AWB user-visible text identifies entities with a named, non-notifying reference:

```text
#[type:<full-uuid>|Human-readable name]
```

Supported types are `ticket`, `agent`, `board`, `action`, `function`, and
`schedule`. The full UUID is required; a shortened ID is never a valid
reference. `@[agent:…]` remains the notification/dispatch syntax and must not be
used for a passive link.

The server resolves every reference by exact ID in the active workspace,
replaces an untrusted token label with the canonical entity name, and returns
the canonical deep link. The client renders the entity kind, canonical name,
and workspace/board context. Context makes same-named entities distinguishable;
the full ID remains available in the tooltip.

If the ID is malformed, missing, outside the active workspace, inaccessible, or
has no detail surface, AWB does not create a link. It renders the entity kind,
full display name when known, full stable ID, available workspace/board context,
and an explicit `연결 불가` reason.

MCP entity-returning tools include a copy-ready `_ref` alongside raw IDs.
Prompts require agents to use `_ref` in chat, ticket comments, and Run output.
Stored chat/comment output is normalized server-side so forged labels and
unresolvable targets cannot become links.

Keep the grammar synchronized in:

- `apps/server/src/common/artifact-ref.ts`
- `apps/client/src/utils/artifactRef.ts`
- `apps/agent-manager/src/lib/prompts.ts`

