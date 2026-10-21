/** Ownership defaults for account catalogs. */
export interface OwnerAccount {
  id: string;
}

/** Global creation requires an explicit choice; permission alone never shares data. */
export function defaultCreateOwner(accounts: readonly OwnerAccount[], explicitlyGlobal = false): string | null {
  if (explicitlyGlobal) return null;
  return accounts[0]?.id ?? '';
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
