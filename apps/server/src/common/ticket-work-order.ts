/**
 * The built-in work order every ticket dispatch carries (docs/tickets.md).
 *
 * Boards used to split a ticket over Plan / In Progress / Review / Merging
 * columns, each with its own prompt template and role. A ticket now has ONE
 * agent who owns it end to end, so the whole lifecycle is one document. It
 * rides `agent_trigger.column_prompt` (template_id `builtin:ticket-work-order`)
 * because that is the slot every agent-manager version already renders —
 * older managers show it as the "column workflow guide", newer ones as the
 * work order.
 *
 * Workspace / project specifics are not written here: the workspace harness
 * (`system_prompt_append`, language) and the project's `instructions` ride
 * alongside on the same payload.
 */

export const TICKET_WORK_ORDER_TEMPLATE_ID = 'builtin:ticket-work-order';
export const TICKET_WORK_ORDER_NAME = 'Ticket work order';

export interface TicketWorkOrderContext {
  /** Project the ticket is about; null for non-code tickets. */
  project: {
    name: string;
    repo_url: string;
    default_branch: string;
    use_pr: boolean;
    instructions: string;
    main_clone_dir: string | null;
  } | null;
  /** Branch the work starts from ('' → the project's default, then origin/HEAD). */
  base_branch: string;
}

function landingSection(usePr: boolean): string {
  if (usePr) {
    return `## 5. Land (this project lands through pull requests)
- Push the feature branch and open a PR (\`gh pr create --fill\`). Put the PR URL in a comment.
- Wait for CI on the PR. If it will take a while, call \`mcp__awb__await_ci_run\` and end your turn — AWB wakes you when the run finishes. Never sleep-poll.
- Fix red CI, then merge (\`gh pr merge\`) and delete the branch. Verify the PR is merged and \`origin/<base>\` contains your commits.`;
  }
  return `## 5. Land (this project merges directly)
- \`git fetch origin\`, rebase the feature branch onto the latest \`origin/<base>\`, re-run the relevant checks.
- Fast-forward the base: \`git checkout <base> && git pull --ff-only && git merge --ff-only <feature-branch> && git push origin <base>\`.
- Verify: \`git merge-base --is-ancestor <feature-branch> origin/<base>\` exits 0, then delete the feature branch locally and on origin.
- If the push is rejected (protection, CI gate): never force-push the base. Comment the reason and \`mcp__awb__pend_ticket\`.`;
}

/** Render the work order for one dispatch. Pure — no I/O. */
export function renderTicketWorkOrder(ctx: TicketWorkOrderContext): string {
  const project = ctx.project;
  const base = ctx.base_branch || project?.default_branch || 'origin/HEAD';
  const projectBlock = project
    ? [
        `## Project: ${project.name}`,
        `- Repository: ${project.repo_url || '(no repository URL)'}`,
        `- Base branch: ${base}`,
        project.main_clone_dir
          ? `- Main clone on this host: \`${project.main_clone_dir}\` — the operator's checkout. Never reset, clean or switch branches in it; your worktree is cut from it.`
          : '- This host has no registered main clone for the project; the manager prepared a clone for you.',
        project.instructions.trim() ? `\n### Project instructions\n${project.instructions.trim()}` : '',
      ].filter(Boolean).join('\n')
    : '## No project\nThis ticket is not about a repository. Skip the git steps (3 and 5); do the work, then report and finish the same way.';

  return `# Ticket work order

You are the only agent on this ticket and you own it end to end — there is no separate planner, reviewer or merger. AWB has already moved it to **In Progress**.

${projectBlock}

## 1. Understand
- Read the ticket with \`mcp__awb__get_ticket\`: description, instructions, comments, attachments, child tickets, prerequisites.
- Investigate before asking. If the requirement is genuinely ambiguous in a way only a human can settle, ask in a comment, call \`mcp__awb__pend_ticket\` with a one-line reason, and stop.

## 2. Plan
- For anything non-trivial, post a short plan as a comment before you start.
- Big work: split it. Fan independent parts out to your own subagents and integrate their results yourself, or create child tickets (\`mcp__awb__create_child_ticket\`) as a checklist you work through. Do not hand the work to other agents.
- Before building, check the work is not already done or in flight: \`git log origin/${base}\`, and \`mcp__awb__list_tickets\` with this ticket's project/tags.

## 3. Implement
- Work in the current directory — it is this ticket's own worktree. \`git fetch origin\` first and start from the latest \`${base}\`; rebase a reused branch before adding commits.
- Commit by logical unit with clear messages.

## 4. Verify
- Build and run the tests that cover the change. Then review your own diff (\`git diff origin/${base}...HEAD\`) the way a strict reviewer would: correctness, scope creep, leftovers, missing tests.

${project ? landingSection(project.use_pr) : '## 5. Land\nNothing to land.'}

## 6. Report and finish
- \`mcp__awb__add_comment\` with: what changed, how you verified it (paste the key output), commit SHA / PR URL, anything left over.
- File follow-ups you noticed as new tickets (\`mcp__awb__create_ticket\`, status \`backlog\`, same project and tags, description starting with a link to this ticket).
- Then finish with exactly one of:
  - \`mcp__awb__move_ticket(status: "done")\` — the work is complete and landed.
  - \`mcp__awb__move_ticket(status: "review")\` — a human should check the result first; say what to check.
  - \`mcp__awb__pend_ticket\` — blocked on a human decision.
  - \`mcp__awb__add_ticket_prerequisites\` — blocked on other tickets; you resume automatically when they are done.
  - \`mcp__awb__await_ci_run\` — waiting on a long CI run; you resume automatically.

## Rules
- Never stop with the ticket left In Progress and nothing registered — AWB treats that as a crashed agent and wakes you again.
- Comments a human adds while you work are steering. Read and address them.
- Never push to the base branch without the checks in step 4, and never force-push the base branch.`;
}
