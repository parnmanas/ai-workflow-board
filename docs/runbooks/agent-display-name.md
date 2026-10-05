# Runtime / Host Display Name Contract

**When:** You render a Host/runtime label in pickers, rosters, typing/status indicators, timelines, SSE frames, or prompts. Use the shared label source for that object; preserve host context and snapshot names, and do not render an execution ID as a human name.

## Current identities and labels

The Agent table is removed. Choose the label source for the object being shown:

| Object | Display source |
| --- | --- |
| Runtime Host | `RuntimeHost.name`, a bare host name. |
| Ticket assignee | `<Host>/<RuntimeSpec.label>`, through the assignee helpers below. |
| Team slot / runtime execution | The slot/spec label and host context supplied by its projection; `rt-` keys are execution addresses, not names. |
| Snapshot with `{ name, manager_name }` | `formatAgentDisplayName`, retaining `<Manager>/<name>` when both are present. |
| Historical actor without a current Host lookup | Preserve its stored display name. |

The server's `resolveAgentDisplayName` / `resolveAgentDisplayNamesByIds` resolve
UUID-shaped IDs against Runtime Hosts. They do not reconstruct removed Agent
rows and do not resolve `rt-` keys to template IDs. An unresolved runtime needs
its spec/snapshot label, not a shortened ID rendered as a human name. Client
`agentIdentityLabel` exposes an ID as a tooltip when needed.

Names can repeat across hosts. Carry host context through the relevant helpers
rather than inventing a different prefix at each call site.

## Ticket assignee — `<Host>/<label>`

A ticket's single assignee is a RuntimeSpec, not an Agent row
([tickets.md](../tickets.md)). Its display is the spec `label` under its Runtime
Host's name: **`<Host>/<label>`**, or the bare label when the host name cannot
be resolved. A raw host uuid is never rendered as a name.

- **Server**: every full ticket and every list row carries `assignee_name`,
  computed from the `RuntimeHost` row named by `assignee.manager_agent_id` —
  `TicketService.serialize` (`apps/server/src/modules/tickets/ticket.service.ts`)
  for list/card rows and `loadTicketFull`
  (`apps/server/src/modules/mcp/shared/ticket-parsing.ts`) for the detail. MCP
  `list_tickets` / `get_ticket` return the same field. `''` = unassigned.
- **Client**: `assigneeDisplayName(spec, hostNames)` in
  `apps/client/src/tickets/assignee.ts` (label → `<folder leaf>/<cli>` fallback,
  then `formatAgentDisplayName`), with host names from the shared
  `useHostNames()` hook (`apps/client/src/runtime/useHostNames.ts`). The ticket
  artifact card prefers the server's `assignee_name` and falls back to the
  helper. The assignee filter on the Tickets page groups by `assignee_key`
  (`runtimeIdentityKey(spec)`) and labels each option with the same helper.

Do not join `${host}/${spec.label}` by hand anywhere else.

## The two formatters — never inline the format

| Side | Module | Use |
|---|---|---|
| Server | `apps/server/src/utils/agent-name.ts` | `formatAgentDisplayName({ name, manager_name })`, `resolveAgentDisplayName(scope, id)` (single), `resolveAgentDisplayMap(scope, snapshots)` (batched — prefer for lists), `resolveAgentDisplayNamesByIds(scope, ids)` (mixed id sets; IDs without a Host lookup are absent from the map) |
| Client | `apps/client/src/utils/agentName.ts` | `formatAgentDisplayName(agent)`, `parseAgentDisplayName(input)`, `agentMatchesQuery(agent, query)` |

`scope` is a DataSource/EntityManager exposing `getRepository`, not an Agent
repository. Host-name lookup and snapshot formatting are different operations:
use the former for Host identities and the latter when the payload carries both
name components. There is no Agent entity to add a `fullName` column to.

## Checklist — 6 touch points

Adding a surface that shows an agent? Walk all six. Each one has shipped broken
at least once.

| # | Touch point | What to do | Failure if missed |
|---|---|---|---|
| 1 | **Server list/detail projection** | Resolve Host/spec labels in the projection; for name snapshots, preserve `manager_name` alongside `name` | Every consumer shows the bare leaf name |
| 2 | **API payload shape** | For name snapshots carry `manager_name`; for specs carry the spec and use the shared host-name source. Update the matching client type | The client lacks the host context needed to render the label |
| 3 | **Client state mapping** | `.map((a) => ({ id, name }))` **drops** `manager_name` — carry it through | Picker renders bare names although the API returned the manager |
| 4 | **Client render** | Use `formatAgentDisplayName` for snapshots and `assigneeDisplayName` for ticket specs; no manual `/` join | Inconsistent labels across pages |
| 5 | **Denormalized writes / SSE frames** | Any `actor_name` / `agent_name` / `assignee_name` / `sender_name` written to a row or put on the wire must be resolved at emit time (or re-resolved on read, if a companion id is stored) | Stale or bare names; worst case a raw UUID on screen |
| 6 | **Agent-facing prompts** | Roster / dependency / assignee names in a prompt are user-visible too — resolve them | The orchestrator cannot distinguish two same-named members when assigning work |

## Specific traps

- **Typing / status indicators.** The indicator must be posted under the
  **responding agent's** id, not the manager's. `apps/agent-manager` runs many
  agents from one process, so `loadAgentInfo()` is the *manager's* identity —
  using it makes the UI say `<manager> is thinking`. It also breaks the
  client-side auto-clear, which keys the indicator by `agent_id` and clears it
  by the reply's `sender_id`: a mismatch leaves the indicator stuck until the
  15s safety timeout. **Set and clear must use the same id.**
- **Events with no name field.** `agent_typing` carried only `agent_id` and the
  registry flattened it as `actor_name: p.agent_id` — a UUID on screen. If an
  event feeds a label, give it a resolved name field.
- **Choke points beat call sites.** Prefer canonicalizing in one place that all
  writers pass through (e.g. `OrchestrationMissionService.recordEvent` resolves
  `actor_name` for every `actor_type: 'agent'` caller) over patching N call
  sites that will drift.
- **Non-agent actors must survive verbatim.** System labels (`AWB` on
  dispatcher activity rows), user names, and deleted rows have no Agent row.
  The Host resolvers return `null` / omit unresolved IDs from the map for this reason —
  always fall back to the stored value rather than overwriting it.

## Verify

```bash
# From the repository root; tests import compiled dist.
npm run build
(cd apps/server && node test/run-suite.mjs \
  test/agent-fullname-display.test.mjs \
  test/agent-fullname-orchestration-typing.test.mjs)
node --test apps/agent-manager/test/chat-typing-attribution.test.mjs
```

Add a case to `agent-fullname-orchestration-typing.test.mjs` for the surface you
touched. A useful test **fails on the pre-fix code** — verify that (stash your
`src` changes, rebuild, run) rather than assuming it.

Quick sweep for regressions before you ship:

```bash
# client: agent labels that bypass the helper
rg -n 'agents\.map|\.agent_name|agent\.name' apps/client/src -g '*.tsx'
# server: bare-name denormalization into a payload
rg -n '_name: .*\.name' apps/server/src -g '*.ts'
```

## Related

- `apps/server/test/agent-fullname-display.test.mjs` — activity / pending / SSE
- `apps/server/test/agent-fullname-orchestration-typing.test.mjs` — orchestration + both typing indicators
- `apps/agent-manager/test/chat-typing-attribution.test.mjs` — responder attribution
- `docs/runbooks/mcp-tool-wiring.md` — new MCP tools that return an agent name go through this contract too
