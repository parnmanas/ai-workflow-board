import { MigrationInterface, QueryRunner } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { DEFAULT_PROMPT_TEMPLATES } from '../default-prompt-templates';

/**
 * Refresh the Review default workflow prompt template on existing workspaces
 * so already-installed boards pick up the rebase-before-review base-freshness
 * gate (ticket 87b7e073 — "리뷰어 게이트: stale base 가 아닌 최신 origin/main
 * 기준으로 diff 검토").
 *
 * What changed in DEFAULT_PROMPT_TEMPLATES (prompt text only, review_workflow):
 *   - Reviewer branch gains step 2, a **base-freshness gate**: capture the
 *     current integration tip (`gh api .../git/refs/heads/<default>` /
 *     `gh pr view --json baseRefOid`), check `mergeStateStatus`, and bounce a
 *     `BEHIND`/`DIRTY` branch back to In Progress for a rebase instead of
 *     reviewing a stale 3-dot diff.
 *   - Review dimensions gain a **Backward-compat / regression** bullet: a
 *     "no regression" ✅ requires the freshness gate to have passed, else the
 *     verdict is held.
 *   - Decision/Notes require the LGTM comment to record the reviewed base SHA
 *     (`reviewed against origin/<default>@<sha>`) so "no regression vs. what?"
 *     is auditable.
 *
 * Same operator-safety contract as 1760000000022 / 1760000000030 /
 * 1760000000031 / 1760000000036:
 *   - Insert-only seed/backfill paths never touch an existing row, so a
 *     workspace seeded before this change keeps the stale content forever
 *     unless refreshed here.
 *   - We UPDATE a row only when its `content` is byte-exactly the known prior
 *     default below. Any operator edit / earlier drift breaks the match and
 *     the row is left untouched.
 *   - We never INSERT here — that's the seed/backfill path's job.
 *
 * The PRIOR_* constant holds the verbatim pre-change template content
 * (captured from the source file at HEAD~1 of this change) as a JSON string
 * literal — same byte-exact contract as the prior refresh migrations,
 * encoded as a JSON string rather than a template literal so the escapes
 * can't drift.
 *
 * Idempotent: re-running after apply is a no-op (rows now hold the current
 * content, which is not the prior string). Future revisions: push the
 * now-current content onto the prior list and bump DEFAULT_PROMPT_TEMPLATES
 * in the same change.
 */

const PRIOR_REVIEW_WORKFLOW = "# Review — Code Review + Q&A (reviewer / assignee)\n\nThis ticket is in the Review column. Both the reviewer **and** the assignee are triggered here so they can iterate on questions without bouncing the ticket back and forth. Your first job is to check which role you hold on this ticket, then follow only the matching branch below.\n\n> **Environment**:\n> - Reviewer: no local repo assumed — use `gh` CLI or the GitHub web UI.\n> - Assignee: has the local repo but does **not** edit code here — only responds to questions.\n>\n> If you are **neither** the reviewer nor the assignee on this ticket, do not `move_ticket` or post non-trivial comments; simply stop.\n\n## Step 0 — Identify your role\n\n- `mcp__awb__get_ticket` and compare the ticket's `reviewer_id` / `assignee_id` to your own agent identity.\n- **Reviewer** → follow the reviewer branch.\n- **Assignee** → follow the assignee branch.\n\n---\n\n## Reviewer branch\n\n1. **Identify the branch / PR** — find the branch name (and PR URL if present) the assignee posted in the ticket comments. If missing, `add_comment` asking for the branch name (mention the assignee with `@[role:assignee|<name>]`) and stop.\n\n2. **Inspect the diff remotely**\n   - Preferred: `gh pr diff <pr-number-or-branch>` — works with only a `gh` auth token, no local clone.\n   - Fallback: open `https://github.com/<owner>/<repo>/compare/<default>...<branch>` and read the diff in the browser / via MCP fetch.\n   - If neither is available, `add_comment` \"review blocked: no remote diff access — please attach the diff or a PR URL\" (mention the assignee) and stop.\n\n3. **Review dimensions**\n   - **Requirement fit** — does the diff solve what the ticket asked for?\n   - **Code quality** — style / structure consistent with the rest of the repo, meaningful names, no unrelated changes, no dead code.\n   - **Obvious bugs / security** — null handling, SQL injection, XSS, missing permission checks, log-forward-on-polling loops, etc.\n   - **CI signal** — `gh pr checks <pr>` / `gh run list --branch <branch>`. A red CI is a blocker.\n   - **Do not attempt local build or test.** You may not have a repo. If coverage looks thin, say so in the bounce comment.\n\n4. **Decision**\n   - **LGTM** → `add_comment` \"LGTM — approved for merge.\" with 1–2 lines of rationale → `move_ticket` to **Merging**. (Do not move to Done — Merging handles the actual merge.)\n   - **Changes requested** → `add_comment` with concrete findings (`file:line` citations, \"X instead of Y\" suggestions), mention the assignee (`@[role:assignee|<name>]`) → `move_ticket` back to **In Progress**.\n   - **Question for the assignee** → `add_comment` with a specific question, mention the assignee (`@[role:assignee|<name>]`), and stop. Do **not** `move_ticket` — the ticket stays in Review so the assignee can answer without a round-trip to In Progress.\n   - **Cannot decide on your own** → `add_comment` with a specific question to the **reporter** (use `@[role:reporter|<name>]`) and stop. Do not `move_ticket`.\n\n## Reviewer notes\n\n- The reviewer **judges and comments** — never edits code. If changes are needed, bounce to In Progress so the assignee fixes it.\n- If in doubt, bounce (or stay in Review with a question) rather than rubber-stamp to Merging.\n- Review comments must be concrete (`file:line`, \"X instead of Y\"). No vague \"looks off\" / \"seems fine\".\n- **Never @-mention the reviewer role from a reviewer comment.** Self-mentions cause recursive triggers. Mention only the assignee or the reporter.\n- Approving to Merging is a statement that the *diff* is acceptable; the Merging stage handles rebase / conflict / push outcomes.\n\n---\n\n## Assignee branch\n\nYou handed the ticket off to Review. You are triggered here because the reviewer may have questions. You should **not** re-edit code from this column — that requires the ticket to bounce back to In Progress first.\n\n1. **Scan recent comments** — look at the newest comments since you last commented. Filter for ones that **mention you** (`@[role:assignee|<you>]`) or are clearly directed at you.\n\n2. **Decide what to do**\n   - **No open question for you** → no-op. Do not `add_comment` (it would spam the column), do not `move_ticket`.\n   - **Reviewer asked a concrete question** → answer in `add_comment`, citing the relevant code (`file:line` or snippet). Mention the reviewer (`@[role:reviewer|<name>]`) so they are re-triggered to read your answer. Stay in Review.\n   - **Reviewer requested changes and bounced the ticket** → this column workflow should not fire in that case (ticket moved to In Progress). If somehow the ticket is still in Review after a \"changes requested\" comment, leave a one-line \"moving to In Progress to address\" comment and `move_ticket` to **In Progress**.\n   - **Request needs more than a comment to answer** (e.g., \"run this command and paste output\") → do it from your local repo, then post the result as a comment.\n\n## Assignee notes\n\n- **Do not edit code in this column.** Code changes happen in In Progress. If fixes are needed, ask the reviewer to bounce, or you may `move_ticket` to In Progress yourself only if the reviewer already requested changes explicitly.\n- **Do not silently re-push the branch** without leaving a comment explaining what changed.\n- **No self-mention.** Do not `@[role:assignee|...]` from an assignee comment.\n- If both reviewer and reporter were mentioned in the same comment, answer the reviewer's question first; reporter routing handles broader concerns.\n";

// Map: template name -> known prior contents to refresh to the current
// default. List shape lets a future revision append the now-current
// content as the next "prior" without dropping this upgrade path.
export const PRIOR_REVIEW_REBASE_CONTENTS: Record<string, string[]> = {
  review_workflow: [PRIOR_REVIEW_WORKFLOW],
};

export class RefreshDefaultPromptTemplatesReviewRebase1760000000042
  implements MigrationInterface
{
  name = 'RefreshDefaultPromptTemplatesReviewRebase1760000000042';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const wsRepo = manager.getRepository(Workspace);
    const tplRepo = manager.getRepository(PromptTemplate);

    const currentByName = new Map<string, string>();
    for (const def of DEFAULT_PROMPT_TEMPLATES) {
      if (def.name in PRIOR_REVIEW_REBASE_CONTENTS) {
        currentByName.set(def.name, def.content);
      }
    }

    const workspaces = await wsRepo.find();
    let updated = 0;
    let customized = 0;
    let missing = 0;
    let alreadyCurrent = 0;

    for (const ws of workspaces) {
      for (const name of Object.keys(PRIOR_REVIEW_REBASE_CONTENTS)) {
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
        const priorList = PRIOR_REVIEW_REBASE_CONTENTS[name];
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
      `[87b7e073 migration] prompt template refresh (rebase-before-review base-freshness gate) — ` +
        `updated=${updated} alreadyCurrent=${alreadyCurrent} ` +
        `customized=${customized} missing=${missing} ` +
        `across ${workspaces.length} workspace(s)`,
    );
  }

  public async down(): Promise<void> {
    // Data migration — no true inverse (see prior migrations' empty down()).
  }
}
