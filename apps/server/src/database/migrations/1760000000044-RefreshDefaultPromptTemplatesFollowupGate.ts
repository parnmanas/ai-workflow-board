import { MigrationInterface, QueryRunner } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { DEFAULT_PROMPT_TEMPLATES } from '../default-prompt-templates';

/**
 * Refresh the In Progress + Review default workflow prompt templates on
 * existing workspaces so already-installed boards pick up the inline
 * follow-up filing gate (ticket 3dfc78d2 — "'별도 티켓 권장' 코멘트를 컬럼
 * 이동 전 즉시 파일링하도록 assignee/reviewer 워크플로 가이드에 게이트 추가").
 *
 * What changed in DEFAULT_PROMPT_TEMPLATES (prompt text only):
 *   - in_progress_workflow: a new step (`File any inline follow-up flags
 *     before moving`) is inserted before `Move to Review`. If the assignee
 *     wrote or spotted a "track in a separate ticket / follow-up needed" note
 *     that isn't a ticket yet, they must `create_ticket` it now (Backlog,
 *     priority=low, `Source:` link) rather than defer to the Self-Improvement
 *     Review. `Move to Review` renumbers 6 -> 7.
 *   - review_workflow: the LGTM decision gains the same gate inline — file any
 *     un-ticketed follow-up before `move_ticket` to Merging.
 *
 * Rationale: the retrospective (Self-Improvement Review) was the only thing
 * catching un-filed "recommend a separate ticket" memos, and only after the
 * source ticket reached a terminal column — late and non-deterministic. This
 * pulls the filing responsibility inline to the column-move boundary.
 *
 * Same operator-safety contract as 1760000000022 / 1760000000030 /
 * 1760000000031 / 1760000000036 / 1760000000042:
 *   - Insert-only seed/backfill paths never touch an existing row, so a
 *     workspace seeded before this change keeps the stale content forever
 *     unless refreshed here.
 *   - We UPDATE a row only when its `content` is byte-exactly the known prior
 *     default below. Any operator edit / earlier drift breaks the match and
 *     the row is left untouched.
 *   - We never INSERT here — that's the seed/backfill path's job.
 *
 * The PRIOR_* constants hold the verbatim pre-change template content
 * (captured from the source file at HEAD~1 of this change) as JSON string
 * literals so the escapes can't drift.
 *
 * Idempotent: re-running after apply is a no-op (rows now hold the current
 * content, which is not the prior string). Future revisions: push the
 * now-current content onto the prior list and bump DEFAULT_PROMPT_TEMPLATES
 * in the same change.
 */

const PRIOR_IN_PROGRESS_WORKFLOW = "# In Progress — Branch Work (assignee)\n\nThis ticket is in the In Progress column. Implement the work on a feature branch and hand it off to Review.\n\n> **Environment**: assignee has a full local repo. Use real git commands here. Do NOT merge to default — that happens in `merging_workflow` after Review approval.\n\n## Steps\n\n1. **Create or reuse the feature branch — always start from the latest tip**\n   - `git fetch origin` — **always**, every trigger. Never start work against a stale local ref.\n   - Resolve the base branch:\n     - If the trigger prompt includes a **Base repository** block, use the `Base branch` listed there. Verify your `working_dir` is a clone of the listed URL — if it isn't, stop and ask in a comment instead of guessing.\n     - Otherwise, fall back to the repository's default branch (`origin/HEAD`).\n   - Pull the base branch to the latest tip: `git checkout <base-branch> && git pull --ff-only origin <base-branch>`. Do this **every time** — for a brand-new branch *and* before reusing an existing one. Work always begins on the current tip of the base, never on a stale snapshot.\n   - **New branch** — from that up-to-date base, `git checkout -b ticket/{ticket_id_short}-{slug}` where:\n     - `ticket_id_short` — first 8 chars of the ticket id.\n     - `slug` — lowercase alphanumeric-and-hyphen slug derived from the ticket title (fall back to id only if no usable tokens).\n   - **Reused branch** (ticket bounced back from Review) — `git checkout` the existing branch and **immediately** `git rebase origin/<base-branch>` to lift your commits onto the latest tip *before* writing any new code. Amend or append commits afterwards; do **not** start over with a new name. If the rebase hits a conflict, integrate it the same way Merging does (fold same-meaning / duplicate changes; see `merging_workflow`) rather than abandoning the branch.\n\n2. **Overlap pre-flight — run BEFORE writing any implementation code.** A sibling ticket may already have shipped a fix for this same symptom on the default branch, possibly with a *different, incompatible* design. Building first and discovering the collision afterwards wastes the whole build pass. Check both directions:\n   - **Already on the default?** You already fetched + pulled the base to its tip in step 1. Now confirm the bug/symptom this ticket targets isn't already resolved there: `git log --oneline -20 origin/<base-branch>`, and grep the files/symptom you were about to touch (`git log -p --since=2.weeks -- <path>`, or search for the error string / function names). If the symptom is already fixed on the default, the build is moot.\n   - **In-flight elsewhere?** Scan for other **open or recently-Done** tickets attacking the same files/symptom: `mcp__awb__get_board_summary` / `mcp__awb__get_my_tickets`, and skim sibling tickets' titles/labels for the same bug. A sibling mid-build with a conflicting design is the same trap as one already merged.\n   - **If a conflicting sibling already merged or is in-flight → stop and escalate. Do NOT build.** Leave an `add_comment` stating which commit(s)/ticket already cover this symptom and why your planned design collides, mention the reporter (`@[role:reporter|<name>]`), and **park** rather than bounce — use `mcp__awb__pend_ticket` (human must decide: close as superseded, or re-scope this ticket to the residual). This is the cheap gate that the `7929ef0b`/`ff3e7337` collision skipped: that assignee ran exactly this check *on resume* and parked correctly — the only gap was not running it *before* the first build pass.\n   - **No overlap → proceed to step 3.**\n\n3. **Do the work** — implement the requirement. Split commits by logical unit (one commit per one change).\n\n4. **Push** — `git push -u origin <branch-name>`.\n   - **Record the exact pushed ref.** After pushing, confirm the remote ref name matches your local branch: `git ls-remote --heads origin <branch-name>` must return a row. If a push hook / PR automation renamed it on the remote (e.g. to `awb-<id>...`), note the **actual remote ref name** in your step-5 comment — that is the name Merging must delete. A local/remote name mismatch is what makes branch cleanup silently no-op later, leaving the ref orphaned on origin.\n   - **Submodule projects**: if the change is inside a submodule, push the submodule's feature branch here, but **do NOT bump the parent repo's submodule ref yet**. The parent bump happens in Merging, after the submodule default branch has absorbed the change.\n   - Before the final push, rebase onto the latest default so Merging can do a fast-forward: `git fetch origin && git rebase origin/<default>`. If this is a re-push after a rebase, use `git push --force-with-lease` on the feature branch (never the default branch).\n\n5. **Ticket comment** — `add_comment` with:\n   - Branch name (exactly as pushed).\n   - 3–5 line summary of the main changes.\n   - Build / test results if you ran them.\n   - If a PR already exists, its URL.\n\n6. **Move to Review** — `move_ticket` to the **Review** column.\n\n## When to park instead of bouncing back\n\nSometimes the work cannot finish in this ticket and bouncing it back to To Do (or Plan) just re-fires the same agent → same column → same blocker loop. Pick the parking tool by **what** you're waiting on:\n\n1. **Genuine human decision needed** (credentials, architectural choice with cost trade-offs, missing requirement only the reporter can fill in):\n   - Leave a comment explaining what you need (mention the reporter or whoever can answer).\n   - Call `mcp__awb__pend_ticket` with a one-line `reason` so the User tab on the ticket panel surfaces the ask without anyone having to read the whole comment thread.\n   - Stop. Do **not** `move_ticket` back. Pending tickets release the agent's focus, so other tickets get worked on while this one waits.\n   - A human clears it later with `unpend_ticket` and the dispatch loop wakes you back up.\n\n2. **Waiting on another ticket** — the blocker is *not* a human decision but the output of one or more other tickets that just need to finish (the perf-test job lands, the upstream refactor merges, a dependency entity gets built):\n   - File the prerequisite work if it doesn't exist yet (`mcp__awb__create_ticket`, referencing this ticket's id).\n   - Call `mcp__awb__add_ticket_prerequisites(ticket_id, [<prereq id(s)>], reason)`. This sets `pending_on_tickets=true` and **auto-resumes** the moment every prerequisite reaches a terminal column — no human `unpend` needed. Use this instead of `pend_ticket` whenever the blocker is another ticket.\n   - Stop. Do **not** `move_ticket` back. The block releases the focus exactly like a human pend, but the wake-up is automatic.\n\nThe rule of thumb: **human answer → `pend_ticket`; another ticket finishing → `add_ticket_prerequisites`.** If a ticket genuinely needs both, do both — either flag keeps the ticket parked until cleared.\n\n## Notes\n\n- **Never push directly to master / main / the default branch.** Reviewer and Merging stages gate that.\n- **Never start work from a stale state.** Always `git fetch` + pull the base to its latest tip — and `git rebase origin/<base>` a reused branch — *before* the first new commit (step 1). Building on an outdated base is what manufactures avoidable merge conflicts downstream.\n- If the plan is unclear or the requirement is ambiguous, leave a comment and stop — do not guess.\n- Out-of-scope bugs or refactor itches are not yours here. Propose a new ticket in a comment (or file it with `create_ticket` if it's a hard blocker — see \"When to park instead of bouncing back\" above).\n- Keep the feature branch rebased onto the latest default before the final push. Merging will rebase and actively integrate the branch onto the default if it has fallen behind, but a clean rebase here keeps that step trivial.\n- `--force-with-lease` is OK on the feature branch only. Force-pushing to a shared branch (default, release, …) is forbidden.\n- For PR-gated repos, open the PR with `gh pr create --draft` during this stage and include its URL in the comment so Review can inspect the diff remotely.\n";

const PRIOR_REVIEW_WORKFLOW = "# Review — Code Review + Q&A (reviewer / assignee)\n\nThis ticket is in the Review column. Both the reviewer **and** the assignee are triggered here so they can iterate on questions without bouncing the ticket back and forth. Your first job is to check which role you hold on this ticket, then follow only the matching branch below.\n\n> **Environment**:\n> - Reviewer: no local repo assumed — use `gh` CLI or the GitHub web UI.\n> - Assignee: has the local repo but does **not** edit code here — only responds to questions.\n>\n> If you are **neither** the reviewer nor the assignee on this ticket, do not `move_ticket` or post non-trivial comments; simply stop.\n\n## Step 0 — Identify your role\n\n- `mcp__awb__get_ticket` and compare the ticket's `reviewer_id` / `assignee_id` to your own agent identity.\n- **Reviewer** → follow the reviewer branch.\n- **Assignee** → follow the assignee branch.\n\n---\n\n## Reviewer branch\n\n1. **Identify the branch / PR** — find the branch name (and PR URL if present) the assignee posted in the ticket comments. If missing, `add_comment` asking for the branch name (mention the assignee with `@[role:assignee|<name>]`) and stop.\n\n2. **Base-freshness gate — review against the current integration target, not the stale fork point.** A `<default>...<branch>` comparison is a 3-dot diff computed from the *merge base* (where the branch forked). If the default has moved since — especially when the same area is evolving fast — that diff hides what already landed, so \"no regression / existing behaviour unchanged\" claims become **unverifiable against what will actually be integrated**. Gate on base freshness *before* reading the diff:\n   - Capture the current integration tip: `gh api repos/<owner>/<repo>/git/refs/heads/<default> --jq .object.sha` (or `gh pr view <pr> --json baseRefOid -q .baseRefOid`). This SHA is the base you review **against** — it goes in your decision comment.\n   - Check whether the branch is behind it: `gh pr view <pr> --json mergeStateStatus,baseRefName,headRefOid`. A `mergeStateStatus` of `BEHIND` (or `DIRTY` for a conflicting branch) means the branch forked from an older base and the diff is stale.\n   - **BEHIND / DIRTY** → do **not** approve backward-compat / \"no regression\" claims from this diff. `add_comment` asking the assignee to `git rebase origin/<default>` and re-push (mention `@[role:assignee|<name>]`), `move_ticket` back to **In Progress**, and stop. Re-review once the branch is current.\n   - **Current** (`CLEAN` / `HAS_HOOKS` / `UNSTABLE` — anything not behind) → proceed; the diff reflects the real integration target.\n\n3. **Inspect the diff remotely**\n   - Preferred: `gh pr diff <pr-number-or-branch>` — works with only a `gh` auth token, no local clone.\n   - Fallback: open `https://github.com/<owner>/<repo>/compare/<default>...<branch>` and read the diff in the browser / via MCP fetch.\n   - If neither is available, `add_comment` \"review blocked: no remote diff access — please attach the diff or a PR URL\" (mention the assignee) and stop.\n\n4. **Review dimensions**\n   - **Requirement fit** — does the diff solve what the ticket asked for?\n   - **Code quality** — style / structure consistent with the rest of the repo, meaningful names, no unrelated changes, no dead code.\n   - **Obvious bugs / security** — null handling, SQL injection, XSS, missing permission checks, log-forward-on-polling loops, etc.\n   - **Backward-compat / regression** — only mark a \"no regression\" / \"existing behaviour unchanged\" claim ✅ when the base-freshness gate (step 2) passed **and** the diff against the *current* base actually preserves the prior path. If the base lagged, or you can't confirm against the current integration target, **hold** that verdict and say so — never rubber-stamp backward-compat against a stale base.\n   - **CI signal** — `gh pr checks <pr>` / `gh run list --branch <branch>`. A red CI is a blocker.\n   - **Do not attempt local build or test.** You may not have a repo. If coverage looks thin, say so in the bounce comment.\n\n5. **Decision**\n   - **LGTM** → `add_comment` \"LGTM — approved for merge.\" with 1–2 lines of rationale **and the reviewed base SHA** (`reviewed against origin/<default>@<sha>` from step 2) so \"no regression vs. what?\" is auditable → `move_ticket` to **Merging**. (Do not move to Done — Merging handles the actual merge.)\n   - **Changes requested** → `add_comment` with concrete findings (`file:line` citations, \"X instead of Y\" suggestions), mention the assignee (`@[role:assignee|<name>]`) → `move_ticket` back to **In Progress**.\n   - **Question for the assignee** → `add_comment` with a specific question, mention the assignee (`@[role:assignee|<name>]`), and stop. Do **not** `move_ticket` — the ticket stays in Review so the assignee can answer without a round-trip to In Progress.\n   - **Cannot decide on your own** → `add_comment` with a specific question to the **reporter** (use `@[role:reporter|<name>]`) and stop. Do not `move_ticket`.\n\n## Reviewer notes\n\n- The reviewer **judges and comments** — never edits code. If changes are needed, bounce to In Progress so the assignee fixes it.\n- If in doubt, bounce (or stay in Review with a question) rather than rubber-stamp to Merging.\n- Review comments must be concrete (`file:line`, \"X instead of Y\"). No vague \"looks off\" / \"seems fine\".\n- **Record the reviewed base SHA.** Every LGTM states `reviewed against origin/<default>@<sha>` (step 2's captured tip). \"No regression\" is meaningless without naming the base it's measured against — and it makes a later stale-base merge visible.\n- **Never @-mention the reviewer role from a reviewer comment.** Self-mentions cause recursive triggers. Mention only the assignee or the reporter.\n- Approving to Merging is a statement that the *diff* is acceptable; the Merging stage handles rebase / conflict / push outcomes.\n\n---\n\n## Assignee branch\n\nYou handed the ticket off to Review. You are triggered here because the reviewer may have questions. You should **not** re-edit code from this column — that requires the ticket to bounce back to In Progress first.\n\n1. **Scan recent comments** — look at the newest comments since you last commented. Filter for ones that **mention you** (`@[role:assignee|<you>]`) or are clearly directed at you.\n\n2. **Decide what to do**\n   - **No open question for you** → no-op. Do not `add_comment` (it would spam the column), do not `move_ticket`.\n   - **Reviewer asked a concrete question** → answer in `add_comment`, citing the relevant code (`file:line` or snippet). Mention the reviewer (`@[role:reviewer|<name>]`) so they are re-triggered to read your answer. Stay in Review.\n   - **Reviewer requested changes and bounced the ticket** → this column workflow should not fire in that case (ticket moved to In Progress). If somehow the ticket is still in Review after a \"changes requested\" comment, leave a one-line \"moving to In Progress to address\" comment and `move_ticket` to **In Progress**.\n   - **Request needs more than a comment to answer** (e.g., \"run this command and paste output\") → do it from your local repo, then post the result as a comment.\n\n## Assignee notes\n\n- **Do not edit code in this column.** Code changes happen in In Progress. If fixes are needed, ask the reviewer to bounce, or you may `move_ticket` to In Progress yourself only if the reviewer already requested changes explicitly.\n- **Do not silently re-push the branch** without leaving a comment explaining what changed.\n- **No self-mention.** Do not `@[role:assignee|...]` from an assignee comment.\n- If both reviewer and reporter were mentioned in the same comment, answer the reviewer's question first; reporter routing handles broader concerns.\n";

// Map: template name -> known prior contents to refresh to the current
// default. List shape lets a future revision append the now-current
// content as the next "prior" without dropping this upgrade path.
export const PRIOR_FOLLOWUP_GATE_CONTENTS: Record<string, string[]> = {
  in_progress_workflow: [PRIOR_IN_PROGRESS_WORKFLOW],
  review_workflow: [PRIOR_REVIEW_WORKFLOW],
};

export class RefreshDefaultPromptTemplatesFollowupGate1760000000044
  implements MigrationInterface
{
  name = 'RefreshDefaultPromptTemplatesFollowupGate1760000000044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const wsRepo = manager.getRepository(Workspace);
    const tplRepo = manager.getRepository(PromptTemplate);

    const currentByName = new Map<string, string>();
    for (const def of DEFAULT_PROMPT_TEMPLATES) {
      if (def.name in PRIOR_FOLLOWUP_GATE_CONTENTS) {
        currentByName.set(def.name, def.content);
      }
    }

    const workspaces = await wsRepo.find();
    let updated = 0;
    let customized = 0;
    let missing = 0;
    let alreadyCurrent = 0;

    for (const ws of workspaces) {
      for (const name of Object.keys(PRIOR_FOLLOWUP_GATE_CONTENTS)) {
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
        const priorList = PRIOR_FOLLOWUP_GATE_CONTENTS[name];
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
      `[3dfc78d2 migration] prompt template refresh (inline follow-up filing gate) — ` +
        `updated=${updated} alreadyCurrent=${alreadyCurrent} ` +
        `customized=${customized} missing=${missing} ` +
        `across ${workspaces.length} workspace(s)`,
    );
  }

  public async down(): Promise<void> {
    // Data migration — no true inverse (see prior migrations' empty down()).
  }
}
