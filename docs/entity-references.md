# AWB entity references

AWB user-visible text identifies entities with a named, non-notifying reference:

```text
#[type:<full-uuid>|Human-readable name]
```

Supported types are `ticket`, `agent`, `action`, `function`, and `schedule`.
The full UUID is required; a shortened ID is never a valid reference.
`@[agent:…]` remains the notification/dispatch syntax and must not be used for a
passive link.

There is no `board` type — boards were removed (see [tickets.md](tickets.md)).
An old `#[board:…]` token in stored text no longer matches the grammar and is
rendered as plain text. Projects have no reference type either; name a project
by its name, or reference the ticket that is about it.

An `agent` reference resolves through the Runtime Host identity (there is no
Agent table and no agent detail page), so it always renders as a named,
unlinked reference with the `no_detail_surface` reason.

The server resolves every reference by exact ID and authorizes its actual owner,
replaces an untrusted token label with the canonical entity name, and returns
the canonical deep link (tickets open `/tickets?ticket=<id>`; Actions,
Functions and Schedules open `/actions?artifact=<id>`, `/functions?artifact=<id>`,
and `/schedules?artifact=<id>`). A request does not need an ambient account.
The client renders the entity kind, canonical name, and account context. Context makes same-named
entities distinguishable; the full ID remains available in the tooltip.

If the ID is malformed, missing, inaccessible, or
has no detail surface, AWB does not create a link. It renders the entity kind,
full display name when authorized, full stable ID, available account context, and
an explicit `연결 불가` reason.
An inaccessible reference never reveals its stored name or owner context.

MCP entity-returning tools include a copy-ready `_ref` alongside raw IDs.
Prompts require agents to use `_ref` in chat, ticket comments, and Run output.
Stored chat/comment output is normalized server-side so forged labels and
unresolvable targets cannot become links.

Keep the grammar synchronized in:

- `apps/server/src/common/artifact-ref.ts`
- `apps/client/src/utils/artifactRef.ts`
- `apps/agent-manager/src/lib/prompts.ts`
