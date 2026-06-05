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
  /**
   * Lowercased column name (matches DEFAULT_COLUMNS .name) to auto-link this
   * template to. Empty string → no auto-link.
   *
   * SEED-ONLY surface — used at workspace/board creation time to pair the
   * default templates with the freshly-minted default columns. Runtime
   * dispatch (`apps/server/src/modules/agents/**`) never reads column names;
   * it goes through `BoardColumn.kind` and `role_routing` exclusively (ticket
   * 47a90ea3 AC #3 enforces zero `name.toLowerCase()` compares in the
   * dispatch path). Migrating this field to `kind_match: ColumnKind` would
   * remove the last seed-time hardcode; tracked as a follow-up rather than
   * landed in this ticket since it's outside the runtime starvation scope.
   */
  column_match: string;
  content: string;
}

export const DEFAULT_PROMPT_TEMPLATES: DefaultPromptTemplateDef[] = [
  {
    name: 'backlog_workflow',
    description: 'Backlog column default workflow — reporter narrates server-driven backlog promotions; scheduling is owned by BacklogPromotionService.',
    category: 'default_workflow',
    column_match: 'backlog',
    content: `# Backlog — Narrate Server-Driven Promotions (reporter)

This ticket sits in an intake column. **Backlog → first-active promotion is now owned by the server's \`BacklogPromotionService\`** — it runs whenever an agent on the board frees up, picks the highest-priority intake ticket whose destination-column role holders are below cap, and moves it in a single transaction.

Your job here as reporter is **not to scan or schedule** — that path was a per-trigger full-board scan that self-amplified into a starvation loop. Instead, observe what the server already did and narrate it briefly so the audit trail is human-readable.

> **Environment**: reporter runs with no local repo. MCP-only; no git, no gh, no shell commands.

## Steps

1. **Read the ticket** — \`mcp__awb__get_ticket\` to load this ticket's recent comments and activity.

2. **Decide whether anything needs saying**:
   - **Server promoted this ticket out of intake** (you'll see a \`backlog_promoted\` audit row in the recent activity, or a \`moved\` comment authored by \`BacklogPromotionService\`) → \`add_comment\` with one line acknowledging the move and the reason if surfaced (priority, role holder freed, etc.). That's it.
   - **This ticket is still in the intake column** → no-op. Do **not** move it yourself, do **not** scan the rest of the backlog, do **not** comment. The next capacity event will fire the server-side promotion when it's eligible.
   - **Intake is empty / no candidates eligible** → no-op. The server already determined nothing can be promoted right now; an extra comment from the reporter just adds noise.

## Notes

- **Do not \`move_ticket\` from this prompt.** Promotions are server-owned; manual moves bypass the priority + capacity checks and are a regression risk.
- **Do not iterate the backlog or fetch the full board.** That was the v0.40 anti-pattern: every reporter trigger re-scanned, every scan wrote 2 comments, every comment was a fresh trigger. The server-side promotion is single-transaction and idempotent.
- **No self-mention.** Reporter comments must not use \`@[role:reporter|...]\`.
- If a backlog ticket has been sitting un-promoted for a long time and you suspect a bug, comment with the suspected blocker (e.g. \`"reviewer slot has been busy for 90 min — supervisor check?"\`) and stop. Humans decide whether to override.
- The reporter still owns answering planner / assignee / reviewer questions on tickets you filed — that's a separate trigger path (\`comment\` activity on a ticket you reported), not this one.
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
- **Don't bounce a ticket back to wait.** If a question to the reporter is the real blocker, leave the comment AND call \`mcp__awb__pend_ticket\` with a \`reason\`. This releases the focus so other tickets get worked on while this one waits, and the User tab on the ticket panel surfaces the ask. Bouncing through To Do ↔ another column without parking just re-triggers you in a loop.
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
- **Park, don't ping-pong.** When a blocking question goes to the reporter, call \`mcp__awb__pend_ticket\` with a one-line \`reason\` instead of leaving the ticket in Plan (or bouncing it). Parking releases the focus so other tickets advance; the User tab on the ticket panel surfaces the ask so a human can intervene without scanning comments.
- **Blocked on another ticket, not a human?** If the plan can only proceed once some *other* ticket finishes (an upstream refactor, a dependency that has to be built first), call \`mcp__awb__add_ticket_prerequisites(ticket_id, [<prereq id(s)>], reason)\` instead of \`pend_ticket\`. It parks the ticket the same way but **auto-resumes** the moment every prerequisite lands on a terminal column — no human \`unpend\` needed. Rule of thumb: human answer → \`pend_ticket\`; another ticket finishing → \`add_ticket_prerequisites\`.
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

1. **Create or reuse the feature branch — always start from the latest tip**
   - \`git fetch origin\` — **always**, every trigger. Never start work against a stale local ref.
   - Resolve the base branch:
     - If the trigger prompt includes a **Base repository** block, use the \`Base branch\` listed there. Verify your \`working_dir\` is a clone of the listed URL — if it isn't, stop and ask in a comment instead of guessing.
     - Otherwise, fall back to the repository's default branch (\`origin/HEAD\`).
   - Pull the base branch to the latest tip: \`git checkout <base-branch> && git pull --ff-only origin <base-branch>\`. Do this **every time** — for a brand-new branch *and* before reusing an existing one. Work always begins on the current tip of the base, never on a stale snapshot.
   - **New branch** — from that up-to-date base, \`git checkout -b ticket/{ticket_id_short}-{slug}\` where:
     - \`ticket_id_short\` — first 8 chars of the ticket id.
     - \`slug\` — lowercase alphanumeric-and-hyphen slug derived from the ticket title (fall back to id only if no usable tokens).
   - **Reused branch** (ticket bounced back from Review) — \`git checkout\` the existing branch and **immediately** \`git rebase origin/<base-branch>\` to lift your commits onto the latest tip *before* writing any new code. Amend or append commits afterwards; do **not** start over with a new name. If the rebase hits a conflict, integrate it the same way Merging does (fold same-meaning / duplicate changes; see \`merging_workflow\`) rather than abandoning the branch.

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

## When to park instead of bouncing back

Sometimes the work cannot finish in this ticket and bouncing it back to To Do (or Plan) just re-fires the same agent → same column → same blocker loop. Pick the parking tool by **what** you're waiting on:

1. **Genuine human decision needed** (credentials, architectural choice with cost trade-offs, missing requirement only the reporter can fill in):
   - Leave a comment explaining what you need (mention the reporter or whoever can answer).
   - Call \`mcp__awb__pend_ticket\` with a one-line \`reason\` so the User tab on the ticket panel surfaces the ask without anyone having to read the whole comment thread.
   - Stop. Do **not** \`move_ticket\` back. Pending tickets release the agent's focus, so other tickets get worked on while this one waits.
   - A human clears it later with \`unpend_ticket\` and the dispatch loop wakes you back up.

2. **Waiting on another ticket** — the blocker is *not* a human decision but the output of one or more other tickets that just need to finish (the perf-test job lands, the upstream refactor merges, a dependency entity gets built):
   - File the prerequisite work if it doesn't exist yet (\`mcp__awb__create_ticket\`, referencing this ticket's id).
   - Call \`mcp__awb__add_ticket_prerequisites(ticket_id, [<prereq id(s)>], reason)\`. This sets \`pending_on_tickets=true\` and **auto-resumes** the moment every prerequisite reaches a terminal column — no human \`unpend\` needed. Use this instead of \`pend_ticket\` whenever the blocker is another ticket.
   - Stop. Do **not** \`move_ticket\` back. The block releases the focus exactly like a human pend, but the wake-up is automatic.

The rule of thumb: **human answer → \`pend_ticket\`; another ticket finishing → \`add_ticket_prerequisites\`.** If a ticket genuinely needs both, do both — either flag keeps the ticket parked until cleared.

## Notes

- **Never push directly to master / main / the default branch.** Reviewer and Merging stages gate that.
- **Never start work from a stale state.** Always \`git fetch\` + pull the base to its latest tip — and \`git rebase origin/<base>\` a reused branch — *before* the first new commit (step 1). Building on an outdated base is what manufactures avoidable merge conflicts downstream.
- If the plan is unclear or the requirement is ambiguous, leave a comment and stop — do not guess.
- Out-of-scope bugs or refactor itches are not yours here. Propose a new ticket in a comment (or file it with \`create_ticket\` if it's a hard blocker — see "When to park instead of bouncing back" above).
- Keep the feature branch rebased onto the latest default before the final push. Merging will rebase and actively integrate the branch onto the default if it has fallen behind, but a clean rebase here keeps that step trivial.
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
    description: 'Merging column default workflow — assignee rebases the feature branch onto the latest default and actively integrates same-meaning conflicts (escalating only on a genuinely big problem), lands it, deletes the branch (local + remote), bumps parent submodule ref if needed, and moves the ticket to Done.',
    category: 'default_workflow',
    column_match: 'merging',
    content: `# Merging — Integrate into Default (assignee)

This ticket is in the Merging column, which means Review approved the diff. Your job: land the feature branch on the default branch, delete the feature branch (local + remote), and advance the ticket to Done.

> **Environment**: assignee has a full local repo. This stage exists because reviewer / reporter may not — so all real merge work happens here.
>
> **Integrate, don't bounce on first friction.** Since you branched, similar or overlapping work may already have landed on the default. A clean fast-forward is the happy path — but when it doesn't apply, you are **expected to rebase and actively integrate**: resolve conflicts whose two sides mean the same thing, fold duplicate/overlapping changes together, and carry on. Bouncing the ticket at the first conflict is the wrong default. Escalate (bounce / pend) **only** on a genuinely big problem — see "When to integrate vs. escalate" below.
>
> **Definition of merged**: a local merge is not enough. **(a)** \`origin/<default>\` must point at the integrated commit(s), and **(b)** the feature branch must be deleted from **both** local and remote. Verify with commands at each step.

## Steps

1. **Identify the default branch** — \`git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'\` (typically \`master\` or \`main\`).

2. **Rebase onto the latest default and integrate**
   - \`git fetch origin --prune\`
   - \`git checkout <feature-branch>\`
   - If behind the default: \`git rebase origin/<default>\`.
   - **On conflict — integrate, don't reflexively bounce.** Inspect each conflicting hunk:
     - **Similar / duplicate work already on the default** (someone landed the same or an overlapping change first) and the two sides mean the same thing → integrate them: take the default's version (or the merged superset), drop your now-redundant duplicate, and confirm the result still expresses this ticket's intent.
     - **Mechanical textual conflict** (imports, adjacent edits, moved lines, formatting) with a clear correct resolution → resolve it.
     - \`git add\` the resolved files and \`git rebase --continue\` until the rebase is clean.
     - **Escalate only on a genuinely big problem** — see "When to integrate vs. escalate" below. In that case \`git rebase --abort\`, \`add_comment\` naming which boundary you hit, and \`move_ticket\` back to **In Progress** (or \`pend_ticket\` if it needs a human decision).
   - After a successful rebase: \`git push --force-with-lease\` (feature branch only — never the default).

3. **Merge into default**
   - \`git checkout <default-branch>\`
   - \`git pull --ff-only origin <default-branch>\`
   - \`git merge --ff-only <feature-branch>\` — after step 2's rebase this fast-forwards cleanly.
   - **If the ff fails** because the default moved again while you were rebasing: re-run step 2 (\`git checkout <feature-branch> && git rebase origin/<default>\`, integrating any fresh conflicts), then retry the ff. This loop is normal under concurrent merges — repeat until it fast-forwards, escalating only if you hit a genuinely big problem per the boundary below.

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
   - **If you integrated any rebase/merge conflicts in step 2/3**: which hunk(s) conflicted, why each was safe to fold (same meaning / duplicate work already on the default / mechanical), and confirmation that build + relevant tests still pass after the integration. This is the audit trail for the relaxed-ff policy.
   - If any step failed, record the failure mode precisely so Done's sanity check can surface it.

8. **Move to Done** — \`move_ticket\` to the **Done** column. (Leave in Merging only if you recorded a \`manual merge required\` block above.)

## When to integrate vs. escalate

**Default to integrating.** Overlapping or duplicate work landing on the default before you is expected, not exceptional — resolve it in step 2/3 and move on. Bounce back to In Progress (or \`pend_ticket\` for a human) **only** when the conflict is a genuinely big problem, namely any of:

- **Semantic conflict** — the same lines were changed with a *different intent*, so choosing or merging the sides actually changes behaviour. That's a real decision, not a mechanical resolution.
- **Data / schema loss risk** — integrating would drop or override a migration, column, or persisted field, or otherwise risks corrupting/clobbering data.
- **Build or tests break after integration** — you rebased/merged but \`build\` or the relevant tests now fail and the fix isn't an obvious mechanical one.
- **Human judgment required** — the correct resolution depends on product/architecture intent only the reporter or a human can settle.

If none of these apply, integrate and proceed — record what you folded in the step-7 comment. If one does apply, escalate with a precise comment naming which boundary you hit, then bounce or pend; do not guess a resolution through a semantic or data-loss conflict.

## Notes

- **A local merge is not completion.** Step 4's verification (\`HEAD == origin/<default>\`) is the threshold.
- **Feature branches must be deleted on BOTH sides.** Deleting only one leaves dangling refs.
- **Never force-push master / main / the default branch.** Ever. \`--force-with-lease\` is only acceptable on the feature branch during rebase.
- **PR-gated repos** — replace steps 3–5 with \`gh pr merge <pr> --squash --delete-branch\`. After merging, verify with \`gh pr view <pr> --json state,mergeCommit\` (\`state\` must be \`MERGED\`). If \`--delete-branch\` silently failed, fall back to manual \`git push origin --delete\` + \`git branch -d\`. If the PR reports conflicts, integrate them locally first via step 2 (rebase + fold same-meaning changes, push \`--force-with-lease\` on the feature branch), then re-run the merge — same integrate-vs-escalate boundary applies.
- **No \`gh\` available and direct push rejected** → stop, record \`"manual merge required"\`, leave the ticket in Merging for a human.
- **Submodule changes must run through step 6.** Skipping the parent bump leaves every other environment pointing at the old ref.
- After merge, a quick sanity build on the default branch is cheap insurance. If it's broken, open a follow-up ticket or revert immediately.
`,
  },
  {
    name: 'done_workflow',
    description: 'Done column default workflow — reporter verifies the merge trail and records completion. Backlog scheduling is server-owned (BacklogPromotionService).',
    category: 'default_workflow',
    column_match: 'done',
    content: `# Done — Completion (reporter)

This ticket is in the Done column. Merging already landed the code and deleted the feature branch. Your job is administrative: record the completion on the reporter side. **Backlog scheduling is no longer your responsibility** — \`BacklogPromotionService\` runs server-side on the same capacity event the supervisor watches, so a freed agent triggers the next promotion automatically.

> **Environment**: reporter may have no local repo. MCP-only. No git, gh, or shell commands.

## Steps

1. **Sanity-check the merge trail**
   - \`mcp__awb__get_ticket\` on this ticket — confirm the Merging-stage comment exists and includes a merge commit SHA plus branch-deletion confirmation.
   - If the confirmation is **missing** or says \`"manual merge required"\`, \`add_comment\` \`"done reached without merge confirmation — please verify"\` and stop.

2. **Completion comment** — \`add_comment\` with:
   - One line acknowledging the ticket is fully complete from the reporter's side.
   - Reference the merge commit SHA from the Merging comment (copy it, do not re-compute).

That's it. The terminal landing eventually fires \`agent_idle\` for the merging agent (when its subagent exits), which drains that agent's dispatch queue and gives \`BacklogPromotionService\` a chance to pull the next intake ticket forward. No manual scheduling pass is needed or wanted.

## Notes

- **No local git, no \`gh\`, no branch operations here.** Merge / push / delete already happened in Merging.
- **No self-mention.** Reporter comments must not use \`@[role:reporter|...]\`.
- **Do not run a backlog scan.** Scanning is forbidden — the server owns it. Manual scans were the v0.40 starvation source.
- If you suspect the server-side promotion is stuck (e.g. backlog has critical work but the freed agent didn't pick anything up), comment with the suspicion and stop. Humans investigate; you don't override.
`,
  },
];
