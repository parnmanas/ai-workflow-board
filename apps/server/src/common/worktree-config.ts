/**
 * Worktree / merge convention board options — foundation of the worktree
 * 규약 chain (전면 재정의).
 *
 * Two plain board-level scalars that every follow-up ticket in the chain reads
 * through the single null-safe resolver here, so the "what mode / PR on?"
 * decision lives in one place:
 *
 *   - worktree_mode: 'per_ticket' | 'shared'  (default 'per_ticket')
 *       Where an agent lays down the worktree it works a ticket in, always
 *       rooted at `<working_dir>/.awb/wt/…`:
 *         per_ticket → one worktree per ticket   → `.awb/wt/<ticket8>/`
 *         shared     → one reused worktree        → `.awb/wt/shared/`
 *   - use_pr: boolean  (default false)
 *       false → direct fast-forward merge on the Merging boundary (today's
 *       behaviour); true → the opt-in PR create/merge path.
 *
 * These are ordinary `varchar` / `boolean` columns with DB defaults — NOT JSON
 * config — so the module mirrors the `self_improvement_mode` / `benchmark_mode`
 * enum convention (a null-safe read resolver + a strict write-path validator),
 * not the `harness_config` JSON convention (parse/serialize). synchronize:true
 * (db.ts) auto-adds a default-bearing column in every env, so no migration is
 * needed ([[awb_db_synchronize_always_on_all_envs]]).
 *
 * REGRESSION SAFETY: a board that never sets either field (every board today)
 * resolves to per_ticket / false — the pre-existing behaviour — so introducing
 * the columns changes nothing until a follow-up ticket actually reads them.
 */

export const WORKTREE_MODES = ['per_ticket', 'shared'] as const;
export type WorktreeMode = (typeof WORKTREE_MODES)[number];

/** Default worktree mode when a board has not set one (regression baseline). */
export const DEFAULT_WORKTREE_MODE: WorktreeMode = 'per_ticket';
/** Default PR usage when a board has not set one — direct ff merge. */
export const DEFAULT_USE_PR = false;

/** Narrowing type guard for a worktree_mode value. */
export function isWorktreeMode(value: unknown): value is WorktreeMode {
  return typeof value === 'string' && (WORKTREE_MODES as readonly string[]).includes(value);
}

/**
 * Fixed worktree root, relative to the agent's working_dir: `.awb/wt` (규약 ②).
 * Mirrors agent-manager's `worktreesRootFor()` so the server and the manager
 * agree on placement — the server never knows the absolute working_dir, so it
 * only ever produces this working_dir-relative path.
 */
export const WORKTREE_ROOT_REL = '.awb/wt';

/**
 * Map a ticket + mode to the worktree dir's last path segment — the EXACT
 * mirror of agent-manager's `worktreeSlug()` (worktree-manager.ts), kept in
 * sync so the relative path the server injects into the trigger prompt (규약 ④)
 * resolves to the same folder the manager actually checks out at spawn:
 *   per_ticket → the ticket uuid's first 8 chars (sanitized);
 *   shared     → the literal 'shared' (one reused checkout for every ticket).
 */
export function worktreeSlugFor(
  ticketId: string,
  mode: WorktreeMode = DEFAULT_WORKTREE_MODE,
): string {
  if (mode === 'shared') return 'shared';
  const t = String(ticketId || '').slice(0, 8).replace(/[^A-Za-z0-9._-]/g, '_');
  return t || 'ticket';
}

/**
 * Resolve the working_dir-relative worktree path AWB assigns a ticket (규약 ④):
 * `.awb/wt/<slug>`. Shipped on the agent_trigger SSE payload so agent-manager
 * can name the concrete work folder in the trigger prompt; the manager joins it
 * onto the agent's working_dir (which the server never knows) and prefers the
 * actual resolved cwd so the printed path matches the real spawn cwd/worktree.
 * `mode` is the already-resolved board worktree_mode.
 */
export function resolveWorktreeRelPath(
  ticketId: string,
  mode: WorktreeMode = DEFAULT_WORKTREE_MODE,
): string {
  return `${WORKTREE_ROOT_REL}/${worktreeSlugFor(ticketId, mode)}`;
}

/**
 * Null-safe READ: resolve a stored worktree_mode into a concrete mode. Any
 * null / undefined / unknown / malformed value degrades to the default
 * 'per_ticket' so a corrupt row never breaks a dispatch path (read path never
 * throws — same posture as resolveMergeGate).
 */
export function resolveBoardWorktreeMode(raw: string | null | undefined): WorktreeMode {
  return isWorktreeMode(raw) ? raw : DEFAULT_WORKTREE_MODE;
}

/**
 * Null-safe READ: resolve a stored use_pr value into a concrete boolean.
 * null / undefined → the default false (direct ff merge). Accepts the DB's
 * native boolean plus the sql.js 0/1 integer and a "true"/"1" string so a
 * value that round-trips through a raw driver / JSON still reads correctly;
 * anything else falls back to the default.
 */
export function resolveBoardUsePr(raw: boolean | number | string | null | undefined): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') return raw === 'true' || raw === '1';
  return DEFAULT_USE_PR;
}

/**
 * Validate a WRITE-path worktree_mode input (REST PATCH body / MCP arg). Unlike
 * the resolver this REJECTS an unknown value so the caller can 400 — silent
 * coercion to the default on a write would make a typo'd mode vanish without
 * feedback (same contract as validateMergeGateConfigInput).
 */
export function validateWorktreeModeInput(
  input: unknown,
): { ok: true; value: WorktreeMode } | { ok: false; error: string } {
  if (!isWorktreeMode(input)) {
    return { ok: false, error: `worktree_mode must be one of: ${WORKTREE_MODES.join(', ')}` };
  }
  return { ok: true, value: input };
}

/**
 * Validate a WRITE-path use_pr input. Accepts a real boolean and the common
 * wire encodings (true/false, 1/0, "true"/"false") so a REST body that carries
 * a stringified boolean still passes, but REJECTS anything genuinely non-boolean
 * (e.g. "yes", 2, {}) so a typo 400s instead of being coerced.
 */
export function validateUsePrInput(
  input: unknown,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (typeof input === 'boolean') return { ok: true, value: input };
  if (input === 1 || input === '1' || input === 'true') return { ok: true, value: true };
  if (input === 0 || input === '0' || input === 'false') return { ok: true, value: false };
  return { ok: false, error: 'use_pr must be a boolean' };
}
