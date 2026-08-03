# Agent Column State Synchronization Design

## Problem

Persistent agent sessions retain the workflow guide from the column where they started. A later `board_update` says only that a ticket moved, while `get_ticket` and `agent_trigger` do not provide a human-readable authoritative column snapshot. An old session can therefore infer the current column from stale context and post an incorrect correction.

## Design

The ticket row and its current `BoardColumn` relation are the source of truth. Expose the same flat snapshot everywhere an agent reads or receives ticket state:

- `current_column_id`
- `current_column_name`
- `current_column_kind`

`loadTicketFull` resolves these fields directly from `ticket.column_id`. `agent_trigger` copies the already-resolved current column into the SSE payload. `board_update` resolves the ticket's current column at event-mapping time and also preserves the activity log's `old_value` and `new_value` as `previous_column_name` and `new_column_name` for move diagnostics.

The agent-manager prints the authoritative current column near the top of both fresh and reused trigger prompts. A `ticket.moved` board update is not forwarded as a generic follow-up to every persistent session; the server's role router emits targeted `agent_trigger` events for the new column instead. Other board updates remain forwarded and include the current column snapshot.

## Compatibility

All new SSE and ticket fields are optional additions. Existing clients can ignore them. Existing raw `column_id`, workflow prompts, and non-move board update fan-out remain unchanged.

## Verification

Regression tests cover ticket hydration, SSE map/flatten parity, prompt rendering, and suppression of generic move follow-ups. Server and agent-manager builds plus their relevant test suites must pass before pushing.
