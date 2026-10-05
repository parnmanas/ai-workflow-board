import { IsNull, type FindOptionsWhere } from 'typeorm';
import type { Skill } from '../../entities/Skill';
import { canUseCatalogItem, normalizeCatalogScope, type CatalogScope } from '../../common/catalog-scope';

/**
 * Scope plumbing for skills, on top of the shared catalog-scope model
 * (`docs/catalog-scopes.md`): Global (`account_id NULL`) or one Account.
 */

export type SkillScope = CatalogScope;

/** '' / undefined / 'global' → global; otherwise the workspace uuid. */
export function resolveSkillScope(input: {
  scope?: string | null;
  account_id?: string | null;
}): { account_id: string | null } {
  const normalized = normalizeCatalogScope({
    scope: input.scope,
    account_id: input.account_id ?? null,
  });
  return { account_id: normalized.account_id };
}

export function skillScopeOf(skill: Pick<Skill, 'account_id'>): SkillScope {
  return skill.account_id ? 'account' : 'global';
}

export function skillIsVisibleTo(skill: Pick<Skill, 'account_id'>, accountId: string): boolean {
  return canUseCatalogItem({ account_id: skill.account_id }, accountId);
}

/**
 * TypeORM `where` for "global rows OR this workspace's rows".
 *
 * `account_id: IsNull()` and `account_id: accountId` cannot be expressed
 * in one object, so this returns the two-element OR array TypeORM understands.
 * Always spread extra predicates into BOTH branches — a predicate added to
 * only one silently changes which scope it filters.
 */
export function visibleScopeWhere<T extends { account_id: string | null }>(
  accountId: string,
  extra: Partial<Record<keyof T, unknown>> = {},
): Array<FindOptionsWhere<T>> {
  return [
    { ...extra, account_id: IsNull() } as FindOptionsWhere<T>,
    { ...extra, account_id: accountId } as FindOptionsWhere<T>,
  ];
}

/**
 * Account-over-global shadowing by slug — the same precedence
 * WorkflowFunction applies to its `key`. A workspace fork of a built-in skill
 * therefore wins without the operator having to delete the global original.
 *
 * `include_shadowed` callers (the management UI) skip this and render both.
 */
export function shadowBySlug<T extends { slug: string; account_id: string | null }>(rows: T[]): T[] {
  const bySlug = new Map<string, T>();
  for (const row of rows) {
    const current = bySlug.get(row.slug);
    // Account beats global; between two rows of the same scope the first
    // wins (callers pass a deterministic order).
    if (!current || (!current.account_id && row.account_id)) bySlug.set(row.slug, row);
  }
  return Array.from(bySlug.values());
}
