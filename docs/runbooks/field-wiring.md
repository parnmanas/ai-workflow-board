# Ticket JSON-Array Field Wiring Checklist

**When:** Checklist for adding or changing a JSON-array column on the Ticket entity (today: `tags`, `channel_ids`, `on_done_action_ids`). Use whenever a Ticket field stored as a JSON string array is added, renamed, or starts flowing through a new surface — missing any of the 5 touch points makes the client receive a raw string or silently fail to save.

Ticket columns that hold arrays are stored as JSON **strings** in the DB (`varchar`, default `'[]'`) and must be serialized on every write path and parsed on every read path. There are exactly **5 touch points** — wire all of them or the field breaks in a non-obvious way. Ticket writes go through `TicketService` (`apps/server/src/modules/tickets/ticket.service.ts`, see [tickets.md](../tickets.md)), which is why the server side is shorter than it used to be.

## The 5 touch points

| # | Touch point | Direction | Where | Failure if missed |
|---|---|---|---|---|
| 1 | `TicketService.create` / `TicketService.update` | write | `apps/server/src/modules/tickets/ticket.service.ts` — the one write path behind REST `POST /api/tickets` and `PATCH /api/tickets/:id`, MCP `create_ticket` / `update_ticket`, QA/Security failure tickets, CI-red tickets, outreach and the chat fallback. Also add the key to the MCP tool's zod schema (`apps/server/src/modules/mcp/tools/ticket-crud-tools.ts`) so it reaches the service | Writes don't persist, or store double-encoded JSON |
| 2 | Child-ticket inserts | write | The paths that create/update sub-tickets without `TicketService`: REST `POST /tickets/:parentId/children` (`tickets.controller.ts`), MCP `create_child_ticket` / `update_child_ticket` (`ticket-child-tools.ts`) and `create_ticket`'s inline `subtasks`. Only needed when the field applies to children — otherwise the entity default `'[]'` covers them | Sub-tickets save without the field / with a non-JSON value |
| 3 | `TicketService.serialize` | read | `ticket.service.ts` — the row projection behind the ticket list / kanban cards (`GET /api/tickets`, MCP `list_tickets`) including the two nested child levels, and the child-create response | Cards and list rows get a raw string |
| 4 | `parseTicket` + `loadTicketFull` | read | `apps/server/src/modules/mcp/shared/ticket-parsing.ts` — the full-ticket loader behind REST `GET` / `PATCH` / move responses and MCP `get_ticket` / `create_ticket` / `update_ticket`. `loadTicketFull` decodes the root, children and grandchildren separately; wire all three | Detail panel / `get_ticket` get a raw string |
| 5 | Client draft + types | read/write | `apps/client/src/types.ts` (`Ticket`), the `TicketPatch` body type in `apps/client/src/api.ts`, and `apps/client/src/components/ticketPanel/ticketDraft.ts` (draft init + the diff that builds the PATCH body — pick ordered vs unordered equality deliberately) | The panel never sends the edit, or treats a reorder as no change |

## Procedure

1. Add the `@Column` on `apps/server/src/entities/Ticket.ts` (`varchar` holding JSON, default `'[]'`).
2. Wire the write paths (1, and 2 if children carry it): accept an array from the caller, `JSON.stringify` before save.
3. Wire the read paths (3, 4): `JSON.parse` with a `[]` fallback on null/invalid.
4. Wire the client (5).
5. Verify end-to-end: write via MCP **and** via the client UI, then check the Tickets page card, the detail panel, `list_tickets` and a `get_ticket` MCP call all return a real array.

## Smell test

If the client ever renders `["a","b"]` as literal text, or saving a field silently no-ops, you missed one of the 5 — diff your change against this list before debugging anywhere else.

## Sibling class — SSE payload field wiring

The same "one cell missed in a multi-touch wire" failure exists on the SSE side. `apps/server/src/modules/events/event-registry.ts` rebuilds each event payload **field-by-field** in its `map()` (and reshapes it in `flatten()`). Add an optional field to a `*Payload` type in `apps/server/src/common/types/stream-events.ts` but forget to copy it into the `map()`/`flatten()` literal and it vanishes on the wire — TypeScript won't complain, the consumer (agent-manager / web UI) silently sees `undefined`, and the symptom surfaces somewhere unrelated (e.g. a QA run that never spawns an executor, an effort preset that never applies, an "update available" badge that never lights). Real incidents: `run_provision` (fe297886), and `agent_trigger.effort_preset` / `environment_config` / `force_respawn` + `agent_instance_update.instance.*` self-update fields (665bd10c).

Guard: `apps/server/test/event-registry-payload-parity-guard.test.mjs` (wired into `npm test`) statically asserts every declared payload field — top-level and one level of nested inline objects — is present as a key in its `map()` literal. It checks key **presence**, so conditional-omit values (`x ? x : undefined`) are preserved. If you add an SSE payload field, the guard tells you the moment the `map()` doesn't forward it.
