import { MigrationInterface, QueryRunner } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { DEFAULT_PROMPT_TEMPLATES } from '../default-prompt-templates';

/**
 * Refresh the In Progress / Merging / Done default workflow prompt templates
 * on existing workspaces so already-installed boards pick up the new
 * cleanup + completeness post-verification rules (ticket 990c35fa —
 * "done/merging workflow prompts let partial merges & leftover branches/
 * worktrees pass to Done").
 *
 * What changed in DEFAULT_PROMPT_TEMPLATES (prompt text only):
 *   - merging_workflow: completeness verify (no partial merge) on push,
 *     delete the feature branch by its *actually pushed* ref name (catches
 *     the local/remote `awb-<id>` rename that made cleanup a silent no-op),
 *     a PR-gated squash completeness gate (the `9b8f338f` 1-of-6-commits
 *     failure), a "Cleanup failure recovery" section, and a step-8 gate that
 *     only advances to Done when completeness + both-side deletion verify.
 *   - done_workflow: re-verify the merge as *git state* (merge SHA reachable
 *     on origin/<default>, remote branch gone, no leftover worktree) instead
 *     of trusting the Merging comment prose; bounce back (force) on failure.
 *   - in_progress_workflow: record the exact pushed ref so Merging deletes
 *     the right remote name.
 *
 * Same operator-safety contract as 1760000000022 / 1760000000030 /
 * 1760000000031:
 *   - Insert-only seed/backfill paths never touch an existing row, so a
 *     workspace seeded before this change keeps the stale content forever
 *     unless refreshed here.
 *   - We UPDATE a row only when its `content` is byte-exactly the known
 *     prior default below. Any operator edit / earlier drift breaks the
 *     match and the row is left untouched.
 *   - We never INSERT here — that's the seed/backfill path's job.
 *
 * The PRIOR_* constants hold the verbatim pre-change template content
 * (captured from the source file at HEAD~1 of this change) as JSON string
 * literals — same byte-exact contract as the prior refresh migrations,
 * encoded as JSON strings rather than template literals so the escapes
 * can't drift.
 *
 * Idempotent: re-running after apply is a no-op (rows now hold the current
 * content, which is not the prior string). Future revisions: push the
 * now-current content onto the prior list and bump DEFAULT_PROMPT_TEMPLATES
 * in the same change.
 */

const PRIOR_IN_PROGRESS_WORKFLOW = "# In Progress — Branch Work (assignee)\n\nThis ticket is in the In Progress column. Implement the work on a feature branch and hand it off to Review.\n\n> **Environment**: assignee has a full local repo. Use real git commands here. Do NOT merge to default — that happens in `merging_workflow` after Review approval.\n\n## Steps\n\n1. **Create or reuse the feature branch — always start from the latest tip**\n   - `git fetch origin` — **always**, every trigger. Never start work against a stale local ref.\n   - Resolve the base branch:\n     - If the trigger prompt includes a **Base repository** block, use the `Base branch` listed there. Verify your `working_dir` is a clone of the listed URL — if it isn't, stop and ask in a comment instead of guessing.\n     - Otherwise, fall back to the repository's default branch (`origin/HEAD`).\n   - Pull the base branch to the latest tip: `git checkout <base-branch> && git pull --ff-only origin <base-branch>`. Do this **every time** — for a brand-new branch *and* before reusing an existing one. Work always begins on the current tip of the base, never on a stale snapshot.\n   - **New branch** — from that up-to-date base, `git checkout -b ticket/{ticket_id_short}-{slug}` where:\n     - `ticket_id_short` — first 8 chars of the ticket id.\n     - `slug` — lowercase alphanumeric-and-hyphen slug derived from the ticket title (fall back to id only if no usable tokens).\n   - **Reused branch** (ticket bounced back from Review) — `git checkout` the existing branch and **immediately** `git rebase origin/<base-branch>` to lift your commits onto the latest tip *before* writing any new code. Amend or append commits afterwards; do **not** start over with a new name. If the rebase hits a conflict, integrate it the same way Merging does (fold same-meaning / duplicate changes; see `merging_workflow`) rather than abandoning the branch.\n\n2. **Overlap pre-flight — run BEFORE writing any implementation code.** A sibling ticket may already have shipped a fix for this same symptom on the default branch, possibly with a *different, incompatible* design. Building first and discovering the collision afterwards wastes the whole build pass. Check both directions:\n   - **Already on the default?** You already fetched + pulled the base to its tip in step 1. Now confirm the bug/symptom this ticket targets isn't already resolved there: `git log --oneline -20 origin/<base-branch>`, and grep the files/symptom you were about to touch (`git log -p --since=2.weeks -- <path>`, or search for the error string / function names). If the symptom is already fixed on the default, the build is moot.\n   - **In-flight elsewhere?** Scan for other **open or recently-Done** tickets attacking the same files/symptom: `mcp__awb__get_board_summary` / `mcp__awb__get_my_tickets`, and skim sibling tickets' titles/labels for the same bug. A sibling mid-build with a conflicting design is the same trap as one already merged.\n   - **If a conflicting sibling already merged or is in-flight → stop and escalate. Do NOT build.** Leave an `add_comment` stating which commit(s)/ticket already cover this symptom and why your planned design collides, mention the reporter (`@[role:reporter|<name>]`), and **park** rather than bounce — use `mcp__awb__pend_ticket` (human must decide: close as superseded, or re-scope this ticket to the residual). This is the cheap gate that the `7929ef0b`/`ff3e7337` collision skipped: that assignee ran exactly this check *on resume* and parked correctly — the only gap was not running it *before* the first build pass.\n   - **No overlap → proceed to step 3.**\n\n3. **Do the work** — implement the requirement. Split commits by logical unit (one commit per one change).\n\n4. **Push** — `git push -u origin <branch-name>`.\n   - **Submodule projects**: if the change is inside a submodule, push the submodule's feature branch here, but **do NOT bump the parent repo's submodule ref yet**. The parent bump happens in Merging, after the submodule default branch has absorbed the change.\n   - Before the final push, rebase onto the latest default so Merging can do a fast-forward: `git fetch origin && git rebase origin/<default>`. If this is a re-push after a rebase, use `git push --force-with-lease` on the feature branch (never the default branch).\n\n5. **Ticket comment** — `add_comment` with:\n   - Branch name (exactly as pushed).\n   - 3–5 line summary of the main changes.\n   - Build / test results if you ran them.\n   - If a PR already exists, its URL.\n\n6. **Move to Review** — `move_ticket` to the **Review** column.\n\n## When to park instead of bouncing back\n\nSometimes the work cannot finish in this ticket and bouncing it back to To Do (or Plan) just re-fires the same agent → same column → same blocker loop. Pick the parking tool by **what** you're waiting on:\n\n1. **Genuine human decision needed** (credentials, architectural choice with cost trade-offs, missing requirement only the reporter can fill in):\n   - Leave a comment explaining what you need (mention the reporter or whoever can answer).\n   - Call `mcp__awb__pend_ticket` with a one-line `reason` so the User tab on the ticket panel surfaces the ask without anyone having to read the whole comment thread.\n   - Stop. Do **not** `move_ticket` back. Pending tickets release the agent's focus, so other tickets get worked on while this one waits.\n   - A human clears it later with `unpend_ticket` and the dispatch loop wakes you back up.\n\n2. **Waiting on another ticket** — the blocker is *not* a human decision but the output of one or more other tickets that just need to finish (the perf-test job lands, the upstream refactor merges, a dependency entity gets built):\n   - File the prerequisite work if it doesn't exist yet (`mcp__awb__create_ticket`, referencing this ticket's id).\n   - Call `mcp__awb__add_ticket_prerequisites(ticket_id, [<prereq id(s)>], reason)`. This sets `pending_on_tickets=true` and **auto-resumes** the moment every prerequisite reaches a terminal column — no human `unpend` needed. Use this instead of `pend_ticket` whenever the blocker is another ticket.\n   - Stop. Do **not** `move_ticket` back. The block releases the focus exactly like a human pend, but the wake-up is automatic.\n\nThe rule of thumb: **human answer → `pend_ticket`; another ticket finishing → `add_ticket_prerequisites`.** If a ticket genuinely needs both, do both — either flag keeps the ticket parked until cleared.\n\n## Notes\n\n- **Never push directly to master / main / the default branch.** Reviewer and Merging stages gate that.\n- **Never start work from a stale state.** Always `git fetch` + pull the base to its latest tip — and `git rebase origin/<base>` a reused branch — *before* the first new commit (step 1). Building on an outdated base is what manufactures avoidable merge conflicts downstream.\n- If the plan is unclear or the requirement is ambiguous, leave a comment and stop — do not guess.\n- Out-of-scope bugs or refactor itches are not yours here. Propose a new ticket in a comment (or file it with `create_ticket` if it's a hard blocker — see \"When to park instead of bouncing back\" above).\n- Keep the feature branch rebased onto the latest default before the final push. Merging will rebase and actively integrate the branch onto the default if it has fallen behind, but a clean rebase here keeps that step trivial.\n- `--force-with-lease` is OK on the feature branch only. Force-pushing to a shared branch (default, release, …) is forbidden.\n- For PR-gated repos, open the PR with `gh pr create --draft` during this stage and include its URL in the comment so Review can inspect the diff remotely.\n";

const PRIOR_MERGING_WORKFLOW = "# Merging — Integrate into Default (assignee)\n\nThis ticket is in the Merging column, which means Review approved the diff. Your job: land the feature branch on the default branch, delete the feature branch (local + remote), and advance the ticket to Done.\n\n> **Environment**: assignee has a full local repo. This stage exists because reviewer / reporter may not — so all real merge work happens here.\n>\n> **Integrate, don't bounce on first friction.** Since you branched, similar or overlapping work may already have landed on the default. A clean fast-forward is the happy path — but when it doesn't apply, you are **expected to rebase and actively integrate**: resolve conflicts whose two sides mean the same thing, fold duplicate/overlapping changes together, and carry on. Bouncing the ticket at the first conflict is the wrong default. Escalate (bounce / pend) **only** on a genuinely big problem — see \"When to integrate vs. escalate\" below.\n>\n> **Definition of merged**: a local merge is not enough. **(a)** `origin/<default>` must point at the integrated commit(s), and **(b)** the feature branch must be deleted from **both** local and remote. Verify with commands at each step.\n\n## Steps\n\n1. **Identify the default branch** — `git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'` (typically `master` or `main`).\n\n2. **Rebase onto the latest default and integrate**\n   - `git fetch origin --prune`\n   - `git checkout <feature-branch>`\n   - If behind the default: `git rebase origin/<default>`.\n   - **On conflict — integrate, don't reflexively bounce.** Inspect each conflicting hunk:\n     - **Similar / duplicate work already on the default** (someone landed the same or an overlapping change first) and the two sides mean the same thing → integrate them: take the default's version (or the merged superset), drop your now-redundant duplicate, and confirm the result still expresses this ticket's intent.\n     - **Mechanical textual conflict** (imports, adjacent edits, moved lines, formatting) with a clear correct resolution → resolve it.\n     - `git add` the resolved files and `git rebase --continue` until the rebase is clean.\n     - **Escalate only on a genuinely big problem** — see \"When to integrate vs. escalate\" below. In that case `git rebase --abort`, `add_comment` naming which boundary you hit, and `move_ticket` back to **In Progress** (or `pend_ticket` if it needs a human decision).\n   - After a successful rebase: `git push --force-with-lease` (feature branch only — never the default).\n\n3. **Merge into default**\n   - `git checkout <default-branch>`\n   - `git pull --ff-only origin <default-branch>`\n   - `git merge --ff-only <feature-branch>` — after step 2's rebase this fast-forwards cleanly.\n   - **If the ff fails** because the default moved again while you were rebasing: re-run step 2 (`git checkout <feature-branch> && git rebase origin/<default>`, integrating any fresh conflicts), then retry the ff. This loop is normal under concurrent merges — repeat until it fast-forwards, escalating only if you hit a genuinely big problem per the boundary below.\n\n4. **Push to origin (required)**\n   - `git push origin <default-branch>`\n   - **Verify**: `git rev-parse HEAD` == `git rev-parse origin/<default-branch>`. If they differ, the push did not land — read the error and retry.\n   - If the push is rejected (branch protection, CI gate, …) → **never force-push the default branch**. Skip step 5, go to step 7, record `\"manual merge required — <default> push rejected: <reason>\"`, and stop.\n\n5. **Delete the feature branch (both sides)**\n   - Remote: `git push origin --delete <feature-branch>`\n   - Local: `git branch -d <feature-branch>` (default must already be checked out; `-D` is unnecessary if the ff merge succeeded).\n   - **Verify**:\n     - `git ls-remote --heads origin <feature-branch>` → must be empty.\n     - `git branch --list <feature-branch>` → must be empty.\n\n6. **Submodule handling** (only if the feature branch lived inside a submodule)\n   - Move into the parent repo; `git status` should show the submodule ref changed.\n   - `git add <submodule-path>` → `git commit -m \"chore: bump <submodule> ref (<ticket-id>)\"` → `git push origin <parent-default-branch>`.\n   - **Verify**: parent's `git rev-parse HEAD` == `git rev-parse origin/<parent-default-branch>`.\n   - Multiple submodules? Finish steps 3–5 in each, then make a single bump commit in the parent.\n\n7. **Ticket comment** — `add_comment` with all of:\n   - Merge commit SHA (`git rev-parse origin/<default-branch>`).\n   - Default branch name + `origin push: OK`.\n   - Feature branch name + `local/remote delete: OK`.\n   - Parent bump commit SHA (if step 6 applied).\n   - **If you integrated any rebase/merge conflicts in step 2/3**: which hunk(s) conflicted, why each was safe to fold (same meaning / duplicate work already on the default / mechanical), and confirmation that build + relevant tests still pass after the integration. This is the audit trail for the relaxed-ff policy.\n   - If any step failed, record the failure mode precisely so Done's sanity check can surface it.\n\n8. **Move to Done** — `move_ticket` to the **Done** column. (Leave in Merging only if you recorded a `manual merge required` block above.)\n\n## When to integrate vs. escalate\n\n**Default to integrating.** Overlapping or duplicate work landing on the default before you is expected, not exceptional — resolve it in step 2/3 and move on. Bounce back to In Progress (or `pend_ticket` for a human) **only** when the conflict is a genuinely big problem, namely any of:\n\n- **Semantic conflict** — the same lines were changed with a *different intent*, so choosing or merging the sides actually changes behaviour. That's a real decision, not a mechanical resolution.\n- **Data / schema loss risk** — integrating would drop or override a migration, column, or persisted field, or otherwise risks corrupting/clobbering data.\n- **Build or tests break after integration** — you rebased/merged but `build` or the relevant tests now fail and the fix isn't an obvious mechanical one.\n- **Human judgment required** — the correct resolution depends on product/architecture intent only the reporter or a human can settle.\n\nIf none of these apply, integrate and proceed — record what you folded in the step-7 comment. If one does apply, escalate with a precise comment naming which boundary you hit, then bounce or pend; do not guess a resolution through a semantic or data-loss conflict.\n\n## Notes\n\n- **A local merge is not completion.** Step 4's verification (`HEAD == origin/<default>`) is the threshold.\n- **Feature branches must be deleted on BOTH sides.** Deleting only one leaves dangling refs.\n- **Never force-push master / main / the default branch.** Ever. `--force-with-lease` is only acceptable on the feature branch during rebase.\n- **PR-gated repos** — replace steps 3–5 with `gh pr merge <pr> --squash --delete-branch`. After merging, verify with `gh pr view <pr> --json state,mergeCommit` (`state` must be `MERGED`). If `--delete-branch` silently failed, fall back to manual `git push origin --delete` + `git branch -d`. If the PR reports conflicts, integrate them locally first via step 2 (rebase + fold same-meaning changes, push `--force-with-lease` on the feature branch), then re-run the merge — same integrate-vs-escalate boundary applies.\n- **No `gh` available and direct push rejected** → stop, record `\"manual merge required\"`, leave the ticket in Merging for a human.\n- **Submodule changes must run through step 6.** Skipping the parent bump leaves every other environment pointing at the old ref.\n- After merge, a quick sanity build on the default branch is cheap insurance. If it's broken, open a follow-up ticket or revert immediately.\n";

const PRIOR_DONE_WORKFLOW = "# Done — Completion (reporter)\n\nThis ticket is in the Done column. Merging already landed the code and deleted the feature branch. Your job is administrative: record the completion on the reporter side. **Backlog scheduling is no longer your responsibility** — `BacklogPromotionService` runs server-side on the same capacity event the supervisor watches, so a freed agent triggers the next promotion automatically.\n\n> **Environment**: reporter may have no local repo. MCP-only. No git, gh, or shell commands.\n\n## Steps\n\n1. **Sanity-check the merge trail**\n   - `mcp__awb__get_ticket` on this ticket — confirm the Merging-stage comment exists and includes a merge commit SHA plus branch-deletion confirmation.\n   - If the confirmation is **missing** or says `\"manual merge required\"`, `add_comment` `\"done reached without merge confirmation — please verify\"` and stop.\n\n2. **Completion comment** — `add_comment` with:\n   - One line acknowledging the ticket is fully complete from the reporter's side.\n   - Reference the merge commit SHA from the Merging comment (copy it, do not re-compute).\n\nThat's it. The terminal landing eventually fires `agent_idle` for the merging agent (when its subagent exits), which drains that agent's dispatch queue and gives `BacklogPromotionService` a chance to pull the next intake ticket forward. No manual scheduling pass is needed or wanted.\n\n## Notes\n\n- **No local git, no `gh`, no branch operations here.** Merge / push / delete already happened in Merging.\n- **No self-mention.** Reporter comments must not use `@[role:reporter|...]`.\n- **Do not run a backlog scan.** Scanning is forbidden — the server owns it. Manual scans were the v0.40 starvation source.\n- If you suspect the server-side promotion is stuck (e.g. backlog has critical work but the freed agent didn't pick anything up), comment with the suspicion and stop. Humans investigate; you don't override.\n";

// Map: template name -> known prior contents to refresh to the current
// default. List shape lets a future revision append the now-current
// content as the next "prior" without dropping this upgrade path.
export const PRIOR_CLEANUP_VERIFY_CONTENTS: Record<string, string[]> = {
  in_progress_workflow: [PRIOR_IN_PROGRESS_WORKFLOW],
  merging_workflow: [PRIOR_MERGING_WORKFLOW],
  done_workflow: [PRIOR_DONE_WORKFLOW],
};

export class RefreshDefaultPromptTemplatesCleanupVerify1760000000036
  implements MigrationInterface
{
  name = 'RefreshDefaultPromptTemplatesCleanupVerify1760000000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const wsRepo = manager.getRepository(Workspace);
    const tplRepo = manager.getRepository(PromptTemplate);

    const currentByName = new Map<string, string>();
    for (const def of DEFAULT_PROMPT_TEMPLATES) {
      if (def.name in PRIOR_CLEANUP_VERIFY_CONTENTS) {
        currentByName.set(def.name, def.content);
      }
    }

    const workspaces = await wsRepo.find();
    let updated = 0;
    let customized = 0;
    let missing = 0;
    let alreadyCurrent = 0;

    for (const ws of workspaces) {
      for (const name of Object.keys(PRIOR_CLEANUP_VERIFY_CONTENTS)) {
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
        const priorList = PRIOR_CLEANUP_VERIFY_CONTENTS[name];
        if (priorList.includes(row.content)) {
          row.content = current;
          await tplRepo.save(row);
          updated++;
        } else {
          // Drifted / operator-customized -> leave alone.
          customized++;
        }
      }
    }

    console.log(
      `[990c35fa migration] prompt template refresh (cleanup + completeness post-verify) — ` +
        `updated=${updated} alreadyCurrent=${alreadyCurrent} ` +
        `customized=${customized} missing=${missing} ` +
        `across ${workspaces.length} workspace(s)`,
    );
  }

  public async down(): Promise<void> {
    // Data migration — no true inverse (see prior migrations' empty down()).
  }
}
