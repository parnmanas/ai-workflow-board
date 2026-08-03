# CLI Column Prompt Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Claude and Codex current-column behavior and add explicitly saved workspace-template and board-mapping reset flows.

**Architecture:** Agent Manager owns one CLI-neutral current-column contract and lets adapters translate only faithfully supported harness settings. The server exposes built-in workflow definitions and applies workspace reset batches transactionally. Client editors hold reset/select changes locally until a single Save call succeeds.

**Tech Stack:** TypeScript, Node test runner, NestJS, TypeORM, React 18, existing AWB component/token system.

## Global Constraints

- Current-column instructions are authoritative; later-column verification, review, merge, deployment, and completion work are not performed early.
- Agents investigate accessible context and proceed with safe assumptions before asking for user input.
- Reset actions only edit local draft state; Save is the only persistence action.
- Workspace batch reset is atomic and preserves user-created templates.
- Existing user-owned uncommitted changes must be preserved.
- Work is committed and pushed directly to `main` because the user explicitly requested it.

---

### Task 1: Shared current-column contract and Codex harness parity

**Files:**
- Modify: `apps/agent-manager/src/lib/prompts.ts`
- Modify: `apps/agent-manager/src/lib/cli-adapters/codex.ts`
- Modify: `apps/agent-manager/src/lib/cli-adapters/base.ts`
- Test: `apps/agent-manager/test/harness-config.test.mjs`
- Test: `apps/agent-manager/test/codex-adapter.test.mjs`

**Interfaces:**
- Produces: `CURRENT_COLUMN_EXECUTION_CONTRACT: string`
- Produces: Codex `harnessKeys()` support for `system_prompt_append`, `model`, and `permission_mode`
- Consumes: existing `HarnessSpec`, `partitionHarness()`, `composeTriggerPrompt()`, and `OneshotSpec`

- [ ] **Step 1: Write failing prompt and adapter tests**

Add behavioral tests which compose a real trigger prompt and assert that it limits work to the current column and directs the agent to investigate before asking. Add Codex adapter tests that pass a harness and assert the generated stdin begins with a delimited AWB policy, the model survives partitioning, and permission modes produce the expected sandbox/bypass arguments. The tests must assert that tool allow/deny keys remain skipped.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm run build && node --test test/harness-config.test.mjs test/codex-adapter.test.mjs` from `apps/agent-manager`.

Expected: failures because the common contract, Codex harness keys, and Codex permission mapping do not exist.

- [ ] **Step 3: Implement the minimal prompt and adapter behavior**

Prepend a compact contract in `composeTriggerPrompt()`. In the Codex adapter, declare only faithfully supported keys, delimit the resolved system prompt before role/task content, and map permission modes onto supported Codex `--sandbox` or managed bypass arguments. Keep tool lists unsupported and preserve the current default non-interactive launch behavior when permission mode is unset.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same focused command and require zero failures.

### Task 2: Transactional workspace built-in prompt reset API

**Files:**
- Modify: `apps/server/src/modules/prompt-templates/prompt-templates.service.ts`
- Modify: `apps/server/src/modules/prompt-templates/prompt-templates.controller.ts`
- Modify: `apps/server/src/database/default-prompt-templates.ts`
- Test: `apps/server/test/prompt-template-reset.integration.test.mjs`

**Interfaces:**
- Produces: `GET /api/prompt-templates/defaults?workspace_id=<id>`
- Produces: `POST /api/prompt-templates/reset` with `{ workspace_id, names, reset_board_mappings }`
- Returns: refreshed workspace templates and built-in metadata including `column_match`
- Consumes: `DEFAULT_PROMPT_TEMPLATES`, `PromptTemplate`, `Board`, and `BoardColumn`

- [ ] **Step 1: Write failing integration tests**

Cover a single reset preserving the row ID, full reset recreating a missing built-in, preservation of a custom template, matching board mapping repair, preservation of custom-column mappings, rejection of unknown names, and rollback when a batch operation fails.

- [ ] **Step 2: Run the focused server test and verify RED**

Run: `npm run build && node test/run-suite.mjs test/prompt-template-reset.integration.test.mjs` from `apps/server`.

Expected: route-not-found or missing-method failures.

- [ ] **Step 3: Implement defaults catalog and transaction**

Expose serializable built-in metadata. Validate reset names against the catalog. Use `DataSource.transaction()` to update matching rows in place, create missing rows, and when requested rebuild only recognized default-column entries on every workspace board while retaining mappings for unmatched custom columns.

- [ ] **Step 4: Run the focused server test and verify GREEN**

Run the same focused server command and require zero failures.

### Task 3: Workspace prompt reset drafts

**Files:**
- Modify: `apps/client/src/api.ts`
- Modify: `apps/client/src/types.ts`
- Modify: `apps/client/src/components/admin/PromptTemplateManager.tsx`
- Create: `apps/client/src/utils/promptResetDraft.ts`
- Test: `apps/client/test/prompt-reset-draft.test.mjs`

**Interfaces:**
- Produces: pure draft helpers `resetTemplateDraft()` and `resetAllTemplateDrafts()`
- Consumes: defaults catalog and reset API from Task 2

- [ ] **Step 1: Write failing pure-state tests**

Using literal fixtures, assert that a single reset changes only one built-in draft, reset-all changes all built-ins, custom templates are untouched, and no persistence callback is involved in either helper.

- [ ] **Step 2: Run the focused client test and verify RED**

Run: `node --import tsx --test test/prompt-reset-draft.test.mjs` from `apps/client`.

Expected: module-not-found failure for the draft helpers.

- [ ] **Step 3: Implement draft helpers and editor controls**

Load the built-in catalog with templates. Add per-row Reset, `Reset all column prompts`, an unsaved-change indicator, Save changes, and Cancel. Reset only changes draft state; Save calls one reset batch and reloads after success. Keep existing create/edit/delete behavior and existing AWB tokens/components.

- [ ] **Step 4: Run the focused client test and build**

Run: `node --import tsx --test test/prompt-reset-draft.test.mjs && npm run build` from `apps/client`.

Expected: test pass and TypeScript/Vite build exit 0.

### Task 4: Board column mapping reset drafts

**Files:**
- Modify: `apps/client/src/components/ColumnManager.tsx`
- Modify: `apps/client/src/components/BoardSettingsPage.tsx`
- Modify: `apps/client/src/utils/promptResetDraft.ts`
- Test: `apps/client/test/prompt-reset-draft.test.mjs`

**Interfaces:**
- Produces: `resetColumnMappingDraft()` and `resetAllColumnMappingDrafts()`
- ColumnManager consumes persisted mappings, built-in defaults, and a single `onSaveColumnPrompts()` callback

- [ ] **Step 1: Add failing mapping-draft tests**

Assert that a single matching column selects its default, an unmatched custom column remains unchanged, reset-all updates every recognized column while preserving unmatched mappings, and cancel can restore the original literal mapping.

- [ ] **Step 2: Run the focused test and verify RED**

Run the focused client test and confirm failures for missing mapping helpers.

- [ ] **Step 3: Implement staged Board Settings controls**

Move mapping state into ColumnManager draft state synchronized from props. Selector changes and reset buttons mutate only the draft. Add per-column Reset plus section-level Reset all, Save changes, and Cancel. Make Save send one board PATCH and refresh only on success; preserve the draft on failure.

- [ ] **Step 4: Run focused test and client build**

Require the focused test and client build to pass.

### Task 5: Full verification, documentation, and delivery

**Files:**
- Modify: `docs/cli-runtime-profiles.md` if option applicability needs operator documentation
- Modify: `docs/superpowers/plans/2026-08-03-cli-column-prompt-consistency.md` checkboxes only

**Interfaces:**
- Consumes all deliverables from Tasks 1-4

- [ ] **Step 1: Verify all affected packages**

Run agent-manager full tests, server focused reset plus prompt-template scope tests, client full tests, and all three package builds.

- [ ] **Step 2: Review diffs and requirement coverage**

Confirm no unrelated user changes are staged, reset paths are draft-only until Save, custom templates/mappings are preserved as specified, and both CLI prompts enforce the same stage boundary.

- [ ] **Step 3: Commit intentionally**

Stage only files belonging to this feature and commit with a scoped message. Do not include pre-existing unrelated modifications.

- [ ] **Step 4: Push main**

Push the verified commit(s) to `origin/main` and report the resulting commit SHA.
