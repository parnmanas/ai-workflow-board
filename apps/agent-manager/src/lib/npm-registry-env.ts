/**
 * npm registry tokens an account exposed to agent runs (Credential provider
 * `npm`). npm reads auth per registry from config keyed by the registry's
 * "nerf dart" — `//registry.npmjs.org/:_authToken` — and @npmcli/config takes
 * any `npm_config_<key>` env var as config, leaving `//…` keys un-normalized.
 * So one env var authenticates the agent's npm for that registry without
 * touching its ~/.npmrc, and it beats a stale token there (env > user config).
 *
 * Only the token is set — never `npm_config_registry`: pointing every install
 * at a private registry is not what "here is a token" means.
 */

export interface NpmRegistryCredential {
  registry: string;
  token: string;
}

/** `https://npm.example.com/api/npm/repo/` → `//npm.example.com/api/npm/repo/`; null if not http(s). */
export function npmNerfDart(registry: string): string | null {
  try {
    const url = new URL(registry);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    return `//${url.host}${path}`;
  } catch {
    return null;
  }
}

export function npmRegistryEnv(registries: readonly NpmRegistryCredential[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { registry, token } of registries) {
    const nerf = npmNerfDart(registry);
    if (nerf && token) env[`npm_config_${nerf}:_authToken`] = token;
  }
  return env;
}
