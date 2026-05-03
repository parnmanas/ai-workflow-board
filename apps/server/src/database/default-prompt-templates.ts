/**
 * Default workflow prompt templates seeded into every newly-created
 * workspace and (via migration) into existing workspaces that are missing
 * any of them.
 *
 * Each entry pairs a template (name + content + category) with a
 * `column_match` slug — the lowercased column name from `DEFAULT_COLUMNS`
 * that this template should auto-attach to when a new default board is
 * minted. The seed code looks up the column by name (case-insensitive),
 * the template by name, and writes both ids into `Board.column_prompts`
 * so the workflow runs end-to-end on a fresh install without the admin
 * having to wire each column manually.
 *
 * Customization model:
 * - First-run / new workspace: all 7 rows inserted with `is_builtin`
 *   semantics (well, prompt templates don't carry that flag yet — we
 *   just dedupe by name on re-seed). Operators can edit/delete freely
 *   per-workspace afterwards.
 * - Existing workspaces (via 1760000000010 migration): only insert
 *   templates whose `name` is missing in the workspace; never touch
 *   existing rows. Operators with custom forks of these templates keep
 *   their custom content intact.
 *
 * Adding a new default: append to the array, optionally set
 * `column_match` if it pairs with a known DEFAULT_COLUMNS column. The
 * seed flow is idempotent so re-running on already-seeded workspaces is
 * a no-op.
 */
export interface DefaultPromptTemplateDef {
  name: string;
  description: string;
  category: string;
  /** Lowercased column name (matches DEFAULT_COLUMNS .name) to auto-link this template to. Empty string → no auto-link. */
  column_match: string;
  content: string;
}

export const DEFAULT_PROMPT_TEMPLATES: DefaultPromptTemplateDef[] = [
  {
    name: 'backlog_workflow',
    description: 'Backlog column default workflow — reporter scans the backlog and promotes the highest-priority ticket with idle assignee + reviewer into To Do.',
    category: 'default_workflow',
    column_match: 'backlog',
    content: `# Backlog — Work Scheduler (reporter)

This ticket is in the Backlog column and you were triggered as the board's reporter. Your job is **not to process this specific ticket** — it is to scan the entire backlog and move the *highest-priority ticket that can actually start right now* into the To Do column. That ticket may or may not be this one.

> **Environment**: reporter runs with no local repo. This prompt is MCP-only — never issue git, gh, or shell commands.

## Steps

1. **Load board context**
   - \`mcp__awb__get_ticket\` to confirm this ticket's \`column_id\`.
   - \`mcp__awb__get_board\` to fetch the full board state — every column, every ticket's \`assignee_id\` / \`reviewer_id\` / \`priority\` / \`status\` / \`created_at\`.

2. **Build the candidate queue** — sort backlog tickets:
   - **Primary**: priority (\`critical\` → \`high\` → \`medium\` → \`low\`).
   - **Secondary**: \`created_at\` ascending (older first within the same priority).
   - **Skip**: tickets missing \`assignee_id\` or \`reviewer_id\`. Those need human scheduling.

3. **Idle check** (iterate the queue in priority order):
   - A role is **busy** if the agent bound to it appears as \`assignee_id\` OR \`reviewer_id\` on any ticket in the same board's To Do, In Progress, Review, or Merging columns.
   - Apply the check to both the candidate's assignee and reviewer.
   - The first candidate whose **assignee AND reviewer are both idle** is the pick → go to step 4.
   - If the entire queue is busy: \`mcp__awb__add_comment\` on *this* ticket with one line — \`"no idle capacity; top candidates busy: {id1 — reason}, {id2 — reason}"\` — and stop. Do not \`move_ticket\`.

4. **Promote the picked ticket to To Do**
   - \`mcp__awb__add_comment\` on the picked ticket:
     - Scheduler identity (reporter name / agent_id).
     - One-line rationale (e.g., \`"priority=high; assignee=bob and reviewer=alice both have no active tickets"\`).
     - If higher-priority candidates were skipped, summarise 1–3 of them (e.g., \`"ticket {id} skipped: assignee=bob busy on in_progress ticket {id}"\`).
   - \`mcp__awb__move_ticket\` to the **To Do** column.

5. **Marker on this ticket** — if the picked ticket is **not** this one, \`mcp__awb__add_comment\` here: \`"scheduled {picked-id} into To Do instead"\`. Leave this ticket in Backlog.

## Notes

- **Do not move this ticket just because you were triggered on it.** This prompt is a scheduler, not a "process this one" worker.
- **Never interrupt work to make room for a critical ticket.** If a \`priority: critical\` backlog ticket's assignee or reviewer is busy, leave a comment noting the situation and stop. A human decides whether to interrupt.
- **One \`move_ticket\` per trigger.** Do not schedule multiple tickets in a single pass.
- **The scheduler never creates or deletes tickets.** Empty backlog or all-busy state does not justify conjuring work or removing tickets. Humans define scope.
- **Board-scoped idle check.** Cross-board activity is ignored; scheduling unit is a single board.
- **No self-mention.** Reporter comments must not use \`@[role:reporter|...]\`. Reference other roles by name instead. Self-mentions cause recursive triggers.
- If the reporter is also the assignee or reviewer on some ticket, those tickets still count toward their busy check.
`,
  },
  {
    name: 'todo_workflow',
    description: 'To Do column default workflow — assignee decides whether to start now or wait based on concurrent work conflicts.',
    category: 'default_workflow',
    column_match: 'to do',
    content: `# To Do — Start-or-Wait Decision (assignee)

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
`,
  },
  {
    name: 'plan_workflow',
    description: 'Plan column default workflow — planner turns the ticket\'s intent into a concrete plan, asks the reporter when ambiguous, optionally creates subtasks, and hands off to In Progress. MCP-only, no local git.',
    category: 'default_workflow',
    column_match: 'plan',
    content: `# Plan — Concrete Plan Before Code (planner)

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
`,
  },
  {
    name: 'in_progress_workflow',
    description: 'In Progress column default workflow — assignee creates a feature branch, does the work, pushes, and hands off to Review.',
    category: 'default_workflow',
    column_match: 'in progress',
    content: `# In Progress — Branch Work (assignee)

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
`,
  },
  {
    name: 'review_workflow',
    description: 'Review column default workflow — reviewer inspects the diff remotely, assignee stays on standby to answer reviewer questions. Both roles are triggered; each branches on role.',
    category: 'default_workflow',
    column_match: 'review',
    content: `# Review — Code Review + Q&A (reviewer / assignee)

This ticket is in the Review column. Both the reviewer **and** the assignee are triggered here so they can iterate on questions without bouncing the ticket back and forth. Your first job is to check which role you hold on this ticket, then follow only the matching branch below.

> **Environment**:
> - Reviewer: no local repo assumed — use \`gh\` CLI or the GitHub web UI.
> - Assignee: has the local repo but does **not** edit code here — only responds to questions.
>
> If you are **neither** the reviewer nor the assignee on this ticket, do not \`move_ticket\` or post non-trivial comments; simply stop.

## Step 0 — Identify your role

- \`mcp__awb__get_ticket\` and compare the ticket's \`reviewer_id\` / \`assignee_id\` to your own agent identity.
- **Reviewer** → follow the reviewer branch.
- **Assignee** → follow the assignee branch.

---

## Reviewer branch

1. **Identify the branch / PR** — find the branch name (and PR URL if present) the assignee posted in the ticket comments. If missing, \`add_comment\` asking for the branch name (mention the assignee with \`@[role:assignee|<name>]\`) and stop.

2. **Inspect the diff remotely**
   - Preferred: \`gh pr diff <pr-number-or-branch>\` — works with only a \`gh\` auth token, no local clone.
   - Fallback: open \`https://github.com/<owner>/<repo>/compare/<default>...<branch>\` and read the diff in the browser / via MCP fetch.
   - If neither is available, \`add_comment\` "review blocked: no remote diff access — please attach the diff or a PR URL" (mention the assignee) and stop.

3. **Review dimensions**
   - **Requirement fit** — does the diff solve what the ticket asked for?
   - **Code quality** — style / structure consistent with the rest of the repo, meaningful names, no unrelated changes, no dead code.
   - **Obvious bugs / security** — null handling, SQL injection, XSS, missing permission checks, log-forward-on-polling loops, etc.
   - **CI signal** — \`gh pr checks <pr>\` / \`gh run list --branch <branch>\`. A red CI is a blocker.
   - **Do not attempt local build or test.** You may not have a repo. If coverage looks thin, say so in the bounce comment.

4. **Decision**
   - **LGTM** → \`add_comment\` "LGTM — approved for merge." with 1–2 lines of rationale → \`move_ticket\` to **Merging**. (Do not move to Done — Merging handles the actual merge.)
   - **Changes requested** → \`add_comment\` with concrete findings (\`file:line\` citations, "X instead of Y" suggestions), mention the assignee (\`@[role:assignee|<name>]\`) → \`move_ticket\` back to **In Progress**.
   - **Question for the assignee** → \`add_comment\` with a specific question, mention the assignee (\`@[role:assignee|<name>]\`), and stop. Do **not** \`move_ticket\` — the ticket stays in Review so the assignee can answer without a round-trip to In Progress.
   - **Cannot decide on your own** → \`add_comment\` with a specific question to the **reporter** (use \`@[role:reporter|<name>]\`) and stop. Do not \`move_ticket\`.

## Reviewer notes

- The reviewer **judges and comments** — never edits code. If changes are needed, bounce to In Progress so the assignee fixes it.
- If in doubt, bounce (or stay in Review with a question) rather than rubber-stamp to Merging.
- Review comments must be concrete (\`file:line\`, "X instead of Y"). No vague "looks off" / "seems fine".
- **Never @-mention the reviewer role from a reviewer comment.** Self-mentions cause recursive triggers. Mention only the assignee or the reporter.
- Approving to Merging is a statement that the *diff* is acceptable; the Merging stage handles rebase / conflict / push outcomes.

---

## Assignee branch

You handed the ticket off to Review. You are triggered here because the reviewer may have questions. You should **not** re-edit code from this column — that requires the ticket to bounce back to In Progress first.

1. **Scan recent comments** — look at the newest comments since you last commented. Filter for ones that **mention you** (\`@[role:assignee|<you>]\`) or are clearly directed at you.

2. **Decide what to do**
   - **No open question for you** → no-op. Do not \`add_comment\` (it would spam the column), do not \`move_ticket\`.
   - **Reviewer asked a concrete question** → answer in \`add_comment\`, citing the relevant code (\`file:line\` or snippet). Mention the reviewer (\`@[role:reviewer|<name>]\`) so they are re-triggered to read your answer. Stay in Review.
   - **Reviewer requested changes and bounced the ticket** → this column workflow should not fire in that case (ticket moved to In Progress). If somehow the ticket is still in Review after a "changes requested" comment, leave a one-line "moving to In Progress to address" comment and \`move_ticket\` to **In Progress**.
   - **Request needs more than a comment to answer** (e.g., "run this command and paste output") → do it from your local repo, then post the result as a comment.

## Assignee notes

- **Do not edit code in this column.** Code changes happen in In Progress. If fixes are needed, ask the reviewer to bounce, or you may \`move_ticket\` to In Progress yourself only if the reviewer already requested changes explicitly.
- **Do not silently re-push the branch** without leaving a comment explaining what changed.
- **No self-mention.** Do not \`@[role:assignee|...]\` from an assignee comment.
- If both reviewer and reporter were mentioned in the same comment, answer the reviewer's question first; reporter routing handles broader concerns.
`,
  },
  {
    name: 'merging_workflow',
    description: 'Merging column default workflow — assignee fast-forwards the feature branch into default, pushes, deletes the branch (local + remote), bumps parent submodule ref if needed, and moves the ticket to Done.',
    category: 'default_workflow',
    column_match: 'merging',
    content: `# Merging — Fast-Forward to Default (assignee)

This ticket is in the Merging column, which means Review approved the diff. Your job: land the feature branch on the default branch, delete the feature branch (local + remote), and advance the ticket to Done.

> **Environment**: assignee has a full local repo. This stage exists because reviewer / reporter may not — so all real merge work happens here.
>
> **Definition of merged**: a local merge is not enough. **(a)** \`origin/<default>\` must point at the merge commit, and **(b)** the feature branch must be deleted from **both** local and remote. Verify with commands at each step.

## Steps

1. **Identify the default branch** — \`git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'\` (typically \`master\` or \`main\`).

2. **Refresh**
   - \`git fetch origin --prune\`
   - \`git checkout <feature-branch>\`
   - If behind the default: \`git rebase origin/<default>\`, then \`git push --force-with-lease\` (feature branch only — never the default).
   - **On conflict**: do NOT resolve it yourself. \`add_comment\` "rebase conflict — assignee input needed" and \`move_ticket\` back to **In Progress**.

3. **Merge (ff-only)**
   - \`git checkout <default-branch>\`
   - \`git pull --ff-only origin <default-branch>\`
   - \`git merge --ff-only <feature-branch>\`
   - If the ff fails, retry step 2 once. If it still fails, bounce to **In Progress**.

4. **Push to origin (required)**
   - \`git push origin <default-branch>\`
   - **Verify**: \`git rev-parse HEAD\` == \`git rev-parse origin/<default-branch>\`. If they differ, the push did not land — read the error and retry.
   - If the push is rejected (branch protection, CI gate, …) → **never force-push the default branch**. Skip step 5, go to step 7, record \`"manual merge required — <default> push rejected: <reason>"\`, and stop.

5. **Delete the feature branch (both sides)**
   - Remote: \`git push origin --delete <feature-branch>\`
   - Local: \`git branch -d <feature-branch>\` (default must already be checked out; \`-D\` is unnecessary if the ff merge succeeded).
   - **Verify**:
     - \`git ls-remote --heads origin <feature-branch>\` → must be empty.
     - \`git branch --list <feature-branch>\` → must be empty.

6. **Submodule handling** (only if the feature branch lived inside a submodule)
   - Move into the parent repo; \`git status\` should show the submodule ref changed.
   - \`git add <submodule-path>\` → \`git commit -m "chore: bump <submodule> ref (<ticket-id>)"\` → \`git push origin <parent-default-branch>\`.
   - **Verify**: parent's \`git rev-parse HEAD\` == \`git rev-parse origin/<parent-default-branch>\`.
   - Multiple submodules? Finish steps 3–5 in each, then make a single bump commit in the parent.

7. **Ticket comment** — \`add_comment\` with all of:
   - Merge commit SHA (\`git rev-parse origin/<default-branch>\`).
   - Default branch name + \`origin push: OK\`.
   - Feature branch name + \`local/remote delete: OK\`.
   - Parent bump commit SHA (if step 6 applied).
   - If any step failed, record the failure mode precisely so Done's sanity check can surface it.

8. **Move to Done** — \`move_ticket\` to the **Done** column. (Leave in Merging only if you recorded a \`manual merge required\` block above.)

## Notes

- **A local merge is not completion.** Step 4's verification (\`HEAD == origin/<default>\`) is the threshold.
- **Feature branches must be deleted on BOTH sides.** Deleting only one leaves dangling refs.
- **Never force-push master / main / the default branch.** Ever. \`--force-with-lease\` is only acceptable on the feature branch during rebase.
- **PR-gated repos** — replace steps 3–5 with \`gh pr merge <pr> --squash --delete-branch\`. After merging, verify with \`gh pr view <pr> --json state,mergeCommit\` (\`state\` must be \`MERGED\`). If \`--delete-branch\` silently failed, fall back to manual \`git push origin --delete\` + \`git branch -d\`.
- **No \`gh\` available and direct push rejected** → stop, record \`"manual merge required"\`, leave the ticket in Merging for a human.
- **Submodule changes must run through step 6.** Skipping the parent bump leaves every other environment pointing at the old ref.
- After merge, a quick sanity build on the default branch is cheap insurance. If it's broken, open a follow-up ticket or revert immediately.
`,
  },
  {
    name: 'done_workflow',
    description: 'Done column default workflow — reporter verifies the merge trail, records completion, and runs one backlog-scheduling pass if the board is idle. MCP-only, no local git.',
    category: 'default_workflow',
    column_match: 'done',
    content: `# Done — Completion + Next-Ticket Scheduling (reporter)

This ticket is in the Done column. Merging already landed the code and deleted the feature branch. Your job is administrative: record the completion on the reporter side and, if the board is idle, pull the next work from Backlog.

> **Environment**: reporter may have no local repo. This prompt is MCP-only. Do not issue git, gh, or shell commands.

## Steps

1. **Sanity-check the merge trail**
   - \`mcp__awb__get_ticket\` on this ticket — confirm the Merging-stage comment exists and includes a merge commit SHA plus branch-deletion confirmation.
   - If the confirmation is **missing** or says \`"manual merge required"\`, \`add_comment\` \`"done reached without merge confirmation — please verify"\` and stop. Do not run the scheduler below.

2. **Completion comment** — \`add_comment\` with:
   - One line acknowledging the ticket is fully complete from the reporter's side.
   - Reference the merge commit SHA from the Merging comment (copy it, do not re-compute).

3. **Investment pass** — run the Backlog scheduler inline:
   - \`mcp__awb__get_board\` for the full board state.
   - If **To Do AND In Progress are both empty**, follow the \`backlog_workflow\` selection algorithm:
     - Priority order: \`critical\` → \`high\` → \`medium\` → \`low\`; break ties by \`created_at\` ascending.
     - Skip tickets missing assignee or reviewer.
     - Pick the first candidate whose assignee AND reviewer are both idle (no presence as assignee or reviewer on any To Do / In Progress / Review / Merging ticket on the same board).
     - \`add_comment\` on the pick with the scheduling rationale, then \`move_ticket\` to **To Do**.
   - If the board still has active work (anything in To Do, In Progress, Review, or Merging), **do nothing** — the next natural trigger will handle scheduling.
   - **One investment per done event.** Do not schedule multiple tickets in a single pass.

## Notes

- **No local git, no \`gh\`, no branch operations here.** Merge / push / delete already happened in Merging. If any of those are missing, the right response is a comment, not a retry.
- **No self-mention.** Reporter comments must not use \`@[role:reporter|...]\`. Reference other roles by name instead. Self-mentions cause recursive triggers.
- **Never forcibly interrupt.** Even if a critical backlog ticket is waiting and everyone looks busy, do not shuffle tickets to make room — leave a note and let a human decide.
- If this ticket's backlog is empty too, there is nothing to schedule. Leave the completion comment and stop.
- Same scheduling constraints as \`backlog_workflow\` apply: board-scoped idle check, missing assignee / reviewer skipped, one move per trigger.
`,
  },
];
