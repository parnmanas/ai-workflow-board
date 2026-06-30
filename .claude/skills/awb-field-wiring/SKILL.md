---
name: awb-field-wiring
description: Checklist for adding or changing a JSON-array column on the Ticket entity (e.g. labels, channel_ids, on_done_action_ids). Use whenever a Ticket field stored as a JSON string array is added, renamed, or starts flowing through a new surface — missing any of the 5 touch points makes the client receive a raw string or silently fail to save.
---

# Ticket JSON-Array Field Wiring Checklist

Ticket columns that hold arrays are stored as JSON **strings** in the DB and must be serialized on every write path and parsed on every read path. There are exactly **5 touch points** — wire all of them or the field breaks in a non-obvious way.

## The 5 touch points

| # | Touch point | Direction | Where | Failure if missed |
|---|---|---|---|---|
| 1 | MCP write | write | MCP tool handler (`create_ticket` / `update_ticket` in the MCP server) | Agent writes don't persist or store double-encoded JSON |
| 2 | REST PATCH write | write | tickets controller PATCH handler | Client edits can't save the field |
| 3 | `parseTicket` | read | ticket parse helper | Single-ticket reads return a raw JSON string instead of an array |
| 4 | `loadTicketFull` | read | full-ticket loader (detail view / MCP `get_ticket`) | Detail view gets raw string |
| 5 | Board-card projection | read | board endpoint's per-card ticket projection | Board cards get raw string / field missing on cards |

## Procedure

1. Add the `@Column` on `apps/server/src/entities/Ticket.ts` (text/varchar holding JSON, default `'[]'`).
2. Wire **both** write paths (1, 2): accept an array from the caller, `JSON.stringify` before save.
3. Wire **all three** read paths (3, 4, 5): `JSON.parse` with a `[]` fallback on null/invalid.
4. Verify end-to-end: write via MCP **and** via the client UI, then check the board card, the detail panel, and a `get_ticket` MCP call all return a real array.

## Smell test

If the client ever renders `["a","b"]` as literal text, or saving a field silently no-ops, you missed one of the 5 — diff your change against this list before debugging anywhere else.

## Sibling class — SSE payload field wiring

The same "one cell missed in a multi-touch wire" failure exists on the SSE side. `apps/server/src/modules/events/event-registry.ts` rebuilds each event payload **field-by-field** in its `map()` (and reshapes it in `flatten()`). Add an optional field to a `*Payload` type in `apps/server/src/common/types/stream-events.ts` but forget to copy it into the `map()`/`flatten()` literal and it vanishes on the wire — TypeScript won't complain, the consumer (agent-manager / web UI) silently sees `undefined`, and the symptom surfaces somewhere unrelated (e.g. a QA run that never spawns an executor, an effort preset that never applies, an "update available" badge that never lights). Real incidents: `run_provision` (fe297886), and `agent_trigger.effort_preset` / `environment_config` / `force_respawn` + `agent_instance_update.instance.*` self-update fields (665bd10c).

Guard: `apps/server/test/event-registry-payload-parity-guard.test.mjs` (wired into `npm test`) statically asserts every declared payload field — top-level and one level of nested inline objects — is present as a key in its `map()` literal. It checks key **presence**, so conditional-omit values (`x ? x : undefined`) are preserved. If you add an SSE payload field, the guard tells you the moment the `map()` doesn't forward it.
