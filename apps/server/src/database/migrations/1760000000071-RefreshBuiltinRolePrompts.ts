import { MigrationInterface, QueryRunner } from 'typeorm';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { BUILTIN_ROLES } from '../../db';

/**
 * ticket ec498050 — refresh the two builtin `role_prompt` texts that
 * over-constrained the planner/assignee roles into asking-before-acting even
 * when the codebase and git history could answer the question themselves.
 *
 * The assignee text specifically ("if the plan is missing or stale, ask the
 * planner instead of improvising") was the direct, code-free root cause of
 * ticket 29ea479c: the assignee repeatedly refused to implement without a
 * fresh plan, bouncing the ticket back instead of self-investigating. The
 * planner text had the same "resolve ambiguity by asking, don't investigate
 * first" shape one role prior in the pipeline.
 *
 * `BUILTIN_ROLES` in `db.ts` already carries the NEW text (self-investigate
 * first, only ask when a genuine decision remains) — this migration is the
 * data-side counterpart that reaches EXISTING workspace rows a source change
 * alone can't touch.
 *
 * EXACT-MATCH predicate (unlike 1760000000009's "only if empty" backfill):
 * a `WorkspaceRole.role_prompt` row is replaced ONLY when it is byte-for-byte
 * identical to the OLD seed string below. Any operator who customized their
 * prompt — even by one character — keeps their own text untouched.
 *
 * Because this is a REPLACE (not 1760000000070's append), `down()` is a real
 * inverse: it runs the same exact-match swap in reverse (new seed → old
 * seed), so a rollback restores exactly what a fresh `up()` would have
 * overwritten. Self-referential risk: this migration changes the prompt of
 * whichever agent is CURRENTLY running this ticket's own In Progress column —
 * ship it as an independent commit from the Phase A code-gate changes so
 * either half can roll back without the other (ticket ec498050 plan §3).
 */

const OLD_PLANNER =
  "You are acting as the PLANNER on this ticket.\n" +
  "\n" +
  "Goal: turn the ticket's intent into a concrete, reviewable plan before " +
  "anyone starts implementing.\n" +
  "\n" +
  "Responsibilities:\n" +
  "- Read the ticket, its description, and any prior comments end-to-end before posting.\n" +
  "- Identify ambiguities, missing context, or hidden constraints. Resolve them by " +
  "@mentioning the reporter (or other relevant role) with a focused question — do not " +
  "guess.\n" +
  "- Produce a numbered task breakdown that an assignee can execute without re-deriving " +
  "the design. Each step should name files/components, expected behavior, and acceptance " +
  "criteria.\n" +
  "- Flag risks, edge cases, and rollback considerations explicitly. If subtasks are " +
  "warranted, create them.\n" +
  "- When the plan is complete and unblocked, move the ticket to In Progress so the " +
  "assignee picks it up.\n" +
  "\n" +
  "Do NOT implement the work yourself in this role — that's the assignee's job.";

const OLD_ASSIGNEE =
  "You are acting as the ASSIGNEE on this ticket.\n" +
  "\n" +
  "Goal: deliver the planned change to a state where the reviewer can sign off.\n" +
  "\n" +
  "Responsibilities:\n" +
  "- Read the latest plan and any open questions before starting; if the plan is missing " +
  "or stale, ask the planner instead of improvising.\n" +
  "- Implement the change in small, focused commits with clear messages. Keep behavior " +
  "consistent with the plan; surface any plan-vs-reality conflicts as comments rather " +
  "than silent deviations.\n" +
  "- Self-test before handing off: run the relevant tests, exercise the user-visible " +
  "behavior, and report what you actually verified (not just what you wrote).\n" +
  "- When the work is ready for review, post a short summary comment (what changed, how " +
  "it was tested, any caveats) and move the ticket to Review.\n" +
  "- If the reviewer kicks it back, address every point in the same ticket — don't open " +
  "a new one for the same work.";

function newPromptFor(slug: string): string {
  const def = BUILTIN_ROLES.find(r => r.slug === slug);
  if (!def) throw new Error(`RefreshBuiltinRolePrompts1760000000071: no BUILTIN_ROLES entry for slug "${slug}"`);
  return def.role_prompt;
}

export class RefreshBuiltinRolePrompts1760000000071 implements MigrationInterface {
  name = 'RefreshBuiltinRolePrompts1760000000071';

  private async swap(queryRunner: QueryRunner, replacements: Array<{ slug: string; from: string; to: string }>): Promise<number> {
    const repo = queryRunner.manager.getRepository(WorkspaceRole);
    let updated = 0;
    for (const { slug, from, to } of replacements) {
      const rows = await repo.find({ where: { slug, role_prompt: from } });
      for (const row of rows) {
        row.role_prompt = to;
        await repo.save(row);
        updated++;
      }
    }
    return updated;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const updated = await this.swap(queryRunner, [
      { slug: 'planner', from: OLD_PLANNER, to: newPromptFor('planner') },
      { slug: 'assignee', from: OLD_ASSIGNEE, to: newPromptFor('assignee') },
    ]);
    console.log(`[ec498050 migration] up: refreshed ${updated} builtin role_prompt row(s) (exact-match only)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const updated = await this.swap(queryRunner, [
      { slug: 'planner', from: newPromptFor('planner'), to: OLD_PLANNER },
      { slug: 'assignee', from: newPromptFor('assignee'), to: OLD_ASSIGNEE },
    ]);
    console.log(`[ec498050 migration] down: restored ${updated} builtin role_prompt row(s) (exact-match only)`);
  }
}
