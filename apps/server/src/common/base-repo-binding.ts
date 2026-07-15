/**
 * Base repository binding for dispatch (ticket 8c3befa8).
 *
 * Two pure helpers the trigger-loop dispatch path uses so "임의 저장소 추정 금지"
 * is enforced by code, not convention:
 *
 *  1. `pickBaseRepoResourceId` — auto-bind the board environment repo as the
 *     DEFAULT base repo. When a ticket carries no `base_repo_resource_id`,
 *     dispatch falls back to the board's merged `environment_config`
 *     `repositories[0].resource_id` (and to that Resource's `default_branch`
 *     for an empty `base_branch`, resolved by the caller). Same "fill an empty
 *     field from a board-level default" shape as the `default_role_assignments`
 *     backfill (ticket d94a1b87).
 *
 *  2. `requiresBaseRepo` — the guard predicate. An assignee dispatched onto an
 *     active (branch-work) column with NO resolvable repo would land in a
 *     worktree it can't push from: worktree-manager's credential install
 *     early-returns on a null repo, so `git push` later dies with
 *     `could not read Username` and the assignee loops every cycle waiting on a
 *     "base repo 미지정" that never arrives (the root cause behind ticket
 *     34f2da14 and the repeated "worktree 프로비저닝 실패" comment spam). The
 *     dispatch path pends the ticket instead of emitting into that doomed loop.
 *
 * Kept as pure functions (no DB / no NestJS) so the backfill precedence and the
 * guard scope are unit-testable in isolation — `_emitTrigger` itself is not
 * cheaply bootable, so its wiring is pinned by a separate static guard.
 */

/** Minimal shape of a (merged) environment_config repository entry. */
export interface EnvRepoRef {
  resource_id?: string;
}

export type BaseRepoSource = 'ticket' | 'board_env' | 'none';

export interface PickedBaseRepo {
  /** The chosen repo Resource id, or '' when none can be determined. */
  resourceId: string;
  /** Where it came from — for logging / audit only. */
  source: BaseRepoSource;
}

/**
 * Pick the base_repo Resource id for a dispatch: the ticket's own id wins;
 * otherwise the first board-environment repository that carries a `resource_id`.
 *
 * A url-only env repo (no `resource_id`) is deliberately NOT a valid fallback:
 * without a Resource id the downstream credential lookup can't resolve a git
 * credential, so binding it would just recreate the "no credential" push
 * failure this ticket exists to prevent. Such an entry is skipped, and if
 * nothing else qualifies the result is `{ resourceId: '', source: 'none' }` —
 * the caller then treats the dispatch as un-bindable (see `requiresBaseRepo`).
 */
export function pickBaseRepoResourceId(
  ticketBaseRepoId: string | null | undefined,
  envRepositories: EnvRepoRef[] | null | undefined,
): PickedBaseRepo {
  const ticketId = (ticketBaseRepoId || '').trim();
  if (ticketId) return { resourceId: ticketId, source: 'ticket' };
  for (const repo of envRepositories || []) {
    const rid = (repo?.resource_id || '').trim();
    if (rid) return { resourceId: rid, source: 'board_env' };
  }
  return { resourceId: '', source: 'none' };
}

/**
 * Does this dispatch's role/column pairing do branch work that pushes?
 *
 * True only for an assignee on an active (branch-work) column — the sole
 * role/column pairing that checks out a worktree and pushes. Planner / reviewer
 * / QA / security / chat dispatches never push. Mirrors the exact "needs a real
 * repo" predicate the claim-verification branch-tip snapshot already uses in
 * `_emitTrigger` (`role === 'assignee' && col.kind === 'active'`).
 */
export function requiresBaseRepo(
  role: string | null | undefined,
  columnKind: string | null | undefined,
): boolean {
  return role === 'assignee' && columnKind === 'active';
}

/**
 * Goal 2 guard decision: should this dispatch be BLOCKED (pended) because a
 * base repo is REQUIRED (branch-work role/column) but none resolved?
 *
 * Fires when BOTH hold:
 *  - the role/column pushes (`requiresBaseRepo` — assignee on an active column);
 *  - NO usable base repo resolved, from the ticket's own id OR the board-env
 *    backfill (`pickBaseRepoResourceId`).
 *
 * DELIBERATELY unconditional on whether a repo was "configured" anywhere. Ticket
 * 8c3befa8's acceptance is literal: "보드에 environment repo 가 없는 상태로
 * base_repo 미지정 티켓 dispatch → 추정 없이 pend/차단". Gating the block on a
 * repo being pre-declared (the earlier `repoWasExpected` heuristic) let exactly
 * that scenario — ticket AND board-env both empty — slip through and emit, the
 * opposite of the requirement.
 *
 * This also mirrors the authoritative manager behaviour: agent-manager's
 * `validateWorktreeProvisioningInputs` fails an assignee ticket dispatch closed
 * with `missing_repository_resource` whenever the bootstrap repo has no
 * resource_id — there is no "non-code" branch-work dispatch on the manager side.
 * Blocking here just moves that inevitable failure earlier, as a clean server
 * pend with a human-actionable reason, instead of letting the assignee loop into
 * the manager's per-cycle "worktree 프로비저닝 실패" abort (the comment spam this
 * ticket exists to end). No repo guessing — fail closed. `requiresBaseRepo`
 * already scopes this to the sole branch-work pairing, so planner / reviewer /
 * QA / chat dispatches (which never push) are untouched.
 */
export function shouldBlockDispatchForMissingRepo(args: {
  role: string | null | undefined;
  columnKind: string | null | undefined;
  hasResolvedBaseRepo: boolean;
}): boolean {
  return requiresBaseRepo(args.role, args.columnKind) && !args.hasResolvedBaseRepo;
}
