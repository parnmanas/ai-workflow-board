# On-Ticket-Done Action Hook

Run a saved **Action** automatically the moment a ticket enters the `done`
status, with the finished ticket injected into the prompt. This is the
event-driven complement to the other ways an Action starts (a Workspace Schedule
pointing at it with `action_id`, or a manual `run_action`): some "continuous"
work is tied to *a ticket finishing*, not to a clock.

> 크론은 더 이상 Action 에 없다 — `actions.schedule_cron` 은 Workspace Schedule 로
> 옮겼다(`docs/workspace-schedules.md`). Action 은 "무엇을 · 누가 · 어디서" 만
> 정의하고 "언제" 는 Schedule 이 정한다. 반대로 이 on-ticket-done 트리거는 시각이
> 아니라 **무엇에 반응하는가**라서 Action 에 그대로 남아 있다.

> Ticket: `16a6339c` ([Feature] 티켓 Done(terminal) 시 연결된 Action 자동 실행).
> Implemented by `OnTicketDoneActionService` (`apps/server/src/modules/actions/`).

## How it fires

`OnTicketDoneActionService` subscribes to the same `activityEvents` 'activity'
stream `TicketDispatchService` listens to (a separate listener in the actions
module, so ticket status changes take no dependency on Actions). On every `moved`
activity whose new value is `done` it:

1. Re-loads the ticket and bails unless it is still `done` (it may have left
   again before the listener ran).
2. Requires `terminal_entered_at` to be set (`TicketService` stamps it on
   entering `done` and clears it on leaving).
3. Skips the ticket entirely if it carries the recursion-guard tag
   (see below).
4. Collects the eligible Actions (union of the two binding methods).
5. Claims the terminal entry atomically and dispatches each Action once, with
   the finished ticket as `{{ticket.*}}` context.

## Two ways to bind an Action

You can use either or both; the service takes the **union, deduped by action
id**. `enabled=false` Actions are skipped by both methods (manual `run_action`
still works).

### (a) Per-ticket — `Ticket.on_done_action_ids`

A JSON array of Action ids on the ticket itself. Fires those Actions, in array
order, when *this specific ticket* reaches `done`, regardless of the Action's own
`trigger` field (the Action must be in the ticket's workspace and enabled). Set
it via `update_ticket` (or `PATCH /api/tickets/:id`):

```jsonc
update_ticket({ ticket_id, on_done_action_ids: ["<action-id>", ...] })
```

Good for one-off "when this particular ticket ships, do X".

### (b) Tag policy — `Action.trigger='on_ticket_done'`

Opt the Action into the hook and scope which finished tickets trigger it. The
policy is workspace-wide; the only narrowing is by tag:

| field | meaning |
| --- | --- |
| `trigger` | `'on_ticket_done'` to enable the hook (`''` = manual / Workspace Schedule only) |
| `trigger_label` | empty = any finished ticket in the workspace; else the ticket's `tags` must include this exact tag (the field keeps its historical name) |

Set it via `save_action`:

```jsonc
save_action({
  workspace_id, name: "Test gate",
  target_runtimes: [<RuntimeSpec>],
  trigger: "on_ticket_done",
  trigger_label: "feature",      // optional tag scope
  prompt: "Ticket {{ticket.title}} ({{ticket.id}}) just shipped in {{project.name}} …",
})
```

Policy Actions fire after the ticket's explicit `on_done_action_ids` (an Action
named by both fires once, in the explicit position).

Good for workspace-wide policy ("every `feature` ticket that ships gets a
test-gate check").

## Prompt context — `{{ticket.*}}`

On the hook path the prompt template can reference the finished ticket. Tokens
(all render as the empty string off the hook path):

- `{{ticket.id}}`, `{{ticket.title}}`, `{{ticket.priority}}`, `{{ticket.status}}`,
  `{{ticket.description}}`
- `{{ticket.project_id}}`, `{{ticket.base_branch}}` (closest pointer to the diff/PR)
- `{{ticket.tags}}` (comma-joined), `{{ticket.assignee}}` (the assignee
  RuntimeSpec's label, empty when unassigned)
- `{{project.id}}`, `{{project.name}}`, `{{project.repo_url}}`,
  `{{project.default_branch}}` — the finished ticket's project

Pre-board-removal spellings still render so saved prompts keep working:
`{{ticket.labels}}` = `{{ticket.tags}}`, `{{ticket.base_repo_id}}` =
`{{ticket.project_id}}`. Board/column/reporter tokens (`{{ticket.board_id}}`,
`{{ticket.column_id}}`, `{{ticket.reporter}}`, `{{board.*}}`) render empty.

The standard `{{action.*}}`, `{{run.*}}`, `{{workspace.*}}`, `{{agent.*}}`,
`{{date}}`/`{{time}}`/`{{datetime}}` tokens still apply.

## Guarantees

- **Exactly once per terminal entry.** Idempotency is an atomic conditional
  claim on `Ticket.on_done_dispatched_at` vs `terminal_entered_at`: dispatch
  only when `on_done_dispatched_at` is null or older than `terminal_entered_at`.
  A reorder within `done` or a re-emitted `moved` does **not** re-fire; leaving
  `done` and re-entering (which re-stamps `terminal_entered_at`) does.
- **enabled respected.** `enabled=false` ⇒ the hook skips it.
- **Recursion guard.** A ticket tagged **`no-on-done-hook`** is never
  eligible. A hook Action that files a follow-up ticket should stamp that tag
  on what it creates, so the follow-up reaching `done` can't recursively re-fire
  the hook.
- **Fleet quiesce.** While the instance is quiesced (live import) the hook does
  nothing and does **not** consume the claim.

## Operational notes

- The Run is attributed to `system` (triggered_by_id `on_ticket_done`) and
  appears in the target agent's chat list exactly like a scheduled/manual Run.
  Inspect it with `list_action_runs`.
- Schema: `actions.trigger`, `actions.trigger_label`,
  `tickets.on_done_action_ids`, `tickets.on_done_dispatched_at` — entity
  columns, created by `synchronize`.
- Tests: behavioural `test/qa-flows/on-ticket-done-hook.test.mjs`, static guard
  `test/on-ticket-done-hook-grep.test.mjs`.
