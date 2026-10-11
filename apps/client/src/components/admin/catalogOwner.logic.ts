/**
 * Owner (Account) presentation for the account-management catalog pages —
 * Functions, Credentials and Resources. Their lists aggregate every accessible
 * Account plus Global rows (docs/ownership.md), so every row names its owner
 * and a new item's owner is chosen explicitly: there is no hidden "current
 * account" on these pages. Pure helpers, kept out of the components so they
 * can be tested without rendering.
 */

export interface OwnerAccount {
  id: string;
  name?: string | null;
}

export interface OwnerOption {
  /** null = Global (`account_id NULL`). */
  accountId: string | null;
  label: string;
}

/** `<select>` value standing for Global. Account ids are UUIDs, so it cannot collide. */
export const GLOBAL_OWNER_VALUE = 'global';

export function ownerToSelectValue(accountId: string | null): string {
  return accountId ?? GLOBAL_OWNER_VALUE;
}

export function selectValueToOwner(value: string): string | null {
  return value === GLOBAL_OWNER_VALUE || value === '' ? null : value;
}

/** An Account's name; a short id when the name is not known (yet). */
export function accountLabel(accountId: string, accounts: readonly OwnerAccount[]): string {
  const name = accounts.find((account) => account.id === accountId)?.name?.trim();
  return name || `Account ${accountId.slice(0, 8)}`;
}

/** The Owner column: the owning Account's name, or "Global" for `account_id NULL`. */
export function catalogOwnerLabel(accountId: string | null | undefined, accounts: readonly OwnerAccount[]): string {
  return accountId ? accountLabel(accountId, accounts) : 'Global';
}

/**
 * "Account for new item" options: Global — only when the caller may write
 * Global rows of this kind — plus every accessible Account by name.
 */
export function createOwnerOptions(accounts: readonly OwnerAccount[], canManageGlobal: boolean): OwnerOption[] {
  return [
    ...(canManageGlobal ? [{ accountId: null, label: 'Not set (Global)' }] : []),
    ...accounts.map((account) => ({ accountId: account.id, label: accountLabel(account.id, accounts) })),
  ];
}

/** Default owner for new items: Global when permitted, otherwise the first accessible Account. */
export function defaultCreateOwner(accounts: readonly OwnerAccount[], canManageGlobal: boolean): string | null {
  if (canManageGlobal) return null;
  return accounts[0]?.id ?? null;
}

/**
 * The owner for new items given the user's pick (`undefined` = not picked
 * yet). A pick that is no longer offered — the permission or the membership
 * went away — falls back to the default instead of being sent anyway.
 */
export function resolveCreateOwner(
  picked: string | null | undefined,
  accounts: readonly OwnerAccount[],
  canManageGlobal: boolean,
): string | null {
  if (picked === null && canManageGlobal) return null;
  if (picked && accounts.some((account) => account.id === picked)) return picked;
  return defaultCreateOwner(accounts, canManageGlobal);
}

/**
 * Destinations offered by the Edit dialog's scope picker on an existing
 * credential (credentials.controller.ts update(), docs/catalog-scopes.md).
 * A Global credential can be narrowed to any accessible Account. An Account
 * credential can only stay or widen to Global — the server refuses Account →
 * other Account: widen first, then narrow, so the dependent check runs.
 */
export function credentialScopeOptions(rowAccountId: string | null, accounts: readonly OwnerAccount[]): OwnerOption[] {
  const global: OwnerOption = { accountId: null, label: 'Not set (Global — every Account)' };
  if (rowAccountId) return [global, { accountId: rowAccountId, label: accountLabel(rowAccountId, accounts) }];
  return [global, ...accounts.map((account) => ({ accountId: account.id, label: accountLabel(account.id, accounts) }))];
}

/**
 * `scope` / `account_id` of a credential PATCH. `account_id` is the ownership
 * proof for an Account credential (the server requires it to equal the row's
 * owner) and the destination when a Global credential is narrowed.
 */
export function credentialUpdateScope(
  rowAccountId: string | null,
  destination: string | null,
): { scope: 'global' | 'account'; account_id?: string } {
  if (destination === null) return rowAccountId ? { scope: 'global', account_id: rowAccountId } : { scope: 'global' };
  return { scope: 'account', account_id: rowAccountId ?? destination };
}

/** Who gets an `agent_env` credential's variables: one Account, or every Account for Global. */
export function agentEnvOwnerLabel(ownerAccountId: string | null, accounts: readonly OwnerAccount[]): string {
  return ownerAccountId === null ? 'every Account' : accountLabel(ownerAccountId, accounts);
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

/**
 * The Account a Global Function runs in (an Account Function always runs in
 * its owner — the server refuses any other): the picked run Account, else the
 * owner selected for new items, else the first accessible Account.
 */
export function globalRunAccount(
  pickedRunAccountId: string | null,
  createAccountId: string | null,
  accounts: readonly OwnerAccount[],
): string | null {
  const offered = (id: string | null): id is string => !!id && accounts.some((account) => account.id === id);
  if (offered(pickedRunAccountId)) return pickedRunAccountId;
  if (offered(createAccountId)) return createAccountId;
  return accounts[0]?.id ?? null;
}
