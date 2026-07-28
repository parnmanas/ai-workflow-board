# Board UX guidelines

AWB uses a chat-first navigation hierarchy. Board navigation separates
operational board pages from reusable automation configuration.

## Navigation

The persistent desktop sidebar is ordered by user intent:

1. Chat and its independently scrollable room list;
2. Work (Boards and AI Agents);
3. Automation (Functions, Actions, Schedules);
4. Knowledge (Resources, Prompt Templates);
5. Quality (QA, Security);
6. Settings;
7. admin-only Operations diagnostics.

Mobile uses the same hierarchy in an off-canvas drawer. Do not create a second
navigation inventory for mobile or for Chat mode.

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

Functions, Resources, Prompt Templates, Actions, QA, Security, and Schedules are
independent feature entries. Credentials and Claude Profiles are independent
Settings entries. There is no intermediate Automation Catalog page.

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
page. Workspace and Board QA definitions remain on the QA page. Agent Manager
runtime operations are integrated into AI Agents, while Workflow Health remains
an independent Admin diagnostic page. The internal system-QA and column-policy
APIs have no standalone navigation.

Settings pages use `/ws/:workspaceId/settings/*`. The Settings Overview page
groups related destinations, while the sidebar keeps direct one-click links to
each destination. Legacy workspace and Admin management URLs must redirect to
the canonical Settings route.

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
