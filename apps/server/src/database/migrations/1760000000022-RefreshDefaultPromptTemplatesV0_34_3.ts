import { MigrationInterface, QueryRunner } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { DEFAULT_PROMPT_TEMPLATES } from '../default-prompt-templates';

/**
 * Refresh the To Do / Plan / In Progress default workflow prompt templates
 * on existing workspaces so already-installed boards actually receive the
 * v0.34.3 "park instead of ping-pong" guidance (ticket a57517be —
 * Ticket Blocking 개선).
 *
 * Why the prior seed/backfill paths are not enough:
 *   - `PromptTemplatesService.seedDefaults` only INSERTs templates whose
 *     `name` is missing in the workspace.
 *   - Migration `1760000000010-BackfillDefaultPromptTemplates` follows the
 *     same name-match insert-only contract — it explicitly preserves
 *     existing rows so operator customizations survive.
 *
 *   That means any workspace seeded before v0.34.3 keeps its
 *   `todo_workflow` / `plan_workflow` / `in_progress_workflow` rows with
 *   the v0.34.2 content, and agents on those boards never learn to call
 *   `pend_ticket` / `create_ticket`. Requirement #2 of the ticket
 *   (encourage agents to park or split rather than bounce) silently
 *   fails on every upgraded install — which is exactly the deployment
 *   where the System ↔ Agent loop bug shows up.
 *
 * Operator-safety contract — content match is byte-exact:
 *   - PRIOR_DEFAULT_CONTENTS holds the verbatim v0.34.2 template literal
 *     content for each refreshed name (preserving escapes so the runtime
 *     string equals what `seedDefaults` originally wrote).
 *   - We only UPDATE a row when its `content` matches the prior value
 *     exactly. Any operator tweak (even a typo fix) breaks the match
 *     and the row is left alone.
 *   - We never insert rows here — that's the seed/backfill path's job.
 *
 * Idempotency:
 *   - Re-running after the migration is fully applied is a no-op: rows
 *     now hold the current default content, which is NOT in the prior
 *     list, so the match fails and nothing updates.
 *   - Safe to run alongside `seedDefaults` (workspace-create) and
 *     `1760000000010` (existing-workspace insert) — those touch
 *     different rows / paths.
 *
 * Future revisions: when the default content changes again, push the
 * now-current content onto PRIOR_DEFAULT_CONTENTS[name] and bump
 * `DEFAULT_PROMPT_TEMPLATES` in the same change. The next deploy will
 * carry both v0.34.2 → current AND v0.34.3 → current upgrades, still
 * leaving operator-customized rows untouched.
 *
 * Constraint matrix:
 *   - D-02: data only, no schema DDL.
 *   - D-04: idempotent — see above.
 *   - Reviewer ask (2026-05-25): "idempotent data migration or versioned
 *     prompt-sync path that updates the relevant default workflow
 *     templates for existing workspaces without clobbering
 *     operator-customized templates".
 */

// ── Prior-default content blocks ──────────────────────────────────────
// Copied verbatim from `default-prompt-templates.ts` at commit 7722527~1
// (the last revision before the "park instead of ping-pong" change).
// MUST be kept literally identical to what `seedDefaults` wrote to the DB
// for each name. Do NOT reformat or normalize whitespace — any drift
// breaks the byte-exact match and the migration silently turns into a
// no-op on workspaces that actually need the refresh.

const PRIOR_TODO_WORKFLOW = `# To Do — Start-or-Wait Decision (assignee)

This ticket is in the To Do column and you are its assignee. Decide whether to start now or wait.

> **Environment**: assignee has a local repo and will do real development. No git commands yet — those begin in \`in_progress_workflow\`. This prompt is purely a decision step.

## Steps

1. **Read the ticket** — \`mcp__awb__get_ticket\` to load body, comments, assignee / reporter / reviewer, priority, and any attached context. If requirements are unclear, leave a question comment and stop (do not \`move_ticket\`).

2. **List your in-progress work** — \`mcp__awb__get_my_tickets\` with \`status="in_progress"\` to see everything you are currently working on.

3. **Concurrent-work check**:
   - **No active work** → safe to start immediately.
   - **Active work exists** → for each in-progress ticket, evaluate:
     - **File / module overlap** — will this ticket touch the same files, modules, or packages?
     - **Dependency** — does this ticket need output (API, entity, migration, schema) from the in-progress ticket?
     - **Shared resources** — DB migrations, CI pipelines, or shared config files that are hard to isolate.
   - If *every* in-progress ticket is independent, parallel is OK. A single overlap means **wait**.

4. **Decision**:
   - **Start** → \`add_comment\` with:
     - A one-line "starting" declaration.
     - If running in parallel: list concurrent ticket ids and the independence rationale (e.g., \`"touching apps/client/src/components/chat/* only — no overlap with ticket 1f92d68"\`).
     Then \`move_ticket\` to **In Progress**.
   - **Wait** → \`add_comment\` with the waiting reason and which ticket you are waiting on. Do **not** \`move_ticket\`.

5. **After In Progress** — \`in_progress_workflow\` takes over with the branch → work → push → Review hand-off flow.

## Notes

- If you already have **3 or more in-progress tickets**, finish one before starting a new one. Context-switch cost outweighs concurrency.
- Never start a ticket whose file / module scope overlaps with an active one. Sequential is the default.
- When in doubt, ask the reviewer or reporter via \`add_comment\` and wait — never start on a guess.
- If a \`priority: critical\` ticket enters the queue, finish the current commit boundary (commit + push) on your non-critical work cleanly, then pick the critical. Never abandon mid-file.
- If you are not the assignee, do not \`move_ticket\`. If this looks like a misassignment, leave a comment and stop.
`;

const PRIOR_PLAN_WORKFLOW = `# Plan — Concrete Plan Before Code (planner)

This ticket is in the Plan column and you were triggered as its planner. Your job: turn the ticket's intent into a concrete plan an assignee can execute without re-deriving the design — then hand it off to In Progress. If the requirements are still ambiguous, ask the reporter and wait.

> **Environment**: planner may have no local repo. This prompt is MCP-only — do not issue git, gh, or shell commands. The plan itself is a comment (and optionally subtasks); no code changes here.

## Steps

1. **Load full context**
   - \`mcp__awb__get_ticket\` for the ticket body, description, all comments, role assignments, and subtree.
   - If the ticket has a \`parent_id\`, \`mcp__awb__get_ticket\` on the parent too — the parent often holds the surrounding constraint.
   - Read the \`prompt_text\` snapshot pinned to the ticket and the originating description end-to-end. **Do not skim.**

2. **Ambiguity sweep** — list every gap the assignee would hit:
   - Behaviour not pinned down (edge cases, error paths, idempotency, ordering).
   - Touch points outside the ticket scope (other components / services / agents).
   - Acceptance criteria that aren't explicit.
   - Performance / scaling assumptions.
   - **For each blocking gap**: \`add_comment\` with a focused question, mention the **reporter** (\`@[role:reporter|<name>]\`), and stop. Do not \`move_ticket\` — answers re-trigger you. Never guess intent.
   - **For non-blocking gaps** (implementation detail the assignee can call): note them in the plan rather than blocking on the reporter.

3. **Decompose the work** — produce a numbered task breakdown. Each step should specify:
   - **Where**: files / components / modules touched (be concrete — \`apps/server/src/modules/foo/foo.controller.ts\`, not "the foo module").
   - **What**: the behaviour change in one line.
   - **Done when**: the observable outcome that confirms the step (test passes, endpoint returns X, UI shows Y).
   - **Risk / rollback**: only when relevant — DB migration, breaking API change, shared-config edit, etc.
   - **Test surface**: what to add or update so the change is verifiable.

   Keep each step small enough that a reviewer can sign off on it independently. If a step says "do all the rest", break it down further.

4. **Cross-cutting concerns** — finish with a short trailing block, only including the lines that apply:
   - Security / privacy (auth, PII, ratelimits).
   - Performance / scaling (N+1, hot paths, large tables).
   - Observability — what logs / metrics / traces should appear.
   - Migrations or feature flags needed.
   - Backward compatibility notes for callers / downstream systems.

5. **Subtasks (optional)** — if the breakdown has 3+ independent steps that map to separate commits AND each is big enough to track individually, \`mcp__awb__create_child_ticket\` for each. For smaller plans, keep the breakdown as the plan comment alone — subtasks add overhead.

6. **Post the plan** — \`add_comment\` with the full plan markdown. Mention the **assignee** (\`@[role:assignee|<name>]\`) so they receive a fresh trigger when the ticket lands in In Progress.

7. **Hand off** — \`mcp__awb__move_ticket\` to **In Progress**. The \`in_progress_workflow\` takes over with the branch → work → push → Review flow.

## Notes

- **The planner plans — does not implement.** No git, no gh, no code edits, no PR opens. Steps 5–7 are administrative; step 6 is the plan itself.
- **Don't fabricate certainty.** Ambiguous requirements stay in Plan with a question, not in In Progress with a guess. This is the failure mode the column exists to prevent.
- **Plans should fit in one comment** (~80 lines of markdown). If it's longer than that, the ticket is too big — propose a split into child tickets in the plan instead.
- **Cite the spec.** When the plan references a behaviour, link or quote the line from the ticket description / parent / referenced doc that drives it. The assignee should be able to challenge the plan against the source, not against your interpretation.
- **No self-mention.** Planner comments must not use \`@[role:planner|...]\`. Mention only the reporter, assignee, or reviewer. Self-mentions cause recursive triggers.
- **Re-planning is OK.** If a ticket bounces back from Review or In Progress with a "the plan was wrong" finding, treat it as a fresh plan trigger — load the latest state, refine the plan, re-hand off. Do not re-use a stale plan unchanged.
- If you are **not** the planner on this ticket, leave a one-line "not the planner — stopping" comment and exit. Do not \`move_ticket\`.
`;

const PRIOR_IN_PROGRESS_WORKFLOW = `# In Progress — Branch Work (assignee)

This ticket is in the In Progress column. Implement the work on a feature branch and hand it off to Review.

> **Environment**: assignee has a full local repo. Use real git commands here. Do NOT merge to default — that happens in \`merging_workflow\` after Review approval.

## Steps

1. **Create or reuse the feature branch**
   - \`git fetch origin\`
   - Resolve the base branch:
     - If the trigger prompt includes a **Base repository** block, use the \`Base branch\` listed there. Verify your \`working_dir\` is a clone of the listed URL — if it isn't, stop and ask in a comment instead of guessing.
     - Otherwise, fall back to the repository's default branch (\`origin/HEAD\`).
   - Pull the base branch to the latest tip: \`git checkout <base-branch> && git pull --ff-only origin <base-branch>\`.
   - From that up-to-date base, \`git checkout -b ticket/{ticket_id_short}-{slug}\` where:
     - \`ticket_id_short\` — first 8 chars of the ticket id.
     - \`slug\` — lowercase alphanumeric-and-hyphen slug derived from the ticket title (fall back to id only if no usable tokens).
   - If the branch already exists (ticket bounced back from Review), \`git checkout\` and reuse it. Amend or append commits; do **not** start over with a new name.

2. **Do the work** — implement the requirement. Split commits by logical unit (one commit per one change).

3. **Push** — \`git push -u origin <branch-name>\`.
   - **Submodule projects**: if the change is inside a submodule, push the submodule's feature branch here, but **do NOT bump the parent repo's submodule ref yet**. The parent bump happens in Merging, after the submodule default branch has absorbed the change.
   - Before the final push, rebase onto the latest default so Merging can do a fast-forward: \`git fetch origin && git rebase origin/<default>\`. If this is a re-push after a rebase, use \`git push --force-with-lease\` on the feature branch (never the default branch).

4. **Ticket comment** — \`add_comment\` with:
   - Branch name (exactly as pushed).
   - 3–5 line summary of the main changes.
   - Build / test results if you ran them.
   - If a PR already exists, its URL.

5. **Move to Review** — \`move_ticket\` to the **Review** column.

## Notes

- **Never push directly to master / main / the default branch.** Reviewer and Merging stages gate that.
- If the plan is unclear or the requirement is ambiguous, leave a comment and stop — do not guess.
- Out-of-scope bugs or refactor itches are not yours here. Propose a new ticket in a comment.
- Keep the feature branch rebased onto the latest default before the final push. Merging expects a clean ff.
- \`--force-with-lease\` is OK on the feature branch only. Force-pushing to a shared branch (default, release, …) is forbidden.
- For PR-gated repos, open the PR with \`gh pr create --draft\` during this stage and include its URL in the comment so Review can inspect the diff remotely.
`;

// Map: template name → list of known prior contents that should be
// refreshed to the current default. List shape (rather than single
// string) lets a future revision append the now-current content as the
// next "prior" without losing the v0.34.2 → current upgrade path for
// workspaces that skip a release.
//
// Exported so the regression test (test/qa-flows/prompt-template-refresh.test.mjs)
// can seed fixture rows with byte-exact prior content without re-encoding
// the full template literal in the test file — the test stays in lockstep
// with the migration as future revisions extend the prior list.
export const PRIOR_DEFAULT_CONTENTS: Record<string, string[]> = {
  todo_workflow: [PRIOR_TODO_WORKFLOW],
  plan_workflow: [PRIOR_PLAN_WORKFLOW],
  in_progress_workflow: [PRIOR_IN_PROGRESS_WORKFLOW],
};

export class RefreshDefaultPromptTemplatesV0_34_31760000000022 implements MigrationInterface {
  name = 'RefreshDefaultPromptTemplatesV0_34_31760000000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const wsRepo = manager.getRepository(Workspace);
    const tplRepo = manager.getRepository(PromptTemplate);

    // Build current-content lookup once. Names not in
    // PRIOR_DEFAULT_CONTENTS are intentionally ignored — this migration
    // only refreshes the three templates touched by the v0.34.3 change.
    const currentByName = new Map<string, string>();
    for (const def of DEFAULT_PROMPT_TEMPLATES) {
      if (def.name in PRIOR_DEFAULT_CONTENTS) {
        currentByName.set(def.name, def.content);
      }
    }

    const workspaces = await wsRepo.find();
    let updated = 0;
    let customized = 0;
    let missing = 0;
    let alreadyCurrent = 0;

    for (const ws of workspaces) {
      for (const name of Object.keys(PRIOR_DEFAULT_CONTENTS)) {
        const row = await tplRepo.findOne({ where: { workspace_id: ws.id, name } });
        if (!row) {
          // Workspace doesn't have this template yet (e.g. seeded before
          // the template existed and not yet backfilled). Skip — the
          // backfill path will insert the current content directly.
          missing++;
          continue;
        }
        const current = currentByName.get(name)!;
        if (row.content === current) {
          alreadyCurrent++;
          continue;
        }
        const priorList = PRIOR_DEFAULT_CONTENTS[name];
        if (priorList.includes(row.content)) {
          row.content = current;
          await tplRepo.save(row);
          updated++;
        } else {
          // Content differs from both the current default AND every
          // known prior default — operator has customized this row, so
          // leave it alone. Logged for auditability.
          customized++;
        }
      }
    }

    console.log(
      `[v0.34.3 migration] prompt template refresh — ` +
      `updated=${updated} alreadyCurrent=${alreadyCurrent} ` +
      `customized=${customized} missing=${missing} ` +
      `across ${workspaces.length} workspace(s)`,
    );
  }

  public async down(): Promise<void> {
    // Data migrations don't have a true inverse — see prior migrations'
    // empty down() for precedent. Rolling back would require knowing
    // which rows we touched vs. left alone, and we don't persist that.
  }
}
