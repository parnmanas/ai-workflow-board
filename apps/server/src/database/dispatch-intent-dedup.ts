/**
 * Rollout-safe pre-index repair for the durable dispatch outbox (ticket 3c3b17a3).
 *
 * WHY THIS EXISTS
 * The follow-up hardening declares a PARTIAL UNIQUE index
 *   `uniq_dispatch_intent_open_ticket_role (ticket_id, role) WHERE status != 'resolved'`
 * on `dispatch_intents` (see entities/DispatchIntent.ts). `synchronize` (hardcoded
 * ON for sqlite AND postgres — db.ts D-01) emits `CREATE UNIQUE INDEX … WHERE …`
 * on the FIRST boot after this lands.
 *
 * But the very defect this ticket fixes — the non-atomic find-then-insert in
 * recordDispatched/recordOwed/createSeed — means a LIVE production DB may ALREADY
 * hold two (or more) OPEN rows for the same (ticket_id, role). `CREATE UNIQUE
 * INDEX` against that pre-existing duplicate FAILS, and because it runs inside
 * `DataSource.initialize()` (before any NestJS lifecycle hook / data migration),
 * the whole server boot aborts. The downstream `_emitTrigger` in-flight-strand
 * gate only dedupes real SPAWNS — it does nothing to prevent duplicate intent
 * ROWS — so the duplicate-open state is genuinely reachable in prod.
 *
 * THE REPAIR
 * Before `synchronize` builds the index, deterministically collapse every
 * (ticket_id, role) group to at most ONE open row by RESOLVING the extras. The
 * survivor is the row `_findOpen` would pick — `ORDER BY created_at ASC, id ASC`
 * — so the repair reproduces the exact runtime selection and never resurrects a
 * row the reconciler wouldn't have chosen. Resolving (not deleting) preserves the
 * audit trail and slots straight into the partial predicate (`status != 'resolved'`
 * rows are excluded from the index), so after the repair the `CREATE UNIQUE INDEX`
 * lands cleanly. Idempotent: on an already-clean DB the UPDATE matches zero rows.
 *
 * CROSS-DB
 * The statement is intentionally parameter-free and uses only constructs SQLite
 * (sql.js) and Postgres share — `CURRENT_TIMESTAMP` and a self-correlated
 * subquery referencing the UPDATE target — so the SAME SQL runs verbatim on both
 * backends (the ticket's dual-DB requirement). It is executed:
 *   - Postgres: from `preSyncPostgres()` via the raw `pg` Client (pre-sync-postgres.ts)
 *   - sql.js:   from `preSyncSqljsOpenIntents()` via a raw sql.js load (db.ts)
 * both of which run BEFORE TypeORM initializes / synchronizes.
 */

/** Table name (single source of truth for the pre-sync callers + tests). */
export const DISPATCH_INTENTS_TABLE = 'dispatch_intents';

/** Reason stamped on rows resolved by the pre-index repair (audit + test hook). */
export const DEDUP_RESOLVE_REASON = 'deduped_pre_open_unique_index';

/**
 * Resolve every DUPLICATE open (`status != 'resolved'`) dispatch_intent so at most
 * ONE open row survives per (ticket_id, role). The survivor is the group's minimum
 * by (created_at, id) — i.e. the row `_findOpen` orders first — leaving every
 * "later" open sibling resolved. Parameter-free; safe to run on both sql.js and
 * Postgres verbatim. No-op when there are no duplicates.
 */
export const DEDUP_OPEN_DISPATCH_INTENTS_SQL = `
UPDATE ${DISPATCH_INTENTS_TABLE}
   SET status = 'resolved',
       resolved_at = CURRENT_TIMESTAMP,
       last_reason = '${DEDUP_RESOLVE_REASON}',
       lease_owner = '',
       lease_expires_at = NULL
 WHERE status <> 'resolved'
   AND EXISTS (
         SELECT 1
           FROM ${DISPATCH_INTENTS_TABLE} o
          WHERE o.ticket_id = ${DISPATCH_INTENTS_TABLE}.ticket_id
            AND o.role       = ${DISPATCH_INTENTS_TABLE}.role
            AND o.status <> 'resolved'
            AND (
                  o.created_at <  ${DISPATCH_INTENTS_TABLE}.created_at
               OR (o.created_at = ${DISPATCH_INTENTS_TABLE}.created_at
                   AND o.id < ${DISPATCH_INTENTS_TABLE}.id)
                )
       )`.trim();
