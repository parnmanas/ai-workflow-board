import { IsNull, type FindOptionsWhere } from 'typeorm';
import type { Skill } from '../../entities/Skill';
import { canUseCatalogItem, normalizeCatalogScope, type CatalogScope } from '../../common/catalog-scope';

/**
 * Scope plumbing for skills, on top of the shared catalog-scope model
 * (`docs/catalog-scopes.md`). Skills carry no `board_id` column — new catalog
 * entities never add one — so every call into the shared helpers adapts with a
 * literal `board_id: null`.
 */

export type SkillScope = CatalogScope;

/** '' / undefined / 'global' → global; otherwise the workspace uuid. */
export function resolveSkillScope(input: {
  scope?: SkillScope | 'board';
  workspace_id?: string | null;
}): { workspace_id: string | null } {
  const normalized = normalizeCatalogScope({
    scope: input.scope,
    workspace_id: input.workspace_id ?? null,
    board_id: null,
  });
  return { workspace_id: normalized.workspace_id };
}

export function skillScopeOf(skill: Pick<Skill, 'workspace_id'>): SkillScope {
  return skill.workspace_id ? 'workspace' : 'global';
}

export function skillIsVisibleTo(skill: Pick<Skill, 'workspace_id'>, workspaceId: string): boolean {
  return canUseCatalogItem({ workspace_id: skill.workspace_id, board_id: null }, workspaceId);
}

/**
 * TypeORM `where` for "global rows OR this workspace's rows".
 *
 * `workspace_id: IsNull()` and `workspace_id: workspaceId` cannot be expressed
 * in one object, so this returns the two-element OR array TypeORM understands.
 * Always spread extra predicates into BOTH branches — a predicate added to
 * only one silently changes which scope it filters.
 */
export function visibleScopeWhere<T extends { workspace_id: string | null }>(
  workspaceId: string,
  extra: Partial<Record<keyof T, unknown>> = {},
): Array<FindOptionsWhere<T>> {
  return [
    { ...extra, workspace_id: IsNull() } as FindOptionsWhere<T>,
    { ...extra, workspace_id: workspaceId } as FindOptionsWhere<T>,
  ];
}

/**
 * Workspace-over-global shadowing by slug — the same precedence
 * WorkflowFunction applies to its `key`. A workspace fork of a built-in skill
 * therefore wins without the operator having to delete the global original.
 *
 * `include_shadowed` callers (the management UI) skip this and render both.
 */
export function shadowBySlug<T extends { slug: string; workspace_id: string | null }>(rows: T[]): T[] {
  const bySlug = new Map<string, T>();
  for (const row of rows) {
    const current = bySlug.get(row.slug);
    // Workspace beats global; between two rows of the same scope the first
    // wins (callers pass a deterministic order).
    if (!current || (!current.workspace_id && row.workspace_id)) bySlug.set(row.slug, row);
  }
  return Array.from(bySlug.values());
}
