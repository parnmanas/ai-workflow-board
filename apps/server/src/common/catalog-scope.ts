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
  if (!accountId) throw Object.assign(new Error('account_id is required for account scope'), { status: 400 });
  return { account_id: accountId };
}

export function canUseCatalogItem(row: CatalogScoped, accountId: string): boolean {
  if (row.account_id === null) return true;
  return row.account_id === accountId;
}

/**
 * The Accounts whose rows a catalog list (Function / Credential / Resource)
 * covers, Global rows aside — see docs/ownership.md.
 *
 * - An explicit `account_id` keeps the single-Account view: pickers that bind
 *   a definition to one Account's work (CLI settings, projects, runtime slots)
 *   must only offer what that Account can read.
 * - Without one the list aggregates every Account the caller can access. The
 *   page's default account is a creation default, never a filter.
 *
 * AccountAccessService.bindRequest rewrites `query.account_id` to that default,
 * so on a bound request the explicit value is `req.requestedAccountId`. An
 * unbound call (no request, as in direct controller tests) treats the query
 * value as explicit. Returns null when there is nothing to scope by.
 */
export function catalogListAccountIds(req: any, queryAccountId: string | null | undefined): string[] | null {
  if (Array.isArray(req?.accessibleAccountIds)) {
    const requested = String(req.requestedAccountId || '').trim();
    return requested ? [requested] : [...req.accessibleAccountIds];
  }
  const explicit = String(queryAccountId || '').trim();
  return explicit ? [explicit] : null;
}
