export type CatalogScope = 'global' | 'workspace';

/**
 * Catalog items (Resources, Credentials, Functions, Skills, …) are owned by
 * exactly two layers: Global (`workspace_id NULL`) and one Workspace. The old
 * Board layer is gone together with boards — see docs/catalog-scopes.md.
 */
export interface CatalogScoped {
  workspace_id: string | null;
}

export function catalogScopeOf(row: CatalogScoped): CatalogScope {
  return row.workspace_id ? 'workspace' : 'global';
}

export function normalizeCatalogScope(input: {
  scope?: string | null;
  workspace_id?: string | null;
}): CatalogScoped {
  if (input.scope && input.scope !== 'global' && input.scope !== 'workspace') {
    throw Object.assign(
      new Error(`scope must be 'global' or 'workspace' (got '${input.scope}')`),
      { status: 400 },
    );
  }
  const requested = input.scope
    || (input.workspace_id ? 'workspace' : 'global');
  if (requested === 'global') return { workspace_id: null };
  const workspaceId = String(input.workspace_id || '').trim();
  if (!workspaceId) throw Object.assign(new Error('workspace_id is required for workspace scope'), { status: 400 });
  return { workspace_id: workspaceId };
}

export function canUseCatalogItem(row: CatalogScoped, workspaceId: string): boolean {
  if (row.workspace_id === null) return true;
  return row.workspace_id === workspaceId;
}
