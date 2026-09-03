/**
 * Credential secret values are pasted in by an operator, and a paste that came
 * out of a wrapped terminal carries the wrap with it: a `claude setup-token`
 * output shown across two display lines arrives as `…NHm9xS\n VFxMT6Y…`.
 *
 * Nothing downstream tolerates an interior newline. The manager exports the
 * value verbatim as CLAUDE_CODE_OAUTH_TOKEN, the CLI puts it into an
 * Authorization header, and every request dies with `terminal_reason:
 * api_error` ~1s in — for *every* agent bound to that credential at once,
 * with no error text that points back at the paste.
 *
 * So: single-line secrets get ALL whitespace stripped. None of them — API
 * keys, OAuth tokens, base URLs, model ids — may legally contain whitespace,
 * so stripping can only ever remove damage. The blob fields that ARE
 * legitimately multi-line (a pasted `.credentials.json` / `auth.json` /
 * `config.toml`) are only end-trimmed, never touched inside.
 */
export const MULTILINE_CREDENTIAL_FIELDS: readonly string[] = [
  'credentials_json',
  'auth_json',
  'config_toml',
  'oauth_creds_json',
];

/** Normalize one credential field value. Non-strings pass through untouched. */
export function normalizeCredentialField(field: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (MULTILINE_CREDENTIAL_FIELDS.includes(field)) return value.trim();
  return value.replace(/\s+/g, '');
}

/**
 * Normalize a whole credential field map. Applied on every write (so a bad
 * paste never reaches storage) AND on the manager-facing read (so rows that
 * were already stored damaged heal without the operator re-entering them).
 */
export function normalizeCredentialFields<T extends Record<string, unknown>>(fields: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = normalizeCredentialField(key, value);
  }
  return out as T;
}
