/**
 * Mirror of `apps/server/src/common/credential-fields.ts` — the manager must
 * not depend on the server having the fix, because the failure it prevents is
 * total: a `claude setup-token` value pasted out of a wrapped terminal carries
 * an interior newline, the adapter exports it verbatim as
 * CLAUDE_CODE_OAUTH_TOKEN, and every claude agent on that credential fails
 * auth ~1s into every spawn with nothing but `api_error` to go on.
 *
 * Single-line secrets (api keys, oauth tokens, base urls, model ids) may never
 * legally contain whitespace, so all of it is stripped. The blob fields that
 * are legitimately multi-line are only end-trimmed.
 */
export const MULTILINE_CREDENTIAL_FIELDS: readonly string[] = [
  'credentials_json',
  'auth_json',
  'config_toml',
  'oauth_creds_json',
];

export function normalizeCredentialField(field: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (MULTILINE_CREDENTIAL_FIELDS.includes(field)) return value.trim();
  return value.replace(/\s+/g, '');
}

/**
 * Returns the normalized map plus the names of fields that actually changed,
 * so the caller can log the repair — an operator whose credential silently
 * needed fixing should see it once per spawn, not never.
 */
export function normalizeCredentialFields(
  fields: Record<string, string> | undefined | null,
): { fields: Record<string, string>; repaired: string[] } {
  const out: Record<string, string> = {};
  const repaired: string[] = [];
  for (const [key, value] of Object.entries(fields ?? {})) {
    const next = normalizeCredentialField(key, value) as string;
    out[key] = next;
    if (next !== value) repaired.push(key);
  }
  return { fields: out, repaired };
}
