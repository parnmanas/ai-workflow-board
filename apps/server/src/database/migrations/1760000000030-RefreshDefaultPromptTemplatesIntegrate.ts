import { MigrationInterface, QueryRunner } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { DEFAULT_PROMPT_TEMPLATES } from '../default-prompt-templates';

/**
 * Refresh the In Progress / Merging default workflow prompt templates on
 * existing workspaces so already-installed boards pick up the new git
 * policy (ticket 3377b7e2 — "always start from the latest tip" +
 * "Merging actively integrates instead of bouncing on the first
 * conflict").
 *
 * Same operator-safety contract as 1760000000022:
 *   - Insert-only seed/backfill paths (`seedDefaults`,
 *     1760000000010-BackfillDefaultPromptTemplates) never touch an
 *     existing row, so a workspace seeded before this change keeps the
 *     stale `in_progress_workflow` / `merging_workflow` content forever.
 *   - We UPDATE a row only when its `content` is byte-exactly one of the
 *     known prior defaults below. Any operator edit breaks the match and
 *     the row is left untouched.
 *   - We never INSERT here — that's the seed/backfill path's job.
 *
 * Drift note (ticket 3377b7e2): the AWB self-host workspace's
 * `in_progress_workflow` row had already drifted from the code default
 * (it pre-dated the "Base repository" / "When to park" revisions), so the
 * byte-exact match below intentionally does NOT catch it — that row was
 * refreshed directly via `save_prompt_template` in the same ticket. This
 * migration is for the common case: workspaces whose rows still equal a
 * shipped default verbatim.
 *
 * PRIOR_*_CONTENTS hold the verbatim pre-change template content (captured
 * from `git show HEAD:...default-prompt-templates.ts` at the time of this
 * change) as JSON string literals — same byte-exact contract as the v0.34.3
 * migration, encoded as JSON strings rather than template literals so the
 * escapes can't drift.
 *
 * Idempotent: re-running after apply is a no-op (rows now hold the current
 * content, which is not in the prior list). Future revisions: push the
 * now-current content onto the prior list and bump
 * DEFAULT_PROMPT_TEMPLATES in the same change.
 */

const PRIOR_IN_PROGRESS_WORKFLOW = "# In Progress — Branch Work (assignee)\n\nThis ticket is in the In Progress column. Implement the work on a feature branch and hand it off to Review.\n\n> **Environment**: assignee has a full local repo. Use real git commands here. Do NOT merge to default — that happens in `merging_workflow` after Review approval.\n\n## Steps\n\n1. **Create or reuse the feature branch**\n   - `git fetch origin`\n   - Resolve the base branch:\n     - If the trigger prompt includes a **Base repository** block, use the `Base branch` listed there. Verify your `working_dir` is a clone of the listed URL — if it isn't, stop and ask in a comment instead of guessing.\n     - Otherwise, fall back to the repository's default branch (`origin/HEAD`).\n   - Pull the base branch to the latest tip: `git checkout <base-branch> && git pull --ff-only origin <base-branch>`.\n   - From that up-to-date base, `git checkout -b ticket/{ticket_id_short}-{slug}` where:\n     - `ticket_id_short` — first 8 chars of the ticket id.\n     - `slug` — lowercase alphanumeric-and-hyphen slug derived from the ticket title (fall back to id only if no usable tokens).\n   - If the branch already exists (ticket bounced back from Review), `git checkout` and reuse it. Amend or append commits; do **not** start over with a new name.\n\n2. **Do the work** — implement the requirement. Split commits by logical unit (one commit per one change).\n\n3. **Push** — `git push -u origin <branch-name>`.\n   - **Submodule projects**: if the change is inside a submodule, push the submodule's feature branch here, but **do NOT bump the parent repo's submodule ref yet**. The parent bump happens in Merging, after the submodule default branch has absorbed the change.\n   - Before the final push, rebase onto the latest default so Merging can do a fast-forward: `git fetch origin && git rebase origin/<default>`. If this is a re-push after a rebase, use `git push --force-with-lease` on the feature branch (never the default branch).\n\n4. **Ticket comment** — `add_comment` with:\n   - Branch name (exactly as pushed).\n   - 3–5 line summary of the main changes.\n   - Build / test results if you ran them.\n   - If a PR already exists, its URL.\n\n5. **Move to Review** — `move_ticket` to the **Review** column.\n\n## When to park instead of bouncing back\n\nSometimes the work cannot finish in this ticket and bouncing it back to To Do (or Plan) just re-fires the same agent → same column → same blocker loop. Pick the parking tool by **what** you're waiting on:\n\n1. **Genuine human decision needed** (credentials, architectural choice with cost trade-offs, missing requirement only the reporter can fill in):\n   - Leave a comment explaining what you need (mention the reporter or whoever can answer).\n   - Call `mcp__awb__pend_ticket` with a one-line `reason` so the User tab on the ticket panel surfaces the ask without anyone having to read the whole comment thread.\n   - Stop. Do **not** `move_ticket` back. Pending tickets release the agent's focus, so other tickets get worked on while this one waits.\n   - A human clears it later with `unpend_ticket` and the dispatch loop wakes you back up.\n\n2. **Waiting on another ticket** — the blocker is *not* a human decision but the output of one or more other tickets that just need to finish (the perf-test job lands, the upstream refactor merges, a dependency entity gets built):\n   - File the prerequisite work if it doesn't exist yet (`mcp__awb__create_ticket`, referencing this ticket's id).\n   - Call `mcp__awb__add_ticket_prerequisites(ticket_id, [<prereq id(s)>], reason)`. This sets `pending_on_tickets=true` and **auto-resumes** the moment every prerequisite reaches a terminal column — no human `unpend` needed. Use this instead of `pend_ticket` whenever the blocker is another ticket.\n   - Stop. Do **not** `move_ticket` back. The block releases the focus exactly like a human pend, but the wake-up is automatic.\n\nThe rule of thumb: **human answer → `pend_ticket`; another ticket finishing → `add_ticket_prerequisites`.** If a ticket genuinely needs both, do both — either flag keeps the ticket parked until cleared.\n\n## Notes\n\n- **Never push directly to master / main / the default branch.** Reviewer and Merging stages gate that.\n- If the plan is unclear or the requirement is ambiguous, leave a comment and stop — do not guess.\n- Out-of-scope bugs or refactor itches are not yours here. Propose a new ticket in a comment (or file it with `create_ticket` if it's a hard blocker — see \"When to park instead of bouncing back\" above).\n- Keep the feature branch rebased onto the latest default before the final push. Merging expects a clean ff.\n- `--force-with-lease` is OK on the feature branch only. Force-pushing to a shared branch (default, release, …) is forbidden.\n- For PR-gated repos, open the PR with `gh pr create --draft` during this stage and include its URL in the comment so Review can inspect the diff remotely.\n";

const PRIOR_MERGING_WORKFLOW = "# Merging — Fast-Forward to Default (assignee)\n\nThis ticket is in the Merging column, which means Review approved the diff. Your job: land the feature branch on the default branch, delete the feature branch (local + remote), and advance the ticket to Done.\n\n> **Environment**: assignee has a full local repo. This stage exists because reviewer / reporter may not — so all real merge work happens here.\n>\n> **Definition of merged**: a local merge is not enough. **(a)** `origin/<default>` must point at the merge commit, and **(b)** the feature branch must be deleted from **both** local and remote. Verify with commands at each step.\n\n## Steps\n\n1. **Identify the default branch** — `git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'` (typically `master` or `main`).\n\n2. **Refresh**\n   - `git fetch origin --prune`\n   - `git checkout <feature-branch>`\n   - If behind the default: `git rebase origin/<default>`, then `git push --force-with-lease` (feature branch only — never the default).\n   - **On conflict**: do NOT resolve it yourself. `add_comment` \"rebase conflict — assignee input needed\" and `move_ticket` back to **In Progress**.\n\n3. **Merge (ff-only)**\n   - `git checkout <default-branch>`\n   - `git pull --ff-only origin <default-branch>`\n   - `git merge --ff-only <feature-branch>`\n   - If the ff fails, retry step 2 once. If it still fails, bounce to **In Progress**.\n\n4. **Push to origin (required)**\n   - `git push origin <default-branch>`\n   - **Verify**: `git rev-parse HEAD` == `git rev-parse origin/<default-branch>`. If they differ, the push did not land — read the error and retry.\n   - If the push is rejected (branch protection, CI gate, …) → **never force-push the default branch**. Skip step 5, go to step 7, record `\"manual merge required — <default> push rejected: <reason>\"`, and stop.\n\n5. **Delete the feature branch (both sides)**\n   - Remote: `git push origin --delete <feature-branch>`\n   - Local: `git branch -d <feature-branch>` (default must already be checked out; `-D` is unnecessary if the ff merge succeeded).\n   - **Verify**:\n     - `git ls-remote --heads origin <feature-branch>` → must be empty.\n     - `git branch --list <feature-branch>` → must be empty.\n\n6. **Submodule handling** (only if the feature branch lived inside a submodule)\n   - Move into the parent repo; `git status` should show the submodule ref changed.\n   - `git add <submodule-path>` → `git commit -m \"chore: bump <submodule> ref (<ticket-id>)\"` → `git push origin <parent-default-branch>`.\n   - **Verify**: parent's `git rev-parse HEAD` == `git rev-parse origin/<parent-default-branch>`.\n   - Multiple submodules? Finish steps 3–5 in each, then make a single bump commit in the parent.\n\n7. **Ticket comment** — `add_comment` with all of:\n   - Merge commit SHA (`git rev-parse origin/<default-branch>`).\n   - Default branch name + `origin push: OK`.\n   - Feature branch name + `local/remote delete: OK`.\n   - Parent bump commit SHA (if step 6 applied).\n   - If any step failed, record the failure mode precisely so Done's sanity check can surface it.\n\n8. **Move to Done** — `move_ticket` to the **Done** column. (Leave in Merging only if you recorded a `manual merge required` block above.)\n\n## Notes\n\n- **A local merge is not completion.** Step 4's verification (`HEAD == origin/<default>`) is the threshold.\n- **Feature branches must be deleted on BOTH sides.** Deleting only one leaves dangling refs.\n- **Never force-push master / main / the default branch.** Ever. `--force-with-lease` is only acceptable on the feature branch during rebase.\n- **PR-gated repos** — replace steps 3–5 with `gh pr merge <pr> --squash --delete-branch`. After merging, verify with `gh pr view <pr> --json state,mergeCommit` (`state` must be `MERGED`). If `--delete-branch` silently failed, fall back to manual `git push origin --delete` + `git branch -d`.\n- **No `gh` available and direct push rejected** → stop, record `\"manual merge required\"`, leave the ticket in Merging for a human.\n- **Submodule changes must run through step 6.** Skipping the parent bump leaves every other environment pointing at the old ref.\n- After merge, a quick sanity build on the default branch is cheap insurance. If it's broken, open a follow-up ticket or revert immediately.\n";

// Map: template name → known prior contents to refresh to the current
// default. List shape lets a future revision append the now-current
// content as the next "prior" without dropping this upgrade path.
export const PRIOR_INTEGRATE_CONTENTS: Record<string, string[]> = {
  in_progress_workflow: [PRIOR_IN_PROGRESS_WORKFLOW],
  merging_workflow: [PRIOR_MERGING_WORKFLOW],
};

export class RefreshDefaultPromptTemplatesIntegrate1760000000030
  implements MigrationInterface
{
  name = 'RefreshDefaultPromptTemplatesIntegrate1760000000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const wsRepo = manager.getRepository(Workspace);
    const tplRepo = manager.getRepository(PromptTemplate);

    const currentByName = new Map<string, string>();
    for (const def of DEFAULT_PROMPT_TEMPLATES) {
      if (def.name in PRIOR_INTEGRATE_CONTENTS) {
        currentByName.set(def.name, def.content);
      }
    }

    const workspaces = await wsRepo.find();
    let updated = 0;
    let customized = 0;
    let missing = 0;
    let alreadyCurrent = 0;

    for (const ws of workspaces) {
      for (const name of Object.keys(PRIOR_INTEGRATE_CONTENTS)) {
        const row = await tplRepo.findOne({
          where: { workspace_id: ws.id, name },
        });
        if (!row) {
          missing++;
          continue;
        }
        const current = currentByName.get(name)!;
        if (row.content === current) {
          alreadyCurrent++;
          continue;
        }
        const priorList = PRIOR_INTEGRATE_CONTENTS[name];
        if (priorList.includes(row.content)) {
          row.content = current;
          await tplRepo.save(row);
          updated++;
        } else {
          // Drifted / operator-customized → leave alone.
          customized++;
        }
      }
    }

    console.log(
      `[3377b7e2 migration] prompt template refresh (integrate policy) — ` +
        `updated=${updated} alreadyCurrent=${alreadyCurrent} ` +
        `customized=${customized} missing=${missing} ` +
        `across ${workspaces.length} workspace(s)`,
    );
  }

  public async down(): Promise<void> {
    // Data migration — no true inverse (see prior migrations' empty down()).
  }
}
