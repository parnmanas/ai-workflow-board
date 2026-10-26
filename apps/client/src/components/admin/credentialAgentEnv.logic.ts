import { t as translate } from '../../i18n/core';
/**
 * Credential → agent env var naming and the Google OAuth JSON import, kept
 * out of CredentialManager.tsx so they can be tested without rendering.
 *
 * The naming rule mirrors the server's apps/server/src/common/credential-agent-env.ts
 * (`<PREFIX>_<FIELD>`, upper-cased). The server is the one that validates and
 * delivers; this copy only previews what an agent will see. Both test files
 * pin the same examples.
 */

/** Providers whose fields may be exposed as env — the non-CLI ones. */
export const AGENT_ENV_PROVIDERS: ReadonlySet<string> = new Set(['github', 'gitlab', 'cloudflare', 'openai', 'google_oauth', 'git_http', 'npm', 'custom']);

/** A git host is handed to agents' git as a credential helper; it gets env vars only with a prefix. */
export const GIT_HOST_PROVIDER = 'git_http';
/** An npm registry token authenticates agents' npm directly; env vars only with a prefix. */
export const NPM_PROVIDER = 'npm';
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';

/** Suggested prefix when exposure is switched on. */
export const DEFAULT_AGENT_ENV_PREFIX: Readonly<Record<string, string>> = {
  google_oauth: 'GOOGLE',
  github: 'GITHUB',
  gitlab: 'GITLAB',
  cloudflare: 'CLOUDFLARE',
  npm: 'NPM',
};

/** Custom key/value keys: something an env var or a JSON consumer can name. */
export const CUSTOM_FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeAgentEnvPrefix(raw: string): string {
  return String(raw ?? '').trim().toUpperCase().replace(/_+$/, '');
}

export function agentEnvName(prefix: string, field: string): string {
  const key = String(field).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const p = normalizeAgentEnvPrefix(prefix);
  return p ? `${p}_${key}` : key;
}

export function agentEnvNames(provider: string, prefix: string, fieldKeys: readonly string[]): string[] {
  if ((provider === GIT_HOST_PROVIDER || provider === NPM_PROVIDER) && !normalizeAgentEnvPrefix(prefix)) return [];
  return fieldKeys.map((k) => agentEnvName(prefix, k));
}

/** Registry npm keys auth by (slash-terminated); empty → the public registry; null if not http(s). Mirrors the server. */
export function npmRegistryUrl(raw: string): string | null {
  const text = String(raw ?? '').trim() || DEFAULT_NPM_REGISTRY;
  try {
    const url = new URL(text);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return null;
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  } catch {
    return null;
  }
}

/** `https://lfs.example.com/org/repo.git/info/lfs` → `https://lfs.example.com`; null if not http(s). Mirrors the server. */
export function gitHostOrigin(raw: string): string | null {
  try {
    const url = new URL(String(raw ?? '').trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export type GoogleOAuthImport =
  | { ok: true; fields: { client_id: string; client_secret: string; refresh_token?: string }; kind: 'client' | 'authorized_user' }
  | { ok: false; error: string };

/**
 * Accepts the two JSON shapes Google hands out for an OAuth client:
 *  - the Cloud Console download (`client_secret_….json`): `{ "installed": {…} }`
 *    or `{ "web": {…} }` with client_id / client_secret
 *  - an authorized-user file (`gcloud auth application-default login`,
 *    google-auth `Credentials.to_json()`): flat client_id / client_secret /
 *    refresh_token — the one that lets an agent call APIs without a browser
 * A service-account key is refused by name: it is a different credential
 * (private key, no client secret) and would only half-fill this form.
 */
export function parseGoogleOAuthJson(text: string): GoogleOAuthImport {
  let data: any;
  try {
    data = JSON.parse(String(text ?? '').trim());
  } catch {
    return { ok: false, error: translate('Not valid JSON.') };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: translate('Expected a JSON object.') };
  if (data.type === 'service_account') {
    return { ok: false, error: translate('This is a service-account key, not an OAuth client. Store it as a Custom credential instead.') };
  }
  const inner = data.installed ?? data.web;
  const source = inner && typeof inner === 'object' ? inner : data;
  const clientId = typeof source.client_id === 'string' ? source.client_id.trim() : '';
  const clientSecret = typeof source.client_secret === 'string' ? source.client_secret.trim() : '';
  if (!clientId || !clientSecret) return { ok: false, error: translate('client_id and client_secret were not found in this JSON.') };
  const refresh = typeof data.refresh_token === 'string' ? data.refresh_token.trim() : '';
  return {
    ok: true,
    kind: inner ? 'client' : 'authorized_user',
    fields: { client_id: clientId, client_secret: clientSecret, ...(refresh ? { refresh_token: refresh } : {}) },
  };
}

export interface CustomRow {
  key: string;
  value: string;
}

/** First problem with the new Custom rows, or null. `existingKeys` are the stored keys that stay. */
export function customRowsProblem(rows: readonly CustomRow[], existingKeys: readonly string[]): string | null {
  const seen = new Set(existingKeys);
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value) continue;
    if (!key) return translate('Every value needs a key.');
    if (!CUSTOM_FIELD_KEY_RE.test(key)) return translate('Key {0} must start with a letter or _ and use only letters, digits and _.', { 0: key });
    if (seen.has(key)) return translate('Key {0} is used twice.', { 0: key });
    if (!row.value) return translate('Key {0} has no value.', { 0: key });
    seen.add(key);
  }
  return null;
}
