# AWB Functions

Functions are reusable, versioned operations that humans, workflows, and MCP
agents can execute without re-implementing operational rules in a prompt.

They complement Actions:

- **Function**: structured input/output, deterministic executor, idempotency,
  retry/approval policy, and an auditable run.
- **Action**: a saved prompt dispatched to a target Agent in a chat room.
- `agent_action` is the adapter when a Function intentionally needs an Agent.

## Scope

Functions use one database model. There is no separate “Global Function” type.

| `workspace_id` | Meaning | Management surface |
|---|---|---|
| `NULL` | Global, inherited by every workspace | Admin → Global Functions |
| workspace UUID | Available only in that workspace | Workspace → Functions |

Resolution is by stable `key`. A workspace row with the same key overrides the
global row. Scope cannot be moved in place; create/delete an override instead so
run history remains unambiguous.

## Definition contract

Every Function has:

- a stable `key` and monotonically increasing `version`;
- JSON input/output schemas;
- executor type and JSON configuration;
- risk level: `read`, `write`, `destructive`, or `high_impact`;
- idempotency mode, timeout, retry count, and approval policy;
- enabled/built-in flags.

Every execution writes a `workflow_function_runs` row containing the exact
Function version, scope, actor, ticket/board context, inputs, outputs, evidence,
idempotency key, errors, and timestamps. Pipeline child runs point to their
parent run.

`destructive` and `high_impact` definitions are always normalized to
`approval_policy=admin`; an author cannot downgrade that gate.

## Executors

| Executor | Purpose | Configuration |
|---|---|---|
| `builtin` | Server-owned, reviewed AWB operation | `{ "handler": "..." }` |
| `pipeline` | Ordered composition of other Functions | `{ "steps": [{ "function_key": "...", "inputs": {}, "continue_on_error": false }] }` |
| `http` | Call a controlled HTTP API | `{ "url": "...", "method": "POST", "headers": {}, "body": {} }` |
| `agent_action` | Dispatch an existing AWB Action | `{ "action_id": "..." }` |

Arbitrary shell execution is intentionally not a server executor. Repository
commands need an Agent Manager executor with an explicit working-directory and
credential contract; adding that contract is safer than letting the web server
run user-authored shell text.

## Built-ins shipped now

- `system.noop`: connectivity check and pipeline echo step.
- `workflow.ticket_snapshot`: immutable evidence of the ticket/column state.
- `workflow.verify_children_complete`: fails closed when a direct child is not
  in a terminal column.
- `workflow.verify_required_functions`: fails closed when configured Function
  keys have no successful run for the ticket.

## Function catalogue

The following operations should move out of prompts. The implementation order
is based on failure impact and how often prompt-only behavior has left branches,
worktrees, or tickets behind.

### P0 — workflow and integration correctness

- `workflow.preflight_transition`
- `workflow.verify_children_complete`
- `workflow.verify_review_approval`
- `workflow.verify_consensus`
- `workflow.verify_required_functions`
- `workflow.complete_ticket`
- `workflow.reopen_ticket`
- `workflow.handoff_ticket`
- `workflow.block_ticket`
- `workflow.request_human_decision`
- `git.resolve_repository_context`
- `git.inspect_repository`
- `git.prepare_ticket_branch`
- `git.inspect_branch`
- `git.rebase_branch`
- `git.push_branch`
- `git.create_or_update_pull_request`
- `git.verify_review_freshness`
- `git.integrate_branch`
- `git.verify_integration`
- `git.delete_remote_branch`
- `git.delete_local_branch`
- `git.cleanup_worktree`
- `git.reconcile_orphan_branches`
- `git.sync_production_overlay`
- `git.bump_submodule_pointer`

`workflow.complete_ticket` should be a pipeline whose blocking verification and
integration steps all succeed before the ticket is moved to a terminal column.
Branch/worktree deletion belongs after integration verification, never merely
after an Agent says it merged.

### P1 — quality, release, and recovery

- `quality.build`
- `quality.typecheck`
- `quality.test`
- `quality.lint`
- `quality.security_scan`
- `quality.verify_artifacts`
- `release.create`
- `release.publish`
- `deploy.plan`
- `deploy.execute`
- `deploy.verify`
- `deploy.rollback`
- `workflow.detect_stuck_ticket`
- `workflow.reconcile_dispatch`
- `workflow.recover_interrupted_run`
- `workflow.expire_stale_approval`

### P2 — agent and workspace operations

- `agent.spawn`
- `agent.stop`
- `agent.restart`
- `agent.set_working_directory`
- `agent.reload_configuration`
- `agent.verify_connectivity`
- `workspace.clone_repository`
- `workspace.refresh_repository`
- `workspace.validate_credentials`
- `workspace.rotate_credential`
- `workspace.archive_artifacts`
- `notification.send`
- `notification.request_approval`

## Applying Functions to workflow transitions

The durable target is a Function binding layer:

- event: `manual`, `before_transition`, `after_transition`, or `schedule`;
- workspace/board/source-column/destination-column filters;
- blocking or asynchronous mode;
- optional condition;
- `required_for_transition`.

Before-transition bindings must fail closed: a required Function timeout,
missing executor, or failed run prevents the state transition. After-transition
bindings may run asynchronously, but their failure remains visible in Function
run history and workflow health. The binding layer should call the same
`WorkflowFunctionsService.execute()` path used by REST and MCP so behavior does
not diverge by caller.

## MCP surface

- `list_functions`
- `get_function`
- `save_function` (workspace scope only)
- `delete_function` (workspace-authored only)
- `execute_function`
- `list_function_runs`

Global authoring stays on the authenticated Admin REST/UI path. MCP API keys
bound to a workspace cannot manage or execute another workspace's Functions.
