/**
 * Worktree placement mode carried on agent_trigger / comment_mention.
 *
 * Since board removal (docs/tickets.md) every ticket gets its own worktree —
 * the server always sends 'per_ticket'. The 'shared' value stays in the type
 * because agent-managers still understand it from older servers, and the wire
 * field is shared with them.
 */

export const WORKTREE_MODES = ['per_ticket', 'shared'] as const;
export type WorktreeMode = (typeof WORKTREE_MODES)[number];

export const DEFAULT_WORKTREE_MODE: WorktreeMode = 'per_ticket';

/** Narrowing type guard for a worktree_mode value. */
export function isWorktreeMode(value: unknown): value is WorktreeMode {
  return typeof value === 'string' && (WORKTREE_MODES as readonly string[]).includes(value);
}
