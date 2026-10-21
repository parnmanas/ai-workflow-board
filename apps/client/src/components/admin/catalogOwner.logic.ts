/** Internal ownership routing for catalogs; no workspace/scope UI. */
export interface OwnerAccount {
  id: string;
}

/** Default owner for new items: Global when permitted, otherwise the first accessible Account. */
export function defaultCreateOwner(accounts: readonly OwnerAccount[], canManageGlobal: boolean): string | null {
  if (canManageGlobal) return null;
  return accounts[0]?.id ?? null;
}

/**
 * Credentials a Resource owned by `ownerAccountId` may bind: Global ones plus
 * those of its own Account (ResourcesController.assertCredentialScope).
 */
export function credentialsUsableBy<T extends { account_id: string | null }>(
  credentials: readonly T[],
  ownerAccountId: string | null,
): T[] {
  return credentials.filter((credential) =>
    credential.account_id === null || (ownerAccountId !== null && credential.account_id === ownerAccountId));
}
