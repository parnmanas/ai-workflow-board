# Board UX guidelines

Board navigation separates operational board pages from reusable automation
configuration.

## Navigation

The Board header and sub-menu expose only board operations:

- board status controls such as Pause / Resume;
- ticket and feature views;
- Archive, Settings, and Benchmark when enabled;
- no reusable-definition manager links.

Reusable definitions retain independent type routes for direct access:

```text
/ws/:workspaceId/:managementType
/ws/:workspaceId/boards/:boardId/:managementType
```

Do not add a new board-only manager page for a reusable automation definition.
Reuse the same type manager and provide the Board context explicitly.

## Management menus

Functions, Credentials, Resources, Prompt Templates, Actions, QA, Security,
Schedules, and Claude Profiles are independent Workspace menu entries. There is
no intermediate Automation Catalog page.

- Functions, Credentials, Resources, and Prompt Templates use Global,
  Workspace, and Board scopes.
- Their Workspace page lists only Global plus the current Workspace rows.
- New definitions choose between `workspace_id = NULL` (Global) and the current
  Workspace directly on that page.
- Actions, QA, Security, and Schedules use Workspace and Board scopes because
  they bind workspace agents and retain workspace execution history.
- Scope is chosen only when an item is created and is immutable afterward.
- Board scope always requires a board belonging to the selected workspace.
- Every row shows a scope badge.

Claude backend definitions and Workspace assignment share the Claude Profiles
page. System QA, Column Policies, and Workflow Health remain independent Admin
menus because they are system operations rather than scoped reusable
definitions.

See [Catalog scopes](catalog-scopes.md) for the data model, inheritance rules,
authorization, and implementation checklist.

## Header behavior

- Keep state-changing controls visually separate from navigation.
- Keep primary actions to two or three items; put infrequent pages in overflow.
- Collapse labels before moving navigation into overflow on narrow layouts.
- Use shared tokens and common UI primitives rather than page-local button
  styles.
- Preserve the workspace and board context in every management link.

## New board UI checklist

- Use `PageHeader` and shared common controls.
- Keep routes under `/ws/:workspaceId/boards/:boardId`.
- Put reusable configuration in its type-specific Workspace/Board menu.
- Verify empty, loading, error, and permission-denied states.
- Verify keyboard focus, narrow layouts, and long names.
- Verify the target board belongs to the current workspace server-side.
