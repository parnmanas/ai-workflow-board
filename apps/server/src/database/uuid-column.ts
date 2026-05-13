/**
 * Shared TypeORM ValueTransformer for FK-like uuid columns that the v1 schema
 * stored as `varchar` with a `''` empty-string default sentinel.
 *
 * Why this exists — Phase B of the v0.42 uuid-typing unification widens every
 * FK column that references a `@PrimaryGeneratedColumn('uuid')` PK from
 * `varchar` to `uuid`. PostgreSQL refuses to compare `varchar = uuid`, so any
 * QueryBuilder JOIN against those columns (e.g. `ra.ticket_id = t.id`) blows
 * up with `operator does not exist: character varying = uuid`. SQLite stores
 * everything as TEXT and never trips this, which is why the bug only surfaces
 * in production.
 *
 * The catch — historical code paths pass `''` to indicate "no value" for these
 * columns (e.g. `assignee_id: '', created_by_id: ''`). After widening the
 * column to `uuid`, an `''` insert hits the same operator-mismatch error from
 * the *other* direction (PG can't cast '' to uuid). Updating every call site
 * to swap '' for null is a much larger blast-radius change than the schema
 * fix warrants.
 *
 * This transformer bridges the two — at the storage boundary, '' / undefined
 * / null all collapse to DB NULL, and reads of NULL return '' so consumer code
 * that already does `ticket.assignee_id || ''` continues to work unchanged.
 * Use this for columns whose property type is `string` and whose v1 default
 * was `''`. Columns whose property type is `string | null` and whose v1
 * default was `null` don't need the transformer — TypeORM handles them
 * natively once the column type is `uuid`.
 *
 * Note on query semantics — `repo.find({ where: { assignee_id: '' } })` will
 * now match rows where the DB column is NULL (the `to` step converts '' to
 * null, TypeORM emits `IS NULL`). That's the desired behaviour: '' was
 * always the "no value" marker, and consumers reading those rows continue
 * to see '' courtesy of the `from` step. No call site in the current tree
 * compares against `''` directly (verified via grep) so there's no
 * behavioural change.
 */

import { ValueTransformer } from 'typeorm';

export const emptyToNullUuid: ValueTransformer = {
  to: (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null;
    return String(value);
  },
  from: (value: unknown): string => {
    if (value === undefined || value === null) return '';
    return String(value);
  },
};

/**
 * Variant for columns whose property is already `string | null` (i.e. the
 * v1 entity declared `nullable: true, default: null`). The `from` step
 * passes null through instead of normalising to ''. The `to` step still
 * collapses '' to null defensively in case a caller writes '' rather than
 * null — protects against the same PG cast error for the rare write site
 * that uses the empty-string sentinel.
 */
export const nullablePassThroughUuid: ValueTransformer = {
  to: (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null;
    return String(value);
  },
  from: (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    return String(value);
  },
};
