import type { DataSource } from 'typeorm';

/**
 * Normalizes a ROLLING-WINDOW `created_at >= :since`-style query parameter so
 * it compares correctly against sql.js/sqlite (ticket 8fc94adf).
 *
 * Root cause: `@CreateDateColumn()` fields (Comment.created_at,
 * ActivityLog.created_at, ...) that are left unset when the entity is
 * created get their value from the column's DB-level `DEFAULT
 * (datetime('now'))` — sqlite's own `datetime('now')` has NO fractional
 * seconds ("2026-07-22 14:48:30"). A bound `Date` query parameter, however,
 * is always formatted by TypeORM's sqlite driver WITH milliseconds
 * ("2026-07-22 14:48:30.000"). Since the comparison is a plain lexicographic
 * string compare on sqlite, a stored value is a strict *prefix* of a same-
 * second parameter and therefore always sorts before it — `created_at >=
 * :since` silently excludes any row created in the same wall-clock second as
 * `since`, no matter its true sub-second ordering.
 *
 * Postgres stores/compares real `timestamp` values at full precision and
 * has no such mismatch, so this is a no-op for every driver except sqljs.
 *
 * The fix floors `since` to a whole-second string in the exact format
 * sqlite's own default produces, so same-second rows compare equal (and
 * therefore match `>=`) instead of being silently dropped. This WIDENS the
 * matched set by less than one second — safe for a pure rolling window
 * (`since = now - windowMs`, e.g. respawn-storm-detector.service.ts's
 * forward-progress veto) where there is no other invariant to protect.
 *
 * DO NOT use this for an EPOCH-ANCHORED comparison (`since` = the ticket's
 * last human-unpend timestamp, as in common/hard-budget-guard.ts's
 * `countAutoResponses`/`countWindowDispatches`). There, the exact same
 * same-second EXCLUSION this function removes is load-bearing: it guarantees
 * a comment/dispatch from BEFORE the unpend epoch never gets recounted as
 * "after" it. Widening that comparison to be same-second-inclusive lets
 * pre-epoch events leak into the post-unpend count and reopens the
 * permanent-death loop ticket a940d75b closed (see hard-budget-guard.ts's
 * doc comments on those two functions, and hard-budget-guard.test.mjs's "a
 * human unpend actually clears the ceiling" regression test).
 */
export function sinceBoundaryParam(dataSource: DataSource, since: Date): Date | string {
  if (dataSource.options.type !== 'sqljs') return since;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${since.getUTCFullYear()}-${pad(since.getUTCMonth() + 1)}-${pad(since.getUTCDate())} ` +
    `${pad(since.getUTCHours())}:${pad(since.getUTCMinutes())}:${pad(since.getUTCSeconds())}`
  );
}
