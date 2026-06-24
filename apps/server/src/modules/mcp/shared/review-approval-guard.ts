/**
 * Review→Merging approval guard (ticket a3d25202 — proposal 2 of 86bfb8af).
 *
 * Defense-in-depth complement to the trigger-routing fix shipped by 86bfb8af.
 * That ticket removed `assignee` from the Review column's `role_routing`, so an
 * assignee strand can no longer be *woken* in Review to self-LGTM and self-merge
 * (the trigger-race root cause). This guard closes the remaining hole: the
 * *manual / abnormal* paths — a human dragging a card Review→Merging, an
 * automated batch caller, or a future config edit that re-adds assignee to the
 * routing — could still cross the review gate without the reviewer role ever
 * having spoken.
 *
 * The mechanical rule: a ticket may only leave a `review` column for a `merging`
 * column when at least one reviewer-authored comment exists on it
 * (`metadata.author_role === 'reviewer'`). An assignee self-LGTM (author_role
 * 'assignee') does not satisfy it. Bypassable with an explicit `force=true`,
 * exactly like `isTerminalReopen` — a deliberate human override, never the
 * default automated path.
 *
 * Pure predicate + DB helper kept separate so each move surface can compose them
 * the same way it composes the terminal-reopen guard.
 */

import type { DataSource, EntityManager } from 'typeorm';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Comment } from '../../../entities/Comment';

type RepoScope = DataSource | EntityManager;

/**
 * True when a move crosses the review gate into the merge step — i.e. source is
 * a `review` column and dest is a `merging` column.
 *
 * Data-driven on ColumnKind (NOT column-name string compares, which are
 * forbidden in apps/server/src) so it survives column renames. Returns false the
 * moment either side is missing or carries a different kind, so forward moves
 * into Review, reorders, and every non-review→merging transition are unaffected.
 */
export function isReviewToMerging(
  sourceColumn: BoardColumn | null | undefined,
  destColumn: BoardColumn | null | undefined,
): boolean {
  return (sourceColumn as any)?.kind === 'review' && (destColumn as any)?.kind === 'merging';
}

/**
 * Does this ticket carry at least one reviewer-authored comment?
 *
 * Scans the ticket's comments for `metadata.author_role === 'reviewer'`,
 * ignoring `type='system'` board-move / role-change markers (those are written
 * by SystemCommentService, never by a reviewer). The author_role is stamped onto
 * comment metadata by add_comment from the subagent's role pin, so a comment
 * posted by the reviewer strand carries 'reviewer' while an assignee self-LGTM
 * carries 'assignee' — which is exactly the independence this gate enforces.
 *
 * N is small (a single ticket's comment timeline) so we load + filter in JS
 * rather than reaching for DB-specific JSON operators, keeping the check
 * portable across the SQLite/Postgres drivers this server runs on.
 */
export async function hasReviewerApproval(
  scope: RepoScope,
  ticketId: string,
): Promise<boolean> {
  const commentRepo = scope.getRepository(Comment);
  const comments = await commentRepo.find({ where: { ticket_id: ticketId } });
  return comments.some((c) => {
    if (c.type === 'system') return false;
    let meta: any;
    try {
      meta = JSON.parse(c.metadata || '{}');
    } catch {
      meta = {};
    }
    return meta?.author_role === 'reviewer';
  });
}

/**
 * Thrown / surfaced when a Review→Merging move is rejected because no
 * reviewer-authored comment exists yet. Callers that genuinely mean to override
 * (a human consciously advancing the card) pass `force=true`; everyone else gets
 * a stable, greppable rejection mirroring TerminalReopenError's shape.
 */
export class ReviewApprovalRequiredError extends Error {
  status = 409;
  code = 'review_approval_required';
  hint = 'A reviewer-authored comment (metadata.author_role="reviewer") must exist before Review→Merging; pass force=true to override.';
  constructor(ticketId: string, sourceName: string, destName: string) {
    super(
      `Ticket ${ticketId} cannot move from review column "${sourceName}" to merge column "${destName}" — ` +
      `no reviewer-authored comment (author_role="reviewer") exists yet. ` +
      `Review independence requires the reviewer role to sign off before merge; an assignee self-LGTM does not count. ` +
      `Have the reviewer post an approval comment, or pass force=true to deliberately override.`,
    );
    this.name = 'ReviewApprovalRequiredError';
  }
}
