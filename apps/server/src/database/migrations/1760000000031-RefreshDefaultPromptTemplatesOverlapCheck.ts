import { MigrationInterface, QueryRunner } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { DEFAULT_PROMPT_TEMPLATES } from '../default-prompt-templates';

/**
 * Refresh the In Progress default workflow prompt template on existing
 * workspaces so already-installed boards pick up the new assignee
 * **overlap pre-flight** step (ticket ed742792 — "Flag overlapping
 * in-flight tickets before an assignee builds a duplicate solution").
 *
 * Source of the rule: the `7929ef0b` / `ff3e7337` retrospective. Two open
 * tickets attacked the same pair of bugs with incompatible designs in
 * parallel; one shipped 8 commits to main while the other's assignee built
 * substantial WIP before checking `origin/main`. The new step 2 makes the
 * assignee run the overlap/main check *before* the first build pass and
 * stop-and-escalate (pend) when a conflicting sibling already merged or is
 * in-flight.
 *
 * Same operator-safety contract as 1760000000022 / 1760000000030:
 *   - Insert-only seed/backfill paths never touch an existing row, so a
 *     workspace seeded before this change keeps the stale
 *     `in_progress_workflow` content forever unless refreshed here.
 *   - We UPDATE a row only when its `content` is byte-exactly the known
 *     prior default below. Any operator edit / earlier drift breaks the
 *     match and the row is left untouched.
 *   - We never INSERT here — that's the seed/backfill path's job.
 *
 * PRIOR_IN_PROGRESS_WORKFLOW holds the verbatim pre-change template content
 * (captured from the source file at the time of this change) as a JSON
 * string literal — same byte-exact contract as the prior refresh
 * migrations, encoded as a JSON string rather than a template literal so
 * the escapes can't drift.
 *
 * Idempotent: re-running after apply is a no-op (rows now hold the current
 * content, which is not the prior string). Future revisions: push the
 * now-current content onto the prior list and bump
 * DEFAULT_PROMPT_TEMPLATES in the same change.
 */

const PRIOR_IN_PROGRESS_WORKFLOW = "# In Progress — Branch Work (assignee)\n\nThis ticket is in the In Progress column. Implement the work on a feature branch and hand it off to Review.\n\n> **Environment**: assignee has a full local repo. Use real git commands here. Do NOT merge to default — that happens in `merging_workflow` after Review approval.\n\n## Steps\n\n1. **Create or reuse the feature branch — always start from the latest tip**\n   - `git fetch origin` — **always**, every trigger. Never start work against a stale local ref.\n   - Resolve the base branch:\n     - If the trigger prompt includes a **Base repository** block, use the `Base branch` listed there. Verify your `working_dir` is a clone of the listed URL — if it isn't, stop and ask in a comment instead of guessing.\n     - Otherwise, fall back to the repository's default branch (`origin/HEAD`).\n   - Pull the base branch to the latest tip: `git checkout <base-branch> && git pull --ff-only origin <base-branch>`. Do this **every time** — for a brand-new branch *and* before reusing an existing one. Work always begins on the current tip of the base, never on a stale snapshot.\n   - **New branch** — from that up-to-date base, `git checkout -b ticket/{ticket_id_short}-{slug}` where:\n     - `ticket_id_short` — first 8 chars of the ticket id.\n     - `slug` — lowercase alphanumeric-and-hyphen slug derived from the ticket title (fall back to id only if no usable tokens).\n   - **Reused branch** (ticket bounced back from Review) — `git checkout` the existing branch and **immediately** `git rebase origin/<base-branch>` to lift your commits onto the latest tip *before* writing any new code. Amend or append commits afterwards; do **not** start over with a new name. If the rebase hits a conflict, integrate it the same way Merging does (fold same-meaning / duplicate changes; see `merging_workflow`) rather than abandoning the branch.\n\n2. **Do the work** — implement the requirement. Split commits by logical unit (one commit per one change).\n\n3. **Push** — `git push -u origin <branch-name>`.\n   - **Submodule projects**: if the change is inside a submodule, push the submodule's feature branch here, but **do NOT bump the parent repo's submodule ref yet**. The parent bump happens in Merging, after the submodule default branch has absorbed the change.\n   - Before the final push, rebase onto the latest default so Merging can do a fast-forward: `git fetch origin && git rebase origin/<default>`. If this is a re-push after a rebase, use `git push --force-with-lease` on the feature branch (never the default branch).\n\n4. **Ticket comment** — `add_comment` with:\n   - Branch name (exactly as pushed).\n   - 3–5 line summary of the main changes.\n   - Build / test results if you ran them.\n   - If a PR already exists, its URL.\n\n5. **Move to Review** — `move_ticket` to the **Review** column.\n\n## When to park instead of bouncing back\n\nSometimes the work cannot finish in this ticket and bouncing it back to To Do (or Plan) just re-fires the same agent → same column → same blocker loop. Pick the parking tool by **what** you're waiting on:\n\n1. **Genuine human decision needed** (credentials, architectural choice with cost trade-offs, missing requirement only the reporter can fill in):\n   - Leave a comment explaining what you need (mention the reporter or whoever can answer).\n   - Call `mcp__awb__pend_ticket` with a one-line `reason` so the User tab on the ticket panel surfaces the ask without anyone having to read the whole comment thread.\n   - Stop. Do **not** `move_ticket` back. Pending tickets release the agent's focus, so other tickets get worked on while this one waits.\n   - A human clears it later with `unpend_ticket` and the dispatch loop wakes you back up.\n\n2. **Waiting on another ticket** — the blocker is *not* a human decision but the output of one or more other tickets that just need to finish (the perf-test job lands, the upstream refactor merges, a dependency entity gets built):\n   - File the prerequisite work if it doesn't exist yet (`mcp__awb__create_ticket`, referencing this ticket's id).\n   - Call `mcp__awb__add_ticket_prerequisites(ticket_id, [<prereq id(s)>], reason)`. This sets `pending_on_tickets=true` and **auto-resumes** the moment every prerequisite reaches a terminal column — no human `unpend` needed. Use this instead of `pend_ticket` whenever the blocker is another ticket.\n   - Stop. Do **not** `move_ticket` back. The block releases the focus exactly like a human pend, but the wake-up is automatic.\n\nThe rule of thumb: **human answer → `pend_ticket`; another ticket finishing → `add_ticket_prerequisites`.** If a ticket genuinely needs both, do both — either flag keeps the ticket parked until cleared.\n\n## Notes\n\n- **Never push directly to master / main / the default branch.** Reviewer and Merging stages gate that.\n- **Never start work from a stale state.** Always `git fetch` + pull the base to its latest tip — and `git rebase origin/<base>` a reused branch — *before* the first new commit (step 1). Building on an outdated base is what manufactures avoidable merge conflicts downstream.\n- If the plan is unclear or the requirement is ambiguous, leave a comment and stop — do not guess.\n- Out-of-scope bugs or refactor itches are not yours here. Propose a new ticket in a comment (or file it with `create_ticket` if it's a hard blocker — see \"When to park instead of bouncing back\" above).\n- Keep the feature branch rebased onto the latest default before the final push. Merging will rebase and actively integrate the branch onto the default if it has fallen behind, but a clean rebase here keeps that step trivial.\n- `--force-with-lease` is OK on the feature branch only. Force-pushing to a shared branch (default, release, …) is forbidden.\n- For PR-gated repos, open the PR with `gh pr create --draft` during this stage and include its URL in the comment so Review can inspect the diff remotely.\n";

// Map: template name → known prior contents to refresh to the current
// default. List shape lets a future revision append the now-current
// content as the next "prior" without dropping this upgrade path.
export const PRIOR_OVERLAP_CHECK_CONTENTS: Record<string, string[]> = {
  in_progress_workflow: [PRIOR_IN_PROGRESS_WORKFLOW],
};

export class RefreshDefaultPromptTemplatesOverlapCheck1760000000031
  implements MigrationInterface
{
  name = 'RefreshDefaultPromptTemplatesOverlapCheck1760000000031';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const wsRepo = manager.getRepository(Workspace);
    const tplRepo = manager.getRepository(PromptTemplate);

    const currentByName = new Map<string, string>();
    for (const def of DEFAULT_PROMPT_TEMPLATES) {
      if (def.name in PRIOR_OVERLAP_CHECK_CONTENTS) {
        currentByName.set(def.name, def.content);
      }
    }

    const workspaces = await wsRepo.find();
    let updated = 0;
    let customized = 0;
    let missing = 0;
    let alreadyCurrent = 0;

    for (const ws of workspaces) {
      for (const name of Object.keys(PRIOR_OVERLAP_CHECK_CONTENTS)) {
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
        const priorList = PRIOR_OVERLAP_CHECK_CONTENTS[name];
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
      `[ed742792 migration] prompt template refresh (overlap pre-flight) — ` +
        `updated=${updated} alreadyCurrent=${alreadyCurrent} ` +
        `customized=${customized} missing=${missing} ` +
        `across ${workspaces.length} workspace(s)`,
    );
  }

  public async down(): Promise<void> {
    // Data migration — no true inverse (see prior migrations' empty down()).
  }
}
