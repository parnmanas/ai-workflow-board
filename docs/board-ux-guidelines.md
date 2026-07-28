# Board UX guidelines

Board navigation separates operational board pages from reusable automation
configuration.

## Navigation

The Board header and sub-menu expose only board operations:

- board status controls such as Pause / Resume;
- ticket and feature views;
- Archive, Settings, and Benchmark when enabled;
- one **Automation Catalog** entry carrying the current `board` query.

Resources, Actions, QA, and Security no longer have independent Board
management pages. Their legacy URLs redirect to:

```text
/ws/:workspaceId/catalog?tab=:tab&scope=board&board=:boardId
```

Do not add a new board-only manager page for a reusable automation definition.
Add it as a Catalog tab and make the scope explicit instead.

## Automation Catalog

The Catalog displays applicable scopes together so operators can compare
inheritance and overrides without navigating between Admin, Workspace, and
Board pages.

- Functions, Credentials, Resources, and Prompt Templates use Global,
  Workspace, and Board scopes.
- Actions, QA, Security, and Schedules use Workspace and Board scopes because
  they bind workspace agents and retain workspace execution history.
- Scope is chosen only when an item is created and is immutable afterward.
- Board scope always requires a board belonging to the selected workspace.
- Every row shows a scope badge.

Legacy workspace and Admin routes redirect to the relevant Catalog tab. New
navigation must link directly to the Catalog rather than relying on redirects.

See [Catalog scopes](catalog-scopes.md) for the data model, inheritance rules,
authorization, and implementation checklist.

## Header behavior

- Keep state-changing controls visually separate from navigation.
- Keep primary actions to two or three items; put infrequent pages in overflow.
- Collapse labels before moving navigation into overflow on narrow layouts.
- Use shared tokens and common UI primitives rather than page-local button
  styles.
- Preserve the workspace and board context in every Catalog link.

## New board UI checklist

- Use `PageHeader` and shared common controls.
- Keep routes under `/ws/:workspaceId/boards/:boardId`.
- Put reusable configuration in Automation Catalog.
- Verify empty, loading, error, and permission-denied states.
- Verify keyboard focus, narrow layouts, and long names.
- Verify the target board belongs to the current workspace server-side.
