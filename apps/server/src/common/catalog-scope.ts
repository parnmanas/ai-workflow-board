export type CatalogScope = 'global' | 'account';

/**
 * Catalog items (Resources, Credentials, Functions, Skills, …) are owned by
 * exactly two layers: Global (`account_id NULL`) and one Account. The old
 * Board layer is gone together with boards — see docs/catalog-scopes.md.
 */
export interface CatalogScoped {
  account_id: string | null;
}

export function catalogScopeOf(row: CatalogScoped): CatalogScope {
  return row.account_id ? 'account' : 'global';
}

export function normalizeCatalogScope(input: {
  scope?: string | null;
  account_id?: string | null;
}): CatalogScoped {
  if (input.scope && input.scope !== 'global' && input.scope !== 'account') {
    throw Object.assign(
      new Error(`scope must be 'global' or 'account' (got '${input.scope}')`),
      { status: 400 },
    );
  }
  const requested = input.scope
    || (input.account_id ? 'account' : 'global');
  if (requested === 'global') return { account_id: null };
  const accountId = String(input.account_id || '').trim();
  if (!accountId) throw Object.assign(new Error('account_id is required for workspace scope'), { status: 400 });
  return { account_id: accountId };
}

export function canUseCatalogItem(row: CatalogScoped, accountId: string): boolean {
  if (row.account_id === null) return true;
  return row.account_id === accountId;
}
