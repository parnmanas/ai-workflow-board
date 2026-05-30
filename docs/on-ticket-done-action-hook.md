# On-Ticket-Done Action Hook

Run a saved **Action** automatically the moment a ticket lands on a terminal
column (Done), with the finished ticket injected into the prompt. This is the
event-driven complement to the two existing Action triggers (cron schedule and
manual `run_action`): some "continuous" work is tied to *a ticket finishing*,
not to a clock.

> Ticket: `16a6339c` ([Feature] 티켓 Done(terminal) 시 연결된 Action 자동 실행).
> Implemented by `OnTicketDoneActionService` (`apps/server/src/modules/actions/`).

## How it fires

`OnTicketDoneActionService` subscribes to the same `activityEvents` 'activity'
stream `TriggerLoopService` uses (a separate listener in the actions module, so
there is no actions↔agents module cycle). On every `moved` activity it:

1. Loads the ticket and its current column; bails unless the column is terminal
   (`is_terminal=true` or `kind='terminal'`).
2. Requires `terminal_entered_at` to be set (the move path stamps it on the
   non-terminal → terminal crossing).
3. Skips the ticket entirely if it carries the recursion-guard label
   (see below).
4. Collects the eligible Actions (union of the two binding methods).
5. Claims the terminal entry atomically and dispatches each Action once, with
   the finished ticket as `{{ticket.*}}` context.

## Two ways to bind an Action

You can use either or both; the service takes the **union, deduped by action
id**. `enabled=false` Actions are skipped by both methods (manual `run_action`
still works).

### (a) Per-ticket — `Ticket.on_done_action_ids`

A JSON array of Action ids on the ticket itself. Fires those Actions when *this
specific ticket* reaches Done, regardless of the Action's own `trigger` field.
Set it via `update_ticket`:

```jsonc
update_ticket({ ticket_id, on_done_action_ids: ["<action-id>", ...] })
```

Good for one-off "when this particular ticket ships, do X".

### (b) Board / label policy — `Action.trigger='on_ticket_done'`

Opt the Action into the hook and scope which finished tickets trigger it:

| field | meaning |
| --- | --- |
| `trigger` | `'on_ticket_done'` to enable the hook (`''` = legacy cron/manual) |
| `board_id` | `null`/omitted = any board in the workspace; `<uuid>` = only that board |
| `trigger_label` | empty = any label; else the finished ticket must carry this label |

Set it via `save_action`:

```jsonc
save_action({
  workspace_id, name: "Test gate",
  target_agent_id: "<agent>",
  trigger: "on_ticket_done",
  board_id: "<board>",          // optional board scope
  trigger_label: "feature",      // optional label scope
  prompt: "Ticket {{ticket.title}} ({{ticket.id}}) just shipped on {{ticket.board_id}} …",
})
```

Good for board-wide policy ("every feature ticket that ships gets a test-gate
check").

## Prompt context — `{{ticket.*}}`

On the hook path the prompt template can reference the finished ticket. Tokens
(all render as the empty string off the hook path):

- `{{ticket.id}}`, `{{ticket.title}}`, `{{ticket.board_id}}`, `{{ticket.column_id}}`
- `{{ticket.priority}}`, `{{ticket.status}}`, `{{ticket.description}}`
- `{{ticket.base_branch}}`, `{{ticket.base_repo_id}}` (closest pointer to the diff/PR)
- `{{ticket.labels}}` (comma-joined), `{{ticket.assignee}}`, `{{ticket.reporter}}`

The standard `{{action}}`, `{{run}}`, `{{workspace}}`, `{{board}}`, `{{agent}}`,
`{{date}}`/`{{time}}`/`{{datetime}}` tokens still apply.

## Guarantees

- **Exactly once per terminal entry.** Idempotency is an atomic conditional
  claim on `Ticket.on_done_dispatched_at` vs `terminal_entered_at`: dispatch
  only when `on_done_dispatched_at` is null or older than `terminal_entered_at`.
  A reorder within Done or a re-emitted `moved` does **not** re-fire; leaving
  Done and re-entering (which re-stamps `terminal_entered_at`) does.
- **enabled respected.** `enabled=false` ⇒ the hook skips it.
- **Recursion guard.** A ticket labelled **`no-on-done-hook`** is never
  eligible. A hook Action that files a follow-up ticket should stamp that label
  on what it creates, so the follow-up reaching Done can't recursively re-fire
  the hook. (Same label convention the self-improvement post-done review uses
  with `self-improvement`.)

## Operational notes

- The Run is attributed to `system` (triggered_by_id `on_ticket_done`) and
  appears in the target agent's chat list exactly like a scheduled/manual Run.
  Inspect it with `list_action_runs`.
- Schema: four columns added (`actions.trigger`, `actions.trigger_label`,
  `tickets.on_done_action_ids`, `tickets.on_done_dispatched_at`). SQLite gets
  them via `synchronize`; Postgres via migration
  `1760000000029-AddOnTicketDoneActionHook`.
- Tests: behavioural `test/qa-flows/on-ticket-done-hook.test.mjs`, static guard
  `test/on-ticket-done-hook-grep.test.mjs`.
