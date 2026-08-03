# CLI Column Prompt Consistency and Reset Design

## Goal

Make Claude and Codex subagents execute only the work assigned to the ticket's current column, without opportunistically performing later-column verification, review, merge, deployment, or release work. Agents should investigate available context and proceed autonomously, asking the user only when a concrete decision or unavailable input blocks the current-column task.

Provide staged reset controls for both workspace default workflow prompt content and board column-to-template mappings. Reset actions must not affect persisted prompts or running agents until the user explicitly saves them.

## Current Behavior and Root Cause

AWB already resolves a workspace/board harness and sends it with ticket dispatches. Claude declares support for the full harness surface and maps it to `--append-system-prompt`, `--allowedTools`, `--disallowedTools`, `--model`, and `--permission-mode`. Codex does not declare those harness keys, so the manager partitions most of them out and logs them as skipped. Codex receives its role prompt as ordinary task text and always launches with `--dangerously-bypass-approvals-and-sandbox`.

The installed CLIs confirm the capability mismatch:

- Claude Code 2.1.220 supports system-prompt append, tool allow/deny lists, model, effort, fallback model, and permission mode flags.
- Codex CLI 0.144.3 supports model, sandbox, profile/config overrides, working directory, and approval/sandbox bypass, but has no direct append-system-prompt or tool allow/deny equivalent in `codex exec`.

Default workflow prompts are copied into each workspace as mutable `PromptTemplate` rows. Boards store column-to-template IDs in `Board.column_prompts`. The current UI persists board mapping changes immediately and has no operation that restores built-in template content or default mappings.

## Design Principles

1. The column workflow guide is the authoritative stage boundary.
2. A subagent may perform work explicitly required by the current column, but must not pre-run responsibilities assigned to a later column.
3. Generic agent defaults must not expand a ticket's scope beyond its current column.
4. Agents inspect ticket context, repository state, and available AWB data before asking questions. They ask only for a concrete missing decision, permission, secret, or irreversible-risk approval.
5. Reset is an editor action, not a persistence action. Nothing changes outside the current browser state until Save succeeds.
6. Multi-row reset persistence is atomic. A failed save leaves all stored prompts and mappings unchanged.
7. User-created templates are never modified or deleted by a default reset.

## Common Current-Column Contract

Agent Manager will prepend one compact AWB execution contract to every ticket trigger prompt, independent of CLI:

- Treat the current column workflow guide as the complete stage scope.
- Perform only the work required by that guide and the ticket instructions.
- Do not perform validation, review, merge, deployment, release, cleanup, or completion work assigned to a later column unless the current guide explicitly requires it.
- Do not broaden the task with optional audits, refactors, documentation, publishing, or follow-up work.
- Inspect accessible context and make safe, reversible assumptions before asking the user.
- Ask only when the current-column work is blocked by a concrete product decision, unavailable credential/permission, missing required input, or irreversible risk.
- When current-column completion criteria are met, report the result and advance only as the workflow guide instructs.

The contract is placed before role, ticket, and column content so both Claude and Codex see the same scope boundary. Existing column prompts remain responsible for their column-specific completion criteria.

The seven built-in workflow templates will also receive concise boundary language appropriate to their stage. For example, In Progress may implement and run only the checks its guide requires, but it must not conduct Review, merge to the default branch, deploy, or perform Done-stage auditing. Merging may perform integration checks required to land the branch, but it must not invent a deployment step.

## CLI Option Mapping

### Claude

Claude keeps its existing native mappings:

- role prompt plus resolved harness system prompt through `--append-system-prompt`;
- AWB baseline tools plus configured additions through `--allowedTools`;
- configured exclusions through `--disallowedTools`;
- configured model and effort flags;
- configured permission mode, otherwise the existing managed bypass behavior.

The common current-column contract is included in the task prompt as an AWB-owned invariant, so it is present for both one-shot and persistent ticket sessions.

### Codex

Codex will explicitly support the harness keys it can faithfully represent:

- `model` maps to `--model` through the existing model precedence path;
- `system_prompt_append` is rendered as a clearly delimited AWB system-policy section before role and task text because `codex exec` has no append-system-prompt flag;
- `permission_mode` is normalized to Codex's available sandbox/approval launch modes rather than silently ignored.

Claude-only `allowed_tools` and `disallowed_tools` remain unsupported for Codex unless AWB can enforce an equivalent tool surface. They are reported as skipped instead of being presented as effective configuration. The UI will label option applicability so an administrator can see which fields are Claude-only and which apply to both CLIs.

Codex will no longer use a single unconditional launch policy when a supported permission setting is present. The mapping will be explicit and covered by adapter tests. AWB's default managed mode remains non-interactive so routine ticket work does not repeatedly ask for confirmation.

## Workspace Default Prompt Reset

The workspace Prompt Templates page will distinguish built-in workflow templates from user-created templates using stable built-in names and `column_match` metadata supplied by the server's reset preview/catalog response.

Each built-in template row gets a Reset action. Reset copies the latest built-in name, description, category, and content into client draft state for that template. The row is marked modified, but no request is sent.

The page also gets `Reset all column prompts`. It stages the latest built-in values for all seven workflow templates. User-created templates remain unchanged.

A single Save action submits the complete staged default-template reset batch. The server executes it in a transaction:

1. Update matching existing built-in rows in place so their IDs remain stable.
2. Create any missing built-in rows.
3. When full workspace reset is requested, recompute default mappings for every board in the workspace by matching column names case-insensitively to `column_match`.
4. Preserve non-matching custom-column mappings and all user-created templates.
5. Commit only after every template and board mapping update succeeds.

Cancel or navigation with discarded drafts leaves persisted data unchanged. The UI will use its existing unsaved-change protection pattern where practical.

## Board Column Mapping Reset

Board Settings will maintain a local draft of `column_prompts` instead of saving each selector change immediately.

Each column gets a Reset action that stages the workspace's default template ID matching that column's current name. If no built-in definition matches, Reset stages no mapping and explains that the column has no built-in default.

`Reset all column mappings` stages defaults for every matching column in the board. Non-matching custom-column mappings are preserved rather than erased.

The section gets explicit Save and Cancel actions:

- Save sends one `column_prompts` update and refreshes the board after success.
- Cancel restores the last persisted mapping.
- Selector edits and Reset actions only alter the local draft.
- Save failure retains the draft for correction/retry while the persisted board remains unchanged.

## API and Data Flow

The prompt-template API will expose a workspace-scoped built-in defaults catalog or reset-preview response containing stable template name, description, category, content, and `column_match`. This keeps the client from duplicating large default prompt strings.

A workspace reset endpoint accepts the staged set of built-in template names plus whether all board mappings should be recomputed. It rejects unknown names, verifies workspace permission, and performs the batch transaction.

The existing board PATCH remains the persistence endpoint for board mapping drafts because it already validates that column and template IDs belong to the board/workspace. Only the client interaction changes from immediate writes to staged Save.

Dispatch continues to resolve the stored template at trigger time. Unsaved drafts never enter an agent prompt; after a successful Save, new dispatches use the updated content or mapping. Existing live CLI sessions are not mutated mid-turn.

## Error Handling

- Unknown or non-built-in reset targets return a validation error and make no changes.
- Cross-workspace template or board references are rejected by existing scope checks.
- Workspace reset transaction failure rolls back template creation, template updates, and board mapping changes together.
- Missing built-in templates are recreated during workspace reset rather than treated as fatal.
- A board column with no built-in name match is left unchanged during reset-all and is reported in the preview/UI.
- Concurrent edits are handled by returning refreshed server state after Save; the client does not claim success until the transaction completes.

## Testing

### Agent Manager

- Claude and Codex trigger prompts contain the same current-column execution contract.
- Codex receives resolved `system_prompt_append` in a delimited policy block.
- Codex applies the supported model and permission/sandbox mapping.
- Unsupported Codex tool allow/deny keys remain visibly skipped.
- Claude's existing native harness flags remain unchanged.

### Server

- A single built-in reset updates only the selected built-in row and preserves its ID.
- Full workspace reset updates all built-ins, creates missing rows, and preserves user templates.
- Full reset recomputes matching board mappings while preserving custom-column mappings.
- Any failure rolls back every update in the batch.
- Unknown targets and cross-workspace attempts are rejected.

### Client

- Per-template and reset-all actions change draft state without making API calls.
- Workspace Save submits one batch; Cancel/discard leaves persisted state unchanged.
- Per-column and reset-all mapping actions change draft state without making API calls.
- Board Save submits one mapping update; Cancel restores persisted selections.
- Failed saves do not display applied state and retain recoverable drafts.

## Out of Scope

- Resetting user-created templates.
- Resetting agent-specific role prompts or workspace role prompts.
- Mutating prompts inside already-running CLI turns.
- Emulating Claude tool allow/deny flags in Codex without an enforceable Codex capability.
- Automatically running deployment, release, or post-merge actions as part of reset.
