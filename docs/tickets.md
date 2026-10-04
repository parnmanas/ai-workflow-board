# Tickets & Projects (board-less model)

**When:** you touch ticket creation, ticket status, ticket dispatch to an agent,
ticket filtering (tags / project), repositories, or a per-host working folder.

The Board concept is gone. There are no boards, no columns, no workspace roles,
no column → role routing, no prompt templates and no board lessons. What used
to be "a board per purpose" is now **one ticket pool per workspace**, classified
by **tags** and an optional **project**, and every ticket is done by **one agent**
(the assignee), who may fan the work out to its own subagents.

## Ticket

| Field | Meaning |
| --- | --- |
| `workspace_id` | Owning workspace. The only scope a ticket has. |
| `status` | One of the fixed set below. Replaces columns. |
| `tags` | `string[]`. Free-form classification (kind, area, old board name, …). Filterable. |
| `project_id` | Optional → `Project`. Which repository the work is about. Filterable. |
| `base_branch` | Branch the work starts from. Empty → the project's `default_branch`. |
| `assignee` | `RuntimeSpec \| null` — the one agent that does the ticket (host + CLI + model + working_dir …, see `common/runtime-spec.ts`). `null` = unassigned (never dispatched). |
| `priority` | `low` / `medium` / `high` / `critical` (`urgent` is accepted as an alias of `critical`). |
| `position` | Ordering inside a status lane. |
| `parent_id` | Child tickets (sub-tasks) keep working as before. Children have no assignee of their own and are not dispatched; they are a checklist the assignee works through. |
| `pending_user_action` / `pending_on_tickets` / `pending_ci_wait` | Unchanged pending flags. Any pending flag blocks dispatch. |
| `archived_at` | Unchanged soft-archive. |
| `terminal_entered_at` | Set when the ticket enters `done`, cleared when it leaves. |

### Status

`backlog` → `todo` → `in_progress` → `review` → `done`

| Status | Meaning | Dispatch |
| --- | --- | --- |
| `backlog` | Not ready. | never |
| `todo` | Ready and queued for its assignee. | The dispatcher moves it to `in_progress` and sends `agent_trigger` as soon as the assignee has capacity. |
| `in_progress` | The assignee is working on it. | Re-triggered on a human comment, on unpend / prerequisites resolved / CI wait resolved, on a manual "Run", and by the supervisor when the agent died without finishing. |
| `review` | The agent finished and wants a human to look. | never (send it back by moving to `todo`) |
| `done` | Finished. Terminal. | never. On entry: on-done Actions, `next_ticket_id`, prerequisite dependents, QA rerun, duplicate resolution. |

Constants live in `apps/server/src/common/ticket-status.ts` (`TICKET_STATUSES`,
`TICKET_STATUS_LABELS`). Never compare against a status string literal you
typed by hand elsewhere — import the constant.

Capacity: an agent identity (`runtimeIdentityKey(assignee)`) works on at most
`workspace.max_concurrent_tickets_per_agent` (default 1) non-pending
`in_progress` tickets at a time. Queued `todo` tickets for that identity are
started in `priority` → `position` → `created_at` order when a slot frees up.

`workspace.dispatch_paused_at` (non-null) stops all ticket dispatch in the
workspace — humans can still edit, comment and move tickets.

Never dispatched regardless of status: checklist children, archived and pending
tickets, and confirmed duplicates (`canonical_ticket_id` set) — a duplicate is
worked through its canonical ticket and is closed with it
(`resolved_from_canonical`) without running its own done hooks. Entering
`done` also releases `operational_dedupe_key`, so a later request with the same
key files new work instead of folding into the finished ticket.

The assignee RuntimeSpec is checked on write the same way team slots are: an
unknown `cli_runtime_profile` or a credential the workspace cannot use is a
400, not a dispatch-time failure.

## Project

A project is one git repository plus the knowledge every feature needs to work
on it. It replaces Resources of `type='repository'` (migrated with the **same
id**, so stored references keep resolving).

| Field | Meaning |
| --- | --- |
| `id`, `workspace_id`, `name`, `description` | |
| `repo_url` | Clone URL. |
| `default_branch` | Base branch when a ticket/run does not name one. Empty → `origin/HEAD`. |
| `credential_id` | Workspace Credential used to clone/push. |
| `clone_policy` | JSON (`common/clone-policy.ts`), project ⊕ workspace default. |
| `use_pr` | Land through a pull request instead of a direct fast-forward merge. |
| `instructions` | Free text shown to every agent that works on the project (build/test commands, conventions). |
| `default_assignee` | `RuntimeSpec \| null`. Applied to new tickets of this project that do not name an assignee (UI, MCP, QA/Security failure tickets, CI-red tickets, outreach). |
| `host_folders` | `[{ host_id, path }]` — the **main clone folder** of this project on each Runtime Host. |

### Main clone folder per host

`ProjectHostFolder(project_id, host_id, path)` — unique per (project, host).
`path` is an absolute path on that host. It is the one canonical checkout of
the project on that machine:

- **Tickets**: when the assignee runs on a host that has a main clone folder,
  the manager uses that folder as the base repository and cuts the ticket
  worktree from it at `<main_clone>/.awb/wt/<ticket8>` (instead of
  `<working_dir>/.awb/base/<slug>`). Shipped as `base_repo.main_clone_dir` on
  `agent_trigger`.
- **Missions / orchestration**: a mission names a `project_id`; each step's
  work order tells the member where that project lives on *its* host, and the
  team-slot editor offers "project folder on this host" as the slot's
  working_dir. Members on different hosts therefore never guess the folder.
- **QA / Security / Actions**: `repo_ref.project_id` replaces
  `repo_ref.resource_id`.

## REST (user session)

All under `/api`. Workspace header `X-Workspace-Id` as before. For non-admins
a `/workspaces/:wsId/...` path must name the same workspace as the header
(403 otherwise), and a `/tickets/:id/...` of another workspace answers 404.

### Tickets
| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/workspaces/:wsId/tickets` | `?status=todo,in_progress&tags=a,b&project_id=&assignee_key=&q=&include_archived=1&archived_only=1` (tags = AND) | `{ tickets: TicketCard[], tags: {tag,count}[] }` — root tickets only |
| POST | `/workspaces/:wsId/tickets` | `{ title, description?, status? (default todo), priority?, tags?, project_id?, base_branch?, assignee?: RuntimeSpec\|null, prompt_text?, position? }` | full ticket |
| GET | `/tickets/:id` | | full ticket (as before + fields above, `project` summary, children, comments…) |
| PATCH | `/tickets/:id` | any of `title, description, priority, tags, project_id, base_branch, assignee, prompt_text, pending_*, next_ticket_id, on_done_action_ids` | full ticket |
| PATCH | `/tickets/:id/move` | `{ status, position? }` | full ticket |
| POST | `/tickets/:id/trigger` | `{}` | `{ ok, dispatched, reason? }` — manual Run. `reason`: `unassigned`, `pending`, `archived`, `duplicate`, `workspace_paused`, `host_offline`, `agent_busy`, `queued`, `status_<s>` |
| POST | `/tickets/:parentId/children` | `{ title, description?, tags? }` | child |
| POST | `/tickets/:id/archive` · `/unarchive` · DELETE `/tickets/:id` | | as before |
| comments / attachments / prerequisites / read-state / presence / typing | unchanged paths | | |
| GET | `/tickets/unread-counts` | | `{ total, perTicket }` (no `perBoard`) |
| GET | `/workspaces/:wsId/ticket-tags` | | `{ tags: {tag,count}[] }` — tag suggestions across the workspace |
| PATCH | `/tickets/:id/parent` | `{ parent_id \| null }` | full ticket — make a ticket a subtask / promote it to a root |
| POST | `/tickets/read-all` | `{}` (workspace from header) | |

Prerequisite rows (`GET /tickets/:id` → `prerequisites[]`, `GET /tickets/:id/prerequisites`)
carry `prerequisite: { id, title, status, is_done, archived_at }` (no column fields).
Full tickets carry `assignee` (RuntimeSpec or null), `assignee_name` (`<Host>/<label>`),
`project` (`{ id, name, repo_url, default_branch, use_pr, host_folders[] }` or null),
`base_repo` (agent-manager shape) and `next_ticket` (`{ id, title, status }`).
Removed: `/columns/*`, `/boards/*`, role-assignment, consensus, move-to-board,
handoff and comment-summary endpoints.

`TicketCard` = ticket row fields (`id, title, status, priority, tags, project_id,
base_branch, assignee, assignee_key, position, pending_*, archived_at,
created_at, updated_at, parent_id`) + `comments` (projection
`{id,type,status,created_at}`), `prerequisite_count`, `children` (two levels).
`assignee_key` = `runtimeIdentityKey(assignee)` or `''`.

### Projects
| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/workspaces/:wsId/projects` | | `Project[]` (with `host_folders`) |
| POST | `/workspaces/:wsId/projects` | `{ name, repo_url, description?, default_branch?, credential_id?, clone_policy?, use_pr?, instructions?, default_assignee? }` | Project |
| GET | `/projects/:id` | | Project |
| PATCH | `/projects/:id` | same fields as POST | Project |
| DELETE | `/projects/:id` | | `{ ok }` (409 `project_in_use` with counts unless `?force=1`) |
| PUT | `/projects/:id/host-folders/:hostId` | `{ path }` | Project |
| DELETE | `/projects/:id/host-folders/:hostId` | | Project |
| GET | `/projects/:id/branches` | | `{ branches, default_branch }` |
| POST | `/projects/test-connection` | `{ repo_url, credential_id?, workspace_id }` | `{ ok, branches?, default_branch?, error? }` |
| GET | `/projects/:id/refs` · `/commits` · `/commits/:sha` · `/tree` · `/file` | same query params as the old resource repo browser | same shapes |

### QA / Security failure tickets
`on_failure_ticket` (QaScenario / SecurityProfile) drops `board_id`,
`column_id`, `column_name`, `assignee_id` and renames `labels` → `tags`
(stored rows with `labels` are still read). New keys: `project_id?`,
`status?` (`todo` default, or `backlog`). Assignee: `assignee_runtime` →
else the scenario/profile `target_runtime` → else the project's
`default_assignee`. Other keys (`priority`, `dedupe`, `title_template`,
`rerun_on_fix`, `max_rerun_attempts`, …) are unchanged.

### Workflow health
`/api/admin/workflow-health` keeps only the usage rollups (`token_usage`,
`long-term-usage`). Storms / respawns / suppressions and the `?board_id=`
filter are gone with the respawn-storm detector.

### Workspace settings (moved from boards)
`PATCH /workspaces/:id` additionally accepts `language`, `max_concurrent_tickets_per_agent`,
`auto_archive_days`, `dispatch_paused_at` (ISO or null).

## MCP

Removed: every board / column / lesson / prompt-template / role / consensus /
handoff / benchmark / feature / merge-lease / review-drift tool,
`move_ticket_to_board`, `get_allocated_tickets`, `batch_operations`,
`get_board_summary`.

| Tool | Notes |
| --- | --- |
| `list_tickets` | `{ workspace_id?, status?: string[], tags?: string[], project_id?, assignee_key?, query?, include_archived?, limit? }` |
| `get_ticket` | unchanged |
| `create_ticket` | `{ title, description?, status?, priority?, tags?, project_id?, base_branch?, assignee? (RuntimeSpec), parent_id? … }` |
| `update_ticket` | same fields as create (partial) |
| `move_ticket` | `{ ticket_id, status }` |
| `claim_ticket` | kept for old prompts: `todo` → `in_progress`, no-op otherwise |
| `get_my_tickets` | tickets whose assignee identity is the caller |
| `list_projects`, `get_project`, `save_project` | projects; `get_project` includes host folders |
| `list_repo_branches` | `{ project_id }` |
| `subscribe_events` | `{ workspace_id?, tags?, since?, assigned_to_me? }` (no `board_id`) |
| `list_archived_tickets` | `{ workspace_id?, cursor?, limit?, q? }` (no `board_id`) |

## SSE `agent_trigger` (server ↔ agent-manager contract)

Same event, same envelope. Changes:

- `role` is always `'assignee'`; `role_prompt` is the assignee spec's `role_prompt`.
- New `status` (`'todo' | 'in_progress' | 'review'`) and `project` summary.
- `current_column_id/_name/_kind` are still sent, **derived from status**
  (`id = 'status:<status>'`, `name = <label>`, `kind = 'active'`) so managers
  that predate this change keep dispatching.
- `column_prompt` carries the built-in single-agent ticket work order
  (`common/ticket-work-order.ts`) — `template_id = 'builtin:ticket-work-order'`.
  New managers render it as the work order (no "current column only" contract).
- `base_repo` = the project: `{ id: project.id, name, url, default_branch,
  main_clone_dir }`. `main_clone_dir` = the project's folder on the assignee's
  host, or `null`.
- `worktree_mode` is always `'per_ticket'`; `use_pr` comes from the project.
- `effort_preset` is `null` — effort rides `runtime.runtime_config.extra.effort`.
- `environment_config` = the workspace's only (no board layer).

`board_update` keeps its name (it is the ticket-change event). `current_column_*`
in it are derived from status the same way, plus a new `status` field.

Repository credentials: `GET /api/agent-manager/projects/:projectId/git-credential`
(the old `/resources/:id/git-credential` path is kept as an alias and resolves
projects by id).

Chat "ordinary work" fallback (manager → server):
- `GET /api/agent/ordinary-work-candidates?workspace_id=` →
  `{ projects: [{ id, name, repo_url }], tags: [{ tag, count }] }` (replaces
  `ordinary-work-board-candidates`).
- `POST /api/agent/ordinary-work-ticket` body
  `{ workspace_id, dedupe_key, title, description?, original_request?, tags?: string[], project_id?, room_id, message_id }`
  (no `board_id`). The fallback line is
  `AWB_ORDINARY_WORK_FALLBACK:{"title":…,"description":…,"tags":[…],"project_id":…}`.
